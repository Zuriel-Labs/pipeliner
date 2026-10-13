'use strict';
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { app, nativeTheme } = require('electron');

// Development-only. Actual renderer, native theme, keyboard and protected policy; no Human/VoiceOver acceptance claim.
exports.run = async ({ window, directory, appearance, channel, policy, development, js, wait, check, measurements }) => {
  const chat = async text => {
    await wait(() => js("!document.getElementById('prompt').disabled && !document.getElementById('chat-send').disabled"));
    return js(`document.getElementById('chat-nav').click();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('composer').requestSubmit()`);
  };
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
  await check('appearance-technical-detail-chat-default-native-keyboard-and-refresh', async () => {
    await change('Show technical details'); assert.equal(appearance.status().values['appearance.technicalDetails'].value, true);
    const snapshot = development.status(), display = { ...snapshot, revision: snapshot.revision + 100, run: { id: 'synthetic-display-run', issue: 54, control: 'paused', limits: {} },
      development: { state: 'executing', turns: 1, stepTurns: 1, usage: { input: 2, output: 1, unavailable: true } }, qa: null, publication: null, pending: [] };
    window.webContents.send('development:status', display); await wait(() => js("Boolean(document.getElementById('chat-development-technical'))"));
    assert.equal(await js("document.getElementById('chat-development-technical').open"), true);
    await js("document.getElementById('chat-nav').click();document.getElementById('chat-development-technical-summary').focus()");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(() => js("!document.getElementById('chat-development-technical').open"));
    window.webContents.send('development:status', { ...display, revision: display.revision + 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await js("document.getElementById('chat-development-technical').open"), false);
    assert.equal(await js('document.activeElement.id'), 'chat-development-technical-summary');
    assert.equal(await js("!document.getElementById('chat-development-pause').closest('details') && !document.getElementById('chat-development-stop').closest('details')"), true);
    await change('Hide technical details');
    await new Promise((resolve, reject) => { window.webContents.once('did-finish-load', resolve); window.webContents.once('did-fail-load', reject); window.reload(); });
    await wait(() => js("Boolean(document.getElementById('appearance-form'))"));
    assert.equal(await js("document.getElementById('appearance-technicalDetails').value"), 'false');
    assert.equal(development.status().run, null); // Display fixture grants no execution authority.
  });
  await check('appearance-in-app-notifications-scope-native-apply-cancel-inheritance', async () => {
    const selected = appearance.status().repository; assert(selected);
    await change('Turn off in-app notifications globally');
    assert.equal(appearance.status().notificationsEnabled, false);
    await chat('Turn on in-app notifications for this repository'); await wait(() => Boolean(appearance.status().preview));
    assert.equal(appearance.status().preview.target, selected.id);
    await chat('Cancel this appearance change'); await wait(() => !appearance.status().preview);
    assert.equal(appearance.status().notificationsEnabled, false);
    await chat('Turn on in-app notifications for this repository'); await wait(() => Boolean(appearance.status().preview)); await show();
    await js("document.getElementById('appearance-apply').focus()"); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(() => appearance.status().notificationsEnabled);
    assert.equal(policy.worker.read(selected.id).values['appearance.repositoryNotifications'].source, 'repository');
    await chat('Reset repository in-app notifications'); await wait(() => Boolean(appearance.status().preview)); await chat('Apply this appearance change'); await wait(() => !appearance.status().preview);
    assert.equal(appearance.status().notificationsEnabled, false);
    assert.equal(policy.worker.read(selected.id).values['appearance.repositoryNotifications'].source, 'global');
    assert.equal(policy.worker.read(null).values['appearance.osNotifications'].value, false);
    await chat('Reset global in-app notifications'); await wait(() => Boolean(appearance.status().preview)); await chat('Apply this appearance change'); await wait(() => !appearance.status().preview);
    assert.equal(appearance.status().notificationsEnabled, true);
  });
  await check('appearance-layout-panes-reading-draft-keyboard-reload-and-restore', async () => {
    await change('Set text size to 100%'); window.setSize(1480, 900);
    const snapshot = development.status(), display = { ...snapshot, revision: snapshot.revision + 200, run: { id: 'synthetic-layout-display', issue: 54, control: 'paused', limits: {} },
      development: { state: 'executing', turns: 1, stepTurns: 1, usage: { input: 2, output: 1, unavailable: true } }, qa: null, publication: null, pending: [] };
    window.webContents.send('development:status', display); await wait(() => js("Boolean(document.getElementById('chat-development-pause'))"));
    await chat('Show work beside chat'); await wait(() => Boolean(appearance.status().preview));
    await js(`const log=document.getElementById('transcript');for(let i=0;i<40;i++){const article=document.createElement('article');article.className='message assistant';article.textContent='Synthetic reading fixture '+i+' · Earlier conversation content remains available while current work stays visible.';log.append(article)}log.scrollTop=250;document.getElementById('prompt').value='Unsent layout draft';window.layoutAnchor=[...log.children].find(node=>node.getBoundingClientRect().bottom>log.getBoundingClientRect().top);window.layoutOffset=window.layoutAnchor.getBoundingClientRect().top-log.getBoundingClientRect().top;document.getElementById('appearance-apply-chat').click()`);
    await wait(() => appearance.status().values['appearance.layout'].value === 'beside');
    await wait(() => js("getComputedStyle(document.getElementById('chat-view')).display==='grid'"));
    assert.equal(await js("Math.abs(window.layoutAnchor.getBoundingClientRect().top-document.getElementById('transcript').getBoundingClientRect().top-window.layoutOffset)<2"), true);
    assert.equal(await js("document.getElementById('prompt').value"), 'Unsent layout draft');
    assert.equal(await js('document.activeElement.id'), 'prompt');
    assert.equal(await js("(()=>{const chat=document.getElementById('transcript').getBoundingClientRect(),work=document.getElementById('development-status').getBoundingClientRect();return work.left>chat.right&&chat.width>=300&&work.width>=288&&document.documentElement.scrollWidth<=innerWidth})()"), true);
    assert.equal(await js("!document.getElementById('chat-development-pause').closest('details')&&!document.getElementById('chat-development-stop').closest('details')"), true);
    writeFileSync(join(directory, 'layout-capture.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 });
    // Display-only fixture. A genuine renderer reply uses the shared append path; no worker is started.
    await js("window.layoutScroll=document.getElementById('transcript').scrollTop;window.layoutPage=scrollY");
    appearance.dispatch({ operation: 'cancel' });
    await wait(() => js("!document.getElementById('chat-new-activity').hidden"));
    assert.equal(await js("Math.abs(document.getElementById('transcript').scrollTop-window.layoutScroll)<2&&scrollY===window.layoutPage"), true);
    assert.equal(await js('document.activeElement.id'), 'prompt');
    app.focus({ steal: true }); window.focus(); await js("document.getElementById('chat-new-activity').focus({preventScroll:true})");
    await wait(() => window.isFocused());
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(() => js("document.getElementById('chat-new-activity').hidden&&document.activeElement.id==='transcript'"));
    const geometry = await js("(()=>{const log=document.getElementById('transcript');return {bottomGap:log.scrollHeight-log.clientHeight-log.scrollTop,pageBefore:window.layoutPage,pageAfter:scrollY,cueVisibility:getComputedStyle(document.getElementById('chat-new-activity')).visibility}})()");
    measurements.push({ interaction: 'chat-jump-to-new-activity', ...geometry });
    assert(Math.abs(geometry.bottomGap) <= 1); assert.equal(geometry.pageAfter, geometry.pageBefore); assert.equal(geometry.cueVisibility, 'hidden');
    await js("document.getElementById('chat-new-activity').focus({preventScroll:true})"); assert.equal(await js('document.activeElement.id'), 'transcript');
    const revision = policy.worker.read(null).revision;
    await new Promise((resolve, reject) => { window.webContents.once('did-finish-load', resolve); window.webContents.once('did-fail-load', reject); window.reload(); });
    await wait(() => js("document.getElementById('appearance-layout')?.value==='beside'")); assert.equal(policy.worker.read(null).revision, revision);
    window.webContents.send('development:status', { ...display, revision: display.revision + 1 });
    await wait(() => js("Boolean(document.getElementById('chat-development-pause'))"));
    await change('Set text size to 200%'); await js("document.getElementById('chat-nav').click()");
    assert.equal(await js("getComputedStyle(document.getElementById('chat-view')).display!=='grid'&&document.documentElement.scrollWidth<=innerWidth"), true);
    window.setSize(420, 760); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js("getComputedStyle(document.getElementById('chat-view')).display!=='grid'&&document.documentElement.scrollWidth<=innerWidth"), true);
    const others = Object.fromEntries(Object.entries(appearance.status().values).filter(([key]) => key !== 'appearance.layout'));
    await chat('Restore layout'); await wait(() => Boolean(appearance.status().preview)); assert.deepEqual(Object.keys(appearance.status().preview.after), ['appearance.layout']);
    await js("document.getElementById('prompt').value='Draft survives Restore Layout';document.getElementById('appearance-apply-chat').click()");
    await wait(() => appearance.status().values['appearance.layout'].value === 'above');
    assert.deepEqual(Object.fromEntries(Object.entries(appearance.status().values).filter(([key]) => key !== 'appearance.layout')), others);
    assert.equal(await js("document.getElementById('prompt').value"), 'Draft survives Restore Layout'); assert.equal(development.status().run, null);
    await change('Set text size to 100%'); window.setSize(1180, 840); await show();
  });
  await check('appearance-200-percent-reflow-labels-touch-targets-and-motion', async () => {
    await change('Set text size to 200%'); await change('Use dark mode'); await show();
    assert.equal(await js("Array.from(document.querySelectorAll('#appearance-settings input,#appearance-settings select')).every(input=>Array.from(document.querySelectorAll('#appearance-settings label')).some(label=>label.htmlFor===input.id))"), true);
    const navigation = () => js("(()=>{const nav=document.querySelector('.app-nav');return {viewport:innerWidth,scrollWidth:nav.scrollWidth,clientWidth:nav.clientWidth,labels:[...nav.querySelectorAll('button')].map(button=>({text:button.textContent,height:button.getBoundingClientRect().height}))}})()");
    const desktopNavigation = await navigation(); measurements.push({ interaction: 'appearance-desktop-navigation-200-percent', ...desktopNavigation });
    assert(desktopNavigation.scrollWidth <= desktopNavigation.clientWidth);
    assert(desktopNavigation.labels.every(label => label.height >= 44));
    window.setSize(420, 760); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    const narrowNavigation = await navigation(); measurements.push({ interaction: 'appearance-narrow-navigation-200-percent', ...narrowNavigation });
    assert(narrowNavigation.scrollWidth <= narrowNavigation.clientWidth);
    assert(narrowNavigation.labels.every(label => label.height >= 44));
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
