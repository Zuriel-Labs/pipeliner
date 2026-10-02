import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log(JSON.stringify({ passed: false, notRun: 'A qualified compatible native runtime is required' })); process.exit(1);
}
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-d07-native-')));
const ownership = { issue: 28, owner: 'brimdor', run: randomUUID(), directory };
const marker = join(directory, 'ownership.json');
writeFileSync(marker, JSON.stringify(ownership), { flag: 'wx', mode: 0o600 });
const executable = join(root, 'desktop/prototype/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
let native = null, error = null, cleanup = false;
try {
  if (!existsSync(executable)) throw new Error('Pinned native runtime unavailable');
  const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [join(root, 'desktop/core/qualify.cjs'), '--fixture-directory', directory], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let size = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', bytes => { size += bytes.length; if (size > 1048576) child.kill('SIGTERM'); else output += bytes; });
    child.stderr.resume();
    child.once('error', reason => { clearTimeout(timer); reject(reason); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  native = JSON.parse(result.output.trim().split('\n').at(-1));
  if (result.code !== 0 || result.signal || !native.passed || !native.resourcesClosed) throw new Error('Native policy qualification failed');
} catch (reason) { error = ['Pinned native runtime unavailable', 'Native policy qualification failed'].includes(reason.message) ? reason.message : 'Native policy runner failed'; }
finally {
  // Electron can flush user data while quitting. Remove it only after child close.
  if (readFileSync(marker, 'utf8') === JSON.stringify(ownership) && realpathSync(directory) === directory) {
    rmSync(directory, { recursive: true }); cleanup = !existsSync(directory);
  }
}
console.log(JSON.stringify({ passed: !error && cleanup, error, native, cleanup }));
process.exitCode = !error && cleanup ? 0 : 1;
