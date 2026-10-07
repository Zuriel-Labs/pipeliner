import { constants, lstatSync, realpathSync, openSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildIdentity } from '../package/build.mjs';
import { immutable, record } from '../core/settings.mjs';
import { createProtectedBackup, verifyProtectedBackup } from '../privacy/backup.mjs';

const stores = [['workspaces', 5], ['development', 2], ['artifacts', 2]];
const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

// Host-only capture under the maintenance fence. No restoration, authority rollback or worker replay.
export function captureUpdateBackups(options) {
  const held = [];
  try {
    record(options, ['directory', 'vault', 'build', 'checkpoint'], ['signal']);
    const { directory, vault, checkpoint, signal } = options, build = buildIdentity(options.build);
    if (typeof directory !== 'string' || typeof checkpoint !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)
      || realpathSync(directory) !== directory) throw Error();
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700) throw Error();
    const inspect = () => {
      signal?.throwIfAborted(); checkpoint(); signal?.throwIfAborted();
      const current = lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino
        || current.uid !== root.uid || current.mode !== root.mode || realpathSync(directory) !== directory) throw Error();
      for (const item of held) {
        if (!same(item.owner, fstatSync(item.fd)) || !same(item.owner, lstatSync(item.path)) || realpathSync(item.path) !== item.path
          || ['-wal', '-shm', '-journal'].some(suffix => lstatSync(item.path + suffix, { throwIfNoEntry: false }))) throw Error();
      }
    };
    inspect();
    for (const [store, version] of stores) {
      const path = join(directory, store + '.sqlite'), item = { path, store, version }; held.push(item);
      item.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); item.owner = fstatSync(item.fd);
      if (!item.owner.isFile() || item.owner.nlink !== 1 || item.owner.uid !== process.getuid() || (item.owner.mode & 0o777) !== 0o600
        || item.owner.size < 100 || item.owner.size > 512 * 1024 ** 2) throw Error();
      item.db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 });
      item.db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN;');
      if (item.db.prepare('PRAGMA user_version').get().user_version !== version
        || item.db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete'
        || item.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error();
      inspect();
    }
    const databases = held.map(item => {
      inspect(); const receipt = createProtectedBackup(item.path, { vault, store: item.store, version: item.version, checkpoint: inspect });
      inspect(); return receipt;
    });
    for (const receipt of databases) {
      const verified = verifyProtectedBackup(receipt.path, { vault, store: receipt.store, version: receipt.schemaVersion, checkpoint: inspect });
      if (verified.sha256 !== receipt.sha256 || verified.sourceHash !== receipt.sourceHash) throw Error();
    }
    inspect(); return immutable({ kind: 'pipeliner-update-backups', schemaVersion: 1, build, databases });
  } catch { throw Error('update-backup-unverified'); }
  finally {
    let failed = false;
    for (const item of held.reverse()) {
      try { item.db?.close(); } catch { failed = true; }
      try { if (item.fd !== undefined) closeSync(item.fd); } catch { failed = true; }
    }
    if (failed) throw Error('update-backup-recovery-required');
  }
}
