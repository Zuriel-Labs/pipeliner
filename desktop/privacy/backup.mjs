import { constants, lstatSync, fstatSync, openSync, closeSync, readSync, writeSync, fsyncSync, unlinkSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { DatabaseSync } from 'node:sqlite';

const maximum = 512 * 1024 ** 2, chunkSize = 64 * 1024, headerSize = 48, magic = Buffer.from('PPLBKP01');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const regular = s => s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function expected(store, version) { if (!['workspaces', 'development', 'artifacts'].includes(store) || !Number.isSafeInteger(version) || version < 1 || version > 100) throw Error(); }
function location(path) {
  if (typeof path !== 'string' || resolve(path) !== path) throw Error();
  const parent = dirname(path), info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || realpathSync(parent) !== parent) throw Error();
  return { path: parent, info };
}
function protection(vault) {
  if (typeof vault?.sealPayload !== 'function' || typeof vault?.openPayload !== 'function') throw Error();
  const binding = { purpose: 'migration', repository: null, id: 'backup-protection-probe' }, bytes = vault.openPayload(binding, vault.sealPayload(binding, Buffer.alloc(0)));
  try { if (bytes.length) throw Error(); } finally { bytes.fill(0); }
}
function read(fd, length, position) {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const count = readSync(fd, bytes, offset, length - offset, position + offset); if (!count) { bytes.fill(0); throw Error(); } offset += count; }
  return bytes;
}
function stable(path, fd, before, parent) {
  const after = fstatSync(fd), current = lstatSync(path);
  if (!regular(current) || !same(before, after) || !same(before, current) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    || !same(parent.info, lstatSync(parent.path)) || realpathSync(parent.path) !== parent.path) throw Error();
}
const binding = (id, part) => ({ purpose: 'migration', repository: null, id: id + '.' + part });
function hashFile(fd, size) {
  const hash = createHash('sha256');
  for (let offset = 0; offset < size; offset += chunkSize) { const bytes = read(fd, Math.min(chunkSize, size - offset), offset); try { hash.update(bytes); } finally { bytes.fill(0); } }
  return hash.digest('hex');
}

// Host-only. The store caller must hold its exclusive writer fence and use checkpointed DELETE journaling.
// Verification reads encrypted archives only; it never restores a database, grants authority or replays work.
export function createProtectedBackup(source, { vault, store, version }) {
  let input, output, path, owned, written = 0, parent; const outputHash = createHash('sha256');
  try {
    protection(vault); expected(store, version); parent = location(source);
    const legacyName = new RegExp(`^${store}-v${version}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.sqlite$`);
    if (basename(source) !== store + '.sqlite' && !legacyName.test(basename(source)) || ['-wal', '-journal'].some(suffix => existsSync(source + suffix) && lstatSync(source + suffix).size > 0)) throw Error();
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = fstatSync(input);
    if (!regular(before) || before.size < 100 || before.size > maximum) throw Error();
    const originalHeader = read(input, 100, 0);
    try { if (!originalHeader.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) || originalHeader.readUInt32BE(60) !== version) throw Error(); } finally { originalHeader.fill(0); }
    const id = randomUUID(), manifest = { version: 1, id, store, schemaVersion: version, sourceBytes: before.size,
      sourceHash: hashFile(input, before.size), chunks: Math.ceil(before.size / chunkSize) };
    stable(source, input, before, parent);
    path = join(parent.path, `${store}-v${version}-${id}.pipeliner-backup`);
    output = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); owned = fstatSync(output);
    if (!regular(owned) || owned.size !== 0) throw Error();
    function write(bytes) {
      let offset = 0;
      while (offset < bytes.length) { const count = writeSync(output, bytes, offset, bytes.length - offset, written); if (!count) throw Error(); outputHash.update(bytes.subarray(offset, offset + count)); offset += count; written += count; }
    }
    let plain = Buffer.from(canonicalJSON(manifest)), sealed;
    try { sealed = vault.sealPayload(binding(id, 'manifest'), plain); } finally { plain.fill(0); }
    const header = Buffer.alloc(headerSize); magic.copy(header); header.write(id, 8, 36, 'ascii'); header.writeUInt32BE(sealed.length, 44); write(header); write(sealed);
    for (let index = 0; index < manifest.chunks; index++) {
      plain = read(input, Math.min(chunkSize, before.size - index * chunkSize), index * chunkSize);
      try { sealed = vault.sealPayload(binding(id, 'chunk.' + index), plain); } finally { plain.fill(0); }
      const length = Buffer.alloc(4); length.writeUInt32BE(sealed.length); write(length); write(sealed);
    }
    fsyncSync(output); stable(source, input, before, parent);
    const result = verifyProtectedBackup(path, { vault, store, version });
    if (result.sourceHash !== manifest.sourceHash || result.sha256 !== outputHash.copy().digest('hex')) throw Error();
    const directory = openSync(parent.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!same(parent.info, fstatSync(directory))) throw Error(); fsyncSync(directory); } finally { closeSync(directory); }
    return { path, ...result };
  } catch {
    let preserved = false;
    if (output !== undefined && owned) try {
      const current = lstatSync(path), after = fstatSync(output);
      if (!regular(current) || !same(owned, current) || !same(owned, after) || after.size !== written || hashFile(output, written) !== outputHash.copy().digest('hex')) throw Error();
      unlinkSync(path);
    } catch (error) { preserved = error.code !== 'ENOENT'; }
    throw Error(preserved ? 'protected-backup-failed; altered archive preserved for recovery' : 'protected-backup-failed; original store preserved');
  } finally { if (output !== undefined) closeSync(output); if (input !== undefined) closeSync(input); }
}

