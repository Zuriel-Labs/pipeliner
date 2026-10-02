import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpath, stat, mkdir, lstat, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { inspectWorkspace, workspaceData, workspaceRemote } from '../core/identity.mjs';
import { cloneRepository } from '../github/git.mjs';

const source = fileURLToPath(import.meta.url);
if (process.argv[1] === source && process.argv[2] === '--inspect') {
  try {
    let input = '';
    for await (const bytes of process.stdin) { input += bytes; if (Buffer.byteLength(input) > 8192) throw new Error(); }
    const workerData = JSON.parse(input);
    const slug = workspaceRemote(workerData.directory), [owner, name] = slug.split('/');
    const selected = workerData.remote ?? { repository: 'unresolved', owner, name };
    const identity = workspaceData(inspectWorkspace(workerData.directory, selected));
    const changes = execFileSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', identity.checkoutRoot,
      'status', '--porcelain=v1', '-z', '--ignore-submodules=all'], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    let tracked = 0, untracked = 0;
    const entries = changes.split('\0');
    for (let i = 0; i < entries.length; i++) if (entries[i]) { if (entries[i].startsWith('??')) untracked++; else tracked++; if (/^[RC]|^.[RC]/.test(entries[i])) i++; }
    console.log(JSON.stringify({ identity, slug, changes: { tracked, untracked } }));
  } catch { console.log(JSON.stringify({ error: 'local-identity-invalid' })); }
}

export async function inspectLocal(directory, remote, signal) {
  signal?.throwIfAborted();
  const child = spawn(process.execPath, [source, '--inspect'], { detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
  let output = '', timer;
  const stop = action => { if (child.pid) { try { process.kill(-child.pid, action); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
  const abort = () => { stop('SIGTERM'); timer ??= setTimeout(() => stop('SIGKILL'), 1000); };
  const control = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  control.addEventListener('abort', abort, { once: true }); if (control.aborted) abort();
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ directory, remote }));
  child.stdout.setEncoding('utf8'); child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 32768) abort(); });
  const members = () => child.pid ? execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 3000 }).split('\n').filter(line => line.trim().split(/\s+/)[1] === String(child.pid)) : [];
  try {
    const code = await new Promise((resolveCode, reject) => { child.once('close', resolveCode); child.once('error', reject); });
    control.throwIfAborted(); if (code !== 0 || Buffer.byteLength(output) > 32768) throw new Error('local-identity-invalid');
    const value = JSON.parse(output); if (value.error) throw new Error(value.error); return value;
  } finally {
    clearTimeout(timer); control.removeEventListener('abort', abort); stop('SIGTERM');
    for (let attempt = 0; members().length && attempt < 20; attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 25));
    if (members().length) stop('SIGKILL');
    for (let attempt = 0; members().length && attempt < 20; attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 25));
    if (members().length) throw new Error('git-cleanup-failed');
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
