// Developer-only SQLite qualification. Synthetic fixtures; never opens application data.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, lstatSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.ok(process.env.TEST_ARTIFACT_RUN && process.env.TEST_ARTIFACT_TMP, 'Admitted external run required');
assert.equal(realpathSync(tmpdir()), realpathSync(process.env.TEST_ARTIFACT_TMP));
assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--snapshot', 'Unknown probe mode');
const snapshotRead = process.argv[2] === '--snapshot';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-cold-read-'))), observations = [];
let writer, reader;
function snapshot(directory) {
  return readdirSync(directory).sort().map(name => {
    const path = join(directory, name), stat = lstatSync(path, { bigint: true });
    assert.ok(stat.isFile() && stat.nlink === 1n && stat.uid === BigInt(process.getuid()));
    return { name, identity: ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => stat[key].toString()),
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  });
}
try {
  for (const mode of ['delete', 'clean-wal', 'pending-wal']) {
    for (const exclusive of snapshotRead ? [false] : [false, true]) {
      const directory = join(root, `${mode}-${exclusive}`), fixture = join(directory, 'fixture'), source = join(directory, 'source.sqlite');
      mkdirSync(directory, { mode: 0o700 }); mkdirSync(fixture, { mode: 0o700 });
      writeFileSync(source, '', { mode: 0o600, flag: 'wx' });
      writer = new DatabaseSync(source, { allowExtension: false });
      writer.exec(`PRAGMA journal_mode=${mode === 'delete' ? 'DELETE' : 'WAL'}; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE evidence(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO evidence VALUES(1,'synthetic committed value');`);
      const sqliteVersion = writer.prepare('SELECT sqlite_version() AS version').get().version;
      const path = join(fixture, 'state.sqlite');
      if (mode === 'pending-wal') {
        // Copy the quiescent committed pair before close checkpoints it. No invented WAL bytes.
        copyFileSync(source, path); copyFileSync(source + '-wal', path + '-wal');
      }
      writer.close(); writer = undefined;
      if (mode !== 'pending-wal') copyFileSync(source, path);
      const before = snapshot(fixture); let value = null, failure = null, inspectedPath = path;
      if (snapshotRead) {
        const inspection = join(directory, 'inspection'); mkdirSync(inspection, { mode: 0o700 });
        inspectedPath = join(inspection, 'state.sqlite');
        copyFileSync(path, inspectedPath);
        if (mode === 'pending-wal') copyFileSync(path + '-wal', inspectedPath + '-wal');
      }
      try {
        reader = new DatabaseSync(inspectedPath, { readOnly: true, allowExtension: false, timeout: 0 });
        if (exclusive) reader.exec('PRAGMA locking_mode=EXCLUSIVE;');
        reader.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN;');
        value = reader.prepare('SELECT id,value FROM evidence ORDER BY id').all();
      } catch (error) { failure = { code: error.code ?? null, message: error.message }; }
      finally { reader?.close(); reader = undefined; }
      const after = snapshot(fixture);
      observations.push({ mode, exclusive, snapshotRead, sqliteVersion, value, failure, unchanged: JSON.stringify(before) === JSON.stringify(after), before, after });
    }
  }
  console.log(JSON.stringify({ kind: 'cold-sqlite-read-probe', node: process.version, observations }));
  for (const result of observations.filter(value => snapshotRead || value.exclusive)) {
    assert.equal(result.failure, null, `${result.mode}: read failed`);
    assert.equal(JSON.stringify(result.value), JSON.stringify([{ id: 1, value: 'synthetic committed value' }]), `${result.mode}: committed rows missing`);
    assert.equal(result.unchanged, true, `${result.mode}: inspection changed files`);
  }
} finally {
  try { reader?.close(); } finally {
    try { writer?.close(); } finally { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
  }
}
