import { lstatSync, realpathSync, openSync, closeSync, fsyncSync, constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { createRecordCodec } from '../privacy/records.mjs';
import { buildIdentity, buildIdentityName, readBuildIdentity } from '../package/build.mjs';
import { inspectManagedData } from '../privacy/inventory.mjs';
import { runMacUpdateCommand } from './mac.mjs';
import { backgroundBundleId } from '../background/native.mjs';

const phases = ['logout-pending', 'service-pending', 'credentials-pending', 'trash-pending', 'removed'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const binding = { repository: null, table: 'uninstall_state', key: 1 };
const schema = 'CREATE TABLE uninstall_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0),clock INTEGER NOT NULL CHECK(clock>=0),payload BLOB NOT NULL CHECK(length(payload) BETWEEN 28 AND 16384))';
const consumers = new WeakSet();
const custodyKeys = ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const bundlePaths = bundle => [bundle, dirname(bundle), join(bundle, 'Contents'), join(bundle, 'Contents/Resources'), join(bundle, 'Contents/MacOS'), join(bundle, 'Contents/MacOS/Pipeliner'), join(bundle, 'Contents/Resources', buildIdentityName)];
function snapshot(value) {
  record(value, ['count', 'stored', 'sha256']);
  if (!Number.isSafeInteger(value.count) || value.count < 0 || value.count > 2048 || !Number.isSafeInteger(value.stored)
    || value.stored < 0 || value.stored > value.count || !digest(value.sha256)) throw Error();
}
export function checkUninstallPlan(value) {
  canonicalJSON(value); record(value, ['bundle', 'identity', 'team', 'custody', 'credentials', 'service', 'recordInventorySha256']);
  buildIdentity(value.identity); record(value.custody, ['device', 'inode']); record(value.credentials, ['before', 'after']);
  snapshot(value.credentials.before); snapshot(value.credentials.after); record(value.service, ['qualified', 'status']);
  if (typeof value.bundle !== 'string' || value.bundle.length > 512 || resolve(value.bundle) !== value.bundle
    || !value.bundle.endsWith('/Pipeliner.app') || /[\x00-\x1f\x7f]/.test(value.bundle)
    || typeof value.team !== 'string' || !/^[A-Z0-9]{10}$/.test(value.team)
    || Object.values(value.custody).some(item => typeof item !== 'string' || !/^[1-9][0-9]{0,19}$/.test(item))
    || value.credentials.before.count !== value.credentials.after.count || value.credentials.after.stored !== 0
    || value.service.qualified !== true || !['not-registered', 'enabled', 'requires-approval', 'not-found'].includes(value.service.status)
    || !digest(value.recordInventorySha256)) throw Error();
}
function intent(value, row) {
  record(value, ['schemaVersion', 'id', 'revision', 'phase', 'createdAt', 'updatedAt', 'plan']); checkUninstallPlan(value.plan);
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)
    || !phases.includes(value.phase) || !time(value.createdAt) || value.createdAt > value.updatedAt
    || value.updatedAt !== row.clock || value.revision !== row.revision) throw Error();
}
function credentials(vault, value, phase, recovery = false) {
  const current = canonicalJSON(vault.connectionInventory()), expected = value.plan.credentials;
  const allowed = ['logout-pending', 'service-pending', 'credentials-pending'].includes(phase) ? [expected.before] : [expected.after];
  if (recovery && phase === 'credentials-pending') allowed.push(expected.after);
  if (!allowed.some(snapshot => canonicalJSON(snapshot) === current)) throw Error();
}
function checkpoint(work) {
  const result = work(); if (result instanceof Promise) result.catch(() => {});
  if (result !== undefined) throw Error();
}
function recordInventory(directory) {
  const inventory = inspectManagedData(directory).filter(value => ['policy', 'workspaces', 'development', 'execution', 'extensions', 'privacy', 'artifacts', 'archives', 'migration'].includes(value.id));
  if (inventory.some(value => value.state === 'unavailable')) throw Error();
  return createHash('sha256').update(canonicalJSON(inventory.map(({ id, count, bytes, state }) => ({ id, count, bytes, state })))).digest('hex');
}

