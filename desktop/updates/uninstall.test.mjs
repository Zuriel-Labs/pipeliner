import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
