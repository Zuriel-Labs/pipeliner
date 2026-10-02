'use strict';
const assert = require('node:assert/strict');
const { readFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { app, safeStorage, nativeTheme } = require('electron');
const moduleAt = file => import(pathToFileURL(path.join(__dirname, file)).href);
const fixtureKey = 'synthetic-native-entry-only';
let nativeResult, workspaceFixture, folderFailure = null, folderCancelled = false;
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
  return { github: { ...offline, refresh: async ({ value }) => value }, 'github-setup': offline, codex: offline, ollama: ollamaAdapter({ send, entry: async signal => { nativeResult = await nativeKeyEntry(helper, directory, signal, ++entries === 1); return nativeResult; } }) };
};

exports.workspaceOptions = async ({ directory, helper, nativeFolderEntry }) => {
  const { definitions, planFields, verifyFields } = await moduleAt('../repositories/github.mjs');
  const fixture = path.join(app.getPath('documents'), 'pipeliner-36-native-' + process.pid);
  mkdirSync(fixture, { mode: 0o700 });
  const info = require('node:fs').lstatSync(fixture);
  writeFileSync(path.join(directory, 'native-ownership.json'), JSON.stringify({ pid: process.pid, path: fixture, key: info.dev + ':' + info.ino }), { flag: 'wx', mode: 0o600 });
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', fixture, ...args], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Synthetic']); git(['config', 'user.email', 'synthetic@example.invalid']);
  writeFileSync(path.join(fixture, 'tracked'), 'initial'); git(['add', 'tracked']); git(['commit', '-m', 'Synthetic native fixture']); git(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  writeFileSync(path.join(fixture, 'tracked'), 'preserved modification'); writeFileSync(path.join(fixture, 'untracked'), 'preserved untracked');
  const owner = { id: 'ORG1', numericId: 2, login: 'fixture', type: 'Organization' };
  const repo = { id: 'R1', numericId: 3, owner, name: 'repo', slug: 'fixture/repo', displayName: 'fixture/repo', private: true, permissions: { pull: true } };
  let project = { id: 'P1', number: 1, title: 'Fixture Project', public: false, closed: false, viewerCanUpdate: true, owner: { id: owner.id, login: owner.login },
    repositories: [{ id: repo.id, nameWithOwner: repo.displayName }], fields: [{ id: 'F1', name: 'Status', options: [{ id: 'S1', name: 'Backlog', color: 'GRAY', description: 'Preserve' }, { id: 'S2', name: 'Custom', color: 'RED', description: 'Preserve' }] }] };
  let entries = 0, writes = 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  workspaceFixture = { path: fixture, git, repo, owner, get project() { return project; }, get writes() { return writes; } };
  return { folder: async signal => {
    // macOS requires a human to accept its panel. Exercise import with an owned synthetic selection;
    // exercise the real panel's foreground cancellation separately, without granting OS consent.
    if (++entries === 1) return fixture;
    try { return await nativeFolderEntry(helper, directory, signal, true); }
    catch (error) { folderFailure = error.cause ?? null; folderCancelled = error.message === 'native-entry-cancelled'; throw error; }
  },
    api: { planFields, verifyFields, listProjects: async () => [{ id: project.id, title: project.title, viewerCanUpdate: true }], readRepository: async () => copy(repo), readProject: async () => copy(project),
      applyField: async (_lease, _project, field) => { writes++; const changed = { id: field.id ?? 'F-' + field.role, name: field.name, options: field.options.map((option, i) => ({ ...option, id: option.id ?? 'O-' + field.role + i })) };
        project.fields = [...project.fields.filter(item => item.id !== changed.id), changed]; return copy(changed); } } };
};

