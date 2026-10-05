import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(import.meta.url);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function repositoryCredentialReply(input, token, repository) {
  if (!repository || !/^[A-Za-z0-9-]{1,39}$/.test(repository.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name) || ['.', '..'].includes(repository.name)
    || typeof input !== 'string' || input.length > 1024 || /[\r\0]/.test(input) ||
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
    fields.path !== `${repository.owner}/${repository.name}.git` ||
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

if (process.argv[1] && path.resolve(process.argv[1]) === source && process.argv[2] === '--repository-credential') {
  try {
    if (process.argv[5] === 'get') {
      const input = boundedInput(0, 1024), repository = { owner: process.argv[3], name: process.argv[4] };
      repositoryCredentialReply(input, 'ghu_synthetic_destination_check', repository);
      process.stdout.write(repositoryCredentialReply(input, boundedInput(3, 256), repository));
    } else if (!['store', 'erase'].includes(process.argv[5])) process.exitCode = 1;
  } catch { process.exitCode = 1; }
}

export function repositoryCredentialHelper(repository, { packaged = Boolean(process.versions.electron) && !process.defaultApp, resourcesPath = process.resourcesPath } = {}) {
  repositoryCredentialReply(`protocol=https\nhost=github.com\npath=${repository?.owner}/${repository?.name}.git\n\n`, 'ghu_synthetic_destination_check', repository);
  if (packaged) {
    if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath) || path.normalize(resourcesPath) !== resourcesPath || resourcesPath.includes('\0')) throw new Error('git-credential-denied');
    return `!${quote(path.join(resourcesPath, 'helpers/git-credential'))} ${quote(repository.owner)} ${quote(repository.name)}`;
  }
  return `!${quote(process.execPath)} ${quote(source)} --repository-credential ${quote(repository.owner)} ${quote(repository.name)}`;
}

export async function cloneRepository(token, repository, directory, { signal, onProcess = () => {} } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('git-host-unqualified');
  repositoryCredentialReply(`protocol=https\nhost=github.com\npath=${repository.owner}/${repository.name}.git\n\n`, token, repository);
  const info = fs.lstatSync(directory), key = info.dev + ':' + info.ino;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || fs.realpathSync(directory) !== path.resolve(directory) || fs.readdirSync(directory).length) throw new Error('git-destination-denied');
  const helper = repositoryCredentialHelper(repository);
  const members = pid => execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 3000 }).split('\n')
    .flatMap(line => { const match = line.trim().match(/^(\d+)\s+(\d+)$/); return match && Number(match[2]) === pid ? [Number(match[1])] : []; });
  async function run(args) {
    const control = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    control.throwIfAborted();
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev + ':' + current.ino !== key || fs.realpathSync(directory) !== directory) throw new Error('git-destination-denied');
    const child = spawn('/usr/bin/git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, '-c', 'credential.useHttpPath=true',
      '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...args],
      { cwd: directory, detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: directory, GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...(Boolean(process.versions.electron) && !process.defaultApp ? {} : { ELECTRON_RUN_AS_NODE: '1' }) }, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
    let bytes = 0, timer;
    const stop = action => { if (child.pid) { try { process.kill(-child.pid, action); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
    const abort = () => { stop('SIGTERM'); timer ??= setTimeout(() => stop('SIGKILL'), 1000); };
    const closed = new Promise((resolveCode, reject) => { child.once('close', resolveCode); child.once('error', reject); });
    closed.catch(() => {});
    child.stdio[3].on('error', () => {});
    try {
      onProcess({ pid: child.pid, state: 'started' }); control.addEventListener('abort', abort, { once: true }); if (control.aborted) abort();
      child.stdout.on('data', part => { bytes += part.length; if (bytes > 65536) abort(); }); child.stdio[3].end(token);
      const code = await closed;
      if (control.aborted || code !== 0 || bytes > 65536) throw new Error('git-clone-incomplete');
    } finally {
      control.removeEventListener('abort', abort); abort(); await closed.catch(() => {}); clearTimeout(timer);
      for (let attempt = 0; child.pid && members(child.pid).length && attempt < 20; attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 25));
      if (child.pid && members(child.pid).length) stop('SIGKILL');
      for (let attempt = 0; child.pid && members(child.pid).length && attempt < 20; attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 25));
      if (child.pid && members(child.pid).length) throw new Error('git-cleanup-failed');
      onProcess({ pid: child.pid, state: 'closed' });
    }
  }
  await run(['clone', '--no-checkout', '--no-recurse-submodules', '--template=', `https://github.com/${repository.owner}/${repository.name}.git`, '.']);
  await run(['-C', directory, 'checkout', '--force', '--no-recurse-submodules']);
}
