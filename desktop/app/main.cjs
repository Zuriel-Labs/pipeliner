'use strict';
const { app, BrowserWindow, Menu, protocol, session, ipcMain, dialog, shell, safeStorage, powerMonitor } = require('electron');
const { mkdirSync, lstatSync, realpathSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
if (app.isPackaged && process.argv.some(value => /^(?:--qualify(?:-|=|$)|--(?:data-directory|key-helper|calendar-helper)(?:=|$))/i.test(value))) {
  console.error('Pipeliner rejected an unsupported packaged startup option.'); app.exit(2); return;
}
const origin = 'pipeliner://app', url = `${origin}/index.html`;
const argument = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const qualifying = process.argv.includes('--qualify');
const backgroundLaunch = process.argv.includes('--background-helper');
const entryStarted = performance.now(); let windowReadyMs;
const dataDirectory = argument('--data-directory') ?? path.join(app.getPath('appData'), 'Pipeliner');
const helper = argument('--key-helper') ?? (app.isPackaged ? path.join(process.resourcesPath, 'helpers/secure-entry') : undefined);
const calendarHelper = argument('--calendar-helper') ?? (app.isPackaged ? path.join(process.resourcesPath, 'helpers/calendar') : undefined);
app.setName('Pipeliner'); app.setPath('userData', dataDirectory); app.setPath('crashDumps', path.join(dataDirectory, 'crashes'));
protocol.registerSchemesAsPrivileged([{ scheme: 'pipeliner', privileges: { standard: true, secure: true } }]);
if (!app.requestSingleInstanceLock()) app.exit(0);
let window, manager, vault, workspaces, workspaceStore, issues, pipelines, policy, development, developmentStore, supervisor, scheduling, scheduler, background, backgroundHost, backgroundNative, skills, skillStore, tools, toolStore, toolConnections, privacy, privacyRecords, retentionMonitor, attachWindow, attachment, requestShutdown, authorizationMonitor, shutdownPaused = false, closing = false, verifiedClose = false;
const moduleAt = file => import(pathToFileURL(path.join(__dirname, file)).href);
const assets = new Map(['index.html', 'app.css', 'app.mjs', 'workspaces.mjs', 'issues.mjs', 'pipelines.mjs', 'development.mjs', 'scheduling.mjs', 'background.mjs', 'skills.mjs', 'tools.mjs', 'privacy.mjs'].map(file => [file, path.join(__dirname, file)]));
assets.set('commands.mjs', path.join(__dirname, '../connections/commands.mjs')); assets.set('tokens.css', path.join(__dirname, '../prototype/style.css'));
assets.set('issue-commands.mjs', path.join(__dirname, '../issues/commands.mjs')); assets.set('connections/commands.mjs', path.join(__dirname, '../connections/commands.mjs'));
assets.set('pipeline-commands.mjs', path.join(__dirname, '../pipelines/commands.mjs'));
assets.set('development-commands.mjs', path.join(__dirname, '../development/commands.mjs'));
assets.set('scheduling-commands.mjs', path.join(__dirname, '../scheduling/commands.mjs'));
assets.set('background-commands.mjs', path.join(__dirname, '../background/commands.mjs'));
assets.set('skill-commands.mjs', path.join(__dirname, '../skills/commands.mjs'));
assets.set('tool-commands.mjs', path.join(__dirname, '../tools/commands.mjs'));
assets.set('privacy-commands.mjs', path.join(__dirname, '../privacy/commands.mjs'));
assets.set('tools/commands.mjs', path.join(__dirname, '../tools/commands.mjs'));
function asset(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'pipeliner:' && parsed.host === 'app' && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash && assets.has(parsed.pathname.slice(1)) ? parsed.pathname.slice(1) : null; }
  catch { return null; }
}