exports.run = async ({ window, directory, vault, manager, workspaces, workspaceChannel, channel, windowReadyMs }) => {
  const started = performance.now(), checks = [], measurements = [];
  const js = code => window.webContents.executeJavaScript(code);
  const wait = async predicate => { const until = Date.now() + 10000; while (!await predicate()) { if (Date.now() >= until) throw new Error('qualification-wait-timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } };
  async function check(name, fn) { const begin = performance.now(); try { await fn(); checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - begin) }); } catch (error) { checks.push({ name, passed: false, category: 'assertion-or-native-failure' }); throw error; } }
  let capture, nativeEvidence, workspaceStage = null, workspaceEvidence = null;
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
      await wait(() => window.isFocused());
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
    await check('chat-local-import-with-owned-synthetic-folder-selection', async () => {
      const { repo, owner } = workspaceFixture, epoch = vault.begin('github');
      vault.save('github', epoch, { credential: { accessToken: 'ghu_synthetic_fixture' }, account: { id: 1, node: 'U1' }, view: { health: 'connected', account: 'Synthetic fixture', lastVerified: Date.now(), owners: [{ id: owner.numericId, node: owner.id, login: owner.login, type: owner.type }],
        repositories: [{ id: repo.id, numericId: repo.numericId, name: repo.displayName, private: true, permissions: ['pull'] }] } });
      const chat = async text => { await js(`document.getElementById('chat-nav').click();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('composer').requestSubmit()`); };
      workspaceStage = 'begin'; await chat('Use a local project'); await wait(() => Boolean(workspaces.status().draft));
      workspaceStage = 'synthetic-folder'; await chat('Choose a folder'); await wait(() => Boolean(workspaces.status().draft.folder)); await workspaces.idle();
      assert.equal(workspaces.status().draft.folder.path, workspaceFixture.path); await wait(() => window.isFocused());
      workspaceStage = 'discover-projects'; await chat('Review this setup'); await workspaces.idle(); await wait(() => Boolean(workspaces.status().draft.projects));
      workspaceStage = 'select-project'; await chat('Use project Fixture Project'); await wait(() => workspaces.status().draft.values.project === 'P1');
      workspaceStage = 'preview'; await chat('Review this setup'); await wait(() => workspaces.status().draft.state === 'preview'); await workspaces.idle();
      assert.equal(workspaces.status().draft.preview.inspected.changes.tracked, 1); assert.equal(workspaces.status().draft.preview.inspected.changes.untracked, 1);
      assert.equal(workspaceFixture.writes, 0);
    });
    await check('registered-workspace-preview-and-keyboard-apply', async () => {
      const frame = window.webContents.mainFrame, sender = window.webContents, draft = workspaces.status().draft;
      const payload = { operation: 'apply', hash: draft.preview.hash, contextRevision: workspaces.status().revision };
      assert.throws(() => workspaceChannel.dispatch({ sender: {}, senderFrame: frame }, payload));
      assert.throws(() => workspaceChannel.dispatch({ sender, senderFrame: frame }, { ...payload, contextRevision: payload.contextRevision - 1 }));
      assert.throws(() => workspaceChannel.dispatch({ sender, senderFrame: frame }, { ...payload, path: '/forged' }));
      await js("document.getElementById('repositories-nav').click();document.getElementById('setup-apply').focus()");
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait(() => workspaces.status().draft.state === 'complete'); await workspaces.idle();
      assert.equal(workspaces.status().workspaces.length, 1); assert.equal(workspaceFixture.writes, 4);
      assert.equal(workspaceFixture.project.fields.find(field => field.name === 'Status').options.find(option => option.name === 'Custom').id, 'S2');
      assert.equal(readFileSync(path.join(workspaceFixture.path, 'tracked'), 'utf8'), 'preserved modification');
      assert.equal(readFileSync(path.join(workspaceFixture.path, 'untracked'), 'utf8'), 'preserved untracked');
      const before = workspaceFixture.git(['status', '--porcelain=v1']).toString();
      assert.equal(before.includes('tracked'), true);
      assert.equal(JSON.stringify(workspaces.status()).includes('ghu_synthetic_fixture'), false);
    });
    await check('actual-workspace-store-reopen-without-replay', async () => {
      const { openWorkspaceStore } = await moduleAt('../repositories/store.mjs'), reopened = openWorkspaceStore(directory);
      try { assert.equal(reopened.workspaces()[0].project.fields.Status.options.find(option => option.name === 'Pending Review').name, 'Pending Review');
        assert.equal(reopened.selected(), workspaces.status().selected); assert.equal(reopened.pending().length, 0); assert.equal(workspaceFixture.writes, 4); }
      finally { reopened.close(); }
    });
    await check('themes-narrow-zoom-high-contrast-reduced-motion', async () => {
      for (const theme of ['light', 'dark']) { nativeTheme.themeSource = theme; await js("document.getElementById('repositories-nav').click()"); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); }
      window.setSize(420, 760); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
      window.webContents.setZoomFactor(2); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); window.webContents.setZoomFactor(1);
      window.webContents.debugger.attach('1.3'); await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await js("matchMedia('(forced-colors:active)').matches && matchMedia('(prefers-reduced-motion:reduce)').matches"), true); window.webContents.debugger.detach();
      window.setSize(1180, 840); nativeTheme.themeSource = 'dark'; await new Promise(resolve => setTimeout(resolve, 100));
      capture = (await window.webContents.capturePage()).toPNG().toString('base64');
    });
    await check('foreground-close-cancels-actual-owned-native-entry', async () => {
      workspaces.dispatch({ operation: 'begin', mode: 'local' }); workspaces.dispatch({ operation: 'folder' });
      manager.start('ollama', 'connect'); await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(manager.status().connections.find(c => c.id === 'ollama').busy, true);
      const closed = new Promise(resolve => window.once('closed', resolve)); window.close(); await closed;
      assert.equal(manager.status().connections.some(c => c.busy), false);
      assert.equal(workspaces.status().busy, false);
      assert.equal(folderCancelled, true);
    });
  } catch { const snapshot = workspaces.status(); workspaceEvidence = { checkpoint: workspaceStage, busy: snapshot.busy, state: snapshot.draft?.state, error: snapshot.draft?.error, folderSelected: Boolean(snapshot.draft?.folder), projectCount: snapshot.draft?.projects?.length ?? 0 }; process.exitCode = 1; }
  const report = { desktopQualification: 'guided-repositories', checks, passed: checks.length === 16 && checks.every(c => c.passed), milliseconds: Math.round(performance.now() - started), windowReadyFromMainEntryMs: windowReadyMs, measurements,
    versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, sqlite: process.versions.sqlite, os: process.platform, architecture: process.arch },
    nativeEvidence, workspaceEvidence, folderFailure, folderCancelled, synthetic: 'Synthetic GitHub/model replies and first folder selection; actual native secure field, folder-panel cancellation, protected storage, local Git and own window',
    pending: ['Human native folder selection', 'Authenticated provider/GitHub PM journeys', 'Human task observation', 'Screen reader', 'Windows/Linux', 'Stable signed package storage identity'], capture,
    nativeCapture: existsSync(path.join(directory, 'secure-field.png')) ? readFileSync(path.join(directory, 'secure-field.png')).toString('base64') : undefined };
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
  if (window.isDestroyed()) app.exit(report.passed ? 0 : 1);
  else { window.once('closed', () => app.exit(report.passed ? 0 : 1)); window.close(); }
};