// Read-only host capture. Signature/custody evidence does not grant PM authority or qualify any removal effect.
export async function captureMacUninstallPlan(options, { run = runMacUpdateCommand } = {}) {
  try {
    record(options, ['app', 'background', 'directory', 'vault', 'checkpoint'], ['signal']);
    if (Object.getOwnPropertySymbols(options).length || Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)
      || process.platform !== 'darwin' || process.arch !== 'arm64' || options.app.isPackaged !== true || process.argv.includes('--background-helper')
      || typeof options.checkpoint !== 'function' || typeof run !== 'function' || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw Error();
    const { app, background, directory, vault, checkpoint: activeCheckpoint } = options, signal = options.signal ?? new AbortController().signal;
    checkpoint(activeCheckpoint); signal.throwIfAborted();
    const executable = process.execPath, bundle = dirname(dirname(dirname(executable)));
    if (!bundle.endsWith('/Pipeliner.app') || executable !== join(bundle, 'Contents/MacOS/Pipeliner') || resolve(executable) !== executable
      || typeof directory !== 'string' || resolve(directory) !== directory || directory === bundle
      || directory.startsWith(bundle + '/') || bundle.startsWith(directory + '/')) throw Error();
    const paths = bundlePaths(bundle);
    const stable = (a, b) => custodyKeys.every(key => a[key] === b[key]);
    function inspect(path, index) {
      const value = lstatSync(path, { bigint: true });
      if (realpathSync(path) !== path || value.isSymbolicLink() || ![0n, BigInt(process.getuid())].includes(value.uid) || value.mode & 0o022n
        || (index < 5 ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n) || index === 5 && !(value.mode & 0o111n)) throw Error();
      return value;
    }
    const original = paths.map(inspect), root = lstatSync(directory, { bigint: true });
    function service() { const value = background.inspect(); canonicalJSON(value); record(value, ['qualified', 'status']);
      if (value.qualified !== true || !['not-registered', 'enabled', 'requires-approval', 'not-found'].includes(value.status)) throw Error(); return immutable(value); }
    const capturedService = service(), capturedCredentials = vault.previewCredentialRemoval(), capturedRecords = recordInventory(directory);
    function check() {
      checkpoint(activeCheckpoint); signal.throwIfAborted();
      const current = lstatSync(directory, { bigint: true });
      if (app.isPackaged !== true || process.execPath !== executable || process.argv.includes('--background-helper') || realpathSync(directory) !== directory
        || !current.isDirectory() || current.isSymbolicLink() || current.uid !== BigInt(process.getuid()) || (current.mode & 0o777n) !== 0o700n
        || !['dev', 'ino', 'uid', 'mode'].every(key => root[key] === current[key])
        || paths.some((path, index) => !stable(original[index], inspect(path, index)))
        || canonicalJSON(service()) !== canonicalJSON(capturedService) || canonicalJSON(vault.previewCredentialRemoval()) !== canonicalJSON(capturedCredentials)
        || recordInventory(directory) !== capturedRecords) throw Error();
    }
    check(); const identity = await readBuildIdentity(bundle, { signal }); check();
    const details = (await run('/usr/bin/codesign', ['--display', '--verbose=4', bundle], signal)).stderr; check();
    if (typeof details !== 'string' || Buffer.byteLength(details) > 32768) throw Error();
    const field = name => { const values = [...details.matchAll(new RegExp('^' + name + '=([^\\r\\n]+)$', 'gm'))]; if (values.length !== 1) throw Error(); return values[0][1]; };
    const team = field('TeamIdentifier'), flags = [...details.matchAll(/^CodeDirectory .* flags=0x([a-fA-F0-9]{1,8})\([^\r\n)]*\)/gm)];
    if (!/^[A-Z0-9]{10}$/.test(team) || field('Identifier') !== backgroundBundleId || flags.length !== 1 || !(parseInt(flags[0][1], 16) & 0x10000)) throw Error();
    const requirement = '=anchor apple generic and identifier "' + backgroundBundleId + '" and certificate leaf[subject.OU] = "' + team + '"';
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, bundle], signal); check();
    if (canonicalJSON(await readBuildIdentity(bundle, { signal })) !== canonicalJSON(identity)) throw Error(); check();
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, bundle], signal); check();
    const value = { bundle, identity, team, custody: { device: original[0].dev.toString(), inode: original[0].ino.toString() },
      credentials: capturedCredentials, service: capturedService, recordInventorySha256: capturedRecords };
    checkUninstallPlan(value); return immutable(value);
  } catch { throw Error('uninstall-plan-unavailable'); }
}

