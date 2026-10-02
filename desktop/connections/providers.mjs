import { mkdir, writeFile, readFile, lstat, realpath, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppServer, CLI, isolatedEnv, isAllowedAuthUrl } from '../codex/qualify.mjs';
import { catalog, chat, broker } from '../ollama/qualify.mjs';

export const codexVersion = 'codex-cli 0.159.2';
const exec = promisify(execFile);
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value);
const config = 'cli_auth_credentials_store = "keyring"\nforced_login_method = "chatgpt"\n';
const present = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

export async function protectedCodexHome(directory) {
  const home = join(directory, 'codex');
  await mkdir(home, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid() || await realpath(home) !== resolve(home)) throw new Error('provider-storage-blocked');
  const path = join(home, 'config.toml');
  await writeFile(path, config, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.uid !== process.getuid() || await readFile(path, 'utf8') !== config || await present(join(home, 'auth.json'))) throw new Error('provider-storage-blocked');
  return home;
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

export function codexAdapter({ directory, openBrowser }) {
  async function inspect(server, home, signal, before) {
    signal?.throwIfAborted();
    const response = await server.request('account/read', { refreshToken: true }, 30000), account = response.account;
    if (account?.type !== 'chatgpt') throw new Error('reauthentication-required');
    const label = typeof account.email === 'string' && account.email.length <= 254 ? account.email : 'ChatGPT account';
    if (before?.account && label !== before.account) throw new Error('account-changed');
    if (await present(join(home, 'auth.json'))) throw new Error('provider-storage-blocked');
    return { credential: null, account: label, view: { account: label, health: 'connected', lastVerified: Date.now(),
      credentialStatus: 'Codex-managed Keychain login', models: await codexModels(server, signal), capability: null } };
  }
  return {
    async connect({ signal }) {
      const home = await protectedCodexHome(directory), server = await initializeCodex(home); let loginId, complete = false;
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
      const home = await protectedCodexHome(directory), server = await initializeCodex(home);
      try { return await inspect(server, home, signal, value); } finally { await server.close(); }
    },
    async test({ value, model, signal }) {
      const home = await protectedCodexHome(directory), workspace = join(home, `capability-${randomUUID()}`);
      await mkdir(workspace, { mode: 0o700 });
      const context = { repo: 'synthetic/pipeliner-connection', issue: 34, run: randomUUID(), epoch: 1, markerPath: join(workspace, 'marker') };
      let server;
      try {
        server = await initializeCodex(home, context); const verified = await inspect(server, home, signal, value);
        if (!verified.view.models.some(entry => entry.id === model)) throw new Error('model-unavailable');
        const thread = await server.request('thread/start', { model, allowProviderModelFallback: false, cwd: workspace, environments: [], sandbox: 'read-only', approvalPolicy: 'never',
          dynamicTools: [{ type: 'function', name: 'pipeliner_probe', description: 'One synthetic connection check. No repository data.', inputSchema: { type: 'object', additionalProperties: false,
            properties: { repo: { type: 'string' }, issue: { type: 'integer' }, run: { type: 'string' }, epoch: { type: 'integer' }, operation: { type: 'string' } }, required: ['repo', 'issue', 'run', 'epoch', 'operation'] } }] });
        context.threadId = thread.thread.id; signal.throwIfAborted();
        const started = await server.request('turn/start', { threadId: context.threadId, environments: [], input: [{ type: 'text', text: `Call pipeliner_probe once with ${JSON.stringify({ repo: context.repo, issue: 34, run: context.run, epoch: 1, operation: 'write-marker' })}. Remember that run value for the next message.` }] }, 30000);
        context.turnId = started.turn.id;
        const terminal = await server.waitForNotification('turn/completed', p => p?.threadId === context.threadId && p?.turn?.id === context.turnId, 120000, signal);
        if (terminal.turn.status !== 'completed' || server.toolCalls.length !== 1 || !server.toolCalls[0].allowed || server.unexpectedRequests.length || await readFile(context.markerPath, 'utf8') !== 'worker-ok\n') throw new Error('capability-unverified');
        await server.close(); server = await initializeCodex(home);
        await server.request('thread/resume', { threadId: context.threadId, environments: [] }); signal.throwIfAborted();
        const resumed = await server.request('turn/start', { threadId: context.threadId, environments: [], input: [{ type: 'text', text: 'What was the run value in the previous tool call? Return only that value. Do not call tools.' }] }, 30000);
        const end = await server.waitForNotification('turn/completed', p => p?.threadId === context.threadId && p?.turn?.id === resumed.turn.id, 120000, signal);
        const response = server.events.filter(event => event.method === 'item/agentMessage/delta').map(event => event.params?.delta ?? '').join('');
        if (end.turn.status !== 'completed' || !response.includes(context.run) || server.unexpectedRequests.length) throw new Error('capability-unverified');
        return { ...verified, view: { ...verified.view, selectedModel: model, capability: { model, testedAt: Date.now(), toolLoop: true, stream: true, resumed: true, usage: null, scope: 'Synthetic provider path only; each execution step still needs preflight.' } } };
      } finally { if (server) await server.close(); await rm(workspace, { recursive: true, force: true }); }
    },
    async disconnect() {
      const home = await protectedCodexHome(directory), server = await initializeCodex(home);
      try { await server.request('account/logout'); const state = await server.request('account/read', { refreshToken: false });
        if (state.account || await present(join(home, 'auth.json'))) throw new Error('provider-storage-blocked'); }
      finally { await server.close(); }
    },
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
