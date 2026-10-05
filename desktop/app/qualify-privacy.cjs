'use strict';
const assert = require('node:assert/strict');
const { readFileSync, existsSync, statSync, writeFileSync } = require('node:fs');
const { join, dirname, basename, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');

// Development-only, never packaged. Actual Keychain, renderer, keyboard and native file sheets; synthetic repository/provider data.
exports.run = async ({ window, directory, vault, privacy, records, channel, workspaces, policy, js, wait, check }) => {
  const first = workspaces.status().workspaces.find(item => item.id === workspaces.status().selected), second = workspaces.status().workspaces.find(item => item.id !== first.id);
  const exportDirectory = process.env.PIPELINER_PRIVACY_EXPORT_DIRECTORY;
  assert.ok(typeof exportDirectory === 'string' && isAbsolute(exportDirectory) && dirname(exportDirectory) === dirname(directory) && basename(exportDirectory).startsWith('pipeliner-54-privacy-export-'));
  const chat = text => js(`document.getElementById('chat-nav').click();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('composer').requestSubmit()`);
  const keyApply = async () => { await js("document.getElementById('chat-nav').click();document.getElementById('privacy-apply-chat').focus()");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' }); };
  async function panel(kind) {
    await wait(() => privacy.status().busy); console.log(JSON.stringify({ privacyNativePanel: kind, directory: exportDirectory }));
    const end = Date.now() + 90000;
    while (privacy.status().busy) { if (Date.now() >= end) throw new Error('native-panel-deadline'); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  await check('privacy-frame-scope-and-storage-defaults', async () => {
    const frame = window.webContents.mainFrame, payload = { operation: 'prepare', contextRevision: privacy.status().revision, changes: { 'privacy.logDays': 17 } };
    assert.throws(() => channel.dispatch({ sender: {}, senderFrame: frame }, payload));
    assert.throws(() => channel.dispatch({ sender: window.webContents, senderFrame: frame }, { ...payload, path: '/forged' }));
    assert.equal(privacy.status().storageAvailable, true); assert.equal(privacy.status().values['privacy.logDays'].value, 30);
    assert.equal(privacy.status().values['privacy.telemetry'].value, false); assert.equal(privacy.status().values['privacy.automaticUpload'].value, false);
  });
  await check('privacy-chat-preview-cancel-and-native-keyboard-apply', async () => {
    await chat('Keep logs for 17 days for this project'); await wait(() => privacy.status().preview?.after['privacy.logDays']?.value === 17);
    assert.equal(policy.worker.read(first.id).values['privacy.logDays'].value, 30);
    await wait(() => js("Boolean(document.getElementById('privacy-apply-chat'))"));
    await chat('Cancel privacy change'); await wait(() => !privacy.status().preview);
    await chat('Keep logs for 17 days for this project'); await wait(() => Boolean(privacy.status().preview)); await keyApply();
    await wait(() => policy.worker.read(first.id).values['privacy.logDays'].value === 17);
    assert.equal(policy.worker.read(second.id).values['privacy.logDays'].value, 30);
  });
  await check('privacy-actual-encrypted-draft-history-reopen-and-renderer-reload', async () => {
    const secret = 'Synthetic private draft survives reload', revision = policy.worker.read(first.id).revision;
    await js(`document.getElementById('prompt').focus();document.getElementById('prompt').value=${JSON.stringify(secret)};document.getElementById('prompt').dispatchEvent(new Event('input'))`);
    await wait(() => records.draft(first.id) === secret); privacy.sync();
    assert.equal(await js("document.getElementById('prompt').value"), secret);
    const { openPrivacyStore } = await import(pathToFileURL(join(__dirname, '../privacy/store.mjs')).href), reopened = openPrivacyStore(directory, { vault });
    try { assert.equal(reopened.draft(first.id), secret); assert.ok(reopened.list(first.id, 'conversation', { runId: 'messages' }).length > 0); } finally { reopened.close(); }
    assert.equal(readFileSync(join(directory, 'privacy.sqlite')).includes(secret), false);
    await new Promise((resolve, reject) => { window.webContents.once('did-finish-load', resolve); window.webContents.once('did-fail-load', reject); window.reload(); });
    await wait(() => js(`document.getElementById('prompt').value===${JSON.stringify(secret)}`));
    assert.equal(policy.worker.read(first.id).revision, revision);
  });
  await check('privacy-local-diagnostics-have-no-raw-data-or-upload', async () => {
    await chat('Show diagnostics'); await wait(() => Boolean(privacy.status().diagnostics));
    const value = privacy.status().diagnostics;
    assert.equal(value.background.configured, false); assert.equal(value.storage.protected, true);
    assert.equal(value.host.version, process.getSystemVersion()); assert.equal(Object.hasOwn(value, 'rawLog'), false); assert.equal(Object.hasOwn(value, 'account'), false);
  });
  await check('privacy-actual-save-sheet-cancel-preserves-records', async () => {
    await chat("Export this project's settings"); await panel('save-cancel');
    assert.equal(privacy.status().preview, null); assert.equal(existsSync(join(exportDirectory, 'Pipeliner settings.json')), false);
    assert.equal(policy.worker.read(first.id).values['privacy.logDays'].value, 17);
  });
  await check('privacy-actual-save-sheet-preview-exclusive-export-and-byte-readback', async () => {
    await chat("Export this project's settings"); await panel('save');
    const destination = join(exportDirectory, 'Pipeliner settings.json'); await wait(() => privacy.status().preview?.destination === destination);
    assert.equal(existsSync(destination), false); await keyApply(); await wait(() => existsSync(destination)); await wait(() => !privacy.status().busy);
    const document = JSON.parse(readFileSync(destination)); assert.equal(document.settings['privacy.logDays'], 17);
    assert.equal(statSync(destination).mode & 0o777, 0o600); assert.equal(statSync(destination).nlink, 1); assert.equal(JSON.stringify(document).includes('ghu_synthetic_fixture'), false);
  });
  await check('privacy-actual-open-sheet-restores-only-reviewed-scope', async () => {
    await chat('Keep logs for 19 days for this project'); await wait(() => privacy.status().preview?.after['privacy.logDays']?.value === 19); await keyApply();
    await wait(() => policy.worker.read(first.id).values['privacy.logDays'].value === 19);
    const ceiling = policy.worker.read(first.id).values['permissions.ceiling'].value;
    await chat("Restore this project's settings"); await panel('open'); await wait(() => privacy.status().preview?.kind === 'restore' || /^Privacy (?:import|restore) failed;/.test(privacy.status().message));
    assert.equal(privacy.status().preview?.kind, 'restore', privacy.status().message);
    assert.equal(policy.worker.read(first.id).values['privacy.logDays'].value, 19); await keyApply();
    await wait(() => policy.worker.read(first.id).values['privacy.logDays'].value === 17);
    assert.deepEqual(policy.worker.read(first.id).values['permissions.ceiling'].value, ceiling);
    assert.equal(policy.worker.read(second.id).values['privacy.logDays'].value, 30); assert.equal(policy.runtime.status(first.id), null);
  });
  await check('privacy-actual-scoped-delete-retains-other-repository-and-accessible-settings', async () => {
    const preserve = records.append({ repository: second.id, category: 'conversation', runId: 'messages', value: { role: 'pm', text: 'Other repository preserved', issue: null }, completedAt: Date.now() });
    await chat('Delete local conversations'); await wait(() => privacy.status().preview?.kind === 'delete'); assert.ok(privacy.status().preview.count > 0);
    await keyApply(); await wait(() => !privacy.status().preview); assert.equal(records.list(first.id, 'conversation').length, 0);
    assert.equal(records.list(second.id, 'conversation')[0].id, preserve.id); assert.equal(records.list(null, 'audit')[0].value.operation, 'delete');
    await js("document.getElementById('settings-nav').click();document.getElementById('settings-privacy').click()");
    assert.equal(await js("Array.from(document.querySelectorAll('#privacy-settings input,#privacy-settings select')).every(input=>Array.from(document.querySelectorAll('#privacy-settings label')).some(label=>label.htmlFor===input.id))"), true);
    for (const zoom of [1, 2]) { window.setSize(420, 760); window.webContents.setZoomFactor(zoom); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); }
    window.webContents.setZoomFactor(1); window.setSize(1180, 840);
    writeFileSync(join(directory, 'qa-capture.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 });
  });
};
