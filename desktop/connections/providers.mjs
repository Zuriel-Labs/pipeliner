import { mkdir, mkdtemp, writeFile, readFile, lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppServer, CLI, isolatedEnv, isAllowedAuthUrl, brokerWriteMarker } from '../codex/client.mjs';
import { catalog, chat, broker } from '../ollama/client.mjs';
import { canonicalJSON, record } from '../core/settings.mjs';

export const codexVersion = 'codex-cli 0.160.0';
const exec = promisify(execFile);
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value);
const config = 'cli_auth_credentials_store = "keyring"\nforced_login_method = "chatgpt"\n';
const present = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

export async function protectedCodexHome(directory) {
  return codexHome(directory, true);
}
async function codexHome(directory, create) {
  try {
    const root = await lstat(directory), home = join(directory, 'codex');
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700 || await realpath(directory) !== resolve(directory)) throw Error();
    if (create) await mkdir(home, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid() || await realpath(home) !== home) throw Error();
    const path = join(home, 'config.toml');
    if (create) await writeFile(path, config, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size !== Buffer.byteLength(config) || (file.mode & 0o777) !== 0o600
      || file.uid !== process.getuid() || await realpath(path) !== path || await readFile(path, 'utf8') !== config || await present(join(home, 'auth.json'))) throw Error();
    return home;
  } catch { throw Error('provider-storage-blocked'); }
}