// Host-only journal. Native effects and PM authority must be verified by the idle coordinator, never inferred from a phase.
export function openUninstallJournal(directory, { vault, clock = Date.now }) {
  let db;
  try {
    if (typeof clock !== 'function' || realpathSync(directory) !== directory) throw Error();
    const codec = createRecordCodec(vault, 'update'), path = protectedFile(directory, 'uninstall.sqlite');
    const original = lstatSync(path), root = lstatSync(directory);
    if (original.size > 1024 ** 2) throw Error();
    db = new DatabaseSync(path, { allowExtension: false, timeout: 1000 });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version) || !version && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) throw Error();
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;');
    const size = db.prepare('PRAGMA page_size').get().page_size;
    // ponytail: one active intent/latest receipt, 1 MiB database and 16 KiB row; qualify history separately if required.
    if (!Number.isInteger(size) || size < 512 || size > 65536
      || db.prepare('PRAGMA max_page_count=' + Math.floor(1024 ** 2 / size)).get().max_page_count * size > 1024 ** 2
      || db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete' || db.prepare('PRAGMA synchronous').get().synchronous !== 3) throw Error();
    if (!version) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(schema); db.prepare('INSERT INTO uninstall_state VALUES(1,0,0,?)').run(codec.encode(binding, null, { revision: 0, clock: 0 }));
        db.exec('PRAGMA user_version=1; COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error();
    let closed = false, active;
    function readState() {
      if (closed) throw Error();
      const parent = lstatSync(directory), file = lstatSync(path), now = clock();
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== root.dev || parent.ino !== root.ino
        || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory
        || !file.isFile() || file.isSymbolicLink() || file.dev !== original.dev || file.ino !== original.ino
        || file.uid !== process.getuid() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.size > 1024 ** 2
        || db.prepare('PRAGMA user_version').get().user_version !== 1) throw Error();
      const objects = db.prepare("SELECT type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].sql !== schema) throw Error();
      const row = db.prepare('SELECT revision,clock,payload FROM uninstall_state WHERE id=1').get();
      if (!row || !time(row.revision) || !time(row.clock) || !time(now) || now < row.clock) throw Error();
      const value = codec.decode(binding, row.payload, { revision: row.revision, clock: row.clock });
      if (value !== null) intent(value, row); return { value, row, now };
    }
    function guarded(work) { try { return work(); } catch { throw Error('uninstall-state-unavailable'); } }
    function transaction(work) {
      return guarded(() => {
        if (closed) throw Error(); let started = false;
        try {
          db.exec('BEGIN IMMEDIATE'); started = true; const result = work(readState()); db.exec('COMMIT'); started = false; return result;
        } catch (error) {
          if (started) try { db.exec('ROLLBACK'); } catch { closed = true; active = undefined; try { db.close(); } catch { /* Keep recovery denied. */ } }
          throw error;
        }
      });
    }
    function save(state, value) {
      if (state.row.revision === Number.MAX_SAFE_INTEGER) throw Error();
      const revision = state.row.revision + 1, next = { ...value, revision, updatedAt: state.now };
      if (db.prepare('UPDATE uninstall_state SET revision=?,clock=?,payload=? WHERE id=1 AND revision=?')
        .run(revision, state.now, codec.encode(binding, next, { revision, clock: state.now }), state.row.revision).changes !== 1
        || canonicalJSON(readState().value) !== canonicalJSON(next)) throw Error();
      return next;
    }
    function owns(state, token) { return Boolean(token && active?.token === token && state.value?.id === active.id
      && state.row.revision === active.revision && state.value.phase !== 'removed'); }
    function claim(value) { const token = Object.freeze({}); active = { token, id: value.id, revision: value.revision }; return token; }
    readState();
    return Object.freeze({
      read: () => guarded(() => immutable(readState().value)),
      clear() { try { const value = readState().value; return value === null || value.phase === 'removed'; } catch { return false; } },
      owned(token) { try { return owns(readState(), token); } catch { return false; } },
      begin(value) {
        const saved = transaction(state => {
          checkUninstallPlan(value); if (state.value !== null && state.value.phase !== 'removed'
            || canonicalJSON(value.credentials) !== canonicalJSON(vault.previewCredentialRemoval())) throw Error();
          return save(state, { schemaVersion: 1, id: randomUUID(), phase: phases[0], createdAt: state.now, plan: value });
        }); return claim(saved);
      },
      claimRecovery(expected) {
        const saved = transaction(state => {
          canonicalJSON(expected); if (!state.value || state.value.phase === 'removed' || canonicalJSON(expected) !== canonicalJSON(state.value)) throw Error();
          credentials(vault, state.value, state.value.phase, true); return save(state, state.value);
        }); return claim(saved);
      },
      advance(token, phase) {
        const saved = transaction(state => {
          if (!owns(state, token) || phases.indexOf(phase) !== phases.indexOf(state.value.phase) + 1) throw Error();
          credentials(vault, state.value, phase); return save(state, { ...state.value, phase });
        }); active.revision = saved.revision; if (phase === 'removed') active = undefined; return immutable(saved);
      },
      close() { if (!closed) { closed = true; active = undefined; db.close(); } },
    });
  } catch { db?.close(); throw Error('uninstall-state-unavailable'); }
}

