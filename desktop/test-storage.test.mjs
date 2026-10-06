import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const { classifyStartup, validateContext, validateOwnedDataDirectory, configureOwnedPaths, nativeTestEnvironment, chromiumLauncher } = createRequire(import.meta.url)('./test-storage.cjs');
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
test('Native Chromium environment requires the exact declared external IPC identity before Electron initialization', () => {
  const base='/Volumes/TESTING/TestArtifacts', run=base+'/projects/pipeliner/issues/54/runs/synthetic';
  const temp=base+'/manifests/chromium-'+createHash('sha256').update(run.slice(base.length+1)).digest('hex').slice(0,16);
  const paths=Object.fromEntries(['tmp','logs','recordings','outputs'].map(name=>[name,join(run,name)]));
  const storage={verified:true,project:'pipeliner',run_path:run,paths,volume_uuid:volume};
  const helper='/Users/chris/.local/share/eaglepro-test-storage-candidates/chromium-singleton-95c420f82716/storage.py';
  const env={TEST_ARTIFACT_RUN:run,TEST_ARTIFACT_CHROMIUM_HELPER:helper,TEST_ARTIFACT_CHROMIUM_TMP:temp,MAC_CHROMIUM_TMPDIR:temp};
  const uid=process.getuid(), info={dev:7,ino:42,uid,mode:0o40700,nlink:2,isDirectory:()=>true,isSymbolicLink:()=>false};
  const metadata={managed_by:'eaglepro-test-storage',owner_uid:uid,project:'pipeliner',status:'running',run_path:run,volume_uuid:volume,paths,
    chromium_singleton:{version:1,project:'pipeliner',run_path:run,temp_path:temp,temp_identity:[7,42,uid,0o40700,null,null],
      phase:'prepared',profile_pattern:'pipeliner-app-[A-Za-z0-9]{6}',ipc_limit_bytes:65536,bindings:{}}};
  let changed=metadata, directory=info, parentMode=0o40755, fileChange={}, closed=0;
  const io={lstatSync:value=>value===base+'/manifests'?{...info,mode:parentMode}:directory,realpathSync:value=>value,openSync:()=>9,closeSync:()=>{closed++;},
    fstatSync:()=>({...info,size:1024,nlink:1,isFile:()=>true,...fileChange}),readFileSync:()=>JSON.stringify(changed)};
  assert.equal(chromiumLauncher,helper.replace('storage.py','test-artifacts'));
  assert.deepEqual(nativeTestEnvironment(storage,env,io,uid),{
    TEST_ARTIFACT_CHROMIUM_HELPER:helper,TEST_ARTIFACT_CHROMIUM_TMP:temp,MAC_CHROMIUM_TMPDIR:temp});
  assert.equal(closed,1);
  for(const change of [{TEST_ARTIFACT_CHROMIUM_HELPER:'/private/foreign'}, {TEST_ARTIFACT_CHROMIUM_TMP:'/private/foreign'},
    {MAC_CHROMIUM_TMPDIR:'/private/foreign'}, {TEST_ARTIFACT_CHROMIUM_HELPER:undefined}]) {
    assert.throws(()=>nativeTestEnvironment(storage,{...env,...change},io,uid),/test-storage-chromium-context/);
  }
  for(const record of [{...metadata,status:'passed'},{...metadata,owner_uid:uid+1},{...metadata,volume_uuid:'foreign'},
    {...metadata,chromium_singleton:undefined}, {...metadata,chromium_singleton:{...metadata.chromium_singleton,run_path:run+'-foreign'}},
    {...metadata,chromium_singleton:{...metadata.chromium_singleton,phase:'closed'}},
    {...metadata,chromium_singleton:{...metadata.chromium_singleton,ipc_limit_bytes:65537}},
    {...metadata,paths:{...paths,tmp:'/private/foreign'}}]) {
    changed=record;assert.throws(()=>nativeTestEnvironment(storage,env,io,uid),/test-storage-chromium-context/);
  }
  changed=metadata;
  for(const change of [{ino:43},{uid:uid+1},{dev:8},{mode:0o40755},{isSymbolicLink:()=>true}]) {
    directory={...info,...change};assert.throws(()=>nativeTestEnvironment(storage,env,io,uid),/test-storage-chromium-context/);
  }
  directory=info;
  parentMode=0o40777;assert.throws(()=>nativeTestEnvironment(storage,env,io,uid),/test-storage-chromium-context/);parentMode=0o40755;
  for(const change of [{size:65537},{nlink:2},{uid:uid+1},{mode:0o100622},{isFile:()=>false}]) {
    fileChange=change;assert.throws(()=>nativeTestEnvironment(storage,env,io,uid),/test-storage-chromium-context/);
  }
  assert.throws(()=>validateContext('/synthetic/repository',{TEST_ARTIFACT_RUN:run,TEST_ARTIFACT_CHROMIUM_HELPER:'/private/foreign'},()=>{throw new Error('must-not-execute');}),/test-storage-chromium-helper/);
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
