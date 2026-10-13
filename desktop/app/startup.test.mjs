import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, mkdirSync, lstatSync, rmdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url), source = readFileSync(new URL('./main.cjs',import.meta.url),'utf8');
const testStorage = require('../test-storage.cjs');
test('host update replacement retains one exact restart target and refuses foreign or unowned completion', async () => {
  const start = source.indexOf('  const makeUpdates = initialRevision =>'), end = source.indexOf('  updates = makeUpdates(1);', start);
  for (const mode of ['normal', 'source', 'background', 'closing', 'lease', 'token', 'phase', 'foreign-path', 'foreign-build']) {
    const token = Object.freeze({}), identity = Object.freeze({ kind: 'pipeliner-desktop-build', schemaVersion: 1,
      sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.2.0', platform: 'darwin', architecture: 'arm64' });
    const result = Object.freeze({ installed: '/private/Pipeliner.app', rollback: '/private/data/updates/candidate/Pipeliner.app', identity });
    let captured, replacements = 0, restarts = 0; const queued = [];
    const context = { policy: {}, updateHistory: {}, trustedUpdateSources: [], maintenance: { active: () => mode !== 'lease' },
      app: { isPackaged: mode !== 'source', getVersion: () => '0.1.0' }, backgroundLaunch: mode === 'background', closing: mode === 'closing', restartTarget: null,
      maintenanceStore: { owned: value => mode !== 'token' && value === token,
        async replaceBundle(value, options) { assert.equal(value, token); assert.equal(options.history, context.updateHistory); options.checkpoint(); replacements++; return result; },
        read: () => ({ phase: mode === 'phase' ? 'replacing' : 'relaunching', to: identity,
          copy: { installed: { bundle: result.installed, team: 'ABCDEFGHIJ' }, receipt: { bundle: result.rollback } } }) },
      path: require('node:path'), process: { execPath: '/private/Pipeliner.app/Contents/MacOS/Pipeliner' },
      setImmediate: fn => queued.push(fn), requestShutdown: async () => { restarts++; },
      createUpdateManager: value => { captured = value; return {}; }, maintenanceRecovery: () => false, publishUpdates() {} };
    runInNewContext(`${source.slice(start, end)}\nmakeUpdates(1);`, context, { timeout: 1000 });
    assert.equal(typeof captured.replaceInstaller, 'function'); assert.equal(typeof captured.onInstalled, 'function');
    const options = { trust: {}, current: {}, checkpoint() {}, signal: new AbortController().signal };
    if (['source', 'background', 'closing', 'lease', 'token'].includes(mode)) {
      await assert.rejects(captured.replaceInstaller(token, options)); assert.equal(replacements, 0); continue;
    }
    assert.equal(await captured.replaceInstaller(token, options), result); assert.equal(replacements, 1);
    context.maintenance.active = () => false;
    const supplied = mode === 'foreign-path' ? { ...result, installed: '/private/other/Pipeliner.app' }
      : mode === 'foreign-build' ? { ...result, identity: { ...identity, sourceCommit: 'c'.repeat(40) } } : result;
    if (mode !== 'normal') { assert.throws(() => captured.onInstalled(supplied)); assert.equal(context.restartTarget, null); assert.equal(queued.length, 0); }
    else {
      captured.onInstalled(supplied); assert.equal(queued.length, 1); assert.equal(restarts, 0);
      assert.deepEqual(JSON.parse(JSON.stringify(context.restartTarget)), { bundle: result.installed, team: 'ABCDEFGHIJ', identity });
      assert.throws(() => captured.onInstalled(supplied)); queued[0](); assert.equal(restarts, 1);
    }
  }
});
test('host rollback captures one matching completion and rechecks the running build before journal preparation', async () => {
  const start = source.indexOf('  const makeUpdates = initialRevision =>'), end = source.indexOf('  updates = makeUpdates(1);', start);
  for (const mode of ['normal', 'source', 'background', 'closing', 'lease', 'recovery', 'missing', 'duplicate', 'rollback', 'changed', 'foreign', 'cancelled']) {
    let captured, prepared = 0, swapped = 0, changed = false;
    const identity = Object.freeze({ kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.2.0', platform: 'darwin', architecture: 'arm64' });
    const target = Object.freeze({ ...identity, version: '0.1.0' }), token = Object.freeze({}), signal = new AbortController().signal;
    const previous = { intent: { id: '12345678-1234-1234-1234-123456789012', to: identity, from: target,
      ...(mode === 'rollback' ? { rollback: {} } : {}), copy: { installed: { bundle: mode === 'foreign' ? '/private/other/Pipeliner.app' : '/private/Pipeliner.app' } } } };
    const checkpoint = () => { if (mode === 'cancelled') throw Error('Synthetic cancellation'); };
    const context = { policy: {}, updateHistory: {}, trustedUpdateSources: [], maintenance: { active: () => mode !== 'lease' },
      app: { isPackaged: mode !== 'source', getVersion: () => identity.version }, backgroundLaunch: mode === 'background', closing: mode === 'closing',
      maintenanceStore: { clear: () => mode !== 'recovery', completed: () => mode === 'missing' ? [] : mode === 'duplicate' ? [previous, previous] : [previous],
        owned: value => value === token, read: () => ({ rollback: { id: previous.intent.id } }),
        async replaceBundle(value, options) { assert.equal(value, token); assert.deepEqual(Object.keys(options).sort(), ['checkpoint', 'signal']); swapped++; return {}; },
        async prepareRollback(options) {
          assert.equal(options.id, previous.intent.id); assert.equal(options.running.bundle, '/private/Pipeliner.app');
          assert.equal(options.running.identity, identity); assert.equal(options.checkpoint, checkpoint); assert.equal(options.signal, signal); prepared++; return token;
        } },
      moduleAt: async name => { assert.equal(name, '../package/build.mjs'); return { readBuildIdentity: async () => changed ? { ...identity, gitTree: 'c'.repeat(40) } : identity }; },
      path: require('node:path'), process: { execPath: '/private/Pipeliner.app/Contents/MacOS/Pipeliner' },
      createUpdateManager: value => { captured = value; return {}; }, maintenanceRecovery: () => false, publishUpdates() {} };
    runInNewContext(`${source.slice(start, end)}\nmakeUpdates(1);`, context, { timeout: 1000 });
    assert.equal(captured.rollbackQualified, undefined); assert.equal(captured.installerQualified, undefined);
    if (['source', 'background', 'closing', 'lease', 'recovery', 'cancelled'].includes(mode)) {
      await assert.rejects(captured.inspectRollback({ checkpoint, signal }));
      await assert.rejects(captured.prepareRollback({ plan: {}, checkpoint, signal, onIntent() {} })); assert.equal(prepared, 0); continue;
    }
    const plan = await captured.inspectRollback({ checkpoint, signal });
    if (['missing', 'duplicate', 'rollback', 'foreign'].includes(mode)) { assert.equal(plan, null); assert.equal(prepared, 0); continue; }
    assert.equal(plan.id, previous.intent.id); assert.equal(plan.target, target); assert.equal(Object.isFrozen(plan), true);
    if (mode === 'changed') changed = true;
    const operation = captured.prepareRollback({ plan, checkpoint, signal, onIntent() {} });
    if (changed) { await assert.rejects(operation); assert.equal(prepared, 0); }
    else { assert.equal(await operation, token); assert.equal(prepared, 1); await captured.replaceInstaller(token, { checkpoint, signal }); assert.equal(swapped, 1); }
  }
});

test('update restart follows closed stores and fresh native verification without reusing startup arguments', async () => {
  const start = source.indexOf('  requestShutdown = async () =>'), end = source.indexOf('  Menu.setApplicationMenu', start);
  assert.ok(start >= 0 && end > start);
  for (const mode of ['normal', 'shutdown-refusal', 'native-refusal', 'relaunch-refusal', 'ordinary']) {
    const events = [], target = Object.freeze({ bundle: '/private/Pipeliner.app', team: 'ABCDEFGHIJ', identity: Object.freeze({ synthetic: true }) });
    const context = { closing: false, verifiedClose: false, shutdownPaused: false, restartTarget: mode === 'ordinary' ? null : target,
      authorizationMonitor: null, retentionMonitor: null, clearInterval() {}, phase() {}, suspendHost() {}, wakeHost() {}, endSession() {}, path: require('node:path'),
      powerMonitor: { removeListener() {} }, console: { error() { events.push('error'); } }, publish() {}, attachWindow: async () => {},
      AbortController, app: { relaunch(options) { events.push('relaunch'); assert.deepEqual(JSON.parse(JSON.stringify(options)), { execPath: '/private/Pipeliner.app/Contents/MacOS/Pipeliner', args: [] });
        if (mode === 'relaunch-refusal') throw Error('Synthetic relaunch refusal'); }, quit() { events.push('quit'); } },
      moduleAt: async name => { assert.equal(name, '../updates/mac.mjs'); return { verifyMacUpdateBundle: async value => {
        assert.equal(value, target); assert.equal(events.includes('vault'), true); assert.equal(context.verifiedClose, false);
        events.push('native'); if (mode === 'native-refusal') throw Error('Synthetic native refusal');
      } }; } };
    for (const name of ['updates', 'development', 'issues', 'workspaces', 'manager', 'scheduler', 'tools', 'toolConnections', 'privacy', 'privacyRecords', 'permissions',
      'updateHistory', 'uninstallJournal', 'maintenanceStore', 'delivery', 'artifacts', 'backgroundHost', 'background', 'scheduling', 'pipelines', 'skills', 'appearance',
      'developmentStore', 'policy', 'skillStore', 'toolStore', 'workspaceStore', 'vault']) context[name] = {
        async stop() {}, suspend() {}, status: () => ({}), close() { events.push(name); if (mode === 'shutdown-refusal' && name === 'development') throw Error('Synthetic close refusal'); }
      };
    runInNewContext(source.slice(start, end), context, { timeout: 1000 });
    await context.requestShutdown();
    assert.equal(events.includes('relaunch'), ['normal', 'relaunch-refusal'].includes(mode));
    assert.equal(events.includes('quit'), mode !== 'shutdown-refusal');
    assert.equal(events.includes('native'), !['shutdown-refusal', 'ordinary'].includes(mode));
    assert.equal(context.verifiedClose, mode !== 'shutdown-refusal');
    if (mode !== 'shutdown-refusal') { const length = events.length; await context.requestShutdown(); assert.equal(events.length, length); }
    else assert.equal(context.restartTarget, null);
  }
});
test('maintenance and completed removal block wake before and after native settlement', async () => {
  const blocked = source.match(/^  const hostMaintenanceBlocked = (.+);$/m)?.[1], wake = source.match(/^  const wakeHost = (.+);$/m)?.[1];
  assert.ok(blocked && wake); let release;
  const events = [], context = { closing: false, removalFinished: false, active: false, recovery: false,
    maintenance: { active: () => context.active }, maintenanceRecovery: () => context.recovery,
    backgroundHost: { async wake() { events.push('native'); await new Promise(resolve => { release = resolve; }); }, executionAllowed: () => true },
    scheduler: { async wake() { events.push('scheduler'); } } };
  runInNewContext(`globalThis.hostMaintenanceBlocked = ${blocked}; globalThis.wake = ${wake};`, context, { timeout: 1000 });
  for (const key of ['closing', 'removalFinished', 'active', 'recovery']) {
    context[key] = true; assert.equal(context.hostMaintenanceBlocked(), true); context.wake(); assert.deepEqual(events, []); context[key] = false;
  }
  assert.equal(context.hostMaintenanceBlocked(), false); context.wake(); assert.deepEqual(events, ['native']);
  context.removalFinished = true; release(); await new Promise(setImmediate); assert.deepEqual(events, ['native']);
  context.removalFinished = false; context.wake(); release(); await new Promise(setImmediate); assert.deepEqual(events, ['native', 'native', 'scheduler']);
});
test('cold native maintenance requires unopened ordinary stores and its captured inspection handle', async () => {
  const start = source.indexOf('  maintenance = createMaintenanceGate('), end = source.indexOf('  const executionAllowed =', start);
  assert.ok(start >= 0 && end > start);
  let options, inspections = 0;
  const signal = new AbortController().signal, context = { maintenanceRecovery: () => true, closing: false, app: { isPackaged: true }, backgroundLaunch: false,
    maintenanceUnavailable: false, vault: {}, recoveryWork: { verifyIdle(value) { assert.equal(value, signal); inspections++; return true; } }, uninstallJournal: {},
    maintenanceStore: { clear: () => true }, workspaceStore: null, policy: null, developmentStore: null, supervisor: null, scheduler: null, backgroundHost: null, privacyRecords: null,
    createMaintenanceGate(value) { options = value; return {}; } };
  runInNewContext(source.slice(start, end), context, { timeout: 1000 });
  assert.equal(options.recoveryReady(), true); assert.equal(await options.verifyRecovery(signal), true); assert.equal(inspections, 1);
  for (const key of ['workspaceStore', 'policy', 'developmentStore', 'supervisor', 'scheduler', 'backgroundHost', 'privacyRecords']) {
    context[key] = {}; assert.equal(options.recoveryReady(), false, key); context[key] = null;
  }
  for (const key of ['closing', 'backgroundLaunch', 'maintenanceUnavailable']) { context[key] = true; assert.equal(options.recoveryReady(), false, key); context[key] = false; }
  for (const key of ['vault', 'recoveryWork', 'uninstallJournal']) { const saved = context[key]; context[key] = null; assert.equal(options.recoveryReady(), false, key); context[key] = saved; }
  context.app.isPackaged = false; assert.equal(options.recoveryReady(), false); context.app.isPackaged = true;
  context.maintenanceStore.clear = () => false; assert.equal(options.recoveryReady(), false);
});
test('host removal execution binds native consumers, preserves ordinary stores and releases cold recovery custody', async () => {
  const start = source.indexOf('  const runRemoval = async'), end = source.indexOf('  const makeUpdates =', start);
  assert.ok(start >= 0 && end > start);
  for (const mode of ['normal', 'cold', 'capture-failed', 'cleanup-failed', 'native-failed', 'source', 'background']) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-removal-host-'))), events = [], signal = new AbortController().signal;
    const cold = ['cold', 'capture-failed', 'cleanup-failed'].includes(mode), token = Object.freeze({}), plan = Object.freeze({ synthetic: true });
    const context = { app: { isPackaged: mode !== 'source' }, backgroundLaunch: mode === 'background', closing: false, maintenanceUnavailable: false,
      directory, vault: {}, uninstallJournal: { read: () => ({ synthetic: true }) }, maintenanceStore: { clear: () => true }, maintenance: {}, recoveryWork: null, removalFinished: false,
      policy: cold ? null : {}, workspaceStore: cold ? null : {}, developmentStore: cold ? null : {}, supervisor: cold ? null : {},
      backgroundNative: {}, shell: {}, path: require('node:path'), mkdirSync, lstatSync, realpathSync, rmdirSync, process,
      manager: { async close() { events.push('connections'); } }, toolConnections: { async close() { events.push('tools'); } },
      adapters: { codex: { async disconnect(value) { assert.equal(value.signal, signal); events.push('logout'); }, async verifyDisconnected(value) { assert.equal(value.signal, signal); events.push('readback'); return true; } } },
      moduleAt: async name => {
        if (name === '../core/execution.mjs') return { captureRecoveryWork(root, options) {
          assert.equal(root, directory); assert.equal(options.vault, context.vault); options.checkpoint(); events.push('capture');
          if (mode === 'capture-failed') throw Error('Synthetic capture refusal');
          return { verify() { events.push('verify'); return true; }, close() { events.push('release'); if (mode === 'cleanup-failed') throw Error('Synthetic close refusal'); } };
        } };
        assert.equal(name, '../updates/uninstall.mjs');
        return { async coordinateUninstall(options) {
          options.checkpoint(); assert.equal(options.journal, context.uninstallJournal); assert.equal(options.maintenance, context.maintenance);
          assert.equal(options.plan, cold ? null : plan); assert.equal(options.signal, signal);
          if (cold) assert.ok(context.recoveryWork);
          await options.consume({ token, checkpoint: options.checkpoint, signal, recovering: cold }); return true;
        }, completeMacUninstall: consume, recoverMacUninstall: consume };
      }
    };
    async function consume(options) {
      events.push('consume'); assert.equal(options.app, context.app); assert.equal(options.background, context.backgroundNative); assert.equal(options.directory, directory);
      assert.equal(options.vault, context.vault); assert.equal(options.journal, context.uninstallJournal); assert.equal(options.token, token); assert.equal(options.shell, context.shell);
      options.checkpoint(); assert.equal(await options.settle(), true); await options.logout(signal); assert.equal(await options.verifyLogout(signal), true);
      if (mode === 'native-failed') throw Error('Synthetic native refusal'); return { phase: 'removed' };
    }
    try {
      runInNewContext(`${source.slice(start, end)}\nglobalThis.run = runRemoval;`, context, { timeout: 1000 });
      const operation = context.run({ ...(cold ? {} : { plan }), signal, checkpoint() {} });
      if (['normal', 'cold'].includes(mode)) assert.equal(await operation, true); else await assert.rejects(operation);
      assert.equal(context.removalFinished, ['normal', 'cold'].includes(mode));
      assert.equal(context.maintenanceUnavailable, mode === 'cleanup-failed');
      if (mode !== 'cleanup-failed') assert.equal(context.recoveryWork, null); assert.equal(existsSync(join(directory, 'maintenance-recovery-work')), false);
      if (mode === 'cold') { assert.ok(events.indexOf('capture') < events.indexOf('consume')); assert.equal(events.at(-1), 'release'); }
      if (['source', 'background'].includes(mode)) assert.deepEqual(events, []);
      if (['normal', 'cold', 'native-failed'].includes(mode)) assert.deepEqual(events.filter(value => ['connections', 'tools', 'logout', 'readback'].includes(value)), ['connections', 'tools', 'logout', 'readback']);
    } finally { rmSync(directory, { recursive: true }); assert.equal(existsSync(directory), false); }
  }
});
test('host maintenance fence blocks pending or unreadable uninstall state and partial store initialization', () => {
  const expression = source.match(/^  const maintenanceRecovery = (.+);$/m)?.[1]; assert.ok(expression);
  for (const mode of ['ready', 'update', 'uninstall', 'unreadable', 'partial']) {
    const context = { maintenanceUnavailable: mode === 'partial', maintenanceStore: { clear: () => mode !== 'update' },
      uninstallJournal: mode === 'partial' ? null : { clear() { if (mode === 'unreadable') throw Error('Synthetic unreadable state'); return mode !== 'uninstall'; } } };
    assert.equal(runInNewContext(`(${expression})()`, context, { timeout: 1000 }), mode !== 'ready');
  }
});
test('pending startup recovery stops before normal stores can create missing data; only verified packaged foreground proceeds', async () => {
  const start = source.indexOf('    if (app.isPackaged && !backgroundLaunch && maintenanceStore'), end = source.indexOf('    const initialRevision = manager.status().revision + 1;', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  for (const mode of ['source', 'background', 'unavailable', 'uninstall', 'refused', 'cancelled', 'verified', 'clear']) {
    let pending = mode !== 'clear', finished = 0, continued = 0, published = 0;
    const store = mode === 'unavailable' ? null : { clear: () => !pending, async finishRelaunch(options) {
      finished++; assert.equal(options.running.bundle, '/private/Pipeliner.app'); options.checkpoint();
      if (mode !== 'verified') throw Error('Synthetic native refusal'); pending = false;
    } };
    const context = { app: { isPackaged: mode !== 'source' }, backgroundLaunch: mode === 'background', maintenanceStore: store,
      uninstallJournal: { clear: () => mode !== 'uninstall' },
      maintenanceRecovery: () => pending, moduleAt: async () => ({ readBuildIdentity: async () => ({ synthetic: true }) }),
      path: require('node:path'), process: { execPath: '/private/Pipeliner.app/Contents/MacOS/Pipeliner' }, closing: mode === 'cancelled', AbortController,
      updates: { sync() {}, status: () => ({ recoveryRequired: pending }) }, publishUpdates(status) { assert.equal(status.recoveryRequired, true); published++; },
      console: { error() {} }, continueStartup() { continued++; } };
    await runInNewContext(`(async function(){${block}\ncontinueStartup();})();`, context, { timeout: 1000 });
    assert.equal(continued, ['verified', 'clear'].includes(mode) ? 1 : 0);
    assert.equal(published, continued ? 0 : 1);
    assert.equal(finished, ['refused', 'cancelled', 'verified'].includes(mode) ? 1 : 0);
  }
});
function entry(packaged, args, storageAvailable = true) {
  const calls = [];
  const app = { isPackaged:packaged, getPath(name) { calls.push(['getPath',name]); return '/private/synthetic-app-data'; },
    setName(name) { calls.push(['setName',name]); }, setPath(...values) { calls.push(['setPath',...values]); },
    requestSingleInstanceLock() { calls.push(['lock']); return true; }, whenReady() { calls.push(['ready']); return {then(){return {catch(){}};}}; }, on(){},
    exit(code) { throw new Error('captured-exit-' + code); } };
  const context = { require:name=> {
    if (name === 'electron') return {app,protocol:{registerSchemesAsPrivileged(){calls.push(['protocol']);}}};
    if (name === 'node:fs') return { ...require(name), readFileSync(file) {
      assert.equal(file, '/private/owned-run/manifest.json'); calls.push(['manifest']); return '{}';
    } };
    if (name === '../test-storage.cjs') {
      if (packaged) throw new Error('packaged-developer-dependency');
      return { ...testStorage, qualificationContext() {
        calls.push(['storage']); if (!storageAvailable) throw new Error('test-storage-run-required');
        return {run_path:'/private/owned-run',paths:{tmp:'/private/owned-test'}};
      }, validateOwnedDataDirectory(_storage, directory) {calls.push(['owned',directory]);},
      qualificationEnvironment() {calls.push(['chromium']);if(storageAvailable==='foreign-ipc') throw new Error('test-storage-chromium-context');},
      configureOwnedPaths(_app,_storage,directory) {
        assert.ok(!calls.some(call=>call[0]==='ready'));
        calls.push(['setPath','userData',directory]);
      } };
    }
    return require(name);
  },
    process:{argv:['/private/package/Pipeliner',...args],resourcesPath:'/private/package/Resources',on(){}},performance:{now:()=>0},console:{error(...values){calls.push(['error',...values]);}},__dirname:'/private/package/Resources/app' };
  return {calls,run:()=>runInNewContext(`(function(){${source}\n})();`,context,{timeout:1000})};
}
test('host update preparation captures only the running packaged build and binds private journal ownership', async () => {
  const start = source.indexOf('  const makeUpdates = initialRevision =>'), end = source.indexOf('  updates = makeUpdates(1);', start);
  assert.ok(start >= 0 && end > start);
  for (const mode of ['normal', 'source', 'background', 'cancelled', 'duplicate-team', 'native-refused']) {
    const token = Object.freeze({}), signal = new AbortController().signal, trust = Object.freeze({ synthetic: true }), current = Object.freeze({ synthetic: true });
    let held = true, nativeCalls = 0, prepared = 0, captured;
    const build = Object.freeze({ kind: 'synthetic-build' }), checkpoint = () => { if (mode === 'cancelled') throw Error('Synthetic cancelled host'); }, onIntent = () => {};
    const context = { policy: {}, updateHistory: {}, trustedUpdateSources: [], maintenance: { active: () => held },
      maintenanceStore: { owned: candidate => candidate === token,
        read: () => ({ phase: 'repair-required', from: { version: '0.1.0' }, to: { version: '0.2.0' }, installer: { file: '/private/retained.dmg' },
          backups: { databases: [{}, {}, {}] }, copy: { receipt: { bundle: '/private/candidate.app' } }, replacement: {} }), async prepare(options) {
        prepared++; assert.deepEqual(JSON.parse(JSON.stringify(options.installed)), { bundle: '/private/Pipeliner.app', identity: build, team: 'ABCDEFGHIJ' });
        assert.equal(options.history, context.updateHistory); assert.equal(options.trust, trust); assert.equal(options.current, current);
        assert.equal(options.signal, signal); assert.equal(options.onIntent, onIntent); assert.equal(options.checkpoint, checkpoint);
        assert.equal(options.maxBytes, 8 * 1024 ** 3); assert.equal(options.reserveBytes, 16 * 1024 ** 3); assert.equal(options.timeoutMs, 1800000);
        if (mode === 'native-refused') throw Error('update-native-trust-unverified'); return token;
      } }, app: { isPackaged: mode !== 'source', getVersion: () => '0.1.0' }, backgroundLaunch: mode === 'background',
      moduleAt: async name => {
        if (name === '../package/build.mjs') return { readBuildIdentity: async (bundle, options) => {
          assert.equal(bundle, '/private/Pipeliner.app'); assert.equal(options.signal, signal); return build;
        } };
        assert.equal(name, '../updates/mac.mjs'); return { runMacUpdateCommand: async (file, args, candidate) => {
          nativeCalls++; assert.equal(file, '/usr/bin/codesign'); assert.deepEqual([...args], ['--display', '--verbose=4', '/private/Pipeliner.app']); assert.equal(candidate, signal);
          return { stderr: 'TeamIdentifier=ABCDEFGHIJ\n' + (mode === 'duplicate-team' ? 'TeamIdentifier=ABCDEFGHIJ\n' : '') };
        } };
      }, path: require('node:path'), process: { execPath: '/private/Pipeliner.app/Contents/MacOS/Pipeliner' },
      createUpdateManager(options) { captured = options; return {}; }, maintenanceRecovery: () => false, publishUpdates() {} };
    runInNewContext(`${source.slice(start, end)}\nmakeUpdates(1);`, context, { timeout: 1000 });
    assert.deepEqual(JSON.parse(JSON.stringify(captured.recoveryDetails())), { phase: 'repair-required', fromVersion: '0.1.0', toVersion: '0.2.0',
      installerRecorded: true, backupsRecorded: 3, candidateRecorded: true, replacementRecorded: true });
    assert.equal(captured.ownsIntent(token), true); assert.equal(captured.ownsIntent({}), false); held = false; assert.equal(captured.ownsIntent(token), false); held = true;
    const invoke = () => captured.prepareInstaller({ trust, current, checkpoint, signal, onIntent });
    if (mode === 'normal') assert.equal(await invoke(), token); else await assert.rejects(invoke());
    assert.equal(prepared, ['normal', 'native-refused'].includes(mode) ? 1 : 0);
    assert.equal(nativeCalls, ['normal', 'native-refused', 'duplicate-team'].includes(mode) ? 1 : 0);
  }
});
test('Packaged entry rejects development authority inputs before initialization; source startup remains usable',()=>{
  for(const argument of ['--qualify','--qualify-tools','--qualify-workload-profile','--qualify=1','--QUALIFY','--test-data-directory=/private/foreign','--test-data-directory','--TEST-DATA-DIRECTORY=/private/foreign','--data-directory=/private/foreign','--data-directory','--key-helper=/private/foreign','--key-helper','--calendar-helper=/private/foreign','--calendar-helper']) {
    const fixture=entry(true,[argument]);assert.throws(fixture.run,/captured-exit-2/);assert.deepEqual(fixture.calls,[['error','Pipeliner rejected an unsupported packaged startup option.']]);
  }
  for(const args of [[],['--background-helper']]) {
    const fixture=entry(true,args);fixture.run();assert.ok(fixture.calls.some(call=>call[0]==='ready'));
    assert.ok(fixture.calls.some(call=>call[0]==='setPath'&&call[1]==='userData'&&call[2]==='/private/synthetic-app-data/Pipeliner'));
  }
  const sourceFixture=entry(false,['--qualify','--data-directory=/private/owned-test','--key-helper=/private/owned-key','--calendar-helper=/private/owned-calendar']);
  sourceFixture.run();assert.ok(sourceFixture.calls.some(call=>call[0]==='ready'));
  assert.ok(sourceFixture.calls.findIndex(call=>call[0]==='storage') < sourceFixture.calls.findIndex(call=>call[0]==='lock'));
  assert.ok(sourceFixture.calls.some(call=>call[0]==='setPath'&&call[1]==='userData'&&call[2]==='/private/owned-test'));
  assert.ok(sourceFixture.calls.findIndex(call=>call[0]==='owned') < sourceFixture.calls.findIndex(call=>call[0]==='setName'));
  assert.ok(sourceFixture.calls.findIndex(call=>call[0]==='chromium') < sourceFixture.calls.findIndex(call=>call[0]==='lock'));
  const denied=entry(false,['--qualify','--test-data-directory=/private/owned-test'],false);
  assert.throws(denied.run,/test-storage-run-required/);assert.deepEqual(denied.calls,[['storage']]);
  const foreignIpc=entry(false,['--qualify','--test-data-directory=/private/owned-test'],'foreign-ipc');
  assert.throws(foreignIpc.run,/test-storage-chromium-context/);assert.deepEqual(foreignIpc.calls,[['storage'],['chromium']]);
});

test('host removal inspection binds actual app storage and exposes only recorded recovery details', async () => {
  const start = source.indexOf('  const makeUpdates = initialRevision =>'), end = source.indexOf('  updates = makeUpdates(1);', start);
  assert.ok(start >= 0 && end > start);
  for (const mode of ['normal', 'source', 'background', 'vault', 'uninstall', 'update', 'cancelled']) {
    let captured, inspected = 0, checkpoints = 0;
    const plan = Object.freeze({ synthetic: true }), signal = new AbortController().signal;
    const checkpoint = () => { checkpoints++; if (mode === 'cancelled') throw Error('Synthetic cancelled capture'); };
    const saved = { phase: 'service-pending', plan: { identity: { version: '0.1.0' }, credentials: { before: { stored: 2 } }, service: { status: 'enabled' }, bundle: '/private/secret-bundle' } };
    const context = { policy: {}, updateHistory: {}, trustedUpdateSources: [], maintenance: {}, maintenanceStore: { clear: () => mode !== 'update' },
      uninstallJournal: { clear: () => mode !== 'uninstall', read: () => saved }, vault: mode === 'vault' ? null : {}, directory: '/private/synthetic-data',
      backgroundNative: {}, app: { isPackaged: mode !== 'source', getVersion: () => '0.1.0' }, backgroundLaunch: mode === 'background',
      moduleAt: async name => { assert.equal(name, '../updates/uninstall.mjs'); return { async captureMacUninstallPlan(options) {
        inspected++; assert.equal(options.app, context.app); assert.equal(options.background, context.backgroundNative);
        assert.equal(options.directory, context.directory); assert.equal(options.vault, context.vault); assert.equal(options.checkpoint, checkpoint); assert.equal(options.signal, signal);
        assert.deepEqual(Object.keys(options).sort(), ['app', 'background', 'checkpoint', 'directory', 'signal', 'vault']); return plan;
      } }; }, createUpdateManager(options) { captured = options; return {}; }, maintenanceRecovery: () => false, publishUpdates() {} };
    runInNewContext(`${source.slice(start, end)}\nmakeUpdates(1);`, context, { timeout: 1000 });
    assert.deepEqual(JSON.parse(JSON.stringify(captured.removalDetails())), { phase: 'service-pending', version: '0.1.0', credentialCount: 2, backgroundStatus: 'enabled' });
    assert.doesNotMatch(JSON.stringify(captured.removalDetails()), /private|secret-bundle/);
    if (mode === 'normal') assert.equal(await captured.inspectRemoval({ checkpoint, signal }), plan);
    else await assert.rejects(captured.inspectRemoval({ checkpoint, signal }));
    assert.equal(inspected, mode === 'normal' ? 1 : 0); assert.equal(checkpoints, mode === 'normal' ? 2 : mode === 'cancelled' ? 1 : 0);
  }
});
