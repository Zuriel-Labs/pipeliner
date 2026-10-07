import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url), source = readFileSync(new URL('./main.cjs',import.meta.url),'utf8');
const testStorage = require('../test-storage.cjs');
test('pending startup recovery stops before normal stores can create missing data; only verified packaged foreground proceeds', async () => {
  const start = source.indexOf('    if (app.isPackaged && !backgroundLaunch && maintenanceStore'), end = source.indexOf('    const initialRevision = manager.status().revision + 1;', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  for (const mode of ['source', 'background', 'unavailable', 'refused', 'cancelled', 'verified', 'clear']) {
    let pending = mode !== 'clear', finished = 0, continued = 0, published = 0;
    const store = mode === 'unavailable' ? null : { clear: () => !pending, async finishRelaunch(options) {
      finished++; assert.equal(options.running.bundle, '/private/Pipeliner.app'); options.checkpoint();
      if (mode !== 'verified') throw Error('Synthetic native refusal'); pending = false;
    } };
    const context = { app: { isPackaged: mode !== 'source' }, backgroundLaunch: mode === 'background', maintenanceStore: store,
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
