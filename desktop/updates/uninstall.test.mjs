import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, lstatSync, utimesSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { openVault } from '../connections/vault.mjs';
import { createMaintenanceGate } from './idle.mjs';
import { inspectManagedData } from '../privacy/inventory.mjs';
import { canonicalJSON } from '../core/settings.mjs';

test('protected uninstall intent survives restart and reconciles only captured credential states without native replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-uninstall-journal-'))), file = join(root, 'uninstall.sqlite');
  let vault, journal, other, db, now = 1000;
  try {
    const { openUninstallJournal } = await import('./uninstall.mjs');
    assert.throws(() => openUninstallJournal(root, { vault: {} })); assert.equal(existsSync(file), false);
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text),
      decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
    for (const id of ['github', 'mcp-' + 'c'.repeat(64)]) vault.save(id, vault.begin(id), { credential: 'synthetic-only-' + id });
    const binding = { purpose: 'workspace', repository: null, id: 'preserved-record' }, plain = Buffer.from('Keep readable records');
    const protectedRecord = vault.sealPayload(binding, plain);
    // Journal metadata is synthetic. No actual bundle, signature, service or provider qualification is asserted.
    const plan = { bundle: join(root, 'Pipeliner.app'), identity: { kind: 'pipeliner-desktop-build', schemaVersion: 1,
      sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' },
      team: 'ABCDEFGHIJ', custody: { device: '1', inode: '2' }, credentials: vault.previewCredentialRemoval(),
      service: { qualified: true, status: 'not-registered' }, recordInventorySha256: 'd'.repeat(64) };
    const open = () => openUninstallJournal(root, { vault, clock: () => now }); journal = open();
    assert.equal(journal.read(), null); assert.equal(journal.clear(), true);
    assert.equal(inspectManagedData(root).find(category => category.id === 'updates').count, 1);
    for (const changed of [{ ...plan, extra: true }, { ...plan, bundle: '../Pipeliner.app' }, { ...plan, team: 'foreign' },
      { ...plan, service: { qualified: false, status: 'not-found' } },
      { ...plan, credentials: { ...plan.credentials, before: { ...plan.credentials.before, sha256: 'e'.repeat(64) } } }])
      assert.throws(() => journal.begin(changed), /uninstall-state-unavailable/);
    let reads = 0; assert.throws(() => journal.begin({ ...plan, get team() { reads++; return plan.team; } })); assert.equal(reads, 0);
    const gate = createMaintenanceGate({ ready: () => true, verify: async () => true, recovery: () => !journal.clear() }); let token;
    await gate.control(() => gate.exclusive(async checkpoint => {
      token = journal.begin(plan); checkpoint(); assert.equal(journal.owned(token), true);
      await assert.rejects(gate.control(() => assert.fail('No competing work')), /maintenance-recovery-required/);
      assert.equal(journal.read().phase, 'logout-pending');
    }, { ownsRecovery: () => journal.owned(token) }));
    const first = journal.read(); assert.equal(Object.isFrozen(first.plan), true); assert.equal(first.revision, 1);
    assert.equal(journal.clear(), false); assert.equal(readFileSync(file).includes(plan.bundle), false);
    assert.throws(() => journal.advance({}, 'service-pending')); assert.throws(() => journal.advance(token, 'trash-pending'));
    other = open(); assert.throws(() => other.advance(token, 'service-pending')); assert.throws(() => other.begin(plan));
    now++; journal.advance(token, 'service-pending');
    const snapshot = journal.read(), recovered = other.claimRecovery(snapshot);
    assert.equal(journal.owned(token), false); assert.equal(other.owned(recovered), true);
    assert.throws(() => journal.advance(token, 'credentials-pending')); assert.throws(() => journal.claimRecovery(snapshot));
    const beforeFailure = other.read(), exec = DatabaseSync.prototype.exec;
    const refusal = mock.method(DatabaseSync.prototype, 'exec', function (sql) { if (sql === 'COMMIT' && this.prepare('PRAGMA database_list').get().file === file) throw Error('Synthetic commit refusal'); return exec.call(this, sql); });
    try { assert.throws(() => other.advance(recovered, 'credentials-pending')); } finally { refusal.mock.restore(); }
    assert.deepEqual(other.read(), beforeFailure); assert.equal(other.owned(recovered), true);
    now++; other.advance(recovered, 'credentials-pending');
    assert.throws(() => other.advance(recovered, 'trash-pending')); assert.equal(other.read().phase, 'credentials-pending');
    const expected = other.read(); assert.deepEqual(vault.forgetCredentials(expected.plan.credentials.before), expected.plan.credentials.after);
    assert.deepEqual(vault.openPayload(binding, protectedRecord), plain);
    journal.close(); other.close(); other = null; journal = open();
    assert.deepEqual(journal.read(), expected); assert.equal(journal.clear(), false); assert.equal(journal.owned(recovered), false);
    await assert.rejects(gate.control(() => assert.fail('No automatic native replay')), /maintenance-recovery-required/);
    const resumed = journal.claimRecovery(expected); now++; journal.advance(resumed, 'trash-pending');
    assert.deepEqual(vault.connectionInventory(), plan.credentials.after);
    now++; journal.advance(resumed, 'removed'); assert.equal(journal.clear(), true);
    assert.throws(() => journal.advance(resumed, 'removed')); assert.throws(() => journal.claimRecovery(journal.read()));
    const completed = journal.read(); journal.close(); journal = open();
    assert.deepEqual(journal.read(), completed); assert.equal(journal.clear(), true); assert.equal(journal.owned(resumed), false);
    assert.deepEqual(vault.openPayload(binding, protectedRecord), plain);
    const next = journal.begin({ ...plan, credentials: vault.previewCredentialRemoval() }); assert.equal(journal.clear(), false);
    const pending = journal.read(); now = pending.updatedAt - 1; assert.throws(() => journal.read()); assert.equal(journal.clear(), false); now = pending.updatedAt;
    db = new DatabaseSync(file); db.exec('PRAGMA user_version=2'); assert.throws(() => journal.read()); assert.equal(journal.clear(), false);
    assert.throws(open); db.exec('PRAGMA user_version=1');
    const payload = Buffer.from(db.prepare('SELECT payload FROM uninstall_state WHERE id=1').get().payload), changed = Buffer.from(payload);
    changed[changed.length - 1] ^= 1; db.prepare('UPDATE uninstall_state SET payload=? WHERE id=1').run(changed);
    assert.throws(() => journal.read()); assert.equal(journal.clear(), false); assert.throws(() => journal.advance(next, 'service-pending')); assert.throws(open);
    assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM uninstall_state WHERE id=1').get().payload), changed);
    db.prepare('UPDATE uninstall_state SET payload=? WHERE id=1').run(payload); assert.deepEqual(journal.read(), pending);
    const close = DatabaseSync.prototype.close; let closeCalls = 0, closeFailure = null;
    const closure = mock.method(DatabaseSync.prototype, 'close', function () { closeCalls++; try { return close.call(this); } catch (error) { closeFailure = error.message; throw error; } });
    const rollback = mock.method(DatabaseSync.prototype, 'exec', function (sql) { if (['COMMIT', 'ROLLBACK'].includes(sql) && this.prepare('PRAGMA database_list').get().file === file) throw Error('Synthetic rollback refusal'); return exec.call(this, sql); });
    try { assert.throws(() => journal.advance(next, 'service-pending')); } finally { rollback.mock.restore(); closure.mock.restore(); }
    assert.equal(closeCalls, 1); assert.equal(closeFailure, null);
    const recoveredRow = db.prepare('SELECT revision,clock,payload FROM uninstall_state WHERE id=1').get();
    assert.equal(recoveredRow.revision, pending.revision); assert.equal(recoveredRow.clock, pending.updatedAt);
    assert.deepEqual(Buffer.from(recoveredRow.payload), payload);
    assert.throws(() => journal.read()); assert.equal(journal.clear(), false); journal = open(); assert.deepEqual(journal.read(), pending);
    assert.deepEqual(vault.openPayload(binding, protectedRecord), plain);
  } finally { db?.close(); other?.close(); journal?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});

