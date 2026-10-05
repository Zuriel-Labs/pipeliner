import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigurationExport, configurationChanges, createDiagnosticExport } from './model.mjs';
import { developmentTemplate } from '../core/settings.mjs';

const snapshot = settings => ({ scope: 'repository', target: 'first', revision: 7, hash: 'a'.repeat(64), settings });
test('configuration exports typed selected overrides, excludes handles and automatic dispatch, and restores inheritance', () => {
  const envelope = createConfigurationExport(snapshot({ 'privacy.logDays': 12, 'pipelines.development': developmentTemplate,
    'connections.ollama': 'cloud', 'agents.dev': 'dev', 'scheduling.enabled': true, 'permissions.resources': ['private-folder'] }), 1000);
  assert.deepEqual(envelope.repair, ['agents.dev', 'connections.ollama', 'permissions.resources', 'scheduling.enabled']);
  assert.equal(JSON.stringify(envelope).includes('private-folder'), false); assert.equal(envelope.settings['scheduling.enabled'], undefined);
  const edit = configurationChanges(envelope, { scope: 'repository', target: 'first', currentSettings: { 'privacy.auditDays': 400, 'connections.ollama': 'current', 'scheduling.enabled': false } });
  assert.deepEqual(edit.reset, ['privacy.auditDays']); assert.equal(edit.changes['privacy.logDays'], 12);
  assert.deepEqual(edit.changes['pipelines.development'], developmentTemplate); assert.equal(edit.changes['connections.ollama'], undefined);
});
test('restore rejects changed contents, foreign scope, credentials and an unknown or future schema', () => {
  const envelope = createConfigurationExport(snapshot({ 'privacy.logDays': 12 }), 1000), context = { scope: 'repository', target: 'first', currentSettings: {} };
  assert.throws(() => configurationChanges({ ...envelope, settings: { 'privacy.logDays': 200 } }, context), /Configuration integrity/);
  for (const target of ['second', null]) assert.throws(() => configurationChanges(envelope, { ...context, target }), /Configuration scope/);
  assert.throws(() => configurationChanges({ ...envelope, credential: 'synthetic' }, context), /Configuration format/);
  assert.throws(() => configurationChanges({ ...envelope, version: 2 }, context), /Configuration format/);
  assert.throws(() => createConfigurationExport(snapshot({ credential: 'synthetic' }), 1000), /Configuration field/);
  assert.throws(() => createConfigurationExport(snapshot({ 'privacy.logDays': 'sk-secret' }), 1000), /Invalid/);
});
test('free-form pipeline and testing values cannot export credential-shaped contents', () => {
  const pipeline = structuredClone(developmentTemplate); pipeline.steps[0].expectedResult = 'Bearer synthetic-secret';
  assert.throws(() => createConfigurationExport(snapshot({ 'pipelines.development': pipeline }), 1000), /Configuration contains protected/);
  assert.throws(() => createConfigurationExport(snapshot({ 'testing.instructions': [{ action: 'Use token=synthetic-secret', expected: 'success' }] }), 1000), /Configuration contains protected/);
});
test('host exports cannot restore background authorization, update trust, permission ceilings or runtime identities', () => {
  const envelope = createConfigurationExport({ ...snapshot({ 'appearance.theme': 'dark', 'background.enabled': true, 'updates.source': 'trusted', 'permissions.ceiling': ['workspace.read'] }), scope: 'host', target: null }, 1000);
  assert.deepEqual(envelope.settings, { 'appearance.theme': 'dark' });
  const edit = configurationChanges(envelope, { scope: 'host', target: null, currentSettings: { 'permissions.ceiling': ['workspace.read'], 'background.enabled': false, 'appearance.motion': 'reduced' } });
  assert.deepEqual(edit.reset, ['appearance.motion']); assert.equal(edit.changes['permissions.ceiling'], undefined);
});
const diagnostic = () => ({ appVersion: '0.1.0', host: { platform: 'darwin', architecture: 'arm64', version: '27.0.1' },
  storage: { protected: true, categories: { conversation: 2, log: 1, audit: 3 }, ciphertextBytes: 1000 },
  connections: { github: 'disconnected', codex: 'connected', ollama: 'blocked' },
  recovery: { activeRuns: 1, uncertainEffects: 0, blockedRuns: 1 }, background: { configured: false, effective: false } });
test('diagnostics allow only bounded version, status and count fields, with no raw logs or destinations', () => {
  const envelope = createDiagnosticExport(diagnostic(), 1000); assert.equal(envelope.kind, 'pipeliner-diagnostics'); assert.equal(envelope.createdAt, 1000);
  for (const value of [{ ...diagnostic(), rawLog: 'secret' }, { ...diagnostic(), connections: { ...diagnostic().connections, account: 'private' } },
    { ...diagnostic(), host: { ...diagnostic().host, path: '/Users/private' } }, { ...diagnostic(), recovery: { ...diagnostic().recovery, activeRuns: -1 } }])
    assert.throws(() => createDiagnosticExport(value, 1000), /Diagnostic/);
});
