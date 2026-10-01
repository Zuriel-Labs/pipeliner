'use strict';
// Local, purpose-limited qualification. Never invoked by framework checks or Actions.
const { app, BaseWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
if (!process.argv.includes('--managed')) throw new Error('Use the task-owned desktop-github runner');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeliner-d05-'));
app.setPath('userData', directory);
app.setPath('crashDumps', path.join(directory, 'crashes'));
app.setName('Pipeliner Desktop · GitHub connection');
fs.writeFileSync(path.join(directory, 'ownership.json'), JSON.stringify({ issue: 26, pid: process.pid, directory }));
const cancellation = new AbortController();
let flow, credentials, fixtureLabel, busy = true, phase = 'native-start';
const permittedError = error => /^(http-\d{3}|cancelled|timeout|transport-failed|authorization-[a-z-]+|device-[a-z-]+|invalid-[a-z-]+|account-mismatch|installation-mismatch|repository-mismatch|readback-mismatch|fixture-collision|response-(invalid|too-large)|write-result-uncertain|graphql-(forbidden|rejected|insufficient-scopes|validation|not-found)|setup-token-required|incomplete-list|read-failed|reauthentication-required|token-request-denied)$/.test(error?.message)
  ? error.message : 'connection-check-failed';
app.on('before-quit', event => { cancellation.abort(); flow?.cancel(); credentials = null; if (busy) event.preventDefault(); });
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
app.whenReady().then(async () => {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  // Native parent is required for cancellable macOS sheets; no web renderer or IPC is created.
  const window = new BaseWindow({ width: 660, height: 480, title: 'Pipeliner · GitHub connection' });
  window.on('closed', () => app.quit());
  if (process.argv.includes('--native-failure-check')) throw new Error('synthetic-failure');
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
    busy = false; app.quit();
    return;
  }
  const { readApp, startDevice, refreshDevice, startSetupDevice, refreshSetupDevice } = await import('./device.mjs');
  const { qualifyAccess, qualifySetup, appPermissions, fixtures, setupTargets } = await import('./access.mjs');
  const setup = process.argv.includes('--setup-fixtures');
  phase = 'public-app-read';
  // Public OAuth identity verified in the owned Zuriel-Labs registration UI; no secret is generated.
  const selected = setup ? { clientId: 'Ov23liqnTj1cUOMnqW1l' }
    : await readApp('pipeliner-desktop', { signal: cancellation.signal });
  if (!setup && (selected.id !== 5148613 || selected.clientId !== 'Iv23liXNpydn3E3Qt5JK' || selected.owner !== 'Zuriel-Labs' ||
    selected.ownerType !== 'Organization' || !isDeepStrictEqual(selected.permissions, appPermissions))) throw new Error('installation-mismatch');
  const fixtureId = process.argv.includes('--organization-fixture') ? fixtures.find(f => f.type === 'Organization').id : undefined;
  const targets = setup ? setupTargets : fixtureId === undefined ? fixtures : fixtures.filter(f => f.id === fixtureId);
  fixtureLabel = targets.map(f => `${f.owner}/${f.name}`).join(', ');
  phase = 'device-code';
  flow = await (setup ? startSetupDevice : startDevice)(selected.clientId, { signal: cancellation.signal });
  const detail = setup
    ? `Issue #26 · Pipeliner Desktop Setup · approved OAuth qualification.\n\nCode: ${flow.userCode}\n\nAt github.com/login/device, use your brimdor account. GitHub grants broader repository and personal/organization Project access. This trusted setup probe qualifies only ${fixtureLabel} and their private synthetic Projects after exact identity and absence checks. It reuses the recorded personal test repository; organization creation is fresh. The scoped App remains the repository connection.\n\nExpiring credentials stay in memory. No secret is requested. Cancel stops this qualification sequence. The complete Desktop app is still being built.`
    : `Issue #26 · Verify the designated Pipeliner Desktop GitHub App.\n\nCode: ${flow.userCode}\n\nAt github.com/login/device, use your brimdor account. GitHub retains the existing selected-repository access. One sign-in runs the bounded suite for ${fixtureLabel}; private fixture identity checks run before any write.\n\nThis checks synthetic fixtures. The complete Desktop app is still being built. Cancel stops the qualification sequence.`;
  const start = await dialog.showMessageBox(window, { type: 'info', title: 'Pipeliner · Connect GitHub',
    message: setup ? 'Connect Pipeliner Desktop Setup' : 'Connect the scoped GitHub App', detail, buttons: ['Open GitHub', 'Cancel'], defaultId: 0, cancelId: 1,
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.max(1, flow.expiresAt - Date.now()))]) });
  if (start.response !== 0) throw new Error('cancelled');
  await shell.openExternal(flow.verificationUri);
  const waiting = new AbortController();
  let settled = false;
  const pending = dialog.showMessageBox(window, { type: 'info', title: 'Pipeliner · GitHub sign-in',
    message: 'Complete sign-in at GitHub', detail, buttons: ['Cancel connection'], cancelId: 0, signal: waiting.signal })
    .then(() => { if (!settled) { flow.cancel(); cancellation.abort(); } });
  phase = 'device-authorize';
  try { credentials = await flow.authorize(); }
  finally { settled = true; waiting.abort(); await pending; }
  if (setup) console.log(JSON.stringify({ receipt: { fixture: fixtureLabel, operation: 'setup-grant', status: 'passed',
    detail: { scopes: credentials.scopes, expiresInSeconds: Math.round((credentials.expiresAt - Date.now()) / 1000) } } }));
  phase = 'fixture-preflight';
  const result = await (setup ? qualifySetup : qualifyAccess)(credentials.accessToken, { fixtureId, signal: cancellation.signal,
    onResult: receipt => console.log(JSON.stringify({ receipt })) });
  console.log(JSON.stringify({ date: new Date().toISOString(), appId: selected.id,
    ...(setup ? { setup: result.setup, rows: result.rows } : result) }));
  if (setup) {
    phase = 'setup-token-refresh';
    const rotated = await refreshSetupDevice(selected.clientId, credentials.refreshToken, { signal: cancellation.signal });
    const refresh = { passed: rotated.accessToken !== credentials.accessToken,
      expiresInSeconds: Math.round((rotated.expiresAt - Date.now()) / 1000) };
    credentials = rotated;
    await result.verify(credentials.accessToken);
    refresh.repositoryAndProjectBinding = 'passed';
    console.log(JSON.stringify({ receipt: { fixture: fixtureLabel, operation: phase,
      status: refresh.passed ? 'passed' : 'failed', detail: refresh } }));
    credentials = null;
    busy = false; app.quit();
    return;
  }
  const { qualifyGit } = await import('./git.mjs');
  for (const fixture of targets) {
    phase = 'git-transport';
    const started = performance.now();
    try {
      const detail = await qualifyGit(credentials.accessToken, fixture.id, { signal: cancellation.signal });
      console.log(JSON.stringify({ receipt: { fixture: `${fixture.owner}/${fixture.name}`, operation: phase,
        status: 'passed', detail, milliseconds: performance.now() - started } }));
    } catch (error) {
      console.log(JSON.stringify({ receipt: { fixture: `${fixture.owner}/${fixture.name}`, operation: phase,
        status: 'failed', detail: /^git-[a-z-]+$/.test(error.message) ? error.message : 'git-operation-failed',
        milliseconds: performance.now() - started } }));
      if (cancellation.signal.aborted) throw new Error('cancelled');
    }
  }
  let refresh = { passed: false, detail: 'Provider supplied no refresh token' };
  if (credentials.refreshToken) {
    phase = 'device-refresh';
    const rotated = await refreshDevice(selected.clientId, credentials.refreshToken, { signal: cancellation.signal });
    refresh = { passed: rotated.accessToken !== credentials.accessToken, expiresInSeconds: Math.round((rotated.expiresAt - Date.now()) / 1000) };
    credentials = rotated;
    phase = 'refreshed-fixture-preflight';
    await qualifyAccess(credentials.accessToken, { fixtureId, readOnly: true, signal: cancellation.signal,
      onResult: receipt => console.log(JSON.stringify({ receipt })) });
    refresh.repositoryBinding = 'passed';
  }
  console.log(JSON.stringify({ receipt: { fixture: fixtureLabel, operation: 'device-token-refresh',
    status: refresh.passed ? 'passed' : 'failed', detail: refresh } }));
  console.log(JSON.stringify({ refresh }));
  credentials = null;
  busy = false; app.quit();
}).catch(error => {
  if (fixtureLabel) console.log(JSON.stringify({ receipt: { fixture: fixtureLabel,
    operation: phase, status: 'failed', detail: permittedError(error) } }));
  console.log(JSON.stringify({ failed: permittedError(error) }));
  credentials = null;
  busy = false; app.quit();
});
