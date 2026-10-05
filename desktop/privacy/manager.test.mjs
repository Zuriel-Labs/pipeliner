import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openVault } from '../connections/vault.mjs';
import { openPolicyStore } from '../core/policy.mjs';
import { openPrivacyStore } from './store.mjs';
import { createPrivacyManager } from './manager.mjs';
import { privacyCommand } from './commands.mjs';
import { createPrivacyControlChannel } from '../core/control.mjs';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-privacy-manager-')));
  let vault, policy, records, manager, selected = 'first', clock = 1000, destination = join(root, 'export.json'), source = destination, select;
  async function close() { try { await manager?.close(); records?.close(); policy?.close(); vault?.close(); } finally { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } }
  try {
    // Synthetic OS wrapper; actual encryption uses the vault, native Keychain qualification remains separate.
    vault = await openVault(root, { available: async () => true, encrypt: async value => Buffer.from(value.split('').reverse().join('')), decrypt: async value => ({ result: value.toString().split('').reverse().join(''), shouldReEncrypt: false }) });
    policy = openPolicyStore(root, { clock: () => clock, catalog: () => ({ repositories: ['first', 'second'], capabilities: ['workspace.read', 'workspace.write', 'worker.exec'], maxConcurrency: 1,
      background: false, connections: [], developers: [], extensions: [] }) });
    records = openPrivacyStore(root, { vault, clock: () => clock });
    manager = createPrivacyManager({ records, policy, clock: () => clock, workspace: () => ({ id: selected, name: selected }),
      chooseExport: async () => select ? select() : destination, chooseImport: async () => source, protectedPaths: [],
      diagnostics: () => ({ appVersion: '0.1.0', host: { platform: 'darwin', architecture: 'arm64', version: '27.0.1' }, storage: { protected: true, categories: { conversation: 0, log: 0, audit: 0 }, ciphertextBytes: 0 },
        connections: { github: 'disconnected', codex: 'disconnected', ollama: 'disconnected' }, recovery: { activeRuns: 0, uncertainEffects: 0, blockedRuns: 0 }, background: { configured: false, effective: false } }) });
  } catch (error) { await close(); throw error; }
  return { root, policy, records, manager, close, select: value => { selected = value; manager.sync(); }, path: value => { destination = value; }, input: value => { source = value; },
    pending: value => { select = value; }, advance: value => { clock += value; } };
}
test('chat and Settings share exact retention proposals and stale context cannot apply them', async () => {
  const f = await fixture();
  try {
    await f.manager.dispatch({ operation: 'chat', text: 'Keep logs for 12 days for this project' }); const preview = f.manager.status().preview;
    assert.equal(f.policy.worker.read('first').values['privacy.logDays'].value, 30);
    f.select('second'); await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: preview.hash }), /Privacy preview/);
    f.select('first'); await f.manager.dispatch({ operation: 'prepare', changes: { 'privacy.logDays': 12 }, scope: 'repository' });
    await f.manager.dispatch({ operation: 'apply', hash: f.manager.status().preview.hash });
    assert.equal(f.policy.worker.read('first').values['privacy.logDays'].value, 12); assert.equal(f.policy.worker.read('second').values['privacy.logDays'].value, 30);
    assert.equal(privacyCommand('apply privacy change').operation, 'apply'); assert.equal(privacyCommand('quoted "apply privacy change"'), null);
  } finally { await f.close(); }
});
test('chosen exports remain unwritten until exact apply; restore uses a fresh policy proposal and preserves other scope', async () => {
  const f = await fixture(), destination = join(f.root, 'export.json');
  try {
    await f.manager.dispatch({ operation: 'prepare', changes: { 'privacy.auditDays': 400 } }); await f.manager.dispatch({ operation: 'apply' });
    await f.manager.dispatch({ operation: 'export', kind: 'configuration', scope: 'repository' }); const preview = f.manager.status().preview;
    assert.equal(existsSync(destination), false); assert.equal(preview.destination, destination);
    await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: 'f'.repeat(64) }), /Privacy preview/);
    await f.manager.dispatch({ operation: 'apply', hash: preview.hash }); assert.equal(existsSync(destination), true);
    assert.equal(JSON.parse(readFileSync(destination)).settings['privacy.auditDays'], 400);
    await f.manager.dispatch({ operation: 'prepare', changes: { 'privacy.auditDays': 500 } }); await f.manager.dispatch({ operation: 'apply' });
    await f.manager.dispatch({ operation: 'import', scope: 'repository' }); assert.equal(f.policy.worker.read('first').values['privacy.auditDays'].value, 500);
    await f.manager.dispatch({ operation: 'apply', hash: f.manager.status().preview.hash });
    assert.equal(f.policy.worker.read('first').values['privacy.auditDays'].value, 400); assert.equal(f.policy.worker.read('second').values['privacy.auditDays'].value, 365);
  } finally { await f.close(); }
});
test('native selection cancellation or context drift creates no export and no reusable preview', async () => {
  const f = await fixture();
  try {
    f.path(null); await f.manager.dispatch({ operation: 'export', kind: 'configuration' }); assert.equal(f.manager.status().preview, null);
    let release; f.pending(() => new Promise(resolve => { release = resolve; }));
    const work = f.manager.dispatch({ operation: 'export', kind: 'configuration' }); await Promise.resolve();
    f.select('second'); release(join(f.root, 'changed.json')); await assert.rejects(work, /Privacy context/);
    assert.equal(existsSync(join(f.root, 'changed.json')), false); assert.equal(f.manager.status().preview, null);
  } finally { await f.close(); }
});
test('restore reports linked-file denial and rejects bytes changed after its exact preview', async () => {
  const f = await fixture(), path = join(f.root, 'export.json'), alias = join(f.root, 'alias.json');
  try {
    await f.manager.dispatch({ operation: 'prepare', changes: { 'privacy.logDays': 17 } }); await f.manager.dispatch({ operation: 'apply' });
    await f.manager.dispatch({ operation: 'export', kind: 'configuration' }); await f.manager.dispatch({ operation: 'apply' });
    await f.manager.dispatch({ operation: 'prepare', changes: { 'privacy.logDays': 19 } }); await f.manager.dispatch({ operation: 'apply' });
    const original = readFileSync(path), revision = f.policy.worker.read('first').revision;
    linkSync(path, alias); await assert.rejects(f.manager.dispatch({ operation: 'import' }), /another hard link/);
    assert.equal(f.manager.status().errorCode, 'PRIVACY_IMPORT_LINKS'); assert.equal(f.manager.status().preview, null);
    assert.equal(f.policy.worker.read('first').revision, revision); assert.deepEqual(readFileSync(path), original);
    unlinkSync(alias); await f.manager.dispatch({ operation: 'import' }); const preview = f.manager.status().preview;
    assert.equal(f.manager.status().errorCode, null); writeFileSync(path, original.toString().replace('17', '18'));
    await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: preview.hash }), /Privacy import failed/);
    assert.equal(f.policy.worker.read('first').revision, revision); assert.equal(f.policy.worker.read('first').values['privacy.logDays'].value, 19);
  } finally { await f.close(); }
});
test('old host-issued conversation tokens save only their original scope and stored approval text grants no authority', async () => {
  const f = await fixture();
  try {
    const token = f.manager.status().conversationToken, commandId = randomUUID(), initial = f.policy.worker.read('first').revision;
    await f.manager.dispatch({ operation: 'append', token, commandId, role: 'pm', text: 'Approved' });
    await f.manager.dispatch({ operation: 'append', token, commandId, role: 'pm', text: 'Approved' }); f.select('second');
    await f.manager.dispatch({ operation: 'append', token, commandId: randomUUID(), role: 'app', text: 'Late reply for the first repository' });
    assert.equal(f.records.list('first', 'conversation', { runId: 'messages' }).length, 2); assert.equal(f.records.list('second', 'conversation').length, 0);
    assert.equal(f.policy.worker.read('first').revision, initial);
    await assert.rejects(f.manager.dispatch({ operation: 'append', token: randomUUID(), commandId: randomUUID(), role: 'pm', text: 'forged' }), /Privacy conversation/);
  } finally { await f.close(); }
});
test('closing waits for the owned native panel and rejects its late selection before closing storage', async () => {
  const f = await fixture(); let release;
  try {
    f.pending(() => new Promise(resolve => { release = resolve; }));
    const work = f.manager.dispatch({ operation: 'export', kind: 'configuration' }); await Promise.resolve();
    const outcome = assert.rejects(work, /Privacy context/); let finished = false;
    const closing = f.manager.close().then(() => { finished = true; }); await Promise.resolve();
    assert.equal(finished, false); assert.equal(f.records.inventory().categories.length, 0);
    release(join(f.root, 'late.json')); await outcome; await closing;
    assert.equal(existsSync(join(f.root, 'late.json')), false);
    await assert.rejects(f.manager.dispatch({ operation: 'view' }), /Privacy protected storage/);
  } finally { release?.(null); await f.close(); }
});
test('app history redacts protected-looking content; ordinary PM keys never persist', async () => {
  const f = await fixture();
  try {
    const token = f.manager.status().conversationToken;
    await f.manager.dispatch({ operation: 'append', token, commandId: randomUUID(), role: 'app', text: 'Candidate ' + 'a'.repeat(40) + ' received. token=synthetic-private-value' });
    const history = await f.manager.dispatch({ operation: 'history' });
    assert.equal(history.messages[0].value.text, 'Candidate [protected-looking text omitted] received. [protected-looking text omitted]');
    await assert.rejects(f.manager.dispatch({ operation: 'append', token, commandId: randomUUID(), role: 'pm', text: 'token=synthetic-private-value' }), /protected key/);
    assert.equal(f.records.list('first', 'conversation').length, 1);
  } finally { await f.close(); }
});
test('privacy IPC rejects other frames and stale policy actions while old capabilities archive data only', async () => {
  const f = await fixture();
  try {
    const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { isDestroyed: () => false, mainFrame: frame }, event = { sender: contents, senderFrame: frame };
    const channel = createPrivacyControlChannel(f.manager, { contents, url: frame.url, context: () => ({ revision: f.manager.status().revision }) });
    const revision = f.manager.status().revision, token = f.manager.status().conversationToken;
    assert.throws(() => channel.dispatch({ ...event, senderFrame: { ...frame } }, { operation: 'status' }), /Untrusted/);
    f.select('second');
    assert.throws(() => channel.dispatch(event, { operation: 'prepare', contextRevision: revision, changes: { 'privacy.logDays': 12 } }), /Control context/);
    await channel.dispatch(event, { operation: 'append', contextRevision: revision, token, commandId: randomUUID(), role: 'app', text: 'old repository reply' });
    assert.equal(f.records.list('first', 'conversation').length, 1); assert.equal(f.records.list('second', 'conversation').length, 0);
    assert.throws(() => channel.dispatch(event, { operation: 'append', contextRevision: revision, token, commandId: randomUUID(), role: 'app', text: 'data only', scope: 'host' }), /Invalid policy/);
    assert.equal(f.policy.worker.read('second').values['privacy.logDays'].value, 30);
  } finally { await f.close(); }
});
test('chat deletion survives its transient confirmation but a different persisted draft invalidates it', async () => {
  const f = await fixture();
  try {
    const token = f.manager.status().conversationToken;
    await f.manager.dispatch({ operation: 'draft', token, text: 'delete local conversations' });
    await f.manager.dispatch({ operation: 'chat', text: 'delete local conversations' });
    assert.equal(f.records.draft('first'), ''); assert.ok(f.manager.status().preview.count > 0);
    await f.manager.dispatch({ operation: 'chat', text: 'apply privacy deletion' });
    assert.equal(f.records.list('first', 'conversation').length, 0);
    const next = f.manager.status().conversationToken;
    await f.manager.dispatch({ operation: 'chat', text: 'delete local conversations' });
    await f.manager.dispatch({ operation: 'draft', token: next, text: 'different unsent message' });
    await assert.rejects(f.manager.dispatch({ operation: 'apply' }), /Privacy preview changed/);
    assert.equal(f.records.draft('first'), 'different unsent message');
    assert.equal(privacyCommand('show diagnostics').operation, 'diagnostics');
    await f.manager.dispatch({ operation: 'diagnostics' }); assert.equal(f.manager.status().diagnostics.kind, 'pipeliner-diagnostics');
    assert.equal(existsSync(join(f.root, 'export.json')), false);
  } finally { await f.close(); }
});
