import { lstatSync, realpathSync, openSync, fstatSync, closeSync, fsyncSync, constants } from 'node:fs';
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
import { runMacUpdateCommand, verifyMacUpdateBundle } from './mac.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openDevelopmentStore } from '../development/state.mjs';
import { openArtifactStore } from '../delivery/artifacts.mjs';
import { resolve, dirname, join } from 'node:path';

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
function replacement(value, intent) {
  canonicalJSON(value); record(value, ['device', 'inode']);
  if (!intent.copy?.receipt || !['replacing', 'relaunching', 'repair-required'].includes(intent.phase)
    || ['device', 'inode'].some(key => typeof value[key] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value[key]))
    || value.device !== intent.copy.receipt.device || value.inode === intent.copy.receipt.inode) throw Error();
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
    let closed = false, active, recovering = false;
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
        record(value, ['schemaVersion', 'id', 'phase', 'from', 'to', 'sha256', 'bytes', 'createdAt', 'updatedAt', 'revision'], ['backups', 'installer', 'copy', 'replacement']);
        plan({ from: value.from, to: value.to, sha256: value.sha256, bytes: value.bytes });
        if (value.backups !== undefined) updateBackups(value.backups, { directory, build: value.from });
        if (value.installer !== undefined) installer(value.installer, directory, value);
        if (value.copy !== undefined) bundleCopy(value.copy, directory, value);
        if (value.replacement !== undefined) replacement(value.replacement, value);
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
      async replaceBundle(token, options, { run = runMacUpdateCommand } = {}) {
        let attempted = false, effectRevision;
        try {
          record(options, ['history', 'trust', 'current', 'checkpoint', 'signal']);
          if (Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)
            || typeof run !== 'function' || typeof options.checkpoint !== 'function' || !(options.signal instanceof AbortSignal)) throw Error();
          const { checkpoint, signal, history } = options, trust = { ...options.trust }, current = { ...options.current };
          const initial = readState();
          if (!owned(initial) || token !== active.token || initial.value.phase !== 'verified' || initial.value.replacement
            || !initial.value.copy?.receipt || !initial.value.backups || !initial.value.installer
            || ['version', 'platform', 'architecture'].some(key => current[key] !== initial.value.from[key])) throw Error();
          const intent = initial.value, { installed, receipt } = intent.copy;
          let revision = initial.row.revision, phase = 'verified';
          function check() {
            signal.throwIfAborted(); checkpoint(); signal.throwIfAborted(); const state = readState();
            if (!owned(state) || token !== active.token || state.row.revision !== revision || state.value.phase !== phase
              || canonicalJSON(state.value.copy) !== canonicalJSON(intent.copy)) throw Error();
          }
          check();
          const installer = await verifyStagedInstaller({ directory: directory + '/updates', file: intent.installer.file,
            history, trust, current, signal, isCurrent: () => { try { check(); return true; } catch { return false; } } }, { clock });
          if (installer.bytes !== intent.bytes || installer.sha256 !== intent.sha256
            || ['version', 'platform', 'architecture', 'sourceCommit', 'gitTree'].some(key => installer.release[key] !== intent.to[key])) throw Error();
          verifyUpdateBackups({ capture: intent.backups, directory, build: intent.from, vault }); check();
          await verifyMacUpdateBundle({ ...installed, signal }, { run }); check();
          await verifyMacUpdateBundle({ bundle: receipt.bundle, team: installed.team, identity: intent.to, signal }, { run }); check();
          const inspect = path => lstatSync(path, { bigint: true }), from = inspect(installed.bundle), to = inspect(receipt.bundle);
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
          verifyUpdateBackups({ capture: intent.backups, directory, build: intent.from, vault }); bindings();
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
