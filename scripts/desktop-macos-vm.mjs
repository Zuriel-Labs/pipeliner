import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, realpath, lstat, statfs, rm, open, chmod, copyFile, access, mkdir, readdir, symlink, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGuestReport } from '../desktop/native/bridge-data.mjs';
import { downloadLeasedRestore, restore } from './desktop-macos-restore.mjs';

// Qualification only; deliberately separate from the packaged application and host capability API.
const exec = promisify(execFile), repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 3 || process.argv[2] !== '--bridge') throw Error('macos-vm-root-unverified');
const bridge = true, runPath = process.env.TEST_ARTIFACT_RUN;
const contractHome = '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-vm-amendments-ef503d3a75b1d6fc';
const contractWrapper = join(contractHome, 'test-artifacts-vm-amendments');
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const helperPins = {
  [join(contractHome, 'vm.py')]: 'ef503d3a75b1d6fc858381c87b05cfd08df1a95ecfa52bb52da952d30fd29ad0',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-quality-groups-9a1a595dd66417b9/groups.py': '9a1a595dd66417b94745659daed5b96df65b9a78e4c7b821c0f5b2bab6b9e78c',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-contracts-5f78740e471545f0/entry.py': 'c28a82fd39f72954690f78bbf595a9d115037470994aae6c6837e41cd1e4b59a',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-contracts-5f78740e471545f0/diagnostics.py': 'f286d78fd994a899598259f93b39e03d86808861843def203c3b3699656e2119',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-contracts-5f78740e471545f0/contracts.py': 'da1f02f84b1ef58a7a47fe77ab84cdd288e62448ab03ecc3a7db2fc2e0b14040',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/chromium-singleton-95c420f82716/storage.py': '6fbb08f51bf7f950672a4f7462983ae6b1b30253e880d336beb5955ec57e2de3',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/chromium-singleton-95c420f82716/chromium_singleton.py': 'ca4cf859353eb6889a58c36ba1d478aa9544a9f7ac9d1e3a9c2e6b4ee28ec10d',
};
async function readOwned(path, maximum = 1048576) {
  if (await realpath(path) !== path) throw Error('macos-vm-file-unverified');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.mode & 0o022 || before.size > maximum) throw Error('macos-vm-file-unverified');
    const buffer = Buffer.alloc(before.size+1); let length = 0;
    while (length < buffer.length) { const result = await file.read(buffer,length,buffer.length-length); if (!result.bytesRead) break; length += result.bytesRead; }
    const bytes = buffer.subarray(0,length), after = await file.stat(), current = await lstat(path);
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino || current.dev !== before.dev || current.ino !== before.ino
      || after.size !== before.size || current.size !== before.size || after.mode !== before.mode || current.mode !== before.mode
      || after.uid !== before.uid || current.uid !== before.uid || after.nlink !== 1 || current.nlink !== 1
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw Error('macos-vm-file-unverified');
    return bytes;
  } finally { await file.close(); }
}
if (typeof runPath !== 'string' || !/^\/Volumes\/TESTING\/TestArtifacts\/projects\/pipeliner\/issues\/54\/runs\/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{32}$/.test(runPath)
  || ['tmp','logs','outputs','recordings'].some(name => process.env['TEST_ARTIFACT_' + name.toUpperCase()] !== join(runPath,name))) throw Error('macos-vm-context-required');
