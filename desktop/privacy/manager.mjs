import { randomUUID, createHash } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { containsSecret, redactProtectedText } from '../connections/commands.mjs';
import { skillChatSafe } from '../skills/commands.mjs';
import { toolChatSafe } from '../tools/commands.mjs';
import { privacyShapes, privacyCommand } from './commands.mjs';
import { createConfigurationExport, configurationChanges, createDiagnosticExport } from './model.mjs';
import { writeExportFile, readConfigurationFile } from './files.mjs';

const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const privacyKeys = Object.freeze(['privacy.conversationDays', 'privacy.logDays', 'privacy.auditDays', 'privacy.runLogMiB', 'privacy.totalLogMiB',
  'privacy.telemetry', 'privacy.automaticUpload', 'privacy.crossRepositoryReuse']);

export function createPrivacyManager({ records, policy, workspace = () => null, chooseExport, chooseImport, diagnostics, managedInventory = () => [], artifactSummary = () => null, protectedPaths = [],
  initialRevision = 1, clock = Date.now, onChange = () => {}, onApplied = () => {} }) {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 1 || ![workspace, managedInventory, artifactSummary, clock, onChange, onApplied].every(value => typeof value === 'function')) throw new Error('Privacy host controls unavailable');
  let revision = initialRevision, scope = workspace()?.id ? 'repository' : 'global', observed, preview = null, applied = null,
    busy = false, pending = null, closed = false, message = null, diagnosticView = null, errorCode = null, finalStatus;
  const tokens = new Map(), receipts = new Map(), inFlight = new Set();
  const paths = () => typeof protectedPaths === 'function' ? protectedPaths() : protectedPaths;
  function context() { const current = workspace(); return { repository: current?.id ?? null, issue: current?.issue ?? null, policyRevision: policy?.worker.read(null).revision ?? null }; }
  const invalidate = () => { if (preview?.policy) policy.control.invalidate(preview.policy.inputId); preview = null; applied = null; };
  function sync() {
    if (closed) return;
    const next = canonicalJSON(context());
    if (observed !== undefined && observed !== next) { pending?.controller.abort(); invalidate(); if (scope === 'repository' && !workspace()?.id) scope = 'global'; revision++; }
    observed = next;
  }
  function token() {
    const current = context(), fingerprint = canonicalJSON({ repository: current.repository, issue: current.issue });
    let saved = [...tokens.entries()].find(([_key, value]) => value.fingerprint === fingerprint);
    if (!saved) {
      if (tokens.size >= 256) tokens.delete(tokens.keys().next().value);
      saved = [randomUUID(), { ...current, fingerprint }]; tokens.set(...saved);
    }
    return saved[0];
  }
  function status() {
    if (closed) return finalStatus; sync();
    const current = workspace(), target = scope === 'repository' ? current?.id ?? null : null, view = policy?.worker.read(target);
    let managed, artifacts;
    try { managed = managedInventory(); } catch { managed = null; }
    try { artifacts = current?.id ? artifactSummary(current.id) : null; } catch { artifacts = { unavailable: true }; }
    return { revision, repository: current?.id ?? null, repositoryLabel: current?.name ?? null, scope, busy, storageAvailable: Boolean(records && policy),
      conversationToken: records && policy ? token() : null,
      values: view ? Object.fromEntries(privacyKeys.map(key => [key, view.values[key]])) : null,
      inventory: records?.inventory().categories.filter(row => row.repository === (current?.id ?? null)) ?? [],
      managedInventory: managed, artifacts, preview: preview ? structuredClone(preview.visible) : null, diagnostics: diagnosticView ? structuredClone(diagnosticView) : null, errorCode, message };
  }
  const publish = () => { if (!closed) onChange(status()); };
  function ready() { sync(); if (closed || !records || !policy) throw new Error('Privacy protected storage unavailable'); }
  function chosenScope(value = scope) {
    if (!['host', 'global', 'repository'].includes(value) || value === 'repository' && !workspace()?.id) throw new Error('Privacy scope unavailable');
    if (scope !== value) { invalidate(); scope = value; revision++; }
    return { scope, target: scope === 'repository' ? workspace().id : null };
  }
  function time() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new Error('Privacy clock invalid'); return value; }
  function proposal(changes, reset, selected, text, kind, extra = {}) {
    invalidate(); const input = policy.control.capture({ commandId: randomUUID(), conversationId: token(), target: selected.target, text });
    try {
      const p = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: token(), ...selected, changes, reset });
      const keys = [...Object.keys(changes), ...reset];
      preview = { kind, binding: context(), policy: p, ...extra, visible: { kind, scope: selected.scope, target: selected.target, hash: p.hash,
        expiresAt: p.expiresAt, before: Object.fromEntries(keys.map(key => [key, p.before[key]])), after: Object.fromEntries(keys.map(key => [key, p.after[key]])), repair: extra.repair ?? [] } };
      message = kind === 'restore' ? 'Review the typed changes. Connections and installation handles need secure repair; active runs keep their captured versions.'
        : 'Review retention and storage limits. Completed eligible records use the new limits at future cleanup; recovery records stay protected.';
    } catch (error) { policy.control.invalidate(input.id); if (error.message !== 'Policy proposal has no change') throw error; message = 'These settings already match. No policy version was created.'; }
    revision++; publish(); return { snapshot: status() };
  }
  async function nativeSelection(work) {
    invalidate(); const operation = { controller: new AbortController(), revision }; pending = operation; busy = true; publish();
    try {
      const value = await work(operation.controller.signal); sync();
      if (closed || operation.controller.signal.aborted || revision !== operation.revision) throw new Error('Privacy context changed');
      return value;
    } finally { if (pending === operation) pending = null; busy = false; publish(); }
  }
  async function execute(payload) {
    ready(); canonicalJSON(payload); const shape = privacyShapes[payload?.operation];
    if (!shape) throw new Error('Privacy operation unavailable'); record(payload, ['operation', ...shape[0]], shape[1]);
    if (payload.operation === 'append' || payload.operation === 'draft') {
      const saved = tokens.get(payload.token); if (!saved || !uuid(payload.token)) throw new Error('Privacy conversation changed');
      if (typeof payload.text !== 'string' || payload.text.length > 16000) throw new Error('Privacy conversation requires bounded text');
      const safeCommand = skillChatSafe(payload.text) || toolChatSafe(payload.text);
      if ((payload.operation === 'draft' || payload.role === 'pm') && !safeCommand && containsSecret(payload.text)) throw new Error('Privacy conversation requires protected key entry');
      if (payload.operation === 'draft') return records.saveDraft(saved.repository, payload.text);
      if (!uuid(payload.commandId) || !['pm', 'app'].includes(payload.role)) throw new Error('Privacy conversation receipt invalid');
      const identity = digest({ token: payload.token, role: payload.role, text: payload.text }), prior = receipts.get(payload.commandId);
      if (prior && prior.identity !== identity) throw new Error('Privacy conversation receipt changed');
      const createdAt = prior?.createdAt ?? time();
      // History is data, never authority. Conservative redaction may omit hashes; live verified panels retain their exact identities.
      const text = payload.role === 'app' ? redactProtectedText(payload.text) : payload.text;
      const result = records.append({ id: payload.commandId, repository: saved.repository, category: 'conversation', runId: 'messages',
        value: { role: payload.role, text, issue: saved.issue }, completedAt: createdAt });
      receipts.set(payload.commandId, { identity, createdAt }); if (receipts.size > 1000) receipts.delete(receipts.keys().next().value);
      return { ...result, text };
    }
    if (payload.operation !== 'history') errorCode = null;
    if (payload.operation === 'cancel') { pending?.controller.abort(); invalidate(); message = 'Privacy operation cancelled. Existing records and configuration are preserved.'; revision++; publish(); return { snapshot: status() }; }
    if (busy) throw new Error('Privacy native operation pending');
    if (payload.operation === 'chat') {
      const action = privacyCommand(payload.text);
      if (!action) return { snapshot: status(), message: 'Ask to show privacy, change retention, export settings, restore settings or delete local conversations.' };
      if (!['apply', 'cancel'].includes(action.operation)) {
        const bound = canonicalJSON(context()), issued = token();
        records.saveDraft(context().repository, '');
        await execute({ operation: 'append', token: issued, commandId: randomUUID(), role: 'pm', text: payload.text });
        sync(); if (closed || bound !== canonicalJSON(context())) throw new Error('Privacy context changed');
      }
      return execute(action);
    }
    if (payload.operation === 'view') { chosenScope(payload.scope); publish(); return { snapshot: status() }; }
    if (payload.operation === 'diagnostics') {
      diagnosticView = createDiagnosticExport(diagnostics(), time()); message = 'These allowlisted local diagnostic counts and versions contain no raw logs or credentials. Nothing was exported or uploaded.';
      revision++; publish(); return { snapshot: status() };
    }
    if (payload.operation === 'history') {
      const selected = context(), page = records.list(selected.repository, 'conversation', { runId: 'messages', limit: 50, ...(payload.before ? { before: payload.before } : {}) });
      const before = page.at(-1)?.id ?? null;
      return { repository: selected.repository, token: token(), messages: page.reverse(), draft: records.draft(selected.repository), before,
        more: before !== null && records.list(selected.repository, 'conversation', { runId: 'messages', before, limit: 1 }).length > 0 };
    }
    if (payload.operation === 'prepare') {
      const selected = chosenScope(payload.scope);
      if (Object.keys(payload.changes).some(key => !privacyKeys.includes(key)) || (payload.reset ?? []).some(key => !privacyKeys.includes(key))) throw new Error('Privacy changes require retention fields only');
      return proposal(payload.changes, payload.reset ?? [], selected, 'Review local data retention changes.', 'retention');
    }
    if (payload.operation === 'export') {
      if (!['configuration', 'diagnostics'].includes(payload.kind)) throw new Error('Privacy export unavailable');
      const selected = chosenScope(payload.scope), bound = context();
      const document = payload.kind === 'configuration' ? createConfigurationExport(policy.control.configuration(selected.scope, selected.target), time()) : createDiagnosticExport(diagnostics(), time());
      const destination = await nativeSelection(signal => chooseExport({ kind: payload.kind, ...selected, signal }));
      if (!destination) { message = 'Export cancelled. No file was created.'; publish(); return { snapshot: status() }; }
      const visible = { kind: 'export', ...selected, destination, document, expiresAt: time() + 900000, bound };
      visible.hash = digest(visible); preview = { kind: 'export', binding: bound, visible, document, destination };
      message = 'Review this captured nonsecret content and chosen local destination. Pipeliner makes a local copy; your chosen folder\'s sync service may upload it. Credentials are excluded.'; revision++; publish(); return { snapshot: status() };
    }
    if (payload.operation === 'import') {
      const selected = chosenScope(payload.scope);
      const selectedFile = await nativeSelection(async signal => { const source = await chooseImport({ ...selected, signal });
        return source ? { source, document: await readConfigurationFile(source, selected, { protectedPaths: paths(), signal }) } : null; });
      if (!selectedFile) { message = 'Restore cancelled. Configuration is unchanged.'; publish(); return { snapshot: status() }; }
      const edit = configurationChanges(selectedFile.document, { ...selected, currentSettings: policy.control.configuration(selected.scope, selected.target).settings });
      return proposal(edit.changes, edit.reset, selected, 'Restore the selected nonsecret configuration snapshot ' + selectedFile.document.digest, 'restore', { ...selectedFile, repair: edit.repair });
    }
    if (payload.operation === 'delete') {
      const current = workspace(); if (!current?.id) throw new Error('Privacy deletion requires a selected repository'); invalidate();
      const p = records.previewDeletion(current.id, payload.categories, { ...(payload.after ? { after: payload.after } : {}) });
      const visible = { kind: 'delete', ...p, scope: 'repository', target: current.id, expiresAt: p.expires, hash: digest(p) };
      preview = { kind: 'delete', binding: context(), deletion: p, visible }; message = 'Review eligible local records and retained recovery records. Source folders and GitHub/provider copies remain outside this deletion. A minimal installation audit receipt remains.';
      revision++; publish(); return { snapshot: status() };
    }
    if (payload.operation === 'apply') {
      if (!preview) { if (applied && (!payload.hash || payload.hash === applied)) return { snapshot: status(), applied: false }; throw new Error('Privacy preview unavailable; review the current change'); }
      const p = preview;
      if (payload.hash && payload.hash !== p.visible.hash || canonicalJSON(context()) !== canonicalJSON(p.binding)) throw new Error('Privacy preview changed');
      if (time() > p.visible.expiresAt) throw new Error('Privacy preview expired');
      busy = true; publish();
      try {
        if (p.kind === 'export') {
          const controller = new AbortController(); pending = { controller, revision };
          await writeExportFile(p.destination, p.document, { protectedPaths: paths(), signal: controller.signal });
          message = 'The reviewed nonsecret export was saved and its exact bytes verified. External copies remain under your control.';
        } else if (p.kind === 'delete') {
          const result = records.delete(p.deletion);
          if (p.deletion.categories.includes('conversation')) for (const [key, value] of tokens) if (value.repository === p.binding.repository) tokens.delete(key);
          message = result.deleted + ' eligible local records deleted. Recovery records, source folders, credentials, policy/ownership records and GitHub/provider copies are preserved.';
        } else {
          if (p.kind === 'restore') {
            const controller = new AbortController(); pending = { controller, revision };
            const current = await readConfigurationFile(p.source, { scope: p.policy.scope, target: p.policy.target }, { protectedPaths: paths(), signal: controller.signal });
            sync(); if (closed || controller.signal.aborted || preview !== p || canonicalJSON(current) !== canonicalJSON(p.document)) throw new Error('Privacy preview changed');
          }
          policy.control.apply({ commandId: randomUUID(), proposalId: p.policy.id, inputId: p.policy.inputId, hash: p.policy.hash,
            conversationId: p.policy.conversationId, target: p.policy.target });
          message = p.kind === 'restore' ? 'Reviewed configuration restored as a new policy version. Secure connections/resources need repair; work was not started or resumed.' : 'Retention settings saved. Recovery records remain protected.';
        }
        // A completed export is an external copy of the reviewed snapshot, even if the view changed at completion.
        if (preview === p) { preview = null; applied = p.visible.hash; }
        observed = canonicalJSON(context()); revision++; onApplied();
      } finally { pending = null; busy = false; publish(); }
      return { snapshot: status(), applied: true, historyChanged: p.kind === 'delete' && p.deletion.categories.includes('conversation') };
    }
    throw new Error('Privacy operation unavailable');
  }
  function dispatch(payload) {
    const work = execute(payload).catch(error => {
      // Only fixed host-generated messages are shown; native/filesystem errors and selected file content stay private.
      if (/^Privacy import (?:failed; (?:choose (?:a JSON export in an owned local folder outside protected application data|an unchanged regular local JSON file under 2 MiB|an intact Pipeliner configuration export for the current scope)|the selected file has another hard link\. Export a new copy to an unsynced local folder)|cancelled)$/.test(error.message)) {
        errorCode = /^PRIVACY_IMPORT_(?:LOCATION|OPEN|LINKS|METADATA|BYTES|STABILITY|CONFIGURATION)$/.test(error.code) ? error.code : null;
        message = error.message; revision++; publish();
      } else if (payload.operation === 'import' || payload.operation === 'chat' && privacyCommand(payload.text)?.operation === 'import') {
        const reasons = new Map([['Privacy context changed', 'the selected repository or policy changed'], ['Configuration scope changed', 'the export belongs to another scope'],
          ['Configuration field unavailable', 'a field is unavailable in this scope'], ['Configuration integrity changed', 'the selected export changed'],
          ['Connection capability unavailable', 'a connection needs secure repair'], ['Host capability unavailable', 'a host capability is unavailable'],
          ['Referenced capability unavailable', 'a referenced resource needs secure repair'], ['Repository permission exceeds host ceiling', 'an imported permission exceeds the current ceiling'],
          ['Selected provider metric unavailable for hard cap', 'a provider cannot enforce an imported limit']]);
        message = 'Privacy restore failed; ' + (reasons.get(error.message) ?? 'current configuration could not accept this export') + '. Review Settings and choose a fresh export.';
        revision++; publish();
      }
      throw error;
    }); inFlight.add(work);
    void work.then(() => inFlight.delete(work), () => inFlight.delete(work)); return work;
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); }, async close() {
    if (!closed) { finalStatus = status(); pending?.controller.abort(); invalidate(); closed = true; tokens.clear(); receipts.clear(); }
    // Save/Open panels have no documented AbortSignal. Keep their storage alive until the actual panel resolves.
    await Promise.allSettled([...inFlight]);
  } });
}
