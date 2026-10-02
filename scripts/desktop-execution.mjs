import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openWorkerEnvironment } from '../desktop/core/worker.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') { console.log(JSON.stringify({ passed: false, notRun: 'Compatible qualified Mac required' })); process.exit(1); }
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = realpathSync(mkdtempSync('/private/tmp/pipeliner-execution-'));
const ownership = { issue: 32, owner: 'brimdor', run: randomUUID(), directory };
const marker = join(directory, 'ownership.json');
writeFileSync(marker, JSON.stringify(ownership), { mode: 0o600, flag: 'wx' });
if (realpathSync(directory) !== directory || !directory.startsWith('/private/tmp/pipeliner-execution-') || readFileSync(marker, 'utf8') !== JSON.stringify(ownership) || ownership.issue !== 32) throw new Error('Qualification ownership mismatch');
console.log(JSON.stringify({ inventory: { issue: 32, owner: ownership.owner, directory, resources: 'private VM/disk/image and child processes; cleanup in finally' } }));
const executable = join(root, 'desktop/prototype/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const started = performance.now();
let native = null, nativeProcess = null, cleanup = null, error = null;
try {
  if (!existsSync(executable)) throw new Error('Pinned native runtime unavailable');
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [join(root, 'desktop/core/execution-qualify.cjs'), '--fixture-directory', directory], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    nativeProcess = { pid: child.pid, closed: false };
    let output = '', bytes = 0, force;
    const kill = () => { if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 2000); } };
    const timer = setTimeout(kill, 900000);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 1048576) kill(); else { output += data; const lines = data.toString().split('\n').filter(Boolean); for (const line of lines) { try { const parsed = JSON.parse(line); if (parsed.progress) console.log(JSON.stringify({ progress: parsed.progress })); } catch {} } } }); child.stderr.resume();
    child.once('error', reason => { clearTimeout(timer); clearTimeout(force); reject(reason); });
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(force); nativeProcess = { ...nativeProcess, closed: true, code, signal }; resolve({ code, signal, output }); });
  });
  native = JSON.parse(result.output.trim().split('\n').at(-1));
  if (result.code !== 0 || result.signal || !native.passed || !native.resourcesClosed) throw new Error('Native execution qualification failed');
} catch (reason) { error = reason.message; }
finally {
  try {
    const environment = openWorkerEnvironment(directory); cleanup = await environment.destroy();
    if (process.argv.includes('--retain-owned-capture') && existsSync(join(directory, 'controls-dark.png'))) {
      const capturePath = '/tmp/pipeliner-d09-controls-dark.png'; writeFileSync(capturePath, readFileSync(join(directory, 'controls-dark.png')), { mode: 0o600 }); cleanup.captureRetained = { path: capturePath, owner: 'brimdor', trigger: 'Remove after Issue32 rendered review' };
    }
    if (readFileSync(marker, 'utf8') !== JSON.stringify(ownership) || realpathSync(directory) !== directory) throw new Error('Qualification cleanup ownership mismatch');
    rmSync(directory, { recursive: true }); cleanup.workspaceRemoved = !existsSync(directory);
  } catch { cleanup = { ...(cleanup ?? {}), failed: true }; }
}
console.log(JSON.stringify({ passed: !error && native?.passed === true && cleanup?.workspaceRemoved === true && !cleanup.failed, milliseconds: Math.round(performance.now() - started), error, native, nativeProcess, cleanup }));
process.exitCode = !error && native?.passed === true && cleanup?.workspaceRemoved === true && !cleanup.failed ? 0 : 1;