test('Mac uninstall capture binds the packaged running bundle and refuses changing authority or inventory without native effects', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const { captureMacUninstallPlan } = await import('./uninstall.mjs'); assert.equal(typeof captureMacUninstallPlan, 'function');
  const original = Object.getOwnPropertyDescriptor(process, 'execPath');
  for (const mode of ['complete', 'source', 'hardening', 'identifier', 'team', 'duplicate', 'service', 'credentials', 'records', 'metadata', 'cancelled', 'async-checkpoint']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-uninstall-capture-'))), bundle = join(root, 'Pipeliner.app'), data = join(root, 'data');
    let vault;
    try {
      mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true, mode: 0o755 }); mkdirSync(join(bundle, 'Contents/Resources'), { mode: 0o755 }); mkdirSync(data, { mode: 0o700 });
      const executable = join(bundle, 'Contents/MacOS/Pipeliner'), resource = join(bundle, 'Contents/Resources/pipeliner-build.json');
      const identity = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
      writeFileSync(executable, 'Synthetic executable; never launched', { mode: 0o755 }); writeFileSync(resource, canonicalJSON(identity) + '\n', { mode: 0o600 });
      Object.defineProperty(process, 'execPath', { ...original, value: executable });
      vault = await openVault(data, { available: async () => true, encrypt: async text => Buffer.from(text),
        decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
      vault.save('ollama', vault.begin('ollama'), { credential: 'synthetic-only' });
      const before = vault.previewCredentialRemoval(), resourceBytes = readFileSync(resource), info = lstatSync(bundle, { bigint: true });
      const controller = new AbortController(), commands = []; let status = 'enabled', checks = 0;
      const options = { app: { isPackaged: mode !== 'source' }, background: { inspect: () => ({ qualified: true, status }) },
        directory: data, vault, signal: controller.signal, checkpoint: mode === 'async-checkpoint' ? async () => {} : () => { checks++; } };
      // Only signature/service responses are synthetic. No real codesign, login, service or Trash operation runs.
      const run = async (file, args, signal) => {
        assert.equal(file, '/usr/bin/codesign'); assert.equal(signal, controller.signal); assert.equal(args.at(-1), bundle); commands.push(args);
        if (args[0] === '--display') return { stdout: '', stderr: 'Identifier=' + (mode === 'identifier' ? 'foreign.app' : 'com.zuriellabs.pipeliner.desktop') + '\nTeamIdentifier=' + (mode === 'team' ? 'bad' : 'ABCDEFGHIJ')
          + '\nCodeDirectory v=20500 size=128 flags=0x' + (mode === 'hardening' ? '0' : '10000') + '(runtime)\n' + (mode === 'duplicate' ? 'TeamIdentifier=ABCDEFGHIJ\n' : '') };
        assert.equal(args[0], '--verify'); assert.ok(args.includes('--deep') && args.includes('--strict'));
        assert.ok(args.includes('=anchor apple generic and identifier "com.zuriellabs.pipeliner.desktop" and certificate leaf[subject.OU] = "ABCDEFGHIJ"'));
        if (mode === 'service') status = 'not-registered';
        if (mode === 'credentials') vault.save('ollama', vault.get('ollama').epoch, { credential: 'Synthetic changed credential' });
        if (mode === 'records') writeFileSync(join(data, 'privacy.sqlite'), 'Synthetic inventory change', { mode: 0o600 });
        if (mode === 'metadata') { writeFileSync(resource, resourceBytes); const stamp = lstatSync(resource); utimesSync(resource, stamp.atime, new Date(stamp.mtimeMs + 2000)); }
        if (mode === 'cancelled') controller.abort(); return { stdout: '', stderr: '' };
      };
      if (mode === 'complete') {
        for (const directory of [bundle, root, join(bundle, 'Contents/data'), 'relative'])
          await assert.rejects(captureMacUninstallPlan({ ...options, directory }, { run }), /uninstall-plan-unavailable/);
        let getters = 0; await assert.rejects(captureMacUninstallPlan({ ...options, get checkpoint() { getters++; return options.checkpoint; } }, { run }));
        assert.equal(getters, 0); assert.equal(commands.length, 0);
        const macOS = join(bundle, 'Contents/MacOS'); chmodSync(macOS, 0o777);
        try { await assert.rejects(captureMacUninstallPlan(options, { run }), /uninstall-plan-unavailable/); }
        finally { chmodSync(macOS, 0o755); }
        assert.equal(commands.length, 0);
        const result = await captureMacUninstallPlan(options, { run });
        assert.deepEqual(result.identity, identity); assert.equal(result.bundle, bundle); assert.equal(result.team, 'ABCDEFGHIJ');
        assert.deepEqual(result.custody, { device: info.dev.toString(), inode: info.ino.toString() }); assert.deepEqual(result.credentials, before);
        assert.deepEqual(result.service, { qualified: true, status: 'enabled' }); assert.match(result.recordInventorySha256, /^[a-f0-9]{64}$/);
        assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.credentials), true); assert.ok(checks > 1);
        assert.equal(commands.filter(args => args[0] === '--verify').length, 2); assert.deepEqual(vault.previewCredentialRemoval(), before);
      } else {
        await assert.rejects(captureMacUninstallPlan(options, { run }), /uninstall-plan-unavailable/);
        if (['source', 'async-checkpoint'].includes(mode)) assert.equal(commands.length, 0);
      }
      assert.equal(existsSync(join(data, 'uninstall.sqlite')), false); assert.equal(existsSync(bundle), true);
      assert.deepEqual(readFileSync(resource), resourceBytes);
    } finally { Object.defineProperty(process, 'execPath', original); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
  }
});