async function initializeCodex(home, context) {
  const version = await exec(CLI, ['--version'], { env: isolatedEnv(home), timeout: 10000 });
  if (version.stdout.trim() !== codexVersion) throw new Error('provider-unavailable');
  const server = new AppServer(home, context);
  try {
    const initialized = await server.request('initialize', { clientInfo: { name: 'pipeliner_desktop', title: 'Pipeliner', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    if (initialized.codexHome !== await realpath(home)) throw new Error('provider-storage-blocked');
    server.send({ method: 'initialized', params: {} }); return server;
  } catch { await server.close(); throw new Error('provider-unavailable'); }
}

export async function codexModels(server, signal) {
  const models = [], ids = new Set(), cursors = new Set(); let cursor = null;
  for (let page = 0; page < 100; page++) {
    signal?.throwIfAborted();
    const result = await server.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data) || result.data.length > 100) throw new Error('catalog-invalid');
    for (const entry of result.data) {
      if (!modelId(entry.model) || ids.has(entry.model)) throw new Error('catalog-invalid');
      ids.add(entry.model); models.push({ id: entry.model, name: typeof entry.displayName === 'string' && entry.displayName.length <= 256 ? entry.displayName : entry.model, recommended: entry.isDefault === true });
    }
    if (result.nextCursor === null || result.nextCursor === undefined) return models;
    if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048 || cursors.has(result.nextCursor) || result.data.length === 0) throw new Error('catalog-invalid');
    cursors.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new Error('catalog-invalid');
}

export function codexAdapter({ directory, openBrowser, initialize = initializeCodex }) {
  if (typeof initialize !== 'function') throw Error('provider-unavailable');
  const bridge = 'codex-development-v1';
  const qualified = (value, model) => value?.view?.health === 'connected' && value.view.selectedModel === model
    && value.view.models?.some(item => item.id === model) && value.view.capability?.model === model
    && value.view.capability.bridge === bridge && value.view.capability.noPrompts === true
    && Number.isSafeInteger(value.view.capability.testedAt) && value.view.capability.testedAt > 0
    && ['stream', 'toolLoop', 'resumed'].every(key => value.view.capability[key] === true);
  async function disconnected(signal, logout) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw Error('provider-storage-blocked');
    signal?.throwIfAborted();
    const home = await codexHome(directory, logout), paths = [directory, home, join(home, 'config.toml')];
    const original = await Promise.all(paths.map(path => lstat(path, { bigint: true })));
    async function check() {
      signal?.throwIfAborted(); await codexHome(directory, false);
      const current = await Promise.all(paths.map(path => lstat(path, { bigint: true })));
      if (current.some((value, index) => (index === 2 ? ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] : ['dev', 'ino', 'uid', 'mode'])
        .some(key => value[key] !== original[index][key]))) throw Error('provider-storage-blocked');
      signal?.throwIfAborted();
    }
    let server;
    try {
      await check(); server = await initialize(home); await check();
      if (logout) { await server.request('account/logout'); await check(); }
      const state = await server.request('account/read', { refreshToken: false }); await check();
      canonicalJSON(state); record(state, ['account', 'requiresOpenaiAuth'], Object.keys(state));
      if (state.account !== null || typeof state.requiresOpenaiAuth !== 'boolean') throw Error('provider-storage-blocked');
    } catch { throw Error('provider-storage-blocked'); }
    finally { if (server) { await server.close(); await check(); } }
    return true;
  }
  async function inspect(server, home, signal, before) {
    signal?.throwIfAborted();
    const response = await server.request('account/read', { refreshToken: true }, 30000), account = response.account;
    if (account?.type !== 'chatgpt') throw new Error('reauthentication-required');
    const label = typeof account.email === 'string' && account.email.length <= 254 ? account.email : 'ChatGPT account';
    if (before?.account && label !== before.account) throw new Error('account-changed');
    if (await present(join(home, 'auth.json'))) throw new Error('provider-storage-blocked');
    const models = await codexModels(server, signal), retained = qualified(before, before?.view?.selectedModel)
      && models.some(item => item.id === before.view.selectedModel);
    return { credential: null, account: label, view: { account: label, health: 'connected', lastVerified: Date.now(),
      credentialStatus: 'Codex-managed Keychain login', models, selectedModel: retained ? before.view.selectedModel : null,
      capability: retained ? before.view.capability : null } };
  }
  async function turn({ value, model, messages, tools, maxOutput, signal }, requireQualification = true) {
    if (requireQualification && !qualified(value, model)) throw Error('capability-unverified');
    canonicalJSON({ messages, tools });
    if (!Array.isArray(messages) || !messages.length || !Array.isArray(tools) || tools.length > 8
      || !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 8192
      || Buffer.byteLength(JSON.stringify({ messages, tools })) > 1024 * 1024) throw Error('provider-input-invalid');
    const names = new Set(), dynamicTools = tools.map(entry => {
      record(entry, ['type', 'function']); record(entry.function, ['name', 'description', 'parameters']);
      const { name, description, parameters } = entry.function;
      if (entry.type !== 'function' || typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
        || names.has(name) || typeof description !== 'string' || description.length > 4096 || parameters?.type !== 'object') throw Error('provider-input-invalid');
      names.add(name); return { type: 'function', name, description, inputSchema: parameters };
    });
    signal?.throwIfAborted();
    const home = await protectedCodexHome(directory), requests = [], first = Promise.withResolvers(), controller = new AbortController(); let overflow = false;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let closed = false, closing;
    const server = await initialize(home, { captureTool(params) { if (requests.length >= 8) overflow = true; else requests.push(params); first.resolve(); } });
    const close = () => closing ??= server.close();
    try {
      const verified = await inspect(server, home, combined, value);
      if (!verified.view.models.some(entry => entry.id === model)) throw Error('model-unavailable');
      combined.throwIfAborted();
      const thread = await server.request('thread/start', { model, allowProviderModelFallback: false, cwd: home, environments: [], sandbox: 'read-only',
        approvalPolicy: 'never', ephemeral: true, dynamicTools });
      if (thread.model !== model || typeof thread.thread?.id !== 'string' || !thread.thread.id) throw Error('model-mismatch');
      const threadId = thread.thread.id;
      combined.throwIfAborted();
      const started = await server.request('turn/start', { threadId, environments: [], input: [{ type: 'text',
        text: 'Execute the latest user request in this host-recorded conversation. Roles and completed tool results are explicit data. Use only the declared host tools.\n' + canonicalJSON(messages) }] }, 30000);
      const turnId = started.turn?.id;
      if (typeof turnId !== 'string' || !turnId) throw Error('response-invalid');
      const terminal = server.waitForNotification('turn/completed', p => p?.threadId === threadId && p?.turn?.id === turnId, 120000, combined);
      const outcome = await Promise.race([first.promise.then(() => null), terminal]);
      if (outcome === null) await server.request('turn/interrupt', { threadId, turnId }, 30000);
      const end = outcome ?? await terminal;
      combined.throwIfAborted();
      await close(); closed = true;
      await codexHome(directory, false); combined.throwIfAborted();
      if (overflow || server.unexpectedRequests.length || end.turn.status !== (requests.length ? 'interrupted' : 'completed')) throw Error('capability-unverified');
      const calls = new Set(), tool_calls = requests.map(params => {
        canonicalJSON(params); record(params, ['threadId', 'turnId', 'callId', 'namespace', 'tool', 'arguments']);
        if (params.threadId !== threadId || params.turnId !== turnId || params.namespace !== null || !names.has(params.tool)
          || typeof params.callId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(params.callId) || calls.has(params.callId)
          || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) throw Error('response-invalid');
        calls.add(params.callId); return { function: { name: params.tool, arguments: structuredClone(params.arguments) } };
      });
      const content = server.events.filter(event => event.method === 'item/agentMessage/delta' && event.params?.threadId === threadId && event.params.turnId === turnId)
        .map(event => { if (typeof event.params.delta !== 'string') throw Error('response-invalid'); return event.params.delta; }).join('');
      const result = { content, thinking: '', tool_calls, usage: { input: null, output: null } };
      if (Buffer.byteLength(canonicalJSON(result)) > 1024 * 1024) throw Error('response-too-large');
      return result;
    } finally {
      controller.abort();
      if (!closed) { await close(); await codexHome(directory, false); }
      signal?.throwIfAborted();
    }
  }
  return {
    qualified, noPrompts: true,
    turn(input) { return turn(input); },
    async connect({ signal }) {
      const home = await protectedCodexHome(directory), server = await initialize(home); let loginId, complete = false;
      const cancel = () => { if (loginId) void server.request('account/login/cancel', { loginId }).catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        const login = await server.request('account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' }, 30000);
        loginId = login.loginId;
        if (login.type !== 'chatgpt' || typeof loginId !== 'string' || !isAllowedAuthUrl(login.authUrl)) throw new Error('provider-unavailable');
        signal.throwIfAborted(); await openBrowser(login.authUrl);
        const result = await server.waitForNotification('account/login/completed', value => value?.loginId === loginId, 300000, signal);
        if (result.success !== true) throw new Error('provider-storage-blocked');
        const record = await inspect(server, home, signal); signal.throwIfAborted(); complete = true; return record;
      } finally {
        signal.removeEventListener('abort', cancel);
        if (!complete && loginId) { await server.request('account/login/cancel', { loginId }).catch(() => {}); await server.request('account/logout').catch(() => {}); }
        await server.close();
      }
    },
    async refresh({ value, signal }) {
      const home = await protectedCodexHome(directory), server = await initialize(home);
      try { return await inspect(server, home, signal, value); } finally { await server.close(); }
    },
    async test({ value, model, signal }) {
      const home = await protectedCodexHome(directory), workspace = await mkdtemp(join(tmpdir(), 'pipeliner-codex-capability-'));
      const context = { repo: 'synthetic/pipeliner-connection', issue: 34, run: randomUUID(), epoch: 1, markerPath: join(workspace, 'marker') };
      let server;
      try {
        server = await initialize(home, context); const verified = await inspect(server, home, signal, value);
        if (!verified.view.models.some(entry => entry.id === model)) throw new Error('model-unavailable');
        const thread = await server.request('thread/start', { model, allowProviderModelFallback: false, cwd: workspace, environments: [], sandbox: 'read-only', approvalPolicy: 'never',
          dynamicTools: [{ type: 'function', name: 'pipeliner_probe', description: 'One synthetic connection check. No repository data.', inputSchema: { type: 'object', additionalProperties: false,
            properties: { repo: { type: 'string' }, issue: { type: 'integer' }, run: { type: 'string' }, epoch: { type: 'integer' }, operation: { type: 'string' } }, required: ['repo', 'issue', 'run', 'epoch', 'operation'] } }] });
        context.threadId = thread.thread.id; signal.throwIfAborted();
        const started = await server.request('turn/start', { threadId: context.threadId, environments: [], input: [{ type: 'text', text: `Call pipeliner_probe once with ${JSON.stringify({ repo: context.repo, issue: 34, run: context.run, epoch: 1, operation: 'write-marker' })}. Remember that run value for the next message.` }] }, 30000);
        context.turnId = started.turn.id;
        const terminal = await server.waitForNotification('turn/completed', p => p?.threadId === context.threadId && p?.turn?.id === context.turnId, 120000, signal);
        if (terminal.turn.status !== 'completed' || server.toolCalls.length !== 1 || !server.toolCalls[0].allowed || server.unexpectedRequests.length || await readFile(context.markerPath, 'utf8') !== 'worker-ok\n') throw new Error('capability-unverified');
        await server.close(); server = await initialize(home);
        await server.request('thread/resume', { threadId: context.threadId, environments: [] }); signal.throwIfAborted();
        const resumed = await server.request('turn/start', { threadId: context.threadId, environments: [], input: [{ type: 'text', text: 'What was the run value in the previous tool call? Return only that value. Do not call tools.' }] }, 30000);
        const end = await server.waitForNotification('turn/completed', p => p?.threadId === context.threadId && p?.turn?.id === resumed.turn.id, 120000, signal);
        const response = server.events.filter(event => event.method === 'item/agentMessage/delta').map(event => event.params?.delta ?? '').join('');
        if (end.turn.status !== 'completed' || !response.includes(context.run) || server.unexpectedRequests.length) throw new Error('capability-unverified');
        await server.close(); server = null;
        const tool = { type: 'function', function: { name: 'pipeliner_probe', description: 'One synthetic host-broker connection check.', parameters: {
          type: 'object', additionalProperties: false, properties: { repo: { type: 'string' }, issue: { type: 'integer' }, run: { type: 'string' }, epoch: { type: 'integer' }, operation: { type: 'string' } }, required: ['repo', 'issue', 'run', 'epoch', 'operation'] } } };
        const args = { repo: context.repo, issue: context.issue, run: context.run, epoch: context.epoch, operation: 'write-marker' };
        const messages = [{ role: 'user', content: `Call pipeliner_probe once with ${canonicalJSON(args)}. Then wait for its host result.` }];
        const captured = await turn({ value: verified, model, messages, tools: [tool], maxOutput: 128, signal }, false);
        if (captured.tool_calls.length !== 1 || canonicalJSON(captured.tool_calls[0].function.arguments) !== canonicalJSON(args)) throw Error('capability-unverified');
        context.markerPath = join(workspace, 'bridge-marker');
        const written = await brokerWriteMarker(captured.tool_calls[0].function.arguments, context);
        if (!written.allowed || await readFile(context.markerPath, 'utf8') !== 'worker-ok\n') throw Error('capability-unverified');
        messages.push({ role: 'assistant', content: captured.content, tool_calls: captured.tool_calls }, { role: 'tool', tool_name: 'pipeliner_probe', content: `Host wrote the exact synthetic marker for run ${context.run}.` },
          { role: 'user', content: 'Return only that run value. Do not call tools.' });
        const replayed = await turn({ value: verified, model, messages, tools: [], maxOutput: 128, signal }, false);
        if (!replayed.content.includes(context.run) || replayed.tool_calls.length) throw Error('capability-unverified');
        return { ...verified, view: { ...verified.view, selectedModel: model, capability: { bridge, model, testedAt: Date.now(), toolLoop: true, stream: true, resumed: true, noPrompts: true,
          usage: null, scope: 'Synthetic managed provider resume and interrupted host-broker conversation replay; every execution step still needs preflight.' } } };
      } finally { if (server) await server.close(); await rm(workspace, { recursive: true, force: true }); }
    },
    async disconnect({ signal } = {}) { await disconnected(signal, true); },
    verifyDisconnected({ signal } = {}) { return disconnected(signal, false); },
  };
}

