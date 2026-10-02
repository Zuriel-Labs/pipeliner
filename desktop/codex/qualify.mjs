import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const CLI = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const EXPECTED_CLI_VERSION = 'codex-cli 0.158.0-alpha.2.1';
const PROVIDER_HOME = join(homedir(), '.codex', 'pipeliner-evidence', 'issue-19', 'provider-home');
const expectedKeys = ['epoch', 'issue', 'operation', 'repo', 'run'];

export function isolatedEnv(home) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), CODEX_HOME: home,
    TMPDIR: home, LANG: 'en_US.UTF-8',
  };
}

export function checkedCliVersion(expected = EXPECTED_CLI_VERSION) {
  const version = execFileSync(CLI, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.equal(version, expected);
  return version;
}

export function authorizeRequest(request, context) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(expectedKeys)) return false;
  return request.repo === context.repo && request.issue === context.issue &&
    request.run === context.run && request.epoch === context.epoch &&
    request.operation === 'write-marker';
}

export async function brokerWriteMarker(request, context) {
  if (!authorizeRequest(request, context)) return { allowed: false };
  await writeFile(context.markerPath, 'worker-ok\n', { flag: 'wx', mode: 0o600 });
  return { allowed: true };
}

export class AppServer {
  #child;
  #pending = new Map();
  #nextId = 1;
  notifications = [];
  events = [];
  unexpectedRequests = [];
  toolCalls = [];

