import { lstatSync, realpathSync, openSync, closeSync, fsyncSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { createRecordCodec } from '../privacy/records.mjs';
import { buildIdentity } from '../package/build.mjs';
import { isNewerUpdateVersion } from './manifest.mjs';
import { updateBackups, verifyUpdateBackups } from './backup.mjs';
import { verifyStagedInstaller } from './stage.mjs';
import { stageMacUpdateBundle } from './copy.mjs';
import { runMacUpdateCommand } from './mac.mjs';
import { resolve } from 'node:path';

const phases = ['preparing', 'staged', 'verified', 'replacing', 'relaunching', 'repair-required'];
const time = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = { repository: null, table: 'maintenance_state', key: 1 };
function plan(value) {
  canonicalJSON(value); record(value, ['from', 'to', 'sha256', 'bytes']); buildIdentity(value.from); buildIdentity(value.to);
  if (!isNewerUpdateVersion(value.to.version, value.from.version) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 8 * 1024 ** 3) throw Error();
}
function installer(value, directory, intent) {
  canonicalJSON(value); record(value, ['file', 'bytes', 'sha256']);
  const folder = directory + '/updates/';
  if (typeof value.file !== 'string' || !value.file.startsWith(folder)
    || !/^update-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.dmg$/.test(value.file.slice(folder.length))
    || value.bytes !== intent.bytes || value.sha256 !== intent.sha256) throw Error();
}
function bundleCopy(value, directory, intent) {
  canonicalJSON(value); record(value, ['directory', 'installed'], ['receipt']); record(value.installed, ['bundle', 'team', 'identity']);
  const installed = value.installed;
  if (value.directory !== directory + '/updates/candidate-' + intent.id || typeof installed.bundle !== 'string'
    || resolve(installed.bundle) !== installed.bundle || !installed.bundle.endsWith('/Pipeliner.app') || /[\x00-\x1f\x7f]/.test(installed.bundle)
    || typeof installed.team !== 'string' || !/^[A-Z0-9]{10}$/.test(installed.team)
    || canonicalJSON(buildIdentity(installed.identity)) !== canonicalJSON(intent.from)) throw Error();
  if (value.receipt !== undefined) {
    const receipt = value.receipt; record(receipt, ['directory', 'bundle', 'identity', 'team', 'bytes', 'nodes', 'device', 'inode']);
    if (receipt.directory !== value.directory || receipt.bundle !== value.directory + '/Pipeliner.app' || receipt.team !== installed.team
      || canonicalJSON(buildIdentity(receipt.identity)) !== canonicalJSON(intent.to) || !Number.isSafeInteger(receipt.bytes)
      || receipt.bytes < 1 || receipt.bytes > 8 * 1024 ** 3 || !Number.isSafeInteger(receipt.nodes) || receipt.nodes < 1 || receipt.nodes > 20000
      || ['device', 'inode'].some(key => typeof receipt[key] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(receipt[key]))) throw Error();
  }
}

// Host-only intent, not update trust or effect reconciliation. A pending record never clears on reopen.
export function openUpdateMaintenance(directory, { vault, clock = Date.now }) {
  let db;
  try {
    if (typeof clock !== 'function' || realpathSync(directory) !== directory) throw Error();
    const codec = createRecordCodec(vault, 'update'), path = protectedFile(directory, 'maintenance.sqlite');
    const owner = lstatSync(path), root = lstatSync(directory);
    db = new DatabaseSync(path, { allowExtension: false, timeout: 1000 });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version) || !version && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) throw Error();
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;');
    const size = db.prepare('PRAGMA page_size').get().page_size;
    if (!Number.isInteger(size) || size < 512 || size > 65536
      || db.prepare('PRAGMA max_page_count=' + Math.floor(1024 ** 2 / size)).get().max_page_count * size > 1024 ** 2
      || db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete' || db.prepare('PRAGMA synchronous').get().synchronous !== 3) throw Error();
    if (!version) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('CREATE TABLE maintenance_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0),clock INTEGER NOT NULL CHECK(clock>=0),payload BLOB NOT NULL CHECK(length(payload) BETWEEN 28 AND 16384));');
        db.prepare('INSERT INTO maintenance_state VALUES(1,0,0,?)').run(codec.encode(identity, null, { revision: 0, clock: 0 }));
        db.exec('PRAGMA user_version=1; COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error();
    let closed = false, active;
    function readState() {
      if (closed) throw Error();
      const current = lstatSync(path), parent = lstatSync(directory), now = clock();
      if (!same(parent, root) || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
        || (parent.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory || !same(current, owner)
        || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o600) throw Error();
      const row = db.prepare('SELECT revision,clock,payload FROM maintenance_state WHERE id=1').get();
      if (!row || !time(row.revision) || !time(row.clock) || !time(now) || now < row.clock) throw Error();
      const value = codec.decode(identity, row.payload, { revision: row.revision, clock: row.clock });
      if (value !== null) {
        record(value, ['schemaVersion', 'id', 'phase', 'from', 'to', 'sha256', 'bytes', 'createdAt', 'updatedAt', 'revision'], ['backups', 'installer', 'copy']);
        plan({ from: value.from, to: value.to, sha256: value.sha256, bytes: value.bytes });
        if (value.backups !== undefined) updateBackups(value.backups, { directory, build: value.from });
        if (value.installer !== undefined) installer(value.installer, directory, value);
        if (value.copy !== undefined) bundleCopy(value.copy, directory, value);
        if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)
          || !phases.includes(value.phase) || !time(value.createdAt) || value.createdAt > value.updatedAt
          || value.updatedAt !== row.clock || value.revision !== row.revision) throw Error();
      }
      return { value, row, now };
    }
    function save(state, value) {
      if (state.row.revision === Number.MAX_SAFE_INTEGER) throw Error();
      const revision = state.row.revision + 1, payload = value === null ? null : { ...value, revision, updatedAt: state.now };
      db.prepare('UPDATE maintenance_state SET revision=?,clock=?,payload=? WHERE id=1')
        .run(revision, state.now, codec.encode(identity, payload, { revision, clock: state.now }));
      return revision;
    }
    function guarded(work) { try { return work(); } catch { throw Error('maintenance-state-unavailable'); } }
    function transaction(work) {
      return guarded(() => {
        db.exec('BEGIN IMMEDIATE');
        try { const result = work(readState()); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    }
    function owned(state) { return Boolean(active && state.value?.id === active.id && state.row.revision === active.revision); }
    readState();
    return Object.freeze({
      read() { return guarded(() => immutable(readState().value)); },
      clear() { try { return readState().value === null; } catch { return false; } },
      owned() { try { return owned(readState()); } catch { return false; } },
      begin(input) {
        const token = Object.freeze({}), value = guarded(() => { plan(input); return structuredClone(input); });
        const id = randomUUID(), revision = transaction(state => {
          if (state.value !== null) throw Error();
          return save(state, { ...value, schemaVersion: 1, id, phase: 'preparing', createdAt: state.now });
        });
        active = { token, id, revision }; return token;
      },
      advance(token, phase) {
        const revision = transaction(state => {
          if (!owned(state) || token !== active.token || !phases.includes(phase) || state.value.phase === 'repair-required'
            || ['verified', 'replacing', 'relaunching'].includes(phase) && (!state.value.backups || !state.value.installer || !state.value.copy?.receipt)
            || phase !== 'repair-required' && phases.indexOf(phase) !== phases.indexOf(state.value.phase) + 1) throw Error();
          return save(state, { ...state.value, phase });
        });
        active.revision = revision;
      },
      async bindInstaller(token, receipt, options) {
        try {
          record(options, ['history', 'trust', 'current'], ['checkpoint', 'signal']); canonicalJSON(receipt); record(receipt, ['file', 'bytes', 'sha256', 'release']);
          const candidate = immutable(structuredClone(receipt)), checkpoint = options.checkpoint ?? (() => {}), signal = options.signal;
          const trust = { ...options.trust }, current = { ...options.current };
          const initial = readState(), eligible = state => owned(state) && token === active.token && !state.value.installer
            && ['preparing', 'staged'].includes(state.value.phase) && state.row.revision === initial.row.revision;
          if (typeof checkpoint !== 'function' || signal !== undefined && !(signal instanceof AbortSignal) || !eligible(initial)
            || ['version', 'platform', 'architecture'].some(key => current[key] !== initial.value.from[key])) throw Error();
          installer({ file: candidate.file, bytes: candidate.bytes, sha256: candidate.sha256 }, directory, initial.value);
          const isCurrent = () => {
            try { signal?.throwIfAborted(); checkpoint(); signal?.throwIfAborted(); return eligible(readState()); } catch { return false; }
          };
          const verified = await verifyStagedInstaller({ directory: directory + '/updates', file: candidate.file,
            history: options.history, trust, current, signal, isCurrent }, { clock });
          if (!isCurrent() || canonicalJSON(verified) !== canonicalJSON(candidate)
            || ['version', 'platform', 'architecture', 'sourceCommit', 'gitTree'].some(key => verified.release[key] !== initial.value.to[key])) throw Error();
          const revision = transaction(state => {
            if (!eligible(state)) throw Error();
            return save(state, { ...state.value, phase: 'staged', installer: { file: verified.file, bytes: verified.bytes, sha256: verified.sha256 } });
          });
          active.revision = revision;
        } catch { throw Error('maintenance-state-unavailable'); }
      },
      bindBackups(token, capture) {
        const backups = guarded(() => {
          const state = readState();
          if (!owned(state) || token !== active.token || state.value.backups || !['preparing', 'staged'].includes(state.value.phase)) throw Error();
          return verifyUpdateBackups({ capture, directory, build: state.value.from, vault });
        });
        const revision = transaction(state => {
          if (!owned(state) || token !== active.token || state.value.backups || !['preparing', 'staged'].includes(state.value.phase)) throw Error();
          return save(state, { ...state.value, backups });
        });
        active.revision = revision;
      },
      async stageBundle(token, options, { run = runMacUpdateCommand } = {}) {
        let copying = false;
        try {
          record(options, ['installed', 'history', 'trust', 'current', 'maxBytes', 'reserveBytes'], ['checkpoint', 'signal']);
          if (Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)) throw Error();
          canonicalJSON(options.installed); canonicalJSON(options.current);
          const installed = immutable(structuredClone(options.installed)), trust = { ...options.trust }, current = { ...options.current };
          const checkpoint = options.checkpoint ?? (() => {}), signal = options.signal ?? new AbortController().signal;
          const { maxBytes, reserveBytes } = options;
          if (typeof run !== 'function' || typeof checkpoint !== 'function' || !(signal instanceof AbortSignal)
            || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 ** 3
            || !Number.isSafeInteger(reserveBytes) || reserveBytes < 1024 ** 2 || reserveBytes > 1024 ** 4) throw Error();
          signal.throwIfAborted(); checkpoint(); signal.throwIfAborted();
          const initial = readState(), copy = { directory: directory + '/updates/candidate-' + initial.value?.id, installed };
          const eligible = state => owned(state) && token === active.token && state.value.phase === 'staged' && state.value.installer && state.value.backups;
          if (!eligible(initial) || initial.value.copy || ['version', 'platform', 'architecture'].some(key => current[key] !== initial.value.from[key])) throw Error();
          bundleCopy(copy, directory, initial.value);
          const revision = transaction(state => {
            if (!eligible(state) || state.value.copy || state.row.revision !== initial.row.revision) throw Error();
            return save(state, { ...state.value, copy });
          });
          active.revision = revision; active.copying = true; copying = true;
          const isCurrent = () => {
            try { signal.throwIfAborted(); checkpoint(); signal.throwIfAborted(); const state = readState();
              return Boolean(eligible(state) && state.row.revision === revision && canonicalJSON(state.value.copy) === canonicalJSON(copy));
            } catch { return false; }
          };
          let receipt;
          try {
            receipt = await stageMacUpdateBundle({ directory: directory + '/updates', id: initial.value.id, installed,
              image: { directory: directory + '/updates', file: initial.value.installer.file, history: options.history, trust, current,
                team: installed.team, signal, isCurrent }, maxBytes, reserveBytes }, { run, clock });
          } catch (error) {
            if (error.message === 'update-bundle-copy-recovery-required') {
              active.revision = transaction(state => {
                if (!eligible(state) || state.row.revision !== revision) throw Error();
                return save(state, { ...state.value, phase: 'repair-required' });
              });
            }
            throw error;
          }
          if (!isCurrent()) throw Error();
          bundleCopy({ ...copy, receipt }, directory, initial.value);
          const bound = transaction(state => {
            if (!eligible(state) || state.row.revision !== revision || canonicalJSON(state.value.copy) !== canonicalJSON(copy)) throw Error();
            return save(state, { ...state.value, copy: { ...copy, receipt } });
          });
          active.revision = bound; return immutable(receipt);
        } catch { throw Error('maintenance-state-unavailable'); }
        finally { if (copying && active?.token === token) active.copying = false; }
      },
      // The installer must verify owned cleanup before cancelling a pre-replacement intent.
      cancel(token) {
        transaction(state => {
          if (!owned(state) || token !== active.token || active.copying || !['preparing', 'staged', 'verified'].includes(state.value.phase)) throw Error();
          if (state.value.copy) {
            const folder = directory + '/updates', parent = lstatSync(folder);
            if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700
              || realpathSync(folder) !== folder || parent.dev !== root.dev) throw Error();
            try { lstatSync(state.value.copy.directory); throw Error(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          save(state, null);
        });
        active = undefined;
      },
      close() { if (!closed) { closed = true; active = undefined; db.close(); } },
    });
  } catch { db?.close(); throw Error('maintenance-state-unavailable'); }
}