test('host uninstall coordinator verifies ordered effects and preserves interrupted or changed removal without replaying credential erasure', async () => {
  const { openUninstallJournal, completeUninstall } = await import('./uninstall.mjs');
  assert.equal(typeof completeUninstall, 'function');
  for (const mode of ['complete', 'concurrent', 'settlement', 'verification', 'service', 'trash', 'cancelled', 'takeover', 'credential-commit', 'changed-credentials']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-uninstall-coordinator-')));
    let vault, journal, other, token, controller, operation, second, release, erasures = 0, interrupted = false;
    try {
      vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text),
        decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
      for (const id of ['codex', 'ollama']) vault.save(id, vault.begin(id), { credential: 'synthetic-only' });
      const binding = { purpose: 'workspace', repository: null, id: 'preserved-record' }, plain = Buffer.from('Preserved records');
      const protectedRecord = vault.sealPayload(binding, plain), inventory = vault.previewCredentialRemoval();
      const plan = { bundle: join(root, 'Pipeliner.app'), identity: { kind: 'pipeliner-desktop-build', schemaVersion: 1,
        sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' },
        team: 'ABCDEFGHIJ', custody: { device: '1', inode: '2' }, credentials: inventory,
        service: { qualified: true, status: 'enabled' }, recordInventorySha256: 'd'.repeat(64) };
      journal = openUninstallJournal(root, { vault });
      const events = [], gate = createMaintenanceGate({ ready: () => true, verify: async () => true, recovery: () => !journal.clear() }); controller = new AbortController();
      const wrappedVault = { ...vault, forgetCredentials(expected) { erasures++; return vault.forgetCredentials(expected); } };
      const settled = new Promise(resolve => { release = resolve; });
      operation = gate.control(() => gate.exclusive(async checkpoint => {
        token = journal.begin(plan);
        const options = { journal, vault: wrappedVault, token, checkpoint: () => { controller.signal.throwIfAborted(); checkpoint(); },
          async settle() { events.push('settle'); assert.equal(journal.clear(), false); if (['complete', 'concurrent'].includes(mode)) await settled; return mode !== 'settlement'; },
          async logout(saved) { events.push('logout'); assert.deepEqual(saved, plan); if (mode === 'cancelled') controller.abort(); return true; },
          async removeService(saved) { events.push('service'); assert.deepEqual(saved, plan); if (mode === 'service') throw Error('Synthetic service refusal'); return true; },
          async trash(saved) { events.push('trash'); assert.deepEqual(saved, plan); assert.deepEqual(vault.connectionInventory(), inventory.after); return mode !== 'trash'; },
          async verify(intent, stage) {
            events.push(stage + ':' + intent.phase); assert.equal(Object.isFrozen(intent.plan), true); assert.equal(journal.owned(token), true);
            if (mode === 'verification') return undefined;
            if (mode === 'takeover' && stage === 'before') { other = openUninstallJournal(root, { vault }); other.claimRecovery(journal.read()); }
            if (['credential-commit', 'changed-credentials'].includes(mode) && stage === 'after' && intent.phase === 'credentials-pending' && !interrupted) {
              interrupted = true;
              if (mode === 'changed-credentials') vault.save('ollama', vault.begin('ollama'), { credential: 'Synthetic changed connection' });
              return false;
            }
            assert.deepEqual(vault.openPayload(binding, protectedRecord), plain); return true;
          } };
        let getters = 0; await assert.rejects(completeUninstall({ ...options, get trash() { getters++; return options.trash; } })); assert.equal(getters, 0);
        await assert.rejects(completeUninstall({ ...options, token: {} })); assert.deepEqual(events, []);
        if (mode === 'credential-commit') {
          await assert.rejects(completeUninstall(options), /uninstall-recovery-required/);
          const pending = journal.read(); assert.equal(pending.phase, 'credentials-pending'); assert.equal(erasures, 1);
          assert.deepEqual(vault.connectionInventory(), inventory.after);
          token = journal.claimRecovery(pending); options.token = token;
        }
        const running = completeUninstall(options);
        if (mode === 'concurrent') {
          await setImmediate();
          second = completeUninstall(options).then(() => null, error => error);
          await setImmediate(); release();
          const result = await running, refusal = await second;
          assert.match(refusal?.message ?? '', /uninstall-recovery-required/);
          assert.equal(events.filter(value => value === 'settle').length, 1); return result;
        }
        return running;
      }, { ownsRecovery: () => journal.owned(token) }));
      if (mode === 'complete') {
        await setImmediate(); await setImmediate(); assert.deepEqual(events, ['before:logout-pending', 'settle']);
        assert.equal(vault.connectionInventory().stored, 2); release();
      }
      if (['complete', 'concurrent', 'credential-commit'].includes(mode)) {
        const receipt = await operation; assert.equal(receipt.phase, 'removed'); assert.equal(Object.isFrozen(receipt), true); assert.equal(journal.clear(), true);
        assert.equal(erasures, 1); assert.deepEqual(vault.connectionInventory(), inventory.after);
        assert.equal(events.filter(value => value === 'logout').length, 1); assert.equal(events.filter(value => value === 'service').length, 1);
        assert.equal(events.filter(value => value === 'trash').length, 1);
        assert.ok(events.indexOf('logout') < events.indexOf('service') && events.indexOf('service') < events.indexOf('after:credentials-pending') && events.indexOf('after:credentials-pending') < events.indexOf('trash'));
        await assert.rejects(completeUninstall({ journal, vault, token, checkpoint() {}, settle() {}, logout() {}, removeService() {}, trash() {}, verify() {} }));
      } else {
        await assert.rejects(operation, /uninstall-recovery-required/); assert.equal(journal.clear(), false);
        const phase = journal.read().phase;
        assert.equal(phase, ({ settlement: 'logout-pending', verification: 'logout-pending', service: 'service-pending', trash: 'trash-pending',
          cancelled: 'logout-pending', takeover: 'logout-pending', 'changed-credentials': 'credentials-pending' })[mode]);
        if (mode === 'trash') { assert.equal(erasures, 1); assert.deepEqual(vault.connectionInventory(), inventory.after); }
        else if (mode === 'changed-credentials') { assert.equal(erasures, 1); assert.equal(vault.connectionInventory().stored, 1); assert.throws(() => journal.claimRecovery(journal.read())); }
        else { assert.equal(erasures, 0); assert.deepEqual(vault.connectionInventory(), inventory.before); assert.equal(events.includes('trash'), false); }
        if (mode === 'takeover') assert.equal(events.includes('settle'), false);
      }
      assert.deepEqual(vault.openPayload(binding, protectedRecord), plain);
    } finally { controller?.abort(); release?.(); await Promise.allSettled([operation, second].filter(Boolean));
      other?.close(); journal?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
  }
});

test('Mac uninstall consumer verifies native boundaries and never infers an uncertain Trash outcome', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const { captureMacUninstallPlan, completeMacUninstall, openUninstallJournal } = await import('./uninstall.mjs');
  assert.equal(typeof completeMacUninstall, 'function');
  const original = Object.getOwnPropertyDescriptor(process, 'execPath');
  for (const mode of ['complete', 'bundle', 'metadata', 'records', 'logout', 'service', 'no-trash', 'moved-error', 'cancelled']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-uninstall-native-'))), bundle = join(root, 'Pipeliner.app'), data = join(root, 'data'), destination = join(root, 'fixture-trash/Pipeliner.app');
    let vault, journal;
    try {
      mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true, mode: 0o755 }); mkdirSync(join(bundle, 'Contents/Resources'), { mode: 0o755 });
      mkdirSync(data, { mode: 0o700 }); mkdirSync(join(root, 'fixture-trash'), { mode: 0o700 });
      const executable = join(bundle, 'Contents/MacOS/Pipeliner'), resource = join(bundle, 'Contents/Resources/pipeliner-build.json');
      const identity = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
      writeFileSync(executable, 'Synthetic executable; never launched', { mode: 0o755 }); writeFileSync(resource, canonicalJSON(identity) + '\n', { mode: 0o600 });
      Object.defineProperty(process, 'execPath', { ...original, value: executable });
      vault = await openVault(data, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
      vault.save('codex', vault.begin('codex'), { credential: null, account: 'Synthetic account' }); vault.save('ollama', vault.begin('ollama'), { credential: 'Synthetic key' });
      const binding = { purpose: 'workspace', repository: null, id: 'retained' }, plain = Buffer.from('Retained readable data'), encrypted = vault.sealPayload(binding, plain);
      journal = openUninstallJournal(data, { vault });
      const controller = new AbortController(), app = { isPackaged: true }, events = []; let status = 'enabled', loggedOut = false, token;
      // These responses and fixture rename are synthetic. No native command, service mutation, account logout or OS Trash runs.
      const run = async (file, args) => { assert.equal(file, '/usr/bin/codesign'); assert.equal(args.at(-1), bundle);
        return { stdout: '', stderr: args[0] === '--display' ? 'Identifier=com.zuriellabs.pipeliner.desktop\nTeamIdentifier=ABCDEFGHIJ\nCodeDirectory v=20500 size=128 flags=0x10000(runtime)\n' : '' }; };
      const background = { inspect: () => ({ qualified: true, status }), async unregister() {
        events.push('service'); assert.equal(journal.read().phase, 'service-pending'); status = mode === 'service' ? 'requires-approval' : 'not-registered'; } };
      const gate = createMaintenanceGate({ ready: () => true, verify: async () => true, recovery: () => !journal.clear() });
      const operation = gate.control(() => gate.exclusive(async checkpoint => {
        const context = { app, background, directory: data, vault, checkpoint, signal: controller.signal };
        const plan = await captureMacUninstallPlan(context, { run }); token = journal.begin(plan);
        if (mode === 'bundle') writeFileSync(resource, canonicalJSON({ ...identity, gitTree: 'c'.repeat(40) }) + '\n');
        const options = { ...context, journal, token, async settle() { events.push('settle'); return true; },
          async logout() { events.push('logout'); assert.equal(journal.read().phase, 'logout-pending'); loggedOut = mode !== 'logout';
            if (mode === 'metadata') { const bytes = readFileSync(resource); writeFileSync(resource, bytes); const stamp = lstatSync(resource); utimesSync(resource, stamp.atime, new Date(stamp.mtimeMs + 2000)); }
            if (mode === 'records') writeFileSync(join(data, 'privacy.sqlite'), 'Changed record inventory', { mode: 0o600 }); },
          async verifyLogout() { return loggedOut; }, shell: { async trashItem(path) {
            events.push('trash'); assert.equal(path, bundle); assert.equal(journal.read().phase, 'trash-pending');
            assert.deepEqual(vault.connectionInventory(), plan.credentials.after); assert.deepEqual(vault.openPayload(binding, encrypted), plain);
            if (mode !== 'no-trash') renameSync(bundle, destination);
            if (mode === 'moved-error') throw Error('Synthetic failure after movement');
            if (mode === 'cancelled') controller.abort();
          } } };
        let getters = 0; await assert.rejects(completeMacUninstall({ ...options, get shell() { getters++; return options.shell; } }, { run })); assert.equal(getters, 0);
        if (mode === 'complete') {
          const receipt = await completeMacUninstall(options, { run }); assert.equal(receipt.phase, 'removed');
          assert.deepEqual(events, ['settle', 'logout', 'service', 'trash']); assert.equal(journal.clear(), true);
          assert.equal(existsSync(bundle), false); assert.equal(existsSync(destination), true); assert.deepEqual(vault.connectionInventory(), plan.credentials.after);
        } else {
          await assert.rejects(completeMacUninstall(options, { run }), /uninstall-recovery-required/); assert.equal(journal.clear(), false);
          assert.equal(journal.read().phase, ({ bundle: 'logout-pending', metadata: 'logout-pending', records: 'logout-pending', logout: 'logout-pending', service: 'service-pending', 'no-trash': 'trash-pending', 'moved-error': 'trash-pending', cancelled: 'trash-pending' })[mode]);
          if (['bundle', 'metadata', 'records', 'logout', 'service'].includes(mode)) { assert.equal(events.includes('trash'), false); assert.deepEqual(vault.connectionInventory(), plan.credentials.before); }
          else assert.deepEqual(vault.connectionInventory(), plan.credentials.after);
          if (mode === 'bundle') assert.deepEqual(events, []);
          if (mode === 'no-trash') assert.equal(existsSync(bundle), true);
          if (mode === 'moved-error') {
            const before = [...events]; token = journal.claimRecovery(journal.read());
            await assert.rejects(completeMacUninstall({ ...options, token }, { run }), /uninstall-recovery-required/);
            assert.deepEqual(events, before); assert.equal(existsSync(bundle), false); assert.equal(existsSync(destination), true);
          }
        }
        assert.deepEqual(vault.openPayload(binding, encrypted), plain);
      }, { signal: controller.signal, ownsRecovery: () => journal.owned(token) }));
      if (mode === 'cancelled') await assert.rejects(operation, { name: 'AbortError' }); else await operation;
    } finally { Object.defineProperty(process, 'execPath', original); journal?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
  }
});

