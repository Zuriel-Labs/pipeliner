'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { APP_URL, assetName, validateRequest } = require('./protocol.cjs');
const started = performance.now();
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const output = argument('probe-output');
const dataPath = argument('probe-data');
if (!dataPath) throw new Error('Task-owned --probe-data path required');
mkdirSync(dataPath, { recursive: true });
writeFileSync(path.join(dataPath, 'main.pid'), String(process.pid));
app.setPath('userData', dataPath);
app.setPath('crashDumps', path.join(dataPath, 'crashes'));
app.setName('Pipeliner Shell Probe');
protocol.registerSchemesAsPrivileged([{ scheme: 'pipeliner-probe', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window;
let helper;
let helperBusy = false;
const events = [];
const log = (name, detail = {}) => {
  const event = { name, milliseconds: performance.now() - started, ...detail };
  events.push(event);
  console.log(JSON.stringify(event));
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const eventOnce = (emitter, name) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { emitter.removeListener(name, onEvent); reject(new Error(`Timeout: ${name}`)); }, 5000);
  function onEvent(...args) { clearTimeout(timeout); resolve(args); }
  emitter.once(name, onEvent);
});

function helperRequest(mode) {
  if (helperBusy) return Promise.reject(new Error('Helper diagnostic busy'));
  helperBusy = true;
  const executable = path.join(process.resourcesPath, 'probe-helper');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    helper = child;
    let bytes = '';
    let problem;
    const timeout = setTimeout(() => { problem = new Error('Helper deadline exceeded'); child.kill('SIGTERM'); }, 3000);
    child.on('spawn', () => log('helper-spawn', { pid: child.pid }));
    child.on('error', error => { problem = error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') problem = error; });
    child.stdout.on('data', chunk => {
      bytes += chunk.toString();
      if (bytes.length > 4096) { problem = new Error('Helper output exceeded bound'); child.kill('SIGTERM'); }
    });
    child.stderr.on('data', () => { problem = new Error('Helper reported an error'); });
    child.on('close', code => {
      clearTimeout(timeout);
      helper = undefined;
      helperBusy = false;
      log('helper-exit', { pid: child.pid, code });
      if (problem || code !== 0) return reject(problem ?? new Error(`Helper exited ${code}`));
      try { const reply = JSON.parse(bytes); assert.equal(reply.reply, 'pong'); resolve(reply); }
      catch { reject(new Error('Invalid helper reply')); }
    });
    child.stdin.end(mode === 'ping' ? 'ping\nstop\n' : 'fail\n');
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1100, height: 850, minWidth: 480, minHeight: 560, show: false,
    title: 'Pipeliner — Shell qualification', backgroundColor: '#10141b',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false },
  });
  const current = window;
  const contents = current.webContents;
  contents.setWindowOpenHandler(() => { log('popup-denied'); return { action: 'deny' }; });
  contents.on('will-navigate', event => { event.preventDefault(); log('navigation-denied'); });
  contents.on('will-frame-navigate', event => { event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('render-process-gone', (_event, details) => {
    log('renderer-gone', { reason: details.reason });
    if (!current.isDestroyed() && !process.argv.includes('--qualify')) contents.reload();
  });
  current.once('ready-to-show', () => { current.show(); log('ready-to-show', { visible: current.isVisible() }); });
  current.on('closed', () => { if (window === current) window = undefined; log('window-closed'); });
  contents.on('did-finish-load', () => log('renderer-loaded'));
  current.on('sheet-begin', () => log('native-sheet-begin'));
  current.on('sheet-end', () => log('native-sheet-end'));
  current.loadURL(APP_URL);
  return current;
}

app.whenReady().then(async () => {
  protocol.handle('pipeliner-probe', request => {
    const name = assetName(request.url);
    if (!name || request.method !== 'GET') return new Response('Unavailable', { status: 404 });
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
    return new Response(readFileSync(path.join(__dirname, name)), { headers: {
      'Content-Type': `${type}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
    } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assetName(details.url) }));
  for (const operation of ['ping', 'helper', 'dialog', 'status']) {
    ipcMain.handle(`shell:${operation}`, async (event, payload) => {
      validateRequest(operation, payload, { id: event.sender.id, expectedId: window?.webContents.id,
        mainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url });
      if (operation === 'ping') return { sequence: payload.sequence, reply: 'pong' };
      if (operation === 'helper') return helperRequest(payload.mode);
      if (operation === 'dialog') return dialog.showMessageBox(window, { type: 'info',
        title: 'Local shell check', message: 'Native dialog is available.', detail: 'No files or credentials are requested.', buttons: ['Return to checks'] });
      return { versions: process.versions, platform: process.platform, architecture: process.arch, background: 'off' };
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' },
      { label: 'Reopen qualification', accelerator: 'CmdOrCtrl+Shift+N', click: () => { if (window) window.show(); else createWindow(); } }] },
  ]));
  const initial = createWindow();
  if (process.argv.includes('--qualify')) await qualify(initial);
}).catch(error => { console.error(error); app.exit(1); });
app.on('activate', () => { if (!window) createWindow(); });
app.on('before-quit', () => { if (helper) helper.kill('SIGTERM'); log('quit'); });
app.on('window-all-closed', () => { /* Mac menu remains available; no executor or service exists. */ });

async function qualify(initial) {
  const checks = [];
  const result = { versions: process.versions, platform: process.platform, architecture: process.arch, checks, events };
  const check = (name, condition, detail) => { checks.push({ name, passed: Boolean(condition), detail }); assert.ok(condition, name); };
  try {
    const contents = initial.webContents;
    if (contents.isLoading()) await eventOnce(contents, 'did-finish-load');
    if (!initial.isVisible()) await eventOnce(initial, 'ready-to-show');
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    result.firstUsableMilliseconds = performance.now() - started;
    check('native-visible', initial.isVisible());
    const preferences = contents.getLastWebPreferences();
    check('renderer-preferences', preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration && preferences.webSecurity);
    const exposed = await contents.executeJavaScript(`({require: typeof require, process: typeof process, keys: Object.keys(window.shellProbe)})`);
    check('renderer-no-node-or-generic-ipc', exposed.require === 'undefined' && exposed.process === 'undefined'
      && exposed.keys.sort().join(',') === 'dialog,helper,ping,status', exposed);
    check('valid-ipc', (await contents.executeJavaScript('window.shellProbe.ping({sequence: 1})')).reply === 'pong');
    const denied = await contents.executeJavaScript(`(async () => {
      let rejected = 0;
      for (const payload of [null, {sequence:'1'}, {sequence:1, extra:1}, {sequence:-1}, {sequence:10001}]) {
        try { await window.shellProbe.ping(payload); } catch { rejected++; }
      }
      try { await window.shellProbe.helper({mode:'exec'}); } catch { rejected++; }
      return rejected;
    })()`);
    check('runtime-malformed-ipc', denied === 6, denied);
    const foreign = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await foreign.loadURL(APP_URL);
    const foreignRejected = await foreign.webContents.executeJavaScript(`window.shellProbe.ping({sequence:1}).then(() => false, () => true)`);
    foreign.destroy();
    check('runtime-foreign-sender', foreignRejected);
    const csp = await contents.executeJavaScript(`(async () => {
      let evalBlocked = false, networkBlocked = false;
      try { Function('return 1')(); } catch { evalBlocked = true; }
      try { await fetch('https://example.invalid/probe'); } catch { networkBlocked = true; }
      return {evalBlocked, networkBlocked, popup: window.open('https://example.invalid/') === null};
    })()`);
    check('csp-eval-network-popup', csp.evalBlocked && csp.networkBlocked && csp.popup, csp);
    await contents.executeJavaScript("location.href='https://example.invalid/'; void 0");
    await delay(100);
    check('navigation-blocked', contents.getURL() === APP_URL);
    const permissionDenied = await contents.executeJavaScript(`new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve(false), error => resolve(error.code === 1)))`);
    check('permission-denied', permissionDenied);
    result.feedbackMilliseconds = await contents.executeJavaScript(`(async () => {
      const samples=[];
      for(let i=0;i<100;i++){ const start=performance.now(); await window.shellProbe.ping({sequence:i});
        document.querySelector('#status').textContent='Connection reply verified';
        await new Promise(resolve=>requestAnimationFrame(resolve)); samples.push(performance.now()-start); }
      return samples;
    })()`);
    result.helperMilliseconds = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      const reply = await helperRequest('ping');
      check(`packaged-helper-${index + 1}`, reply.architecture === 'arm64');
      result.helperMilliseconds.push(performance.now() - start);
    }
    let failed = false;
    try { await helperRequest('fail'); } catch (error) { failed = error.message === 'Helper exited 23'; }
    check('helper-failure', failed);
    check('helper-recovery', (await helperRequest('ping')).reply === 'pong');
    initial.setSize(600, 700); await delay(100);
    check('native-resize', initial.getSize().join(',') === '600,700');
    log('native-before-minimize', { visible: initial.isVisible(), focused: initial.isFocused(), minimizable: initial.isMinimizable(), enabled: initial.isEnabled() });
    const minimizing = eventOnce(initial, 'minimize').then(() => true, () => false);
    initial.minimize();
    const minimizeObserved = await minimizing;
    checks.push({ name: 'native-minimize', passed: minimizeObserved && initial.isMinimized(), detail: { event: minimizeObserved, minimized: initial.isMinimized() } });
    if (initial.isMinimized()) {
      const restoring = eventOnce(initial, 'restore'); initial.restore(); await restoring;
      check('native-restore-event', !initial.isMinimized());
    } else checks.push({ name: 'native-restore-event', passed: false, status: 'blocked', detail: 'No minimized state to restore.' });
    initial.focus(); await delay(100);
    check('native-restore-focus', !initial.isMinimized() && initial.isFocused());
    const sheetEnded = eventOnce(initial, 'sheet-end').then(() => true, () => false);
    const dialogAbort = new AbortController();
    const timer = setTimeout(() => dialogAbort.abort(), 400);
    const dialogReply = await dialog.showMessageBox(initial, { message: 'Native qualification dialog', buttons: ['Return'], cancelId: 0, signal: dialogAbort.signal });
    clearTimeout(timer);
    const sheetClosed = await sheetEnded;
    check('native-dialog-api-open-cancel', dialogReply.response === 0 && sheetClosed);
    const keyboard = await contents.executeJavaScript(`({buttons:[...document.querySelectorAll('button')].map(b=>({name:b.textContent,enabled:!b.disabled})), overflow:document.documentElement.scrollWidth>innerWidth})`);
    check('narrow-semantic-controls', keyboard.buttons.length === 4 && keyboard.buttons.every(b=>b.enabled) && !keyboard.overflow, keyboard);
    contents.setZoomFactor(1.5); await delay(100);
    check('text-scale-reflow', await contents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'));
    contents.setZoomFactor(1);
    await delay(100);
    if (output) writeFileSync(path.join(path.dirname(output), 'surface.png'), (await contents.capturePage()).toPNG());
    await contents.debugger.attach('1.3');
    const ax = await contents.debugger.sendCommand('Accessibility.getFullAXTree');
    contents.debugger.detach();
    const buttonNames = ax.nodes.filter(node => node.role?.value === 'button').map(node => node.name?.value);
    check('web-accessibility-tree', buttonNames.includes('Check connection') && buttonNames.includes('Open native dialog'), buttonNames);
    log('renderer-crash-request', { pid: contents.getOSProcessId() });
    const crashed = eventOnce(contents, 'render-process-gone'); contents.forcefullyCrashRenderer(); await crashed;
    const reloaded = eventOnce(contents, 'did-finish-load'); contents.reload(); await reloaded;
    check('renderer-crash-recovery', (await contents.executeJavaScript('window.shellProbe.ping({sequence:1})')).reply === 'pong');
    result.processMetrics = app.getAppMetrics();
    result.warmWindowMilliseconds = [];
    for (let index = 0; index < 5; index++) {
      const closed = eventOnce(window, 'closed'); window.close(); await closed;
      const start = performance.now(); const next = createWindow();
      await eventOnce(next.webContents, 'did-finish-load');
      await next.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      result.warmWindowMilliseconds.push(performance.now() - start);
      check(`native-close-reopen-${index + 1}`, !next.isDestroyed());
    }
    result.passed = checks.every(item => item.passed);
  } catch (error) {
    result.passed = false; result.error = error.message;
    if (window && !window.isDestroyed()) result.windowState = { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), enabled: window.isEnabled() };
    console.error(error);
  }
  finally {
    if (helper) helper.kill('SIGTERM');
    if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    log('qualification-result', { passed: result.passed });
    app.exit(result.passed ? 0 : 1);
  }
}
