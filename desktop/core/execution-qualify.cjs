'use strict';
// Local native qualification only; never package fixtures, probes or the roadmap.
const { app, BrowserWindow, ipcMain, protocol, session, nativeTheme } = require('electron');
const { join } = require('node:path');
const { mkdirSync, readFileSync, writeFileSync, realpathSync } = require('node:fs');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const directory = process.argv[process.argv.indexOf('--fixture-directory') + 1];
assert.ok(process.argv.includes('--fixture-directory')); assert.equal(realpathSync(directory), directory);
assert.ok(directory.startsWith('/private/tmp/pipeliner-execution-')); assert.equal(JSON.parse(readFileSync(join(directory, 'ownership.json'), 'utf8')).issue, 32);
const ui = join(directory, 'ui'); mkdirSync(ui, { mode: 0o700 });
app.setName('Pipeliner Execution Check'); app.setPath('userData', ui); app.setPath('crashDumps', join(ui, 'crashes'));
// Keep the qualification process alive long enough to verify closure and finish owned cleanup.
app.on('window-all-closed', () => {});
const origin = 'pipeliner-execution-test://app', url = `${origin}/index.html`;
protocol.registerSchemesAsPrivileged([{ scheme: 'pipeliner-execution-test', privileges: { standard: true, secure: true } }]);
const preload = join(directory, 'execution-preload.cjs');
writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('executionControl',{dispatch:payload=>ipcRenderer.invoke('execution:control',payload),onBlocked:callback=>ipcRenderer.on('execution:blocked',(_event,message)=>callback(message))});`, { mode: 0o600 });
let fixture, windows = [], complete = false, stage = 'startup'; const results = [], timings = [];
const delay = duration => new Promise(resolve => setTimeout(resolve, duration));
async function waitDOM(window, predicate, maximum = 20000) {
  const started = performance.now();
  do { if (await window.webContents.executeJavaScript(predicate)) return; await delay(100); } while (performance.now() - started < maximum);
  throw new Error('Native UI state timeout');
}
function key(window, keyCode) { window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); }
async function click(window, operation) {
  const point = await window.webContents.executeJavaScript(`(()=>{const r=document.querySelector('[data-operation="${operation}"]').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
async function finish(passed, error = null, cleanupFailed = false) {
  if (complete) return; complete = true;
  let resourcesClosed = !cleanupFailed;
  try { if (fixture) await fixture.close(); } catch { resourcesClosed = false; }
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  console.log(JSON.stringify({ passed: passed && resourcesClosed, stage, error, pid: process.pid, versions: process.versions, results, timings, resourcesClosed }));
  app.exit(passed && resourcesClosed ? 0 : 1);
}
app.whenReady().then(async () => {
  const { qualifyExecutionCore } = await import('./execution-fixture.mjs');
  const { createExecutionControlChannel, guardForegroundClose } = await import('./control.mjs');
  stage = 'restricted-worker-core'; const core = await qualifyExecutionCore(directory, name => console.log(JSON.stringify({ progress: name })));
  fixture = core.fixture; results.push(...core.results); stage = 'native-controls';
  nativeTheme.themeSource = 'dark';
  const assets = { 'index.html': join(__dirname, '../execution/index.html'), 'execution.css': join(__dirname, '../execution/execution.css'), 'execution.js': join(__dirname, '../execution/execution.js'), 'theme.css': join(__dirname, '../prototype/style.css') };
  protocol.handle('pipeliner-execution-test', request => {
    const name = Object.keys(assets).find(name => request.url === `${origin}/${name}`);
    if (!name || request.method !== 'GET') return new Response('Unavailable', { status: 404 });
    return new Response(readFileSync(assets[name]), { headers: { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, reply) => reply({ cancel: !Object.keys(assets).some(name => details.url === `${origin}/${name}`) }));
  const create = show => {
    const window = new BrowserWindow({ width: 760, height: 560, show, title: 'Pipeliner — Execution qualification', webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true } });
    windows.push(window); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) window.webContents.on(name, event => event.preventDefault());
    return window;
  };
  const window = create(true), foreign = create(false);
  const context = () => { const run = fixture.store.runtime.status('R_gentle'); return { target: 'R_gentle', label: 'Qualification repository', revision: run.epoch, binding: { runId: run.id, epoch: run.epoch } }; };
  const channel = createExecutionControlChannel(fixture.supervisor, { contents: window.webContents, url, context });
  ipcMain.handle('execution:control', (event, payload) => {
    const started = performance.now();
    try { return { ok: true, value: channel.dispatch(event, payload) }; }
    catch { return { ok: false, error: 'Control request denied' }; }
    finally { if (payload?.operation !== 'status') timings.push({ operation: ['pause', 'resume', 'stop'].includes(payload?.operation) ? payload.operation : 'invalid', milliseconds: Number((performance.now() - started).toFixed(3)) }); }
  });
  await Promise.all([window.loadURL(url), foreign.loadURL(url)]); await waitDOM(window, `document.getElementById('state').textContent==='Stopped'`);
  assert.equal(await window.webContents.executeJavaScript(`typeof require`), 'undefined');
  assert.equal(await foreign.webContents.executeJavaScript(`(async()=>!(await window.executionControl.dispatch({operation:'stop',contextRevision:${context().revision}})).ok)()`), true);
  assert.equal(await window.webContents.executeJavaScript(`(async()=>!(await window.executionControl.dispatch({operation:'stop',contextRevision:${context().revision},role:'pm'})).ok)()`), true);
  results.push({ name: 'actual-renderer-and-foreign-frame-restrictions', passed: true });
  foreign.destroy(); window.focus();
  const previous = context().revision;
  await click(window, 'resume'); await fixture.supervisor.settle('R_gentle'); await waitDOM(window, `document.getElementById('state').textContent==='Running'`);
  assert.ok(context().revision > previous);
  assert.equal(await window.webContents.executeJavaScript(`(async()=>!(await window.executionControl.dispatch({operation:'stop',contextRevision:${previous}})).ok)()`), true);
  await window.webContents.executeJavaScript(`document.querySelector('[data-operation="status"]').focus()`); key(window, 'Tab');
  await waitDOM(window, `document.activeElement.dataset.operation==='pause'`); key(window, 'Space');
  await delay(50); await fixture.supervisor.settle('R_gentle'); await waitDOM(window, `document.getElementById('state').textContent==='Paused'`);
  assert.equal(await window.webContents.executeJavaScript(`document.activeElement.dataset.operation`), 'pause');
  assert.ok(await window.webContents.executeJavaScript(`(()=>{const s=getComputedStyle(document.activeElement);return parseFloat(s.outlineWidth)>=3})()`));
  const capture = await window.webContents.capturePage(); const pixels = capture.toPNG(); writeFileSync(join(directory, 'controls-dark.png'), pixels, { mode: 0o600 });
  results.push({ name: 'native-pointer-keyboard-focus-and-verified-pause', passed: true, captureHash: createHash('sha256').update(pixels).digest('hex') });
  window.setSize(420, 640); await delay(100); assert.ok(await window.webContents.executeJavaScript(`document.documentElement.scrollWidth<=innerWidth`));
  nativeTheme.themeSource = 'light'; await delay(100); assert.ok(await window.webContents.executeJavaScript(`matchMedia('(prefers-color-scheme:light)').matches`));
  window.setSize(760, 700); window.webContents.setZoomFactor(2); await delay(100); assert.ok(await window.webContents.executeJavaScript(`document.documentElement.scrollWidth<=innerWidth`));
  window.webContents.setZoomFactor(1); nativeTheme.themeSource = 'dark';
  window.webContents.debugger.attach('1.3'); await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'forced-colors', value: 'active' }] });
  assert.ok(await window.webContents.executeJavaScript(`matchMedia('(prefers-reduced-motion:reduce)').matches&&matchMedia('(forced-colors:active)').matches`)); window.webContents.debugger.detach();
  results.push({ name: 'narrow-light-dark-scaling-high-contrast-and-reduced-motion', passed: true, assistiveTechnology: 'not run' });
  await click(window, 'resume'); await fixture.supervisor.settle('R_gentle'); await waitDOM(window, `document.getElementById('state').textContent==='Running'`);
  guardForegroundClose(window, { supervisor: fixture.supervisor, isLastWindow: () => true, backgroundEnabled: () => false });
  const closed = new Promise(resolve => window.once('closed', resolve)); window.close(); await closed;
  assert.equal(fixture.store.runtime.status('R_gentle').control, 'paused'); assert.equal(fixture.store.runtime.status('R_gentle').releasedAt, null);
  results.push({ name: 'actual-final-window-close-pauses-background-off', passed: true }); await finish(true);
}).catch(error => { if (error.partialResults) results.push(...error.partialResults); finish(false, `${error.message}${error.cause ? ': '+JSON.stringify(error.cause) : ''}`, error.cleanupFailed === true); });