test('explicit Mac removal recovery reconciles only captured effects under a freshly claimed token', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const { captureMacUninstallPlan, completeMacUninstall, recoverMacUninstall, openUninstallJournal } = await import('./uninstall.mjs');
  assert.equal(typeof recoverMacUninstall, 'function');
  const original = Object.getOwnPropertyDescriptor(process, 'execPath');
  for (const mode of ['logout', 'service-before', 'service-after', 'credentials-before', 'credentials-after', 'trash', 'ordinary-token', 'recovery-token-normal',
    'stale-token', 'restart-token', 'changed-credentials', 'reconnected', 'foreign-build', 'missing-bundle', 'service-refused', 'trash-uncertain', 'cancelled']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-uninstall-recovery-'))), bundle = join(root, 'Pipeliner.app'), data = join(root, 'data'), destination = join(root, 'fixture-trash/Pipeliner.app');
    let vault, journal;
    try {
      mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true, mode: 0o755 }); mkdirSync(join(bundle, 'Contents/Resources'), { mode: 0o755 });
      mkdirSync(data, { mode: 0o700 }); mkdirSync(join(root, 'fixture-trash'), { mode: 0o700 });
      const executable = join(bundle, 'Contents/MacOS/Pipeliner'), resource = join(bundle, 'Contents/Resources/pipeliner-build.json');
      const identity = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
      writeFileSync(executable, 'Synthetic executable; never launched', { mode: 0o755 }); writeFileSync(resource, canonicalJSON(identity) + '\n', { mode: 0o600 });
      Object.defineProperty(process, 'execPath', { ...original, value: executable });
      vault = await openVault(data, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
      for (const id of ['codex', 'ollama']) vault.save(id, vault.begin(id), { credential: 'Synthetic only' });
      const binding = { purpose: 'workspace', repository: null, id: 'retained' }, plain = Buffer.from('Retained readable records'), encrypted = vault.sealPayload(binding, plain);
      const wrappedVault = { ...vault, forgetCredentials(expected) { erasures++; return vault.forgetCredentials(expected); } };
      let erasures = 0, status = 'enabled', loggedOut = false; const events = [], controller = new AbortController(), app = { isPackaged: true };
      // Actual protected journal/vault and filesystem; all native boundaries remain synthetic.
      const run = async (file, args) => { assert.equal(file, '/usr/bin/codesign'); assert.equal(args.at(-1), bundle);
        return { stdout: '', stderr: args[0] === '--display' ? 'Identifier=com.zuriellabs.pipeliner.desktop\nTeamIdentifier=ABCDEFGHIJ\nCodeDirectory v=20500 size=128 flags=0x10000(runtime)\n' : '' }; };
      const background = { inspect: () => ({ qualified: true, status }), async unregister() { events.push('service'); status = mode === 'service-refused' ? 'requires-approval' : 'not-registered'; } };
      const checkpoint = () => { controller.signal.throwIfAborted(); assert.equal(journal.owned(token), true); };
      journal = openUninstallJournal(data, { vault });
      const plan = await captureMacUninstallPlan({ app, background, directory: data, vault, checkpoint() {} }, { run });
      let token = journal.begin(plan); assert.equal(journal.recoveryOwned(token), false);
      const initial = ['logout', 'ordinary-token', 'recovery-token-normal', 'stale-token', 'restart-token', 'foreign-build', 'cancelled'].includes(mode) ? 'logout-pending'
        : ['service-before', 'service-after', 'reconnected', 'service-refused'].includes(mode) ? 'service-pending'
          : ['credentials-before', 'credentials-after', 'changed-credentials'].includes(mode) ? 'credentials-pending' : 'trash-pending';
      if (initial !== 'logout-pending') { loggedOut = true; journal.advance(token, 'service-pending'); }
      if (['credentials-pending', 'trash-pending'].includes(initial)) { status = 'not-registered'; journal.advance(token, 'credentials-pending'); }
      if (initial === 'trash-pending') { vault.forgetCredentials(plan.credentials.before); journal.advance(token, 'trash-pending'); }
      if (mode === 'service-after') status = 'not-registered';
      if (mode === 'credentials-after') vault.forgetCredentials(plan.credentials.before);
      if (mode !== 'ordinary-token') {
        const expected = journal.read(); journal.close(); journal = openUninstallJournal(data, { vault });
        assert.equal(journal.owned(token), false); assert.deepEqual(journal.read(), expected);
        token = journal.claimRecovery(expected); assert.equal(journal.recoveryOwned(token), true);
      }
      if (mode === 'stale-token') journal.claimRecovery(journal.read());
      if (mode === 'restart-token') { journal.close(); journal = openUninstallJournal(data, { vault }); }
      if (mode === 'changed-credentials') vault.save('ollama', vault.begin('ollama'), { credential: 'Changed synthetic credential' });
      if (mode === 'reconnected') loggedOut = false;
      if (mode === 'foreign-build') writeFileSync(resource, canonicalJSON({ ...identity, gitTree: 'c'.repeat(40) }) + '\n');
      if (mode === 'missing-bundle') renameSync(bundle, destination);
      const saved = journal.read(), inventory = vault.connectionInventory();
      const options = { app, background, directory: data, vault: wrappedVault, journal, token, checkpoint, signal: controller.signal,
        async settle() { events.push('settle'); if (mode === 'cancelled') controller.abort(); return true; },
        async logout() { events.push('logout'); loggedOut = true; }, async verifyLogout() { return loggedOut; },
        shell: { async trashItem(path) { events.push('trash'); assert.equal(path, bundle); assert.equal(journal.read().phase, 'trash-pending');
          assert.deepEqual(vault.connectionInventory(), plan.credentials.after); renameSync(bundle, destination);
          if (mode === 'trash-uncertain') throw Error('Synthetic uncertain native move'); } } };
      const consume = mode === 'recovery-token-normal' ? completeMacUninstall : recoverMacUninstall;
      if (['logout', 'service-before', 'service-after', 'credentials-before', 'credentials-after', 'trash'].includes(mode)) {
        const result = await consume(options, { run }); assert.equal(result.phase, 'removed'); assert.equal(journal.clear(), true);
        assert.deepEqual(vault.connectionInventory(), plan.credentials.after); assert.equal(existsSync(bundle), false); assert.equal(existsSync(destination), true);
        assert.deepEqual(events, ['settle', ...(initial === 'logout-pending' ? ['logout'] : []),
          ...(['logout', 'service-before'].includes(mode) ? ['service'] : []), 'trash']);
        assert.equal(erasures, ['credentials-after', 'trash'].includes(mode) ? 0 : 1);
        assert.equal(journal.recoveryOwned(token), false);
      } else {
        await assert.rejects(consume(options, { run }), /uninstall-recovery-required/); assert.equal(journal.clear(), false); assert.deepEqual(journal.read(), saved);
        if (mode === 'trash-uncertain') { assert.deepEqual(events, ['settle', 'trash']); assert.equal(existsSync(bundle), false); assert.equal(existsSync(destination), true);
          token = journal.claimRecovery(journal.read()); const before = [...events]; await assert.rejects(recoverMacUninstall({ ...options, token }, { run })); assert.deepEqual(events, before); }
        else { assert.deepEqual(vault.connectionInventory(), inventory); assert.equal(erasures, 0);
          assert.deepEqual(events, mode === 'service-refused' ? ['settle', 'service'] : mode === 'cancelled' ? ['settle'] : []); }
      }
      assert.deepEqual(vault.openPayload(binding, encrypted), plain);
    } finally { Object.defineProperty(process, 'execPath', original); journal?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
  }
});
test('removal coordination holds exact journal authority through completion and cold recovery', async () => {
  const { coordinateUninstall, openUninstallJournal, completeUninstall } = await import('./uninstall.mjs');
  const { createMaintenanceGate } = await import('./idle.mjs');
  assert.equal(typeof coordinateUninstall, 'function');
  for (const mode of ['normal', 'cold', 'cancel', 'changed', 'forged', 'busy']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-removal-coordinate-')));
    let vault, journal, held, stopping, release, entered, effect = 0;
    const controller = new AbortController(), hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    try {
      vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
      vault.save('ollama', vault.begin('ollama'), { synthetic: true });
      journal = openUninstallJournal(root, { vault });
      const plan = { bundle: join(root, 'Pipeliner.app'), identity: { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' },
        team: 'ABCDEFGHIJ', custody: { device: '1', inode: '2' }, credentials: vault.previewCredentialRemoval(), service: { qualified: true, status: 'enabled' }, recordInventorySha256: 'c'.repeat(64) };
      if (mode === 'cold') { journal.begin(plan); journal.close(); journal = openUninstallJournal(root, { vault }); }
      const gate = createMaintenanceGate({ ready: () => mode !== 'busy', verify: async () => true, recovery: () => !journal.clear(), recoveryReady: () => true, verifyRecovery: async () => true });
      held = coordinateUninstall({ journal, maintenance: gate, ...(mode === 'cold' ? {} : { plan }), signal: controller.signal, checkpoint() {},
        async consume({ token, checkpoint, signal, recovering }) {
          assert.equal(gate.active(), true); assert.equal(journal.recoveryOwned(token), recovering); assert.equal(recovering, mode === 'cold');
          checkpoint(); entered();
          if (mode === 'forged') return { ...journal.read(), phase: 'removed' };
          if (['cancel', 'changed'].includes(mode)) { await hold; checkpoint(); }
          return completeUninstall({ journal, vault, token, checkpoint,
            async settle() { return true; }, async logout() { effect++; return true; }, async removeService() { effect++; return true; },
            async trash() { effect++; return true; }, async verify() { signal.throwIfAborted(); return true; } });
        } });
      held.catch(() => {});
      if (mode !== 'busy') await started;
      if (mode === 'cancel') { controller.abort(); await setImmediate(); assert.equal(gate.active(), true); }
      if (mode === 'changed') journal.claimRecovery(journal.read());
      release();
      if (['normal', 'cold'].includes(mode)) { assert.equal(await held, true); assert.equal(journal.read().phase, 'removed'); assert.equal(effect, 3); }
      else { await assert.rejects(held); assert.equal(effect, 0); assert.equal(journal.read()?.phase ?? null, mode === 'busy' ? null : 'logout-pending'); }
      assert.equal(gate.active(), false);
    } finally { release(); await Promise.allSettled([held, stopping].filter(Boolean)); journal?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
  }
});
