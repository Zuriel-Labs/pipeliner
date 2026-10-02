import { constants, lstatSync, openSync, closeSync, existsSync, realpathSync } from 'node:fs';
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