// Only historical compatible snapshot names in this exact private store directory are eligible.
// A verified encrypted original is retained before its unchanged plaintext snapshot is removed.
export function protectLegacyBackups(directory, store, { vault, currentVersion }) {
  let entries;
  try {
    expected(store, currentVersion); protection(vault); location(join(directory, store + '.sqlite'));
    entries = readdirSync(directory).filter(name => new RegExp(`^${store}-v[1-9][0-9]*-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.sqlite$`).test(name));
    if (entries.length > 128) throw Error();
  } catch { throw Error('protected-backup-recovery-required'); }
  const results = [];
  for (const name of entries) {
    const source = join(directory, name), version = Number(name.split('-v')[1].split('-')[0]); let db, fd, before, parent;
    try {
      if (version >= currentVersion) throw Error();
      parent = location(source); fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); before = fstatSync(fd);
      if (!regular(before) || !same(before, lstatSync(source)) || before.size < 100 || before.size > maximum
        || ['-wal', '-journal', '-shm'].some(suffix => existsSync(source + suffix))) throw Error();
      db = new DatabaseSync(source, { allowExtension: false, timeout: 1000 });
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;');
      if (db.prepare('PRAGMA user_version').get().user_version !== version || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error();
      const backup = createProtectedBackup(source, { vault, store, version });
      db.exec('COMMIT'); db.close(); db = undefined;
      stable(source, fd, before, parent);
      if (hashFile(fd, before.size) !== backup.sourceHash) throw Error();
      unlinkSync(source); results.push(backup);
      const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { if (!same(parent.info, fstatSync(dir))) throw Error(); fsyncSync(dir); } finally { closeSync(dir); }
      if (existsSync(source)) throw Error();
    } catch { throw Error('protected-backup-recovery-required; compatible snapshots preserved'); }
    finally { if (db) db.close(); if (fd !== undefined) closeSync(fd); }
  }
  return results;
}

export function verifyProtectedBackup(path, { vault, store, version }) {
  let fd, plain;
  try {
    expected(store, version); const parent = location(path);
    if (!new RegExp(`^${store}-v${version}-[a-f0-9-]{36}\\.pipeliner-backup$`).test(basename(path))) throw Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = fstatSync(fd);
    if (!regular(before) || before.size < headerSize + 28 || before.size > maximum + maximum / chunkSize * 32 + 4096) throw Error();
    const header = read(fd, headerSize, 0), id = header.toString('ascii', 8, 44), length = header.readUInt32BE(44);
    if (!header.subarray(0, 8).equals(magic) || !uuid(id) || basename(path) !== `${store}-v${version}-${id}.pipeliner-backup` || length < 28 || length > 2048) throw Error();
    plain = vault.openPayload(binding(id, 'manifest'), read(fd, length, headerSize));
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); plain.fill(0); plain = undefined;
    record(manifest, ['version', 'id', 'store', 'schemaVersion', 'sourceBytes', 'sourceHash', 'chunks']);
    if (manifest.version !== 1 || manifest.id !== id || manifest.store !== store || manifest.schemaVersion !== version || !Number.isSafeInteger(manifest.sourceBytes)
      || manifest.sourceBytes < 100 || manifest.sourceBytes > maximum || !/^[a-f0-9]{64}$/.test(manifest.sourceHash) || manifest.chunks !== Math.ceil(manifest.sourceBytes / chunkSize)) throw Error();
    let position = headerSize + length; const hash = createHash('sha256');
    for (let index = 0; index < manifest.chunks; index++) {
      const count = read(fd, 4, position).readUInt32BE(0), expected = Math.min(chunkSize, manifest.sourceBytes - index * chunkSize);
      if (count !== expected + 28) throw Error(); position += 4;
      plain = vault.openPayload(binding(id, 'chunk.' + index), read(fd, count, position));
      try { if (plain.length !== expected) throw Error(); hash.update(plain); } finally { plain.fill(0); plain = undefined; }
      position += count;
    }
    if (position !== before.size || hash.digest('hex') !== manifest.sourceHash) throw Error();
    const sha256 = hashFile(fd, before.size); stable(path, fd, before, parent);
    return { path, ...manifest, sha256 };
  } catch { throw Error('protected-backup-invalid'); }
  finally { plain?.fill(0); if (fd !== undefined) closeSync(fd); }
}
