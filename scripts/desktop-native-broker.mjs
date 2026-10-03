import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, writeFile, readFile, access, lstat, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile), repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 2) throw new Error('native-broker-host-unqualified');
const id = 'com.pipeliner.qualification.' + randomUUID().replaceAll('-', ''), started = performance.now();
const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-54-native-broker-')));
const neighbor = join(homedir(), 'Library', 'Caches', 'pipeliner-54-native-broker-' + id.split('.').at(-1));
const container = join(homedir(), 'Library', 'Containers', id + '.target'), seed = join(neighbor, 'synthetic-neighbor'), forbidden = join(neighbor, 'unexpected-write'), marker = join(neighbor, 'escape-marker.json');
const exists = path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
let child, report, code = 1, escapePid, failure;
const plist = values => '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' + Object.entries(values).map(([key, value]) => '<key>' + key + '</key>' + (value === true ? '<true/>' : '<string>' + value + '</string>')).join('') + '</dict></plist>';
async function ownedDirectory(path) {
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || await realpath(path) !== path) throw new Error('native-broker-cleanup-ownership-unverified');
}
async function bundle(name, sandbox) {
  const path = join(root, name + '.app'), contents = join(path, 'Contents'), executable = join(contents, 'MacOS', 'fixture');
  await mkdir(join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  await writeFile(join(contents, 'Info.plist'), plist({ CFBundleExecutable: 'fixture', CFBundleIdentifier: id + '.' + name.toLowerCase(), CFBundleName: 'Pipeliner native qualification ' + name, CFBundlePackageType: 'APPL', CFBundleVersion: '1', LSUIElement: true,
    ...(!sandbox ? { PipelinerQualificationMarker: marker } : {}) }), { flag: 'wx', mode: 0o600 });
  await exec('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', '-mmacosx-version-min=13.0', join(repository, 'desktop/native/broker-fixture.m'), '-o', executable], { timeout: 30000 });
  const args = ['--force', '--sign', '-', '--options', 'runtime', '--identifier', id + '.' + name.toLowerCase()];
  if (sandbox) { const entitlements = join(root, 'target.entitlements'); await writeFile(entitlements, plist({ 'com.apple.security.app-sandbox': true }), { flag: 'wx', mode: 0o600 }); args.push('--entitlements', entitlements); }
  await exec('/usr/bin/codesign', [...args, path], { timeout: 10000 }); await exec('/usr/bin/codesign', ['--verify', '--strict', path], { timeout: 10000 });
  return { path, executable };
}
try {
  if (await exists(neighbor) || await exists(container)) throw new Error('native-broker-owned-destination-occupied');
  await mkdir(neighbor, { mode: 0o700 }); await writeFile(seed, 'synthetic neighboring data; never personal data', { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'ownership.json'), JSON.stringify({ issue: 54, owner: 'brimdor', id, root, neighbor, container }), { flag: 'wx', mode: 0o600 });
  const target = await bundle('Target', true), escape = await bundle('Escape', false);
  await exec(escape.executable, ['--escape', marker], { env: { PATH: '/usr/bin:/bin', HOME: homedir(), TMPDIR: root, LANG: 'en_US.UTF-8' }, timeout: 5000 });
  const positive = JSON.parse(await readFile(marker, 'utf8'));
  if (positive.bundle !== escape.path || !Number.isSafeInteger(positive.pid) || positive.pid <= 1) throw new Error('native-broker-positive-control-unverified');
  await rm(marker);
  const inspected = await exec('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', target.path], { timeout: 10000 });
  if (!inspected.stdout.includes('com.apple.security.app-sandbox') || !inspected.stdout.includes('<true/>')) throw new Error('native-broker-signature-sandbox-unverified');
  child = spawn(target.executable, ['--target', seed, forbidden, escape.path, marker], { env: { PATH: '/usr/bin:/bin', HOME: homedir(), TMPDIR: root, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; if (Buffer.byteLength(output) > 16384) child.kill('SIGTERM'); });
  child.stderr.on('data', () => {}); const timeout = setTimeout(() => child.kill('SIGTERM'), 15000);
  try { code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', value => done(value ?? 1)); }); } finally { clearTimeout(timeout); }
  if (code !== 0 || !output.trim()) { console.log(JSON.stringify({ fixtureExit: code, fixtureSignal: child.signalCode, boundedOutputPresent: Boolean(output.trim()) })); throw new Error('native-broker-fixture-incomplete'); }
  report = JSON.parse(output); if (report.pid !== child.pid || report.bundle !== target.path || report.container !== join(container, 'Data')) throw new Error('native-broker-target-identity-unverified');
  const until = Date.now() + 3000; while (report.launchServicesReturnedApp && !await exists(marker) && Date.now() < until) await new Promise(done => setTimeout(done, 25));
  let escaped = false;
  if (await exists(marker)) {
    const value = JSON.parse(await readFile(marker, 'utf8')); if (value.bundle !== escape.path || report.escapePid > 1 && value.pid !== report.escapePid || !Number.isSafeInteger(value.pid) || value.pid <= 1) throw new Error('native-broker-escape-identity-unverified');
    escapePid = value.pid; escaped = true;
  }
  const result = { qualification: 'native-application-boundary', host: { os: (await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim(), architecture: process.arch },
    sourceSHA256: createHash('sha256').update(await readFile(join(repository, 'desktop/native/broker-fixture.m'))).digest('hex'),
    checks: { signatureVerified: true, sandboxEntitlement: true, positiveControl: true, nativeWindowCreated: report.nativeWindowCreated, neighboringReadDenied: report.neighborReadDenied,
      neighboringWriteDenied: report.neighborWriteDenied && !await exists(forbidden), childReadDenied: report.childReadDenied, launchServicesEscapeDenied: !report.launchServicesReturnedApp && !escaped && !report.launchServicesTimedOut },
    launchServices: { returnedApp: report.launchServicesReturnedApp, ownedMarkerWritten: escaped, errorCode: report.launchServicesError, timedOut: Boolean(report.launchServicesTimedOut) },
    milliseconds: Math.round(performance.now() - started), notRun: ['Host automation consent or other applications', 'Third-party install', 'Packaged broker', 'Windows/Linux'] };
  result.passed = Object.values(result.checks).every(value => value === true); console.log(JSON.stringify(result)); code = result.passed ? 0 : 1;
} catch (error) {
  failure = /^native-broker-[a-z-]+$/.test(error.message) ? error.message : 'native-broker-execution-failed'; code = 1;
} finally {
  const cleanupErrors = [];
  const clean = async (name, operation) => { try { await operation(); return true; } catch { cleanupErrors.push(name); return false; } };
  const processesClosed = await clean('owned-processes', async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(done => child.once('close', done)); }
    if (await exists(marker)) {
      const value = JSON.parse(await readFile(marker, 'utf8'));
      if (value.bundle !== join(root, 'Escape.app') || !Number.isSafeInteger(value.pid) || value.pid <= 1) throw new Error('native-broker-escape-identity-unverified');
      escapePid = value.pid;
    }
    if (escapePid || report?.escapePid > 1) {
      const pid = escapePid ?? report.escapePid; if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('native-broker-process-identity-unverified');
      try { const value = await exec('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
        if (value.stdout.trim() !== join(root, 'Escape.app', 'Contents', 'MacOS', 'fixture')) throw new Error('native-broker-process-identity-unverified');
        process.kill(pid, 'SIGTERM');
      } catch (error) { if (error.code !== 1 && error.code !== 'ESRCH') throw error; }
      const until = Date.now() + 3000; for (;;) { try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() > until) throw new Error('native-broker-process-cleanup-unverified'); await new Promise(done => setTimeout(done, 25)); }
    }
  });
  if (processesClosed) {
    if (report?.launchServicesReturnedApp || escapePid) await clean('launch-services-registration', () => exec('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', join(root, 'Escape.app')], { timeout: 10000 }));
    for (const [name, path] of [['container', container], ['neighbor', neighbor]]) await clean(name, async () => {
      if (await exists(path)) { await ownedDirectory(path); await rm(path, { recursive: true }); }
      if (await exists(path)) throw new Error('native-broker-owned-path-cleanup-unverified');
    });
    if (!cleanupErrors.length) await clean('root', async () => { await ownedDirectory(root); await rm(root, { recursive: true }); if (await exists(root)) throw new Error('native-broker-root-cleanup-unverified'); });
  }
  const pathsAbsent = !await exists(root) && !await exists(neighbor) && !await exists(container);
  console.log(JSON.stringify({ ...(failure ? { failure } : {}), cleanup: cleanupErrors.length ? 'incomplete' : 'exact-owned-native-fixtures-removed',
    targetProcessClosed: !child || child.exitCode !== null || child.signalCode !== null, escapeProcessClosed: processesClosed, pathsAbsent, cleanupErrors,
    ...(!pathsAbsent ? { retainedOwnership: join(root, 'ownership.json') } : {}) }));
  if (cleanupErrors.length || !pathsAbsent) code = 1;
}
process.exitCode = code;
