import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openTestVault } from '../connections/test-vault.mjs';
import { openArtifactStore } from './artifacts.mjs';
import { createRecordCodec } from '../privacy/records.mjs';
import { verifyProtectedBackup } from '../privacy/backup.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-artifacts-'))), source = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-artifact-source-')));
  const vault = await openTestVault(root); let store, limits = { keepLatest: 3, warningBytes: 4 * 1024 ** 2, capacityBytes: 8 * 1024 ** 2 };
  const open = async () => store = await openArtifactStore(root, { vault, limits: () => limits }); await open();
  const make = (label, bytes = Buffer.from('synthetic installer bytes ' + label)) => {
    const name = label + '.dmg'; writeFileSync(join(source, name), bytes, { mode: 0o600 });
    return { repository: 'repo_one', commandId: randomUUID(), sourceDirectory: source, manifest: { name, bytes: bytes.length, sha256: digest(bytes), sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40),
      host: { os: 'darwin', architecture: 'arm64', version: '27.0.1' }, validation: { protocol: 'synthetic-custody-fixture', result: 'passed', receiptHash: digest('fixture-' + label) } } };
  };
  return { root, source, make, get store() { return store; }, get vault() { return vault; }, limit(value) { limits = { ...limits, ...value }; },
    async reopen() { await store.close(); await open(); }, async close() { await store.close(); vault.close(); rmSync(root, { recursive: true }); rmSync(source, { recursive: true }); assert.equal(existsSync(root), false); assert.equal(existsSync(source), false); } };
}
test('actual bytes are protected, verified, scoped, durable and deduplicated by exact command identity', async () => {
  const f = await fixture();
  try {
    const input = f.make('first', Buffer.from('private synthetic artifact body '.repeat(3000))), receipt = await f.store.capture(input);
    assert.equal(receipt.state, 'verified'); assert.equal(receipt.manifest.sha256, input.manifest.sha256);
    assert.equal((await f.store.capture(input)).id, receipt.id); assert.equal(f.store.inventory('repo_one').items.length, 1);
    await assert.rejects(f.store.capture({ ...input, manifest: { ...input.manifest, gitTree: 'c'.repeat(40) } }), /changed/);
    assert.equal(f.store.inventory('repo_two').items.length, 0);
    for (const file of [join(f.root, 'artifacts.sqlite'), join(f.root, 'artifacts', receipt.id + '.pipeliner-artifact')]) {
      assert.equal(readFileSync(file).includes(Buffer.from('private synthetic')), false); assert.equal(lstatSync(file).mode & 0o777, 0o600);
    }
    await f.reopen(); assert.equal(f.store.inventory('repo_one').items[0].id, receipt.id); assert.equal(await f.store.verify('repo_one', receipt.id), true);
    assert.equal(JSON.stringify(f.store.inventory('repo_one')).includes(f.source), false);
    await assert.rejects(f.store.verify('repo_two', receipt.id));
  } finally { await f.close(); }
});
test('retention preserves latest, pins, active and recovery artifacts; exact PM previews invalidate after a change', async () => {
  const f = await fixture();
  try {
    f.limit({ keepLatest: 1 }); const a = await f.store.capture(f.make('a'));
    let p = f.store.prepare('repo_one', { action: 'pin', id: a.id }); await f.store.apply(p); assert.equal(f.store.inventory('repo_one').items[0].pinned, true);
    const b = await f.store.capture(f.make('b')); await f.store.apply(f.store.prepare('repo_one', { action: 'recovery', id: b.id }));
    const c = await f.store.capture(f.make('c')); await f.store.hold('repo_one', c.id, true);
    const d = await f.store.capture(f.make('d')); const e = await f.store.capture(f.make('e'));
    p = f.store.prepare('repo_one', { action: 'retain' }); assert.deepEqual(p.remove, [d.id]);
    await f.store.apply(f.store.prepare('repo_one', { action: 'unpin', id: a.id })); await assert.rejects(f.store.apply(p), /changed/);
    await f.store.apply(f.store.prepare('repo_one', { action: 'pin', id: a.id }));
    p = f.store.prepare('repo_one', { action: 'retain' }); await f.store.apply(p);
    assert.deepEqual(new Set(f.store.inventory('repo_one').items.map(x => x.id)), new Set([a.id, b.id, c.id, e.id]));
    assert.equal(existsSync(join(f.root, 'artifacts', d.id + '.pipeliner-artifact')), false);
    await f.store.apply(f.store.prepare('repo_one', { action: 'recovery', id: e.id }));
    assert.equal(f.store.inventory('repo_one').items.find(x => x.id === b.id).recovery, false);
    await assert.rejects(f.store.hold('repo_one', c.id, false), /settled/);
    await f.store.hold('repo_one', c.id, false, { settled: true });
    f.limit({ capacityBytes: 1 }); assert.equal(f.store.inventory('repo_one').overCapacity, true);
    await assert.rejects(f.store.capture(f.make('blocked')), /capacity/); assert.equal(f.store.inventory('repo_one').items.length, 4);
  } finally { await f.close(); }
});
test('quota and hostile sources reject before artifact allocation; warning counts actual ciphertext and metadata', async () => {
  const f = await fixture();
  try {
    f.limit({ warningBytes: 1, capacityBytes: 80 * 1024 }); const input = f.make('large', Buffer.alloc(100 * 1024, 7));
    await assert.rejects(f.store.capture(input), /capacity/); assert.deepEqual(readdirSync(join(f.root, 'artifacts')), []);
    f.limit({ capacityBytes: 8 * 1024 ** 2 }); const link = f.make('link'); rmSync(join(f.source, link.manifest.name)); symlinkSync(join(f.source, 'large.dmg'), join(f.source, link.manifest.name));
    await assert.rejects(f.store.capture(link)); assert.equal(f.store.inventory('repo_one').items.length, 0);
    const receipt = await f.store.capture(f.make('small')); const view = f.store.inventory('repo_one'); assert.equal(view.warning, true); assert.ok(view.usedBytes > receipt.manifest.bytes);
    assert.throws(() => f.store.prepare('repo_two', { action: 'pin', id: receipt.id }));
  } finally { await f.close(); }
});
test('tampered bytes and authenticated metadata fail closed without deleting unrelated files', async () => {
  const f = await fixture();
  try {
    const a = await f.store.capture(f.make('a')), file = join(f.root, 'artifacts', a.id + '.pipeliner-artifact');
    const bytes = readFileSync(file); bytes[0] ^= 1; writeFileSync(file, bytes);
    await assert.rejects(f.store.verify('repo_one', a.id));
    const other = join(f.source, 'unrelated.txt'); writeFileSync(other, 'preserve', { mode: 0o600 });
    await f.store.close(); const db = new DatabaseSync(join(f.root, 'artifacts.sqlite'));
    try { const row = db.prepare('SELECT id,payload FROM artifacts').get(), altered = Buffer.from(row.payload); altered[0] ^= 1; db.prepare('UPDATE artifacts SET payload=? WHERE id=?').run(altered, row.id); } finally { db.close(); }
    await assert.rejects(f.reopen(), /unavailable/); assert.equal(readFileSync(other, 'utf8'), 'preserve'); assert.equal(existsSync(file), true);
  } finally { await f.close(); }
});
test('cancelled capture settles handles, preserves interrupted custody and rejects blind replay', async () => {
  const f = await fixture();
  try {
    const input = f.make('cancel', Buffer.alloc(2 * 1024 ** 2, 8)), controller = new AbortController(), operation = f.store.capture({ ...input, signal: controller.signal });
    // Wait for the durable allocation to appear, then cancel actual asynchronous file work.
    while (!f.store.inventory('repo_one').items.length) await new Promise(resolve => setImmediate(resolve));
    controller.abort(); await assert.rejects(operation, /interrupted/);
    assert.equal(f.store.inventory('repo_one').items[0].state, 'interrupted'); assert.equal(f.store.inventory('repo_one').items[0].active, false);
    await assert.rejects(f.store.capture(input), /recovery/); await f.reopen(); assert.equal(f.store.inventory('repo_one').items[0].state, 'interrupted');
    assert.deepEqual(f.store.prepare('repo_one', { action: 'retain' }).remove, []);
  } finally { await f.close(); }
});
test('changed eligible bytes, expired proposals and altered allocation ownership stop retention', async () => {
  const f = await fixture();
  try {
    f.limit({ keepLatest: 1 }); const first = await f.store.capture(f.make('older')), latest = await f.store.capture(f.make('latest'));
    const expired = f.store.prepare('repo_one', { action: 'retain' }); expired.expiresAt = 1;
    expired.hash = digest(JSON.stringify(Object.fromEntries(Object.keys(expired).filter(key => key !== 'hash').sort().map(key => [key, expired[key]]))));
    await assert.rejects(f.store.apply(expired), /changed/);
    const preview = f.store.prepare('repo_one', { action: 'retain' }), file = join(f.root, 'artifacts', first.id + '.pipeliner-artifact'), bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1; writeFileSync(file, bytes);
    await assert.rejects(f.store.apply(preview), /verified/); assert.equal(existsSync(file), true); assert.equal(await f.store.verify('repo_one', latest.id), true);
    const before = readdirSync(join(f.root, 'artifacts')).sort(); await assert.rejects(f.store.capture(f.make('new')), /preserved/);
    assert.deepEqual(readdirSync(join(f.root, 'artifacts')).sort(), before);
  } finally { await f.close(); }
});
test('retention retains consumed command receipts and blocks reallocation after restart', async () => {
  const f = await fixture();
  try {
    f.limit({ keepLatest: 1 }); const input = f.make('consumed'), first = await f.store.capture(input); await f.store.capture(f.make('latest'));
    const before = f.store.inventory('repo_one').usedBytes; await f.store.apply(f.store.prepare('repo_one', { action: 'retain' }));
    assert.equal(f.store.inventory('repo_one').items.length, 1); await assert.rejects(f.store.capture(input), /removed/); assert.equal(f.store.summary('repo_one').receipts, 1);
    assert.ok(f.store.inventory('repo_one').usedBytes < before); await f.reopen();
    await assert.rejects(f.store.capture(input), /removed/); assert.equal(f.store.inventory('repo_one').items.length, 1);
    assert.equal(existsSync(join(f.root, 'artifacts', first.id + '.pipeliner-artifact')), false);
  } finally { await f.close(); }
});
test('controlled interruption can be discarded exactly, with protection, stale and tamper failures preserved', async () => {
  const f = await fixture();
  try {
    const input = f.make('interrupted', Buffer.alloc(2 * 1024 ** 2, 6)), controller = new AbortController(), operation = f.store.capture({ ...input, signal: controller.signal });
    while (!f.store.inventory('repo_one').items.length) await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(operation, /interrupted/);
    const item = f.store.inventory('repo_one').items[0], file = join(f.root, 'artifacts', item.id + '.pipeliner-artifact');
    assert.equal(f.store.summary('repo_one').held, 1); assert.throws(() => f.store.prepare('repo_two', { action: 'discard', id: item.id }));
    const stale = f.store.prepare('repo_one', { action: 'discard', id: item.id }); await f.store.capture(f.make('other')); await assert.rejects(f.store.apply(stale), /changed/);
    const changed = f.store.prepare('repo_one', { action: 'discard', id: item.id }); writeFileSync(file, 'unrelated changed bytes'); await assert.rejects(f.store.apply(changed)); assert.equal(readFileSync(file, 'utf8'), 'unrelated changed bytes');
    // Explicit test-fixture removal models an externally missing file. Production refused to remove its altered bytes.
    rmSync(file); await f.store.apply(f.store.prepare('repo_one', { action: 'discard', id: item.id }));
    assert.equal(f.store.inventory('repo_one').items.length, 1); assert.equal(f.store.summary('repo_one').receipts, 1); await assert.rejects(f.store.capture(input), /removed/);
    const fresh = f.make('fresh', Buffer.alloc(2 * 1024 ** 2, 7)), cancel = new AbortController(), work = f.store.capture({ ...fresh, signal: cancel.signal });
    while (f.store.inventory('repo_one').items.length < 2) await new Promise(resolve => setImmediate(resolve)); cancel.abort(); await assert.rejects(work, /interrupted/);
    const interrupted = f.store.inventory('repo_one').items.find(x => x.state === 'interrupted'); await f.reopen();
    const preview = f.store.prepare('repo_one', { action: 'discard', id: interrupted.id }); await f.store.apply(preview);
    assert.equal(existsSync(join(f.root, 'artifacts', interrupted.id + '.pipeliner-artifact')), false); assert.equal(f.store.summary('repo_one').held, 0);
    const good = f.store.inventory('repo_one').items[0]; await f.store.apply(f.store.prepare('repo_one', { action: 'pin', id: good.id })); assert.throws(() => f.store.prepare('repo_one', { action: 'discard', id: good.id }));
  } finally { await f.close(); }
});
test('missing bytes after durable delete intent reconcile without replaying the artifact command', async () => {
  const f = await fixture();
  try {
    const input = f.make('lost-delete'), receipt = await f.store.capture(input); await f.store.close();
    const db = new DatabaseSync(join(f.root, 'artifacts.sqlite')), codec = createRecordCodec(f.vault, 'artifact'), identity = { repository: null, table: 'artifacts', key: receipt.id };
    try { const raw = db.prepare('SELECT payload FROM artifacts WHERE id=?').get(receipt.id), row = codec.decode(identity, raw.payload); row.state = 'deleting'; db.prepare('UPDATE artifacts SET payload=? WHERE id=?').run(codec.encode(identity, row), receipt.id); } finally { db.close(); }
    rmSync(join(f.root, 'artifacts', receipt.id + '.pipeliner-artifact')); await f.reopen();
    assert.equal(f.store.summary('repo_one').held, 1); await f.store.apply(f.store.prepare('repo_one', { action: 'discard', id: receipt.id }));
    assert.equal(f.store.inventory('repo_one').items.length, 0); assert.equal(f.store.summary('repo_one').receipts, 1); await assert.rejects(f.store.capture(input), /removed/);
  } finally { await f.close(); }
});
test('readable artifact schema 1 is backed up with authenticated encryption before schema 2', async () => {
  const f = await fixture();
  try {
    const receipt = await f.store.capture(f.make('legacy')); await f.store.close(); const db = new DatabaseSync(join(f.root, 'artifacts.sqlite')); db.exec('PRAGMA user_version=1'); db.close();
    await f.reopen(); assert.equal(await f.store.verify('repo_one', receipt.id), true);
    const backups = readdirSync(f.root).filter(name => /^artifacts-v1-.*\.pipeliner-backup$/.test(name)); assert.equal(backups.length, 1);
    const backup = verifyProtectedBackup(join(f.root, backups[0]), { vault: f.vault, store: 'artifacts', version: 1 }); assert.equal(backup.schemaVersion, 1);
    const current = new DatabaseSync(join(f.root, 'artifacts.sqlite'), { readOnly: true }); try { assert.equal(current.prepare('PRAGMA user_version').get().user_version, 2); } finally { current.close(); }
  } finally { await f.close(); }
});
