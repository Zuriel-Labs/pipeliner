'use strict';
// Explicit test entry points only. Real profiles never call this owner.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  const checked = execute('/Users/chris/.local/bin/test-artifacts',
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

module.exports = { classifyStartup, validateContext, validateOwnedDataDirectory, configureOwnedPaths };
