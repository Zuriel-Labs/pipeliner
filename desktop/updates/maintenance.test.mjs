import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openVault } from '../connections/vault.mjs';
import { openUpdateMaintenance } from './maintenance.mjs';
import { createMaintenanceGate } from './idle.mjs';

test('durable update intent fences stale owners and preserves interrupted or altered maintenance without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-maintenance-'))), file = join(root, 'maintenance.sqlite');
  const from = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40),
    version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
  const plan = { from, to: { ...from, version: '0.2.0', sourceCommit: 'c'.repeat(40), gitTree: 'd'.repeat(40) },
    sha256: 'e'.repeat(64), bytes: 1000 };
  let now = 1000, vault, store, other, db;
  try {
    assert.throws(() => openUpdateMaintenance(root, { vault: {} })); assert.equal(existsSync(file), false);
    // Real authenticated payload encryption; only the OS wrapping of its installation key is synthetic.
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text),
      decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
    const open = () => openUpdateMaintenance(root, { vault, clock: () => now }); store = open();
    assert.equal(store.read(), null); assert.equal(store.clear(), true);
    for (const changed of [{ ...plan, to: from }, { ...plan, bytes: 0 }, { ...plan, sha256: 'bad' }, { ...plan, path: '/private/foreign' }])
      assert.throws(() => store.begin(changed));
    let getterCalls = 0; assert.throws(() => store.begin({ ...plan, get from() { getterCalls++; return from; } })); assert.equal(getterCalls, 0);
    const gate = createMaintenanceGate({ ready: () => true, verify: async () => true, recovery: () => !store.clear() });
    let token;
    await gate.control(() => gate.exclusive(async checkpoint => {
      token = store.begin(plan); checkpoint();
      assert.equal(store.owned(), false); assert.equal(store.owned({}), false); assert.equal(store.owned(token), true);
      await assert.rejects(gate.control(() => assert.fail('competing mutation')), /maintenance-recovery-required/);
      assert.equal(await gate.control(() => store.read().phase, { passive: true }), 'preparing');
    }, { ownsRecovery: () => store.owned(token) }));
    await assert.rejects(gate.exclusive(() => assert.fail('pending maintenance consumer')), /maintenance-recovery-required/);
    const first = store.read();
    assert.equal(first.phase, 'preparing'); assert.deepEqual(first.from, plan.from); assert.deepEqual(first.to, plan.to);
    assert.equal(first.revision, 1); assert(Object.isFrozen(first)); assert.equal(store.clear(), false);
    assert.equal(readFileSync(file).includes(plan.to.sourceCommit), false);
    other = open(); assert.throws(() => other.begin(plan)); assert.throws(() => other.advance(token, 'staged'));
    assert.throws(() => store.advance({}, 'staged')); assert.throws(() => store.advance(token, 'replacing'));
    assert.deepEqual(store.read(), first);
    db = new DatabaseSync(file); db.exec("CREATE TRIGGER refuse_intent BEFORE UPDATE ON maintenance_state BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END;");
    assert.throws(() => store.advance(token, 'staged')); assert.deepEqual(store.read(), first);
    db.exec('DROP TRIGGER refuse_intent'); db.close(); db = undefined;
    now++; store.advance(token, 'staged'); assert.equal(store.read().revision, 2);
    now++; store.cancel(token); assert.equal(store.read(), null); assert.equal(store.clear(), true);
    assert.equal(await gate.control(() => 'ready'), 'ready');
    assert.throws(() => store.cancel(token));
    db = new DatabaseSync(file); db.exec('CREATE TABLE synthetic_pressure(payload BLOB); INSERT INTO synthetic_pressure VALUES(zeroblob(1003520));');
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    assert((Math.floor(1024 ** 2 / pageSize) - db.prepare('PRAGMA page_count').get().page_count + db.prepare('PRAGMA freelist_count').get().freelist_count) * pageSize < 2 * 16384 + 4 * pageSize);
    assert.throws(() => store.begin(plan)); assert.equal(store.read(), null); assert.deepEqual(store.completed(), []);
    db.exec('DROP TABLE synthetic_pressure'); db.close(); db = undefined;
    const next = store.begin(plan); assert.equal(store.read().revision, 4);
    store.advance(next, 'staged'); assert.throws(() => store.advance(next, 'verified')); store.advance(next, 'repair-required');
    const pending = store.read(); assert.throws(() => store.cancel(next)); assert.deepEqual(store.read(), pending);
    store.close(); store = open(); assert.deepEqual(store.read(), pending); assert.equal(store.clear(), false);
    assert.equal(store.owned(), false); await assert.rejects(gate.control(() => assert.fail('restart replay')), /maintenance-recovery-required/);
    assert.throws(() => store.advance(next, 'relaunching')); assert.throws(() => store.begin(plan));
    other.close(); other = undefined; store.close();
    db = new DatabaseSync(file); db.exec('DROP TABLE maintenance_completed; PRAGMA user_version=1');
    const legacy = Buffer.from(db.prepare('SELECT payload FROM maintenance_state WHERE id=1').get().payload);
    db.exec('CREATE TABLE maintenance_completed(preserve TEXT); INSERT INTO maintenance_completed VALUES(\'synthetic conflict\');');
    assert.throws(open); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('SELECT preserve FROM maintenance_completed').get().preserve, 'synthetic conflict');
    assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM maintenance_state WHERE id=1').get().payload), legacy);
    db.exec('DROP TABLE maintenance_completed');
    store = open(); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepEqual(store.read(), pending); assert.deepEqual(store.completed(), []); assert.equal(store.owned(), false);
    assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM maintenance_state WHERE id=1').get().payload), legacy);
    db.close(); db = undefined;
    now = pending.updatedAt - 1; assert.throws(() => store.read()); assert.equal(store.clear(), false); now = pending.updatedAt;
    db = new DatabaseSync(file); db.exec('PRAGMA user_version=4'); store.close(); assert.throws(open);
    db.exec('PRAGMA user_version=2'); store = open();
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM maintenance_state WHERE id=1').get().payload), legacy);
    const row = db.prepare('SELECT payload FROM maintenance_state WHERE id=1').get(), changed = Buffer.from(row.payload); changed[changed.length - 1] ^= 1;
    db.prepare('UPDATE maintenance_state SET payload=? WHERE id=1').run(changed);
    assert.throws(() => store.read()); assert.equal(store.clear(), false); assert.throws(() => store.begin(plan));
    assert.throws(open);
    assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM maintenance_state WHERE id=1').get().payload), changed);
  } finally { db?.close(); other?.close(); store?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});
