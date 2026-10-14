import { join } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import { canonicalJSON, record } from '../core/settings.mjs';
import { createProtectedBackup, verifyProtectedBackup } from './backup.mjs';

const binding = store => ({ purpose: 'migration', repository: null, id: 'migration-' + store + '.state' });
const version = db => db.prepare('PRAGMA user_version').get().user_version;
function target(db, directory, store) {
  try {
    const source = join(directory, store + '.sqlite'), actual = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file, info = lstatSync(source);
    if (actual !== source || realpathSync(source) !== source || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw Error();
  } catch { throw Error('protected-migration-target-unavailable'); }
}
function controls(store, vault, verify) {
  if (!['workspaces', 'development'].includes(store) || typeof vault?.sealPayload !== 'function' || typeof vault?.openPayload !== 'function' || typeof verify !== 'function') throw Error('protected-migration-unavailable');
  const probe = vault.openPayload(binding(store), vault.sealPayload(binding(store), Buffer.alloc(0)));
  try { if (probe.length) throw Error('protected-migration-unavailable'); } finally { probe.fill(0); }
}
function state(db, store, vault) {
  const row = db.prepare('SELECT payload FROM protected_migration WHERE id=1').get(); let plain;
  try {
    if (!row) throw Error(); plain = vault.openPayload(binding(store), Buffer.from(row.payload));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    record(value, ['version', 'store', 'from', 'to', 'backup']);
    if (value.version !== 1 || value.store !== store || !Number.isSafeInteger(value.from) || value.from < 1 || !Number.isSafeInteger(value.to) || value.to <= value.from || value.to > 100 || version(db) !== value.to) throw Error();
    return value;
  } catch { throw Error('protected-migration-recovery-invalid'); } finally { plain?.fill(0); }
}

// Pending compaction is durable. The calling store must finish this before returning any execution control.
// Recovery verifies the transformed store and its sealed original; it never restores or replays a run.
export function finishProtectedMigration(db, directory, store, { vault, verify }) {
  controls(store, vault, verify);
  target(db, directory, store);
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='protected_migration'").get()) return null;
  const saved = state(db, store, vault), backup = verifyProtectedBackup(saved.backup.path, { vault, store, version: saved.from });
  if (canonicalJSON(backup) !== canonicalJSON(saved.backup)) throw Error('protected-migration-recovery-invalid');
  if (join(directory, `${store}-v${saved.from}-${backup.id}.pipeliner-backup`) !== backup.path) throw Error('protected-migration-recovery-invalid');
  try {
    if (!verify(db)) throw Error();
    db.exec('PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; VACUUM;');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || !verify(db)) throw Error();
    db.exec('DROP TABLE protected_migration'); return backup;
  } catch { throw Error('protected-migration-incomplete; verified compaction is required before execution'); }
}

export function migrateProtectedStore(db, directory, store, { vault, from, to, transform, verify }) {
  controls(store, vault, verify);
  target(db, directory, store);
  if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to <= from || to > 100 || version(db) !== from || typeof transform !== 'function') throw Error('protected-migration-unavailable');
  let transaction = false, committed = false, backup;
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error();
    const journal = db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode;
    if (journal !== 'delete') throw Error();
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; BEGIN EXCLUSIVE;'); transaction = true;
    if (version(db) !== from) throw Error();
    backup = createProtectedBackup(join(directory, store + '.sqlite'), { vault, store, version: from });
    // Keep the verified compatible snapshot if a later transform or compaction fails.
    let plain = Buffer.from(canonicalJSON({ version: 1, store, from, to, backup })), sealed;
    try { sealed = vault.sealPayload(binding(store), plain); } finally { plain.fill(0); }
    db.exec('CREATE TABLE protected_migration(id INTEGER PRIMARY KEY CHECK(id=1),payload BLOB NOT NULL)');
    db.prepare('INSERT INTO protected_migration VALUES(1,?)').run(sealed);
    transform(db); db.exec('PRAGMA user_version=' + to);
    if (!verify(db) || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error();
    db.exec('COMMIT'); transaction = false; committed = true;
    finishProtectedMigration(db, directory, store, { vault, verify }); return backup;
  } catch {
    if (transaction) try { db.exec('ROLLBACK'); } catch { throw Error('protected-migration-recovery-required; original and verified backup remain'); }
    throw Error(committed ? 'protected-migration-incomplete; verified compaction is required before execution' : 'protected-migration-failed; original schema preserved');
  }
}
