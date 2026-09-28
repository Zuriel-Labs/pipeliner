#!/usr/bin/env node
// Local Mac qualification only. This runner is never invoked by framework quality/CI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = path.join(root, 'desktop/shell');
const owned = path.join(shell, '.qualification');
const appPath = path.join(owned, 'Pipeliner Shell Probe.app');
const executable = path.join(appPath, 'Contents/MacOS/Electron');
const marker = path.join(owned, 'ownership.json');
const command = process.argv[2];
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, encoding: 'utf8', ...options });
const writeJSON = (file, object) => fs.writeFile(file, JSON.stringify(object, null, 2) + '\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.access(file).then(() => true, () => false);
const sourceFiles = ['main.cjs', 'preload.cjs', 'protocol.cjs', 'index.html', 'renderer.js', 'style.css', 'package.json'];

async function ownership() {
  assert.equal(process.platform, 'darwin', 'Requires a compatible local macOS host');
  assert.equal(process.arch, 'arm64', 'Requires arm64; no emulated cross-host claim');
  await fs.mkdir(owned, { recursive: true });
  assert.ok(!(await fs.lstat(owned)).isSymbolicLink());
  if (!await exists(marker)) await writeJSON(marker, { issue: 15, owner: 'brimdor', root });
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), { issue: 15, owner: 'brimdor', root });
}

async function fileManifest(directory) {
  const entries = [];
  async function visit(current) {
    for (const item of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, item.name);
      const relative = path.relative(directory, full);
      if (item.isSymbolicLink()) entries.push({ path: relative, link: await fs.readlink(full) });
      else if (item.isDirectory()) await visit(full);
      else { const bytes = await fs.readFile(full); entries.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) }); }
    }
  }
  await visit(directory);
  return entries;
}

async function packageApp() {
  assert.equal(ownedProcesses().length, 0, 'Stop the task-owned app before replacing its package');
  await fs.rm(appPath, { recursive: true, force: true });
  await fs.cp(path.join(shell, 'node_modules/electron/dist/Electron.app'), appPath, { recursive: true, verbatimSymlinks: true });
  const resources = path.join(appPath, 'Contents/Resources');
  await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
  const content = path.join(resources, 'app');
  await fs.mkdir(content);
  for (const name of sourceFiles) await fs.copyFile(path.join(shell, name), path.join(content, name));
  run('xcrun', ['clang', '-arch', 'arm64', '-Wall', '-Wextra', '-Werror', '-O2', path.join(shell, 'native-helper.c'), '-o', path.join(resources, 'probe-helper')]);
  const plist = path.join(appPath, 'Contents/Info.plist');
  for (const [key, value] of [['CFBundleIdentifier', 'com.zuriellabs.pipeliner.shell-probe'], ['CFBundleName', 'Pipeliner Shell Probe'], ['CFBundleDisplayName', 'Pipeliner Shell Probe']]) {
    run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }
  run('codesign', ['--force', '--deep', '--sign', '-', '--options', '0', appPath], { stdio: 'pipe' });
  run('codesign', ['--verify', '--deep', '--strict', appPath]);
  const manifest = await fileManifest(appPath);
  const inputManifest = await fileManifest(content);
  assert.deepEqual(inputManifest.map(item => item.path).sort(), [...sourceFiles].sort());
  const identity = { bundleSHA256: sha(JSON.stringify(manifest)), bundleBytes: manifest.reduce((total, item) => total + (item.bytes ?? 0), 0),
    shellInputsSHA256: sha(JSON.stringify(inputManifest)), nativeHelperSHA256: sha(await fs.readFile(path.join(resources, 'probe-helper'))),
    nativeHelperSourceSHA256: sha(await fs.readFile(path.join(shell, 'native-helper.c'))),
    signing: 'Local ad-hoc only; not Developer ID signed or notarized', assets: inputManifest.map(item => item.path) };
  await writeJSON(path.join(owned, 'package-identity.json'), identity);
  console.log(JSON.stringify(identity));
}

function processCommand(pid) {
  try { return run('ps', ['-p', String(pid), '-o', 'command=']).trim(); } catch { return ''; }
}

function ownedProcesses() {
  return run('ps', ['-axo', 'pid=,command=']).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match?.[2].startsWith(appPath + '/Contents/') ? [Number(match[1])] : [];
  });
}