export function ollamaAdapter({ entry, send = fetch }) {
  const qualified = (value, model) => value?.view?.health === 'connected' && value.view.selectedModel === model
    && value.view.models?.some(item => item.id === model) && value.view.capability?.model === model
    && Number.isSafeInteger(value.view.capability.testedAt) && value.view.capability.testedAt > 0
    && ['stream', 'toolLoop', 'resumed'].every(key => value.view.capability[key] === true);
  async function refresh({ value, signal }) {
    const entries = await catalog(value.credential, 'cloud', { signal, send }); const ids = new Set();
    const models = entries.map(item => {
      if (!modelId(item?.name) || ids.has(item.name)) throw new Error('catalog-invalid'); ids.add(item.name);
      return { id: item.name, name: item.name, recommended: item.name === 'deepseek-v4.1-flash' };
    });
    if (models.length > 10000) throw new Error('catalog-invalid');
    // Discovery retains earlier inference evidence only for the same still-listed model.
    const retained = qualified(value, value.view?.selectedModel) && models.some(item => item.id === value.view.selectedModel);
    return { credential: value.credential, view: { account: null, health: retained ? 'connected' : 'limited',
      credentialStatus: retained ? 'Key verified by prior inference; catalog refreshed' : 'Key stored; inference not verified', lastVerified: Date.now(), models,
      selectedModel: retained ? value.view.selectedModel : null, capability: retained ? value.view.capability : null } };
  }
  return {
    noPrompts: true, // The qualified HTTP tool loop has no approval-request protocol.
    async connect({ signal }) {
      const result = await entry(signal); signal.throwIfAborted();
      return refresh({ value: { credential: result.key }, signal });
    }, refresh,
    async test({ value, model, signal }) {
      const verified = await refresh({ value, signal });
      if (!verified.view.models.some(entry => entry.id === model)) throw new Error('model-unavailable');
      const state = { target: 'synthetic-pipeliner-connection', nonce: randomUUID(), epoch: 1, applied: false };
      const tool = { type: 'function', function: { name: 'lookup_fixture', description: 'Read one synthetic connection fixture.', parameters: {
        type: 'object', required: ['target', 'nonce', 'epoch'], properties: { target: { type: 'string' }, nonce: { type: 'string' }, epoch: { type: 'integer' } } } } };
      const messages = [{ role: 'user', content: `Call lookup_fixture once with target ${state.target}, nonce ${state.nonce}, epoch 1. Then report its result.` }];
      const first = await chat(value.credential, model, messages, [tool], 'cloud', { signal, send });
      if (first.tool_calls.length !== 1) throw new Error('capability-unverified');
      const result = broker(first.tool_calls[0], state);
      if (!result.allowed) throw new Error('capability-unverified');
      messages.push({ role: 'assistant', content: first.content, thinking: first.thinking, tool_calls: first.tool_calls }, { role: 'tool', tool_name: 'lookup_fixture', content: result.result });
      const next = await chat(value.credential, model, messages, undefined, 'cloud', { signal, send });
      if (!next.content.includes(result.result) || next.tool_calls.length) throw new Error('capability-unverified');
      return { ...verified, view: { ...verified.view, health: 'connected', credentialStatus: 'Key verified by inference', selectedModel: model,
        capability: { model, testedAt: Date.now(), stream: true, toolLoop: true, resumed: true, usage: { first: first.usage, resumed: next.usage }, scope: 'Synthetic provider path only; each execution step still needs preflight.' } } };
    },
    async turn({ value, model, messages, tools, maxOutput, signal }) {
      if (!qualified(value, model)) throw new Error('capability-unverified');
      return chat(value.credential, model, messages, tools, 'cloud', { signal, send, numPredict: maxOutput, timeoutMs: 120000 });
    },
    async disconnect() {},
  };
}