// Host-only consumer. Caller holds the idle fence and exact PM authority; callbacks independently verify native effects.
export async function completeUninstall(options) {
  let held;
  try {
    record(options, ['journal', 'vault', 'token', 'checkpoint', 'settle', 'logout', 'removeService', 'trash', 'verify']);
    if (Object.getOwnPropertySymbols(options).length || Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)
      || ['checkpoint', 'settle', 'logout', 'removeService', 'trash', 'verify'].some(name => typeof options[name] !== 'function')) throw Error();
    const { journal, vault, token, checkpoint: activeCheckpoint, settle, logout, removeService, trash, verify } = options;
    let current = journal.read();
    function check() {
      checkpoint(activeCheckpoint);
      if (!journal.owned(token) || canonicalJSON(journal.read()) !== canonicalJSON(current)) throw Error();
      credentials(vault, current, current.phase, true);
    }
    async function verified(stage) { check(); if (await verify(current, stage) !== true) throw Error(); check(); }
    check(); if (consumers.has(journal)) throw Error(); consumers.add(journal); held = journal;
    await verified('before'); check();
    if (await settle() !== true) throw Error(); check();
    const effects = { 'logout-pending': logout, 'service-pending': removeService, 'trash-pending': trash };
    while (current.phase !== 'removed') {
      check();
      if (current.phase === 'credentials-pending') {
        if (canonicalJSON(vault.connectionInventory()) !== canonicalJSON(current.plan.credentials.after)) vault.forgetCredentials(current.plan.credentials.before);
      } else if (await effects[current.phase](current.plan) !== true) throw Error();
      await verified('after');
      current = journal.advance(token, phases[phases.indexOf(current.phase) + 1]);
    }
    return immutable(current);
  } catch { throw Error('uninstall-recovery-required'); }
  finally { if (held) consumers.delete(held); }
}