const producer = fileURLToPath(import.meta.url), producerSHA256 = hashBytes(await readOwned(producer));
const receipt = async () => JSON.parse(await readOwned(join(runPath,'manifest.json'),65536));
const initial = await receipt(), candidate = initial.storage_contract?.candidate;
async function verifyReceipt() {
  const value = await receipt(), contract = value.storage_contract, pins = value.diagnostic_context?.source_sha256;
  if (value.status !== 'running' || value.managed_by !== 'eaglepro-test-storage' || value.project !== 'pipeliner' || value.issue !== '54'
    || value.owner_uid !== process.getuid() || value.child_pid !== process.pid || value.run_path !== runPath
    || value.volume_uuid !== '3F381C66-C7CC-4F8F-B3BE-E46151ACF674' || value.diagnostic_context?.route !== 'pipeliner-54-vm-amendments'
    || ['tmp','logs','outputs','recordings'].some(name => value.paths?.[name] !== join(runPath,name))
    || contract?.profile !== 'pipeliner-54-macos-vm' || contract.vm_amendments_version !== 1 || contract.producer_path !== producer
    || contract.producer_sha256 !== producerSHA256 || JSON.stringify(contract.candidate) !== JSON.stringify(candidate)
    || !pins || Object.keys(pins).length !== Object.keys(helperPins).length
    || Object.entries(helperPins).some(([file,digest]) => pins[file] !== digest)) throw Error('macos-vm-receipt-unverified');
  return value;
}
await verifyReceipt();
for (const [file,digest] of Object.entries(helperPins)) if (hashBytes(await readOwned(file)) !== digest) throw Error('macos-vm-contract-source-unverified');
if (hashBytes(await readOwned(contractWrapper)) !== 'd7f472187c0da0de26f1b37bf89076c6d3d55c634bbbab3606952cbdf1f0b17e') throw Error('macos-vm-contract-source-unverified');
if (!candidate || !/^[a-f0-9]{40}$/.test(candidate.source) || !/^[a-f0-9]{40}$/.test(candidate.tree)) throw Error('macos-vm-candidate-unverified');
const git = async args => (await exec('/usr/bin/git', ['-C',repository,...args], {timeout:10000,maxBuffer:1048576})).stdout.trim();
if (await git(['rev-parse','HEAD']) !== candidate.source || await git(['rev-parse','HEAD^{tree}']) !== candidate.tree) throw Error('macos-vm-candidate-unverified');
for (const name of ['scripts/desktop-macos-vm.mjs','scripts/desktop-macos-restore.mjs','desktop/native/macos-vm-fixture.m','desktop/native/macos-guest-fixture.m','desktop/native/bridge-data.mjs']) {
  const committed = await exec('/usr/bin/git',['-C',repository,'show',`${candidate.source}:${name}`],{timeout:10000,maxBuffer:1048576,encoding:'buffer'});
  if (hashBytes(committed.stdout) !== hashBytes(await readOwned(join(repository,name)))) throw Error('macos-vm-candidate-unverified');
}
async function request(operation, args = []) {
  const before = (await verifyReceipt()).storage_contract.sequence;
  const result = await exec(contractWrapper,['contract','--repo',repository,'--run',runPath,'--producer-sha256',producerSHA256,'--operation',operation,...args],{timeout:20000,maxBuffer:65536});
  const acknowledged = JSON.parse(result.stdout), current = (await verifyReceipt()).storage_contract;
  const recorded = JSON.parse(await readOwned(join(runPath,'outputs/storage-contract-request.json'),65536));
  const expected = {sequence:before+1,nonce:recorded.nonce,profile:'pipeliner-54-macos-vm',run_path:runPath,phase:current.phase,accepted:true};
  if (recorded.operation !== operation || recorded.sequence !== before+1 || !/^[a-f0-9]{32}$/.test(recorded.nonce)
    || current.sequence !== before+1 || Object.keys(acknowledged).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key,value]) => acknowledged[key] !== value)) throw Error('macos-vm-acknowledgment-unverified');
  return current;
}
await request('vm-prepare');
const root = join(runPath,'tmp/pipeliner-54-macos-worker'), owned = await lstat(root);
if (await realpath(root) !== root || !owned.isDirectory() || owned.uid !== process.getuid() || (owned.mode & 0o777) !== 0o700
  || (await verifyReceipt()).storage_contract.vm_root !== root) throw Error('macos-vm-root-unverified');
