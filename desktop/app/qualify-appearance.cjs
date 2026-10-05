'use strict';
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { nativeTheme } = require('electron');

// Development-only. Actual renderer, native theme, keyboard and protected policy; no Human/VoiceOver acceptance claim.
exports.run = async ({ window, directory, appearance, channel, policy, js, wait, check }) => {
  const chat = text => js(`document.getElementById('chat-nav').click();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('composer').requestSubmit()`);
  const show = () => js("document.getElementById('settings-nav').click();document.getElementById('settings-appearance').click()");
  async function change(text) { await chat(text); await wait(() => Boolean(appearance.status().preview)); await chat('Apply this appearance change'); await wait(() => !appearance.status().preview); }
  await check('appearance-registered-frame-host-scope-and-defaults', async () => {
    assert.equal(appearance.status().values['appearance.theme'].value, 'system');
    assert.equal(appearance.status().values['appearance.textScale'].value, 1);
    const frame = window.webContents.mainFrame, event = { sender: window.webContents, senderFrame: frame }, payload = { operation: 'prepare', contextRevision: appearance.status().revision, changes: { 'appearance.theme': 'dark' } };
    for (const value of [{ ...payload, scope: 'repository' }, { ...payload, origin: 'pm' }, { ...payload, contextRevision: 0 }]) assert.throws(() => channel.dispatch(event, value));
    assert.throws(() => channel.dispatch({ ...event, senderFrame: { url: frame.url, parent: frame } }, payload));
    await chat('"Use dark mode"'); assert.equal(appearance.status().preview, null);
  });
  await check('appearance-chat-cancel-and-real-keyboard-apply-native-theme', async () => {
    await chat('Use light mode'); await wait(() => Boolean(appearance.status().preview));
    assert.equal(nativeTheme.themeSource, 'system'); await chat('Cancel this appearance change'); await wait(() => !appearance.status().preview);
    await chat('Use light mode'); await wait(() => Boolean(appearance.status().preview)); await show();
    await js("document.getElementById('appearance-apply').focus()"); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(() => nativeTheme.themeSource === 'light'); assert.equal(await js('getComputedStyle(document.body).backgroundColor'), 'rgb(242, 245, 245)');
    await change('Use dark mode'); await wait(() => nativeTheme.themeSource === 'dark');
    assert.equal(await js('getComputedStyle(document.body).backgroundColor'), 'rgb(16, 23, 34)');
    await change('Follow system theme'); assert.equal(nativeTheme.themeSource, 'system');
  });
  await check('appearance-form-draft-focus-and-chat-draft-preserved', async () => {
    await change('Set text size to 137.5%'); await show();
    assert.equal(await js("document.getElementById('appearance-textScale').value"), '137.5');
    const unchangedVersion = policy.worker.read(null).revision;
    await js("document.getElementById('appearance-form').requestSubmit()"); await wait(() => appearance.status().message.includes('already match'));
    assert.equal(appearance.status().preview, null); assert.equal(policy.worker.read(null).revision, unchangedVersion);
    await js("document.getElementById('appearance-textScale').value='175';document.getElementById('appearance-textScale').focus()");
    appearance.sync(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await js("document.getElementById('appearance-textScale').value"), '175'); assert.equal(await js('document.activeElement.id'), 'appearance-textScale');
    await js("document.getElementById('prompt').value='Unsent ordinary PM draft';document.getElementById('prompt').dispatchEvent(new Event('input'));document.getElementById('appearance-density').value='compact';document.getElementById('appearance-motion').value='reduced';document.getElementById('appearance-form').requestSubmit()");
    await wait(() => Boolean(appearance.status().preview)); assert.equal(appearance.status().values['appearance.textScale'].value, 1.375);
    await js("document.getElementById('appearance-apply').click()"); await wait(() => appearance.status().values['appearance.textScale'].value === 1.75);
    assert.equal(await js("document.getElementById('prompt').value"), 'Unsent ordinary PM draft');
    assert.equal(await js("getComputedStyle(document.documentElement).fontSize"), '28px');
    assert.equal(await js("document.documentElement.dataset.density+':'+document.documentElement.dataset.motion"), 'compact:reduced');
  });
  await check('appearance-persisted-reload-and-stale-preview-no-extra-version', async () => {
    const version = policy.worker.read(null).revision;
    await new Promise((resolve, reject) => { window.webContents.once('did-finish-load', resolve); window.webContents.once('did-fail-load', reject); window.reload(); });
    await wait(() => js("Boolean(document.getElementById('appearance-form'))"));
    assert.equal(await js('getComputedStyle(document.documentElement).fontSize'), '28px');
    assert.equal(await js("document.getElementById('appearance-density').value"), 'compact');
    assert.equal(policy.worker.read(null).revision, version);
    await chat('Set text size to 150%'); await wait(() => Boolean(appearance.status().preview)); const old = appearance.status();
    const frame = window.webContents.mainFrame;
    appearance.dispatch({ operation: 'cancel' });
    assert.throws(() => channel.dispatch({ sender: window.webContents, senderFrame: frame }, { operation: 'apply', hash: old.preview.hash, contextRevision: old.revision }));
    assert.equal(policy.worker.read(null).revision, version);
  });
  await check('appearance-200-percent-reflow-labels-touch-targets-and-motion', async () => {
    await change('Set text size to 200%'); await change('Use dark mode'); await show();
    assert.equal(await js("Array.from(document.querySelectorAll('#appearance-settings input,#appearance-settings select')).every(input=>Array.from(document.querySelectorAll('#appearance-settings label')).some(label=>label.htmlFor===input.id))"), true);
    window.setSize(420, 760); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("Array.from(document.querySelectorAll('#appearance-settings button')).every(button=>button.getBoundingClientRect().height>=44)"), true);
    await js("document.getElementById('appearance-form').scrollIntoView({block:'start'});window.scrollBy(0,-(document.querySelector('.app-head').getBoundingClientRect().height+document.querySelector('.app-nav').getBoundingClientRect().height+10))");
    writeFileSync(join(directory, 'qa-capture.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 });
    window.webContents.debugger.attach('1.3');
    try {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await js("matchMedia('(forced-colors:active)').matches && matchMedia('(prefers-reduced-motion:reduce)').matches"), true);
      assert.equal(await js("getComputedStyle(document.querySelector('#appearance-settings button')).animationName"), 'none');
    } finally { await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); window.webContents.debugger.detach(); }
    window.setSize(1180, 840); await change('Set text size to 100%'); await show();
  });
};
