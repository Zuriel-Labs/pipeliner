import { setTimeout as sleep } from 'node:timers/promises';

const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const VERIFY_URL = 'https://github.com/login/device';
const LIMIT = 65536;
const client = value => typeof value === 'string' && /^[A-Za-z0-9.]{10,80}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

async function json(url, fields, { send = fetch, signal, timeoutMs = 30000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let reader;
  try {
    combined.throwIfAborted();
    const response = await send(url, { method: fields ? 'POST' : 'GET', redirect: 'error', signal: combined,
      headers: { Accept: 'application/json', 'User-Agent': 'Pipeliner-Desktop-Qualification',
        ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'X-GitHub-Api-Version': '2026-03-10' }) },
      body: fields ? new URLSearchParams(fields).toString() : undefined });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`http-${response.status}`);
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('invalid-json-response');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', bytes = 0;
    while (true) {
      const part = await reader.read();
      combined.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > LIMIT) throw new Error('response-too-large');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('invalid-json-response'); }
    combined.throwIfAborted();
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid-json-response');
    return result;
  } catch (error) {
    await reader?.cancel().catch(() => {});
    if (signal?.aborted) throw new Error('cancelled');
    if (deadline.aborted) throw new Error('timeout');
    if (/^(http-\d+|invalid-json-response|response-too-large)$/.test(error.message)) throw error;
    throw new Error('transport-failed');
  } finally { reader?.releaseLock(); }
}

function tokenResult(value, now) {
  if (value.error) throw new Error(value.error === 'bad_refresh_token' ? 'reauthentication-required' : 'token-request-denied');
  if (typeof value.access_token !== 'string' || !/^ghu_[A-Za-z0-9_]{8,200}$/.test(value.access_token) ||
    value.token_type !== 'bearer' || value.scope !== '' ||
    (value.expires_in !== undefined && (!positive(value.expires_in) || value.expires_in > 28800)) ||
    (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' ||
      !/^ghr_[A-Za-z0-9_]{8,200}$/.test(value.refresh_token) || !positive(value.refresh_token_expires_in) ||
      value.refresh_token_expires_in > 15897600))) {
    throw new Error('invalid-token-response');
  }
  return { accessToken: value.access_token, refreshToken: value.refresh_token ?? null,
    expiresAt: value.expires_in === undefined ? null : now() + value.expires_in * 1000,
    refreshExpiresAt: value.refresh_token === undefined ? null : now() + value.refresh_token_expires_in * 1000 };
}

export async function readApp(slug, options = {}) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new Error('invalid-app');
  const value = await json(`https://api.github.com/apps/${slug}`, undefined, options);
  if (value.slug !== slug || !positive(value.id) || !client(value.client_id) ||
    typeof value.name !== 'string' || typeof value.owner?.login !== 'string' ||
    !['User', 'Organization'].includes(value.owner.type) || !value.permissions ||
    typeof value.permissions !== 'object' || Array.isArray(value.permissions)) throw new Error('invalid-app-response');
  const permissions = {};
  for (const [name, level] of Object.entries(value.permissions)) {
    if (!/^[a-z_]{1,80}$/.test(name) || !['read', 'write', 'admin'].includes(level)) throw new Error('invalid-app-response');
    permissions[name] = level;
  }
  return { id: value.id, slug, clientId: value.client_id, name: value.name,
    owner: value.owner.login, ownerType: value.owner.type, permissions };
}

export async function startDevice(clientId, options = {}) {
  if (!client(clientId)) throw new Error('invalid-client');
  const repositoryId = options.repositoryId;
  if (repositoryId !== undefined && !positive(repositoryId)) throw new Error('invalid-repository');
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal }));
  const cancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const transport = { ...options, signal };
  const value = await json(DEVICE_URL, { client_id: clientId }, transport);
  if (value.error) throw new Error(value.error === 'device_flow_disabled' ? 'device-flow-disabled' : 'device-request-denied');
  if (typeof value.device_code !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(value.device_code) ||
    typeof value.user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(value.user_code) ||
    value.verification_uri !== VERIFY_URL || !positive(value.expires_in) || value.expires_in > 1800 ||
    !positive(value.interval) || value.interval > 120) throw new Error('invalid-device-response');
  const expiresAt = now() + value.expires_in * 1000;
  const lifetime = AbortSignal.timeout(value.expires_in * 1000);
  const flowSignal = AbortSignal.any([signal, lifetime]);
  let deviceCode = value.device_code, used = false;
  return Object.freeze({ verificationUri: VERIFY_URL, userCode: value.user_code, expiresAt,
    cancel: () => cancellation.abort(),
    async authorize() {
      if (used) throw new Error('transaction-used');
      used = true;
      let interval = value.interval;
      try {
        for (let attempts = 0; attempts < 500; attempts++) {
          if (signal.aborted) throw new Error('cancelled');
          if (lifetime.aborted || now() >= expiresAt) throw new Error('authorization-expired');
          try { await wait(Math.min(interval * 1000, expiresAt - now()), flowSignal); }
          catch { throw new Error(signal.aborted ? 'cancelled' : lifetime.aborted ? 'authorization-expired' : 'authorization-wait-failed'); }
          if (signal.aborted) throw new Error('cancelled');
          if (lifetime.aborted || now() >= expiresAt) throw new Error('authorization-expired');
          const result = await json(TOKEN_URL, { client_id: clientId, device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            ...(repositoryId === undefined ? {} : { repository_id: repositoryId }) }, { ...transport, signal: flowSignal });
          if (lifetime.aborted || now() >= expiresAt) throw new Error('authorization-expired');
          if (result.error === 'authorization_pending') continue;
          if (result.error === 'slow_down') {
            interval = Math.max(interval + 5, positive(result.interval) ? result.interval : 0);
            if (interval > 120) throw new Error('authorization-rate-limited');
            continue;
          }
          if (['expired_token', 'token_expired'].includes(result.error)) throw new Error('authorization-expired');
          if (result.error === 'access_denied') throw new Error('authorization-denied');
          return tokenResult(result, now);
        }
        throw new Error('authorization-attempt-limit');
      } catch (error) {
        if (lifetime.aborted && !signal.aborted) throw new Error('authorization-expired');
        throw error;
      } finally { deviceCode = null; }
    } });
}

export async function refreshDevice(clientId, refreshToken, options = {}) {
  if (!client(clientId)) throw new Error('invalid-client');
  if (typeof refreshToken !== 'string' || !/^ghr_[A-Za-z0-9_]{8,200}$/.test(refreshToken)) throw new Error('invalid-refresh-token');
  return tokenResult(await json(TOKEN_URL, { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }, options),
    options.now ?? Date.now);
}
