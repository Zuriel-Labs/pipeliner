'use strict';
// Explicit test entry points only. Real profiles never call this owner.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const chromiumHome = '/Users/chris/.local/share/eaglepro-test-storage-candidates/chromium-singleton-95c420f82716';
const chromiumLauncher = chromiumHome + '/test-artifacts';
const chromiumHelper = chromiumHome + '/storage.py';
const chromiumHashes = Object.freeze({
  'test-artifacts': '94c8f53da77642d71bcfeee02b8f5da07ddbfd6fad5c2e81dfb8ba9401739510',
  'storage.py': '6fbb08f51bf7f950672a4f7462983ae6b1b30253e880d336beb5955ec57e2de3',
  'chromium_singleton.py': 'ca4cf859353eb6889a58c36ba1d478aa9544a9f7ac9d1e3a9c2e6b4ee28ec10d',
});

function readOwnedFile(file, maximum, io = fs, uid = process.getuid()) {
  if (io.realpathSync(file) !== file) throw new Error('test-storage-file-unverified');
  const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = io.fstatSync(fd);
    if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || info.size > maximum
      || (info.mode & 0o022)) throw new Error('test-storage-file-unverified');
    return io.readFileSync(fd, 'utf8');
  } finally { io.closeSync(fd); }
}

function nativeTestLauncher() {
  for (const [name, hash] of Object.entries(chromiumHashes)) {
    if (createHash('sha256').update(readOwnedFile(path.join(chromiumHome, name), 262144)).digest('hex') !== hash) {
      throw new Error('test-storage-chromium-helper');
    }
  }
  return chromiumLauncher;
}

function classifyStartup(arguments_, environment = process.env) {
  const qualifying = arguments_.some(value => /^--qualify(?:-|=|$)/i.test(value));
  const explicit = arguments_.filter(value => /^--test-data-directory(?:=|$)/i.test(value));
  const legacy = arguments_.find(value => value.startsWith('--data-directory='));
  if (explicit.length > 1 || (explicit.length && legacy)) throw new Error('test-storage-option-conflict');
  const testMode = qualifying || explicit.length > 0 || Boolean(legacy && environment.TEST_ARTIFACT_RUN);
  let testDirectory;
  if (explicit.length) {
    const prefix = '--test-data-directory=';
    if (!explicit[0].startsWith(prefix) || !explicit[0].slice(prefix.length)) {
      throw new Error('test-storage-directory-required');
    }
    testDirectory = explicit[0].slice(prefix.length);
  } else if (testMode && legacy) { testDirectory = legacy.slice('--data-directory='.length); }
  // Unmarked --data-directory retains ordinary source-profile selection. It
  // produces no synthetic/native qualification evidence. Test runners use the
  // explicit test option; legacy overrides inside a managed test run are checked.
  return Object.freeze({ qualifying, testMode, testDirectory });
}

