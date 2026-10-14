import { constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { open, mkdir, unlink, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, record } from '../core/settings.mjs';
import { createRecordCodec } from '../privacy/records.mjs';
import { createProtectedBackup } from '../privacy/backup.mjs';

const chunkSize = 64 * 1024, metadataRoom = 64 * 1024, maximumRecords = 10000;
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const repositoryId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const regular = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o777) === 0o600;
const identity = info => Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, info[key]]));
const stable = (a, b) => same(a, b) && ['size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
function manifest(value) {
  record(value, ['name', 'bytes', 'sha256', 'sourceCommit', 'gitTree', 'host', 'validation']);
  record(value.host, ['os', 'architecture', 'version']); record(value.validation, ['protocol', 'result', 'receiptHash']);
  if (typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value.name)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 100000 * 1024 ** 3
    || ![value.sha256, value.validation.receiptHash].every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))
    || ![value.sourceCommit, value.gitTree].every(x => typeof x === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(x))
    || value.host.os !== 'darwin' || !['arm64', 'x64'].includes(value.host.architecture) || !/^\d+(?:\.\d+){1,3}$/.test(value.host.version)
    || !/^[a-z][a-z0-9-]{0,63}$/.test(value.validation.protocol) || value.validation.result !== 'passed') throw Error('Artifact identity invalid');
  return value;
}
const archiveSize = value => value.bytes + Math.ceil(value.bytes / chunkSize) * 32;
async function read(file, length, position) {
  const bytes = Buffer.alloc(length); let offset = 0;
  try { while (offset < length) { const result = await file.read(bytes, offset, length - offset, position + offset); if (!result.bytesRead) throw Error(); offset += result.bytesRead; } return bytes; }
  catch (error) { bytes.fill(0); throw error; }
}
async function write(file, bytes, position) {
  let offset = 0; while (offset < bytes.length) { const result = await file.write(bytes, offset, bytes.length - offset, position + offset); if (!result.bytesWritten) throw Error(); offset += result.bytesWritten; }
}

