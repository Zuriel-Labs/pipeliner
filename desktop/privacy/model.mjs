import { createHash } from 'node:crypto';
import { canonicalJSON, fields, record, validateValue } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';

// These identities or controls require repair on the current installation; an import cannot recreate their authority.
const repairFields = new Set(['connections.github', 'connections.codex', 'connections.ollama', 'agents.dev', 'agents.fallbacks',
  'permissions.ceiling', 'permissions.resources', 'skills.extensions', 'skills.disabled', 'tools.extensions', 'tools.disabled',
  'testing.requiredChecks', 'delivery.output', 'updates.source', 'background.enabled', 'background.startAtLogin', 'scheduling.enabled']);
const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value);
function scopeCheck(scope, target) {
  if (!['host', 'global', 'repository'].includes(scope) || (scope === 'repository' ? !identifier(target) : target !== null)) throw new Error('Configuration scope invalid');
}
function fieldCheck(key, value, scope) {
  const field = fields.get(key);
  if (!field || field.scope === 'read-only' || (scope === 'host') !== (field.scope === 'host')) throw new Error('Configuration field unavailable');
  validateValue(key, value);
}
function contentCheck(value, key = '') {
  // Only schema-validated immutable extension pins are exempt from credential-shaped string detection.
  if (typeof value === 'string') {
    if (key === 'pin' && /^(?:skill-[a-f0-9]{40}|tool-[a-f0-9]{40}|pipeliner-(?:forge|motif|shape|lens))$/.test(value)) return;
    if (containsSecret(value)) throw new Error('Configuration contains protected-looking content; remove it through Settings before export');
  } else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|credential|authorization|private[_-]?key)$/i.test(name)) throw new Error('Configuration contains protected-looking content; remove it through Settings before export');
    contentCheck(child, name);
  }
}
function checkedSettings(settings, scope, exporting) {
  record(settings, [], Object.keys(settings)); const result = {}, repair = [];
  for (const [key, value] of Object.entries(settings)) {
    fieldCheck(key, value, scope);
    if (repairFields.has(key)) {
      if (!exporting) throw new Error('Configuration field needs secure repair');
      repair.push(key); continue;
    }
    contentCheck(value); result[key] = structuredClone(value);
  }
  return { settings: result, repair: repair.sort() };
}
export function createConfigurationExport(snapshot, createdAt) {
  canonicalJSON(snapshot); record(snapshot, ['scope', 'target', 'revision', 'hash', 'settings']); scopeCheck(snapshot.scope, snapshot.target);
  if (!integer(createdAt) || !integer(snapshot.revision) || !/^[a-f0-9]{64}$/.test(snapshot.hash)) throw new Error('Configuration source invalid');
  const { settings, repair } = checkedSettings(snapshot.settings, snapshot.scope, true);
  const document = { kind: 'pipeliner-configuration', version: 1, scope: snapshot.scope, target: snapshot.target, createdAt,
    source: { revision: snapshot.revision, hash: snapshot.hash }, settings, repair };
  return { ...document, digest: digest(document) };
}
export function configurationChanges(envelope, context) {
  try {
    canonicalJSON(envelope); record(envelope, ['kind', 'version', 'scope', 'target', 'createdAt', 'source', 'settings', 'repair', 'digest']);
    record(envelope.source, ['revision', 'hash']);
    if (envelope.kind !== 'pipeliner-configuration' || envelope.version !== 1 || !integer(envelope.createdAt) || !integer(envelope.source.revision)
      || typeof envelope.source.hash !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.source.hash) || typeof envelope.digest !== 'string'
      || !/^[a-f0-9]{64}$/.test(envelope.digest) || !Array.isArray(envelope.repair) || new Set(envelope.repair).size !== envelope.repair.length
      || envelope.repair.some(key => !repairFields.has(key))) throw new Error();
  } catch { throw new Error('Configuration format invalid'); }
  scopeCheck(envelope.scope, envelope.target); scopeCheck(context.scope, context.target);
  if (context.scope !== envelope.scope || context.target !== envelope.target) throw new Error('Configuration scope changed');
  if (envelope.repair.some(key => (fields.get(key).scope === 'host') !== (envelope.scope === 'host'))) throw new Error('Configuration field unavailable');
  const { digest: expected, ...document } = envelope;
  if (digest(document) !== expected) throw new Error('Configuration integrity changed');
  const changes = checkedSettings(envelope.settings, envelope.scope, false).settings;
  canonicalJSON(context.currentSettings); record(context.currentSettings, [], Object.keys(context.currentSettings));
  for (const [key, value] of Object.entries(context.currentSettings)) fieldCheck(key, value, context.scope);
  // Omitted eligible overrides restore inheritance. Existing service, connection and resource bindings remain untouched.
  const reset = Object.keys(context.currentSettings).filter(key => !repairFields.has(key) && !Object.hasOwn(changes, key)).sort();
  return { changes, reset, repair: [...envelope.repair] };
}

export function createDiagnosticExport(input, createdAt) {
  try {
    canonicalJSON(input); record(input, ['appVersion', 'host', 'storage', 'connections', 'recovery', 'background']);
    record(input.host, ['platform', 'architecture', 'version']); record(input.storage, ['protected', 'categories', 'ciphertextBytes']);
    record(input.storage.categories, ['conversation', 'log', 'audit']); record(input.connections, ['github', 'codex', 'ollama']);
    record(input.recovery, ['activeRuns', 'uncertainEffects', 'blockedRuns']); record(input.background, ['configured', 'effective']);
    const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:-(?:alpha|beta|rc)\.\d{1,4})?$/.test(value);
    if (!integer(createdAt) || !version(input.appVersion) || !version(input.host.version) || !['darwin', 'win32', 'linux'].includes(input.host.platform)
      || !['arm64', 'x64'].includes(input.host.architecture) || typeof input.storage.protected !== 'boolean'
      || !integer(input.storage.ciphertextBytes) || Object.values(input.storage.categories).some(value => !integer(value) || value > 100000000)
      || Object.values(input.connections).some(value => !['disconnected', 'connected', 'blocked'].includes(value))
      || Object.values(input.recovery).some(value => !integer(value) || value > 100000000)
      || Object.values(input.background).some(value => typeof value !== 'boolean') || input.background.effective && !input.background.configured) throw new Error();
    const document = { kind: 'pipeliner-diagnostics', version: 1, createdAt, ...structuredClone(input) };
    return { ...document, digest: digest(document) };
  } catch { throw new Error('Diagnostic fields unavailable; raw content was excluded'); }
}
