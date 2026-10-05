import { record, canonicalJSON } from '../core/settings.mjs';
import { checkedJSON } from '../tools/schema.mjs';
import { sourceLimits, sourcePath, sourceSecretPattern, checkedFiles } from './source.mjs';

export const developmentWorkerProgram = 'exec sleep 604800';

// This function executes only in the inspected container. No host service accepts its commands.
async function workerTool() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawn, execFileSync } = require('node:child_process');
  const root = fs.realpathSync(process.cwd()), maximum = 24 * 1024 * 1024;
  const parts = []; let size = 0;
  for (;;) { const part = Buffer.alloc(65536), count = fs.readSync(0, part, 0, part.length, null); if (!count) break; if ((size += count) > maximum) throw new Error('Tool input limit'); parts.push(part.subarray(0, count)); }
  const request = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (request.runId !== process.env.PIPELINER_RUN_ID || request.epoch !== Number(process.env.PIPELINER_EPOCH) || !Number.isSafeInteger(request.epoch)) throw new Error('Tool epoch binding');
  const shapes = { seed: ['files'], list: [], read: ['path'], write: ['path', 'content', 'mode', 'beforeHash'], run: ['command', 'timeoutMs'], export: [] };
  if (!Object.hasOwn(shapes, request.operation)) throw new Error('Tool unavailable');
  record(request, ['operation', 'runId', 'epoch', ...shapes[request.operation]], request.operation === 'run' ? ['input'] : []);
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  function target(relative, writing = false, create = false) {
    if (!sourcePath(relative, writing)) throw new Error('Protected tool path');
    const names = relative.split('/'); names.pop(); let parent = root;
    for (const name of names) {
      parent = path.join(parent, name);
      if (create && !fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      const info = fs.lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || fs.realpathSync(parent) !== parent) throw new Error('Tool parent identity');
    }
    return path.join(root, relative);
  }
  function bytes(relative) {
    const file = target(relative), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || before.size > sourceLimits.fileBytes) throw new Error('Tool regular file required');
      const data = Buffer.alloc(sourceLimits.fileBytes + 1); let length = 0;
      while (length < data.length) { const count = fs.readSync(fd, data, length, data.length - length, null); if (!count) break; length += count; }
      const after = fs.fstatSync(fd), current = fs.lstatSync(file);
      if (length > sourceLimits.fileBytes || before.size !== length || after.size !== length || after.mtimeMs !== before.mtimeMs || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1) throw new Error('Tool file changed');
      const result = data.subarray(0, length);
      checkedFiles([{ path: relative, mode: before.mode & 0o111 ? '100755' : '100644', content: result.toString('base64') }]);
      return { data: result, mode: before.mode & 0o111 ? '100755' : '100644', hash: digest(result) };
    } finally { fs.closeSync(fd); }
  }
  function write(file, expected, seed = false) {
    checkedFiles([file]);
    const destination = target(file.path, !seed, true);
    const exists = fs.existsSync(destination), old = exists ? bytes(file.path) : null;
    if (seed ? exists : expected !== (old?.hash ?? null)) throw new Error('Tool file precondition changed');
    const temporary = path.join(path.dirname(destination), '.pipeliner-write-' + crypto.randomUUID()), content = Buffer.from(file.content, 'base64');
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, file.mode === '100755' ? 0o755 : 0o644);
      fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      if ((fs.existsSync(destination) ? bytes(file.path).hash : null) !== (old?.hash ?? null)) throw new Error('Tool file changed before write');
      fs.renameSync(temporary, destination);
      const directory = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return { path: file.path, hash: bytes(file.path).hash };
    } finally { if (fd !== null && fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function files() {
    const result = []; let total = 0;
    function visit(relative = '') {
      for (const name of fs.readdirSync(relative ? target(relative) : root)) {
        if (!relative && name === '.git') continue; // Guest-only Git index, never exported or trusted.
        const child = relative ? relative + '/' + name : name, location = target(child), info = fs.lstatSync(location);
        if (info.isDirectory() && !info.isSymbolicLink()) visit(child);
        else {
          const data = bytes(child);
          if ((total += data.data.length) > sourceLimits.totalBytes || result.length >= sourceLimits.files) throw new Error('Tool source export limit');
          result.push({ path: child, mode: data.mode, content: data.data.toString('base64') });
        }
      }
    }
    visit(); return checkedFiles(result);
  }
  let result;
  if (request.operation === 'seed') {
    checkedFiles(request.files);
    if (fs.readdirSync(root).length) throw new Error('Tool seed requires empty workspace');
    for (const file of request.files) write(file, null, true);
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env: environment, timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-b', 'main']); if (request.files.length) git(['add', '-f', '--', ...request.files.map(file => file.path)]);
    result = { files: request.files.length, sourceBytes: request.files.reduce((total, file) => total + Buffer.byteLength(file.content, 'base64'), 0) };
  } else if (request.operation === 'read') {
    const file = bytes(request.path); result = { path: request.path, hash: file.hash, content: new TextDecoder('utf8', { fatal: true }).decode(file.data) };
  } else if (request.operation === 'write') {
    if (request.beforeHash !== null && (typeof request.beforeHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.beforeHash))) throw new Error('Tool write precondition required');
    result = write({ path: request.path, mode: request.mode, content: request.content }, request.beforeHash);
  } else if (request.operation === 'list') {
    result = { files: files().map(file => ({ path: file.path, mode: file.mode, hash: digest(Buffer.from(file.content, 'base64')) })) };
  } else if (request.operation === 'export') result = { files: files() };
  else {
    if (typeof request.command !== 'string' || !request.command.trim() || request.command.length > 4096 || request.command.includes('\0')
      || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 300000) throw new Error('Tool command bounds');
    let inputDirectory;
    try {
    if (Object.hasOwn(request, 'input')) {
      checkedJSON(request.input, 'data'); if (sourceSecretPattern.test(canonicalJSON(request.input))) throw new Error('Tool sensitive command input');
      inputDirectory = fs.mkdtempSync('/tmp/pipeliner-step-'); fs.chmodSync(inputDirectory, 0o700);
      environment.PIPELINER_STEP_INPUT_FILE = path.join(inputDirectory, 'input.json');
      fs.writeFileSync(environment.PIPELINER_STEP_INPUT_FILE, canonicalJSON(request.input), { flag: 'wx', mode: 0o600 });
    }
    result = await new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', request.command], { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', length = 0, truncated = false, timedOut = false, force;
      const kill = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') reject(new Error('Tool command termination failed')); } } };
      const stop = () => { kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 1000); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
      const hard = setTimeout(() => process.exit(124), request.timeoutMs + 2500);
      const consume = part => { length += part.length; if (length > 65536) { truncated = true; stop(); } else output += part.toString('utf8'); };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.once('error', () => { clearTimeout(timer); clearTimeout(hard); clearTimeout(force); reject(new Error('Tool command unavailable')); });
      child.once('close', code => { kill('SIGKILL'); clearTimeout(timer); clearTimeout(hard); clearTimeout(force); resolve({ exitCode: truncated ? 125 : timedOut ? 124 : code ?? 1, output, truncated, timedOut }); });
    });
    } finally { if (inputDirectory) fs.rmSync(inputDirectory, { recursive: true }); }
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

// Reuse the exact host validators inside the guest; no second path/schema implementation.
export const workerToolProgram = `const sourceLimits=${JSON.stringify(sourceLimits)}; const record=${record.toString()}; const canonicalJSON=${canonicalJSON.toString()}; const checkedJSON=${checkedJSON.toString()}; const sourcePath=${sourcePath.toString()}; const sourceSecretPattern=${sourceSecretPattern.toString()}; const checkedFiles=${checkedFiles.toString()}; (${workerTool.toString()})().catch(()=>process.stdout.write(JSON.stringify({ok:false,error:'tool-denied-or-incomplete'})));`;
