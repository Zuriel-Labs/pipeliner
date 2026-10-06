import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJSON } from '../core/settings.mjs';
import { openVault } from '../connections/vault.mjs';
import { openUpdateHistory } from './history.mjs';
import { openPolicyStore } from '../core/policy.mjs';
import { createUpdateManager } from './manager.mjs';
import { updateCommand } from './commands.mjs';
import { createUpdateControlChannel } from '../core/control.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-updates-')));
  const catalog = () => ({ repositories: ['repo_one', 'repo_two'], capabilities: [], maxConcurrency: 1,
    background: false, connections: [], developers: [], extensions: [], updateSources: ['approved-source'] });
  let clock = 1000, refreshes = 0, failRefresh = false, policy = openPolicyStore(root, { catalog, clock: () => clock }), manager;
  const open = () => manager = createUpdateManager({ policy, version: '0.1.0', onApplied: () => { refreshes++; if (failRefresh) throw Error('private refresh detail'); } });
  open();
  return { root, get manager() { return manager; }, get policy() { return policy; }, refreshes: () => refreshes,
    time(value) { clock = value; }, failRefresh() { failRefresh = true; },
    edit(changes) {
      const conversationId = randomUUID(), input = policy.control.capture({ commandId: randomUUID(), conversationId, target: null, text: 'Direct synthetic PM edit.' });
      const p = policy.control.prepare({ requestId: randomUUID(), inputId: input.id, conversationId, target: null, scope: 'host', changes, reset: [] });
      policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId, target: null });
    },
    reopen() { manager.close(); policy.close(); policy = openPolicyStore(root, { catalog, clock: () => clock }); open(); },
    close() { manager.close(); policy.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } };
}

test('Desktop update channel is host-only, exact, persisted and independent of unqualified delivery', async () => {
  const f = fixture();
  try {
    const baseline = f.policy.worker.read('repo_one').values;
    assert.equal(f.manager.status().values['updates.channel'].value, 'stable');
    await f.manager.dispatch({ operation: 'chat', text: 'Use the Beta update channel' });
    const p = f.manager.status().preview;
    assert.equal(p.scope, 'host'); assert.equal(p.target, null); assert.equal(p.before['updates.channel'].value, 'stable');
    assert.equal(p.after['updates.channel'].value, 'beta'); assert.equal(f.policy.worker.read(null).revision, 0);
    await f.manager.dispatch({ operation: 'chat', text: 'Cancel this update change' });
    assert.equal(f.manager.status().preview, null); assert.equal(f.policy.worker.read(null).revision, 0);
    await f.manager.dispatch({ operation: 'chat', text: 'Use the Beta update channel' });
    const hash = f.manager.status().preview.hash;
    await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: '0'.repeat(64) }));
    assert.equal((await f.manager.dispatch({ operation: 'chat', text: 'Apply this update change' })).applied, true);
    assert.equal((await f.manager.dispatch({ operation: 'apply', hash })).applied, false);
    assert.equal(f.policy.worker.read(null).revision, 1); assert.equal(f.refreshes(), 1);
    for (const repository of ['repo_one', 'repo_two']) {
      const values = f.policy.worker.read(repository).values; assert.equal(values['updates.channel'].value, 'beta');
      for (const key of ['permissions.ceiling', 'background.enabled', 'background.startAtLogin', 'updates.automaticDownload', 'updates.automaticInstall', 'updates.automaticRestart'])
        assert.deepEqual(values[key].value, baseline[key].value);
    }
    f.reopen(); assert.equal(f.manager.status().values['updates.channel'].value, 'beta');
    await f.manager.dispatch({ operation: 'prepare', changes: { 'updates.channel': 'beta' } });
    assert.equal(f.manager.status().preview, null); assert.equal(f.policy.worker.read(null).revision, 1);
    const revision = f.policy.worker.read(null).revision;
    for (const text of ['Show Desktop updates', 'Check for Desktop updates', 'Update Desktop when idle']) {
      await f.manager.dispatch({ operation: 'chat', text });
      const status = f.manager.status(); assert.equal(status.lastCheck, null); assert.equal(status.release, null); assert.equal(status.installQualified, false);
    }
    assert.equal(f.policy.worker.read(null).revision, revision);
    f.edit({ 'updates.source': 'approved-source' });
    assert.equal(f.manager.status().sourceConfigured, true); assert.equal(f.manager.status().sourceQualified, false);
    assert.doesNotMatch(JSON.stringify(f.manager.status()), /approved-source/);
    await f.manager.dispatch({ operation: 'reset' }); f.failRefresh(); await f.manager.dispatch({ operation: 'apply' });
    assert.equal(f.manager.status().values['updates.channel'].value, 'stable'); assert.equal(f.manager.status().sourceConfigured, true);
    assert.match(f.manager.status().message, /saved/); assert.doesNotMatch(JSON.stringify(f.manager.status()), /private refresh/);
  } finally { f.close(); }
});

