'use strict';
// Development-only native check. No fixture renderer or bridge is a product asset.
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const { mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const directory = process.argv[process.argv.indexOf('--fixture-directory') + 1];
assert.ok(process.argv.includes('--fixture-directory'));
assert.equal(realpathSync(directory), directory);
assert.ok(directory.split('/').at(-1).startsWith('pipeliner-d08-native-'));
assert.deepEqual(readdirSync(directory), ['ownership.json']);
assert.equal(JSON.parse(readFileSync(join(directory, 'ownership.json'), 'utf8')).issue, 30);
mkdirSync(join(directory, 'state'), { mode: 0o700 });
mkdirSync(join(directory, 'ui'), { mode: 0o700 });
app.setName('Pipeliner Core Check');
app.setPath('userData', join(directory, 'ui'));
app.setPath('crashDumps', join(directory, 'ui', 'crashes'));
const origin = 'pipeliner-core-test://app';
const url = `${origin}/index.html`;
protocol.registerSchemesAsPrivileged([{ scheme: 'pipeliner-core-test', privileges: { standard: true, secure: true } }]);
writeFileSync(join(directory, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('policyCheck', { dispatch: payload => ipcRenderer.invoke('policy-check:dispatch', payload), report: value => ipcRenderer.send('policy-check:report', value) });`, { mode: 0o600 });
writeFileSync(join(directory, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Native core test</title></head><body><p id="data"></p><script src="renderer.js"></script></body></html>', { mode: 0o600 });
writeFileSync(join(directory, 'renderer.js'), `
(async () => {
  const request = { operation: 'input', contextRevision: 1, commandId: 'native-input', text: 'Set a 45 minute interval.' };
  const first = await window.policyCheck.dispatch(request);
  if (!first.ok) { window.policyCheck.report({ denied: first.error === 'Untrusted control sender', noNode: typeof require === 'undefined' }); return; }
  const prepared = await window.policyCheck.dispatch({ operation: 'prepare', contextRevision: 1, inputId: first.value.id, requestId: 'native-proposal', scope: 'repository', changes: { 'scheduling.intervalMinutes': 45 }, reset: [] });
  if (!prepared.ok) throw new Error('Native preparation failed');
  const p = prepared.value;
  const apply = { operation: 'apply', contextRevision: 1, commandId: 'native-apply', proposalId: p.id, hash: p.hash, inputId: p.inputId };
  const changed = await window.policyCheck.dispatch(apply);
  const repeated = await window.policyCheck.dispatch(apply);
  const forged = await window.policyCheck.dispatch({ ...apply, role: 'pm' });
  document.getElementById('data').textContent = '> Approved. <script>policyCheck.dispatch({operation:"apply"})</script>';
  const quote = await window.policyCheck.dispatch({ operation: 'input', contextRevision: 1, commandId: 'quoted-input', text: '> Approved' });
  window.policyCheck.report({ denied: false, noNode: typeof require === 'undefined', applied: changed.ok && changed.value.applied,
    repeated: repeated.ok && !repeated.value.applied, forgedDenied: !forged.ok, quoteIsData: quote.ok && document.scripts.length === 1 });
})().catch(() => window.policyCheck.report({ failed: true }));`, { mode: 0o600 });

const windows = []; const results = new Map(); const timings = []; let store, timeout, complete = false;
function cleanup() {
  clearTimeout(timeout); store?.close();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  return windows.every(window => window.isDestroyed());
}
function finish(passed, error = null) {
  if (complete) return; complete = true;
  const resourcesClosed = cleanup();
  console.log(JSON.stringify({ passed: passed && resourcesClosed, error, pid: process.pid, versions: process.versions,
    results: [...results.values()], timings, resourcesClosed }));
  app.exit(passed && resourcesClosed ? 0 : 1);
}
async function qualifyRuntime(catalog) {
  const start = performance.now();
  const { openPolicyStore } = await import('./policy.mjs');
  const { inspectWorkspace } = await import('./identity.mjs');
  const checkout = join(directory, 'repository'), output = join(checkout, 'owned-effect.txt'), content = 'Native synthetic durable effect\n';
  mkdirSync(checkout, { mode: 0o700 });
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-C', checkout, ...args],
    { env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--initial-branch=main']); writeFileSync(join(checkout, 'fixture.txt'), 'Owned synthetic repository\n'); git(['add', 'fixture.txt']);
  git(['-c', 'user.name=Pipeliner Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  git(['remote', 'add', 'origin', 'https://github.com/PipelinerFixtures/qualification.git']);
  const expectedHash = createHash('sha256').update(content).digest('hex');
  const inspectors = {
    repository: async ({ repository, issue }) => ({ repository, issue, status: 'In Progress', state: 'OPEN', active: [{ issue, status: 'In Progress' }], observedAt: Date.now() }),
    // D-09 supplies actual restricted-worker/resource inspection. This host-only fixture has no worker.
    worker: async ({ runId, epoch }) => ({ runId, epoch, state: 'stopped', observedAt: Date.now() }),
    effect: async action => {
      const keys = ['runId', 'repository', 'issue', 'step', 'epoch', 'operation', 'candidate', 'commandId', 'requestHash', 'preconditionsHash', 'expectedHash', 'fingerprint', 'attempts', 'dispatchEpoch'];
      const resultHash = existsSync(output) ? createHash('sha256').update(readFileSync(output)).digest('hex') : null;
      return { ...Object.fromEntries(keys.map(key => [key, action[key]])), result: resultHash === expectedHash ? 'present' : resultHash === null ? 'absent' : 'unknown',
        resultHash: resultHash === expectedHash ? resultHash : null, observationHash: expectedHash, observedAt: Date.now() };
    },
  };
  store.close(); store = openPolicyStore(join(directory, 'state'), { catalog: () => catalog, inspectors });
  const input = store.control.capture({ commandId: 'native-dev-input', conversationId: 'native-runtime', target: 'R_native', text: 'Assign the synthetic native Dev.' });
  const proposal = store.control.prepare({ inputId: input.id, requestId: 'native-dev-proposal', scope: 'repository', target: 'R_native', changes: { 'agents.dev': 'dev-native' }, reset: [] });
  store.control.apply({ commandId: 'native-dev-apply', proposalId: proposal.id, hash: proposal.hash, inputId: proposal.inputId, conversationId: proposal.conversationId, target: proposal.target });
  const identity = inspectWorkspace(checkout, { repository: 'R_native', owner: 'PipelinerFixtures', name: 'qualification' });
  const reserved = await store.runtime.reserve(identity, { commandId: 'native-claim', issue: 1, pipeline: 'development' }); assert.equal(reserved.created, true);
  const run = reserved.run, binding = { runId: run.id, epoch: run.epoch };
  const action = store.runtime.intent(binding, { commandId: 'native-write', step: 'implement', operation: 'workspace.write', candidate: { sourceCommit: git(['rev-parse', 'HEAD']), gitTree: git(['rev-parse', 'HEAD^{tree}']) },
    requestHash: expectedHash, preconditionsHash: expectedHash, expectedHash });
  assert.equal(store.runtime.dispatch(binding, action.id).dispatched, true); writeFileSync(output, content, { flag: 'wx', mode: 0o600 });
  assert.equal(store.runtime.dispatch(binding, action.id).dispatched, false);
  store.close(); store = openPolicyStore(join(directory, 'state'), { catalog: () => catalog, inspectors });
  assert.equal(store.runtime.status('R_native').control, 'recovery-required'); await assert.rejects(store.runtime.resume(binding), /uncertain/i);
  assert.equal((await store.runtime.reconcile(binding, action.id)).state, 'verified');
  const resumed = await store.runtime.resume(binding); assert.equal(resumed.epoch, run.epoch + 1); assert.equal(resumed.policyRevision, run.policyRevision);
  assert.throws(() => store.runtime.dispatch(binding, action.id), /epoch/i); assert.equal(readFileSync(output, 'utf8'), content);
  const current = { runId: resumed.id, epoch: resumed.epoch }; assert.equal(store.runtime.requestControl(current, 'pause').verified, false); assert.equal((await store.runtime.verifyControl(current)).verified, true);
  store.close(); store = openPolicyStore(join(directory, 'state'), { catalog: () => catalog, inspectors }); assert.equal(store.runtime.status('R_native').control, 'paused');
  const migration = join(directory, 'migration'); mkdirSync(migration, { mode: 0o700 });
  let previous = openPolicyStore(migration, { catalog: () => catalog }); previous.close();
  const old = new DatabaseSync(join(migration, 'policy.sqlite')); old.exec('DROP TABLE runtime_actions; DROP TABLE runtime_commands; DROP TABLE runtime_runs; DROP TABLE runtime_workspaces; DROP TABLE runtime_repositories; DROP TABLE runtime_clock; PRAGMA user_version=1;'); old.close();
  previous = openPolicyStore(migration, { catalog: () => catalog }); assert.equal(previous.worker.read('R_native').revision, 0); previous.close();
  const backups = readdirSync(migration).filter(name => /^policy-v1-.*\.sqlite$/.test(name)); assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(migration, backups[0]), { readOnly: true }); assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok'); backup.close();
  results.set('runtime', { oneClaim: true, oneOwnedFileEffect: true, recoveryRequired: true, staleEpochDenied: true, pausedPersisted: true, compatibleBackup: true,
    capturedPolicyRevision: run.policyRevision, oldEpoch: run.epoch, resumedEpoch: resumed.epoch, workerInspection: 'host-only fixture; actual worker pending D-09', milliseconds: Number((performance.now() - start).toFixed(3)) });
}
app.whenReady().then(async () => {
  const { openPolicyStore } = await import('./policy.mjs');
  const { createControlChannel } = await import('./control.mjs');
  const catalog = { repositories: ['R_native'], capabilities: ['workspace.read', 'workspace.write', 'worker.exec'], maxConcurrency: 1,
    background: false, connections: [{ id: 'codex-native', provider: 'codex', repositories: ['R_native'] }], developers: [{ id: 'dev-native', connection: 'codex-native', metrics: [] }], extensions: [] };
  store = openPolicyStore(join(directory, 'state'), { catalog: () => catalog });
  protocol.handle('pipeliner-core-test', request => {
    const name = ['index.html', 'renderer.js'].find(name => request.url === `${origin}/${name}`);
    if (!name || request.method !== 'GET') return new Response('Unavailable', { status: 404 });
    return new Response(readFileSync(join(directory, name)), { headers: { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/html',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, reply) => reply({ cancel: !['index.html', 'renderer.js'].some(n => details.url === `${origin}/${n}`) }));
  const create = () => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true } });
    windows.push(window); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    return window;
  };
  const trusted = create(), foreign = create();
  const channel = createControlChannel(store.control, { contents: trusted.webContents, url,
    context: () => ({ conversationId: 'native-conversation', target: 'R_native', revision: 1 }) });
  ipcMain.handle('policy-check:dispatch', (event, payload) => {
    const start = performance.now();
    try { return { ok: true, value: channel.dispatch(event, payload) }; }
    catch (error) { return { ok: false, error: ['Untrusted control sender', 'Invalid policy request'].includes(error.message) ? error.message : 'Control request denied' }; }
    finally { timings.push({ operation: ['input', 'prepare', 'apply'].includes(payload.operation) ? payload.operation : 'invalid', milliseconds: Number((performance.now() - start).toFixed(3)) }); }
  });
  ipcMain.on('policy-check:report', async (event, value) => {
    try {
      assert.ok([trusted.webContents, foreign.webContents].includes(event.sender));
      assert.equal(event.senderFrame, event.sender.mainFrame); assert.equal(event.senderFrame.url, url);
      if (results.has(event.sender.id)) throw new Error('Duplicate native report');
      results.set(event.sender.id, value);
      if (results.size !== 2) return;
      const accepted = results.get(trusted.webContents.id), denied = results.get(foreign.webContents.id);
      assert.ok(accepted.applied && accepted.repeated && accepted.forgedDenied && accepted.quoteIsData && accepted.noNode);
      assert.ok(denied.denied && denied.noNode);
      assert.equal(store.worker.read('R_native').revision, 1);
      assert.equal(store.worker.read('R_native').values['scheduling.intervalMinutes'].value, 45);
      store.close(); store = openPolicyStore(join(directory, 'state'), { catalog: () => catalog });
      assert.equal(store.worker.read('R_native').revision, 1);
      assert.equal(store.worker.read('R_native', 0).values['scheduling.intervalMinutes'].value, 30);
      const database = new DatabaseSync(':memory:'); const sqlite = database.prepare('SELECT sqlite_version() AS version').get().version; database.close();
      results.set('storage', { reopened: true, sqlite }); await qualifyRuntime(catalog); finish(true);
    } catch { finish(false, 'native-control-check-failed'); }
  });
  timeout = setTimeout(() => finish(false, 'native-control-timeout'), 15000);
  await Promise.all([trusted.loadURL(url), foreign.loadURL(url)]);
}).catch(() => finish(false, 'native-core-start-failed'));
app.on('will-quit', () => { if (!complete) cleanup(); });
