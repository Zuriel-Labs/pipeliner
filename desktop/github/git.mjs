import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtures } from './access.mjs';

const source = fileURLToPath(import.meta.url);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function credentialReply(input, token, fixtureId) {
  const fixture = fixtures.find(fixture => fixture.id === fixtureId);
  if (!fixture || typeof input !== 'string' || input.length > 1024 || /[\r\0]/.test(input) ||
    typeof token !== 'string' || !/^ghu_[A-Za-z0-9_]{8,200}$/.test(token)) throw new Error('git-credential-denied');
  const fields = Object.create(null);
  for (const line of input.split('\n').filter(Boolean)) {
    const separator = line.indexOf('='), key = line.slice(0, separator), value = line.slice(separator + 1);
    if (separator < 1) throw new Error('git-credential-denied');
    if (['wwwauth[]', 'capability[]'].includes(key)) continue;
    if (!['protocol', 'host', 'path', 'username'].includes(key) || Object.hasOwn(fields, key)) throw new Error('git-credential-denied');
    fields[key] = value;
  }
  if (fields.protocol !== 'https' || fields.host !== 'github.com' ||
    fields.path !== `${fixture.owner}/${fixture.name}.git` ||
    (fields.username !== undefined && fields.username !== 'x-access-token')) throw new Error('git-credential-denied');
  return `username=x-access-token\npassword=${token}\n\n`;
}

function boundedInput(fd, limit) {
  const bytes = Buffer.alloc(limit + 1);
  let length = 0, count;
  while (length <= limit && (count = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += count;
  if (length > limit) throw new Error('git-credential-denied');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
}

if (process.argv[1] && path.resolve(process.argv[1]) === source && process.argv[2] === '--credential') {
  try {
    if (process.argv[4] === 'get') {
      const input = boundedInput(0, 1024), fixtureId = Number(process.argv[3]);
      // Reject the destination before consuming the private token pipe.
      credentialReply(input, 'ghu_synthetic_destination_check', fixtureId);
      process.stdout.write(credentialReply(input, boundedInput(3, 256), fixtureId));
    } else if (!['store', 'erase'].includes(process.argv[4])) process.exitCode = 1;
  } catch { process.exitCode = 1; }
}

export async function qualifyGit(token, fixtureId, { signal } = {}) {
  const fixture = fixtures.find(fixture => fixture.id === fixtureId);
  if (!fixture || typeof token !== 'string' || !/^ghu_[A-Za-z0-9_]{8,200}$/.test(token)) throw new Error('git-credential-denied');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('git-host-unqualified');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeliner-d05-git-'));
  const repository = path.join(directory, 'repository.git'), groups = new Set();
  const journal = () => {
    const file = path.join(directory, 'ownership.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ issue: 26, owner: 'brimdor', fixtureId, directory, processes: [...groups] }));
    fs.renameSync(file + '.tmp', file);
  };
  journal();
  const members = pid => execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).split('\n')
    .flatMap(line => { const match = line.trim().match(/^(\d+)\s+(\d+)$/); return match && Number(match[2]) === pid ? [Number(match[1])] : []; });
  const stop = (pid, action = 'SIGTERM') => { if (groups.has(pid)) { try { process.kill(-pid, action); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
  const helper = `!${quote(process.execPath)} ${quote(source)} --credential ${fixture.id}`;
  async function run(args, write = false) {
    const control = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    control.throwIfAborted();
    const child = spawn('/usr/bin/git', [`--git-dir=${repository}`, '-c', 'credential.helper=', '-c', `credential.helper=${helper}`,
      '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory, detached: true, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: directory,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
    if (child.pid) { groups.add(child.pid); journal(); }
    let output = '', bytes = 0;
    const cancel = () => stop(child.pid);
    control.addEventListener('abort', cancel, { once: true });
    if (control.aborted) cancel();
    child.stdout.on('data', part => { bytes += part.length; if (bytes > 65536) cancel(); else output += part; });
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(token);
    try {
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      if (code !== 0 || control.aborted || bytes > 65536) throw new Error(write ? 'git-write-uncertain' : 'git-read-failed');
      return output.trim();
    } catch { throw new Error(write ? 'git-write-uncertain' : 'git-read-failed'); }
    finally {
      control.removeEventListener('abort', cancel);
      if (child.pid) {
        stop(child.pid);
        for (let attempt = 0; attempt < 20 && members(child.pid).length; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
        if (members(child.pid).length) stop(child.pid, 'SIGKILL');
        for (let attempt = 0; attempt < 20 && members(child.pid).length; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
        if (members(child.pid).length) throw new Error('git-cleanup-failed');
        groups.delete(child.pid); journal();
      }
    }
  }
  try {
    await run(['init', '--bare', repository]);
    const version = await run(['--version']);
    if (!/^git version [0-9A-Za-z. ()-]{1,80}$/.test(version)) throw new Error('git-read-failed');
    const origin = `https://github.com/${fixture.owner}/${fixture.name}.git`;
    const before = await run(['ls-remote', '--refs', origin, 'refs/heads/main']);
    const match = before.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/);
    if (!match) throw new Error('git-readback-mismatch');
    await run(['fetch', '--no-tags', origin, 'refs/heads/main:refs/heads/main']);
    const head = await run(['rev-parse', 'refs/heads/main']);
    if (head !== match[1]) throw new Error('git-readback-mismatch');
    const ref = 'refs/heads/d05-26-git-qualification';
    if (await run(['ls-remote', '--refs', origin, ref])) throw new Error('git-fixture-collision');
    let uncertain = false;
    try { await run(['push', `--force-with-lease=${ref}:`, origin, `${head}:${ref}`], true); }
    catch (error) { if (error.message !== 'git-write-uncertain') throw error; uncertain = true; }
    const actual = await run(['ls-remote', '--refs', origin, ref]);
    if (actual !== `${head}\t${ref}`) throw new Error(uncertain ? 'git-write-uncertain' : 'git-readback-mismatch');
    return { version, head, ref, reconciled: uncertain, cleanup: 'owned Git processes and checkout removed' };
  } finally {
    for (const pid of groups) stop(pid, 'SIGKILL');
    if ([...groups].some(pid => members(pid).length)) throw new Error('git-cleanup-failed');
    fs.rmSync(directory, { recursive: true });
  }
}
