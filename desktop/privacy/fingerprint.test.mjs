import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureRetainedRecords, inspectManagedData } from './inventory.mjs';

test('retained fingerprints preserve typed SQLite rows across WAL close and refuse changed or unreadable records', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-record-fingerprint-')));
  let db;
  try {
    const fingerprint = () => { const captured = captureRetainedRecords(root, () => {}); try { captured.verify(); return captured.value; } finally { captured.close(); } };
    const empty = fingerprint();
    writeFileSync(join(root, 'owner.sqlite'), '', { mode: 0o600 });
    for (const name of ['policy', 'workspaces', 'development', 'execution', 'skills', 'tools', 'privacy', 'artifacts']) {
      const file = join(root, name + '.sqlite'); writeFileSync(file, '', { mode: 0o600 }); db = new DatabaseSync(file);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=7; PRAGMA application_id=42; CREATE TABLE kept(id INTEGER PRIMARY KEY AUTOINCREMENT, value); CREATE TABLE keyed(id TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;");
      db.prepare('INSERT INTO kept(value) VALUES (?)').run(9223372036854775807n);
      db.prepare('INSERT INTO kept(value) VALUES (?)').run('kept\0text');
      db.prepare('INSERT INTO kept(value) VALUES (?)').run(1.25);
      db.prepare('INSERT INTO kept(value) VALUES (?)').run(null);
      db.prepare('INSERT INTO keyed VALUES (?,?)').run('key', Buffer.from([0, 255, 127]));
      const before = new Map(readdirSync(root).filter(entry => entry.startsWith(name + '.sqlite')).map(entry => [entry, readFileSync(join(root, entry))]));
      const captured = fingerprint(); assert.notEqual(captured, empty);
      for (const [entry, bytes] of before) assert.deepEqual(readFileSync(join(root, entry)), bytes);
      assert.equal(readdirSync(root).some(entry => entry.startsWith('removal-read-')), false);
      const held = captureRetainedRecords(root, () => {});
      try { db.close(); db = null; assert.throws(held.verify); } finally { held.close(); }
      assert.throws(held.verify, /closed/); assert.equal(existsSync(file + '-wal'), false); assert.equal(fingerprint(), captured);
      const inventory = inspectManagedData(root);
      db = new DatabaseSync(file); db.prepare('UPDATE kept SET value=? WHERE id=2').run('lost\0text'); db.close(); db = null;
      assert.deepEqual(inspectManagedData(root), inventory); assert.notEqual(fingerprint(), captured);
      db = new DatabaseSync(file); db.prepare('UPDATE kept SET value=? WHERE id=2').run('kept\0text'); db.close(); db = null;
      assert.equal(fingerprint(), captured);
      db = new DatabaseSync(file); db.exec('UPDATE kept SET id=8 WHERE id=2'); db.close(); db = null;
      assert.notEqual(fingerprint(), captured);
      db = new DatabaseSync(file); db.exec('UPDATE kept SET id=2 WHERE id=8'); db.close(); db = null;
      assert.equal(fingerprint(), captured);
    }
    db = new DatabaseSync(join(root, 'privacy.sqlite'));
    db.prepare('INSERT INTO keyed VALUES (?,?)').run('large', Buffer.alloc(512 * 1024, 42));
    db.close(); db = null;
    const before = fingerprint(); let checks = 0;
    assert.throws(() => captureRetainedRecords(root, () => { if (++checks === 5) throw Error('Cancelled'); }), /Cancelled/);
    assert.throws(() => captureRetainedRecords(root, async () => {}), /synchronous/);
    assert.equal(readdirSync(root).some(entry => entry.startsWith('removal-read-')), false); assert.equal(fingerprint(), before);
    writeFileSync(join(root, 'privacy.sqlite-journal'), 'incomplete journal', { mode: 0o600 });
    assert.throws(fingerprint); unlinkSync(join(root, 'privacy.sqlite-journal'));
    unlinkSync(join(root, 'privacy.sqlite')); assert.notEqual(fingerprint(), before);
    writeFileSync(join(root, 'privacy.sqlite-wal'), 'orphaned WAL', { mode: 0o600 }); assert.throws(fingerprint);
    unlinkSync(join(root, 'privacy.sqlite-wal'));
    writeFileSync(join(root, 'privacy.sqlite'), 'unreadable database', { mode: 0o600 }); assert.throws(fingerprint);
    assert.equal(readdirSync(root).some(entry => entry.startsWith('removal-read-')), false);
  } finally { db?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});
