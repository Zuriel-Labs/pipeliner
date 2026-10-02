'use strict';
const { app, BrowserWindow, Menu, protocol, session, ipcMain, dialog, shell, safeStorage } = require('electron');
const { mkdirSync, lstatSync, realpathSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const origin = 'pipeliner://app', url = `${origin}/index.html`;
const argument = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const qualifying = process.argv.includes('--qualify');
const entryStarted = performance.now(); let windowReadyMs;
const dataDirectory = argument('--data-directory') ?? path.join(app.getPath('appData'), 'Pipeliner');
const helper = argument('--key-helper');
app.setName('Pipeliner'); app.setPath('userData', dataDirectory); app.setPath('crashDumps', path.join(dataDirectory, 'crashes'));
protocol.registerSchemesAsPrivileged([{ scheme: 'pipeliner', privileges: { standard: true, secure: true } }]);
if (!app.requestSingleInstanceLock()) app.exit(0);
let window, manager, vault, closing = false, verifiedClose = false;
const moduleAt = file => import(pathToFileURL(path.join(__dirname, file)).href);
const assets = new Map(['index.html', 'app.css', 'app.mjs'].map(file => [file, path.join(__dirname, file)]));
assets.set('commands.mjs', path.join(__dirname, '../connections/commands.mjs')); assets.set('tokens.css', path.join(__dirname, '../prototype/style.css'));
function asset(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'pipeliner:' && parsed.host === 'app' && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash && assets.has(parsed.pathname.slice(1)) ? parsed.pathname.slice(1) : null; }
  catch { return null; }
}

app.whenReady().then(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('host-unqualified');
  mkdirSync(dataDirectory, { mode: 0o700, recursive: true });
  const directory = realpathSync(dataDirectory), info = lstatSync(dataDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid() || directory !== path.resolve(dataDirectory)) throw new Error('storage-directory-invalid');
  const { createConnectionManager } = await moduleAt('../connections/manager.mjs');
  const { createConnectionControlChannel } = await moduleAt('../core/control.mjs');
  const { githubAdapter } = await moduleAt('../connections/github.mjs');
  const { codexAdapter, ollamaAdapter } = await moduleAt('../connections/providers.mjs');
  const { nativeKeyEntry } = await moduleAt('../connections/native-entry.mjs');
  const activeConnections = new Set();
  const publish = snapshot => {
    let returned = false;
    for (const connection of snapshot.connections) { if (activeConnections.has(connection.id) && !connection.busy) returned = true; if (connection.busy) activeConnections.add(connection.id); else activeConnections.delete(connection.id); }
    if (window && !window.isDestroyed()) { window.webContents.send('connections:status', snapshot); if (returned && !closing) { window.show(); window.focus(); window.webContents.focus(); } }
  };
  let adapters = {
    github: githubAdapter({ prompt: githubPrompt }), 'github-setup': githubAdapter({ setup: true, prompt: githubPrompt }),
    codex: codexAdapter({ directory, openBrowser: async value => { await shell.openExternal(value); } }),
    ollama: ollamaAdapter({ entry: signal => nativeKeyEntry(helper, directory, signal) }),
  };
  if (qualifying) adapters = await require('./qualify.cjs').adapters({ directory, helper, nativeKeyEntry });
  manager = createConnectionManager({ vault: null, adapters, onChange: publish });
  protocol.handle('pipeliner', request => {
    const name = request.method === 'GET' ? asset(request.url) : null;
    if (!name) return new Response('Unavailable', { status: 404 });
    return new Response(readFileSync(assets.get(name)), { headers: { 'Content-Type': `${name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !asset(details.url) }));
  window = new BrowserWindow({ width: 1180, height: 840, minWidth: 420, minHeight: 580, show: false, title: 'Pipeliner', backgroundColor: '#101722',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) window.webContents.on(event, e => e.preventDefault());
  const channel = () => createConnectionControlChannel(manager, { contents: window.webContents, url, context: () => ({ revision: manager.status().revision }) });
  ipcMain.handle('connections:control', (event, payload) => { if (closing) throw new Error('App closing'); return channel().dispatch(event, payload); });
  window.on('close', async event => {
    if (verifiedClose) return; event.preventDefault(); if (closing) return; closing = true;
    try { await manager.close(); vault?.close(); verifiedClose = true; window.close(); }
    catch { closing = false; publish(manager.status()); }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Pipeliner', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => window.webContents.executeJavaScript("document.getElementById('settings-nav').click()") }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' } ] }, { role: 'windowMenu' }]));
  window.once('ready-to-show', () => { windowReadyMs = performance.now() - entryStarted; window.show(); }); await window.loadURL(url);
  try {
    const { openVault } = await moduleAt('../connections/vault.mjs');
    vault = await openVault(directory, { available: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: text => safeStorage.encryptStringAsync(text), decrypt: bytes => safeStorage.decryptStringAsync(bytes) });
    if (closing) { vault.close(); return; }
    const initialRevision = manager.status().revision + 1;
    manager = createConnectionManager({ vault, adapters, onChange: publish, initialRevision }); publish(manager.status());
  } catch { publish(manager.status()); }
  if (qualifying) await require('./qualify.cjs').run({ window, directory, helper, vault, manager, channel: channel(), windowReadyMs });
}).catch(() => { console.error('Pipeliner could not start safely.'); app.exit(1); });

async function githubPrompt({ connection, verificationUri, userCode, signal, cancel }) {
  if (verificationUri !== 'https://github.com/login/device') throw new Error('provider-unavailable');
  signal.throwIfAborted(); await shell.openExternal(verificationUri); signal.throwIfAborted();
  const completed = new AbortController();
  // Keep the code visible throughout polling. Completing or closing the flow dismisses only this sheet.
  const display = async () => {
    for (;;) {
      const result = await dialog.showMessageBox(window, { type: 'info', title: 'Connect GitHub', message: connection === 'github-setup' ? 'Connect setup and personal Projects' : 'Connect scoped GitHub access', detail: `Enter this code on GitHub: ${userCode}\n\n${connection === 'github-setup' ? 'GitHub will request the approved repo/project setup grant. This remains separate from scoped execution access.' : 'Only the registered App and its installed repositories can be used.'}\n\nWaiting for authorization…`, buttons: ['Open GitHub', 'Cancel'], defaultId: 0, cancelId: 1, signal: AbortSignal.any([signal, completed.signal]) });
      if (signal.aborted || completed.signal.aborted) return;
      if (result.response === 1) { cancel(); return; }
      await shell.openExternal(verificationUri);
    }
  };
  const waiting = display().catch(() => cancel());
  return { async close() { completed.abort(); await waiting; } };
}
app.on('window-all-closed', () => { if (!qualifying) app.quit(); });
process.on('SIGTERM', () => app.quit());
