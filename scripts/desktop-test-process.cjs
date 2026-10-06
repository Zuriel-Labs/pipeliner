'use strict';
// Explicit EaglePro developer runs only; excluded from every runtime package.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const root = fs.realpathSync(path.join(__dirname, '..'));
const home = '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-quality-closure-transaction-be11b6af99e84244';
const wrapper = home + '/test-artifacts-quality-groups';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = Object.freeze({
  [home + '/groups.py']: 'be11b6af99e842442800359cd0a5b2e70e1c5910391cae1fd517cac368595aa5',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-quality-65b461aef6d8e9c5/quality.py': '65b461aef6d8e9c5647f88784084e93f689e72d973ceddd51ed7383babc5f355',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-contracts-5f78740e471545f0/entry.py': 'c28a82fd39f72954690f78bbf595a9d115037470994aae6c6837e41cd1e4b59a',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-contracts-5f78740e471545f0/diagnostics.py': 'f286d78fd994a899598259f93b39e03d86808861843def203c3b3699656e2119',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-contracts-5f78740e471545f0/contracts.py': 'da1f02f84b1ef58a7a47fe77ab84cdd288e62448ab03ecc3a7db2fc2e0b14040',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-inventory-path-7521f09119f91ef1/entry.py': '7521f09119f91ef1c0b84b8e8e5643f88e542e0edfc2b0dbb0dc9938b1d7c5fd',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-inventory-path-7521f09119f91ef1/optimizer.py': '5621a13d6db2aae066eb9c15baf41603b694b7a0f3761ec23ff8b76a817d4148',
  '/Users/chris/.local/share/eaglepro-test-storage-candidates/pipeliner-54-inventory-diagnostic-963ec2607a2146f4/diagnostic.py': '963ec2607a2146f4a25279541ff067756428ba4d2d229b5cce1c01b0c16dc5eb',
});
const chromiumHome = '/Users/chris/.local/share/eaglepro-test-storage-candidates/chromium-singleton-95c420f82716';
const active = Symbol.for('pipeliner.developer.process-admission');
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
function owned(file, maximum = 262144) {
  if (fs.realpathSync(file) !== file) throw Error('test-process-file-unverified');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.size > maximum || before.mode & 0o022
      || bytes.length !== before.size || before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink()
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('test-process-file-unverified');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function privateDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700
    || fs.realpathSync(directory) !== directory) throw Error('test-process-directory-unverified');
  return info;
}
exports.activate = function activate({ run = process.env.TEST_ARTIFACT_RUN, node = process.execPath } = {}) {
  if (globalThis[active]) {
    if (globalThis[active].run !== run) throw Error('test-process-context-mismatch');
    return globalThis[active];
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || typeof run !== 'string'
    || !/^\/Volumes\/TESTING\/TestArtifacts\/projects\/pipeliner\/issues\/54\/runs\/[A-Za-z0-9-]+$/.test(run)) throw Error('test-process-context-required');
  const manifest = () => JSON.parse(owned(path.join(run, 'manifest.json'), 65536));
  const initial = manifest(), chromium = initial.diagnostic_context?.route === 'quality-explicit-closed-groups-inventory-chromium';
  const expected = { ...pins, ...(chromium ? {
    [chromiumHome + '/storage.py']: '6fbb08f51bf7f950672a4f7462983ae6b1b30253e880d336beb5955ec57e2de3',
    [chromiumHome + '/chromium_singleton.py']: 'ca4cf859353eb6889a58c36ba1d478aa9544a9f7ac9d1e3a9c2e6b4ee28ec10d',
  } : { '/Users/chris/.local/share/eaglepro-test-storage/storage.py': 'e4a75d6c2ff4ca1cd1135da2bba1a3e72b649127ab29c2a9aef1dc161b9426d6' }) };
  function verify() {
    const value = manifest();
    if (value.status !== 'running' || value.managed_by !== 'eaglepro-test-storage' || value.project !== 'pipeliner' || value.issue !== '54'
      || value.owner_uid !== process.getuid() || value.run_path !== run || value.volume_uuid !== '3F381C66-C7CC-4F8F-B3BE-E46151ACF674'
      || value.diagnostic_context?.route !== 'quality-explicit-closed-groups-inventory-' + (chromium ? 'chromium' : 'stable')
      || value.quality_groups?.version !== 1 || Object.keys(value.diagnostic_context.source_sha256).length !== Object.keys(expected).length
      || Object.entries(expected).some(([file, digest]) => value.diagnostic_context.source_sha256[file] !== digest || hash(owned(file)) !== digest)
      || ['tmp', 'logs', 'outputs', 'recordings'].some(name => value.paths?.[name] !== path.join(run, name))) throw Error('test-process-receipt-unverified');
    if (hash(owned(wrapper)) !== 'cb5f528f1c8dc810012c15450a0ed9a1f077031258f108a453a3063d99731048') throw Error('test-process-wrapper-unverified');
    return value;
  }
  const environment = { TEST_ARTIFACT_RUN: run, ...Object.fromEntries(['tmp','logs','outputs','recordings'].map(name => ['TEST_ARTIFACT_' + name.toUpperCase(), path.join(run, name)])),
    ...(chromium ? { TEST_ARTIFACT_CHROMIUM_HELPER: chromiumHome + '/storage.py', TEST_ARTIFACT_CHROMIUM_TMP: initial.chromium_singleton?.temp_path,
      MAC_CHROMIUM_TMPDIR: initial.chromium_singleton?.temp_path } : {}) };
  const storage = require('../desktop/test-storage.cjs').validateContext(root, environment);
  if (chromium) require('../desktop/test-storage.cjs').nativeTestEnvironment(storage, environment);
  const deadline = Date.now() + 15000;
  while (verify().quality_groups.enrollment_boundary_ready !== true) { if (Date.now() > deadline) throw Error('test-process-boundary-timeout'); pause(); }
  const hostNode = fs.realpathSync(node);
  const sourceHash = hash(owned(__filename)), gate = path.join(__dirname, 'desktop-test-process-gate.py'), gateHash = hash(owned(gate));
  const bootstrap = path.join(run, 'outputs', 'process-bootstrap.cjs'), gates = path.join(run, 'outputs', 'process-gates');
  const content = `'use strict';const fs=require('node:fs'),c=require('node:crypto');const file=${JSON.stringify(__filename)};if(c.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==${JSON.stringify(sourceHash)})throw Error('test-process-source-changed');require(file).activate({run:${JSON.stringify(run)},node:${JSON.stringify(hostNode)}});\n`;
  try { fs.writeFileSync(bootstrap, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || owned(bootstrap).toString() !== content) throw error; }
  try { fs.mkdirSync(gates, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateDirectory(gates);
  const original = cp.ChildProcess.prototype.spawn, syncSpawn = cp.spawnSync, syncExec = cp.execFileSync;
  const nodeArgs = (file, args) => {
    let isNode = false; try { isNode = fs.realpathSync(file) === hostNode; } catch { /* Preserve original launch error. */ }
    return isNode && Array.isArray(args) ? ['--require', bootstrap, ...args] : args;
  };
  // ponytail: one run lock serializes admission; preserve each production cancellation group.
  cp.ChildProcess.prototype.spawn = function(options) {
    const targetArgs = [options.args[0], ...nodeArgs(options.file, options.args.slice(1))];
    if (!options.detached) return original.call(this, { ...options, args: targetArgs });
    if (path.isAbsolute(options.file)) { try { fs.accessSync(options.file, fs.constants.X_OK); } catch { return original.call(this, options); } }
    verify();
    if (hash(owned(gate)) !== gateHash || hash(owned(__filename)) !== sourceHash || owned(bootstrap).toString() !== content) throw Error('test-process-source-changed');
    const lock = path.join(run, 'outputs', 'process-enrollment-lock'), until = Date.now() + 30000;
    let lockInfo;
    for (;;) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); lockInfo = privateDirectory(lock); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; privateDirectory(lock); if (Date.now() > until) throw Error('test-process-enrollment-lock-timeout'); pause(); }
    }
    let lease, info, nonce;
    try {
      const observed = verify().quality_groups, boundary = Date.now() + 15000;
      let current;
      do {
        current = verify().quality_groups;
        if (Date.now() > boundary) throw Error('test-process-next-audit-timeout');
        if (current.audit_count <= observed.audit_count) pause();
      } while (current.audit_count <= observed.audit_count);
      if (current.audit_count !== current.verified_pause_count || current.last_audit?.resume_errors?.length
        || !current.last_audit?.resumed.includes(initial.child_pid)) throw Error('test-process-audit-unverified');
      const before = current.registration_sequence;
      lease = fs.mkdtempSync(path.join(gates, 'child-')); info = privateDirectory(lease); nonce = randomUUID();
      const result = original.call(this, { ...options, file: '/opt/homebrew/bin/python3',
        args: ['/opt/homebrew/bin/python3', '-I', '-B', gate, lease, nonce, String(process.pid), options.file, ...targetArgs] });
      this.spawnfile = options.file; this.spawnargs = options.args;
      if (!this.pid) return result;
      const enrolled = syncSpawn(wrapper, ['enroll', '--repo', root, '--run', run, '--leader-pid', String(this.pid), ...(chromium ? ['--chromium-singleton'] : [])],
        { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
      if (enrolled.status !== 0 || enrolled.error) throw Error('test-process-enrollment-refused');
      const acknowledgment = JSON.parse(enrolled.stdout), receipt = verify();
      if (acknowledgment.version !== 1 || acknowledgment.accepted !== true || acknowledgment.leader_pid !== this.pid
        || acknowledgment.identity?.pid !== this.pid || acknowledgment.identity?.pgid !== this.pid || acknowledgment.identity?.sid !== this.pid
        || acknowledgment.identity?.uid !== process.getuid() || acknowledgment.sequence !== before + 1
        || receipt.quality_groups.registration_sequence !== acknowledgment.sequence
        || !receipt.quality_groups.registered_groups.some(group => group.leader === this.pid)) throw Error('test-process-acknowledgment-unverified');
      fs.writeFileSync(path.join(lease, 'release.json'), JSON.stringify({ nonce }), { flag: 'wx', mode: 0o600 });
      this[active] = Object.freeze({ sequence: acknowledgment.sequence, leader: this.pid });
      this.once('close', () => {
        const current = privateDirectory(lease);
        if (current.dev !== info.dev || current.ino !== info.ino || JSON.parse(owned(path.join(lease, 'release.json'))).nonce !== nonce) throw Error('test-process-gate-cleanup-unverified');
        fs.unlinkSync(path.join(lease, 'release.json')); fs.rmdirSync(lease);
      });
      return result;
    } catch (error) { if (this.pid) this.kill('SIGTERM'); throw error; }
    finally {
      const current = privateDirectory(lock);
      if (current.dev !== lockInfo.dev || current.ino !== lockInfo.ino) throw Error('test-process-lock-cleanup-unverified');
      fs.rmdirSync(lock);
    }
  };
  function sync(originalFunction, file, args, options) {
    if (!Array.isArray(args) && args && typeof args === 'object') { options = args; args = []; }
    if (options?.detached) throw Error('test-process-sync-detached-unqualified');
    return originalFunction(file, nodeArgs(file, args ?? []), options);
  }
  cp.spawnSync = (file, args, options) => sync(syncSpawn, file, args, options);
  cp.execFileSync = (file, args, options) => sync(syncExec, file, args, options);
  syncBuiltinESMExports();
  return globalThis[active] = Object.freeze({ run, bootstrap, route: chromium ? 'chromium' : 'stable' });
};
