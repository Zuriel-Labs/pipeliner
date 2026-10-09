import { lstatSync, realpathSync, openSync, fstatSync, closeSync, fsyncSync, mkdirSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { createRecordCodec } from '../privacy/records.mjs';
import { buildIdentity, readDataCompatibility, requireSameDataSupport } from '../package/build.mjs';
import { isNewerUpdateVersion, checkUpdateContext } from './manifest.mjs';
import { updateBackups, verifyUpdateBackups, captureUpdateBackups } from './backup.mjs';
import { verifyStagedInstaller, stageUpdateInstaller } from './stage.mjs';
import { stageMacUpdateBundle } from './copy.mjs';
import { runMacUpdateCommand, verifyMacUpdateBundle } from './mac.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openDevelopmentStore } from '../development/state.mjs';
import { openArtifactStore } from '../delivery/artifacts.mjs';
import { resolve, dirname, join } from 'node:path';

const phases = ['preparing', 'staged', 'verified', 'replacing', 'relaunching', 'repair-required'];
const time = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = { repository: null, table: 'maintenance_state', key: 1 };
const completedIdentity = id => ({ repository: null, table: 'maintenance_completed', key: id });
const completedTriggers = [
  "CREATE TRIGGER immutable_maintenance_completed_update BEFORE UPDATE ON maintenance_completed BEGIN SELECT RAISE(ABORT,'Immutable maintenance receipt'); END",
  "CREATE TRIGGER immutable_maintenance_completed_delete BEFORE DELETE ON maintenance_completed BEGIN SELECT RAISE(ABORT,'Immutable maintenance receipt'); END",
];
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
  if (value.directory !== directory + '/updates/candidate-' + (intent.rollback?.id ?? intent.id) || typeof installed.bundle !== 'string'
    || resolve(installed.bundle) !== installed.bundle || !installed.bundle.endsWith('/Pipeliner.app') || /[\x00-\x1f\x7f]/.test(installed.bundle)
    || typeof installed.team !== 'string' || !/^[A-Z0-9]{10}$/.test(installed.team)
    || canonicalJSON(buildIdentity(installed.identity)) !== canonicalJSON(intent.from)) throw Error();
  if (value.receipt !== undefined) {
    const receipt = value.receipt; record(receipt, ['directory', 'bundle', 'identity', 'team', 'device', 'inode', ...(intent.rollback ? [] : ['bytes', 'nodes'])]);
    if (receipt.directory !== value.directory || receipt.bundle !== value.directory + '/Pipeliner.app' || receipt.team !== installed.team
      || canonicalJSON(buildIdentity(receipt.identity)) !== canonicalJSON(intent.to)
      || !intent.rollback && (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > 8 * 1024 ** 3
        || !Number.isSafeInteger(receipt.nodes) || receipt.nodes < 1 || receipt.nodes > 20000)
      || ['device', 'inode'].some(key => typeof receipt[key] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(receipt[key]))) throw Error();
  }
}
function replacement(value, intent) {
  canonicalJSON(value); record(value, ['device', 'inode']);
  if (!intent.copy?.receipt || !['replacing', 'relaunching', 'repair-required'].includes(intent.phase)
    || ['device', 'inode'].some(key => typeof value[key] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value[key]))
    || value.device !== intent.copy.receipt.device || value.inode === intent.copy.receipt.inode) throw Error();
}
function intentRecord(value, directory, row) {
  record(value, ['schemaVersion', 'id', 'phase', 'from', 'to', 'createdAt', 'updatedAt', 'revision'], ['sha256', 'bytes', 'rollback', 'backups', 'installer', 'copy', 'replacement']);
  if (value.rollback !== undefined) {
    record(value.rollback, ['id']); buildIdentity(value.from); buildIdentity(value.to);
    if (typeof value.rollback.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.rollback.id)
      || value.rollback.id === value.id || !isNewerUpdateVersion(value.from.version, value.to.version)
      || value.sha256 !== undefined || value.bytes !== undefined || value.installer !== undefined || !value.copy?.receipt) throw Error();
  } else plan({ from: value.from, to: value.to, sha256: value.sha256, bytes: value.bytes });
  if (value.backups !== undefined) updateBackups(value.backups, { directory, build: value.from });
  if (value.installer !== undefined) installer(value.installer, directory, value);
  if (value.copy !== undefined) bundleCopy(value.copy, directory, value);
  if (value.replacement !== undefined) replacement(value.replacement, value);
  if (value.schemaVersion !== (value.rollback ? 2 : 1) || typeof value.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)
    || !phases.includes(value.phase) || !time(value.createdAt) || value.createdAt > value.updatedAt
    || value.updatedAt !== row.clock || value.revision !== row.revision) throw Error();
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
    if (![0, 1, 2, 3].includes(version) || !version && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) throw Error();
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
    let closed = false, active, recovering = false, preparing = false;
    function readState() {
      if (closed) throw Error();
      const current = lstatSync(path), parent = lstatSync(directory), now = clock();
      if (!same(parent, root) || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
        || (parent.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory || !same(current, owner)
        || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o600) throw Error();
      const row = db.prepare('SELECT revision,clock,payload FROM maintenance_state WHERE id=1').get();
      if (!row || !time(row.revision) || !time(row.clock) || !time(now) || now < row.clock) throw Error();
      const value = codec.decode(identity, row.payload, { revision: row.revision, clock: row.clock });
      if (value !== null) intentRecord(value, directory, row);
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
    if (version < 2) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name='maintenance_completed'").get()) throw Error();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('CREATE TABLE maintenance_completed(id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0),clock INTEGER NOT NULL CHECK(clock>=0),completed INTEGER NOT NULL CHECK(completed>=clock),payload BLOB NOT NULL CHECK(length(payload) BETWEEN 28 AND 16384));');
        for (const sql of completedTriggers) db.exec(sql);
        db.exec('PRAGMA user_version=2; COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    function readCompleted(state = readState()) {
      const triggers = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='maintenance_completed'").all().map(row => row.sql);
      if (triggers.length !== completedTriggers.length || completedTriggers.some(sql => !triggers.includes(sql))) throw Error();
      const rows = db.prepare('SELECT id,revision,clock,completed,payload FROM maintenance_completed ORDER BY completed DESC,id LIMIT 1025').all();
      if (rows.length > 1024) throw Error();
      return rows.map(row => {
        if (!time(row.revision) || !time(row.clock) || !time(row.completed) || row.completed < row.clock
          || row.completed > state.row.clock || row.revision >= state.row.revision) throw Error();
        const value = codec.decode(completedIdentity(row.id), row.payload, { revision: row.revision, clock: row.clock, completedAt: row.completed });
        record(value, ['intent', 'completedAt']); intentRecord(value.intent, directory, row);
        if (value.intent.id !== row.id || value.completedAt !== row.completed || !value.intent.copy?.receipt || !value.intent.replacement
          || !value.intent.backups || !value.intent.installer && !value.intent.rollback || !['replacing', 'relaunching', 'repair-required'].includes(value.intent.phase)) throw Error();
        return value;
      });
    }
    readCompleted();
    if (version < 3) {
      db.exec('BEGIN IMMEDIATE');
      try { readCompleted(); db.exec('PRAGMA user_version=3; COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    function reserve(state) {
      readCompleted(state);
      const free = db.prepare('PRAGMA max_page_count').get().max_page_count - db.prepare('PRAGMA page_count').get().page_count
        + db.prepare('PRAGMA freelist_count').get().freelist_count;
      if (free * size < 2 * 16384 + 4 * size) throw Error();
    }
    function rollbackSource(value, state) {
      const previous = readCompleted(state).find(item => item.intent.id === value.rollback.id)?.intent;
      if (!previous || previous.rollback || canonicalJSON(previous.to) !== canonicalJSON(value.from)
        || canonicalJSON(previous.from) !== canonicalJSON(value.to)
        || canonicalJSON(value.copy) !== canonicalJSON({ directory: previous.copy.directory,
          installed: { ...previous.copy.installed, identity: previous.to },
          receipt: { directory: previous.copy.directory, bundle: previous.copy.receipt.bundle, identity: previous.from,
            team: previous.copy.installed.team, device: previous.replacement.device, inode: previous.replacement.inode } })) throw Error();
      return previous;
    }
    const journal = Object.freeze({
      read() { return guarded(() => immutable(readState().value)); },
      completed() { return guarded(() => immutable(readCompleted())); },
      clear() { try { return readState().value === null; } catch { return false; } },
      owned(token) { try { return Boolean(token && token === active?.token && owned(readState())); } catch { return false; } },
      // Host-only composition under the caller's exclusive maintenance checkpoint; no replacement or restoration.
      async prepare(options, { run = runMacUpdateCommand, request, resolve: resolver } = {}) {
        let token, acquired = false;
        try {
          record(options, ['installed', 'history', 'trust', 'current', 'maxBytes', 'reserveBytes', 'timeoutMs', 'checkpoint', 'signal'], ['onIntent']);
          if (Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)
            || preparing || recovering || typeof run !== 'function' || typeof options.checkpoint !== 'function'
            || typeof options.history?.read !== 'function' || !(options.signal instanceof AbortSignal)
            || options.onIntent !== undefined && typeof options.onIntent !== 'function'
            || request !== undefined && typeof request !== 'function' || resolver !== undefined && typeof resolver !== 'function'
            || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 8 * 1024 ** 3
            || !Number.isSafeInteger(options.reserveBytes) || options.reserveBytes < 1024 ** 2 || options.reserveBytes > 1024 ** 4
            || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 1800000) throw Error();
          canonicalJSON(options.installed); canonicalJSON(options.current); record(options.installed, ['bundle', 'team', 'identity']);
          record(options.current, ['channel', 'version', 'platform', 'architecture']); record(options.trust, ['id', 'key', 'origin', 'path']);
          const installed = immutable(structuredClone(options.installed)), trust = { ...options.trust }, current = { ...options.current };
          const { history, checkpoint, signal, maxBytes, reserveBytes, timeoutMs } = options, from = buildIdentity(installed.identity);
          if (['version', 'platform', 'architecture'].some(key => current[key] !== from[key])) throw Error();
          preparing = true; acquired = true; let release;
          function check() {
            signal.throwIfAborted(); checkpoint(); signal.throwIfAborted(); const state = readState(), now = clock();
            if (token ? !owned(state) || token !== active.token : state.value !== null) throw Error();
            checkUpdateContext(trust, { ...current, sequence: 0 }, now);
            const saved = history.read(trust, current), next = saved.availability?.release;
            if (!saved.availability?.available || !next || saved.sequence !== next.sequence || next.bytes > maxBytes
              || now < next.issuedAt || now >= next.expiresAt || release && canonicalJSON(next) !== canonicalJSON(release)) throw Error();
            return immutable(structuredClone(next));
          }
          release = check();
          const to = buildIdentity({ ...from, version: release.version, sourceCommit: release.sourceCommit, gitTree: release.gitTree });
          await verifyMacUpdateBundle({ ...installed, signal }, { run }); check();
          const sourceSupport = await readDataCompatibility(installed.bundle, from, { signal }); check();
          requireSameDataSupport(sourceSupport, sourceSupport);
          if (lstatSync(installed.bundle).dev !== root.dev) throw Error();
          token = journal.begin({ from, to, bytes: release.bytes, sha256: release.sha256 }); active.preparing = true;
          active.revision = transaction(state => {
            if (!owned(state) || token !== active.token || state.value.phase !== 'preparing') throw Error();
            // In preparing this is custody metadata, not verified bytes. bindInstaller must freshly authenticate it before staged.
            return save(state, { ...state.value, installer: { file: directory + '/updates/update-' + state.value.id + '.dmg', bytes: release.bytes, sha256: release.sha256 } });
          });
          active.download = true;
          options.onIntent?.(token);
          check(); const folder = directory + '/updates';
          try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          const parent = lstatSync(folder);
          if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700
            || parent.dev !== root.dev || realpathSync(folder) !== folder) throw Error();
          const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { fsyncSync(fd); } finally { closeSync(fd); }
          const staged = await stageUpdateInstaller({ directory: folder, id: journal.read().id, history, trust, current,
            maxBytes, reserveBytes, timeoutMs, signal, isCurrent: () => { try { check(); return true; } catch { return false; } } }, { request, resolve: resolver, clock });
          check(); const binding = { history, trust, current, checkpoint: check, signal };
          await journal.bindInstaller(token, staged, binding); check();
          const backups = captureUpdateBackups({ directory, vault, build: from, checkpoint: check, signal }); check();
          journal.bindBackups(token, backups); check();
          const receipt = await journal.stageBundle(token, { ...binding, installed, maxBytes, reserveBytes }, { run }); check();
          const source = await readDataCompatibility(installed.bundle, from, { signal }); check();
          const candidate = await readDataCompatibility(receipt.bundle, to, { signal }); check(); requireSameDataSupport(source, candidate);
          journal.advance(token, 'verified'); check(); return token;
        } catch {
          if (token) try { journal.advance(token, 'repair-required'); } catch { /* Preserve the last durable intent if repair recording is unavailable. */ }
          throw Error(token ? 'maintenance-preparation-recovery-required' : 'maintenance-state-unavailable');
        } finally { if (acquired) preparing = false; if (token && active?.token === token) active.preparing = false; }
      },
      // Same-format rollback preserves live data and watermarks; only immutable completed custody selects its target.
      async prepareRollback(options, { run = runMacUpdateCommand } = {}) {
        let token, acquired = false;
        try {
          record(options, ['id', 'running', 'checkpoint', 'signal'], ['onIntent']);
          if (Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)
            || preparing || recovering || typeof run !== 'function' || typeof options.checkpoint !== 'function'
            || !(options.signal instanceof AbortSignal) || options.onIntent !== undefined && typeof options.onIntent !== 'function') throw Error();
          canonicalJSON(options.running); record(options.running, ['bundle', 'identity']);
          const running = immutable(structuredClone(options.running)), { checkpoint, signal } = options;
          buildIdentity(running.identity);
          const initial = readState(), completed = readCompleted(initial).find(item => item.intent.id === options.id), previous = completed?.intent;
          if (initial.value || !previous || previous.rollback || running.bundle !== previous.copy.installed.bundle
            || canonicalJSON(running.identity) !== canonicalJSON(previous.to)) throw Error();
          preparing = true; acquired = true;
          const copy = { directory: previous.copy.directory, installed: { ...previous.copy.installed, identity: previous.to },
            receipt: { directory: previous.copy.directory, bundle: previous.copy.receipt.bundle, identity: previous.from,
              team: previous.copy.installed.team, device: previous.replacement.device, inode: previous.replacement.inode } };
          const initialApps = [running.bundle, copy.receipt.bundle].map(path => lstatSync(path, { bigint: true }));
          const stable = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
          function check() {
            signal.throwIfAborted(); checkpoint(); signal.throwIfAborted(); const state = readState();
            if (token ? !owned(state) || active.token !== token : state.value !== null || state.row.revision !== initial.row.revision) throw Error();
            if (canonicalJSON(readCompleted(state).find(item => item.intent.id === previous.id)) !== canonicalJSON(completed)) throw Error();
            const parent = lstatSync(copy.directory, { bigint: true });
            if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== BigInt(process.getuid())
              || (parent.mode & 0o777n) !== 0o700n || parent.dev !== BigInt(root.dev) || realpathSync(copy.directory) !== copy.directory) throw Error();
            for (const [index, path] of [running.bundle, copy.receipt.bundle].entries()) {
              const current = lstatSync(path, { bigint: true }), expected = index ? previous.replacement : previous.copy.receipt;
              if (!current.isDirectory() || current.isSymbolicLink() || current.mode & 0o022n || ![0n, BigInt(process.getuid())].includes(current.uid)
                || realpathSync(path) !== path || current.dev.toString() !== expected.device || current.ino.toString() !== expected.inode
                || !stable(initialApps[index], current)) throw Error();
            }
          }
          async function native() {
            check(); await verifyMacUpdateBundle({ ...copy.installed, signal }, { run }); check();
            await verifyMacUpdateBundle({ bundle: copy.receipt.bundle, identity: previous.from, team: copy.installed.team, signal }, { run }); check();
            const from = await readDataCompatibility(running.bundle, previous.to, { signal }); check();
            const to = await readDataCompatibility(copy.receipt.bundle, previous.from, { signal }); check(); requireSameDataSupport(from, to);
          }
          await native(); verifyUpdateBackups({ capture: previous.backups, directory, build: previous.from, vault, checkpoint: check }); check();
          const id = randomUUID(); token = Object.freeze({});
          const revision = transaction(state => {
            if (state.value || state.row.revision !== initial.row.revision) throw Error(); reserve(state);
            return save(state, { schemaVersion: 2, id, phase: 'preparing', from: previous.to, to: previous.from,
              rollback: { id: previous.id }, copy, createdAt: state.now });
          });
          active = { token, id, revision, preparing: true }; options.onIntent?.(token); check();
          const backups = captureUpdateBackups({ directory, vault, build: previous.to, checkpoint: check, signal }); check();
          await native();
          active.revision = transaction(state => {
            if (!owned(state) || active.token !== token || state.value.phase !== 'preparing') throw Error(); rollbackSource(state.value, state);
            return save(state, { ...state.value, phase: 'verified', backups });
          });
          check(); return token;
        } catch {
          if (token) try { journal.advance(token, 'repair-required'); } catch { /* Retain the last durable intent. */ }
          throw Error(token ? 'maintenance-rollback-recovery-required' : 'maintenance-state-unavailable');
        } finally { if (acquired) preparing = false; if (token && active?.token === token) active.preparing = false; }
      },
      begin(input) {
        const token = Object.freeze({}), value = guarded(() => { plan(input); return structuredClone(input); });
        const id = randomUUID(), revision = transaction(state => {
          if (state.value !== null) throw Error();
          reserve(state);
          return save(state, { ...value, schemaVersion: 1, id, phase: 'preparing', createdAt: state.now });
        });
        active = { token, id, revision }; return token;
      },
      advance(token, phase) {
        const revision = transaction(state => {
          if (!owned(state) || token !== active.token || !['staged', 'verified', 'repair-required'].includes(phase) || state.value.phase === 'repair-required'
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
          const initial = readState(), eligible = state => owned(state) && token === active.token
            && (!state.value.installer || active.preparing && state.value.phase === 'preparing'
              && canonicalJSON(state.value.installer) === canonicalJSON({ file: candidate.file, bytes: candidate.bytes, sha256: candidate.sha256 }))
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
      async replaceBundle(token, options, { run = runMacUpdateCommand } = {}) {
        let attempted = false, effectRevision;
        try {
          const initial = readState(), rollback = Boolean(initial.value?.rollback);
          record(options, ['checkpoint', 'signal', ...(rollback ? [] : ['history', 'trust', 'current'])]);
          if (Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)
            || typeof run !== 'function' || typeof options.checkpoint !== 'function' || !(options.signal instanceof AbortSignal)) throw Error();
          const { checkpoint, signal, history } = options, trust = { ...options.trust }, current = { ...options.current };
          if (!owned(initial) || token !== active.token || initial.value.phase !== 'verified' || initial.value.replacement
            || !initial.value.copy?.receipt || !initial.value.backups || !rollback && (!initial.value.installer
              || ['version', 'platform', 'architecture'].some(key => current[key] !== initial.value.from[key]))) throw Error();
          const intent = initial.value, { installed, receipt } = intent.copy;
          let revision = initial.row.revision, phase = 'verified';
          function check() {
            signal.throwIfAborted(); checkpoint(); signal.throwIfAborted(); const state = readState();
            if (!owned(state) || token !== active.token || state.row.revision !== revision || state.value.phase !== phase
              || canonicalJSON(state.value.copy) !== canonicalJSON(intent.copy)) throw Error();
            if (rollback) rollbackSource(state.value, state);
          }
          check();
          if (!rollback) {
            const installer = await verifyStagedInstaller({ directory: directory + '/updates', file: intent.installer.file,
              history, trust, current, signal, isCurrent: () => { try { check(); return true; } catch { return false; } } }, { clock });
            if (installer.bytes !== intent.bytes || installer.sha256 !== intent.sha256
              || ['version', 'platform', 'architecture', 'sourceCommit', 'gitTree'].some(key => installer.release[key] !== intent.to[key])) throw Error();
          }
          verifyUpdateBackups({ capture: intent.backups, directory, build: intent.from, vault }); check();
          await verifyMacUpdateBundle({ ...installed, signal }, { run }); check();
          await verifyMacUpdateBundle({ bundle: receipt.bundle, team: installed.team, identity: intent.to, signal }, { run }); check();
          async function support(exchanged = false) {
            const from = await readDataCompatibility(exchanged ? receipt.bundle : installed.bundle, intent.from, { signal }); check();
            const to = await readDataCompatibility(exchanged ? installed.bundle : receipt.bundle, intent.to, { signal }); check();
            requireSameDataSupport(from, to);
          }
          await support();
          const inspect = path => lstatSync(path, { bigint: true }), from = inspect(installed.bundle), to = inspect(receipt.bundle);
          if (rollback) {
            const expected = rollbackSource(intent, readState()).copy.receipt;
            if (from.dev.toString() !== expected.device || from.ino.toString() !== expected.inode) throw Error();
          }
          const parents = [dirname(installed.bundle), receipt.directory], roots = parents.map(inspect);
          const helper = join(installed.bundle, 'Contents/Resources/helpers/update-exchange'), executable = inspect(helper);
          const unchanged = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
          if (!executable.isFile() || executable.nlink !== 1n || ![0n, BigInt(process.getuid())].includes(executable.uid)
            || executable.mode & 0o022n || !(executable.mode & 0o111n) || realpathSync(helper) !== helper
            || to.dev.toString() !== receipt.device || to.ino.toString() !== receipt.inode || from.dev !== to.dev || from.ino === to.ino) throw Error();
          function bindings(exchanged = false) {
            check();
            for (let index = 0; index < parents.length; index++) {
              const parent = inspect(parents[index]), path = index ? receipt.bundle : installed.bundle, app = inspect(path);
              const original = exchanged ? index ? from : to : index ? to : from;
              if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== BigInt(process.getuid()) || parent.mode & 0o022n
                || realpathSync(parents[index]) !== parents[index] || !['dev', 'ino', 'uid', 'mode'].every(key => parent[key] === roots[index][key])
                || !app.isDirectory() || app.isSymbolicLink() || app.mode & 0o022n || ![0n, BigInt(process.getuid())].includes(app.uid)
                || realpathSync(path) !== path || app.dev !== parent.dev || !['dev', 'ino', 'uid', 'mode'].every(key => app[key] === original[key])
                || !exchanged && !unchanged(app, original)) throw Error();
            }
            const path = exchanged ? join(receipt.bundle, 'Contents/Resources/helpers/update-exchange') : helper;
            if (realpathSync(path) !== path || !unchanged(executable, inspect(path))) throw Error();
          }
          bindings();
          for (let index = 0; index < parents.length; index++) {
            const verified = await run(helper, ['--verify-parent', parents[index], roots[index].dev.toString(), roots[index].ino.toString()], signal);
            if (verified.stdout !== 'pipeliner-update-parent-verified\n' || verified.stderr !== '') throw Error(); bindings();
          }
          verifyUpdateBackups({ capture: intent.backups, directory, build: intent.from, vault }); bindings(); await support(); bindings();
          const original = { device: from.dev.toString(), inode: from.ino.toString() };
          replacement(original, { ...intent, phase: 'replacing' });
          revision = transaction(state => {
            if (!owned(state) || token !== active.token || state.row.revision !== revision || state.value.phase !== 'verified') throw Error();
            return save(state, { ...state.value, phase: 'replacing', replacement: original });
          });
          active.revision = revision; effectRevision = revision; phase = 'replacing'; attempted = true; bindings();
          const result = await run(helper, [...parents, original.device, original.inode, receipt.device, receipt.inode], signal);
          if (result.stdout !== 'pipeliner-update-exchanged\n' || result.stderr !== '') throw Error(); bindings(true);
          await verifyMacUpdateBundle({ bundle: installed.bundle, team: installed.team, identity: intent.to, signal }, { run }); bindings(true);
          await verifyMacUpdateBundle({ bundle: receipt.bundle, team: installed.team, identity: intent.from, signal }, { run }); bindings(true);
          await support(true); bindings(true);
          const bound = transaction(state => {
            if (!owned(state) || token !== active.token || state.row.revision !== revision || state.value.phase !== 'replacing') throw Error();
            return save(state, { ...state.value, phase: 'relaunching' });
          });
          active.revision = bound; return immutable({ installed: installed.bundle, rollback: receipt.bundle, identity: intent.to });
        } catch {
          if (attempted) try {
            const state = readState();
            if (owned(state) && token === active.token && state.row.revision === effectRevision && state.value.phase === 'replacing')
              active.revision = transaction(current => {
                if (!owned(current) || current.row.revision !== effectRevision || current.value.phase !== 'replacing') throw Error();
                return save(current, { ...current.value, phase: 'repair-required' });
              });
          } catch { /* The persisted replacing intent remains a recovery fence when repair recording fails. */ }
          throw Error(attempted ? 'maintenance-replacement-recovery-required' : 'maintenance-state-unavailable');
        }
      },
      // Foreground packaged startup only. The host captures running identity before any installer can run.
      async finishRelaunch(options, { run = runMacUpdateCommand } = {}) {
        const held = []; let acquired = false;
        try {
          record(options, ['running', 'checkpoint', 'signal']);
          if (Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)
            || recovering || active || typeof run !== 'function' || typeof options.checkpoint !== 'function' || !(options.signal instanceof AbortSignal)) throw Error();
          canonicalJSON(options.running);
          record(options.running, ['bundle', 'identity']);
          const running = immutable(structuredClone(options.running)), { checkpoint, signal } = options, initial = readState(), intent = initial.value;
          if (!intent || !['replacing', 'relaunching', 'repair-required'].includes(intent.phase) || !intent.copy?.receipt || !intent.replacement || !intent.backups
            || running.bundle !== intent.copy.installed.bundle || canonicalJSON(buildIdentity(running.identity)) !== canonicalJSON(intent.to)) throw Error();
          recovering = true; acquired = true;
          function check() {
            signal.throwIfAborted(); checkpoint(); signal.throwIfAborted(); const state = readState();
            if (active || state.row.revision !== initial.row.revision || canonicalJSON(state.value) !== canonicalJSON(intent)) throw Error();
            if (intent.rollback) rollbackSource(state.value, state);
          }
          const inspect = path => lstatSync(path, { bigint: true }), { installed, receipt } = intent.copy;
          const parents = [dirname(installed.bundle), receipt.directory], roots = parents.map(inspect);
          const helper = join(installed.bundle, 'Contents/Resources/helpers/update-exchange'), executable = inspect(helper);
          const stable = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
          if (!executable.isFile() || executable.nlink !== 1n || ![0n, BigInt(process.getuid())].includes(executable.uid)
            || executable.mode & 0o022n || !(executable.mode & 0o111n) || realpathSync(helper) !== helper) throw Error();
          function bindings() {
            check();
            for (let index = 0; index < parents.length; index++) {
              const parent = inspect(parents[index]), path = index ? receipt.bundle : installed.bundle, app = inspect(path);
              const expected = index ? intent.replacement : { device: receipt.device, inode: receipt.inode };
              if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== BigInt(process.getuid()) || parent.mode & 0o022n
                || realpathSync(parents[index]) !== parents[index] || !['dev', 'ino', 'uid', 'mode'].every(key => parent[key] === roots[index][key])
                || !app.isDirectory() || app.isSymbolicLink() || app.mode & 0o022n || ![0n, BigInt(process.getuid())].includes(app.uid)
                || realpathSync(path) !== path || app.dev !== parent.dev || app.dev.toString() !== expected.device || app.ino.toString() !== expected.inode) throw Error();
            }
            if (realpathSync(helper) !== helper || !stable(executable, inspect(helper))) throw Error();
          }
          async function native() {
            bindings();
            await verifyMacUpdateBundle({ bundle: installed.bundle, team: installed.team, identity: intent.to, signal }, { run }); bindings();
            await verifyMacUpdateBundle({ bundle: receipt.bundle, team: installed.team, identity: intent.from, signal }, { run }); bindings();
            const from = await readDataCompatibility(receipt.bundle, intent.from, { signal }); bindings();
            const to = await readDataCompatibility(installed.bundle, intent.to, { signal }); bindings();
            requireSameDataSupport(from, to);
            for (let index = 0; index < parents.length; index++) {
              const result = await run(helper, ['--verify-parent', parents[index], roots[index].dev.toString(), roots[index].ino.toString()], signal);
              if (result.stdout !== 'pipeliner-update-parent-verified\n' || result.stderr !== '') throw Error(); bindings();
            }
            verifyUpdateBackups({ capture: intent.backups, directory, build: intent.from, vault, checkpoint: bindings }); bindings();
          }
          await native();
          function dataBindings() {
            bindings();
            for (const item of held) {
              const current = inspect(item.path);
              if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.uid !== BigInt(process.getuid())
                || (current.mode & 0o777n) !== 0o600n || current.dev !== BigInt(root.dev) || realpathSync(item.path) !== item.path
                || !['dev', 'ino', 'uid', 'mode', 'nlink'].every(key => current[key] === item.original[key])
                || item.fd !== undefined && !['dev', 'ino', 'uid', 'mode', 'nlink'].every(key => fstatSync(item.fd, { bigint: true })[key] === current[key])
                || item.verified && !stable(item.verified, current)
                || ['-wal', '-shm', '-journal'].some(suffix => lstatSync(item.path + suffix, { throwIfNoEntry: false }))) throw Error();
            }
          }
          // Existing schemas only; a future update must provide its reviewed compatibility/migration contract.
          for (const [store, version] of [['workspaces', 5], ['development', 2], ['artifacts', 2]]) {
            const path = join(directory, store + '.sqlite'), item = { path }; held.push(item);
            item.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); item.original = fstatSync(item.fd, { bigint: true });
            if (item.original.size < 100n || item.original.size > BigInt(512 * 1024 ** 2)) throw Error(); dataBindings();
            const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 });
            try {
              database.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;');
              if (database.prepare('PRAGMA user_version').get().user_version !== version
                || database.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete'
                || database.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error();
            } finally { database.close(); }
          }
          const artifactRoot = join(directory, 'artifacts'), artifactInfo = inspect(artifactRoot);
          if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink() || artifactInfo.uid !== BigInt(process.getuid())
            || (artifactInfo.mode & 0o777n) !== 0o700n || artifactInfo.dev !== BigInt(root.dev) || realpathSync(artifactRoot) !== artifactRoot) throw Error();
          dataBindings(); openWorkspaceStore(directory, { vault }).close(); dataBindings();
          openDevelopmentStore(directory, { vault }).close(); dataBindings();
          const artifacts = await openArtifactStore(directory, { vault, limits() { throw Error('Recovery cannot change artifact limits'); } });
          try { dataBindings(); } finally { await artifacts.close(); }
          dataBindings();
          for (const item of held) { item.verified = fstatSync(item.fd, { bigint: true }); closeSync(item.fd); item.fd = undefined; }
          dataBindings(); await native(); dataBindings();
          if (!stable(artifactInfo, inspect(artifactRoot)) || realpathSync(artifactRoot) !== artifactRoot) throw Error();
          transaction(state => {
            if (active || state.row.revision !== initial.row.revision || canonicalJSON(state.value) !== canonicalJSON(intent)) throw Error();
            readCompleted(state);
            db.prepare('INSERT INTO maintenance_completed VALUES(?,?,?,?,?)').run(intent.id, intent.revision, intent.updatedAt, state.now,
              codec.encode(completedIdentity(intent.id), { intent, completedAt: state.now }, { revision: intent.revision, clock: intent.updatedAt, completedAt: state.now }));
            save(state, null);
          });
        } catch { throw Error('maintenance-relaunch-recovery-required'); }
        finally {
          if (acquired) recovering = false;
          let failed = false;
          for (const item of held) if (item.fd !== undefined) try { closeSync(item.fd); } catch { failed = true; }
          if (failed) throw Error('maintenance-relaunch-recovery-required');
        }
      },
      // The installer must verify owned cleanup before cancelling a pre-replacement intent.
      cancel(token) {
        transaction(state => {
          if (!owned(state) || token !== active.token || active.copying || active.preparing || !['preparing', 'staged', 'verified'].includes(state.value.phase)) throw Error();
          if (active.download) {
            const folder = directory + '/updates', parent = lstatSync(folder, { throwIfNoEntry: false });
            if (parent && (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700
              || realpathSync(folder) !== folder || parent.dev !== root.dev) || lstatSync(state.value.installer.file, { throwIfNoEntry: false })) throw Error();
          }
          if (state.value.copy && !state.value.rollback) {
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
    return journal;
  } catch { db?.close(); throw Error('maintenance-state-unavailable'); }
}
