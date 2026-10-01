'use strict';
// Local, purpose-limited qualification. Never invoked by framework checks or Actions.
const { app, BaseWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeliner-d05-'));
app.setPath('userData', directory);
app.setPath('crashDumps', path.join(directory, 'crashes'));
app.setName('Pipeliner Desktop · GitHub connection');
fs.writeFileSync(path.join(directory, 'ownership.json'), JSON.stringify({ issue: 26, pid: process.pid, directory }));
const cancellation = new AbortController();
let flow, credentials;
const permittedError = error => /^(http-\d{3}|cancelled|timeout|transport-failed|authorization-[a-z-]+|device-[a-z-]+|invalid-[a-z-]+|account-mismatch|installation-mismatch|repository-mismatch|incomplete-list|read-failed|reauthentication-required|token-request-denied)$/.test(error?.message)
  ? error.message : 'connection-check-failed';
app.on('before-quit', () => { cancellation.abort(); flow?.cancel(); credentials = null; });
app.on('will-quit', () => fs.rmSync(directory, { recursive: true, force: true }));
app.whenReady().then(async () => {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  // Native parent is required for cancellable macOS sheets; no web renderer or IPC is created.
  const window = new BaseWindow({ width: 660, height: 480, title: 'Pipeliner · GitHub connection' });
  window.on('closed', () => app.quit());
  if (process.argv.includes('--native-check')) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 500);
    try {
      const result = await dialog.showMessageBox(window, { type: 'info', title: 'Pipeliner · GitHub connection',
        message: 'Native connection surface check', detail: 'Synthetic check. No provider login or credential is requested.',
        buttons: ['Cancel check'], cancelId: 0, signal: control.signal });
      assert.equal(result.response, 0);
      console.log(JSON.stringify({ nativeDialog: 'opened-and-cancelled', versions: process.versions, platform: process.platform, architecture: process.arch }));
    } finally { clearTimeout(timer); }
    app.quit();
    return;
  }
  const { readApp, startDevice, refreshDevice } = await import('./device.mjs');
  const { qualifyAccess, appPermissions } = await import('./access.mjs');
  const selected = await readApp('pipeliner-desktop', { signal: cancellation.signal });
  if (selected.id !== 5148613 || selected.clientId !== 'Iv23liXNpydn3E3Qt5JK' || selected.owner !== 'Zuriel-Labs' ||
    selected.ownerType !== 'Organization' || !isDeepStrictEqual(selected.permissions, appPermissions)) throw new Error('installation-mismatch');
  flow = await startDevice(selected.clientId, { signal: cancellation.signal });
  const detail = `Issue #26 · Verify the designated Pipeliner Desktop GitHub App.\n\nCode: ${flow.userCode}\n\nAt github.com/login/device, use your brimdor account. Access is restricted to brimdor/pipeliner-d05-26-personal and Zuriel-Labs/pipeliner-d05-26-org.\n\nThis checks synthetic fixtures. The complete Desktop app is still being built. Cancel stops this connection attempt.`;
  const start = await dialog.showMessageBox(window, { type: 'info', title: 'Pipeliner · Connect GitHub',
    message: 'Connect the scoped GitHub App', detail, buttons: ['Open GitHub', 'Cancel'], defaultId: 0, cancelId: 1,
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.max(1, flow.expiresAt - Date.now()))]) });
  if (start.response !== 0) throw new Error('cancelled');
  await shell.openExternal(flow.verificationUri);
  const waiting = new AbortController();
  let settled = false;
  const pending = dialog.showMessageBox(window, { type: 'info', title: 'Pipeliner · GitHub sign-in',
    message: 'Complete sign-in at GitHub', detail, buttons: ['Cancel connection'], cancelId: 0, signal: waiting.signal })
    .then(() => { if (!settled) { flow.cancel(); cancellation.abort(); } });
  try { credentials = await flow.authorize(); }
  finally { settled = true; waiting.abort(); await pending; }
  const result = await qualifyAccess(credentials.accessToken, { signal: cancellation.signal,
    onResult: receipt => console.log(JSON.stringify({ receipt })) });
  if (credentials.refreshToken) {
    const rotated = await refreshDevice(selected.clientId, credentials.refreshToken, { signal: cancellation.signal });
    result.refresh = { passed: rotated.accessToken !== credentials.accessToken, expiresInSeconds: Math.round((rotated.expiresAt - Date.now()) / 1000) };
    credentials = rotated;
  } else result.refresh = { passed: false, detail: 'Provider supplied no refresh token' };
  console.log(JSON.stringify({ date: new Date().toISOString(), appId: selected.id, ...result }));
  credentials = null;
  app.quit();
}).catch(error => {
  console.log(JSON.stringify({ failed: permittedError(error) }));
  credentials = null;
  process.exitCode = 1;
  app.quit();
});
