// Compatible local Mac only; never called by framework quality or Actions.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modes = { check: '--native-check', failure: '--native-failure-check', connect: null };
const mode = process.argv[2];
if (!Object.hasOwn(modes, mode) || process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Requires check, failure or connect on an arm64 Mac');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'desktop/prototype/node_modules/electron/dist/Electron.app');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeliner-d05-run-'));
await fs.writeFile(path.join(directory, 'ownership.json'), JSON.stringify({ issue: 26, owner: 'brimdor', mode, root }));
const records = [];
let child, buffer = '', bytes = 0, interrupted = false;
const ownedHelpers = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
  const match = line.trim().match(/^(\d+)\s+(.*)$/);
  return match?.[2].startsWith(bundle + '/Contents/') && match[2].includes(directory) ? [Number(match[1])] : [];
});
try {
  child = spawn(path.join(bundle, 'Contents/MacOS/Electron'), [path.join(root, 'desktop/github/connect.cjs'), '--managed',
    ...(modes[mode] ? [modes[mode]] : [])], { cwd: root,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'en_US.UTF-8', TMPDIR: directory },
    stdio: ['ignore', 'pipe', 'ignore'] });
  const stop = () => { interrupted = true; child.kill('SIGTERM'); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log(JSON.stringify({ nativeProbePid: child.pid, mode }));
  child.stdout.on('data', chunk => {
    bytes += chunk.byteLength;
    if (bytes > 65536) { stop(); return; }
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object' && !Array.isArray(record) &&
          Object.keys(record).every(key => ['nativeDialog', 'versions', 'platform', 'architecture', 'date', 'appId',
            'installations', 'rows', 'limitations', 'refresh', 'receipt', 'failed'].includes(key))) records.push(record);
      } catch { /* Discard runtime diagnostics; never forward arbitrary output. */ }
    }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  if (interrupted || bytes > 65536 || code !== 0 || records.some(record => record.failed) ||
    (mode === 'check' && !records.some(record => record.nativeDialog === 'opened-and-cancelled')) ||
    (mode === 'connect' && !records.some(record => record.installations === 'passed'))) process.exitCode = 1;
  for (const record of records) console.log(JSON.stringify(record));
} finally {
  // Chromium can write Local State after will-quit; only the parent can remove data after process exit.
  for (let count = 0; count < 40 && ownedHelpers().length; count++) await new Promise(resolve => setTimeout(resolve, 50));
  if (ownedHelpers().length) throw new Error('Task native helpers remain; cleanup pending');
  await fs.rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: 'owned processes exited; native data removed' }));
}
