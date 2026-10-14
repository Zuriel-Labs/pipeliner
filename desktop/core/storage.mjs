import { constants, lstatSync, fstatSync, fsyncSync, openSync, closeSync, unlinkSync, existsSync, realpathSync, readSync, writeSync, mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export function protectedFile(directory, name, { create = true } = {}) {
  if (typeof create !== 'boolean') throw new Error('Invalid storage creation option');
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== resolve(directory) || (root.mode & 0o777) !== 0o700
    || root.uid !== process.getuid()) throw new Error('Storage directory must be private, owned and canonical');
  if (!/^[a-z]+\.sqlite$/.test(name)) throw new Error('Invalid storage name');
  const path = join(directory, name);
  if (!existsSync(path) && create) {
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

// Host-only; the caller retains the execution-owner lease through native verification and effects.
export function captureRecoveryDatabase(directory, name, { scratch, checkpoint, read }) {
  const held = [], copies = new Map(), maximum = 512 * 1024 ** 2;
  let temporary, temporaryOwner, db, closed = false, root, scratchRoot;
  const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
  const regular = file => file.isFile() && !file.isSymbolicLink() && file.nlink === 1n && file.uid === BigInt(process.getuid()) && (file.mode & 0o777n) === 0o600n;
  function privateRoot(path, previous) {
    if (typeof path !== 'string' || resolve(path) !== path) throw Error('recovery-snapshot-unverified');
    const file = lstatSync(path, { bigint: true });
    if (!file.isDirectory() || file.isSymbolicLink() || file.uid !== BigInt(process.getuid()) || (file.mode & 0o777n) !== 0o700n
      || realpathSync(path) !== resolve(path) || previous && !identity(previous, file)) throw Error('recovery-snapshot-unverified');
    return file;
  }
  function verify() {
    if (closed) throw Error('recovery-snapshot-closed');
    const authority = checkpoint();
    if (authority && typeof authority.then === 'function') throw Error('recovery-snapshot-checkpoint-must-be-synchronous');
    privateRoot(directory, root);
    if (lstatSync(join(directory, name + '-journal'), { throwIfNoEntry: false })) throw Error('recovery-snapshot-unverified');
    for (const item of held) {
      const current = lstatSync(item.path, { bigint: true, throwIfNoEntry: false });
      if (item.fd === undefined ? current !== undefined : !current || !same(item.owner, current) || !same(item.owner, fstatSync(item.fd, { bigint: true }))) throw Error('recovery-snapshot-unverified');
    }
    return true;
  }
  function close() {
    if (closed) return;
    closed = true; let failed = false;
    for (const item of held) if (item.fd !== undefined) try { closeSync(item.fd); } catch { failed = true; }
    if (failed) throw Error('recovery-snapshot-close-required');
  }
  function cleanup() {
    if (!temporary) return;
    privateRoot(scratch, scratchRoot); privateRoot(temporary, temporaryOwner);
    const files = readdirSync(temporary).map(entry => {
      if (![name, name + '-wal', name + '-shm'].includes(entry)) throw Error('recovery-snapshot-cleanup-required');
      const path = join(temporary, entry), file = lstatSync(path, { bigint: true });
      if (!regular(file) || copies.has(entry) && !identity(copies.get(entry), file)) throw Error('recovery-snapshot-cleanup-required');
      return { path, file };
    });
    for (const { path, file } of files) {
      privateRoot(temporary, temporaryOwner);
      if (!same(file, lstatSync(path, { bigint: true }))) throw Error('recovery-snapshot-cleanup-required');
      unlinkSync(path);
    }
    privateRoot(temporary, temporaryOwner); rmdirSync(temporary); temporary = undefined;
  }
  try {
    if (!['execution.sqlite', 'policy.sqlite', 'development.sqlite', 'workspaces.sqlite', 'skills.sqlite', 'tools.sqlite', 'privacy.sqlite', 'artifacts.sqlite'].includes(name)
      || typeof checkpoint !== 'function' || typeof read !== 'function') throw Error('recovery-snapshot-unverified');
    root = privateRoot(directory); scratchRoot = privateRoot(scratch);
    if (readdirSync(scratch).length) throw Error('recovery-snapshot-cleanup-required');
    verify(); let total = 0n;
    for (const suffix of ['', '-wal', '-shm']) {
      const path = join(directory, name + suffix), item = { path, suffix }; held.push(item);
      if (suffix && !lstatSync(path, { throwIfNoEntry: false })) continue;
      item.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      item.owner = fstatSync(item.fd, { bigint: true }); total += item.owner.size;
      if (!regular(item.owner) || total > BigInt(maximum) || !suffix && item.owner.size < 100n) throw Error('recovery-snapshot-unverified');
    }
    verify(); privateRoot(scratch, scratchRoot);
    temporary = mkdtempSync(join(scratch, 'recovery-read-')); temporaryOwner = privateRoot(temporary);
    const bytes = Buffer.alloc(64 * 1024);
    try {
      for (const item of held.filter(item => item.fd !== undefined && item.suffix !== '-shm')) {
        const entry = name + item.suffix, output = openSync(join(temporary, entry), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          copies.set(entry, fstatSync(output, { bigint: true }));
          for (let offset = 0; offset < Number(item.owner.size);) {
            verify();
            const count = readSync(item.fd, bytes, 0, Math.min(bytes.length, Number(item.owner.size) - offset), offset);
            if (!count) throw Error('recovery-snapshot-unverified');
            for (let written = 0; written < count;) {
              const size = writeSync(output, bytes, written, count - written, offset + written);
              if (!size) throw Error('recovery-snapshot-unverified'); written += size;
            }
            offset += count;
          }
        } finally { closeSync(output); }
      }
    } finally { bytes.fill(0); }
    verify(); privateRoot(scratch, scratchRoot); privateRoot(temporary, temporaryOwner);
    if (readdirSync(temporary).length !== copies.size) throw Error('recovery-snapshot-unverified');
    for (const [entry, owner] of copies) {
      const file = lstatSync(join(temporary, entry), { bigint: true });
      if (!regular(file) || !identity(owner, file) || file.size !== held.find(item => name + item.suffix === entry).owner.size) throw Error('recovery-snapshot-unverified');
    }
    db = new DatabaseSync(join(temporary, name), { readOnly: true, allowExtension: false, timeout: 0 });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN;');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('recovery-snapshot-unverified');
    const value = read(db);
    if (value && typeof value.then === 'function') throw Error('recovery-snapshot-reader-must-be-synchronous');
    db.close(); db = undefined; verify(); cleanup(); verify();
    return Object.freeze({ value, verify, close });
  } catch (error) {
    try { db?.close(); } finally { try { cleanup(); } finally { close(); } }
    throw error;
  }
}
