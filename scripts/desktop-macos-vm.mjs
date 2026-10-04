import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, realpath, lstat, statfs, rm, mkdtemp, chmod, copyFile, access } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Qualification only; deliberately separate from the packaged application and host capability API.
const exec = promisify(execFile), repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[3];
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 4 || process.argv[2] !== '--owned-root'
  || !root || !basename(root).startsWith('pipeliner-54-macos-worker-')) throw new Error('macos-vm-owned-host-unqualified');
const owned = await lstat(root), ownership = JSON.parse(await readFile(join(root, 'ownership.json'), 'utf8'));
if (await realpath(root) !== root || !owned.isDirectory() || owned.isSymbolicLink() || owned.uid !== process.getuid() || (owned.mode & 0o777) !== 0o700
  || ownership.root !== root || ownership.owner !== 'brimdor' || ownership.issue !== 54
  || ownership.bytes !== 26637307067 || ownership.sha256 !== '2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1') throw new Error('macos-vm-root-unverified');
const helper = join(root, 'macos-vm-fixture'), began = performance.now(), image = join(root, 'Restore.ipsw');
const exists = path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const free = async () => { const value = await statfs(root); return value.bavail * value.bsize; };
let child, captureRoot, failure, installation, boot, cancellation;
const emit = value => console.log(JSON.stringify(value));
const reportFile = async (name, value) => writeFile(join(root, name), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
const signals = new AbortController();
const abort = () => signals.abort();
process.on('SIGTERM', abort); process.on('SIGINT', abort);
async function run(mode, cancelRunning = false) {
  signals.signal.throwIfAborted();
  const reports = []; let pending = '', failure, cancelling = false, cancellationTimer;
  child = spawn(helper, [mode, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const close = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  close.catch(() => {}); // The PID record can fail before the awaited close; keep rejection observed.
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  const deadline = setTimeout(() => terminate(), mode === '--install' ? 1810000 : 190000);
  let force;
  const terminate = () => { stop(); force ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 15000); };
  signals.signal.addEventListener('abort', terminate, { once: true });
  child.stderr.on('data', () => {}); // Never publish unfiltered native/OS diagnostics.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    pending += data;
    if (Buffer.byteLength(pending) > 16384) { failure = 'output-limit'; terminate(); return; }
    for (let index; (index = pending.indexOf('\n')) !== -1;) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      try {
        const value = JSON.parse(line);
        if (reports.length >= 256) throw new Error('report-limit');
        reports.push(value); emit({ phase: cancelRunning ? 'cancellation' : mode.slice(2), ...value });
        if (cancelRunning && value.running === true && !cancelling) {
          cancelling = true;
          cancellationTimer = setTimeout(async () => {
            try {
              if (child.exitCode !== null || child.signalCode !== null) return;
              const identity = await exec('/bin/ps', ['-p', String(child.pid), '-o', 'comm='], { timeout: 5000 });
              if (identity.stdout.trim() !== helper) throw new Error('process-identity');
              stop();
            } catch { failure = 'cancellation-identity'; terminate(); }
          }, 2000);
        }
      } catch { failure = 'report-unverified'; terminate(); }
    }
  });
  try {
    await reportFile(cancelRunning ? 'cancel-process.json' : mode === '--install' ? 'install-process.json' : 'boot-process.json', { pid: child.pid, helper, helperSHA256: ownership.helperSHA256 });
    if (signals.signal.aborted) terminate();
    const result = await close;
    if (result.code !== 0 || result.signal || failure || pending.trim()) throw new Error('macos-vm-phase-unverified');
    return reports;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { terminate(); await close.catch(() => {}); }
    clearTimeout(deadline); clearTimeout(force); clearTimeout(cancellationTimer); signals.signal.removeEventListener('abort', terminate);
  }
}
async function noFileHandles() {
  const paths = [];
  for (const name of ['Disk.img', 'Restore.ipsw', 'AuxiliaryStorage']) if (await exists(join(root, name))) paths.push(join(root, name));
  if (!paths.length) return;
  try { await exec('/usr/sbin/lsof', ['-Fpn', ...paths], { timeout: 10000 }); throw new Error('macos-vm-file-handles-present'); }
  catch (error) { if (error.code !== 1 || error.stdout || error.stderr) throw error; }
}
try {
  if (await free() < 100 * 1024 ** 3 || (await lstat(image)).size !== ownership.bytes) throw new Error('macos-vm-storage-or-image-unverified');
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const bytes of createReadStream(image)) hash.update(bytes);
  if (hash.digest('hex') !== ownership.sha256) throw new Error('macos-vm-image-integrity-failed');
  await exec('/usr/bin/clang', ['-fobjc-arc','-Wall','-Wextra','-Werror','-framework','AppKit','-framework','Virtualization','-mmacosx-version-min=27.0',join(repository,'desktop/native/macos-vm-fixture.m'),'-o',helper], { timeout: 30000, signal: signals.signal });
  const entitlements = join(root, 'virtualization.entitlements');
  await writeFile(entitlements, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.virtualization</key><true/></dict></plist>', { mode: 0o600 });
  await exec('/usr/bin/codesign', ['--force','--sign','-','--options','runtime','--entitlements',entitlements,helper], { timeout: 10000, signal: signals.signal });
  await exec('/usr/bin/codesign', ['--verify','--strict',helper], { timeout: 10000 });
  const inspected = await exec('/usr/bin/codesign', ['--display','--entitlements','-','--xml',helper], { timeout: 10000 });
  const verified = join(root, 'verified.entitlements'); await writeFile(verified, inspected.stdout, { mode: 0o600 });
  const values = JSON.parse((await exec('/usr/bin/plutil', ['-convert','json','-o','-',verified])).stdout);
  if (Object.keys(values).length !== 1 || values['com.apple.security.virtualization'] !== true) throw new Error('macos-vm-entitlements-unverified');
  ownership.sourceSHA256 = createHash('sha256').update(await readFile(join(repository,'desktop/native/macos-vm-fixture.m'))).digest('hex');
  ownership.helperSHA256 = createHash('sha256').update(await readFile(helper)).digest('hex'); ownership.helper = helper;
  await writeFile(join(root,'ownership.json'), JSON.stringify(ownership), { mode: 0o600 });
  emit({ imageVerified: true, compiled: true, signatureVerified: true, soleVirtualizationEntitlement: true, sourceSHA256: ownership.sourceSHA256, helperSHA256: ownership.helperSHA256 });
  installation = await run('--install');
  if (!installation.some(value => value.installed === true && value.build === '26A434' && value.vmStopped === true)) throw new Error('macos-vm-installation-unverified');
  await noFileHandles(); await rm(image);
  await writeFile(join(root,'guest-provisioning.json'), JSON.stringify({ password: randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 });
  boot = await run('--boot');
  if (!boot.some(value => value.running === true && value.nativeWindowCreated === true && value.hostInputInjection === false)
    || !boot.some(value => value.ownedGuestViewCaptured === true) || !boot.some(value => value.vmStopped === true)) throw new Error('macos-vm-boot-unverified');
  await rm(join(root,'guest-provisioning.json'));
  cancellation = await run('--boot', true);
  if (!cancellation.some(value => value.ownedCancellationReceived === true) || !cancellation.some(value => value.vmStopped === true)) throw new Error('macos-vm-cancellation-unverified');
  captureRoot = await realpath(await mkdtemp(join(tmpdir(),'pipeliner-54-macos-capture-'))); await chmod(captureRoot, 0o700);
  await writeFile(join(captureRoot,'ownership.json'), JSON.stringify({ issue:54, owner:'brimdor', root:captureRoot, cleanupTrigger:'Visual review of owned guest view' }), { flag:'wx', mode:0o600 });
  await copyFile(join(root,'owned-guest-view.png'),join(captureRoot,'owned-guest-view.png')); await chmod(join(captureRoot,'owned-guest-view.png'),0o600);
  emit({ installed:true, bootStopped:true, cancellationStopped:true, captureRoot, guestProvisioningObservation:'Pending visual inspection; running/window flags alone do not prove desktop readiness' });
} catch (error) { failure = /^macos-vm-[a-z-]+$/.test(error.message) ? error.message : 'macos-vm-qualification-failed'; }
finally {
  process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
  try {
    if (child && child.exitCode === null && child.signalCode === null) throw new Error('macos-vm-process-cleanup-unverified');
    await noFileHandles();
    const current = await lstat(root);
    if (current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid || current.isSymbolicLink() || await realpath(root) !== root) throw new Error('macos-vm-cleanup-ownership-unverified');
    await rm(root, { recursive:true });
    if (await exists(root)) throw new Error('macos-vm-root-cleanup-unverified');
    const available = await statfs(tmpdir());
    emit({ ...(failure ? { failure } : {}), exactOwnedVMRootRemoved:true, ownedProcessClosed:true, fileHandlesAbsent:true,
      availableBytes:available.bavail * available.bsize, milliseconds:Math.round(performance.now()-began), ...(captureRoot ? { retainedCaptureOwner:'brimdor', captureRoot } : {}) });
  } catch { emit({ ...(failure ? { failure } : {}), cleanup:'incomplete', retainedOwnership:join(root,'ownership.json') }); failure ??= 'macos-vm-cleanup-unverified'; }
}
process.exitCode = failure ? 1 : 0;
