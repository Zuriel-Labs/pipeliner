'use strict';
const { app, Menu, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const { writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const once = (emitter, name) => new Promise(resolve => emitter.once(name, resolve));
const output = process.argv.find(arg => arg.startsWith('--qualify-output='))?.slice('--qualify-output='.length);

module.exports = async function qualify(window) {
  const checks = [];
  const result = { host: process.platform, architecture: process.arch, versions: process.versions, checks };
  const check = (name, condition, detail) => { checks.push({ name, passed: Boolean(condition), detail }); assert.ok(condition, name); };
  try {
    if (window.webContents.isLoading()) await once(window.webContents, 'did-finish-load');
    if (!window.isVisible()) await once(window, 'ready-to-show');
    const contents = window.webContents;
    const preferences = contents.getLastWebPreferences();
    check('restricted-renderer', preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration && preferences.webSecurity);
    check('native-window', window.isVisible() && !window.isDestroyed());
    const menuShortcut = Menu.getApplicationMenu()?.items.find(item => item.label === 'View')?.submenu?.items.find(item => item.label === 'Settings')?.accelerator;
    check('native-settings-shortcut', menuShortcut === 'CmdOrCtrl+,', menuShortcut);
    const initial = await contents.executeJavaScript(`({
      title: document.title, journeys: document.querySelectorAll('#journey-list button').length,
      require: typeof require, process: typeof process, ipc: typeof window.ipcRenderer,
      background: document.body.textContent.includes('Background off'),
      roadmap: document.body.textContent.toLowerCase().includes('roadmap'),
      overflow: document.documentElement.scrollWidth > innerWidth
    })`);
    check('synthetic-journeys-and-restrictions', initial.journeys === 8 && initial.require === 'undefined'
      && initial.process === 'undefined' && initial.ipc === 'undefined' && initial.background && !initial.roadmap && !initial.overflow, initial);
    if (output) {
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(path.join(path.dirname(output), 'default-wide.png'), (await contents.capturePage()).toPNG());
    }
    const boundary = await contents.executeJavaScript(`(async () => {
      let evalDenied = false, networkDenied = false;
      try { Function('return 1')(); } catch { evalDenied = true; }
      try { await fetch('https://example.invalid/'); } catch { networkDenied = true; }
      return { evalDenied, networkDenied, popupDenied: window.open('https://example.invalid/') === null };
    })()`);
    check('csp-network-popup-denied', boundary.evalDenied && boundary.networkDenied && boundary.popupDenied, boundary);
    const journeyChecks = await contents.executeJavaScript(`(() => {
      const transcript = document.querySelector('#transcript');
      for (const button of document.querySelectorAll('#journey-list button')) button.click();
      return { requests: transcript.querySelectorAll('.message.pm').length,
        replies: [...transcript.querySelectorAll('.message.assistant')].filter(item => item.textContent.includes('No live action occurred.')).length };
    })()`);
    check('eight-simulated-task-paths', journeyChecks.requests === 8 && journeyChecks.replies === 8, journeyChecks);
    const search = await contents.executeJavaScript(`(() => {
      document.querySelector('#settings-nav').click();
      const input = document.querySelector('#settings-search');
      const names = [];
      for (const term of ['ask before merge', 'how often', 'keep installers']) {
        input.value = term; input.dispatchEvent(new Event('input', { bubbles: true }));
        names.push(document.querySelector('.category-button')?.textContent ?? '');
      }
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
      return names;
    })()`);
    check('ordinary-settings-search', search[0].includes('Testing') && search[1].includes('Scheduling') && search[2].includes('Delivery'), search);
    await contents.executeJavaScript(`document.querySelector('#work-nav').focus()`);
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const keyboard = await contents.executeJavaScript(`document.activeElement.id`);
    check('keyboard-navigation', keyboard === 'settings-nav', keyboard);
    const settings = await contents.executeJavaScript(`(() => {
      return { categories: document.querySelectorAll('.category-button').length,
        prototype: document.querySelector('#settings-view').textContent.includes('simulated') };
    })()`);
    check('settings-coverage', settings.categories === 15 && settings.prototype, settings);
    const stale = await contents.executeJavaScript(`(() => {
      [...document.querySelectorAll('.category-button')].find(button => button.textContent.includes('Autonomy and intake')).click();
      document.querySelector('#setting-detail .secondary').click();
      [...document.querySelectorAll('.repository')][1].click();
      document.querySelector('.proposal .primary').click();
      return document.querySelector('#setting-detail').textContent.includes('Target changed. Review the proposal again.');
    })()`);
    check('wrong-target-proposal-denied', stale);
    const pending = await contents.executeJavaScript(`(() => {
      [...document.querySelectorAll('.category-button')].find(button => button.textContent.includes('Scheduling')).click();
      return document.querySelector('#setting-detail').textContent.includes('proposal is still pending')
        && document.querySelector('#setting-detail').textContent.includes('Example Studio');
    })()`);
    check('pending-proposal-kept-on-navigation', pending);
    const scoped = await contents.executeJavaScript(`({ status: document.querySelector('#evidence-status').textContent,
      detail: document.querySelector('#evidence-detail').textContent,
      transcript: document.querySelector('#transcript').textContent })`);
    check('repository-scoped-evidence-and-chat', scoped.status === 'No active Issue'
      && scoped.detail.includes('Field Notes') && !scoped.detail.includes('#42')
      && scoped.transcript.includes('Field Notes') && !scoped.transcript.includes('Example Studio'), scoped);
    contents.setZoomFactor(1.5);
    window.setSize(620, 700);
    await new Promise(resolve => setTimeout(resolve, 150));
    const narrow = await contents.executeJavaScript(`({ overflow: document.documentElement.scrollWidth > innerWidth,
      focusable: [...document.querySelectorAll('button')].filter(button => !button.hidden).length,
      settingsVisible: !document.querySelector('#settings-view').hidden,
      evidenceClosed: document.querySelector('#evidence').classList.contains('closed'),
      repositoriesVisible: getComputedStyle(document.querySelector('#repositories')).display !== 'none' })`);
    check('narrow-reflow-150-percent', !narrow.overflow && narrow.focusable > 15 && narrow.settingsVisible
      && narrow.evidenceClosed && narrow.repositoriesVisible, narrow);
    const drawerOpen = await contents.executeJavaScript(`(() => {
      document.querySelector('#evidence-nav').click();
      return document.querySelector('#main').inert && document.querySelector('.rail').inert
        && document.activeElement.id === 'close-evidence';
    })()`);
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const drawerClosed = await contents.executeJavaScript(`document.querySelector('#evidence').classList.contains('closed')
      && !document.querySelector('#main').inert && !document.querySelector('.rail').inert
      && document.activeElement.id === 'evidence-nav'`);
    check('narrow-drawer-keyboard-and-focus', drawerOpen && drawerClosed, { drawerOpen, drawerClosed });
    if (output) {
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(path.join(path.dirname(output), 'narrow.png'), (await contents.capturePage()).toPNG());
      contents.setZoomFactor(1); window.setSize(1280, 860);
      await new Promise(resolve => setTimeout(resolve, 100));
      writeFileSync(path.join(path.dirname(output), 'wide.png'), (await contents.capturePage()).toPNG());
    }
    contents.debugger.attach('1.3');
    const tree = await contents.debugger.sendCommand('Accessibility.getFullAXTree');
    contents.debugger.detach();
    const names = tree.nodes.filter(node => node.role?.value === 'button').map(node => node.name?.value);
    check('accessibility-tree', names.includes('Settings') && names.some(name => name?.includes('Autonomy and intake')), names.filter(Boolean).slice(0, 25));
    if (output) {
      const previousTheme = nativeTheme.themeSource;
      nativeTheme.themeSource = 'light';
      await new Promise(resolve => setTimeout(resolve, 100));
      writeFileSync(path.join(path.dirname(output), 'light-wide.png'), (await contents.capturePage()).toPNG());
      nativeTheme.themeSource = previousTheme;
    }
    result.passed = checks.every(item => item.passed);
  } catch (error) { result.passed = false; result.error = error.message; }
  finally {
    if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ passed: result.passed, checks: checks.length, error: result.error }));
    app.exit(result.passed ? 0 : 1);
  }
};
