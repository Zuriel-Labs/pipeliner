import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url), source = readFileSync(new URL('./main.cjs',import.meta.url),'utf8');
const testStorage = require('../test-storage.cjs');
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
      return { ...testStorage, validateContext() {
        calls.push(['storage']); if (!storageAvailable) throw new Error('test-storage-run-required');
        return {run_path:'/private/owned-run',paths:{tmp:'/private/owned-test'}};
      }, validateOwnedDataDirectory(_storage, directory) {calls.push(['owned',directory]);},
      nativeTestEnvironment() {calls.push(['chromium']);if(storageAvailable==='foreign-ipc') throw new Error('test-storage-chromium-context');},
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
  assert.ok(sourceFixture.calls.findIndex(call=>call[0]==='manifest') < sourceFixture.calls.findIndex(call=>call[0]==='lock'));
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
