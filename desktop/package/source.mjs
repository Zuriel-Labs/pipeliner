import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readPackageInput } from './inputs.mjs';

const git=(root,args)=>execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args],{
  env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'},timeout:10000,maxBuffer:16*1024*1024,
});
export async function sourceCandidate(root) {
  if(await realpath(root)!==root||await realpath(git(root,['rev-parse','--show-toplevel']).toString().trim())!==root)throw new Error('package-source-identity');
  for(const args of [['config','--no-includes','--local','--get-all','remote.origin.url'],['remote','get-url','--push','--all','origin']])
    if(git(root,args).toString().trim()!=='https://github.com/Zuriel-Labs/pipeliner.git')throw new Error('package-source-identity');
  if(git(root,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none']).length)throw new Error('package-source-dirty');
  const sourceCommit=git(root,['rev-parse','HEAD']).toString().trim(),gitTree=git(root,['rev-parse','HEAD^{tree}']).toString().trim();
  if(![sourceCommit,gitTree].every(v=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)))throw new Error('package-source-identity');
  const files=git(root,['ls-tree','-r','--name-only','-z',sourceCommit]).toString().split('\0').filter(Boolean);
  return {sourceCommit,gitTree,files};
}
export async function committedInput(root,candidate,file) {
  if(typeof file!=='string'||!file||file.includes('\\')||/[\x00-\x1f\x7f]/.test(file)||file.split('/').some(v=>!v||v==='.'||v==='..')||resolve(root,file)!==root+'/'+file||!candidate.files.includes(file))throw new Error('package-input-path-invalid');
  const object=git(root,['ls-tree',candidate.sourceCommit,'--',file]).toString();
  if(!/^100(?:644|755) blob [a-f0-9]{40,64}\t/.test(object))throw new Error('package-input-type-invalid');
  const bytes=git(root,['show',candidate.sourceCommit+':'+file]);
  return readPackageInput(root,file,bytes);
}
