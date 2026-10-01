// Compatible local Mac only; never called by framework quality or Actions.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modes = { check: '--native-check', failure: '--native-failure-check', connect: null,
  'connect-org': '--organization-fixture', 'connect-setup': '--setup-fixtures' };
const mode = process.argv[2];
if (!Object.hasOwn(modes, mode) || process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Requires check, failure or connect on an arm64 Mac');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'desktop/prototype/node_modules/electron/dist/Electron.app');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeliner-d05-run-'));
await fs.writeFile(path.join(directory, 'ownership.json'), JSON.stringify({ issue: 26, owner: 'brimdor', mode, root }));
const records = [];
let child, buffer = '', bytes = 0, interrupted = false;
const processList = () => execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  return match ? [{ pid: Number(match[1]), group: Number(match[2]), command: match[3] }] : [];
});
const gitGroups = async () => {
  const groups = [];
  for (const name of await fs.readdir(directory)) {
    if (!name.startsWith('pipeliner-d05-git-')) continue;
    const location = path.join(directory, name);
    let ownership;
    try { ownership = JSON.parse(await fs.readFile(path.join(location, 'ownership.json'), 'utf8')); }
    catch { throw new Error('Git ownership unavailable; cleanup pending'); }
    if (ownership.issue !== 26 || ownership.owner !== 'brimdor' || ownership.directory !== location ||
      ![1399877876, 1399878351].includes(ownership.fixtureId) || !Array.isArray(ownership.processes) ||
      ownership.processes.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new Error('Git ownership invalid; cleanup pending');
    for (const pid of ownership.processes) groups.push({ pid, location });
  }
  return groups;
};
const ownedHelpers = async () => {
  const groups = new Set((await gitGroups()).map(group => group.pid));
  return processList().filter(process => groups.has(process.group) ||
    (process.command.startsWith(bundle + '/Contents/') && process.command.includes(directory))).map(process => process.pid);
};
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
            'installations', 'setup', 'rows', 'limitations', 'refresh', 'receipt', 'failed'].includes(key))) {
          records.push(record);
          if (record.receipt) console.log(JSON.stringify(record));
        }
      } catch { /* Discard runtime diagnostics; never forward arbitrary output. */ }
    }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  if (interrupted || bytes > 65536 || code !== 0 || records.some(record => record.failed) ||
    (mode === 'check' && !records.some(record => record.nativeDialog === 'opened-and-cancelled')) ||
    (mode.startsWith('connect') && (!records.some(record => mode === 'connect-setup' ? record.setup === 'passed' : record.installations === 'passed') ||
      records.some(record => record.rows?.some(row => row.status !== 'passed') ||
        ['failed', 'blocked'].includes(record.receipt?.status))))) process.exitCode = 1;
  for (const record of records.filter(record => !record.receipt)) console.log(JSON.stringify(record));
} finally {
  // Chromium can write Local State after will-quit; only the parent can remove data after process exit.
  const processes = processList();
  for (const group of await gitGroups()) {
    if (!processes.some(process => process.group === group.pid)) continue;
    if (!processes.some(process => process.pid === group.pid &&
      process.command.startsWith(`/usr/bin/git --git-dir=${group.location}/repository.git `))) throw new Error('Git process identity unavailable; cleanup pending');
    try { process.kill(-group.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let count = 0; count < 40 && (await ownedHelpers()).length; count++) await new Promise(resolve => setTimeout(resolve, 50));
  if ((await ownedHelpers()).length) throw new Error('Task native helpers remain; cleanup pending');
  await fs.rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: 'owned processes exited; native data removed' }));
}
