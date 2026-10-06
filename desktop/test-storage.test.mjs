import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { classifyStartup, validateContext, validateOwnedDataDirectory, configureOwnedPaths } = createRequire(import.meta.url)('./test-storage.cjs');
const volume = '3F381C66-C7CC-4F8F-B3BE-E46151ACF674';
test('Developer storage admission binds the active run, volume and every supplied path', () => {
  const run='/Volumes/TESTING/TestArtifacts/projects/pipeliner/issues/54/runs/synthetic';
  const paths=Object.fromEntries(['tmp','logs','recordings','outputs'].map(name=>[name,join(run,name)]));
  const environment={TEST_ARTIFACT_RUN:run,...Object.fromEntries(Object.entries(paths).map(([name,value])=>['TEST_ARTIFACT_'+name.toUpperCase(),value]))};
  const storage={verified:true,project:'pipeliner',run_path:run,paths,volume_uuid:volume};
  const response=value=>()=>({status:0,stdout:JSON.stringify(value)});
  assert.deepEqual(validateContext('/synthetic/repository',environment,response(storage)),storage);
  for (const changed of [{...storage,volume_uuid:'foreign'},{...storage,verified:false},{...storage,project:'foreign'},
    {...storage,run_path:run+'-stale'},{...storage,paths:{...paths,tmp:'/private/foreign'}}]) {
    assert.throws(()=>validateContext('/synthetic/repository',environment,response(changed)),/test-storage-context-mismatch/);
  }
  assert.throws(()=>validateContext('/synthetic/repository',{},response(storage)),/test-storage-run-required/);
  assert.throws(()=>validateContext('/synthetic/repository',environment,()=>({status:74})),/test-storage-preflight-failed/);
  assert.equal(classifyStartup(['--data-directory=/real/profile'],{}).testMode,false);
  assert.equal(classifyStartup(['--data-directory=/real/profile'],environment).testMode,true);
  for (const args of [['--test-data-directory'],['--test-data-directory='],['--TEST-DATA-DIRECTORY=/synthetic']]) {
    assert.throws(()=>classifyStartup(args,environment),/test-storage-directory-required/);
  }
  assert.throws(()=>classifyStartup(['--test-data-directory=/one','--data-directory=/two']),/test-storage-option-conflict/);
  assert.throws(()=>classifyStartup(['--test-data-directory=/one','--test-data-directory=/two']),/test-storage-option-conflict/);
});
test('Actual private directories and before-ready Electron path setup reject linked or foreign test data', () => {
  const root=mkdtempSync(join(tmpdir(),'pipeliner-storage-check-')), storage={paths:{tmp:root}};
  try {
    const directory=join(root,'profile');mkdirSync(directory,{mode:0o700});
    const calls=[], app={isReady:()=>false,setPath:(...args)=>calls.push(args),setAppLogsPath:value=>calls.push(['logs',value])};
    const destinations=configureOwnedPaths(app,storage,directory);
    assert.deepEqual(calls,Object.entries(destinations));
    assert.throws(()=>configureOwnedPaths({...app,isReady:()=>true},storage,directory),/test-storage-startup-too-late/);
    for (const path of [root,join(root,'..','foreign'), 'relative']) {
      assert.throws(()=>validateOwnedDataDirectory(storage,path),/test-storage-data-outside-run/);
    }
    const linked=join(root,'linked');symlinkSync('profile',linked);
    assert.throws(()=>validateOwnedDataDirectory(storage,linked),/test-storage-directory-unverified/);
    assert.throws(()=>validateOwnedDataDirectory(storage,directory,undefined,process.getuid()+1),/test-storage-directory-unverified/);
    chmodSync(directory,0o755);
    assert.throws(()=>configureOwnedPaths(app,storage,directory),/test-storage-directory-unverified/);
  } finally {rmSync(root,{recursive:true});}
});