  constructor(home, brokerContext) {
    this.brokerContext = brokerContext;
    const env = isolatedEnv(home);
    this.#child = spawn(CLI, ['app-server', '--listen', 'stdio://', '--strict-config'], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stderr.on('data', () => {}); // Never surface provider logs or credentials.
    this.#child.stdin.on('error', () => {});
    this.#child.on('exit', (code) => {
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`app-server exited ${code}`)); }
      this.#pending.clear();
    });
    this.#child.on('error', () => {
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('provider-unavailable')); }
      this.#pending.clear();
    });
    let bytes = 0;
    this.#child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) this.#child.kill('SIGTERM'); });
    const lines = createInterface({ input: this.#child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { this.#child.kill('SIGTERM'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.#child.kill('SIGTERM'); return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const detail = String(message.error.message ?? '').toLowerCase();
          const category = detail.includes('method not found') ? 'method-not-found'
            : detail.includes('not found') ? 'not-found'
              : detail.includes('not logged in') || detail.includes('authentication') ? 'auth-required'
                : detail.includes('no active turn to interrupt') ? 'no-active-turn'
                  : detail.includes('invalid') ? 'invalid-request' : 'other';
          pending.reject(new Error(`RPC ${pending.method} failed: ${message.error.code} (${category})`));
        }
        else pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        if (message.method === 'item/tool/call' && this.brokerContext) {
          const request = message.params?.tool === 'pipeliner_probe' &&
            message.params.threadId === this.brokerContext.threadId &&
            message.params.turnId === this.brokerContext.turnId ? message.params.arguments : null;
          const reply = (allowed) => {
            this.toolCalls.push({ allowed, requestedRepoMatches: request?.repo === this.brokerContext.repo });
            if (this.brokerContext.holdResponse && allowed) return;
            this.send({ id: message.id, result: {
              contentItems: [{ type: 'inputText', text: allowed ? 'allowed' : 'denied' }], success: allowed,
            } });
          };
          void brokerWriteMarker(request, this.brokerContext)
            .then(({ allowed }) => reply(allowed), () => reply(false));
        } else {
          this.unexpectedRequests.push(message.method);
          this.send({ id: message.id, error: { code: -32000, message: 'Denied by qualification client' } });
        }
      } else if (message.method) {
        if (this.events.length >= 4096) { this.#child.kill('SIGTERM'); return; }
        this.notifications.push(message.method);
        this.events.push({ method: message.method, params: message.params });
      }
    });
  }

  send(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 10000) {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null || this.#child.stdin.destroyed) return Promise.reject(new Error('provider-unavailable'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch { clearTimeout(timer); this.#pending.delete(id); reject(new Error('provider-unavailable')); }
    });
  }

  async waitForNotification(method, predicate, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const found = this.events.find((event) => event.method === method && predicate(event.params));
      if (found) return found.params;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${method} timed out`);
  }

  async close() {
    this.#child.stdin.end();
    this.#child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { this.#child.kill('SIGKILL'); }, 3000);
      this.#child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function probeUnauthenticated() {
  const report = { cli: checkedCliVersion(), transport: 'stdio JSONL', checks: [] };
  const home = await mkdtemp(join(tmpdir(), 'pipeliner-d03-'));
  let server;
  try {
    await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store = "ephemeral"\nforced_login_method = "chatgpt"\n', { mode: 0o600 });
    server = new AppServer(home);
    const init = await server.request('initialize', {
      clientInfo: { name: 'pipeliner_d03_probe', title: 'Pipeliner D-03 probe', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    assert.equal(init.codexHome, await realpath(home));
    report.checks.push('isolated-home-handshake');
    server.send({ method: 'initialized', params: {} });

    const before = await server.request('account/read', { refreshToken: false });
    assert.equal(before.account ?? null, null);
    report.checks.push('no-inherited-account');

    const models = await server.request('model/list', { limit: 20, includeHidden: false });
    report.modelCount = Array.isArray(models.data) ? models.data.length : 0;
    report.checks.push('model-discovery-response');

    const profiles = await server.request('permissionProfile/list', { cwd: home });
    report.permissionProfiles = profiles.data.map(({ id, allowed }) => ({ id, allowed }));
    report.checks.push('permission-profile-discovery');

    const model = models.data.find((entry) => entry.isDefault)?.model ?? models.data[0]?.model;
    assert.equal(typeof model, 'string');
    const thread = await server.request('thread/start', {
      model, cwd: home, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
      dynamicTools: [{
        type: 'function', name: 'pipeliner_probe',
        description: 'Request one synthetic broker operation.',
        inputSchema: {
          type: 'object', properties: {
            repo: { type: 'string' }, issue: { type: 'integer' }, run: { type: 'string' },
            epoch: { type: 'integer' }, operation: { type: 'string' },
          },
          required: expectedKeys, additionalProperties: false,
        },
      }],
    });
    assert.equal(typeof thread.thread?.id, 'string');
    report.checks.push('no-environment-dynamic-tool-thread-start');
    try {
      await server.request('thread/read', { threadId: thread.thread.id, includeTurns: true });
      report.checks.push('thread-read');
    } catch (error) { report.threadReadFailure = error.message; }
    try {
      await server.request('thread/resume', { threadId: thread.thread.id, environments: [] });
      report.checks.push('thread-resume');
    } catch (error) { report.threadResumeFailure = error.message; }

    const login = await server.request('account/login/start', { type: 'chatgptDeviceCode' }, 30000);
    assert.equal(login.type, 'chatgptDeviceCode');
    assert.equal(typeof login.loginId, 'string');
    report.checks.push('managed-device-login-start');
    await server.request('account/login/cancel', { loginId: login.loginId });
    report.checks.push('managed-login-cancel');

    const after = await server.request('account/read', { refreshToken: false });
    assert.equal(after.account ?? null, null);
    assert.equal(await exists(join(home, 'auth.json')), false);
    report.checks.push('cancel-leaves-no-account-or-file');
    report.unexpectedServerRequests = server.unexpectedRequests;
    report.passed = report.checks.length === 8 && server.unexpectedRequests.length === 0;
    return report;
  } finally {
    if (server) await server.close();
    await rm(home, { recursive: true, force: true });
    assert.equal(await exists(home), false);
  }
}

export function isAllowedAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['chatgpt.com', 'auth.openai.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export async function probeBrowserLogin() {
  const home = PROVIDER_HOME;
  const report = { cli: checkedCliVersion(), storage: 'keyring', checks: [] };
  assert.equal(await exists(home), false, 'task provider home already exists');
  await mkdir(home, { mode: 0o700 });
  let server;
  let loginId;
  let cleanupSafe = false;
  let connected = false;
  try {
    await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store = "keyring"\nforced_login_method = "chatgpt"\n', { mode: 0o600 });
    server = new AppServer(home);
    const init = await server.request('initialize', {
      clientInfo: { name: 'pipeliner_d03_probe', title: 'Pipeliner D-03 probe', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    assert.equal(init.codexHome, await realpath(home));
    server.send({ method: 'initialized', params: {} });
    const before = await server.request('account/read', { refreshToken: false });
    assert.equal(before.account ?? null, null);
    report.checks.push('fresh-isolated-home');

    const login = await server.request('account/login/start', {
      type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt',
    }, 30000);
    assert.equal(login.type, 'chatgpt');
    assert.equal(isAllowedAuthUrl(login.authUrl), true);
    loginId = login.loginId;
    report.checks.push('managed-browser-login-start');
    const browser = spawn('open', ['-a', 'Firefox', login.authUrl], { stdio: 'ignore' });
    const browserCode = await new Promise((resolve, reject) => {
      browser.once('exit', resolve);
      browser.once('error', reject);
    });
    assert.equal(browserCode, 0);
    report.checks.push('auth-url-opened-in-firefox');

    const completed = await server.waitForNotification('account/login/completed',
      (params) => params?.loginId === loginId, 120000);
    report.loginCompletion = {
      success: completed.success ?? null,
      errorCategory: /keyring|keychain|credentials could not be saved locally/i.test(String(completed.error))
        ? 'credential-persist-failed' : /timeout|timed out/i.test(String(completed.error))
          ? 'timeout' : /cancel/i.test(String(completed.error)) ? 'cancelled' : 'other',
    };
    if (completed.success !== true) {
      report.passed = false;
      return report;
    }
    const account = await server.request('account/read', { refreshToken: false });
    assert.equal(account.account?.type, 'chatgpt');
    assert.equal(await exists(join(home, 'auth.json')), false);
    report.checks.push('chatgpt-connected-no-auth-file');
    connected = true;
    try {
      const models = await server.request('model/list', { limit: 20, includeHidden: false });
      const model = models.data.find((entry) => entry.isDefault)?.model ?? models.data[0]?.model;
      const thread = await server.request('thread/start', {
        model, cwd: home, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
      });
      const started = await server.request('turn/start', {
        threadId: thread.thread.id, input: [{ type: 'text', text: 'Reply with exactly one word: ready.' }],
      }, 30000);
      await server.waitForNotification('turn/completed',
        (params) => params?.threadId === thread.thread.id && params?.turn?.id === started.turn?.id, 120000);
      report.checks.push('no-environment-turn-completed');
      report.eventMethods = [...new Set(server.notifications.filter((name) => name.startsWith('turn/') || name.startsWith('item/')))];
      try {
        await server.request('thread/read', { threadId: thread.thread.id, includeTurns: true });
        report.checks.push('authenticated-thread-read');
      } catch (error) { report.threadReadFailure = error.message; }
      try {
        await server.request('thread/resume', { threadId: thread.thread.id, environments: [] });
        report.checks.push('authenticated-thread-resume');
      } catch (error) { report.threadResumeFailure = error.message; }
    } catch (error) { report.turnFailure = error.message; }
    report.unexpectedServerRequests = server.unexpectedRequests;
    report.providerHomeRetained = true;
    report.passed = report.checks.length === 7 && server.unexpectedRequests.length === 0 &&
      !report.turnFailure && !report.threadReadFailure && !report.threadResumeFailure;
    return report;
  } finally {
    if (server) {
      if (loginId && !connected) {
        try { await server.request('account/login/cancel', { loginId }); } catch {}
      }
      if (!connected) {
        try {
          const account = await server.request('account/read', { refreshToken: false });
          if (account.account?.type === 'chatgpt') {
            await server.request('account/logout');
            report.checks.push('isolated-account-logout');
          }
          const finalAccount = await server.request('account/read', { refreshToken: false });
          cleanupSafe = (finalAccount.account ?? null) === null;
        } catch { report.cleanupError = 'isolated-account-cleanup-unverified'; }
      } else {
        cleanupSafe = true;
        report.providerHomeRetained = true;
      }
      await server.close();
    } else cleanupSafe = true;
    if (cleanupSafe && !connected) {
      await rm(home, { recursive: true, force: true });
      assert.equal(await exists(home), false);
    }
    if (!cleanupSafe) throw new Error('isolated-account-cleanup-unverified; task home retained for exact cleanup');
  }
}

export async function probeConnected() {
  const home = PROVIDER_HOME;
  const report = { cli: checkedCliVersion(), storage: 'keyring', checks: [] };
  assert.equal(await exists(home), true, 'isolated provider home is missing');
  const workspace = await mkdtemp(join(tmpdir(), 'pipeliner-d03-connected-'));
  const brokerContext = {
    repo: 'synthetic/repo', issue: 19, run: 'qualification', epoch: 1,
    markerPath: join(workspace, 'broker-marker'),
  };
  let server;
  try {
    server = new AppServer(home, brokerContext);
    const init = await server.request('initialize', {
      clientInfo: { name: 'pipeliner_d03_probe', title: 'Pipeliner D-03 probe', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    assert.equal(init.codexHome, await realpath(home));
    server.send({ method: 'initialized', params: {} });
    const account = await server.request('account/read', { refreshToken: false });
    assert.equal(account.account?.type, 'chatgpt');
    assert.equal(await exists(join(home, 'auth.json')), false);
    report.checks.push('keyring-session-reopened-without-auth-file');

    const models = await server.request('model/list', { limit: 20, includeHidden: false });
    const model = models.data.find((entry) => entry.isDefault)?.model ?? models.data[0]?.model;
    const toolSpec = {
      type: 'function', name: 'pipeliner_probe',
      description: 'Request one synthetic broker operation. No other filesystem access.',
      inputSchema: {
        type: 'object', properties: {
          repo: { type: 'string' }, issue: { type: 'integer' }, run: { type: 'string' },
          epoch: { type: 'integer' }, operation: { type: 'string' },
        },
        required: expectedKeys, additionalProperties: false,
      },
    };
    const thread = await server.request('thread/start', {
      model, cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
      dynamicTools: [toolSpec],
    });
    const id = thread.thread.id;
    brokerContext.threadId = id;
    const started = await server.request('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: 'Call pipeliner_probe once with {"repo":"synthetic/repo","issue":19,"run":"qualification","epoch":1,"operation":"write-marker"}. Then say done.' }],
    }, 30000);
    brokerContext.turnId = started.turn.id;
    await server.waitForNotification('turn/completed',
      (params) => params?.threadId === id && params?.turn?.id === started.turn?.id, 120000);
    if (server.toolCalls.length === 1 && server.toolCalls[0].allowed &&
        await exists(brokerContext.markerPath) &&
        await readFile(brokerContext.markerPath, 'utf8') === 'worker-ok\n') {
      report.checks.push('live-dynamic-tool-broker-write');
    }
    report.eventMethods = [...new Set(server.notifications.filter((name) =>
      name.startsWith('turn/') || name.startsWith('item/')))];

    const deniedTurn = await server.request('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: 'Call pipeliner_probe once with {"repo":"other/repo","issue":19,"run":"qualification","epoch":1,"operation":"write-marker"}. Report its result.' }],
    }, 30000);
    brokerContext.turnId = deniedTurn.turn.id;
    await server.waitForNotification('turn/completed',
      (params) => params?.threadId === id && params?.turn?.id === deniedTurn.turn?.id, 120000);
    if (server.toolCalls.length === 2 && !server.toolCalls[1].allowed &&
        !server.toolCalls[1].requestedRepoMatches && await exists(brokerContext.markerPath) &&
        await readFile(brokerContext.markerPath, 'utf8') === 'worker-ok\n') {
      report.checks.push('live-broker-wrong-repository-denied');
    }

    const nonce = randomUUID();
    const readPath = join(workspace, 'read-probe');
    await writeFile(readPath, nonce, { mode: 0o600 });
    const readThread = await server.request('thread/start', {
      model, cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
    });
    const readStarted = await server.request('turn/start', {
      threadId: readThread.thread.id,
      input: [{ type: 'text', text: `Use any available tool to read the file at ${readPath}. Report its exact contents. Do not guess.` }],
    }, 30000);
    await server.waitForNotification('turn/completed',
      (params) => params?.threadId === readThread.thread.id && params?.turn?.id === readStarted.turn?.id, 120000);
    const readEvents = server.events.filter(({ params }) =>
      params?.threadId === readThread.thread.id);
    const responseText = readEvents.filter(({ method }) => method === 'item/agentMessage/delta')
      .map(({ params }) => params?.delta ?? '').join('');
    report.builtinReadProbe = {
      nonceObserved: responseText.includes(nonce),
      responsePresent: responseText.length > 0,
      toolCalls: server.toolCalls.length,
      serverRequests: server.unexpectedRequests,
    };
    if (report.builtinReadProbe.responsePresent && !report.builtinReadProbe.nonceObserved &&
        server.unexpectedRequests.length === 0 && server.toolCalls.length === 2) {
      report.checks.push('no-environment-read-probe-did-not-access-file');
    }

    const interruptThread = await server.request('thread/start', {
      model, cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
      dynamicTools: [toolSpec],
    });
    brokerContext.threadId = interruptThread.thread.id;
    brokerContext.markerPath = join(workspace, 'interrupt-marker');
    brokerContext.holdResponse = true;
    const interruptTurn = await server.request('turn/start', {
      threadId: interruptThread.thread.id,
      input: [{ type: 'text', text: 'Call pipeliner_probe once with {"repo":"synthetic/repo","issue":19,"run":"qualification","epoch":1,"operation":"write-marker"}. Wait for its result.' }],
    }, 30000);
    brokerContext.turnId = interruptTurn.turn.id;
    try {
      const deadline = Date.now() + 60000;
      while (server.toolCalls.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(server.toolCalls.length, 3, 'interrupt tool call was not observed');
      await server.request('turn/interrupt', {
        threadId: interruptThread.thread.id, turnId: interruptTurn.turn.id,
      }, 30000);
      const completed = await server.waitForNotification('turn/completed',
        (params) => params?.threadId === interruptThread.thread.id &&
          params?.turn?.id === interruptTurn.turn.id, 60000);
      report.interruptStatus = completed.turn?.status ?? null;
      report.checks.push('turn-interrupt-accepted');
    } catch (error) { report.interruptFailure = error.message; }
    report.toolCalls = server.toolCalls;
    report.unexpectedServerRequests = server.unexpectedRequests;
    report.passed = report.checks.length === 5 && report.interruptStatus === 'interrupted' &&
      server.toolCalls.length === 3 && server.toolCalls[2].allowed &&
      server.unexpectedRequests.length === 0;
    return report;
  } finally {
    if (server) await server.close();
    await rm(workspace, { recursive: true, force: true });
    assert.equal(await exists(workspace), false);
  }
}

export async function probeLogout() {
  const home = PROVIDER_HOME;
  assert.equal(await exists(home), true, 'isolated provider home is missing');
  const report = { cli: checkedCliVersion(), checks: [] };
  let server;
  let safeToRemove = false;
  const connect = async () => {
    const instance = new AppServer(home);
    try {
      const init = await instance.request('initialize', {
        clientInfo: { name: 'pipeliner_d03_probe', title: 'Pipeliner D-03 probe', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      assert.equal(init.codexHome, await realpath(home));
      instance.send({ method: 'initialized', params: {} });
      return instance;
    } catch (error) {
      await instance.close();
      throw error;
    }
  };
  try {
    server = await connect();
    const before = await server.request('account/read', { refreshToken: true }, 30000);
    assert.equal(before.account?.type, 'chatgpt');
    report.checks.push('refresh-read-connected');
    await server.request('account/logout');
    const after = await server.request('account/read', { refreshToken: false });
    assert.equal(after.account ?? null, null);
    report.checks.push('logout-clears-live-account');
    await server.close();
    server = null;
    server = await connect();
    const reopened = await server.request('account/read', { refreshToken: false });
    assert.equal(reopened.account ?? null, null);
    assert.equal(await exists(join(home, 'auth.json')), false);
    report.checks.push('logout-persists-after-restart-no-auth-file');
    safeToRemove = true;
    return report;
  } finally {
    if (server) await server.close();
    if (safeToRemove) {
      await rm(home, { recursive: true, force: true });
      assert.equal(await exists(home), false);
      report.checks.push('task-provider-home-removed');
      report.passed = report.checks.length === 4;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = process.argv.includes('--browser-login')
      ? await probeBrowserLogin() : process.argv.includes('--connected')
        ? await probeConnected() : process.argv.includes('--logout')
          ? await probeLogout() : await probeUnauthenticated();
    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex !== -1) {
      const output = process.argv[outputIndex + 1];
      if (!output) throw new Error('--output requires a path');
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
