import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, mkdir, lstat, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { repositoryOrigin } from '../core/identity.mjs';
import { canonicalJSON, record } from '../core/settings.mjs';
import { cloneRepository } from '../github/repository-git.mjs';

const exec = promisify(execFile);
export async function inspectLocal(directory, remote, signal, { onProcess = () => {} } = {}) {
  const control = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  const members = pid => execFileSync('/bin/ps', ['-axo','pid=,pgid='], { encoding:'utf8', timeout:3000 }).split('\n')
    .filter(line => line.trim().split(/\s+/)[1] === String(pid));
  async function git(checkout, args, { missing = false, status = false } = {}) {
    control.throwIfAborted();
    const task = exec('/usr/bin/git', ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','credential.helper=','-C',checkout,...args],
      { env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'},
        detached:true, encoding:'utf8', timeout:status ? 10000 : 5000, maxBuffer:status ? 1024*1024 : 16384, signal:control });
    const pid = task.child.pid;
    // Observe only owned groups; cancellation never targets the host application's group.
    const stop = action => { if (pid) { try { process.kill(-pid,action); } catch(error) { if(error.code!=='ESRCH')throw error; } } };
    task.catch(()=>{});
    try {
      onProcess({pid,state:'started'});
      return (await task).stdout;
    } catch (error) {
      control.throwIfAborted();
      if (missing && error.code === 1) return '';
      throw new Error('local-identity-invalid');
    } finally {
      await task.catch(()=>{}); stop('SIGTERM');
      for(let attempt=0;pid && members(pid).length && attempt<20;attempt++)await new Promise(r=>setTimeout(r,25));
      if(pid && members(pid).length)stop('SIGKILL');
      for(let attempt=0;pid && members(pid).length && attempt<20;attempt++)await new Promise(r=>setTimeout(r,25));
      if(pid && members(pid).length)throw new Error('git-cleanup-failed');
      onProcess({pid,state:'closed'});
    }
  }
  try {
    if(typeof directory!=='string'||directory.includes('\0'))throw new Error();
    const checkout = await realpath(directory);
    const readOrigin = async () => {
      const urls = (await git(checkout,['config','--no-includes','--local','--get-all','remote.origin.url'])).trim().split('\n');
      const pushes = (await git(checkout,['config','--no-includes','--local','--get-all','remote.origin.pushurl'],{missing:true})).trim();
      if(urls.length!==1)throw new Error();
      const slug=repositoryOrigin(urls[0]);
      if(pushes && pushes.split('\n').some(value=>repositoryOrigin(value)!==slug))throw new Error();
      return slug;
    };
    const slug=await readOrigin(), [owner,name]=slug.split('/');
    const selected = remote ?? {repository:'unresolved',owner,name};
    canonicalJSON(selected);record(selected,['repository','owner','name']);
    if(typeof selected.repository!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(selected.repository)
      ||typeof selected.owner!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(selected.owner)
      ||typeof selected.name!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(selected.name)||['.','..'].includes(selected.name)
      ||(selected.owner+'/'+selected.name).toLowerCase()!==slug)throw new Error();
    async function identity() {
      if((await git(checkout,['rev-parse','--is-inside-work-tree'])).trim()!=='true')throw new Error();
      const checkoutRoot=await realpath((await git(checkout,['rev-parse','--show-toplevel'])).trim());
      if(checkout!==checkoutRoot&&!checkout.startsWith(checkoutRoot+sep)||await readOrigin()!==slug)throw new Error();
      const commonPath=await realpath(resolve(checkout,(await git(checkout,['rev-parse','--path-format=absolute','--git-common-dir'])).trim()));
      const info=await stat(commonPath,{bigint:true});if(!info.isDirectory())throw new Error();
      return {repository:selected.repository,host:'github.com',slug,localKey:info.dev+':'+info.ino,commonPath,checkoutRoot};
    }
    const before=await identity();
    const changes=await git(before.checkoutRoot,['status','--porcelain=v1','-z','--ignore-submodules=all'],{status:true});
    let tracked=0,untracked=0;
    const entries=changes.split('\0');
    for(let i=0;i<entries.length;i++)if(entries[i]){if(entries[i].startsWith('??'))untracked++;else tracked++;if(/^[RC]|^.[RC]/.test(entries[i]))i++;}
    if(canonicalJSON(await identity())!==canonicalJSON(before)||await realpath(directory)!==checkout)throw new Error();
    control.throwIfAborted();return {identity:before,slug,changes:{tracked,untracked}};
  } catch(error) {
    control.throwIfAborted();
    if(error.message==='git-cleanup-failed')throw error;
    throw new Error('local-identity-invalid');
  }
}

export async function folderIdentity(value, { protectedPaths = [], workspace = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('folder-unavailable');
  const path = await realpath(value), info = await stat(path);
  const blocked = ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/private', ...protectedPaths].map(value => resolve(value));
  if (!info.isDirectory() || info.uid !== process.getuid() || path === '/' || blocked.some(root => path === root || path.startsWith(root + sep) || workspace && root.startsWith(path + sep))) throw new Error('folder-unavailable');
  return { path, key: info.dev + ':' + info.ino };
}

export async function checkFolder(selected, options) {
  const current = await folderIdentity(selected.path, options);
  if (current.path !== selected.path || current.key !== selected.key) throw new Error('folder-changed');
  return current;
}

export async function destination(parent, name, options) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || ['.', '..'].includes(name)) throw new Error('folder-unavailable');
  await checkFolder(parent, options); const path = join(parent.path, name);
  await folderIdentity(parent.path, options);
  try { await access(path); throw new Error('folder-exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path;
}

export async function createCheckout(parent, repo, lease, { signal, protectedPaths = [], onProcess } = {}) {
  lease.check();
  const path = await destination(parent, repo.name, { protectedPaths }); await mkdir(path, { mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || info.uid !== process.getuid()) throw new Error('folder-changed');
  const selected = { path, key: info.dev + ':' + info.ino }; await checkFolder(parent, { protectedPaths });
  await cloneRepository(lease.value.credential.accessToken, { owner: repo.owner.login, name: repo.name }, path, { signal: signal ? AbortSignal.any([signal, lease.signal]) : lease.signal, onProcess });
  lease.check(); await checkFolder(selected, { protectedPaths, workspace: true });
  return inspectLocal(path, { repository: repo.workspaceId, owner: repo.owner.login, name: repo.name }, signal);
}
