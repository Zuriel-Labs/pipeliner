import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJSON, immutable } from '../core/settings.mjs';
import { openVault } from '../connections/vault.mjs';
import { openUpdateHistory } from './history.mjs';
import { openUpdateMaintenance } from './maintenance.mjs';
import { openPolicyStore } from '../core/policy.mjs';
import { createUpdateManager } from './manager.mjs';
import { updateCommand } from './commands.mjs';
import { createUpdateControlChannel } from '../core/control.mjs';
import { createMaintenanceGate } from './idle.mjs';
import { openUninstallJournal } from './uninstall.mjs';

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

test('explicit removal consumes a private preview and awaits cancellation; cold recovery needs no normal policy store', async () => {
  for (const mode of ['normal', 'cancel', 'policy', 'expired', 'cold']) {
    const f = fixture(); let update, pending, stopped, release, entered, effects = 0, finished = 0, closed = 0, now = 1000;
    let recovery = mode === 'cold', phase = recovery ? 'service-pending' : null;
    const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const plan = immutable({ bundle: join(f.root, 'Pipeliner.app'), identity: { kind: 'pipeliner-desktop-build', schemaVersion: 1,
      sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' },
      team: 'ABCDEFGHIJ', custody: { device: '1', inode: '2' }, credentials: { before: { count: 1, stored: 1, sha256: 'c'.repeat(64) }, after: { count: 1, stored: 0, sha256: 'd'.repeat(64) } },
      service: { qualified: true, status: 'enabled' }, recordInventorySha256: 'e'.repeat(64) });
    async function consume({ plan: captured, checkpoint, signal }) {
      if (mode !== 'cold') assert.equal(captured, plan); else assert.equal(captured, undefined);
      effects++; entered(); checkpoint(); recovery = true; phase = 'credentials-pending';
      update.sync(); assert.equal(signal.aborted, false); checkpoint();
      try { if (['cancel', 'policy'].includes(mode)) await hold; checkpoint(); signal.throwIfAborted(); phase = 'removed'; recovery = false; return true; }
      finally { finished++; }
    }
    try {
      update = createUpdateManager({ policy: mode === 'cold' ? null : f.policy, version: '0.1.0', clock: () => now,
        maintenance: createMaintenanceGate({ ready: () => true, verify: async () => true }), inspectRemoval: async () => plan,
        removeApp: consume, recoverRemoval: consume, recovery: () => recovery, onRemoved() { assert.equal(update.status().busy, false); closed++; },
        removalDetails: () => phase ? { phase, version: '0.1.0', credentialCount: 1, backgroundStatus: 'enabled' } : null });
      const url = 'pipeliner://app/index.html', frame = { url, parent: null }, contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
      const channel = createUpdateControlChannel(update, { contents, url, context: () => ({ revision: update.status().revision }) });
      const request = payload => channel.dispatch(event, { ...payload, contextRevision: update.status().revision });
      assert.equal(updateCommand('Remove Desktop app').operation, 'removal-apply');
      assert.equal(updateCommand('Resume Desktop removal').operation, 'removal-resume');
      assert.equal(updateCommand('Stop Desktop removal').operation, 'stop');
      assert.throws(() => channel.dispatch({ ...event, sender: {} }, { operation: 'removal-resume', contextRevision: update.status().revision }));
      await assert.rejects(request({ operation: 'removal-apply' }));
      if (mode === 'cold') {
        assert.equal(update.status().storageAvailable, false); assert.equal(update.status().removalRecoverable, true);
        pending = request({ operation: 'chat', text: 'Resume Desktop removal' });
      } else {
        await request({ operation: 'removal-inspect' }); const preview = update.status().removalPreview;
        assert.equal(update.status().removalQualified, true);
        assert.throws(() => request({ operation: 'removal-apply', hash: preview.hash, bundle: plan.bundle }));
        await assert.rejects(request({ operation: 'removal-apply', hash: '0'.repeat(64) })); assert.equal(effects, 0);
        if (mode === 'expired') {
          now = preview.expiresAt + 1; await assert.rejects(request({ operation: 'removal-apply', hash: preview.hash })); assert.equal(effects, 0); continue;
        }
        pending = request({ operation: 'removal-apply', hash: preview.hash });
      }
      await started;
      if (['cancel', 'policy'].includes(mode)) {
        assert.equal(update.status().busy, true); assert.equal(update.status().removalPreview, null);
        if (mode === 'cancel') stopped = request({ operation: 'chat', text: 'Cancel Desktop removal' });
        else { f.edit({ 'appearance.theme': 'dark' }); update.sync(); }
        await new Promise(setImmediate); assert.equal(finished, 0); assert.equal(closed, 0); release();
      }
      await pending; await stopped; assert.equal(effects, 1); assert.equal(finished, 1); assert.equal(update.status().busy, false);
      assert.equal(closed, ['normal', 'cold'].includes(mode) ? 1 : 0);
      if (closed) { assert.equal(update.status().removal.phase, 'removed'); await assert.rejects(request({ operation: 'removal-apply' })); }
      else { assert.equal(update.status().recoveryRequired, true); assert.match(update.status().message, /recovery/i); }
      assert.doesNotMatch(JSON.stringify(update.status()), new RegExp(f.root + '|ABCDEFGHIJ|' + plan.credentials.before.sha256));
    } finally { release(); await Promise.allSettled([pending, stopped].filter(Boolean)); await update?.close(); f.close(); }
  }
});

test('PM removal inspection is read-only, redacted and fenced across idle capture, expiry, cancellation and recovery', async () => {
  for (const mode of ['normal', 'cancel', 'policy', 'close', 'recovery']) {
    const f = fixture(); let update, vault, journal, pending, stopping, finish, entered, now = 1000, idle = true, captures = 0, settled = 0;
    const held = new Promise(resolve => { finish = resolve; }), started = new Promise(resolve => { entered = resolve; });
    try {
      vault = await openVault(f.root, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
      vault.save('ollama', vault.begin('ollama'), { synthetic: true }); journal = openUninstallJournal(f.root, { vault, clock: () => now });
      const plan = immutable({ bundle: join(f.root, 'Pipeliner.app'), identity: { kind: 'pipeliner-desktop-build', schemaVersion: 1,
        sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' },
        team: 'ABCDEFGHIJ', custody: { device: '1', inode: '2' }, credentials: vault.previewCredentialRemoval(),
        service: { qualified: true, status: 'enabled' }, recordInventorySha256: 'c'.repeat(64) });
      const before = vault.connectionInventory(), policyBefore = f.policy.worker.read(null);
      const maintenance = createMaintenanceGate({ ready: () => idle, verify: async () => true, recovery: () => !journal.clear() });
      update = createUpdateManager({ policy: f.policy, version: '0.1.0', maintenance, clock: () => now, recovery: () => !journal.clear(),
        removalDetails: () => { const saved = journal.read(); return saved ? { phase: saved.phase, version: saved.plan.identity.version,
          credentialCount: saved.plan.credentials.before.stored, backgroundStatus: saved.plan.service.status } : null; },
        async inspectRemoval({ checkpoint, signal }) {
          captures++; entered();
          try { checkpoint(); if (mode !== 'normal') await held; signal.throwIfAborted(); checkpoint(); return plan; }
          finally { settled++; }
        } });
      const url = 'pipeliner://app/index.html', frame = { url, parent: null }, contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
      const channel = createUpdateControlChannel(update, { contents, url, context: () => ({ revision: update.status().revision }) });
      assert.equal(update.status().removalInspectable, true); assert.equal(update.status().removalQualified, false);
      const request = () => ({ operation: 'chat', text: 'Review Desktop removal', contextRevision: update.status().revision });
      assert.throws(() => channel.dispatch({ ...event, sender: {} }, request()));
      assert.throws(() => channel.dispatch({ ...event, senderFrame: { url, parent: frame } }, request()));
      assert.throws(() => channel.dispatch(event, { operation: 'removal-inspect', contextRevision: update.status().revision, bundle: plan.bundle }));
      assert.throws(() => channel.dispatch(event, { operation: 'removal-inspect', contextRevision: 0 })); assert.equal(captures, 0);
      idle = false; await maintenance.control(() => channel.dispatch(event, request())); assert.equal(captures, 0); assert.equal(update.status().removalPreview, null);
      idle = true; pending = maintenance.control(() => channel.dispatch(event, request())); await started;
      if (mode !== 'normal') {
        assert.equal(update.status().busy, true); assert.equal(maintenance.active(), true);
        await maintenance.control(() => channel.dispatch(event, { operation: 'status' }), { passive: true });
        await assert.rejects(maintenance.control(() => assert.fail('competing mutation')), /maintenance-active/);
        if (mode === 'cancel') stopping = maintenance.control(() => channel.dispatch(event, { operation: 'chat', text: 'Cancel Desktop removal', contextRevision: update.status().revision }), { passive: true });
        if (mode === 'policy') { f.edit({ 'appearance.theme': 'dark' }); update.sync(); }
        if (mode === 'close') stopping = update.close();
        if (mode === 'recovery') { journal.begin(plan); update.sync(); }
        if (stopping) { await new Promise(setImmediate); assert.equal(settled, 0); assert.equal(maintenance.active(), true); }
        finish(); await stopping;
      }
      await pending; assert.equal(captures, 1); assert.equal(settled, 1); assert.equal(maintenance.active(), false);
      assert.equal(update.status().removalQualified, false); assert.deepEqual(vault.connectionInventory(), before);
      if (mode === 'normal') {
        const preview = update.status().removalPreview;
        assert.deepEqual(Object.keys(preview).sort(), ['backgroundStatus', 'credentialCount', 'expiresAt', 'gitTree', 'hash', 'sourceCommit', 'version']);
        assert.equal(preview.credentialCount, 1); assert.equal(preview.version, '0.1.0'); assert.equal(preview.expiresAt, now + 900000);
        assert.doesNotMatch(JSON.stringify(update.status()), new RegExp(f.root + '|ABCDEFGHIJ|' + plan.credentials.before.sha256));
        assert.deepEqual(f.policy.worker.read(null), policyBefore); assert.equal(journal.read(), null);
        now = preview.expiresAt + 1; assert.equal(update.status().removalPreview, null);
        await maintenance.control(() => channel.dispatch(event, request())); await update.dispatch({ operation: 'chat', text: 'Cancel Desktop removal' });
        assert.equal(update.status().removalPreview, null); assert.equal(journal.read(), null);
      } else assert.equal(update.status().removalPreview, null);
      if (mode === 'recovery') {
        assert.deepEqual(update.status().removal, { phase: 'logout-pending', version: '0.1.0', credentialCount: 1, backgroundStatus: 'enabled' });
        assert.equal(update.status().recoveryRequired, true); await assert.rejects(update.dispatch({ operation: 'removal-inspect' }), /maintenance-recovery-required/);
        const unopened = createUpdateManager({ version: '0.1.0', recovery: () => true, removalDetails: () => update.status().removal });
        assert.deepEqual((await unopened.dispatch({ operation: 'view' })).snapshot.removal, update.status().removal); assert.equal(unopened.status().storageAvailable, false); await unopened.close();
        for (const details of [{ ...update.status().removal, path: f.root }, { ...update.status().removal, credentialCount: -1 }, { ...update.status().removal, phase: 'complete' }]) {
          const refused = createUpdateManager({ recovery: () => true, removalDetails: () => details });
          assert.equal(refused.status().removal, null); assert.equal(refused.status().recoveryRequired, true); await refused.close();
        }
        journal.close(); assert.equal(update.status().removal, null); assert.equal(update.status().recoveryRequired, true);
      }
    } finally { finish(); await Promise.allSettled([pending, stopping].filter(Boolean)); await update?.close(); journal?.close(); vault?.close(); f.close(); }
  }
});

test('maintenance recovery view stays authenticated and read-only when normal policy storage is unopened', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-update-recovery-')));
  const from = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40),
    version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
  let vault, journal, update, malformed = false;
  try {
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
    journal = openUpdateMaintenance(root, { vault, clock: () => 1000 });
    const token = journal.begin({ from, to: { ...from, version: '0.2.0', sourceCommit: 'c'.repeat(40), gitTree: 'd'.repeat(40) }, sha256: 'e'.repeat(64), bytes: 1000 });
    const details = () => { const saved = journal.read(); return { phase: saved.phase, fromVersion: saved.from.version, toVersion: saved.to.version,
      installerRecorded: Boolean(saved.installer), backupsRecorded: saved.backups?.databases.length ?? 0,
      candidateRecorded: Boolean(saved.copy?.receipt), replacementRecorded: Boolean(saved.replacement) }; };
    update = createUpdateManager({ version: from.version, recovery: () => !journal.clear(), recoveryDetails: () => malformed ? { ...details(), path: root } : details() });
    const url = 'pipeliner://app/index.html', frame = { url, parent: null }, contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
    const channel = createUpdateControlChannel(update, { contents, url, context: () => ({ revision: update.status().revision }) });
    const gate = createMaintenanceGate({ ready: () => false, verify: async () => assert.fail('No maintenance work admitted'), recovery: () => !journal.clear() });
    const view = await gate.control(() => channel.dispatch(event, { operation: 'view', contextRevision: update.status().revision }), { passive: true });
    assert.equal(view.snapshot.storageAvailable, false); assert.equal(view.snapshot.recoveryRequired, true); assert.deepEqual(view.snapshot.maintenance, details());
    const before = journal.read();
    await gate.control(() => channel.dispatch(event, { operation: 'chat', text: 'Show Desktop updates', contextRevision: update.status().revision }), { passive: true });
    assert.deepEqual(channel.dispatch(event, { operation: 'status' }).maintenance, details());
    for (const operation of ['prepare', 'source', 'reset', 'apply', 'cancel', 'check', 'install']) await assert.rejects(update.dispatch({ operation,
      ...(operation === 'prepare' ? { changes: { 'updates.channel': 'beta' } } : operation === 'source' ? { name: null } : {}) }));
    assert.throws(() => channel.dispatch({ ...event, sender: {} }, { operation: 'status' }));
    assert.throws(() => channel.dispatch({ ...event, senderFrame: { url, parent: frame } }, { operation: 'status' }));
    assert.throws(() => channel.dispatch(event, { operation: 'view', contextRevision: 0 }));
    assert.throws(() => channel.dispatch(event, { operation: 'view', contextRevision: update.status().revision, approved: true }));
    assert.deepEqual(journal.read(), before); assert.deepEqual(journal.completed(), []);
    assert.doesNotMatch(JSON.stringify(view.snapshot), new RegExp(root));
    assert.equal(existsSync(join(root, 'policy.sqlite')), false); assert.equal(existsSync(join(root, 'updates')), false);
    journal.advance(token, 'staged'); assert.equal(update.status().maintenance.phase, 'staged');
    journal.advance(token, 'repair-required'); assert.equal(update.status().maintenance.phase, 'repair-required');
    for (const invalid of [true, 'throws']) {
      malformed = invalid; if (invalid === 'throws') journal.close();
      assert.equal(update.status().maintenance, null); assert.equal(update.status().recoveryRequired, true);
    }
    await update.close(); await assert.rejects(update.dispatch({ operation: 'view' }));
  } finally { await update?.close(); journal?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});

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
  let now = 1000, trusted = true, foreground = true, mode = 'normal', calls = 0, settled = 0, releaseRead, update, vault, history, journal;
  let idle = true, holdInspection = false, inspectionCalls = 0, inspectionSettled = 0;
  const maintenance = createMaintenanceGate({ ready: () => idle, verify: async signal => {
    inspectionCalls++;
    try {
      if (holdInspection) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted(); return true;
    } finally { inspectionSettled++; }
  } });
  try {
    vault = await openVault(f.root, { available: async () => true, encrypt: async text => Buffer.from(text),
      decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
    history = openUpdateHistory(f.root, { vault, clock: () => now });
    journal = openUpdateMaintenance(f.root, { vault, clock: () => now });
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
    const open = () => createUpdateManager({ policy: f.policy, history, version: '0.1.0', sources: () => trusted ? [source] : [], reader, maintenance, recovery: () => !journal.clear(),
      foreground: () => foreground, host: { platform: 'darwin', architecture: 'arm64' } });
    update = open(); await assert.rejects(update.dispatch({ operation: 'source', name: 'Unknown publisher' })); assert.equal(calls, 0);
    await update.dispatch({ operation: 'chat', text: 'Use Desktop update source Synthetic Releases' });
    assert.equal(update.status().preview.after['updates.source'].value, source.label);
    assert.doesNotMatch(JSON.stringify(update.status()), /approved-source|updates\.example|BEGIN PUBLIC/);
    await update.dispatch({ operation: 'apply' }); assert.equal(update.status().sourceQualified, true);
    await update.dispatch({ operation: 'chat', text: 'Check for Desktop updates' });
    assert.equal(update.status().lastCheck, now); assert.equal(update.status().release.version, '0.2.0'); assert.equal(update.status().installQualified, false);
    const policyRevision = f.policy.worker.read(null).revision;
    idle = false; await maintenance.control(() => update.dispatch({ operation: 'install' }));
    assert.match(update.status().message, /deferred/); assert.equal(inspectionCalls, 0);
    idle = true; await maintenance.control(() => update.dispatch({ operation: 'chat', text: 'Update Desktop when idle' }));
    assert.match(update.status().message, /Idle work verified/); assert.equal(update.status().installQualified, false);
    holdInspection = true;
    const inspecting = maintenance.control(() => update.dispatch({ operation: 'install' }));
    assert.equal(update.status().busy, true); assert.equal(maintenance.active(), true);
    await maintenance.control(() => update.dispatch({ operation: 'stop' }), { passive: true }); await inspecting;
    assert.equal(inspectionSettled, inspectionCalls); assert.equal(update.status().busy, false); assert.equal(maintenance.active(), false);
    assert.equal(calls, 1); assert.equal(f.policy.worker.read(null).revision, policyRevision); holdInspection = false;
    const from = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40),
      version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
    const intent = journal.begin({ from, to: { ...from, version: release.version, sourceCommit: release.sourceCommit, gitTree: release.gitTree }, sha256: release.sha256, bytes: release.bytes });
    assert.equal(update.status().recoveryRequired, true); assert.match(update.status().message, /verified recovery/);
    assert.doesNotMatch(JSON.stringify(update.status()), new RegExp(f.root));
    await update.dispatch({ operation: 'chat', text: 'Show Desktop updates' }); await update.dispatch({ operation: 'stop' });
    for (const operation of ['check', 'install', 'reset', 'cancel', 'apply']) await assert.rejects(update.dispatch({ operation }), /maintenance-recovery-required/);
    await update.poll(); assert.equal(calls, 1); assert.equal(f.policy.worker.read(null).revision, policyRevision);
    journal.cancel(intent); assert.equal(update.status().recoveryRequired, false);
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
  } finally { releaseRead?.(); await update?.close(); journal?.close(); history?.close(); vault?.close(); f.close(); }
});

test('update preparation binds its exact live intent without cancelling itself or reopening competing work', async () => {
  for (const mode of ['normal', 'stop', 'close', 'policy', 'source', 'foreign', 'wrong-token', 'token-loss']) {
    const f = fixture(), { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const source = { id: 'approved-source', label: 'Synthetic Releases', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
    const trust = { id: source.id, key: source.key, origin: source.origin, path: source.path }, current = { version: '0.1.0', platform: 'darwin', architecture: 'arm64', channel: 'stable' };
    const from = { kind: 'pipeliner-desktop-build', schemaVersion: 1, version: current.version, platform: current.platform, architecture: current.architecture,
      sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40) };
    const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: source.id, ...current, version: '0.2.0', sequence: 1,
      issuedAt: 900, expiresAt: 100000000, url: source.origin + source.path + 'Pipeliner.dmg', bytes: 1000,
      sha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40), gitTree: 'e'.repeat(40) };
    let vault, history, journal, update, intent, prepared = 0, settled = 0, trusted = true, signal, finish;
    const hold = new Promise(resolve => { finish = resolve; });
    try {
      vault = await openVault(f.root, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
      history = openUpdateHistory(f.root, { vault, clock: () => 1000 });
      const attempt = history.begin(trust, current);
      history.complete(attempt.token, Buffer.from(canonicalJSON({ release, signature: sign(null, Buffer.from(canonicalJSON(release)), privateKey).toString('base64') })));
      const open = () => openUpdateMaintenance(f.root, { vault, clock: () => 1000 }); journal = open();
      f.edit({ 'updates.source': source.id });
      const maintenance = createMaintenanceGate({ ready: () => true, verify: async () => true, recovery: () => !journal.clear() });
      update = createUpdateManager({ policy: f.policy, history, version: current.version, host: { platform: current.platform, architecture: current.architecture },
        maintenance, sources: () => trusted ? [source] : [], recovery: () => !journal.clear(), ownsIntent: token => journal.owned(token),
        // Synthetic preparation effects; actual protected policy, signed history, journal and host admission.
        async prepareInstaller(options) {
          prepared++; signal = options.signal;
          try {
            assert.deepEqual(options.trust, trust); assert.deepEqual(options.current, current); options.checkpoint();
            intent = journal.begin({ from, to: { ...from, version: release.version, sourceCommit: release.sourceCommit, gitTree: release.gitTree }, bytes: release.bytes, sha256: release.sha256 });
            if (mode !== 'foreign') options.onIntent(mode === 'wrong-token' ? Object.freeze({}) : intent);
            update.sync(); options.checkpoint(); signal.throwIfAborted();
            assert.equal(update.status().busy, true); assert.equal(update.status().recoveryRequired, true); assert.equal(signal.aborted, false);
            assert.throws(() => options.onIntent(intent));
            await hold; options.checkpoint(); signal.throwIfAborted(); return intent;
          } finally { settled++; }
        } });
      const operation = maintenance.control(() => update.dispatch({ operation: 'install' }));
      await new Promise(setImmediate); assert.equal(prepared, 1);
      if (!['foreign', 'wrong-token'].includes(mode)) {
        assert.equal(update.status().busy, true); assert.equal(signal.aborted, false); assert.equal(maintenance.active(), true);
        await maintenance.control(() => update.dispatch({ operation: 'view' }), { passive: true });
        await assert.rejects(maintenance.control(() => assert.fail('competing mutation')), /maintenance-recovery-required/);
        await assert.rejects(update.dispatch({ operation: 'install' }), /maintenance-recovery-required/);
        await update.poll(); assert.equal(prepared, 1);
        let stopping;
        if (mode === 'stop') stopping = maintenance.control(() => update.dispatch({ operation: 'stop' }), { passive: true });
        if (mode === 'close') stopping = update.close();
        if (mode === 'policy') { f.edit({ 'appearance.theme': 'dark' }); update.sync(); }
        if (mode === 'source') { trusted = false; update.sync(); }
        if (mode === 'token-loss') { journal.close(); journal = open(); update.sync(); }
        if (mode !== 'normal') assert.equal(signal.aborted, true);
        if (stopping) { assert.equal(settled, 0); assert.equal(maintenance.active(), true); }
        finish(); await stopping;
      }
      await operation;
      assert.equal(settled, 1); assert.equal(update.status().busy, false); assert.equal(maintenance.active(), false);
      assert.equal(update.status().installQualified, false); assert.equal(journal.clear(), false);
      assert.equal(update.status().recoveryRequired, true); assert.match(update.status().message, /verified recovery/);
      assert.doesNotMatch(JSON.stringify(update.status()), new RegExp(f.root));
      const retained = journal.read(); journal.close(); journal = open();
      assert.deepEqual(journal.read(), retained); assert.equal(journal.owned(intent), false);
      await assert.rejects(maintenance.exclusive(() => assert.fail('restart replay')), /maintenance-recovery-required/);
    } finally { finish(); await update?.close(); journal?.close(); history?.close(); vault?.close(); f.close(); }
  }
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
    assert.equal(unavailable.status().storageAvailable, false); assert.equal((await unavailable.dispatch({ operation: 'view' })).snapshot.storageAvailable, false); unavailable.close();
  } finally { f.close(); }
});
