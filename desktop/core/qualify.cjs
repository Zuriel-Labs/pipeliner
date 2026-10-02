'use strict';
// Development-only native check. No fixture renderer or bridge is a product asset.
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const { mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const directory = process.argv[process.argv.indexOf('--fixture-directory') + 1];
assert.ok(process.argv.includes('--fixture-directory'));
assert.equal(realpathSync(directory), directory);
assert.ok(directory.split('/').at(-1).startsWith('pipeliner-d07-native-'));
assert.deepEqual(readdirSync(directory), ['ownership.json']);
assert.equal(JSON.parse(readFileSync(join(directory, 'ownership.json'), 'utf8')).issue, 28);
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
app.whenReady().then(async () => {
  const { openPolicyStore } = await import('./policy.mjs');
  const { createControlChannel } = await import('./control.mjs');
  const catalog = { repositories: ['R_native'], capabilities: ['workspace.read', 'workspace.write', 'worker.exec'], maxConcurrency: 1,
    background: false, connections: [], developers: [], extensions: [] };
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
  ipcMain.on('policy-check:report', (event, value) => {
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
      results.set('storage', { reopened: true, sqlite }); finish(true);
    } catch { finish(false, 'native-control-check-failed'); }
  });
  timeout = setTimeout(() => finish(false, 'native-control-timeout'), 15000);
  await Promise.all([trusted.loadURL(url), foreign.loadURL(url)]);
}).catch(() => finish(false, 'native-core-start-failed'));
app.on('will-quit', () => { if (!complete) cleanup(); });
