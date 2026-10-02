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
const permittedError = error => /^(http-\d{3}|cancelled|timeout|transport-failed|authorization-[a-z-]+|device-[a-z-]+|invalid-[a-z-]+|account-mismatch|installation-mismatch|repository-mismatch|readback-mismatch|fixture-collision|response-(invalid|too-large)|write-result-uncertain|graphql-(forbidden|rejected|insufficient-scopes|validation|not-found)|setup-token-required|connection-token-required|revocation-not-observed|asset-download-invalid|incomplete-list|read-failed|reauthentication-required|token-request-denied)$/.test(error?.message)
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
  const { qualifyAccess, qualifySetup, qualifyRemaining, qualifyKnownProject, readSetupResources, awaitRevocation,
    appPermissions, fixtures, setupTargets } = await import('./access.mjs');
  const revokeSetup = process.argv.includes('--revoke-setup'), revokeApp = process.argv.includes('--revoke-app'),
    remaining = process.argv.includes('--remaining-fixtures');
  const setup = process.argv.includes('--setup-fixtures') || revokeSetup;
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
  const detail = revokeApp
    ? `Issue #26 · Revoke the Pipeliner Desktop App test grant.\n\nCode: ${flow.userCode}\n\nUse brimdor at github.com/login/device. This read-only mode verifies the exact recorded private App fixtures, refreshes once, then opens GitHub's authorization settings to revoke only Pipeliner Desktop. Completed fixture operations are not repeated. Credentials stay in memory and are discarded after access/refresh denial. Cancel stops the check.`
    : revokeSetup
    ? `Issue #26 · Revoke the Pipeliner Desktop Setup test grant.\n\nCode: ${flow.userCode}\n\nUse brimdor at github.com/login/device. This read-only check verifies the two exact recorded private OAuth fixtures and Projects, refreshes once, then opens GitHub's authorization settings to revoke only Pipeliner Desktop Setup. Credentials stay in memory and are discarded after access/refresh denial. No fixture creation or write runs in this mode. Cancel stops the check.`
    : remaining
    ? `Issue #26 · Finish the scoped Pipeliner Desktop App qualification.\n\nCode: ${flow.userCode}\n\nUse brimdor at github.com/login/device. Only ${fixtureLabel} receive the prepared synthetic Ready, check/status/PR, draft asset and Project tests. The agent handles external fixture status preparation. After refresh and readback, revoke only the Pipeliner Desktop test grant through GitHub's authorization settings. Credentials stay in memory. Cancel stops the sequence. This is a qualification probe; the complete app is still being built.`
    : setup
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
  const result = revokeSetup ? { setup: 'passed', rows: [{ fixture: fixtureLabel, operation: 'read-only-setup-binding', status: 'passed',
    detail: await readSetupResources(credentials.accessToken, { signal: cancellation.signal }) }] }
    : revokeApp ? await qualifyAccess(credentials.accessToken, { readOnly: true, signal: cancellation.signal })
    : await (setup ? qualifySetup : remaining ? qualifyRemaining : qualifyAccess)(credentials.accessToken, { fixtureId, signal: cancellation.signal,
      onResult: receipt => console.log(JSON.stringify({ receipt })) });
  console.log(JSON.stringify({ date: new Date().toISOString(), appId: selected.id,
    ...(setup ? { setup: result.setup, rows: result.rows } : result) }));
  const revoke = async () => {
    phase = 'connection-revocation';
    const name = setup ? 'Pipeliner Desktop Setup' : 'Pipeliner Desktop';
    const prompt = await dialog.showMessageBox(window, { type: 'info', title: 'Pipeliner · Revoke test grant',
      message: `Revoke ${name} at GitHub`, detail: `Issue #26 · Revoke only the ${name} user authorization. Keep the registered App and its installations. The native process verifies that this token and its refresh are denied, then discards them.`,
      buttons: ['Open authorization settings', 'Cancel'], defaultId: 0, cancelId: 1, signal: cancellation.signal });
    if (prompt.response !== 0) throw new Error('cancelled');
    await shell.openExternal(setup ? 'https://github.com/settings/applications' : 'https://github.com/settings/apps/authorizations');
    const checkpoint = await dialog.showMessageBox(window, { type: 'info', title: 'Pipeliner · Provider revocation',
      message: `Revoke ${name} in GitHub`, detail: 'After completing the designated provider controls, start the read-only denial check. No fixture writes run.',
      buttons: ['Check revocation', 'Cancel'], defaultId: 0, cancelId: 1,
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.max(1, Math.min(300000, credentials.expiresAt - Date.now())))]) });
    if (checkpoint.response !== 0) throw new Error('cancelled');
    const control = new AbortController(); let finished = false;
    const waiting = dialog.showMessageBox(window, { type: 'info', title: 'Pipeliner · Revocation check', message: `Verifying revoked access for ${name}`,
      detail: 'Read-only verification. Cancel stops the local check.', buttons: ['Cancel check'], cancelId: 0, signal: control.signal })
      .then(() => { if (!finished) cancellation.abort(); });
    try {
      const denial = await awaitRevocation(credentials.accessToken, { signal: cancellation.signal });
      if (!credentials.refreshToken) throw new Error('revocation-not-observed');
      try {
        await (setup ? refreshSetupDevice : refreshDevice)(selected.clientId, credentials.refreshToken, { signal: cancellation.signal });
        throw new Error('revocation-not-observed');
      } catch (error) { if (!['reauthentication-required', 'token-request-denied', 'http-401'].includes(error.message)) throw error; }
      console.log(JSON.stringify({ receipt: { fixture: fixtureLabel, operation: phase, status: 'passed',
        detail: { connection: name, ...denial, refreshDenied: true } } }));
    } finally { finished = true; control.abort(); await waiting; credentials = null; }
  };
  if (setup) {
    phase = 'setup-token-refresh';
    const rotated = await refreshSetupDevice(selected.clientId, credentials.refreshToken, { signal: cancellation.signal });
    const refresh = { passed: rotated.accessToken !== credentials.accessToken,
      expiresInSeconds: Math.round((rotated.expiresAt - Date.now()) / 1000) };
    credentials = rotated;
    if (revokeSetup) await readSetupResources(credentials.accessToken, { signal: cancellation.signal });
    else await result.verify(credentials.accessToken);
    refresh.repositoryAndProjectBinding = 'passed';
    console.log(JSON.stringify({ receipt: { fixture: fixtureLabel, operation: phase,
      status: refresh.passed ? 'passed' : 'failed', detail: refresh } }));
    if (revokeSetup) await revoke();
    credentials = null;
    busy = false; app.quit();
    return;
  }
  if (remaining || revokeApp) {
    if (remaining) {
      phase = 'known-project-status-readback';
      const started = performance.now();
      const project = await qualifyKnownProject(credentials.accessToken, { signal: cancellation.signal,
        onResult: receipt => console.log(JSON.stringify({ receipt })) });
      console.log(JSON.stringify({ receipt: { fixture: `${fixtures[1].owner}/${fixtures[1].name}`, operation: phase,
        status: 'passed', detail: project, milliseconds: performance.now() - started } }));
    }
    phase = 'device-refresh';
    const rotated = await refreshDevice(selected.clientId, credentials.refreshToken, { signal: cancellation.signal });
    const refreshed = rotated.accessToken !== credentials.accessToken; credentials = rotated;
    await qualifyAccess(credentials.accessToken, { readOnly: true, signal: cancellation.signal });
    if (!refreshed) throw new Error('invalid-token-response');
    console.log(JSON.stringify({ receipt: { fixture: fixtureLabel, operation: 'device-token-refresh', status: 'passed',
      detail: { passed: true, expiresInSeconds: Math.round((credentials.expiresAt - Date.now()) / 1000), repositoryBinding: 'passed' } } }));
    await revoke(); busy = false; app.quit(); return;
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
