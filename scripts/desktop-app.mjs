import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, access, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const qualifying = process.argv.includes('--qualify') || process.argv.includes('--qualify-issues') || process.argv.includes('--qualify-pipelines') || process.argv.includes('--qualify-development') || process.argv.includes('--qualify-scheduling');
if (process.argv.slice(2).some(arg => !['--qualify', '--qualify-issues', '--qualify-pipelines', '--qualify-development', '--qualify-scheduling', '--retain-owned-capture'].includes(arg))) throw new Error('argument-denied');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('host-unqualified');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-app-'))), helper = join(temporary, 'secure-entry');
const calendar = join(temporary, 'calendar');
let child, timer, code = 1, report = '', errors = 0;
try {
  await exec('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', '-mmacosx-version-min=13.0', ...(qualifying ? ['-DPIPELINER_QUALIFY'] : []), join(root, 'desktop/connections/secure-entry.m'), '-o', helper], { timeout: 30000 });
  await exec('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-mmacosx-version-min=13.0', join(root, 'desktop/scheduling/calendar.m'), '-o', calendar], { timeout: 30000 });
  const electron = join(root, 'desktop/prototype/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'); await access(electron);
  child = spawn(electron, [join(root, 'desktop/app/main.cjs'), `--key-helper=${helper}`, `--calendar-helper=${calendar}`, ...(qualifying ? ['--qualify', ...process.argv.filter(arg => ['--qualify-issues', '--qualify-pipelines', '--qualify-development', '--qualify-scheduling'].includes(arg)), `--data-directory=${temporary}`] : [])], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), TMPDIR: temporary, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (qualifying) timer = setTimeout(() => child.kill('SIGTERM'), 180000);
  child.stdout.setEncoding('utf8'); child.stdout.on('data', bytes => { report += bytes; if (Buffer.byteLength(report) > 262144) child.kill('SIGTERM'); });
  child.stderr.on('data', bytes => { errors += bytes.length; }); // Provider and Electron raw logs never enter the handoff.
  code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', value => resolveCode(value ?? 1)); });
  if (qualifying) {
    const line = report.split('\n').find(value => value.startsWith('{"desktopQualification"'));
    if (!line) throw new Error('native-report-missing');
    const result = JSON.parse(line); result.launcher = { pid: child.pid, exitCode: code, helperCompiledLocally: true, rawLogsSuppressed: true };
    for (const [available, file, suffix, key] of [['captureAvailable', 'window-capture.png', '', 'capturePath'], ['nativeCaptureAvailable', 'secure-field.png', '-native', 'nativeCapturePath'], ['qaCaptureAvailable', 'qa-capture.png', '-qa', 'qaCapturePath']]) {
      if (!process.argv.includes('--retain-owned-capture') || !result[available]) continue;
      const source = join(temporary, file), info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > 10 * 1024 * 1024) throw new Error('capture-ownership-invalid');
      const capture = join('/tmp', `pipeliner-${process.argv.includes('--qualify-scheduling') ? 50 : process.argv.includes('--qualify-development') ? 42 : process.argv.includes('--qualify-pipelines') ? 40 : 36}-${child.pid}${suffix}.png`);
      await writeFile(capture, await readFile(source), { flag: 'wx', mode: 0o600 }); result[key] = capture;
    }
    console.log(JSON.stringify(result));
  }
} finally {
  clearTimeout(timer); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolveClose => child.once('close', resolveClose)); }
  try {
    const record = JSON.parse(await readFile(join(temporary, 'native-ownership.json'), 'utf8'));
    const expected = join(homedir(), 'Documents', `pipeliner-36-native-${child.pid}`), info = await lstat(expected);
    if (record.pid !== child.pid || record.path !== expected || info.dev + ':' + info.ino !== record.key || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || await realpath(expected) !== expected) throw new Error('fixture-cleanup-unverified');
    await rm(expected, { recursive: true }); await access(expected).then(() => { throw new Error('fixture-cleanup-unverified'); }, error => { if (error.code !== 'ENOENT') throw error; });
    console.log(JSON.stringify({ cleanup: 'owned-native-workspace-removed', verified: true }));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: 'owned-app-root-removed', processesClosed: !child || child.exitCode !== null || child.signalCode !== null }));
}
process.exitCode = code;
