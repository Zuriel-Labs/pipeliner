'use strict';
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { app, safeStorage, nativeTheme } = require('electron');
const moduleAt = file => import(pathToFileURL(path.join(__dirname, file)).href);
const fixtureKey = 'synthetic-native-entry-only';
let nativeResult;
exports.adapters = async ({ directory, helper, nativeKeyEntry }) => {
  let entries = 0;
  const { ollamaAdapter } = await moduleAt('../connections/providers.mjs');
  const send = async (url, request) => {
    assert.equal(new URL(url).origin, 'https://ollama.com'); assert.equal(request.headers.Authorization, `Bearer ${fixtureKey}`);
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'deepseek-v4.1-flash' }] });
    const body = JSON.parse(request.body);
    return new Response(`${JSON.stringify({ model: body.model, done: true, done_reason: 'stop', message: body.tools ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup_fixture', arguments: {
      target: 'synthetic-pipeliner-connection', nonce: /nonce ([0-9a-f-]+),/.exec(body.messages[0].content)[1], epoch: 1 } } }] } : { role: 'assistant', content: 'fixture-ok' } })}\n`);
  };
  const offline = { connect: async () => { throw new Error('transport-failed'); }, refresh: async () => { throw new Error('http-401'); }, disconnect: async () => {} };
  return { github: offline, 'github-setup': offline, codex: offline, ollama: ollamaAdapter({ send, entry: async signal => { nativeResult = await nativeKeyEntry(helper, directory, signal, ++entries === 1); return nativeResult; } }) };
};