async function verifyStopped() {
  for (let count = 0; count < 20 && ownedProcesses().length; count++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(ownedProcesses().length, 0, 'Task-owned packaged processes remain');
}

async function verifyRun(index, attempt) {
  const directory = path.join(owned, 'runs', attempt, `process-${index}`);
  await fs.mkdir(directory, { recursive: true });
  const resultPath = path.join(directory, 'result.json');
  const dataDirectory = path.join(directory, 'data');
  const args = ['-n', '-W', '--stdout', path.join(directory, 'stdout.log'), '--stderr', path.join(directory, 'stderr.log'),
    appPath, '--args', '--qualify', `--probe-data=${dataDirectory}`, `--probe-output=${resultPath}`];
  const child = spawn('/usr/bin/open', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const helpers = new Set();
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const deadline = setTimeout(async () => {
    timedOut = true;
    const pid = Number(await fs.readFile(path.join(dataDirectory, 'main.pid'), 'utf8').catch(() => '0'));
    if (pid && processCommand(pid).startsWith(executable + ' ')) process.kill(pid, 'SIGTERM');
    child.kill('SIGTERM');
  }, 60000);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally {
    clearTimeout(deadline);
    stdout += await fs.readFile(path.join(directory, 'stdout.log'), 'utf8').catch(() => '');
    stderr += await fs.readFile(path.join(directory, 'stderr.log'), 'utf8').catch(() => '');
    for (const line of stdout.split('\n')) {
      try { const event = JSON.parse(line); if (event.name === 'helper-spawn') helpers.add(event.pid); } catch { /* Non-JSON runtime message. */ }
    }
    for (const pid of helpers) {
      const activeCommand = processCommand(pid);
      if (activeCommand === path.join(appPath, 'Contents/Resources/probe-helper')) {
        process.kill(pid, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(processCommand(pid) !== path.join(appPath, 'Contents/Resources/probe-helper'), `Owned helper ${pid} remains`);
    }
    await fs.writeFile(path.join(directory, 'stdout.log'), stdout);
    await fs.writeFile(path.join(directory, 'stderr.log'), stderr);
    await verifyStopped();
  }
  assert.ok(!timedOut, `Runtime deadline: process ${index}; inspect ${directory}`);
  const result = await fs.readFile(resultPath, 'utf8').then(JSON.parse);
  assert.equal(exitCode, 0, `LaunchServices exit ${exitCode}: ${result.error}`);
  result.ownedHelperPids = [...helpers];
  result.cleanup = 'Every packaged process and observed native helper absent';
  return result;
}

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, minimum: sorted[0], median: sorted[Math.ceil(sorted.length / 2) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], maximum: sorted.at(-1) };
}

await ownership();
if (command === 'setup') {
  run('npm', ['ci', '--prefix', shell, '--ignore-scripts', '--cache', path.join(owned, 'npm-cache')], { stdio: 'inherit' });
  run(process.execPath, [path.join(shell, 'node_modules/electron/install.js')], {
    env: { ...process.env, electron_config_cache: path.join(owned, 'download-cache') }, stdio: 'inherit',
  });
  const expected = JSON.parse(await fs.readFile(path.join(shell, 'node_modules/electron/checksums.json'), 'utf8'))['electron-v44.4.5-darwin-arm64.zip'];
  const downloads = await fileManifest(path.join(owned, 'download-cache'));
  assert.ok(downloads.some(item => item.path.endsWith('electron-v44.4.5-darwin-arm64.zip') && item.sha256 === expected), 'Downloaded Electron checksum');
  console.log(JSON.stringify({ electron: '44.4.5', downloadedSHA256: expected, platform: process.platform, architecture: process.arch }));
} else if (command === 'package') await packageApp();
else if (command === 'compare-native') {
  const comparison = path.join(owned, 'native-window');
  run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-framework', 'Cocoa', path.join(shell, 'native-window-comparison.m'), '-o', comparison]);
  try { console.log(run(comparison, [], { timeout: 10000 })); }
  catch (error) {
    console.log(error.stdout?.toString() ?? 'No comparison output');
    process.exitCode = error.status || 1;
  }
}
else if (command === 'verify') {
  const identity = JSON.parse(await fs.readFile(path.join(owned, 'package-identity.json'), 'utf8'));
  assert.equal(sha(JSON.stringify(await fileManifest(appPath))), identity.bundleSHA256, 'Packaged bundle changed');
  assert.equal(sha(await fs.readFile(path.join(shell, 'native-helper.c'))), identity.nativeHelperSourceSHA256, 'Stale packaged helper source');
  for (const name of sourceFiles) assert.equal(sha(await fs.readFile(path.join(shell, name))), sha(await fs.readFile(path.join(appPath, 'Contents/Resources/app', name))), `Stale packaged source: ${name}`);
  const results = [];
  const attempt = `attempt-${Date.now()}`;
  for (let index = 1; index <= 5; index++) {
    const result = await verifyRun(index, attempt); results.push(result);
    console.log(`Packaged process ${index}: ${result.passed ? 'passed' : 'failed (see measurements)'}`);
  }
  const report = {
    date: new Date().toISOString(), sourceCommit: run('git', ['rev-parse', 'HEAD']).trim(), gitTree: run('git', ['rev-parse', 'HEAD^{tree}']).trim(),
    sourceStatus: run('git', ['status', '--porcelain=v1']), host: { os: run('sw_vers', ['-productVersion']).trim(), build: run('sw_vers', ['-buildVersion']).trim(), architecture: process.arch,
      logicalCPUs: Number(run('sysctl', ['-n', 'hw.ncpu'])), memoryBytes: Number(run('sysctl', ['-n', 'hw.memsize'])) },
    identity, versions: results[0].versions,
    firstUsableFromMainMilliseconds: distribution(results.map(item => item.firstUsableMilliseconds)),
    warmWindowMilliseconds: distribution(results.flatMap(item => item.warmWindowMilliseconds)),
    localFeedbackMilliseconds: distribution(results.flatMap(item => item.feedbackMilliseconds)),
    helperMilliseconds: distribution(results.flatMap(item => item.helperMilliseconds)),
    results,
    limits: ['Fresh-process samples retain OS disk caches; startup timing begins at main entry.', 'Warm shell reopen is not cached workspace navigation.',
      'Synthetic IPC-to-DOM/requestAnimationFrame feedback is not physical-input-to-screen latency.', 'Programmatic native APIs and web accessibility tree do not prove pointer/keyboard/VoiceOver interaction.',
      'No worker isolation, persistent background service, providers, signing/notarization distribution, full workload or cross-platform proof.'],
  };
  await writeJSON(path.join(owned, 'measurements.json'), report);
  process.exitCode = results.every(result => result.passed) ? 0 : 1;
  console.log(JSON.stringify({ host: report.host, versions: report.versions, firstUsableFromMainMilliseconds: report.firstUsableFromMainMilliseconds, warmWindowMilliseconds: report.warmWindowMilliseconds,
    localFeedbackMilliseconds: report.localFeedbackMilliseconds, helperMilliseconds: report.helperMilliseconds, bundleBytes: identity.bundleBytes }));
} else if (command === 'launch') {
  assert.equal(ownedProcesses().length, 0, 'Task-owned candidate already running');
  const directory = path.join(owned, 'pm-test');
  await fs.mkdir(directory, { recursive: true });
  await fs.rm(path.join(directory, 'main.pid'), { force: true });
  run('/usr/bin/open', ['-n', appPath, '--args', `--probe-data=${directory}`]);
  for (let index = 0; index < 50 && !await exists(path.join(directory, 'main.pid')); index++) await new Promise(resolve => setTimeout(resolve, 100));
  const pid = Number(await fs.readFile(path.join(directory, 'main.pid'), 'utf8'));
  assert.ok(processCommand(pid).startsWith(executable + ' '), 'Launched app identity');
  await writeJSON(path.join(owned, 'pm-process.json'), { pid, executable, owner: 'brimdor', issue: 15, cleanupTrigger: 'PM feedback/replacement or final approval' });
  console.log(`PM candidate launched, owned PID ${pid}`);
} else if (command === 'cleanup') {
  const processFile = path.join(owned, 'pm-process.json');
  if (await exists(processFile)) {
    const record = JSON.parse(await fs.readFile(processFile, 'utf8'));
    const activeCommand = processCommand(record.pid);
    if (activeCommand.startsWith(executable + ' ')) {
      process.kill(record.pid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(!processCommand(record.pid).startsWith(executable + ' '), 'PM candidate remains');
  }
  // Exact marker-owned outputs and the dependency tree installed by this runner only.
  await verifyStopped();
  await fs.rm(path.join(shell, 'node_modules'), { recursive: true, force: true });
  await fs.rm(owned, { recursive: true });
  console.log('Issue #15 task outputs and dependencies removed; source preserved.');
} else throw new Error('Use setup, package, verify, compare-native, launch or cleanup');