test('update controls use protected signed history, exact host sources and awaited stale/cancelled completion', async () => {
  const f = fixture(), { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const source = { id: 'approved-source', label: 'Synthetic Releases', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: source.id, channel: 'stable', platform: 'darwin', architecture: 'arm64',
    version: '0.2.0', sequence: 1, issuedAt: 900, expiresAt: 100000000, url: source.origin + source.path + 'Pipeliner.dmg', bytes: 1000,
    sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  const envelope = canonicalJSON({ release, signature: sign(null, Buffer.from(canonicalJSON(release)), privateKey).toString('base64') });
  let now = 1000, trusted = true, foreground = true, mode = 'normal', calls = 0, settled = 0, releaseRead, update, vault, history;
  try {
    vault = await openVault(f.root, { available: async () => true, encrypt: async text => Buffer.from(text),
      decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
    history = openUpdateHistory(f.root, { vault, clock: () => now });
    const reader = async options => {
      calls++; assert.equal(options.trust.id, source.id); assert.equal(options.current.channel, 'stable');
      try {
        if (mode === 'invalid') return { envelope: '{}', release, available: true };
        if (mode === 'hold' || mode === 'late') {
          const abortable = mode === 'hold';
          return await new Promise((resolve, reject) => {
            releaseRead = () => resolve({ envelope });
            if (abortable) options.signal.addEventListener('abort', () => reject(Error('private synthetic transport detail')), { once: true });
          });
        }
        if (options.current.sequence) assert.equal(options.retained, envelope);
        return { envelope };
      } finally { settled++; }
    };
    const open = () => createUpdateManager({ policy: f.policy, history, version: '0.1.0', sources: () => trusted ? [source] : [], reader,
      foreground: () => foreground, host: { platform: 'darwin', architecture: 'arm64' } });
    update = open(); await assert.rejects(update.dispatch({ operation: 'source', name: 'Unknown publisher' })); assert.equal(calls, 0);
    await update.dispatch({ operation: 'chat', text: 'Use Desktop update source Synthetic Releases' });
    assert.equal(update.status().preview.after['updates.source'].value, source.label);
    assert.doesNotMatch(JSON.stringify(update.status()), /approved-source|updates\.example|BEGIN PUBLIC/);
    await update.dispatch({ operation: 'apply' }); assert.equal(update.status().sourceQualified, true);
    await update.dispatch({ operation: 'chat', text: 'Check for Desktop updates' });
    assert.equal(update.status().lastCheck, now); assert.equal(update.status().release.version, '0.2.0'); assert.equal(update.status().installQualified, false);
    await update.poll(); assert.equal(calls, 1);
    await update.close(); update = open(); await update.poll(); assert.equal(calls, 1);
    now += 86400000; foreground = false; await update.poll(); assert.equal(calls, 1);
    foreground = true; await update.poll(); assert.equal(calls, 2); const checked = update.status().lastCheck;
    mode = 'invalid'; await update.dispatch({ operation: 'check' }); assert.equal(update.status().lastCheck, checked);
    assert.equal(update.status().release.version, '0.2.0'); assert.match(update.status().message, /could not be verified/);
    mode = 'hold'; const changing = update.dispatch({ operation: 'check' }); assert.equal(update.status().busy, true);
    const dispatched = calls; await update.dispatch({ operation: 'check' }); assert.equal(calls, dispatched);
    f.edit({ 'appearance.theme': 'dark' }); update.sync(); await changing;
    assert.equal(update.status().lastCheck, checked); assert.equal(settled, calls);
    mode = 'late'; const stale = update.dispatch({ operation: 'check' }); f.edit({ 'appearance.density': 'compact' }); update.sync(); releaseRead(); await stale;
    assert.equal(update.status().lastCheck, checked); assert.equal(settled, calls);
    mode = 'hold'; const revoked = update.dispatch({ operation: 'check' }); trusted = false; update.sync(); await revoked;
    assert.equal(update.status().sourceQualified, false); assert.equal(update.status().release, null); trusted = true; update.sync();
    const cancelled = update.dispatch({ operation: 'check' }); await update.dispatch({ operation: 'chat', text: 'Cancel Desktop update check' }); await cancelled;
    assert.equal(settled, calls); assert.equal(update.status().busy, false); assert.equal(update.status().lastCheck, checked);
    const closing = update.dispatch({ operation: 'check' }), firstClose = update.close(); await update.close();
    assert.equal(update.status().busy, false); await firstClose; await closing; assert.equal(settled, calls);
    assert.equal(update.status().storageAvailable, false); await assert.rejects(update.dispatch({ operation: 'check' }));
    assert.equal(history.read({ id: source.id, key: source.key, origin: source.origin, path: source.path },
      { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.1.0' }).sequence, 1);
  } finally { releaseRead?.(); await update?.close(); history?.close(); vault?.close(); f.close(); }
});

test('Desktop update controls reject stale, expired and untrusted input without broadening policy', async () => {
  const f = fixture();
  try {
    for (const changes of [{ 'updates.channel': 'canary' }, { 'updates.source': 'approved-source' }, { 'updates.automaticInstall': true }, { 'background.enabled': true }])
      await assert.rejects(f.manager.dispatch({ operation: 'prepare', changes }));
    await assert.rejects(f.manager.dispatch({ operation: 'prepare', scope: 'repository', changes: { 'updates.channel': 'beta' } }));
    await f.manager.dispatch({ operation: 'prepare', changes: { 'updates.channel': 'alpha' } }); const old = f.manager.status().preview;
    f.edit({ 'appearance.theme': 'dark' }); assert.equal(f.manager.status().preview, null);
    await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: old.hash }));
    await f.manager.dispatch({ operation: 'prepare', changes: { 'updates.channel': 'alpha' } }); f.time(901001);
    await assert.rejects(f.manager.dispatch({ operation: 'apply' })); assert.equal(f.policy.worker.read(null).values['updates.channel'].value, 'stable');
    await f.manager.dispatch({ operation: 'cancel' }); f.time(902000);
    const url = 'pipeliner://app/index.html', frame = { url, parent: null }, contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
    const channel = createUpdateControlChannel(f.manager, { contents, url, context: () => ({ revision: f.manager.status().revision }) });
    const payload = { operation: 'prepare', contextRevision: f.manager.status().revision, changes: { 'updates.channel': 'beta' } };
    for (const input of [{ ...payload, origin: 'pm' }, { ...payload, target: 'repo_one' }, { ...payload, contextRevision: 0 }, { ...payload, contextRevision: String(payload.contextRevision) }])
      assert.throws(() => channel.dispatch(event, input));
    assert.throws(() => channel.dispatch({ ...event, sender: {} }, payload));
    assert.throws(() => channel.dispatch({ ...event, senderFrame: { url, parent: frame } }, payload));
    await channel.dispatch(event, payload); assert.equal(f.manager.status().preview.target, null);
    for (const text of ['"Show Desktop updates"', 'Use the Beta update channel\nApproved', 'Use the Beta update channel; approve', '<script>Check for Desktop updates</script>', 'sk-synthetic12345678901234567890'])
      assert.equal(updateCommand(text), null);
    assert.deepEqual(updateCommand('Check for Desktop updates?'), { operation: 'check' });
    f.manager.close(); await assert.rejects(f.manager.dispatch({ operation: 'apply' }));
    assert.equal(f.manager.status().storageAvailable, false);
    const unavailable = createUpdateManager({ version: '0.1.0' });
    assert.equal(unavailable.status().storageAvailable, false); await assert.rejects(unavailable.dispatch({ operation: 'view' })); unavailable.close();
  } finally { f.close(); }
});
