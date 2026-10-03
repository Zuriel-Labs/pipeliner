import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { backgroundPlist } from '../desktop/background/native.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 2) throw new Error('host-or-arguments-unqualified');
const exec = promisify(execFile), source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-background-'))), bundle = join(root, 'Pipeliner Background Qualification.app');
const identifier = 'com.zuriellabs.pipeliner.background-qualification.' + randomUUID(), label = identifier + '.background';
const executable = join(bundle, 'Contents/MacOS/Pipeliner'), helper = join(bundle, 'Contents/Library/LaunchServices/PipelinerBackground');
const options = { timeout: 30000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, LANG: 'en_US.UTF-8' } };
const checks = [], started = performance.now(); let registered = false, primaryError, cleanupError, receipt, initialStatus, registrationResult, helperPid;
const command = async (program, args, extra = {}) => exec(program, args, { ...options, ...extra });
const state = async operation => JSON.parse((await command(executable, ['--' + operation])).stdout);
const jobAbsent = async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await command('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + label]); }
    catch (error) { if (error.code === 113 && /Could not find service/.test(error.stderr)) return; throw new Error('native-job-readback-unavailable'); }
    await sleep(100);
  }
  throw new Error('native-job-removal-unverified');
};
try {
  const identities = (await command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])).stdout;
  const available = [...identities.matchAll(/\d+\) ([A-F0-9]{40}) "Apple Development:[^"\n]+"/g)];
  if (available.length !== 1) throw new Error('single-local-development-signing-identity-required');
  for (const directory of ['Contents/MacOS', 'Contents/Library/LaunchServices', 'Contents/Library/LaunchAgents']) await mkdir(join(bundle, directory), { recursive: true });
  await writeFile(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>Pipeliner</string><key>CFBundleName</key><string>Pipeliner Background Qualification</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/></dict></plist>`);
  await writeFile(join(bundle, 'Contents/Library/LaunchAgents', label + '.plist'), backgroundPlist(identifier));
  await command('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'ServiceManagement', '-mmacosx-version-min=13.0', join(source, 'desktop/background/native-fixture.m'), '-o', executable]);
  await command('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'Security', '-framework', 'ServiceManagement', '-mmacosx-version-min=13.0', '-DPIPELINER_BUNDLE_ID="' + identifier + '"', join(source, 'desktop/background/bootstrap.m'), '-o', helper]);
  await command('/usr/bin/codesign', ['--sign', available[0][1], '--options', 'runtime', '--timestamp=none', '--identifier', identifier + '.bootstrap', helper]);
  await command('/usr/bin/codesign', ['--sign', available[0][1], '--options', 'runtime', '--timestamp=none', bundle]);
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and identifier "' + identifier + '"', bundle]); checks.push('actual-development-signature-and-nested-helper');
  initialStatus = (await state('status')).status; assert.ok(['not-registered', 'not-found'].includes(initialStatus));
  await jobAbsent();
  await assert.rejects(lstat(join(root, 'launched.json')), error => error.code === 'ENOENT'); checks.push('initial-native-service-and-launch-absent');
  await assert.rejects(command(helper, ['--arbitrary-target'])); checks.push('arbitrary-bootstrap-operation-denied');
  registered = true; registrationResult = await state('register');
  if (registrationResult.status !== 'enabled') throw new Error(registrationResult.status === 'requires-approval' ? 'native-os-approval-required' : 'native-registration-unverified');
  checks.push('actual-SMAppService-registration-enabled');
  for (let attempt = 0; attempt < 100; attempt++) { try { receipt = JSON.parse(await readFile(join(root, 'launched.json'), 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(100); } }
  assert.ok(receipt?.backgroundArgument); assert.equal(receipt.modelCalls, 0); assert.equal(receipt.githubCalls, 0); checks.push('actual-signed-bootstrap-launches-only-containing-application');
  let processState;
  for (let attempt = 0; attempt < 170; attempt++) {
    processState = await command('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + label]);
    helperPid ??= Number(/^\s*pid = (\d+)$/m.exec(processState.stdout)?.[1]) || undefined;
    if (/last exit code = \d+/.test(processState.stdout)) break; await sleep(100);
  }
  if (!/last exit code = 0(?:\n|$)/.test(processState.stdout)) throw new Error('native-bootstrap-exit-unverified');
  checks.push('owned-bootstrap-job-exits-without-KeepAlive');
  assert.equal((await state('unregister')).status, 'not-registered'); registered = false;
  await jobAbsent(); checks.push('actual-native-unregister-and-job-removal');
  // A modified reviewed asset must invalidate the containing bundle and bootstrap.
  await writeFile(join(bundle, 'Contents/Library/LaunchAgents', label + '.plist'), backgroundPlist(identifier) + '\n');
  await assert.rejects(command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]));
  await assert.rejects(command(helper, [])); checks.push('tampered-containing-bundle-denied');
} catch (error) { primaryError = error.code === 'ERR_ASSERTION' ? 'native-assertion-failed' : /^[a-z-]+$/.test(error.message) ? error.message : 'native-command-failed'; }
finally {
  try {
    if (registered) { assert.equal((await state('unregister')).status, 'not-registered'); registered = false; }
    await jobAbsent();
    for (const pid of [receipt?.pid, helperPid].filter(Boolean)) {
      for (let attempt = 0; attempt < 30; attempt++) { try { process.kill(pid, 0); await sleep(100); } catch (error) { if (error.code !== 'ESRCH') throw error; break; } }
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    }
    const info = await lstat(root); assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700);
    await rm(root, { recursive: true }); await assert.rejects(lstat(root), error => error.code === 'ENOENT');
  } catch { cleanupError = 'owned-native-cleanup-unverified'; }
}
const report = { issue: 52, checks, passed: checks.length === 8 && !primaryError && !cleanupError, milliseconds: performance.now() - started,
  host: { platform: process.platform, architecture: process.arch, node: process.versions.node },
  signature: 'Apple Development local fixture; no distribution/notarization claim', helperSourceSha256: createHash('sha256').update(await readFile(join(source, 'desktop/background/bootstrap.m'))).digest('hex'),
  fixture: 'Actual signed native bootstrap/ServiceManagement and LaunchServices; containing application is a bounded synthetic receipt fixture, not the full product',
  modelCalls: 0, githubCalls: 0, cleanup: { registrationRemoved: !registered, rootRemoved: !cleanupError, processAbsent: !receipt || !cleanupError },
  initialStatus, registrationResult, error: primaryError ?? null, cleanupError: cleanupError ?? null };
console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
