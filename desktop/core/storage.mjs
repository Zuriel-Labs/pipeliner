import { constants, lstatSync, fstatSync, fsyncSync, openSync, closeSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export function protectedFile(directory, name) {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== resolve(directory) || (root.mode & 0o777) !== 0o700
    || root.uid !== process.getuid()) throw new Error('Storage directory must be private, owned and canonical');
  if (!/^[a-z]+\.sqlite$/.test(name)) throw new Error('Invalid storage name');
  const path = join(directory, name);
  if (!existsSync(path)) {
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600) throw new Error('Invalid protected file');
  return path;
}

export function backupDatabase(db, directory, name, version, verify = () => true) {
  if (!/^[a-z]+$/.test(name) || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid backup identity');
  const path = join(directory, `${name}-v${version}-${randomUUID()}.sqlite`);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600), owned = fstatSync(fd);
  const matches = () => { try { const file = lstatSync(path); return file.dev === owned.dev && file.ino === owned.ino; } catch { return false; } };
  try {
    db.prepare('VACUUM INTO ?').run(path); fsyncSync(fd);
    const file = lstatSync(path);
    if (!matches() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600) throw new Error('Compatible backup ownership verification failed');
    const backup = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try { if (backup.prepare('PRAGMA user_version').get().user_version !== version || backup.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || !verify(backup)) throw new Error('Compatible backup verification failed'); }
    finally { backup.close(); }
    return path;
  } catch (error) { if (matches()) unlinkSync(path); throw error; }
  finally { closeSync(fd); }
}