function validateContext(repository, environment = process.env, execute = spawnSync) {
  if (!environment.TEST_ARTIFACT_RUN) throw new Error('test-storage-run-required');
  if (environment.TEST_ARTIFACT_CHROMIUM_HELPER && environment.TEST_ARTIFACT_CHROMIUM_HELPER !== chromiumHelper) {
    throw new Error('test-storage-chromium-helper');
  }
  const launcher = environment.TEST_ARTIFACT_CHROMIUM_HELPER ? nativeTestLauncher() : '/Users/chris/.local/bin/test-artifacts';
  const checked = execute(launcher,
    ['validate-run', '--repo', repository, '--run', environment.TEST_ARTIFACT_RUN],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
  if (checked.status !== 0 || checked.error) throw new Error('test-storage-preflight-failed');
  const storage = JSON.parse(checked.stdout);
  if (!storage.verified || storage.project !== 'pipeliner'
    || storage.volume_uuid !== '3F381C66-C7CC-4F8F-B3BE-E46151ACF674'
    || storage.run_path !== environment.TEST_ARTIFACT_RUN
    || ['tmp', 'logs', 'recordings', 'outputs'].some(name =>
      environment['TEST_ARTIFACT_' + name.toUpperCase()] !== storage.paths?.[name])) {
    throw new Error('test-storage-context-mismatch');
  }
  return storage;
}

function nativeTestEnvironment(storage, environment = process.env, io = fs, uid = process.getuid()) {
  try {
    const base = '/Volumes/TESTING/TestArtifacts', run = storage.run_path;
    const relative = path.relative(base, run);
    if (!/^projects\/pipeliner\/issues\/[^/]+\/runs\/[^/]+$/.test(relative)
      || environment.TEST_ARTIFACT_RUN !== run || !storage.verified || storage.project !== 'pipeliner') throw new Error();
    const temp = path.join(base, 'manifests', 'chromium-' + createHash('sha256').update(relative).digest('hex').slice(0,16));
    if (environment.TEST_ARTIFACT_CHROMIUM_HELPER !== chromiumHelper
      || environment.TEST_ARTIFACT_CHROMIUM_TMP !== temp || environment.MAC_CHROMIUM_TMPDIR !== temp) throw new Error();
    const metadata = JSON.parse(readOwnedFile(path.join(run, 'manifest.json'), 65536, io, uid));
    const record = metadata.chromium_singleton, device = io.lstatSync(storage.paths.tmp).dev;
    if (metadata.managed_by !== 'eaglepro-test-storage' || metadata.owner_uid !== uid || metadata.status !== 'running'
      || metadata.project !== 'pipeliner' || metadata.run_path !== run || metadata.volume_uuid !== storage.volume_uuid
      || storage.volume_uuid !== '3F381C66-C7CC-4F8F-B3BE-E46151ACF674'
      || ['tmp','logs','recordings','outputs'].some(name => metadata.paths?.[name] !== path.join(run,name) || storage.paths[name] !== path.join(run,name))
      || record?.version !== 1 || record.project !== 'pipeliner' || record.run_path !== run || record.temp_path !== temp
      || !['prepared','starting','active'].includes(record.phase) || record.ipc_limit_bytes !== 65536
      || record.profile_pattern !== 'pipeliner-app-[A-Za-z0-9]{6}' || !Array.isArray(record.temp_identity)
      || record.temp_identity.length !== 6 || !record.bindings || typeof record.bindings !== 'object'
      || Array.isArray(record.bindings)) throw new Error();
    for (const directory of [path.dirname(temp), temp]) {
      const info = io.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.dev !== device
        || (info.mode & 0o022) || (directory === temp && (info.mode & 0o777) !== 0o700)
        || io.realpathSync(directory) !== directory) throw new Error();
      if (directory === temp && JSON.stringify([info.dev,info.ino,info.uid,info.mode,null,null]) !== JSON.stringify(record.temp_identity)) throw new Error();
    }
    return Object.freeze({ TEST_ARTIFACT_CHROMIUM_HELPER: chromiumHelper, TEST_ARTIFACT_CHROMIUM_TMP: temp, MAC_CHROMIUM_TMPDIR: temp });
  } catch { throw new Error('test-storage-chromium-context'); }
}

function validateOwnedDataDirectory(storage, directory, io = fs, uid = process.getuid()) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('test-storage-data-outside-run');
  const root = storage.paths.tmp, resolved = path.resolve(directory);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('test-storage-data-outside-run');
  }
  const device = io.lstatSync(root).dev;
  function owned(candidate) {
    const info = io.lstatSync(candidate);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.dev !== device
      || (info.mode & 0o077) !== 0 || io.realpathSync(candidate) !== candidate) {
      throw new Error('test-storage-directory-unverified');
    }
  }
  owned(root);
  let component = root;
  for (const name of relative.split(path.sep)) { component = path.join(component, name); owned(component); }
  return { resolved, owned };
}

function configureOwnedPaths(app, storage, directory, io = fs, uid = process.getuid()) {
  if (app.isReady()) throw new Error('test-storage-startup-too-late');
  const { resolved, owned } = validateOwnedDataDirectory(storage, directory, io, uid);
  const destinations = { userData: resolved, temp: path.join(resolved, 'temporary'),
    sessionData: path.join(resolved, 'session'), crashDumps: path.join(resolved, 'crashes'),
    logs: path.join(resolved, 'logs') };
  for (const [key, destination] of Object.entries(destinations)) {
    if (key !== 'userData') {
      try { io.mkdirSync(destination, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      owned(destination);
    }
  }
  // Precreate owned private directories before Electron can create sessions/logs.
  for (const name of ['userData', 'temp', 'sessionData', 'crashDumps']) app.setPath(name, destinations[name]);
  app.setAppLogsPath(destinations.logs);
  return Object.freeze(destinations);
}

module.exports = { classifyStartup, validateContext, validateOwnedDataDirectory, configureOwnedPaths,
  nativeTestEnvironment, nativeTestLauncher, chromiumLauncher };