// Host-only custody. No renderer path/import API. The qualified build producer owns validation receipts.
export async function openArtifactStore(directory, { vault, limits }) {
  let db;
  try {
    const codec = createRecordCodec(vault, 'artifact'), database = protectedFile(directory, 'artifacts.sqlite'), root = join(directory, 'artifacts');
    try { await mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const rootInfo = lstatSync(root);
    function location() {
      const current = lstatSync(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o700
        || !same(current, rootInfo) || realpathSync(root) !== root) throw Error('Artifact storage changed');
    }
    location(); if (typeof limits !== 'function') throw Error();
    db = new DatabaseSync(database, { allowExtension: false, timeout: 1000 });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA auto_vacuum=FULL;');
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    if (!Number.isInteger(pageSize) || pageSize < 512 || pageSize > 65536) throw Error();
    if (db.prepare('PRAGMA max_page_count=' + Math.floor(16 * 1024 ** 2 / pageSize)).get().max_page_count * pageSize > 16 * 1024 ** 2) throw Error();
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, 2].includes(version)) throw Error();
    if (!version) db.exec('CREATE TABLE artifacts(id TEXT PRIMARY KEY,payload BLOB NOT NULL); PRAGMA user_version=2;');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 1) throw Error();
    let closed = false, busy = null, generation = 1; const session = randomUUID();
    const ready = () => { if (closed) throw Error('Artifact storage unavailable'); location(); };
    const binding = (row, index) => ({ purpose: 'artifact', repository: hash(row.repository), id: row.id + '.chunk.' + index });
    const filePath = row => join(root, row.id + '.pipeliner-artifact');
    const recordId = id => ({ repository: null, table: 'artifacts', key: id });
    function rows() {
      ready(); const results = db.prepare('SELECT id,payload FROM artifacts LIMIT ?').all(maximumRecords + 1);
      if (results.length > maximumRecords) throw Error('Artifact inventory unavailable');
      return results.map(result => {
        if (!uuid(result.id)) throw Error('Artifact inventory unavailable'); const row = codec.decode(recordId(result.id), result.payload);
        record(row, ['id', 'repository', 'commandId', 'fingerprint', 'manifest', 'state', 'pinned', 'recovery', 'active', 'created', 'reserved', 'owner', 'cipherHash']);
        manifest(row.manifest);
        if (row.id !== result.id || !repositoryId(row.repository) || !uuid(row.commandId) || row.fingerprint !== hash(canonicalJSON({ repository: row.repository, manifest: row.manifest }))
          || !['capturing', 'verified', 'interrupted', 'deleting', 'discarded'].includes(row.state) || ![row.pinned, row.recovery, row.active].every(x => typeof x === 'boolean')
          || !Number.isSafeInteger(row.created) || row.created < 1 || row.reserved !== (row.state === 'discarded' ? 0 : archiveSize(row.manifest))
          || row.cipherHash !== null && !/^[a-f0-9]{64}$/.test(row.cipherHash) || row.state === 'verified' && (!row.owner || !row.cipherHash)) throw Error('Artifact inventory unavailable');
        if (row.state === 'discarded' && (row.owner !== null || row.cipherHash !== null || row.active || row.pinned || row.recovery)) throw Error('Artifact receipt invalid');
        if (row.owner !== null) { record(row.owner, ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']); if (!Object.values(row.owner).every(Number.isFinite) || row.owner.size < 0 || row.owner.size > row.reserved) throw Error(); }
        return row;
      });
    }
    function save(row) { db.prepare('INSERT INTO artifacts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(row.id, codec.encode(recordId(row.id), row)); generation++; }
    function configured(repository) {
      const values = limits(repository); record(values, ['keepLatest', 'warningBytes', 'capacityBytes']);
      if (!Number.isSafeInteger(values.keepLatest) || values.keepLatest < 1 || values.keepLatest > 100 || ![values.warningBytes, values.capacityBytes].every(x => Number.isSafeInteger(x) && x > 0 && x <= 100000 * 1024 ** 3)) throw Error('Artifact limits unavailable');
      return values;
    }
    function allocated(all) {
      const names = readdirSync(root), present = new Set(names), known = new Set(all.map(row => row.id + '.pipeliner-artifact'));
      if (names.length > maximumRecords || names.some(name => !known.has(name))) throw Error('Artifact ownership needs recovery');
      let bytes = lstatSync(database).size;
      for (const row of all) {
        if (present.has(row.id + '.pipeliner-artifact')) {
          const info = lstatSync(filePath(row));
          const starting = row.state === 'capturing' && busy?.id === row.id && row.owner === null;
          if (!regular(info) || !starting && (!row.owner || !same(info, row.owner)) || info.size > row.reserved || row.state === 'verified' && !stable(info, row.owner)) throw Error('Artifact ownership needs recovery');
        } else if (row.state === 'verified') throw Error('Artifact bytes need recovery');
        bytes += row.reserved;
      }
      return bytes;
    }
    function token(all, repository) {
      const digest = createHash('sha256').update(canonicalJSON({ session, generation, limits: configured(repository) }));
      for (const row of all) digest.update(canonicalJSON(row)); return digest.digest('hex');
    }
    function inventory(repository, { after = null, limit = 50 } = {}) {
      if (!repositoryId(repository) || after !== null && !uuid(after) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('Artifact scope invalid');
      const all = rows(), values = configured(repository), usedBytes = allocated(all), selected = all.filter(row => row.repository === repository && row.state !== 'discarded').sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
      const start = after === null ? 0 : selected.findIndex(row => row.id === after) + 1; if (after && start === 0) throw Error('Artifact page changed');
      const items = selected.slice(start, start + limit).map(row => ({ id: row.id, manifest: structuredClone(row.manifest), state: row.state, pinned: row.pinned, recovery: row.recovery, active: row.active }));
      return { items, more: start + items.length < selected.length, after: items.at(-1)?.id ?? null, usedBytes, warning: usedBytes >= values.warningBytes,
        overCapacity: usedBytes >= values.capacityBytes, capacityBytes: values.capacityBytes, busy: Boolean(busy), revision: token(all, repository) };
    }
    function target(all, repository, id) { const row = all.find(x => x.repository === repository && x.id === id); if (!row || row.state !== 'verified') throw Error('Verified artifact unavailable'); return row; }
    function interrupted(all, repository, id) {
      const row = all.find(x => x.repository === repository && x.id === id);
      if (!row || !['interrupted', 'deleting'].includes(row.state) || row.active || row.pinned || row.recovery) throw Error('Artifact recovery is protected or unavailable'); return row;
    }
    function disposition(row) {
      location(); let info; try { info = lstatSync(filePath(row)); } catch (error) { if (error.code === 'ENOENT') return { kind: 'absent' }; throw error; }
      if (!regular(info) || !row.owner || !stable(info, row.owner) || !row.cipherHash) throw Error('Artifact recovery ownership unavailable');
      return { kind: 'owned', size: info.size, cipherHash: row.cipherHash };
    }
    async function ciphertextDigest(file, size, signal) {
      const digest = createHash('sha256'); signal?.throwIfAborted();
      for (let offset = 0; offset < size; offset += chunkSize) { signal?.throwIfAborted(); digest.update(await read(file, Math.min(chunkSize, size - offset), offset)); }
      return digest.digest('hex');
    }
    async function inspectInterrupted(row, signal) {
      let file;
      try {
        location(); file = await open(filePath(row), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = await file.stat();
        if (!regular(before) || !stable(before, row.owner) || before.size > archiveSize(row.manifest) || await ciphertextDigest(file, before.size, signal) !== row.cipherHash
          || !stable(before, await file.stat()) || !regular(lstatSync(filePath(row))) || !stable(before, lstatSync(filePath(row)))) throw Error(); location();
      } catch { throw Error('Interrupted artifact changed; bytes preserved for protected repair'); } finally { await file?.close(); }
    }
    const discarded = row => ({ ...row, state: 'discarded', active: false, pinned: false, recovery: false, reserved: 0, owner: null, cipherHash: null });
    async function inspect(row, signal) {
      let file;
      try {
        location(); file = await open(filePath(row), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = await file.stat();
        if (!regular(before) || !stable(before, row.owner) || before.size !== row.reserved) throw Error();
        const plainHash = createHash('sha256'), cipherHash = createHash('sha256'); let position = 0;
        for (let index = 0, offset = 0; offset < row.manifest.bytes; index++, offset += chunkSize) {
          signal?.throwIfAborted(); const length = Math.min(chunkSize, row.manifest.bytes - offset), header = await read(file, 4, position); position += 4;
          if (header.readUInt32BE(0) !== length + 28) throw Error(); cipherHash.update(header);
          const sealed = await read(file, length + 28, position); position += sealed.length; cipherHash.update(sealed); const plain = vault.openPayload(binding(row, index), sealed);
          try { if (plain.length !== length) throw Error(); plainHash.update(plain); } finally { plain.fill(0); }
        }
        location(); if (plainHash.digest('hex') !== row.manifest.sha256 || cipherHash.digest('hex') !== row.cipherHash || !stable(before, await file.stat()) || !regular(lstatSync(filePath(row))) || !stable(before, lstatSync(filePath(row)))) throw Error();
        return true;
      } catch { throw Error('Artifact bytes could not be verified; preserved for recovery'); } finally { await file?.close(); }
    }
    async function syncDirectory() { const file = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { if (!same(await file.stat(), rootInfo)) throw Error(); await file.sync(); } finally { await file.close(); } }
    function prepare(repository, action) {
      if (!repositoryId(repository) || busy) throw Error('Artifact scope busy or invalid'); record(action, ['action'], ['id']);
      if (!['pin', 'unpin', 'recovery', 'retain', 'discard'].includes(action.action) || action.action === 'retain' && action.id !== undefined) throw Error('Artifact action invalid');
      const all = rows(), values = configured(repository), row = action.action === 'retain' ? null : action.action === 'discard' ? interrupted(all, repository, action.id) : target(all, repository, action.id);
      const keep = new Set(all.filter(x => x.repository === repository && x.state === 'verified').sort((a, b) => b.created - a.created || b.id.localeCompare(a.id)).slice(0, values.keepLatest).map(x => x.id));
      const remove = action.action === 'discard' ? [row.id] : action.action === 'retain' ? all.filter(x => x.repository === repository && x.state === 'verified' && !x.active && !x.pinned && !x.recovery && !keep.has(x.id)).map(x => x.id).sort().slice(0, 50) : [];
      const preview = { repository, action: action.action, id: row?.id ?? null, name: row?.manifest.name ?? null, revision: token(all, repository), remove,
        names: remove.map(id => all.find(x => x.id === id).manifest.name), disposition: action.action === 'discard' ? disposition(row) : null, expiresAt: Date.now() + 15 * 60 * 1000 };
      return { ...preview, hash: hash(canonicalJSON(preview)) };
    }
    async function apply(preview, { signal } = {}) {
      ready(); if (busy) throw Error('Artifact storage busy'); record(preview, ['repository', 'action', 'id', 'name', 'revision', 'remove', 'names', 'disposition', 'expiresAt', 'hash']);
      const { hash: supplied, ...base } = preview, all = rows();
      if (supplied !== hash(canonicalJSON(base)) || preview.revision !== token(all, preview.repository) || !Number.isSafeInteger(preview.expiresAt) || preview.expiresAt < Date.now()) throw Error('Artifact preview changed');
      const expected = prepare(preview.repository, preview.action === 'retain' ? { action: 'retain' } : { action: preview.action, id: preview.id });
      if (canonicalJSON(expected.remove) !== canonicalJSON(preview.remove) || canonicalJSON(expected.names) !== canonicalJSON(preview.names) || canonicalJSON(expected.disposition) !== canonicalJSON(preview.disposition) || expected.name !== preview.name) throw Error('Artifact preview changed');
      const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
      const operation = { controller }, boundLimits = canonicalJSON(configured(preview.repository)); busy = operation;
      operation.done = (async () => {
        if (preview.action === 'discard') {
          const row = interrupted(rows(), preview.repository, preview.id);
          if (preview.disposition.kind === 'owned') await inspectInterrupted(row, controller.signal);
          controller.signal.throwIfAborted(); if (boundLimits !== canonicalJSON(configured(preview.repository))) throw Error('Artifact preview changed');
          save({ ...row, state: 'deleting' });
          if (canonicalJSON(disposition(row)) !== canonicalJSON(preview.disposition)) throw Error('Artifact changed; recovery stopped');
          if (preview.disposition.kind === 'owned') await unlink(filePath(row));
          await syncDirectory(); if (disposition({ ...row, owner: null, cipherHash: null }).kind !== 'absent') throw Error('Artifact removal needs reconciliation');
          save(discarded(row)); return { removed: preview.disposition.kind === 'owned' ? 1 : 0, reconciled: true };
        }
        if (preview.action !== 'retain') {
          const row = target(all, preview.repository, preview.id);
          if (preview.action === 'recovery') await inspect(row, controller.signal);
          controller.signal.throwIfAborted();
          if (boundLimits !== canonicalJSON(configured(preview.repository))) throw Error('Artifact preview changed');
          db.exec('BEGIN IMMEDIATE');
          try {
            if (preview.action === 'recovery') for (const prior of all.filter(x => x.repository === preview.repository && x.recovery && x.id !== row.id)) save({ ...prior, recovery: false });
            save({ ...row, ...(preview.action === 'recovery' ? { recovery: true } : { pinned: preview.action === 'pin' }) }); db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          return { removed: 0 };
        }
        let removed = 0;
        for (const id of preview.remove) {
          const row = target(rows(), preview.repository, id); await inspect(row, controller.signal); controller.signal.throwIfAborted();
          if (boundLimits !== canonicalJSON(configured(preview.repository))) throw Error('Artifact limits changed; cleanup stopped');
          // Persist destructive intent. An interrupted delete is held for deliberate reconciliation.
          save({ ...row, state: 'deleting' }); location(); const current = lstatSync(filePath(row)); if (!regular(current) || !stable(current, row.owner)) throw Error('Artifact changed; cleanup stopped');
          await unlink(filePath(row)); await syncDirectory(); if (disposition({ ...row, owner: null, cipherHash: null }).kind !== 'absent') throw Error('Artifact removal needs reconciliation');
          save(discarded(row)); removed++;
        }
        return { removed };
      })();
      try { return await operation.done; } finally { signal?.removeEventListener('abort', abort); busy = null; }
    }
    async function runCapture(input, controller) {
      let source, output, row, created = false;
      try {
        record(input, ['repository', 'commandId', 'sourceDirectory', 'manifest'], ['signal']); manifest(input.manifest);
        if (!repositoryId(input.repository) || !uuid(input.commandId) || input.manifest.host.os !== process.platform || input.manifest.host.architecture !== process.arch) throw Error('Artifact host or scope invalid');
        const fingerprint = hash(canonicalJSON({ repository: input.repository, manifest: input.manifest })), all = rows(), prior = all.find(x => x.commandId === input.commandId);
        if (prior) { if (prior.fingerprint !== fingerprint) throw Error('Artifact command changed'); if (prior.state === 'discarded') throw Error('Artifact command was removed; automatic reallocation is blocked'); if (prior.state !== 'verified') throw Error('Artifact command needs recovery'); await inspect(prior, controller.signal); return structuredClone(prior); }
        if (all.length >= maximumRecords) throw Error('Artifact inventory capacity reached');
        const parent = input.sourceDirectory;
        if (typeof parent !== 'string' || resolve(parent) !== parent || realpathSync(parent) !== parent) throw Error('Artifact source invalid');
        const parentInfo = lstatSync(parent); if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o777) !== 0o700) throw Error('Artifact source invalid');
        const sourcePath = join(parent, input.manifest.name); source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = await source.stat();
        if (!regular(before) || before.size !== input.manifest.bytes || !stable(before, lstatSync(sourcePath))) throw Error('Artifact source invalid');
        const values = configured(input.repository), reserved = archiveSize(input.manifest), used = allocated(all), free = await statfs(directory, { bigint: true });
        if (used + reserved + metadataRoom > values.capacityBytes) throw Error('Artifact capacity reached; retain safely or change the host limit');
        if (free.bavail * free.bsize < BigInt(reserved + metadataRoom + 16 * 1024 ** 2)) throw Error('Artifact free space unavailable');
        controller.signal.throwIfAborted(); row = { id: randomUUID(), repository: input.repository, commandId: input.commandId, fingerprint, manifest: structuredClone(input.manifest), state: 'capturing', pinned: false, recovery: false, active: true,
          created: Math.max(Date.now(), ...all.map(x => x.created + 1)), reserved, owner: null, cipherHash: null };
        busy.id = row.id; save(row); location(); output = await open(filePath(row), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); created = true;
        row.owner = identity(await output.stat()); save(row); const plainHash = createHash('sha256'), cipherHash = createHash('sha256'); let position = 0;
        for (let index = 0, offset = 0; offset < row.manifest.bytes; index++, offset += chunkSize) {
          controller.signal.throwIfAborted(); const plain = await read(source, Math.min(chunkSize, row.manifest.bytes - offset), offset); let sealed;
          try { plainHash.update(plain); sealed = vault.sealPayload(binding(row, index), plain); } finally { plain.fill(0); }
          const header = Buffer.alloc(4); header.writeUInt32BE(sealed.length); await write(output, header, position); position += 4; await write(output, sealed, position); position += sealed.length;
          cipherHash.update(header); cipherHash.update(sealed);
        }
        await output.sync(); row.owner = identity(await output.stat()); row.cipherHash = cipherHash.digest('hex');
        if (plainHash.digest('hex') !== row.manifest.sha256 || row.owner.size !== reserved || !stable(before, await source.stat()) || !regular(lstatSync(sourcePath)) || !stable(before, lstatSync(sourcePath)) || !same(parentInfo, lstatSync(parent)) || realpathSync(parent) !== parent) throw Error();
        await output.close(); output = null; await source.close(); source = null; await syncDirectory(); await inspect(row, controller.signal); controller.signal.throwIfAborted();
        row.state = 'verified'; row.active = false; save(row); return structuredClone(row);
      } catch (error) {
        if (row) {
          if (created && output) {
            try {
              await output.sync(); const before = await output.stat(), current = lstatSync(filePath(row));
              if (!regular(current) || !row.owner || !same(before, row.owner) || !stable(before, current) || before.size > row.reserved) throw Error();
              const digest = await ciphertextDigest(output, before.size);
              if (!stable(before, await output.stat()) || !stable(before, lstatSync(filePath(row)))) throw Error();
              row.owner = identity(before); row.cipherHash = digest;
            } catch { row.cipherHash = null; }
          }
          await output?.close(); output = null; await source?.close(); source = null;
          save({ ...row, state: 'interrupted', active: false }); throw Error('Artifact capture interrupted; preserved for deliberate recovery');
        }
        throw Error(['Artifact command changed', 'Artifact command needs recovery', 'Artifact command was removed; automatic reallocation is blocked', 'Artifact inventory capacity reached', 'Artifact capacity reached; retain safely or change the host limit', 'Artifact free space unavailable'].includes(error.message) ? error.message : 'Artifact capture unavailable; source preserved');
      } finally { await output?.close(); await source?.close(); }
    }
    const initial = rows();
    if (version === 1) {
      db.exec('BEGIN EXCLUSIVE');
      try { createProtectedBackup(database, { vault, store: 'artifacts', version: 1 }); db.exec('PRAGMA user_version=2; COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    for (const row of initial.filter(x => x.state === 'capturing')) save({ ...row, state: 'interrupted', active: false });
    allocated(rows());
    return Object.freeze({ inventory, prepare, apply,
      summary(repository) {
        if (!repositoryId(repository)) throw Error('Artifact scope invalid'); const all = rows(), selected = all.filter(row => row.repository === repository), kept = selected.filter(row => row.state !== 'discarded');
        allocated(all); return { count: kept.length, bytes: kept.reduce((sum, row) => sum + row.reserved, 0), held: kept.filter(row => row.state !== 'verified' || row.active || row.pinned || row.recovery).length, receipts: selected.length - kept.length };
      },
      capture(input) {
        ready(); if (busy) return Promise.reject(Error('Artifact storage busy'));
        const controller = new AbortController(), operation = { controller }; const abort = () => controller.abort();
        input?.signal?.addEventListener('abort', abort, { once: true }); if (input?.signal?.aborted) controller.abort(); busy = operation;
        operation.done = runCapture(input, controller).finally(() => { input?.signal?.removeEventListener('abort', abort); busy = null; }); return operation.done;
      },
      async verify(repository, id) { return inspect(target(rows(), repository, id)); },
      async hold(repository, id, active, settlement) { if (busy || typeof active !== 'boolean' || !active && settlement?.settled !== true) throw Error('Artifact use must be settled by its host owner'); const row = target(rows(), repository, id); save({ ...row, active }); },
      async close() { if (!closed) { if (busy) { const operation = busy; operation.controller.abort(); try { await operation.done; } catch {} } closed = true; db.close(); } }
    });
  } catch { db?.close(); throw Error('Artifact storage unavailable; existing data preserved'); }
}