await request('vm-bind',['--role','controller','--worker-pid',String(process.pid)]);
const ownership = {root,owner:'brimdor',issue:54,bytes:restore.bytes,sha256:restore.sha256,candidate,producerSHA256,
  resources:['leased restore and disk','native helpers','synthetic guest fixtures'],cleanupTrigger:'Exact acknowledged role release; preserve fixtures and receipts'};
await writeFile(join(root,'ownership.json'),JSON.stringify(ownership),{flag:'wx',mode:0o600});
const helper = join(root, 'macos-vm-fixture'), began = performance.now(), image = join(root, 'Restore.ipsw');
const exists = path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const free = async () => { const value = await statfs(root); return value.bavail * value.bsize; };
let child, failure, installation, boot, cancellation, nonce, staged, boundaryPrepared = false, boundaryReleased = false, trialCompleted = false;
const emit = value => console.log(JSON.stringify(value));
const reportFile = async (name, value) => writeFile(join(root, name), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
const signals = new AbortController();
const abort = () => signals.abort();
process.on('SIGTERM', abort); process.on('SIGINT', abort);
async function run(mode, cancelRunning = false) {
  signals.signal.throwIfAborted();
  const reports = []; let pending = '', failure, cancelling = false, cancellationTimer;
  const phase = cancelRunning ? 'cancellation' : mode === '--install' ? 'install' : 'boot-bridge';
  const gateNonce = randomBytes(16).toString('hex'), gatePath = join(root,`native-gate-${gateNonce}.json`);
  const gate = await open(gatePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600), gateIdentity = await gate.stat();
  let enrolled = false, admitted = false;
  child = spawn(helper, [mode, root, gateNonce], { stdio: ['ignore', 'pipe', 'pipe'] });
  const close = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  close.catch(() => {}); // The PID record can fail before the awaited close; keep rejection observed.
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  const deadline = setTimeout(() => terminate(), mode === '--install' ? 1810000 : mode === '--bridge' ? 250000 : 190000);
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
    await new Promise((done,reject) => { child.once('spawn',done); child.once('error',reject); });
    const bound = await request('vm-child-bind',['--child-phase',phase,'--worker-pid',String(child.pid),'--worker-executable',helper,'--worker-sha256',ownership.helperSHA256]);
    const recorded = bound.native_children.at(-1);
    if (!recorded || recorded.pid !== child.pid || recorded.phase !== phase || recorded.executable !== helper || recorded.executable_sha256 !== ownership.helperSHA256 || recorded.closed) throw Error('macos-vm-child-acknowledgment-unverified');
    enrolled = true;
    const named = await lstat(gatePath), opened = await gate.stat();
    if (named.dev !== gateIdentity.dev || named.ino !== gateIdentity.ino || opened.dev !== gateIdentity.dev || opened.ino !== gateIdentity.ino
      || named.nlink !== 1 || opened.nlink !== 1 || named.size !== 0 || opened.size !== 0 || named.mode !== gateIdentity.mode || opened.mode !== gateIdentity.mode) throw Error('macos-vm-gate-unverified');
    await gate.writeFile(JSON.stringify({mode,nonce:gateNonce,pid:child.pid})); await gate.sync(); admitted = true;
    await reportFile(cancelRunning ? 'cancel-process.json' : mode === '--install' ? 'install-process.json' : 'boot-process.json', { pid: child.pid, helper, helperSHA256: ownership.helperSHA256 });
    if (signals.signal.aborted) terminate();
    const result = await close;
    const stopped = reports.some(value => value.vmStopped === true);
    let passed = result.code === 0 && !result.signal && !failure && !pending.trim() && stopped;
    if (mode === '--install') passed &&= reports.some(value => value.installed === true && value.build === '26A434');
    else if (cancelRunning) passed &&= reports.some(value => value.ownedCancellationReceived === true);
    else {
      passed &&= reports.some(value => value.running === true && value.nativeWindowCreated === true && value.hostInputInjection === false)
        && reports.some(value => value.ownedGuestViewCaptured === true) && reports.some(value => value.guestTrialCompleted === true)
        && reports.some(value => value.ownedGuestTargetCaptured === true);
      if (passed) { try { await verifyBridge(); } catch { passed = false; } }
    }
    if (!Number.isInteger(result.code) || result.signal || !stopped) throw Error('macos-vm-stop-unverified');
    await noFileHandles();
    await request('vm-child-close',['--child-phase',phase,'--worker-exit-code',String(result.code),passed?'--phase-passed':'--phase-failed','--vm-stopped']);
    if (!passed) throw Error('macos-vm-phase-unverified');
    return reports;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { terminate(); await close.catch(() => {}); }
    clearTimeout(deadline); clearTimeout(force); clearTimeout(cancellationTimer); signals.signal.removeEventListener('abort', terminate);
    await gate.close();
    emit({phase,storageEnrolled:enrolled,nativeGateReleased:admitted,ownedNativeProcessReaped:child.exitCode !== null || child.signalCode !== null});
  }
}
async function noFileHandles() {
  const paths = [];
  for (const name of ['Disk.img', 'Restore.ipsw', 'AuxiliaryStorage']) if (await exists(join(root, name))) paths.push(join(root, name));
  if (!paths.length) return;
  try { await exec('/usr/sbin/lsof', ['-Fpn', ...paths], { timeout: 10000 }); throw new Error('macos-vm-file-handles-present'); }
  catch (error) { if (error.code !== 1 || error.stdout || error.stderr) throw error; }
}
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function inventory(directory, prefix = '') {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory,name), key = prefix + name, info = await lstat(path);
    if (info.isSymbolicLink()) entries.push({ name:key, link:await readlink(path) });
    else if (info.isDirectory()) { entries.push({ name:key, directory:true }); entries.push(...await inventory(path,key + '/')); }
    else if (info.isFile() && info.nlink === 1 && info.size <= 1024 * 1024) entries.push({ name:key, sha256:await digest(path) });
    else throw new Error('macos-vm-staged-content-unqualified');
  }
  return entries;
}
async function stageGuest() {
  nonce = randomBytes(16).toString('hex');
  const input = join(root,'input'), output = join(root,'output'), neighbor = join(root,'neighbor');
  for (const path of [input,output,neighbor]) await mkdir(path,{mode:0o700});
  await writeFile(join(neighbor,'seed'),randomBytes(32),{flag:'wx',mode:0o600});
  const source = join(repository,'desktop/native/macos-guest-fixture.m'), binary = join(root,'guest-binary');
  await exec('/usr/bin/clang',['-fobjc-arc','-fno-modules','-Wall','-Wextra','-Werror','-framework','AppKit','-framework','Security','-mmacosx-version-min=27.0',source,'-o',binary],{timeout:30000,signal:signals.signal});
  for (const role of ['Agent','Target','Escape']) {
    const bundle = join(input,role + '.app'), contents = join(bundle,'Contents'), macos = join(contents,'MacOS');
    for (const path of [bundle,contents,macos]) await mkdir(path,{mode:0o700});
    await copyFile(binary,join(macos,'fixture')); await chmod(join(macos,'fixture'),0o700);
    const identifier = `com.pipeliner.qualification.${nonce}.${role.toLowerCase()}`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>${role}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>27.0</string><key>PipelinerQualificationRole</key><string>${role.toLowerCase()}</string>${role === 'Target' ? '' : '<key>LSUIElement</key><true/>'}</dict></plist>`;
    await writeFile(join(contents,'Info.plist'),plist,{flag:'wx',mode:0o600});
    await exec('/usr/bin/codesign',['--force','--sign','-','--options','runtime','--identifier',identifier,bundle],{timeout:10000,signal:signals.signal});
    await exec('/usr/bin/codesign',['--verify','--strict',bundle],{timeout:10000});
  }
  await writeFile(join(input,'qualification.json'),JSON.stringify({nonce,neighbor,targetSHA256:await digest(join(input,'Target.app/Contents/MacOS/fixture')),targetIdentifier:`com.pipeliner.qualification.${nonce}.target`}),{flag:'wx',mode:0o600});
  await request('vm-boundary-prepare'); boundaryPrepared = true;
  await symlink(join(neighbor,'seed'),join(input,'escape-link'));
  await reportFile('bridge.json',{nonce});
  staged = { input:await inventory(input), neighbor:await digest(join(neighbor,'seed')) };
  ownership.guestSourceSHA256 = await digest(source); ownership.stagedInputSHA256 = createHash('sha256').update(JSON.stringify(staged.input)).digest('hex');
  ownership.resources.push('private input/output/neighbor folders','original guest bundles');
  await writeFile(join(root,'ownership.json'),JSON.stringify(ownership),{mode:0o600});
  emit({guestBundlesCompiled:true,guestBundleSignaturesVerified:true,guestSourceSHA256:ownership.guestSourceSHA256,stagedInputSHA256:ownership.stagedInputSHA256});
}
async function verifyBridge() {
  const output = join(root,'output');
  const ready = await readGuestReport(output,'agent-ready.json',nonce), result = await readGuestReport(output,'agent-result.json',nonce);
  const stopped = await readGuestReport(output,'agent-stop.json',nonce), escape = await readGuestReport(output,'escape-launch.json',nonce);
  if (!['neighborReadDenied','neighborWriteDenied','readOnlyWriteDenied','escapeLinkReadDenied','descendantDenied','signatureVerified','actualGuestWindowVerified'].every(key=>ready[key] === true)
    || result.clicked !== true || result.guestLaunchEscapeContained !== true || stopped.targetStopped !== true || stopped.ownedGuestInstallRemoved !== true || escape.launchedInGuest !== true) throw new Error('macos-vm-guest-result-unverified');
  if (JSON.stringify(await inventory(join(root,'input'))) !== JSON.stringify(staged.input) || await digest(join(root,'neighbor/seed')) !== staged.neighbor
    || JSON.stringify(await readdir(join(root,'neighbor'))) !== JSON.stringify(['seed'])) throw new Error('macos-vm-host-boundary-changed');
  let linkedRejected = false;
  try { await readGuestReport(output,'returned-link.json',nonce); } catch(error) { if(error.code === 'ELOOP') linkedRejected = true; else throw error; }
  if (!linkedRejected) throw new Error('macos-vm-returned-link-accepted');
  emit({guestInstalledAndLaunched:true,guestBundleWindowVerified:true,guestButtonClicked:true,hostNeighborUnchanged:true,readOnlyInputUnchanged:true,guestLaunchEscapeContained:true,descendantEscapeDenied:true,returnedLinkRejected:true,guestTargetStoppedAndRemoved:true});
}
async function retainCapture() {
  const names = [];
  for (const name of ['owned-guest-view.png','owned-guest-target.png','bridge-path.png','bridge-folder.png']) if(await exists(join(root,name))) names.push(name);
  if(!names.length) return;
  emit({retainedCaptures:names.map(name=>join(root,name)),retainedCaptureOwner:'brimdor',cleanupTrigger:'Visual review; preserve exact retained evidence'});
}
try {
  if (await free() < 288 * 1024 ** 3) throw new Error('macos-vm-storage-or-image-unverified');
  const transfer = await downloadLeasedRestore(image,signals.signal,emit);
  if (transfer.bytes !== ownership.bytes || transfer.sha256 !== ownership.sha256) throw Error('macos-vm-image-integrity-failed');
  await exec('/usr/bin/clang', ['-fobjc-arc','-fno-modules','-Wall','-Wextra','-Werror','-framework','AppKit','-framework','Virtualization','-mmacosx-version-min=27.0',join(repository,'desktop/native/macos-vm-fixture.m'),'-o',helper], { timeout: 30000, signal: signals.signal });
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
  await noFileHandles();
  await stageGuest(); // Begin the 900-second boundary lease after the potentially long install.
  await writeFile(join(root,'guest-provisioning.json'), JSON.stringify({ password: randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 });
  boot = await run(bridge ? '--bridge' : '--boot');
  if (!boot.some(value => value.running === true && value.nativeWindowCreated === true && value.hostInputInjection === false)
    || !boot.some(value => value.ownedGuestViewCaptured === true) || !boot.some(value => value.vmStopped === true)) throw new Error('macos-vm-boot-unverified');
  if (bridge) {
    if (!boot.some(value=>value.guestTrialCompleted === true) || !boot.some(value=>value.ownedGuestTargetCaptured === true)) throw new Error('macos-vm-bridge-unverified');
    await request('vm-boundary-verify');
  }
  await rm(join(root,'guest-provisioning.json'));
  cancellation = await run('--boot', true);
  if (!cancellation.some(value => value.ownedCancellationReceived === true) || !cancellation.some(value => value.vmStopped === true)) throw new Error('macos-vm-cancellation-unverified');
  await retainCapture();
  await request('vm-boundary-release'); boundaryReleased = true;
  await request('vm-complete',['--restore-sha256',ownership.sha256,'--vm-stopped']); trialCompleted = true;
  emit({ installed:true, bootStopped:true, cancellationStopped:true, guestProvisioningObservation:'Pending visual inspection; running/window flags alone do not prove desktop readiness' });
} catch (error) {
  failure = /^macos-vm-[a-z-]+$/.test(error.message) ? error.message : 'macos-vm-qualification-failed';
  if (bridge && nonce) {
    for (const name of ['agent-started.json','agent-failed.json']) {
      try { const report = await readGuestReport(join(root,'output'),name,nonce); emit({guestDiagnostic:name,...(name === 'agent-started.json' ? {started:report.started} : {failed:report.failed})}); }
      catch { /* Missing or hostile diagnostics never establish evidence. */ }
    }
  }
}
finally {
  process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
  try {
    if (child && child.exitCode === null && child.signalCode === null) throw new Error('macos-vm-process-cleanup-unverified');
    await retainCapture();
    await noFileHandles();
    const current = await lstat(root);
    if (current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid || current.isSymbolicLink() || await realpath(root) !== root) throw new Error('macos-vm-cleanup-ownership-unverified');
    if (!trialCompleted) await request('vm-abort');
    if (boundaryPrepared && !boundaryReleased) { await request('vm-boundary-release'); boundaryReleased = true; }
    const roles = ['Restore.ipsw','Disk.img'], identities = new Map();
    for (const name of roles) identities.set(name,await lstat(join(root,name)));
    const released = await request('vm-release',['--roles',...roles]);
    if (roles.some(name=>!released.released_roles.includes(name)) || !['complete','aborted'].includes(released.trial_outcome)) throw Error('macos-vm-release-unverified');
    for (const name of roles) {
      const path = join(root,name), before = identities.get(name), current = await lstat(path);
      if (!current.isFile() || current.uid !== owned.uid || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino
        || current.size !== before.size || current.mode !== before.mode || await realpath(path) !== path) throw Error('macos-vm-cleanup-ownership-unverified');
      await rm(path); if (await exists(path)) throw Error('macos-vm-role-cleanup-unverified');
    }
    emit({ ...(failure ? { failure } : {}), exactReleasedRolesRemoved:roles, retainedVMRoot:root, ownedProcessClosed:true, fileHandlesAbsent:true,
      availableBytes:await free(), milliseconds:Math.round(performance.now()-began) });
  } catch { emit({ ...(failure ? { failure } : {}), cleanup:'incomplete', retainedOwnership:join(root,'ownership.json') }); failure ??= 'macos-vm-cleanup-unverified'; }
}
process.exitCode = failure ? 1 : 0;