exports.run = async ({ window, directory, vault, manager, channel, windowReadyMs }) => {
  const started = performance.now(), checks = [], measurements = [];
  const js = code => window.webContents.executeJavaScript(code);
  const wait = async predicate => { const until = Date.now() + 10000; while (!await predicate()) { if (Date.now() >= until) throw new Error('qualification-wait-timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } };
  async function check(name, fn) { const begin = performance.now(); try { await fn(); checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - begin) }); } catch (error) { checks.push({ name, passed: false, category: 'assertion-or-native-failure' }); throw error; } }
  let capture, nativeEvidence;
  try {
    await wait(() => js("Boolean(document.getElementById('connection-list').children.length)"));
    await check('actual-macos-protected-key', async () => { assert(vault); assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true); assert.equal(existsSync(path.join(directory, 'connections.sqlite')), true); });
    await check('renderer-restrictions', async () => { assert.equal(await js("typeof require + ':' + typeof process"), 'undefined:undefined'); assert.equal(await js("fetch('https://example.com').then(()=>false,()=>true)"), true); assert.equal(await js("document.querySelectorAll('iframe,webview').length"), 0); });
    await check('registered-frame-and-stale-context', async () => {
      const frame = window.webContents.mainFrame, sender = window.webContents, payload = { operation: 'connect', connection: 'github', contextRevision: manager.status().revision };
      for (const event of [{ sender: {}, senderFrame: frame }, { sender, senderFrame: { url: frame.url, parent: frame } }]) assert.throws(() => channel.dispatch(event, payload));
      assert.throws(() => channel.dispatch({ sender, senderFrame: frame }, { ...payload, contextRevision: payload.contextRevision - 1 }));
    });
    await check('secret-like-chat-rejected-before-ipc-history', async () => {
      await js("document.getElementById('prompt').value='ghu_syntheticFixtureOnly123';document.getElementById('composer').requestSubmit()");
      assert.equal(await js("document.getElementById('transcript').textContent.includes('ghu_syntheticFixtureOnly123')"), false);
      assert.equal(await js("document.getElementById('prompt').value"), '');
    });
    await check('native-key-field-to-encrypted-store', async () => {
      await js("document.querySelector('[data-chat=\"Connect Ollama Cloud\"]').click()"); await wait(() => nativeResult); await manager.idle('ollama');
      nativeEvidence = { secureField: nativeResult.secureField, accessibleName: nativeResult.accessibleName, valueMatched: nativeResult.key === fixtureKey,
        credentialPresent: Boolean(vault.get('ollama').value?.credential), error: manager.status().connections.find(c => c.id === 'ollama').error };
      assert.equal(nativeResult.secureField, true); assert.equal(nativeResult.accessibleName, true);
      assert.equal(vault.get('ollama').value.credential, fixtureKey);
      assert.equal(readFileSync(path.join(directory, 'connections.sqlite')).includes(fixtureKey), false);
      assert.equal(JSON.stringify(manager.status()).includes(fixtureKey), false);
      assert.equal(await js(`document.body.textContent.includes(${JSON.stringify(fixtureKey)})`), false);
      assert.equal(window.isFocused(), true);
      assert.equal(existsSync(path.join(directory, 'secure-field.png')), true);
    });
    await check('chat-model-choice-and-real-renderer-keyboard-path', async () => {
      await js("document.getElementById('prompt').value='Test Ollama Cloud';document.getElementById('composer').requestSubmit()");
      await wait(() => js("Boolean(Array.from(document.querySelectorAll('#transcript button')).find(b=>b.textContent==='Test deepseek-v4.1-flash'))"));
      await js("Array.from(document.querySelectorAll('#transcript button')).find(b=>b.textContent==='Test deepseek-v4.1-flash').focus()");
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait(() => Boolean(manager.status().connections.find(c => c.id === 'ollama').capability));
      assert.equal(manager.status().connections.find(c => c.id === 'ollama').capability.toolLoop, true);
    });
    await check('outage-controls-and-disconnect', async () => {
      const previousSnapshot = manager.status();
      await js("document.getElementById('settings-nav').click();document.getElementById('connect-github').click()"); await manager.idle('github');
      await wait(() => js("document.getElementById('card-github').textContent.includes('could not finish')"));
      window.webContents.send('connections:status', previousSnapshot); await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(await js("document.getElementById('card-github').textContent.includes('could not finish')"), true);
      const at = performance.now(); const receipt = await js(`window.pipeliner.request({operation:'disconnect',connection:'ollama',contextRevision:${manager.status().revision}})`); assert.equal(receipt.accepted, true);
      measurements.push({ ipcAction: 'disconnect-receipt', milliseconds: performance.now() - at }); await manager.idle('ollama');
      assert.equal(vault.get('ollama').value, null);
    });
    await check('actual-protected-reopen', async () => {
      const { openVault } = await moduleAt('../connections/vault.mjs');
      const epoch = vault.begin('ollama'); vault.save('ollama', epoch, { credential: fixtureKey, view: { health: 'limited' } });
      const reopened = await openVault(directory, { available: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: text => safeStorage.encryptStringAsync(text), decrypt: bytes => safeStorage.decryptStringAsync(bytes) });
      try { assert.equal(reopened.get('ollama').value.credential, fixtureKey); } finally { reopened.close(); vault.erase('ollama'); }
    });
    await check('current-codex-unauthenticated-isolated-home', async () => {
      const { protectedCodexHome, codexVersion, codexModels } = await moduleAt('../connections/providers.mjs');
      const { AppServer, checkedCliVersion } = await moduleAt('../codex/qualify.mjs'); const home = await protectedCodexHome(directory);
      assert.equal(checkedCliVersion(codexVersion), codexVersion); const server = new AppServer(home);
      try {
        const init = await server.request('initialize', { clientInfo: { name: 'pipeliner_desktop', title: 'Pipeliner', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        assert.equal(init.codexHome, home); server.send({ method: 'initialized', params: {} });
        assert.equal((await server.request('account/read', { refreshToken: false })).account, null); assert((await codexModels(server)).length > 0);
        assert.equal(existsSync(path.join(home, 'auth.json')), false);
      } finally { await server.close(); }
    });
    await check('live-public-github-app-identity', async () => {
      const { readApp } = await moduleAt('../github/device.mjs'), { githubApp } = await moduleAt('../connections/github.mjs'), { appPermissions } = await moduleAt('../github/transport.mjs');
      const live = await readApp(githubApp.slug); assert.equal(live.id, githubApp.id); assert.equal(live.clientId, githubApp.clientId); assert.equal(live.owner, githubApp.owner); assert.deepEqual(live.permissions, appPermissions);
    });
    await check('live-cloud-invalid-key-denial', async () => {
      const { api } = await moduleAt('../ollama/qualify.mjs');
      await assert.rejects(api('/api/chat', 'deliberately-invalid-pipeliner-native-probe', { body: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Synthetic connection test' }], stream: false } }), /http-401/);
    });
    await check('themes-narrow-zoom-high-contrast-reduced-motion', async () => {
      for (const theme of ['light', 'dark']) { nativeTheme.themeSource = theme; await js("document.getElementById('settings-nav').click()"); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); }
      window.setSize(420, 760); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
      window.webContents.setZoomFactor(2); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); window.webContents.setZoomFactor(1);
      window.webContents.debugger.attach('1.3'); await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await js("matchMedia('(forced-colors:active)').matches && matchMedia('(prefers-reduced-motion:reduce)').matches"), true); window.webContents.debugger.detach();
      window.setSize(1180, 840); nativeTheme.themeSource = 'dark'; await new Promise(resolve => setTimeout(resolve, 100));
      capture = (await window.webContents.capturePage()).toPNG().toString('base64');
    });
    await check('foreground-close-cancels-actual-owned-native-entry', async () => {
      manager.start('ollama', 'connect'); await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(manager.status().connections.find(c => c.id === 'ollama').busy, true);
      const closed = new Promise(resolve => window.once('closed', resolve)); window.close(); await closed;
      assert.equal(manager.status().connections.some(c => c.busy), false);
    });
  } catch { process.exitCode = 1; }
  const report = { desktopQualification: 'guided-connections', checks, passed: checks.length === 13 && checks.every(c => c.passed), milliseconds: Math.round(performance.now() - started), windowReadyFromMainEntryMs: windowReadyMs, measurements,
    versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, sqlite: process.versions.sqlite, os: process.platform, architecture: process.arch },
    nativeEvidence, synthetic: 'Authorized UI fixture and model replies; actual native secure field, storage and own window',
    pending: ['Authenticated provider/GitHub PM journeys', 'Human task observation', 'Screen reader', 'Windows/Linux', 'Stable signed package storage identity'], capture,
    nativeCapture: existsSync(path.join(directory, 'secure-field.png')) ? readFileSync(path.join(directory, 'secure-field.png')).toString('base64') : undefined };
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
  if (window.isDestroyed()) app.exit(report.passed ? 0 : 1);
  else { window.once('closed', () => app.exit(report.passed ? 0 : 1)); window.close(); }
};
