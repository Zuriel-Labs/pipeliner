import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp,realpath,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCandidate, committedInput } from './source.mjs';

test('Package source requires a clean canonical checkout and matching fetch/push identity', async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'pipeliner-54-package-source-')));
  const git=(...args)=>execFileSync('/usr/bin/git',['-C',root,...args],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:'pipe'});
  try {
    git('init');git('remote','add','origin','https://github.com/Zuriel-Labs/pipeliner.git');
    await writeFile(join(root,'owned'),'committed');git('add','owned');git('-c','user.name=Synthetic','-c','user.email=fixture@example.invalid','commit','-m','fixture');
    const candidate=await sourceCandidate(root);
    assert.match(candidate.sourceCommit,/^[a-f0-9]{40}$/);assert.match(candidate.gitTree,/^[a-f0-9]{40}$/);assert.deepEqual(candidate.files,['owned']);
    assert.equal((await committedInput(root,candidate,'owned')).toString(),'committed');
    await writeFile(join(root,'owned'),'changed');await assert.rejects(sourceCandidate(root),/package-source-dirty/);
    await assert.rejects(committedInput(root,candidate,'owned'),/package-input/);
    await writeFile(join(root,'owned'),'committed');await writeFile(join(root,'neighbor'),'preserve');await assert.rejects(sourceCandidate(root),/package-source-dirty/);
    await rm(join(root,'neighbor'));git('config','remote.origin.pushurl','https://github.com/Other/foreign.git');await assert.rejects(sourceCandidate(root),/package-source-identity/);
    git('config','--unset','remote.origin.pushurl');git('remote','set-url','origin','https://github.com/Other/foreign.git');await assert.rejects(sourceCandidate(root),/package-source-identity/);
    await assert.rejects(committedInput(root,candidate,'../outside'),/package-input/);
  } finally {await rm(root,{recursive:true});}
});
