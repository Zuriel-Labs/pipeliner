'use strict';
const { app, BrowserWindow, Menu, protocol, session } = require('electron');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const origin = 'pipeliner-prototype://app';
const assets = new Set(['index.html', 'style.css', 'state.mjs', 'renderer.mjs']);
const mime = { html: 'text/html', css: 'text/css', mjs: 'text/javascript' };
const dataPath = mkdtempSync(path.join(tmpdir(), 'pipeliner-prototype-'));
app.setPath('userData', dataPath);
app.setPath('crashDumps', path.join(dataPath, 'crashes'));
app.setName('Pipeliner Prototype');
protocol.registerSchemesAsPrivileged([{ scheme: 'pipeliner-prototype', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function asset(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'pipeliner-prototype:' || parsed.host !== 'app' || parsed.username || parsed.password
      || parsed.port || parsed.search || parsed.hash) return null;
    const name = parsed.pathname.slice(1);
    return assets.has(name) ? name : null;
  } catch { return null; }
}

let window;
function createWindow() {
  window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 560, minHeight: 580, show: false,
    title: 'Pipeliner · Experience prototype', backgroundColor: '#101722',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = undefined; });
  window.loadURL(`${origin}/index.html`);
  return window;
}

app.whenReady().then(async () => {
  protocol.handle('pipeliner-prototype', request => {
    const name = request.method === 'GET' ? asset(request.url) : null;
    if (!name) return new Response('Unavailable', { status: 404 });
    return new Response(readFileSync(path.join(__dirname, name)), { headers: {
      'Content-Type': `${mime[name.split('.').pop()]}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
    } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !asset(details.url) }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => window?.webContents.executeJavaScript("document.getElementById('settings-nav').click()") },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
    ] },
    { role: 'windowMenu' },
  ]));
  const first = createWindow();
  if (process.argv.includes('--qualify')) await require('./qualify.cjs')(first, dataPath);
}).catch(error => { console.error(error); app.exit(1); });

app.on('activate', () => { if (!window) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => rmSync(dataPath, { recursive: true, force: true }));
