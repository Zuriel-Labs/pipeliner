'use strict';
// Generated task output runs in a temporary sandbox with no host bridge or network.
const { app, BrowserWindow, session } = require('electron');
const { readFileSync, writeFileSync, lstatSync, realpathSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = process.argv.find(value => value.startsWith('--task-root='))?.slice(12);
if (!root || realpathSync(root) !== resolve(root) || lstatSync(root).uid !== process.getuid() || (lstatSync(root).mode & 0o777) !== 0o700) throw new Error('task-root-invalid');
app.setPath('userData', join(root, 'renderer')); app.setPath('crashDumps', join(root, 'crashes'));
app.whenReady().then(async () => {
  const file = join(root, 'index.html'), url = pathToFileURL(file).href, started = performance.now(), checks = [];
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url }));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"] } }));
  session.defaultSession.on('will-download', event => event.preventDefault());
  const window = new BrowserWindow({ width: 1180, height: 840, show: true, title: 'Harbor Queue · synthetic skill task', backgroundColor: '#101722',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) window.webContents.on(event, e => e.preventDefault());
  const js = text => window.webContents.executeJavaScript(text);
  async function check(name, work) { try { await work(); checks.push({ name, passed: true }); } catch { checks.push({ name, passed: false }); throw new Error('task-check-failed'); } }
  let passed = false;
  try {
    await window.loadFile(file);
    await check('isolated-generated-output-no-host-or-network', async () => { assert.equal(await js("typeof require + ':' + typeof process + ':' + typeof window.pipeliner"), 'undefined:undefined:undefined'); assert.equal(await js("fetch('https://example.com').then(()=>false,()=>true)"), true); });
    await check('real-three-card-filter-and-live-count', async () => {
      assert.equal(await js("document.querySelectorAll('[data-issue-status]').length"), 3);
      await js("document.getElementById('filter-ready').click()");
      assert.equal(await js("Array.from(document.querySelectorAll('[data-issue-status]')).filter(node=>node.getBoundingClientRect().height>0).length"), 1);
      assert.match(await js("document.getElementById('queue-count').textContent"), /1/);
      await js("document.getElementById('filter-blocked').click()"); assert.equal(await js("Array.from(document.querySelectorAll('[data-issue-status]')).filter(node=>node.getBoundingClientRect().height>0).length"), 1);
      await js("document.getElementById('filter-all').click()"); assert.match(await js("document.getElementById('queue-count').textContent"), /3/);
    });
    await check('real-keyboard-draft-addition-and-escaped-title', async () => {
      assert.equal(await js("document.querySelector('label[for=\"new-title\"]')!==null"), true);
      await js("document.getElementById('new-title').value='Review <em>Harbor</em> screen';document.getElementById('add-issue').focus()");
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await js("document.querySelectorAll('[data-issue-status]').length"), 4); assert.equal(await js("document.querySelectorAll('[data-issue-status] em').length"), 0);
      assert.match(await js('document.body.textContent'), /Review <em>Harbor<\/em> screen/);
    });
    await check('real-narrow-zoom-and-semantic-controls', async () => {
      assert.equal(await js("Array.from(document.querySelectorAll('button,input')).every(node=>node.getBoundingClientRect().height>=44)"), true);
      assert.equal(await js("document.getElementById('queue-count').getAttribute('aria-live')==='polite'||document.getElementById('queue-count').getAttribute('role')==='status'"), true);
      window.setSize(420, 760); for (const zoom of [1, 2]) { window.webContents.setZoomFactor(zoom); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); }
      window.webContents.setZoomFactor(1); window.setSize(1180, 840);
    });
    passed = true;
  } finally {
    await new Promise(resolve => setTimeout(resolve, 100)); writeFileSync(join(root, 'task-capture.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 });
    const report = { passed, checks, milliseconds: performance.now() - started, versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, sqlite: process.versions.sqlite },
      pending: ['Human usability and VoiceOver', 'Full Pipeliner app behavior', 'Native product installer', 'Other OS'] };
    writeFileSync(join(root, 'task-result.json'), JSON.stringify(report), { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify(report)); window.destroy(); app.exit(passed ? 0 : 1);
  }
}).catch(() => app.exit(1));
