import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { openVault } from '../connections/vault.mjs';
import { createMaintenanceGate } from './idle.mjs';
import { inspectManagedData } from '../privacy/inventory.mjs';

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
