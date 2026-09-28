import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const CLI = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const EXPECTED_CLI_VERSION = 'codex-cli 0.158.0-alpha.2.1';
const expectedKeys = ['epoch', 'issue', 'operation', 'repo', 'run'];

export function isolatedEnv(home) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CODEX_HOME: home,
    TMPDIR: home, LANG: 'en_US.UTF-8',
  };
}

function checkedCliVersion() {
  const version = execFileSync(CLI, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.equal(version, EXPECTED_CLI_VERSION);
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

class AppServer {
  #child;
  #pending = new Map();
  #nextId = 1;
  notifications = [];
  events = [];
  unexpectedRequests = [];

  constructor(home) {
    const env = isolatedEnv(home);
    this.#child = spawn(CLI, ['app-server', '--listen', 'stdio://', '--strict-config'], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stderr.on('data', () => {}); // Never surface provider logs or credentials.
    this.#child.on('exit', (code) => {
      for (const pending of this.#pending.values()) pending.reject(new Error(`app-server exited ${code}`));
      this.#pending.clear();
    });
    const lines = createInterface({ input: this.#child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
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
                : detail.includes('invalid') ? 'invalid-request' : 'other';
          pending.reject(new Error(`RPC ${pending.method} failed: ${message.error.code} (${category})`));
        }
        else pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        this.unexpectedRequests.push(message.method);
        this.send({ id: message.id, error: { code: -32000, message: 'Denied by qualification client' } });
      } else if (message.method) {
        this.notifications.push(message.method);
        this.events.push({ method: message.method, params: message.params });
      }
    });
  }

  send(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 10000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params });
    });
  }

  async waitForNotification(method, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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
      const timer = setTimeout(() => { this.#child.kill('SIGKILL'); resolve(); }, 3000);
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
  const home = await mkdtemp(join(tmpdir(), 'pipeliner-d03-'));
  const report = { cli: checkedCliVersion(), transport: 'stdio JSONL', checks: [] };
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
    return url.protocol === 'https:' && ['chatgpt.com', 'auth.openai.com'].includes(url.hostname);
  } catch { return false; }
}

export async function probeBrowserLogin() {
  const home = await mkdtemp(join(tmpdir(), 'pipeliner-d03-login-'));
  const report = { cli: checkedCliVersion(), storage: 'keyring', checks: [] };
  let server;
  let loginId;
  let cleanupSafe = false;
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
    assert.equal(completed.success, true);
    const account = await server.request('account/read', { refreshToken: false });
    assert.equal(account.account?.type, 'chatgpt');
    assert.equal(await exists(join(home, 'auth.json')), false);
    report.checks.push('chatgpt-connected-no-auth-file');
    report.unexpectedServerRequests = server.unexpectedRequests;
    return report;
  } finally {
    if (server) {
      if (loginId) {
        try { await server.request('account/login/cancel', { loginId }); } catch {}
      }
      try {
        const account = await server.request('account/read', { refreshToken: false });
        if (account.account?.type === 'chatgpt') {
          await server.request('account/logout');
          report.checks.push('isolated-account-logout');
        }
        const finalAccount = await server.request('account/read', { refreshToken: false });
        cleanupSafe = (finalAccount.account ?? null) === null;
      } catch { report.cleanupError = 'isolated-account-cleanup-unverified'; }
      await server.close();
    } else cleanupSafe = true;
    if (cleanupSafe) {
      await rm(home, { recursive: true, force: true });
      assert.equal(await exists(home), false);
    }
    if (!cleanupSafe) throw new Error('isolated-account-cleanup-unverified; task home retained for exact cleanup');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = process.argv.includes('--browser-login')
      ? await probeBrowserLogin() : await probeUnauthenticated();
    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex !== -1) {
      const output = process.argv[outputIndex + 1];
      if (!output) throw new Error('--output requires a path');
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
