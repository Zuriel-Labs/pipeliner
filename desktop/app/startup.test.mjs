import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url), source = readFileSync(new URL('./main.cjs',import.meta.url),'utf8');
const testStorage = require('../test-storage.cjs');
function entry(packaged, args, storageAvailable = true) {
  const calls = [];
  const app = { isPackaged:packaged, getPath(name) { calls.push(['getPath',name]); return '/private/synthetic-app-data'; },
    setName(name) { calls.push(['setName',name]); }, setPath(...values) { calls.push(['setPath',...values]); },
    requestSingleInstanceLock() { calls.push(['lock']); return true; }, whenReady() { calls.push(['ready']); return {then(){return {catch(){}};}}; }, on(){},
    exit(code) { throw new Error('captured-exit-' + code); } };
  const context = { require:name=> {
    if (name === 'electron') return {app,protocol:{registerSchemesAsPrivileged(){calls.push(['protocol']);}}};
    if (name === '../test-storage.cjs') {
      if (packaged) throw new Error('packaged-developer-dependency');
      return { ...testStorage, validateContext() {
        calls.push(['storage']); if (!storageAvailable) throw new Error('test-storage-run-required');
        return {paths:{tmp:'/private/owned-test'}};
      }, validateOwnedDataDirectory(_storage, directory) {calls.push(['owned',directory]);},
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
  for(const argument of ['--qualify','--qualify-tools','--qualify=1','--QUALIFY','--test-data-directory=/private/foreign','--test-data-directory','--TEST-DATA-DIRECTORY=/private/foreign','--data-directory=/private/foreign','--data-directory','--key-helper=/private/foreign','--key-helper','--calendar-helper=/private/foreign','--calendar-helper']) {
    const fixture=entry(true,[argument]);assert.throws(fixture.run,/captured-exit-2/);assert.deepEqual(fixture.calls,[['error','Pipeliner rejected an unsupported packaged startup option.']]);
  }
  for(const args of [[],['--background-helper']]) {
    const fixture=entry(true,args);fixture.run();assert.ok(fixture.calls.some(call=>call[0]==='ready'));
    assert.ok(fixture.calls.some(call=>call[0]==='setPath'&&call[1]==='userData'&&call[2]==='/private/synthetic-app-data/Pipeliner'));
  }
  const sourceFixture=entry(false,['--qualify','--data-directory=/private/owned-test','--key-helper=/private/owned-key','--calendar-helper=/private/owned-calendar']);
  sourceFixture.run();assert.ok(sourceFixture.calls.some(call=>call[0]==='ready'));
  assert.ok(sourceFixture.calls.some(call=>call[0]==='setPath'&&call[1]==='userData'&&call[2]==='/private/owned-test'));
  assert.ok(sourceFixture.calls.findIndex(call=>call[0]==='owned') < sourceFixture.calls.findIndex(call=>call[0]==='setName'));
  const denied=entry(false,['--qualify','--test-data-directory=/private/owned-test'],false);
  assert.throws(denied.run,/test-storage-run-required/);assert.deepEqual(denied.calls,[['storage']]);
});
