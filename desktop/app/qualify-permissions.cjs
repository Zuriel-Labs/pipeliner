'use strict';
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Actual registered renderer, keyboard and protected policy. No Human or real active-worker acceptance claim.
exports.run = async ({ window, directory, permissions, appearance, channel, policy, js, wait, check, measurements }) => {
  const chat = text => js(`document.getElementById('chat-nav').click();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('composer').requestSubmit()`);
  const show = () => js("document.getElementById('settings-nav').click();document.getElementById('settings-permissions').click()");
  const settled = () => wait(async () => !permissions.status().busy && !permissions.status().preview && await js("Boolean(document.getElementById('permission-revoke') && !document.getElementById('permission-revoke').disabled)"));
  async function change(text) { await chat(text); await wait(() => Boolean(permissions.status().preview)); await chat('Apply this permission change'); await settled(); }
  const repository = permissions.status().repository.id;
  await check('permissions-native-labels-qualified-grants-and-registered-frame', async () => {
    await chat('Show permissions'); await wait(() => js("!document.getElementById('permission-settings').hidden"));
    assert.equal(permissions.status().scope, 'repository'); assert.deepEqual(permissions.status().resources, []);
    assert.equal(await js("document.querySelectorAll('#permission-form input').length"), 16);
    assert.equal(await js("document.getElementById('permission-host-install').disabled"), true);
    assert.equal(await js("document.getElementById('permission-settings').textContent.includes('No additional resource is qualified')"), true);
    const frame = window.webContents.mainFrame, event = { sender: window.webContents, senderFrame: frame }, payload = { operation: 'revoke', contextRevision: permissions.status().revision, scope: 'repository' };
    for (const value of [{ ...payload, origin: 'pm' }, { ...payload, target: repository }, { ...payload, contextRevision: 0 }]) assert.throws(() => channel.dispatch(event, value));
    assert.throws(() => channel.dispatch({ ...event, senderFrame: { url: frame.url, parent: frame } }, payload));
  });
  await check('permissions-chat-cancel-keyboard-apply-and-permanent-captured-revocation', async () => {
    const captured = policy.worker.read(repository).revision;
    await chat('Revoke editing project files for this repository'); await wait(() => Boolean(permissions.status().preview));
    assert.equal(policy.worker.authority(repository, captured).capabilities.includes('workspace.write'), true);
    await chat('Cancel this permission change'); await settled();
    assert.equal(policy.worker.authority(repository, captured).capabilities.includes('workspace.write'), true);
    await chat('Revoke editing project files for this repository'); await wait(() => Boolean(permissions.status().preview)); await show();
    await js("document.getElementById('permission-apply').focus()"); const started = performance.now();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' }); await settled();
    measurements.push({ permissionsAction: 'native-keyboard-revoke-and-no-active-run-settlement', milliseconds: performance.now() - started });
    assert.equal(policy.worker.authority(repository, captured).capabilities.includes('workspace.write'), false);
    await change('Allow editing project files for this repository');
    assert.equal(policy.worker.authority(repository, captured).capabilities.includes('workspace.write'), false);
    assert.equal(policy.worker.authority(repository, policy.worker.read(repository).revision).capabilities.includes('workspace.write'), true);
  });
  await check('permissions-host-global-and-repository-values-remain-distinct', async () => {
    await change('Allow sending model requests on this Mac'); await change('Allow sending model requests globally');
    await chat('Show permissions for this repository'); await wait(() => permissions.status().scope === 'repository');
    assert.equal(permissions.status().values['permissions.grants'].configuredValue.includes('provider.turn'), false);
    await change('Allow sending model requests for this repository'); await change('Revoke sending model requests on this Mac');
    await chat('Show permissions for this repository'); await wait(() => permissions.status().scope === 'repository');
    const state = permissions.status(); assert.equal(state.values['permissions.grants'].configuredValue.includes('provider.turn'), true); assert.equal(state.values['permissions.grants'].value.includes('provider.turn'), false);
    await show(); assert.equal(await js("document.getElementById('permission-provider-turn').checked && !document.getElementById('permission-provider-turn').disabled"), true);
    await change('Allow sending model requests on this Mac');
    await change('Reset repository permissions'); assert.equal(permissions.status().values['permissions.grants'].source, 'global');
    await change('Revoke sending model requests globally'); await change('Reset host permissions');
  });
  await check('permissions-settings-draft-focus-chat-draft-and-noop-preserved', async () => {
    await chat('Show permissions for this repository'); await wait(() => permissions.status().scope === 'repository'); await show();
    const version = policy.worker.read(repository).revision;
    await js("document.getElementById('permission-form').requestSubmit()"); await wait(() => permissions.status().message.includes('already match'));
    assert.equal(policy.worker.read(repository).revision, version);
    await js("document.getElementById('permission-workspace-write').checked=false;document.getElementById('permission-workspace-write').focus()");
    permissions.sync(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await js("document.getElementById('permission-workspace-write').checked"), false); assert.equal(await js('document.activeElement.id'), 'permission-workspace-write');
    await js("document.getElementById('prompt').value='Unsent ordinary PM draft';document.getElementById('prompt').dispatchEvent(new Event('input'));document.getElementById('permission-form').requestSubmit()");
    await wait(() => Boolean(permissions.status().preview)); assert.equal(policy.worker.authority(repository, version).capabilities.includes('workspace.write'), true);
    await js("document.getElementById('permission-apply').click()"); await settled();
    assert.equal(await js("document.getElementById('prompt').value"), 'Unsent ordinary PM draft');
    assert.equal(policy.worker.authority(repository, version).capabilities.includes('workspace.write'), false);
    await change('Reset repository permissions');
  });
  await check('permissions-unqualified-actions-resource-paths-and-stale-previews-denied', async () => {
    const version = policy.worker.read(repository).revision;
    await assert.rejects(permissions.dispatch({ operation: 'resource', scope: 'repository', reference: 'unregistered', enabled: true }));
    await assert.rejects(permissions.dispatch({ operation: 'resource', scope: 'repository', reference: '/private', enabled: true }));
    await assert.rejects(permissions.dispatch({ operation: 'toggle', scope: 'host', capability: 'host.install', enabled: true }));
    await assert.rejects(permissions.dispatch({ operation: 'toggle', scope: 'repository', capability: 'provider.turn', enabled: true }));
    assert.equal(policy.worker.read(repository).revision, version);
    await chat('Show permissions for this repository'); await wait(() => permissions.status().scope === 'repository');
    await chat('Revoke editing project files for this repository'); await wait(() => Boolean(permissions.status().preview)); const old = permissions.status();
    await permissions.dispatch({ operation: 'cancel' });
    const frame = window.webContents.mainFrame;
    assert.throws(() => channel.dispatch({ sender: window.webContents, senderFrame: frame }, { operation: 'apply', hash: old.preview.hash, contextRevision: old.revision }));
    assert.equal(policy.worker.read(repository).revision, version);
  });
  await check('permissions-native-checkbox-label-targets-and-200-percent-reflow', async () => {
    async function appearanceChange(changes) { await appearance.dispatch({ operation: 'prepare', changes }); const hash = appearance.status().preview.hash; await appearance.dispatch({ operation: 'apply', hash }); }
    await appearanceChange({ 'appearance.textScale': 2, 'appearance.theme': 'dark', 'appearance.motion': 'reduced' }); await show();
    window.setSize(420, 760); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("Array.from(document.querySelectorAll('#permission-form input')).every(input=>Array.from(document.querySelectorAll('#permission-form label')).some(label=>label.htmlFor===input.id && label.getBoundingClientRect().height>=44))"), true);
    assert.equal(await js("Array.from(document.querySelectorAll('#permission-form fieldset')).every(group=>Boolean(group.querySelector('legend')?.textContent))"), true);
    await js("document.getElementById('permission-workspace-write').focus()"); const before = await js("document.getElementById('permission-workspace-write').checked");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    assert.equal(await js("document.getElementById('permission-workspace-write').checked"), !before);
    await js("document.getElementById('permission-form').scrollIntoView({block:'start'});window.scrollBy(0,-(document.querySelector('.app-head').getBoundingClientRect().height+document.querySelector('.app-nav').getBoundingClientRect().height+10))");
    writeFileSync(join(directory, 'qa-capture.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 });
    window.setSize(1180, 840); await appearanceChange({ 'appearance.textScale': 1 }); await show();
  });
};
