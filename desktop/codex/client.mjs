import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { packagedCodexPath } from './executable.mjs';

export const CLI = packagedCodexPath();
const expectedKeys = ['epoch', 'issue', 'operation', 'repo', 'run'];

export function isolatedEnv(home) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), CODEX_HOME: home,
    TMPDIR: home, LANG: 'en_US.UTF-8',
  };
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

export function isAllowedAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['chatgpt.com', 'auth.openai.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}