// Host-only native consumer. Exact PM/token/idle authority and managed account readback belong to the caller.
export async function completeMacUninstall(options, { run = runMacUpdateCommand } = {}) {
  try {
    record(options, ['app', 'background', 'directory', 'vault', 'journal', 'token', 'checkpoint', 'settle', 'logout', 'verifyLogout', 'shell'], ['signal']);
    if (Object.getOwnPropertySymbols(options).length || Object.values(Object.getOwnPropertyDescriptors(options)).some(value => value.get || value.set)
      || ['checkpoint', 'settle', 'logout', 'verifyLogout'].some(name => typeof options[name] !== 'function')
      || typeof options.background?.unregister !== 'function' || typeof options.shell?.trashItem !== 'function'
      || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw Error();
    const { app, background, directory, vault, journal, token, checkpoint: activeCheckpoint, settle, logout, verifyLogout, shell } = options;
    const signal = options.signal ?? new AbortController().signal, executable = process.execPath;
    checkpoint(activeCheckpoint); signal.throwIfAborted();
    if (app.isPackaged !== true || process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.includes('--background-helper')
      || journal.read()?.phase !== 'logout-pending' || journal.owned(token) !== true) throw Error();
    const root = lstatSync(directory, { bigint: true }), paths = bundlePaths(journal.read().plan.bundle), original = paths.map(path => lstatSync(path, { bigint: true }));
    const trashItem = shell.trashItem.bind(shell), unregister = background.unregister.bind(background); let moved = false, trashing = false;
    function check() {
      checkpoint(activeCheckpoint); signal.throwIfAborted();
      const current = lstatSync(directory, { bigint: true });
      if (app.isPackaged !== true || process.execPath !== executable || process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.includes('--background-helper')
        || realpathSync(directory) !== directory || !current.isDirectory() || current.isSymbolicLink() || current.uid !== BigInt(process.getuid())
        || (current.mode & 0o777n) !== 0o700n || !['dev', 'ino', 'uid', 'mode'].every(key => root[key] === current[key])) throw Error();
      if (!moved && !trashing && paths.some((path, index) => { const current = lstatSync(path, { bigint: true });
        return !custodyKeys.every(key => current[key] === original[index][key]); })) throw Error();
    }
    function retained(saved) {
      check(); const service = background.inspect();
      canonicalJSON(service); record(service, ['qualified', 'status']);
      if (service.qualified !== true || service.status !== 'not-registered'
        || canonicalJSON(vault.connectionInventory()) !== canonicalJSON(saved.credentials.after)
        || recordInventory(directory) !== saved.recordInventorySha256) throw Error();
    }
    function absent(bundle) { try { lstatSync(bundle); } catch (error) { if (error.code === 'ENOENT') return; throw error; } throw Error(); }
    async function verify(intent, stage) {
      check(); const saved = intent.plan;
      if (moved) {
        if (intent.phase !== 'trash-pending' || stage !== 'after') throw Error();
        absent(saved.bundle); retained(saved); return true;
      }
      const afterCredentials = intent.phase === 'trash-pending' || intent.phase === 'credentials-pending' && stage === 'after';
      const afterService = afterCredentials || intent.phase === 'credentials-pending' || intent.phase === 'service-pending' && stage === 'after';
      if ((intent.phase !== 'logout-pending' || stage === 'after') && await verifyLogout(signal) !== true) throw Error(); check();
      const current = await captureMacUninstallPlan({ app, background, directory, vault, checkpoint: check, signal }, { run }); check();
      if (['bundle', 'identity', 'team', 'custody', 'recordInventorySha256'].some(key => canonicalJSON(current[key]) !== canonicalJSON(saved[key]))
        || canonicalJSON(current.service) !== canonicalJSON(afterService ? { qualified: true, status: 'not-registered' } : saved.service)
        || canonicalJSON(current.credentials.before) !== canonicalJSON(afterCredentials ? saved.credentials.after : saved.credentials.before)) throw Error();
      return true;
    }
    // Interrupted effects require a separate explicit recovery consumer; this path never infers their completion.
    return await completeUninstall({ journal, vault, token, checkpoint: check, settle,
      async logout() { await verify(journal.read(), 'before'); check(); await logout(signal); check(); return await verifyLogout(signal) === true; },
      async removeService() { await verify(journal.read(), 'before'); check(); await unregister(); check(); const service = background.inspect(); return service.qualified === true && service.status === 'not-registered'; },
      async trash(saved) {
        await verify(journal.read(), 'before'); check();
        trashing = true;
        try {
          if (await trashItem(saved.bundle) !== undefined) throw Error(); check();
          absent(saved.bundle); retained(saved); moved = true; return true;
        } finally { trashing = false; }
      }, verify });
  } catch { throw Error('uninstall-recovery-required'); }
}
