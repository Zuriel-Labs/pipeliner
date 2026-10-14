import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, rmdirSync, existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from './storage.mjs';

test('recovery reads private SQLite copies, preserves originals and retains source custody', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-recovery-read-')));
  let writer, capture;
  const snapshot = directory => readdirSync(directory).sort().map(name => {
    const path = join(directory, name), stat = lstatSync(path, { bigint: true });
    return { name, bytes: readFileSync(path), identity: ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => stat[key].toString()) };
  });
  try {
    assert.equal(typeof storage.captureRecoveryDatabase, 'function');
    for (const mode of ['delete', 'clean-wal', 'pending-wal']) {
      const directory = join(root, mode), scratch = join(root, mode + '-scratch'), seed = join(root, mode + '-seed.sqlite');
      mkdirSync(directory, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 }); writeFileSync(seed, '', { mode: 0o600, flag: 'wx' });
      writer = new DatabaseSync(seed, { allowExtension: false });
      writer.exec(`PRAGMA journal_mode=${mode === 'delete' ? 'DELETE' : 'WAL'}; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE evidence(id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO evidence VALUES(1,'committed'); PRAGMA user_version=1;`);
      const path = join(directory, 'execution.sqlite');
      if (mode === 'pending-wal') { copyFileSync(seed, path); copyFileSync(seed + '-wal', path + '-wal'); }
      writer.close(); writer = undefined;
      if (mode !== 'pending-wal') copyFileSync(seed, path);
      const before = snapshot(directory);
      let authority = true;
      const options = { scratch, checkpoint: () => { assert.equal(authority, true); }, read: db => {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
        assert.throws(() => db.exec("INSERT INTO evidence VALUES(2,'not allowed')"));
        return db.prepare('SELECT value FROM evidence ORDER BY id').all().map(row => row.value);
      } };
      capture = storage.captureRecoveryDatabase(directory, 'execution.sqlite', options);
      assert.deepEqual(capture.value, ['committed']); assert.equal(capture.verify(), true);
      assert.deepEqual(snapshot(directory), before); assert.deepEqual(readdirSync(scratch), []);
      authority = false; assert.throws(() => capture.verify()); authority = true;
      writeFileSync(path + '-journal', '', { mode: 0o600, flag: 'wx' }); assert.throws(() => capture.verify()); unlinkSync(path + '-journal');
      capture.close(); capture.close(); assert.throws(() => capture.verify()); capture = undefined;
      assert.deepEqual(snapshot(directory), before);
      assert.throws(() => storage.captureRecoveryDatabase(directory, 'vault.sqlite', options));
      assert.throws(() => storage.captureRecoveryDatabase(directory, 'policy.sqlite', options));
      assert.throws(() => storage.captureRecoveryDatabase(directory, 'execution.sqlite', { ...options, read() { throw Error('reader failed'); } }));
      assert.throws(() => storage.captureRecoveryDatabase(directory, 'execution.sqlite', { ...options, read: () => Promise.resolve('late') }));
      assert.throws(() => { capture = storage.captureRecoveryDatabase(directory, 'execution.sqlite', { ...options, checkpoint: () => Promise.resolve() }); });
      assert.deepEqual(snapshot(directory), before); assert.deepEqual(readdirSync(scratch), []);
      assert.throws(() => storage.captureRecoveryDatabase(directory, 'execution.sqlite', { ...options, read(db) {
        writeFileSync(join(scratch, readdirSync(scratch)[0], 'unexpected'), 'preserve', { mode: 0o600, flag: 'wx' });
        return options.read(db);
      } }), /cleanup-required/);
      assert.equal(readFileSync(join(scratch, readdirSync(scratch)[0], 'unexpected'), 'utf8'), 'preserve');
      for (const entry of readdirSync(scratch)) rmSync(join(scratch, entry), { recursive: true });
      assert.deepEqual(snapshot(directory), before);
      mkdirSync(join(scratch, 'interrupted'), { mode: 0o700 });
      assert.throws(() => storage.captureRecoveryDatabase(directory, 'execution.sqlite', options));
      assert.deepEqual(readdirSync(scratch), ['interrupted']); rmdirSync(join(scratch, 'interrupted'));
      chmodSync(path, 0o640); assert.throws(() => storage.captureRecoveryDatabase(directory, 'execution.sqlite', options)); chmodSync(path, 0o600);
      symlinkSync(path, join(directory, 'policy.sqlite'));
      assert.throws(() => storage.captureRecoveryDatabase(directory, 'policy.sqlite', options)); unlinkSync(join(directory, 'policy.sqlite'));
      assert.throws(() => storage.captureRecoveryDatabase(directory, 'execution.sqlite', { ...options, read(db) {
        const value = options.read(db); writeFileSync(path + '-journal', '', { mode: 0o600, flag: 'wx' }); return value;
      } }));
      unlinkSync(path + '-journal'); assert.deepEqual(readdirSync(scratch), []);
      capture = storage.captureRecoveryDatabase(directory, 'execution.sqlite', options);
      writeFileSync(path + '-shm', 'changed', { mode: 0o600, flag: 'wx' }); assert.throws(() => capture.verify()); unlinkSync(path + '-shm');
      writeFileSync(path, 'changed', { flag: 'r+' }); assert.throws(() => capture.verify());
      capture.close(); capture = undefined; assert.deepEqual(readdirSync(scratch), []);
    }
  } finally {
    try { writer?.close(); } finally { try { capture?.close(); } finally { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } }
  }
});