app.whenReady().then(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('host-unqualified');
  mkdirSync(dataDirectory, { mode: 0o700, recursive: true });
  const directory = realpathSync(dataDirectory), info = lstatSync(dataDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid() || directory !== path.resolve(dataDirectory)) throw new Error('storage-directory-invalid');
  const { openMacBackgroundService } = await moduleAt('../background/native.mjs');
  backgroundNative = qualifying && process.argv.includes('--qualify-background') ? require('./qualify.cjs').backgroundNative() : await openMacBackgroundService(app);
  if (backgroundLaunch) {
    // Read protected host intent before opening credentials, connections, workers or a UI.
    if (!app.isPackaged || !backgroundNative.inspect().qualified || backgroundNative.inspect().status !== 'enabled') { app.exit(0); return; }
    const { openPolicyStore } = await moduleAt('../core/policy.mjs');
    const startup = openPolicyStore(directory, { catalog: () => ({ repositories: [], capabilities: [], maxConcurrency: 1, background: false, connections: [], developers: [], extensions: [] }) });
    let allowed; try { const v = startup.worker.read(null).values; allowed = v['background.enabled'].value && v['background.startAtLogin'].value; } finally { startup.close(); }
    if (!allowed) { app.exit(0); return; } app.setActivationPolicy('accessory');
  }
  const { createConnectionManager } = await moduleAt('../connections/manager.mjs');
  const { createConnectionControlChannel } = await moduleAt('../core/control.mjs');
  const { createWorkspaceControlChannel } = await moduleAt('../core/control.mjs');
  const { createIssueControlChannel } = await moduleAt('../core/control.mjs');
  const { createPipelineControlChannel } = await moduleAt('../core/control.mjs');
  const { createDevelopmentControlChannel } = await moduleAt('../core/control.mjs');
  const { createSchedulingControlChannel } = await moduleAt('../core/control.mjs');
  const { createBackgroundControlChannel } = await moduleAt('../core/control.mjs');
  const { createSkillControlChannel } = await moduleAt('../core/control.mjs');
  const { createToolControlChannel } = await moduleAt('../core/control.mjs');
  const { createPrivacyControlChannel } = await moduleAt('../core/control.mjs');
  const { createPrivacyManager } = await moduleAt('../privacy/manager.mjs');
  const { openPrivacyStore } = await moduleAt('../privacy/store.mjs');
  const { privacyCommand } = await moduleAt('../privacy/commands.mjs');
  const { createSkillManager } = await moduleAt('../skills/manager.mjs');
  const { openSkillStore } = await moduleAt('../skills/store.mjs');
  const { createToolManager } = await moduleAt('../tools/manager.mjs');
  const { openToolStore } = await moduleAt('../tools/store.mjs');
  const { createToolConnections } = await moduleAt('../tools/connections.mjs');
  const { createBackgroundHost } = await moduleAt('../background/host.mjs');
  const { createBackgroundManager } = await moduleAt('../background/manager.mjs');
  const { createSchedulingManager } = await moduleAt('../scheduling/manager.mjs');
  const { createScheduler } = await moduleAt('../scheduling/scheduler.mjs');
  const { nextCalendar } = await moduleAt('../scheduling/calendar.mjs');
  const { createDevelopmentManager } = await moduleAt('../development/manager.mjs');
  const { createPipelineManager } = await moduleAt('../pipelines/manager.mjs');
  const { createIssueManager } = await moduleAt('../issues/manager.mjs');
  const { openPolicyStore } = await moduleAt('../core/policy.mjs');
  const { createWorkspaceManager } = await moduleAt('../repositories/manager.mjs');
  const { githubAdapter } = await moduleAt('../connections/github.mjs');
  const { codexAdapter, ollamaAdapter } = await moduleAt('../connections/providers.mjs');
  const { nativeKeyEntry, nativeFolderEntry, nativeMCPEntry } = await moduleAt('../connections/native-entry.mjs');
  const activeConnections = new Set();
  const publish = snapshot => {
    development?.sync(); scheduling?.sync(); background?.sync();
    let returned = false;
    for (const connection of snapshot.connections) { if (activeConnections.has(connection.id) && !connection.busy) returned = true; if (connection.busy) activeConnections.add(connection.id); else activeConnections.delete(connection.id); }
    if (window && !window.isDestroyed()) { window.webContents.send('connections:status', snapshot); if (returned && !closing) { window.show(); window.focus(); window.webContents.focus(); } }
  };
  let adapters = {
    github: githubAdapter({ prompt: githubPrompt }), 'github-setup': githubAdapter({ setup: true, prompt: githubPrompt }),
    codex: codexAdapter({ directory, openBrowser: async value => { await shell.openExternal(value); } }),
    ollama: ollamaAdapter({ entry: signal => nativeKeyEntry(helper, directory, signal) }),
  };
  if (qualifying) adapters = await require('./qualify.cjs').adapters({ directory, helper, nativeKeyEntry });
  manager = createConnectionManager({ vault: null, adapters, onChange: publish });
  const workspaceOptions = qualifying ? await require('./qualify.cjs').workspaceOptions({ directory, helper, nativeFolderEntry }) : {};
  let workspaceBusy = false;
  const publishWorkspaces = snapshot => { issues?.sync(); pipelines?.sync(); development?.sync(); scheduling?.sync(); skills?.sync(); tools?.sync(); privacy?.sync(); void scheduler?.sync().catch(() => {}); if (window && !window.isDestroyed()) { window.webContents.send('workspaces:status', snapshot); if (workspaceBusy && !snapshot.busy && !closing) { window.show(); window.focus(); window.webContents.focus(); } } workspaceBusy = snapshot.busy; };
  const makeWorkspaces = initialRevision => createWorkspaceManager({ store: workspaceStore, initialRevision, onChange: publishWorkspaces,
    connections: { status: () => manager.status(), acquire: (...args) => manager.acquire(...args), epoch: id => manager.epoch(id) },
    folder: (signal, existing) => nativeFolderEntry(helper, directory, signal, existing),
    protectedPaths: [directory, __dirname, path.join(app.getPath('home'), '.codex'), path.join(app.getPath('home'), '.agents')],
    openInstallation: () => shell.openExternal('https://github.com/apps/pipeliner-desktop/installations/new'), ...workspaceOptions });
  workspaces = makeWorkspaces(1);
  const publishIssues = snapshot => { pipelines?.sync(); development?.sync(); privacy?.sync(); if (window && !window.isDestroyed()) window.webContents.send('issues:status', snapshot); };
  const makeIssues = initialRevision => createIssueManager({ store: workspaceStore, policy, initialRevision, onChange: publishIssues,
    connections: { acquire: (...args) => manager.acquire(...args), epoch: id => manager.epoch(id) },
    ...(qualifying ? { api: require('./qualify.cjs').issueApi } : {}) });
  issues = makeIssues(1);
  const publishPipelines = snapshot => { development?.sync(); scheduling?.sync(); skills?.sync(); tools?.sync(); void scheduler?.sync().catch(() => {}); if (window && !window.isDestroyed()) window.webContents.send('pipelines:status', snapshot); };
  const makePipelines = initialRevision => createPipelineManager({ store: workspaceStore, policy, skills: skillStore, tools: toolStore, initialRevision, onChange: publishPipelines, onApplied: () => issues.sync() });
  pipelines = makePipelines(1);
  const previousRuns = new Map();
  const publishDevelopment = snapshot => {
    pipelines?.sync(); skills?.sync(); tools?.sync();
    if (scheduler && workspaceStore && !closing) for (const workspace of workspaceStore.workspaces()) {
      const current = policy.runtime.status(workspace.id), previous = previousRuns.get(workspace.id); previousRuns.set(workspace.id, current?.id ?? null);
      if (previous && !current) void scheduler.completed(workspace.id).catch(() => {});
    }
    scheduling?.sync(); if (window && !window.isDestroyed()) window.webContents.send('development:status', snapshot);
  };
  const makeDevelopment = initialRevision => createDevelopmentManager({ store: workspaceStore, policy, ledger: developmentStore, supervisor, skills: skillStore, tools: toolStore,
    connectMCP: toolConnections ? (...args) => toolConnections.lease(...args) : undefined, toolEpoch: toolConnections ? endpoint => toolConnections.epoch(endpoint) : undefined, initialRevision,
    connections: { developers: () => manager.developers(), status: () => manager.status(), acquire: (...args) => manager.acquire(...args), acquireProvider: (...args) => manager.acquireProvider(...args) }, onChange: publishDevelopment,
    openCandidate: value => shell.openExternal(value), hostAuthority: () => !closing && (backgroundHost?.executionAllowed() ?? !backgroundLaunch),
    ...(qualifying ? { api: require('./qualify.cjs').issueApi } : {}) });
  development = makeDevelopment(1);
  const publishScheduling = snapshot => { background?.sync(); pipelines?.sync(); skills?.sync(); tools?.sync(); if (window && !window.isDestroyed()) window.webContents.send('scheduling:status', snapshot); };
  const makeScheduling = initialRevision => createSchedulingManager({ store: workspaceStore, policy, scheduler, initialRevision, onChange: publishScheduling });
  scheduling = makeScheduling(1);
  const publishBackground = snapshot => { pipelines?.sync(); skills?.sync(); tools?.sync(); if (window && !window.isDestroyed()) window.webContents.send('background:status', snapshot); };
  const makeBackground = initialRevision => createBackgroundManager({ policy, host: backgroundHost, initialRevision, onChange: publishBackground,
    scheduler: () => workspaceStore && scheduler ? workspaceStore.workspaces().map(workspace => ({ repository: workspace.name, ...scheduler.status(workspace.id) })) : [] });
  background = makeBackground(1);
  const publishSkills = snapshot => { if (window && !window.isDestroyed()) window.webContents.send('skills:status', snapshot); };
  const makeSkills = initialRevision => createSkillManager({ store: workspaceStore, policy, skills: skillStore, initialRevision, onChange: publishSkills,
    occupiedNames: () => [...(skillStore?.names() ?? []), ...(toolStore?.names() ?? [])],
    onApplied: () => { development.sync(); pipelines.sync(); tools?.sync(); }, ...(qualifying ? require('./qualify.cjs').skillOptions() : {}) });
  skills = makeSkills(1);
  const publishTools = snapshot => { if (window && !window.isDestroyed()) window.webContents.send('tools:status', snapshot); };
  const makeTools = initialRevision => createToolManager({ store: workspaceStore, policy, tools: toolStore, connections: toolConnections, initialRevision, onChange: publishTools,
    occupiedNames: () => [...(skillStore?.names() ?? []), ...(toolStore?.names() ?? [])],
    onApplied: () => { development.sync(); pipelines.sync(); skills.sync(); } });
  tools = makeTools(1);
  const privatePaths = () => [directory, __dirname, path.join(app.getPath('home'), 'Library'), app.getPath('appData'), path.join(app.getPath('home'), '.codex'), path.join(app.getPath('home'), '.agents'), path.join(app.getPath('home'), '.ollama'),
    ...(workspaceStore?.workspaces() ?? []).map(item => path.join(item.path, '.git'))];
  const publishPrivacy = snapshot => { if (window && !window.isDestroyed()) window.webContents.send('privacy:status', snapshot); };
  let recoveryHolds = new Set(), recoveryInventory = [];
  const refreshRecovery = () => {
    recoveryInventory = developmentStore?.recovery() ?? [];
    recoveryHolds = new Set(recoveryInventory.map(item => item.repository));
    for (const item of workspaceStore?.workspaces() ?? []) if (policy?.runtime.status(item.id)) recoveryHolds.add(item.id);
    for (const effect of workspaceStore?.pending() ?? []) if (effect.binding.repository) recoveryHolds.add(effect.binding.repository);
  };
  const makePrivacy = initialRevision => createPrivacyManager({ records: privacyRecords, policy, initialRevision, onChange: publishPrivacy,
    workspace: () => { const id = workspaceStore?.selected(); const item = workspaceStore?.workspaces().find(value => value.id === id);
      return item ? { id, name: item.name, issue: workspaceStore.issueContext(id)?.selected ?? null } : null; },
    protectedPaths: privatePaths, onApplied: () => { issues?.sync(); pipelines?.sync(); development?.sync(); scheduling?.sync(); background?.sync(); skills?.sync(); tools?.sync(); },
    chooseExport: async ({ kind, signal }) => {
      signal.throwIfAborted(); const parent = await attachWindow(); signal.throwIfAborted();
      const result = await dialog.showSaveDialog(parent, { title: 'Choose a local export', defaultPath: kind === 'diagnostics' ? 'Pipeliner diagnostics.json' : 'Pipeliner settings.json',
        buttonLabel: 'Review export', filters: [{ name: 'JSON export', extensions: ['json'] }], showsTagField: false,
        message: 'Choose a new JSON filename. Review the content before saving; existing files are preserved.' });
      signal.throwIfAborted(); return result.canceled ? null : result.filePath;
    },
    chooseImport: async ({ signal }) => {
      signal.throwIfAborted(); const parent = await attachWindow(); signal.throwIfAborted();
      const result = await dialog.showOpenDialog(parent, { title: 'Choose settings to review', buttonLabel: 'Review restore', filters: [{ name: 'Pipeliner JSON export', extensions: ['json'] }], properties: ['openFile'] });
      signal.throwIfAborted(); return result.canceled ? null : result.filePaths.length === 1 ? result.filePaths[0] : null;
    },
    diagnostics: () => {
      refreshRecovery(); const inventory = privacyRecords.inventory().categories, states = manager.status().connections;
      const host = policy.worker.read(null).values, service = backgroundHost?.status();
      return { appVersion: app.getVersion(), host: { platform: process.platform, architecture: process.arch, version: process.getSystemVersion() },
        storage: { protected: true, categories: Object.fromEntries(['conversation', 'log', 'audit'].map(category => [category, inventory.filter(row => row.category === category).reduce((sum, row) => sum + row.count, 0)])),
          ciphertextBytes: inventory.reduce((sum, row) => sum + row.bytes, 0) },
        connections: Object.fromEntries(['github', 'codex', 'ollama'].map(id => { const connection = states.find(item => item.id === id); return [id, ['connected', 'limited'].includes(connection?.health) ? 'connected' : connection?.health === 'disconnected' ? 'disconnected' : 'blocked']; })),
        recovery: { activeRuns: (workspaceStore?.workspaces() ?? []).filter(item => policy.runtime.status(item.id)).length,
          uncertainEffects: recoveryInventory.reduce((sum, item) => sum + item.uncertainEffects, 0) + workspaceStore.pending().length,
          blockedRuns: recoveryInventory.filter(item => ['blocked', 'integration-required'].includes(item.state)).length },
        background: { configured: host['background.enabled'].value, effective: service?.effective ?? false } };
    } });
  privacy = makePrivacy(1);
  protocol.handle('pipeliner', request => {
    const name = request.method === 'GET' ? asset(request.url) : null;
    if (!name) return new Response('Unavailable', { status: 404 });
    return new Response(readFileSync(assets.get(name)), { headers: { 'Content-Type': `${name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !asset(details.url) }));
  attachWindow = async () => {
    if (closing) return; if (window && !window.isDestroyed()) { window.show(); window.focus(); return window; }
    if (attachment) return attachment;
    attachment = (async () => {
    app.setActivationPolicy('regular'); backgroundHost?.setVisible(true);
    await backgroundHost?.refresh(); if (backgroundHost?.executionAllowed()) await scheduler?.resume();
    window = new BrowserWindow({ width: 1180, height: 840, minWidth: 420, minHeight: 580, show: false, title: 'Pipeliner', backgroundColor: '#101722',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false } });
    const attached = window;
    attached.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) attached.webContents.on(event, e => e.preventDefault());
    attached.on('close', event => {
      if (verifiedClose) return;
      if (!closing && backgroundHost?.status().effective) return;
      event.preventDefault(); void requestShutdown?.();
    });
    attached.on('closed', () => { if (window === attached) window = null; backgroundHost?.setVisible(false); if (!closing && backgroundHost?.status().effective) app.setActivationPolicy('accessory'); });
    attached.once('ready-to-show', () => { windowReadyMs ??= performance.now() - entryStarted; if (!closing) attached.show(); }); await attached.loadURL(url); return attached;
    })().finally(() => { attachment = null; }); return attachment;
  };
  const channel = () => createConnectionControlChannel(manager, { contents: window.webContents, url, context: () => ({ revision: manager.status().revision }) });
  ipcMain.handle('connections:control', (event, payload) => { if (closing) throw new Error('App closing'); return channel().dispatch(event, payload); });
  const workspaceChannel = () => createWorkspaceControlChannel(workspaces, { contents: window.webContents, url, context: () => ({ revision: workspaces.status().revision }) });
  ipcMain.handle('workspaces:control', (event, payload) => { if (closing) throw new Error('App closing'); return workspaceChannel().dispatch(event, payload); });
  const issueChannel = () => createIssueControlChannel(issues, { contents: window.webContents, url, context: () => ({ revision: issues.status().revision }) });
  ipcMain.handle('issues:control', (event, payload) => { if (closing) throw new Error('App closing'); return issueChannel().dispatch(event, payload); });
  const pipelineChannel = () => createPipelineControlChannel(pipelines, { contents: window.webContents, url, context: () => ({ revision: pipelines.status().revision }) });
  ipcMain.handle('pipelines:control', (event, payload) => { if (closing) throw new Error('App closing'); return pipelineChannel().dispatch(event, payload); });
  const developmentChannel = () => createDevelopmentControlChannel(development, { contents: window.webContents, url, context: () => ({ revision: development.status().revision }) });
  ipcMain.handle('development:control', (event, payload) => { if (closing) throw new Error('App closing'); return developmentChannel().dispatch(event, payload); });
  const schedulingChannel = () => createSchedulingControlChannel(scheduling, { contents: window.webContents, url, context: () => ({ revision: scheduling.status().revision }) });
  ipcMain.handle('scheduling:control', (event, payload) => { if (closing) throw new Error('App closing'); return schedulingChannel().dispatch(event, payload); });
  const backgroundChannel = () => createBackgroundControlChannel(background, { contents: window.webContents, url, context: () => ({ revision: background.status().revision }) });
  ipcMain.handle('background:control', (event, payload) => { if (closing) throw new Error('App closing'); return backgroundChannel().dispatch(event, payload); });
  const skillChannel = () => createSkillControlChannel(skills, { contents: window.webContents, url, context: () => ({ revision: skills.status().revision }) });
  ipcMain.handle('skills:control', (event, payload) => { if (closing) throw new Error('App closing'); return skillChannel().dispatch(event, payload); });
  const toolChannel = () => createToolControlChannel(tools, { contents: window.webContents, url, context: () => ({ revision: tools.status().revision }) });
  ipcMain.handle('tools:control', (event, payload) => { if (closing) throw new Error('App closing'); return toolChannel().dispatch(event, payload); });
  const privacyChannel = () => createPrivacyControlChannel({ status: () => privacy.status(), dispatch: action => {
    const operation = action.operation === 'chat' ? privacyCommand(action.text)?.operation : action.operation;
    if (['delete', 'apply'].includes(operation)) refreshRecovery(); return privacy.dispatch(action);
  } }, { contents: window.webContents, url, context: () => ({ revision: privacy.status().revision }) });
  ipcMain.handle('privacy:control', (event, payload) => {
    if (closing) throw new Error('App closing');
    return privacyChannel().dispatch(event, payload);
  });
  const suspendHost = () => { scheduler?.suspend(); void backgroundHost?.suspend().catch(() => {}); };
  const wakeHost = () => { if (!closing) void (async () => { await backgroundHost?.wake(); if (backgroundHost?.executionAllowed()) await scheduler?.wake(); })().catch(() => {}); };
  const endSession = event => { event.preventDefault(); void requestShutdown?.(); };
  powerMonitor.on('suspend', suspendHost); powerMonitor.on('resume', wakeHost); powerMonitor.on('shutdown', endSession);
  requestShutdown = async () => {
    if (closing || verifiedClose) return; closing = true; clearInterval(authorizationMonitor); clearInterval(retentionMonitor);
    try {
      if (!shutdownPaused) { scheduler?.suspend(); await backgroundHost?.suspend(); shutdownPaused = true; }
      // Keep recovery controls alive until worker termination has been verified.
      await development.close(); await issues.close(); await workspaces.close(); await manager.close(); await scheduler?.close();
      powerMonitor.removeListener('suspend', suspendHost); powerMonitor.removeListener('resume', wakeHost); powerMonitor.removeListener('shutdown', endSession);
      await tools.close(); await toolConnections?.close();
      await privacy.close(); privacyRecords?.close();
      backgroundHost?.close(); background.close(); scheduling.close(); pipelines.close(); skills.close();
      developmentStore?.close(); policy?.close(); skillStore?.close(); toolStore?.close(); workspaceStore?.close(); vault?.close(); verifiedClose = true; app.quit();
    } catch { closing = false; console.error('Pipeliner shutdown needs verified recovery. Work remains preserved.'); await attachWindow(); publish(manager.status()); }
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Pipeliner', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: async () => { const view = await attachWindow(); await view?.webContents.executeJavaScript("document.getElementById('settings-nav').click()"); } }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' } ] }, { role: 'windowMenu' }]));
  if (!backgroundLaunch) await attachWindow();
  try {
    const { openVault } = await moduleAt('../connections/vault.mjs');
    vault = await openVault(directory, { available: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: text => safeStorage.encryptStringAsync(text), decrypt: bytes => safeStorage.decryptStringAsync(bytes) });
    if (closing) { vault.close(); return; }
    const initialRevision = manager.status().revision + 1;
    manager = createConnectionManager({ vault, adapters, onChange: publish, initialRevision }); publish(manager.status());
    const { openWorkspaceStore } = await moduleAt('../repositories/store.mjs');
    workspaceStore = openWorkspaceStore(directory, { vault });
    skillStore = openSkillStore(directory, { occupiedNames: () => toolStore?.names() ?? [] });
    toolStore = openToolStore(directory, { occupiedNames: () => skillStore.names() });
    toolConnections = createToolConnections({ vault, entry: (endpoint, signal) => nativeMCPEntry(helper, directory, endpoint, signal, qualifying && process.argv.includes('--qualify-tools')),
      ...(qualifying && process.argv.includes('--qualify-tools') ? require('./qualify.cjs').toolConnectionOptions() : {}), onChange: () => { tools?.sync(); development?.sync(); } });
    policy = openPolicyStore(directory, { catalog: () => ({ repositories: workspaceStore.workspaces().map(workspace => workspace.id), capabilities: ['workspace.read', 'workspace.write', 'worker.exec', 'provider.turn', 'git.push', 'github.read', 'github.issue.write', 'github.pr.write', 'github.project.write', 'extension.install', 'extension.invoke'],
      maxConcurrency: 1, background: backgroundNative.inspect().qualified, connections: manager.status().connections.map(connection => ({ id: connection.id, provider: connection.id.startsWith('github') ? 'github' : connection.id,
        repositories: workspaceStore.workspaces().filter(workspace => !connection.id.startsWith('github') || connection.repositories.some(repo => repo.id === workspace.repositoryId)).map(workspace => workspace.id),
        healthy: ['connected', 'limited'].includes(connection.health) })), developers: manager.developers(), extensions: skillStore.catalog(), tools: toolStore.catalog() }),
      inspectors: { repository: input => development.observe(input), worker: binding => supervisor.inspectWorker(binding),
        continuity: input => development.inspectContinuity(input),
        effect: action => action.operation === 'github.pr.merge' ? development.inspectIntegration(action) : supervisor.inspectEffect(action) } });
    const { openDevelopmentStore } = await moduleAt('../development/state.mjs');
    const { openExecutionSupervisor } = await moduleAt('../core/execution.mjs');
    developmentStore = openDevelopmentStore(directory, { vault });
    try { supervisor = openExecutionSupervisor(directory, { store: policy }); } catch { supervisor = null; }
    const developmentRevision = development.status().revision + 1; await development.close(); development = makeDevelopment(developmentRevision); publishDevelopment(development.status());
    const pipelineRevision = pipelines.status().revision + 1; pipelines.close(); pipelines = makePipelines(pipelineRevision); publishPipelines(pipelines.status());
    issues = makeIssues(issues.status().revision + 1); publishIssues(issues.status());
    workspaces = makeWorkspaces(workspaces.status().revision + 1); publishWorkspaces(workspaces.status());
    const skillRevision = skills.status().revision + 1; skills.close(); skills = makeSkills(skillRevision); publishSkills(skills.status());
    const toolRevision = tools.status().revision + 1; await tools.close(); tools = makeTools(toolRevision); publishTools(tools.status());
    scheduler = createScheduler({ store: workspaceStore, policy, development,
      hostAuthority: () => !closing && (backgroundHost?.executionAllowed() ?? !backgroundLaunch),
      connections: { acquire: (...args) => manager.acquireRead(...args), epoch: id => manager.epoch(id) }, nextCalendar: (config, after, signal) => nextCalendar(calendarHelper, config, after, signal),
      onChange: () => scheduling?.sync(), ...(qualifying ? { api: require('./qualify.cjs').issueApi } : {}) });
    const schedulingRevision = scheduling.status().revision + 1; scheduling.close(); scheduling = makeScheduling(schedulingRevision); publishScheduling(scheduling.status());
    backgroundHost = createBackgroundHost({ policy, native: backgroundNative, pause: async () => { scheduler.suspend(); await development.pauseAll(); }, resumeChecks: () => scheduler.resume(), onChange: () => background?.sync() });
    backgroundHost.setVisible(Boolean(window && !window.isDestroyed()));
    const backgroundRevision = background.status().revision + 1; background.close(); background = makeBackground(backgroundRevision); publishBackground(background.status());
    privacyRecords = openPrivacyStore(directory, { vault, held: repository => repository !== null && recoveryHolds.has(repository), limits: repository => {
      const values = policy.worker.read(repository).values, host = policy.worker.read(null).values;
      return { conversationDays: values['privacy.conversationDays'].value, logDays: values['privacy.logDays'].value, auditDays: values['privacy.auditDays'].value,
        runLogBytes: values['privacy.runLogMiB'].value * 1024 ** 2, totalLogBytes: host['privacy.totalLogMiB'].value * 1024 ** 2 };
    } });
    refreshRecovery(); const privacyRevision = privacy.status().revision + 1; await privacy.close(); privacy = makePrivacy(privacyRevision); publishPrivacy(privacy.status());
    let retentionCursor = null;
    const retain = () => { if (closing) return; try { refreshRecovery(); const result = privacyRecords.expire({ after: retentionCursor, limit: 500 }); retentionCursor = result.more ? result.after : null; }
      catch { console.error('Pipeliner local retention needs protected recovery; records were preserved.'); } };
    retain(); retentionMonitor = setInterval(retain, 60000); retentionMonitor.unref();
    await backgroundHost.refresh();
    authorizationMonitor = setInterval(() => { if (!closing) void backgroundHost.refresh().catch(() => {}); }, 1000); authorizationMonitor.unref();
    await scheduler.check('startup');
  } catch { publish(manager.status()); }
  if (qualifying) await require('./qualify.cjs').run({ window, directory, helper, vault, manager, workspaces, issues, pipelines, policy, development, scheduler, scheduling, background, backgroundHost, backgroundNative, skills, skillStore, tools, toolStore, privacy, privacyRecords, privacyChannel: privacyChannel(), toolChannel: toolChannel(), skillChannel: skillChannel(), attachWindow, backgroundChannel: backgroundChannel(), schedulingChannel: schedulingChannel(), developmentChannel: developmentChannel(), workspaceChannel: workspaceChannel(), issueChannel: issueChannel(), pipelineChannel: pipelineChannel(), channel: channel(), windowReadyMs });
}).catch(() => { console.error('Pipeliner could not start safely.'); app.exit(1); });

async function githubPrompt({ connection, verificationUri, userCode, signal, cancel }) {
  if (verificationUri !== 'https://github.com/login/device') throw new Error('provider-unavailable');
  signal.throwIfAborted(); await shell.openExternal(verificationUri); signal.throwIfAborted();
  const completed = new AbortController();
  // Keep the code visible throughout polling. Completing or closing the flow dismisses only this sheet.
  const display = async () => {
    for (;;) {
      const result = await dialog.showMessageBox(window, { type: 'info', title: 'Connect GitHub', message: connection === 'github-setup' ? 'Connect setup and personal Projects' : 'Connect scoped GitHub access', detail: `Enter this code on GitHub: ${userCode}\n\n${connection === 'github-setup' ? 'GitHub will request the approved repo/project setup grant. This remains separate from scoped execution access.' : 'Only the registered App and its installed repositories can be used.'}\n\nWaiting for authorization…`, buttons: ['Open GitHub', 'Cancel'], defaultId: 0, cancelId: 1, signal: AbortSignal.any([signal, completed.signal]) });
      if (signal.aborted || completed.signal.aborted) return;
      if (result.response === 1) { cancel(); return; }
      await shell.openExternal(verificationUri);
    }
  };
  const waiting = display().catch(() => cancel());
  return { async close() { completed.abort(); await waiting; } };
}
app.on('second-instance', (_event, argv) => { if (!argv.includes('--background-helper')) void attachWindow?.(); });
app.on('activate', () => { if (!backgroundLaunch || window) void attachWindow?.(); });
app.on('window-all-closed', () => { if (!qualifying && !closing && !backgroundHost?.status().effective) void requestShutdown?.(); });
app.on('before-quit', event => { if (!verifiedClose && requestShutdown) { event.preventDefault(); void requestShutdown(); } });
process.on('SIGTERM', () => app.quit());
