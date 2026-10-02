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
const issueFixtures = new Map();
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
  const { issueFixture } = await moduleAt('../issues/fixture.mjs');
  exports.issueApi = Object.fromEntries(['readCatalog', 'readIssue', 'readDependencies', 'readDetail', 'createIssue', 'addItem', 'setField', 'addDependency', 'ensureReadyLabel', 'setReady'].map(name => [name, async (...args) => {
    const target = args[name === 'readCatalog' ? 2 : 1]; let fixture = issueFixtures.get(target.id);
    if (!fixture) { fixture = issueFixture(target); issueFixtures.set(target.id, fixture); } return fixture.api[name](...args);
  }]));
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

exports.run = async ({ window, directory, vault, manager, workspaces, issues, pipelines, policy, development, developmentChannel, workspaceChannel, issueChannel, pipelineChannel, channel, windowReadyMs }) => {
  const started = performance.now(), checks = [], measurements = [];
  const developmentScope = process.argv.includes('--qualify-development'), pipelineScope = process.argv.includes('--qualify-pipelines'), issueScope = developmentScope || pipelineScope || process.argv.includes('--qualify-issues');
  const js = code => window.webContents.executeJavaScript(code);
  const wait = async predicate => { const until = Date.now() + 10000; while (!await predicate()) { if (Date.now() >= until) throw new Error('qualification-wait-timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } };
  let pipelineControl;
  async function check(name, fn) { const begin = performance.now(); try { await fn(); checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - begin) }); } catch (error) { checks.push({ name, passed: false, category: error.code === 'ERR_ASSERTION' ? 'assertion' : 'native-failure', failureLine: Number(/qualify\.cjs:(\d+)/.exec(error.stack)?.[1]) || null, ...(name.startsWith('pipeline-') ? { control: pipelineControl, publicError: pipelines.status().error } : {}) }); throw error; } }
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
    if (!issueScope) await check('current-codex-unauthenticated-isolated-home', async () => {
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
    if (!issueScope) await check('live-public-github-app-identity', async () => {
      const { readApp } = await moduleAt('../github/device.mjs'), { githubApp } = await moduleAt('../connections/github.mjs'), { appPermissions } = await moduleAt('../github/transport.mjs');
      const live = await readApp(githubApp.slug); assert.equal(live.id, githubApp.id); assert.equal(live.clientId, githubApp.clientId); assert.equal(live.owner, githubApp.owner); assert.deepEqual(live.permissions, appPermissions);
    });
    if (!issueScope) await check('live-cloud-invalid-key-denial', async () => {
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
    const chat = async text => { await js(`document.getElementById('chat-nav').click();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('composer').requestSubmit()`); await issues.idle(); };
    await check('registered-issue-frame-context-and-protected-label', async () => {
      const frame = window.webContents.mainFrame, sender = window.webContents, payload = { operation: 'ready', number: 7, enabled: true, contextRevision: issues.status().revision };
      assert.throws(() => issueChannel.dispatch({ sender: {}, senderFrame: frame }, payload));
      assert.throws(() => issueChannel.dispatch({ sender, senderFrame: { url: frame.url, parent: frame } }, payload));
      assert.throws(() => issueChannel.dispatch({ sender, senderFrame: frame }, { ...payload, origin: 'pm' }));
      assert.throws(() => issueChannel.dispatch({ sender, senderFrame: frame }, { ...payload, contextRevision: payload.contextRevision - 1 }));
      await chat('Show Issues'); await wait(() => Boolean(issues.status().catalog));
      await chat('"Mark Issue #7 Ready"'); assert.equal(issueFixtures.get(issues.status().workspaceId).writes.length, 0);
    });
    await check('chat-draft-exact-preview-and-keyboard-create', async () => {
      await chat('Draft an Issue called Protect my local work'); await wait(() => issues.status().draft?.values.title === 'Protect my local work');
      await chat('Keep my existing files and changes intact.'); await wait(() => Boolean(issues.status().draft.values.summary));
      await chat('Tracked and untracked files remain unchanged.'); await wait(() => Boolean(issues.status().draft.values.acceptance));
      for (const text of ['Set priority to P1', 'Set impact to High', 'Set effort to M', 'Set labels to type:feature', 'Depends on Issue #7']) await chat(text);
      await chat('Review this Issue'); await wait(() => issues.status().draft.state === 'preview');
      const fixture = issueFixtures.get(issues.status().workspaceId); assert.equal(fixture.writes.length, 0);
      await js("document.getElementById('issues-nav').click();document.getElementById('issue-create').focus()"); await wait(() => window.isFocused());
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait(() => issues.status().draft.state === 'complete'); await issues.idle();
      assert.equal(fixture.writes.filter(value => value === 'create').length, 1); assert.deepEqual(fixture.issues[1].dependencies, [7]);
      assert.equal(fixture.issues[1].status, 'Backlog'); assert.equal(fixture.issues[1].ready, false); assert.deepEqual(fixture.issues[1].assignees, []);
      assert.equal(await js("document.getElementById('selected-issue').textContent.includes('Tracked and untracked files remain unchanged.')"), true);
      assert.equal(await js("document.querySelector('#selected-issue .issue-body').textContent.includes('Summary and intended outcome\\n')"), true);
      assert.equal(await js("document.getElementById('selected-issue').querySelectorAll('script,iframe,img').length"), 0);
    });
    await check('chat-ready-active-denial-and-external-drift', async () => {
      const fixture = issueFixtures.get(issues.status().workspaceId);
      await chat('Mark Issue #8 Ready'); await wait(() => fixture.issues[1].ready); await issues.idle();
      assert.deepEqual(fixture.issues[1].labels, ['type:feature', 'Ready for Development']);
      for (const status of ['In Progress', 'In Review', 'Pending Review']) {
        fixture.issues[1].status = status; fixture.issues[1].metadata.Status = status; await chat('Show Issues'); await issues.idle();
        await wait(() => js("document.getElementById('ready-8').disabled"));
        await chat('Remove Ready from Issue #8'); await issues.idle(); assert.equal(issues.status().error, 'ready-active'); assert.equal(fixture.issues[1].ready, true);
      }
      fixture.issues[1].ready = false; fixture.issues[1].labels = ['type:feature']; await chat('Show Issues'); await issues.idle();
      assert.deepEqual(issues.status().catalog.drift, [8]); assert.equal(issues.status().catalog.active.length, 1);
      assert.equal(fixture.writes.filter(value => value === 'ready').length, 1);
      fixture.issues[1].status = 'Backlog'; fixture.issues[1].metadata.Status = 'Backlog'; await chat('Show Issues');
    });
    await check('repository-conversation-draft-and-prompt-scope', async () => {
      await chat('Draft an Issue called Repository one private draft'); await wait(() => issues.status().draft?.values.title === 'Repository one private draft');
      await js("document.getElementById('prompt').value='Repository one unsent text'");
      const first = workspaces.status().workspaces[0], before = issues.status(), secondPath = path.join(workspaceFixture.path, 'second'); mkdirSync(secondPath, { mode: 0o700 });
      workspaceFixture.git(['-C', secondPath, 'init', '-b', 'main']); workspaceFixture.git(['-C', secondPath, 'remote', 'add', 'origin', 'https://github.com/fixture/second.git']);
      const { inspectLocal } = await moduleAt('../repositories/local.mjs'); const inspected = await inspectLocal(secondPath, { repository: 'repo_qualification_second', owner: 'fixture', name: 'second' });
      const { openWorkspaceStore } = await moduleAt('../repositories/store.mjs'), reopened = openWorkspaceStore(directory);
      try { reopened.register({ ...first, id: 'repo_qualification_second', repositoryId: 'R2', numericId: 4, slug: 'fixture/second', name: 'fixture/second', path: secondPath, localKey: inspected.identity.localKey, commonPath: inspected.identity.commonPath }); }
      finally { reopened.close(); }
      workspaces.dispatch({ operation: 'select', workspace: 'repo_qualification_second' }); await wait(() => js("document.getElementById('chat-title').textContent==='fixture/second'"));
      assert.equal(issues.status().draft, null); assert.equal(await js("document.getElementById('transcript').textContent.includes('Repository one private draft')"), false);
      assert.equal(await js("document.getElementById('prompt').value"), '');
      window.webContents.send('issues:status', before); await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(await js("document.getElementById('chat-title').textContent"), 'fixture/second');
      const frame = window.webContents.mainFrame; assert.throws(() => issueChannel.dispatch({ sender: window.webContents, senderFrame: frame }, { operation: 'create', contextRevision: before.revision }));
      workspaces.dispatch({ operation: 'select', workspace: first.id }); await wait(() => js("document.getElementById('transcript').textContent.includes('Repository one private draft')"));
      assert.equal(await js("document.getElementById('prompt').value"), 'Repository one unsent text'); assert.equal(issues.status().draft.values.title, 'Repository one private draft');
      await chat('Cancel Issue draft');
    });
    await check('repository-intake-settings-exact-pm-apply', async () => {
      await js("document.getElementById('settings-nav').click()"); assert.equal(await js("document.getElementById('intake-review').disabled"), true);
      await js("document.getElementById('intake-mode').value='pm';document.getElementById('intake-mode').dispatchEvent(new Event('change'));document.getElementById('intake-review').click()");
      await wait(() => Boolean(issues.status().policyPreview)); assert.equal(issues.status().policy.mode.value, 'coauthored');
      await js("document.getElementById('intake-apply').focus()");
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait(() => issues.status().policy.mode.value === 'pm'); assert.equal(issues.status().policy.mode.source, 'repository'); assert.equal(issues.status().policy.agentCreation.value, false);
    });
    if (pipelineScope) {
      const pipelineChat = async text => { pipelineControl = 'guided-chat'; const before = pipelines.status().revision; await chat(text); await wait(() => pipelines.status().revision > before); assert.equal(pipelines.status().error, null); };
      const change = async (id, value) => { pipelineControl = id; const before = pipelines.status().revision; await js(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change'))`); await wait(() => pipelines.status().revision > before); assert.equal(pipelines.status().error, null); };
      await check('registered-pipeline-frame-context-and-direct-pm-boundary', async () => {
        const frame = window.webContents.mainFrame, sender = window.webContents, payload = { operation: 'begin', kind: 'development', contextRevision: pipelines.status().revision };
        for (const event of [{ sender: {}, senderFrame: frame }, { sender, senderFrame: { url: frame.url, parent: frame } }]) assert.throws(() => pipelineChannel.dispatch(event, payload));
        for (const extra of [{ origin: 'pm' }, { target: 'repo_qualification_second' }, { contextRevision: payload.contextRevision - 1 }]) assert.throws(() => pipelineChannel.dispatch({ sender, senderFrame: frame }, { ...payload, ...extra }));
        pipelines.dispatch({ operation: 'chat', text: '"Use PM-triggered Autonomous Dev"' }); assert.equal(pipelines.status().draft, null);
        assert.throws(() => pipelines.dispatch({ operation: 'chat', text: 'ghu_syntheticSecretOnly123' })); assert.equal(pipelines.status().draft, null);
      });
      await check('pipeline-chat-control-parity-exact-preview-and-keyboard-apply', async () => {
        const original = pipelines.status().current; await pipelineChat('Edit Development pipeline'); await pipelineChat('Rename step 1 to Inspect the exact change');
        await js("document.getElementById('settings-nav').click();document.getElementById('settings-pipelines').click();document.getElementById('pipeline-step-1').open=true");
        assert.equal(await js("document.getElementById('pipeline-step-1-label').value"), 'Inspect the exact change');
        await change('pipeline-step-1-expectedResult', 'Record bounded evidence'); assert.equal(pipelines.status().current.revision, original.revision);
        await pipelineChat('Review this pipeline'); const preview = pipelines.status().preview; assert.match(preview.hash, /^[a-f0-9]{64}$/);
        assert.equal(preview.before['pipelines.development'].value.steps[0].label, original.definition.steps[0].label);
        assert.equal(preview.after['pipelines.development'].value.steps[0].expectedResult, 'Record bounded evidence');
        await js("document.getElementById('settings-nav').click();document.getElementById('pipeline-apply').focus()");
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await wait(() => pipelines.status().current.revision === original.revision + 1);
        assert.equal(pipelines.status().current.definition.steps[0].expectedResult, 'Record bounded evidence');
        pipelines.dispatch({ operation: 'apply', hash: preview.hash }); assert.equal(pipelines.status().current.revision, original.revision + 1);
        assert.equal(await js("document.getElementById('pipeline-settings').querySelectorAll('script,iframe,img').length"), 0);
      });
      await check('pipeline-controls-add-reorder-declarations-routes-bounds-and-correction', async () => {
        await pipelineChat('Edit Development pipeline'); await js("document.getElementById('settings-nav').click()");
        await js("document.getElementById('pipeline-add-label').value='Bounded evidence check';document.getElementById('pipeline-add-kind').value='check';document.getElementById('pipeline-add-after').value='1';document.getElementById('pipeline-add-label').form.requestSubmit()");
        await wait(() => pipelines.status().draft.definition.steps.length === 7);
        await js("document.getElementById('pipeline-step-2').open=true"); await change('pipeline-step-2-move', '4');
        assert.equal(pipelines.status().draft.definition.steps[2].label, 'Bounded evidence check');
        await change('pipeline-step-3-kind', 'agent'); await change('pipeline-step-3-expectedResult', 'Check only declared evidence');
        await js("document.getElementById('pipeline-step-3-evidence-tests').click();"); await wait(() => pipelines.status().draft.definition.steps[2].evidence.includes('tests'));
        await js("document.getElementById('pipeline-step-3-inputs-artifact').click()"); await wait(() => pipelines.status().draft.definition.steps[2].inputs.includes('artifact'));
        await js("document.getElementById('pipeline-step-3-permissions-workspace.write').click()"); await wait(() => pipelines.status().draft.definition.steps[2].permissions.includes('workspace.write'));
        assert.equal(pipelines.status().current.grantedPermissions.includes('workspace.write'), false);
        await change('pipeline-step-3-feedback', '2'); await change('pipeline-step-3-retryLimit', '11');
        await js("document.getElementById('pipeline-review').click()"); await wait(() => Boolean(pipelines.status().error)); assert.equal(pipelines.status().preview, null);
        await change('pipeline-step-3-retryLimit', '2'); await change('pipeline-step-3-visitLimit', '5'); await pipelineChat('Review this pipeline');
        assert(pipelines.status().preview); await pipelineChat('Remove step 3');
        await js("document.getElementById('settings-nav').click();document.getElementById('pipeline-review').click()"); await wait(() => Boolean(pipelines.status().error)); assert.equal(pipelines.status().preview, null);
        await pipelineChat('Send step 2 success to step 3'); await pipelineChat('Rename step 2 to Implement the bounded change'); await pipelineChat('Review this pipeline'); await pipelineChat('Apply this pipeline');
        assert.equal(pipelines.status().current.definition.steps.length, 6); assert.equal(pipelines.status().current.grantedPermissions.includes('workspace.write'), false);
      });
      await check('pipeline-durable-drafts-inheritance-stale-base-and-repository-switch', async () => {
        await pipelineChat('Edit global Release pipeline'); await pipelineChat('Rename step 1 to Build on the compatible host'); await pipelineChat('Review this pipeline'); await pipelineChat('Apply this pipeline');
        await pipelineChat('Edit repository Release pipeline'); assert.equal(pipelines.status().current.source, 'global'); await pipelineChat('Rename step 1 to Repository build');
        const { openWorkspaceStore } = await moduleAt('../repositories/store.mjs'), reopened = openWorkspaceStore(directory);
        try { assert.equal(reopened.pipelineDraft(pipelines.status().workspaceId, 'release').definition.steps[0].label, 'Repository build'); }
        finally { reopened.close(); }
        const { openPolicyStore } = await moduleAt('../core/policy.mjs'); const ledger = openPolicyStore(directory, { catalog: () => policy.worker.read(null).bindings });
        try { assert.equal(ledger.worker.read(null).values['pipelines.release'].value.steps[0].label, 'Build on the compatible host'); }
        finally { ledger.close(); }
        await pipelineChat('Review this pipeline'); const before = pipelines.status(), first = workspaces.status().selected;
        workspaces.dispatch({ operation: 'select', workspace: 'repo_qualification_second' }); await wait(() => pipelines.status().workspaceId === 'repo_qualification_second');
        assert.equal(pipelines.status().draft, null); assert.equal(pipelines.status().preview, null);
        const frame = window.webContents.mainFrame; assert.throws(() => pipelineChannel.dispatch({ sender: window.webContents, senderFrame: frame }, { operation: 'apply', hash: before.preview.hash, contextRevision: before.revision }));
        window.webContents.send('pipelines:status', before); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(await js("document.getElementById('pipeline-scope').selectedOptions[0].textContent"), 'fixture/second');
        workspaces.dispatch({ operation: 'select', workspace: first }); await wait(() => pipelines.status().workspaceId === first); assert.equal(pipelines.status().draft.definition.steps[0].label, 'Repository build');
        const input = policy.control.capture({ commandId: 'native-40-other-policy', conversationId: 'native-40-pm', target: first, text: 'Synthetic bounded retention change' });
        const p = policy.control.prepare({ inputId: input.id, requestId: 'native-40-other-preview', target: first, scope: 'repository', changes: { 'privacy.conversationDays': 120 }, reset: [] });
        policy.control.apply({ commandId: 'native-40-other-apply', proposalId: p.id, inputId: input.id, conversationId: 'native-40-pm', target: first, hash: p.hash }); pipelines.sync();
        assert.equal(pipelines.status().staleDraft, true); assert.equal(pipelines.status().preview, null);
        await pipelineChat('Refresh this pipeline draft'); await pipelineChat('Review this pipeline'); await pipelineChat('Apply this pipeline');
        await pipelineChat('Reset Release pipeline to inherit'); await pipelineChat('Review this pipeline'); await pipelineChat('Apply this pipeline');
        assert.equal(pipelines.status().current.definition.steps[0].label, 'Build on the compatible host'); assert.equal(pipelines.status().current.source, 'global');
        assert.equal(policy.worker.read(first).values['privacy.conversationDays'].value, 120);
      });
      await check('pipeline-preset-preview-and-accessible-semantic-fields', async () => {
        await pipelineChat('Edit repository Development pipeline'); await pipelineChat('Use PM-triggered Autonomous Dev'); await pipelineChat('Review this pipeline');
        assert.equal(pipelines.status().preview.after['pipelines.development'].value.steps.some(step => step.kind === 'pm-qa'), false);
        assert.equal(pipelines.status().preview.after['pipelines.release'].value.steps.some(step => step.kind === 'pm-qa'), false);
        assert.equal(policy.worker.read(pipelines.status().workspaceId).values['background.enabled'].value, false);
        assert.equal(policy.worker.read(pipelines.status().workspaceId).values['intake.agentCreation'].value, false);
        await js("document.getElementById('settings-nav').click();document.getElementById('pipeline-step-1').open=true");
        assert.equal(await js("Array.from(document.querySelectorAll('#pipeline-settings input,#pipeline-settings select')).every(input=>Array.from(document.querySelectorAll('#pipeline-settings label')).some(label=>label.htmlFor===input.id)||input.closest('label'))"), true);
        assert.equal(await js("document.getElementById('pipeline-settings').textContent.includes('step_')"), false);
        assert.equal(await js("document.getElementById('pipeline-settings').textContent.includes('D-13')"), false);
        assert.equal(await js("document.getElementById('pipeline-apply').textContent"), 'Apply this pipeline');
      });
    }
    if (developmentScope) {
      await check('development-native-Dev-preview-and-keyboard-apply', async () => {
        const epoch = vault.begin('ollama'); vault.save('ollama', epoch, { credential: fixtureKey, view: { health: 'connected', selectedModel: 'deepseek-v4.1-flash', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek fixture' }],
          capability: { model: 'deepseek-v4.1-flash', testedAt: Date.now(), stream: true, toolLoop: true, resumed: true, scope: 'Synthetic native fixture only.' } } });
        manager.start('ollama', 'refresh'); await manager.idle('ollama');
        await js("document.getElementById('chat-nav').click();document.getElementById('prompt').value='Use Ollama as the Dev';document.getElementById('composer').requestSubmit()");
        await wait(() => Boolean(development.status().preview));
        assert.equal(development.status().configuredDev.value, null);
        assert.equal(development.status().preview.scope, 'repository');
        await js("document.getElementById('settings-nav').click();document.getElementById('settings-agents').click();document.getElementById('dev-apply').focus()");
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await wait(() => Boolean(development.status().configuredDev.value));
        assert.equal(development.status().configuredDev.binding.model, 'deepseek-v4.1-flash');
        assert.equal(await js("document.body.textContent.includes('synthetic-native-entry-only')"), false);
      });
      await check('development-native-scope-and-registered-frame-fences', async () => {
        await js("document.getElementById('dev-permissions-host').click()"); await wait(() => Boolean(development.status().preview));
        const frame = window.webContents.mainFrame, payload = { operation: 'apply', hash: development.status().preview.hash, contextRevision: development.status().revision };
        assert.equal(development.status().preview.target, null); assert.equal(development.status().preview.scope, 'host');
        assert.throws(() => developmentChannel.dispatch({ sender: {}, senderFrame: frame }, payload));
        assert.throws(() => developmentChannel.dispatch({ sender: window.webContents, senderFrame: frame }, { ...payload, contextRevision: payload.contextRevision - 1 }));
        assert.throws(() => developmentChannel.dispatch({ sender: window.webContents, senderFrame: frame }, { ...payload, Ready: true }));
        await js("document.getElementById('dev-apply').focus()"); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await wait(() => !development.status().preview); assert(development.status().permissions.host.value.includes('provider.turn'));
        assert.equal(development.status().permissions.repository.value.includes('provider.turn'), false);
        await js("document.getElementById('dev-permissions-repository').click()"); await wait(() => Boolean(development.status().preview));
        assert.equal(development.status().preview.target, development.status().workspaceId); await js("document.getElementById('dev-cancel').click()"); await wait(() => !development.status().preview);
        assert.equal(development.status().permissions.repository.value.includes('provider.turn'), false);
      });
      await check('development-native-starter-inventory-and-chat-status', async () => {
        await js("document.getElementById('dev-starter-skills').open=true");
        const skills = development.status().skills; assert.equal(skills.length, 4); assert.equal(new Set(skills.map(skill => skill.id)).size, 4);
        assert(skills.every(skill => skill.version === '1.0.0' && skill.license === 'MIT' && /^[a-f0-9]{64}$/.test(skill.digest)));
        assert.equal(development.status().run, null);
        await js("document.getElementById('chat-nav').click();document.getElementById('prompt').value='Show development';document.getElementById('composer').requestSubmit()");
        await wait(() => js("document.getElementById('transcript').textContent.includes('qualified Dev')"));
        assert.equal(await js("Boolean(document.getElementById('chat-development-start'))"), true);
      });
    }
    await check('themes-narrow-zoom-high-contrast-reduced-motion', async () => {
      if (developmentScope) await js("document.getElementById('settings-nav').click();document.getElementById('settings-agents').click()");
      for (const theme of ['light', 'dark']) for (const view of ['repositories', 'issues', 'settings']) { nativeTheme.themeSource = theme; await js(`document.getElementById('${view}-nav').click()`); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); }
      await js("document.getElementById('issues-nav').click()");
      await js('window.scrollTo(0,document.documentElement.scrollHeight)'); assert.equal(await js("document.getElementById('issues-nav').getBoundingClientRect().top>=76 && document.getElementById('issues-nav').getBoundingClientRect().bottom<=innerHeight"), true);
      window.setSize(420, 760); await new Promise(resolve => setTimeout(resolve, 150));
      for (const view of pipelineScope ? ['issues', 'settings'] : ['issues']) { await js(`document.getElementById('${view}-nav').click()`); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); }
      window.webContents.setZoomFactor(2); await new Promise(resolve => setTimeout(resolve, 100));
      for (const view of pipelineScope ? ['issues', 'settings'] : ['issues']) { await js(`document.getElementById('${view}-nav').click()`); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); } window.webContents.setZoomFactor(1);
      window.webContents.debugger.attach('1.3'); await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await js("matchMedia('(forced-colors:active)').matches && matchMedia('(prefers-reduced-motion:reduce)').matches"), true);
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
      assert.equal(await js("matchMedia('(forced-colors:active)').matches"), false); window.webContents.debugger.detach();
      window.setSize(1180, 840); nativeTheme.themeSource = 'dark'; await js('window.scrollTo(0,0)'); await new Promise(resolve => setTimeout(resolve, 100));
      if (pipelineScope) await js("document.getElementById('settings-nav').click();document.getElementById('settings-pipelines').click();document.getElementById('pipeline-step-1').open=true;window.scrollTo(0,document.getElementById('pipeline-draft').offsetTop-100)");
      if (developmentScope) await js("document.getElementById('settings-nav').click();document.getElementById('settings-agents').click();document.getElementById('dev-starter-skills').open=true");
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await new Promise(resolve => setTimeout(resolve, 100));
      if (developmentScope) assert.equal(await js("!document.getElementById('settings-view').hidden && !document.getElementById('agent-settings').hidden && document.getElementById('settings-nav').getAttribute('aria-current')==='page'"), true);
      assert.equal(await js("getComputedStyle(document.body).backgroundColor==='rgb(16, 23, 34)'"), true);
      capture = (await window.webContents.capturePage()).toPNG(); writeFileSync(path.join(directory, 'window-capture.png'), capture, { flag: 'wx', mode: 0o600 });
    });
    await check('foreground-close-cancels-actual-owned-native-entry', async () => {
      const fixture = issueFixtures.get(issues.status().workspaceId);
      fixture.delay(signal => new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); }));
      issues.dispatch({ operation: 'refresh' }); await wait(() => issues.status().busy);
      workspaces.dispatch({ operation: 'begin', mode: 'local' }); workspaces.dispatch({ operation: 'folder' });
      manager.start('ollama', 'connect'); await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(manager.status().connections.find(c => c.id === 'ollama').busy, true);
      const closed = new Promise(resolve => window.once('closed', resolve)); window.close(); await closed;
      assert.equal(manager.status().connections.some(c => c.busy), false);
      assert.equal(workspaces.status().busy, false);
      assert.equal(issues.status().busy, false);
      assert.equal(folderCancelled, true);
    });
  } catch { const snapshot = workspaces.status(); workspaceEvidence = { checkpoint: workspaceStage, busy: snapshot.busy, state: snapshot.draft?.state, error: snapshot.draft?.error, folderSelected: Boolean(snapshot.draft?.folder), projectCount: snapshot.draft?.projects?.length ?? 0 }; process.exitCode = 1; }
  const report = { desktopQualification: developmentScope ? 'development-controls' : pipelineScope ? 'versioned-pipeline-editing' : 'protected-issue-intake', checks, passed: checks.length === (developmentScope ? 21 : pipelineScope ? 23 : issueScope ? 18 : 21) && checks.every(c => c.passed), milliseconds: Math.round(performance.now() - started), windowReadyFromMainEntryMs: windowReadyMs, measurements,
    versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, sqlite: process.versions.sqlite, os: process.platform, architecture: process.arch },
    nativeEvidence, workspaceEvidence, folderFailure, folderCancelled, synthetic: 'Synthetic GitHub/model replies and first folder selection; actual native secure field, folder-panel cancellation, protected storage, local Git and own window',
    notRun: issueScope ? ['Unchanged Codex unauthenticated discovery', 'Unchanged public GitHub App qualification', 'Unchanged invalid Cloud key probe'] : [],
    pending: ['Human native folder selection', 'Authenticated provider/GitHub PM journeys', 'Human task observation', 'Screen reader', 'Windows/Linux', 'Stable signed package storage identity'], captureAvailable: Boolean(capture),
    nativeCaptureAvailable: existsSync(path.join(directory, 'secure-field.png')) };
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
  if (window.isDestroyed()) app.exit(report.passed ? 0 : 1);
  else { window.once('closed', () => app.exit(report.passed ? 0 : 1)); window.close(); }
};
