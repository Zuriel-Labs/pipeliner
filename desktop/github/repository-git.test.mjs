import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { repositoryCredentialHelper } from './repository-git.mjs';

test('Packaged Git helper selects only its native bundled executable, with no development Node mode', () => {
  const repository={owner:'fixture',name:'repo'};
  assert.equal(repositoryCredentialHelper(repository,{packaged:true,resourcesPath:'/private/owned/Resources'}),"!'/private/owned/Resources/helpers/git-credential' 'fixture' 'repo'");
  for(const value of [{owner:'fixture;touch other',name:'repo'},{owner:'fixture',name:'..'}])assert.throws(()=>repositoryCredentialHelper(value,{packaged:true,resourcesPath:'/private/owned/Resources'}),/git-credential-denied/);
  assert.throws(()=>repositoryCredentialHelper(repository,{packaged:true,resourcesPath:'relative'}),/git-credential-denied/);
});

test('Actual native Git credential helper enforces the destination before reading its private token pipe', {skip:process.platform!=='darwin'||process.arch!=='arm64'}, async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'pipeliner-54-native-credential-'))), binary=join(root,'git-credential');
  const token='ghu_synthetic_native_pipe_only', query='protocol=https\nhost=github.com\npath=fixture/repo.git\n\n';
  const children=new Set();
  async function run(command,args,input,{leaveTokenOpen=false,credential=token}={}) {
    const child=spawn(command,args,{cwd:root,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'},stdio:['pipe','pipe','pipe','pipe']});children.add(child);
    let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);child.stdin.on('error',()=>{});child.stdio[3].on('error',()=>{});
    const closed=new Promise((done,reject)=>{child.once('close',code=>done({code,output,errors}));child.once('error',reject)});
    const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.stdin.end(input);if(!leaveTokenOpen)child.stdio[3].end(credential);
    try{return await closed;}finally{clearTimeout(timer);child.stdio[3].destroy();children.delete(child);}
  }
  try {
    execFileSync('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0','desktop/github/git-credential.c','-o',binary],{stdio:'pipe'});
    const valid=await run(binary,['fixture','repo','get'],query);assert.equal(valid.code,0);assert.equal(valid.output,'username=x-access-token\npassword='+token+'\n\n');assert.equal(valid.errors,'');
    for(const input of [query.replace('fixture/repo.git','other/repo.git'),query.replace('https','http'),query.replace('github.com','github.com.evil'),query.replace('\n\n','\nhost=github.com\n\n'),query.replace('\n\n','\nusername=other\n\n'),'x'.repeat(1025),Buffer.from([0xff])]) {
      const denied=await run(binary,['fixture','repo','get'],input,{leaveTokenOpen:true});assert.equal(denied.code,1);assert.equal(denied.output,'');assert.equal(denied.errors,'');
    }
    for(const credential of ['invalid','ghu_'+'a'.repeat(201),token+'\n',token+'\0']) {const denied=await run(binary,['fixture','repo','get'],query,{credential});assert.equal(denied.code,1);assert.equal(denied.output,'');}
    for(const operation of ['store','erase']) {const empty=await run(binary,['fixture','repo',operation],query,{leaveTokenOpen:true});assert.equal(empty.code,0);assert.equal(empty.output,'');}
    const helper=repositoryCredentialHelper({owner:'fixture',name:'repo'},{packaged:true,resourcesPath:root});
    // Exercise Git itself without network. The fixture path matches the packaged helper contract.
    const {mkdir,rename}=await import('node:fs/promises');await mkdir(join(root,'helpers'));await rename(binary,join(root,'helpers/git-credential'));
    const git=await run('/usr/bin/git',['-c','credential.helper=','-c','credential.helper='+helper,'-c','credential.useHttpPath=true','credential','fill'],query);
    assert.equal(git.code,0);assert.ok(git.output.includes('password='+token));assert.equal(git.errors,'');
  } finally {
    for(const child of children)child.kill('SIGKILL');
    if(children.size)throw Error('owned-native-credential-process-remains');
    await rm(root,{recursive:true});await access(root).then(()=>{throw Error('owned credential root remains')},e=>{if(e.code!=='ENOENT')throw e});
  }
});
