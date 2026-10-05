import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, linkSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openVault } from '../connections/vault.mjs';
import { createRecordCodec } from './records.mjs';
import { createProtectedBackup, verifyProtectedBackup } from './backup.mjs';
import { migrateProtectedStore, finishProtectedMigration } from './migration.mjs';

const wrapping = { available: async () => true, encrypt: async text => Buffer.from(text.split('').reverse().join('')),
  decrypt: async bytes => ({ result: bytes.toString().split('').reverse().join(''), shouldReEncrypt: false }) };
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-protected-migration-')));
  // Synthetic OS wrapping, actual vault AES-GCM. No native protection claim.
  const vault = await openVault(root, wrapping);
  return { root, vault, close() { vault.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } };
}
test('protected JSON preserves data and authenticates store, record and mutable query metadata', async () => {
  const f = await fixture();
  try {
    const codec = createRecordCodec(f.vault, 'workspace'), identity = { repository: 'first', table: 'effects', key: 'one' }, metadata = { state: 'uncertain', job: 'import', step: 'link' };
    const data = { title: 'Private project title', result: { candidate: 'a'.repeat(40), approved: false } }, bytes = codec.encode(identity, data, metadata);
    assert.equal(bytes.includes('Private project title'), false); assert.deepEqual(codec.decode(identity, bytes, metadata), data);
    for (const changed of [{ ...identity, repository: 'second' }, { ...identity, table: 'drafts' }, { ...identity, key: 'two' }]) assert.throws(() => codec.decode(changed, bytes, metadata), /protected-record/);
    assert.throws(() => codec.decode(identity, bytes, { ...metadata, state: 'verified' }), /protected-record/);
    assert.throws(() => createRecordCodec(f.vault, 'development').decode(identity, bytes, metadata), /protected-record/);
    const altered = Buffer.from(bytes); altered[30] ^= 1; assert.throws(() => codec.decode(identity, altered, metadata), /protected-record/);
    assert.throws(() => codec.decode(identity, JSON.stringify(data), metadata), /protected-record/);
  } finally { f.close(); }
});
test('record codec refuses missing or closed protection and unknown purpose', async () => {
  const f = await fixture();
  try {
    assert.throws(() => createRecordCodec(null, 'workspace'), /protected-record/);
    assert.throws(() => createRecordCodec(f.vault, 'unrecognized'), /protected-record/);
    const codec = createRecordCodec(f.vault, 'development'), identity = { repository: 'first', table: 'runs', key: 'one' };
    const bytes = codec.encode(identity, { text: 'Private run' }); f.vault.close();
    assert.throws(() => codec.decode(identity, bytes), /protected-record/); assert.throws(() => codec.encode(identity, {}), /protected-record/);
  } finally { f.close(); }
});
function database(f) {
  const source = join(f.root, 'workspaces.sqlite'); writeFileSync(source, '', { mode: 0o600, flag: 'wx' });
  const db = new DatabaseSync(source); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE private_data(value TEXT); PRAGMA user_version=4');
  db.prepare('INSERT INTO private_data VALUES(?)').run('Synthetic private backup marker ' + 'x'.repeat(150000));
  return { source, db };
}
test('exclusive encrypted backup authenticates every bounded chunk and exact original while preserving source', async () => {
  const f = await fixture(), { source, db } = database(f);
  try {
    const before = readFileSync(source); db.exec('BEGIN EXCLUSIVE');
    const result = createProtectedBackup(source, { vault: f.vault, store: 'workspaces', version: 4 }); db.exec('COMMIT');
    assert.ok(result.chunks >= 3); assert.deepEqual(verifyProtectedBackup(result.path, { vault: f.vault, store: 'workspaces', version: 4 }), result);
    assert.deepEqual(readFileSync(source), before); assert.equal(readFileSync(result.path).includes('Synthetic private backup marker'), false);
    assert.equal(statSync(result.path).mode & 0o777, 0o600); assert.equal(readdirSync(f.root).filter(name => name.endsWith('.pipeliner-backup')).length, 1);
    for (const expected of [{ store: 'development', version: 4 }, { store: 'workspaces', version: 3 }]) assert.throws(() => verifyProtectedBackup(result.path, { vault: f.vault, ...expected }), /protected-backup/);
  } finally { db.close(); f.close(); }
});
test('backup rejects ciphertext mutation, chunk substitution, truncation and extra bytes', async () => {
  const f = await fixture(), { source, db } = database(f);
  try {
    db.exec('BEGIN EXCLUSIVE'); const result = createProtectedBackup(source, { vault: f.vault, store: 'workspaces', version: 4 }); db.exec('COMMIT');
    const original = readFileSync(result.path);
    const swapped = Buffer.from(original), first = 48 + original.readUInt32BE(44), length = 4 + original.readUInt32BE(first), second = first + length;
    assert.equal(4 + original.readUInt32BE(second), length);
    original.copy(swapped, first, second, second + length); original.copy(swapped, second, first, first + length);
    for (const altered of [swapped, original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from([0])])]) {
      writeFileSync(result.path, altered); assert.throws(() => verifyProtectedBackup(result.path, { vault: f.vault, store: 'workspaces', version: 4 }), /protected-backup/);
    }
    const changed = Buffer.from(original); changed[changed.length - 40] ^= 1; writeFileSync(result.path, changed);
    assert.throws(() => verifyProtectedBackup(result.path, { vault: f.vault, store: 'workspaces', version: 4 }), /protected-backup/);
    writeFileSync(result.path, original); f.vault.close();
    assert.throws(() => verifyProtectedBackup(result.path, { vault: f.vault, store: 'workspaces', version: 4 }), /protected-backup/);
  } finally { db.close(); f.close(); }
});
test('encrypted records and verified backup survive a reopened installation vault', async () => {
  const f = await fixture(), { source, db } = database(f); let reopened;
  try {
    const identity = { repository: 'first', table: 'drafts', key: 'one' }, value = { text: 'Synthetic private draft' };
    const bytes = createRecordCodec(f.vault, 'workspace').encode(identity, value);
    db.exec('BEGIN EXCLUSIVE'); const backup = createProtectedBackup(source, { vault: f.vault, store: 'workspaces', version: 4 }); db.exec('COMMIT');
    f.vault.close(); reopened = await openVault(f.root, wrapping);
    assert.deepEqual(createRecordCodec(reopened, 'workspace').decode(identity, bytes), value);
    assert.deepEqual(verifyProtectedBackup(backup.path, { vault: reopened, store: 'workspaces', version: 4 }), backup);
  } finally { reopened?.close(); db.close(); f.close(); }
});
test('failed sealing removes only the newly created archive and preserves legacy and neighboring records', async () => {
  const f = await fixture(), { source, db } = database(f);
  try {
    const before = readFileSync(source); writeFileSync(join(f.root, 'neighbor'), 'preserve', { mode: 0o600 }); let calls = 0;
    const vault = { ...f.vault, sealPayload(...args) { if (++calls === 3) throw Error('synthetic-failure'); return f.vault.sealPayload(...args); } };
    db.exec('BEGIN EXCLUSIVE'); assert.throws(() => createProtectedBackup(source, { vault, store: 'workspaces', version: 4 }), /protected-backup/); db.exec('ROLLBACK');
    assert.deepEqual(readFileSync(source), before); assert.equal(readFileSync(join(f.root, 'neighbor'), 'utf8'), 'preserve');
    assert.equal(readdirSync(f.root).some(name => name.endsWith('.pipeliner-backup')), false);
    const result = createProtectedBackup(source, { vault: f.vault, store: 'workspaces', version: 4 }); assert.ok(result.sourceBytes > 0);
  } finally { db.close(); f.close(); }
});
test('backup refuses aliases, hard links, live sidecars and missing protection without replacing any data', async () => {
  const f = await fixture(), { source, db } = database(f);
  try {
    const before = readFileSync(source);
    assert.throws(() => createProtectedBackup(source, { vault: null, store: 'workspaces', version: 4 }), /protected-backup/);
    symlinkSync(source, join(f.root, 'alias.sqlite')); assert.throws(() => createProtectedBackup(join(f.root, 'alias.sqlite'), { vault: f.vault, store: 'alias', version: 4 }), /protected-backup/);
    writeFileSync(source + '-wal', 'synthetic live sidecar', { mode: 0o600 });
    assert.throws(() => createProtectedBackup(source, { vault: f.vault, store: 'workspaces', version: 4 }), /protected-backup/);
    rmSync(source + '-wal'); linkSync(source, join(f.root, 'linked.sqlite'));
    assert.throws(() => createProtectedBackup(source, { vault: f.vault, store: 'workspaces', version: 4 }), /protected-backup/);
    assert.deepEqual(readFileSync(source), before); assert.equal(readdirSync(f.root).some(name => name.endsWith('.pipeliner-backup')), false);
  } finally { db.close(); f.close(); }
});
test('protected migration commits preserved data, a sealed compatible original and verified compaction together', async () => {
  const f = await fixture(), { source, db } = database(f);
  try {
    const original = db.prepare('SELECT value FROM private_data').get().value, codec = createRecordCodec(f.vault, 'workspace'), identity = { repository: null, table: 'private_data', key: 1 };
    const verify = db => codec.decode(identity, db.prepare('SELECT value FROM private_data').get().value) === original;
    const backup = migrateProtectedStore(db, f.root, 'workspaces', { vault: f.vault, from: 4, to: 5,
      transform: db => db.prepare('UPDATE private_data SET value=?').run(codec.encode(identity, original)), verify });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5); assert.equal(verify(db), true);
    assert.equal(readFileSync(source).includes('Synthetic private backup marker'), false);
    assert.deepEqual(verifyProtectedBackup(backup.path, { vault: f.vault, store: 'workspaces', version: 4 }), backup);
    assert.equal(finishProtectedMigration(db, f.root, 'workspaces', { vault: f.vault, verify }), null);
  } finally { db.close(); f.close(); }
});
test('transform failure rolls back the original schema and retains a verified encrypted recovery archive', async () => {
  const f = await fixture(), { source, db } = database(f);
  try {
    const before = readFileSync(source);
    assert.throws(() => migrateProtectedStore(db, f.root, 'workspaces', { vault: f.vault, from: 4, to: 5,
      transform(db) { db.exec('DELETE FROM private_data'); throw Error('synthetic-transform-failure'); }, verify: () => true }), /original schema preserved/);
    assert.deepEqual(readFileSync(source), before); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    const backup = readdirSync(f.root).find(name => name.endsWith('.pipeliner-backup'));
    assert.ok(verifyProtectedBackup(join(f.root, backup), { vault: f.vault, store: 'workspaces', version: 4 }).sourceBytes > 0);
  } finally { db.close(); f.close(); }
});
test('post-commit failure keeps an authenticated recovery marker until a reopened vault verifies compaction', async () => {
  const f = await fixture(), { source, db } = database(f); let reopened;
  try {
    const original = db.prepare('SELECT value FROM private_data').get().value, codec = createRecordCodec(f.vault, 'workspace'), identity = { repository: null, table: 'private_data', key: 1 }; let calls = 0;
    assert.throws(() => migrateProtectedStore(db, f.root, 'workspaces', { vault: f.vault, from: 4, to: 5,
      transform: db => db.prepare('UPDATE private_data SET value=?').run(codec.encode(identity, original)),
      verify: db => { if (++calls === 2) throw Error('synthetic-post-commit-failure'); return codec.decode(identity, db.prepare('SELECT value FROM private_data').get().value) === original; } }), /compaction is required/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5); assert.ok(db.prepare('SELECT payload FROM protected_migration').get().payload instanceof Uint8Array);
    f.vault.close(); reopened = await openVault(f.root, wrapping); const restoredCodec = createRecordCodec(reopened, 'workspace');
    assert.ok(finishProtectedMigration(db, f.root, 'workspaces', { vault: reopened, verify: db => restoredCodec.decode(identity, db.prepare('SELECT value FROM private_data').get().value) === original }));
    assert.equal(readFileSync(source).includes('Synthetic private backup marker'), false);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='protected_migration'").get(), undefined);
  } finally { reopened?.close(); db.close(); f.close(); }
});
test('migration refuses a database from another owned directory before any transform or backup', async () => {
  const first = await fixture(), second = await fixture(), a = database(first), b = database(second);
  try {
    const beforeA = readFileSync(a.source), beforeB = readFileSync(b.source); let transformed = false;
    assert.throws(() => migrateProtectedStore(b.db, first.root, 'workspaces', { vault: first.vault, from: 4, to: 5,
      transform() { transformed = true; }, verify: () => true }), /protected-migration/);
    assert.equal(transformed, false); assert.deepEqual(readFileSync(a.source), beforeA); assert.deepEqual(readFileSync(b.source), beforeB);
    assert.equal(readdirSync(first.root).some(name => name.endsWith('.pipeliner-backup')), false);
  } finally { a.db.close(); b.db.close(); first.close(); second.close(); }
});
