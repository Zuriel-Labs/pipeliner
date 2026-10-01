import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readApp, startDevice, refreshDevice } from './device.mjs';

const clientId = 'Iv1.syntheticclient';
const device = { device_code: 'synthetic-device-code-only', user_code: 'ABCD-EFGH',
  verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 2 };
const token = { access_token: 'ghu_synthetic_access', refresh_token: 'ghr_synthetic_refresh',
  token_type: 'bearer', scope: '', expires_in: 28800, refresh_token_expires_in: 15897600 };
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('public App lookup returns only public connection metadata', async () => {
  const app = await readApp('fixture-app', { send: async (url, options) => {
    assert.equal(url, 'https://api.github.com/apps/fixture-app');
    assert.equal(options.headers.Authorization, undefined);
    return response({ id: 7, slug: 'fixture-app', name: 'Fixture App', client_id: clientId,
      owner: { login: 'fixture-owner', type: 'Organization' }, permissions: { issues: 'write' },
      unexpected_secret: 'never-return-this' });
  } });
  assert.equal(app.clientId, clientId);
  assert.equal(JSON.stringify(app).includes('never-return-this'), false);
  await assert.rejects(readApp('../other'), /invalid-app/);
});

test('device flow hides device code and honors pending and slow-down timing', async () => {
  let time = 1000;
  const waits = [], requests = [];
  const replies = [device, { error: 'authorization_pending' }, { error: 'slow_down', interval: 7 }, token];
  const send = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body.includes('client_secret'), false);
    requests.push({ url, time, body: new URLSearchParams(options.body) });
    return response(replies.shift());
  };
  const flow = await startDevice(clientId, { send, now: () => time,
    wait: async milliseconds => { waits.push(milliseconds); time += milliseconds; } });
  assert.equal(flow.userCode, device.user_code);
  assert.equal(flow.verificationUri, device.verification_uri);
  assert.equal(JSON.stringify(flow).includes(device.device_code), false);
  const connected = await flow.authorize();
  assert.equal(connected.accessToken, token.access_token);
  assert.deepEqual(waits, [2000, 2000, 7000]);
  assert.equal(requests[0].url, 'https://github.com/login/device/code');
  assert.equal(requests[1].url, 'https://github.com/login/oauth/access_token');
  assert.equal(requests[1].body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  await assert.rejects(flow.authorize(), /transaction-used/);
});

test('device cancellation and expiry never return credentials', async () => {
  let sends = 0, time = 0;
  const flow = await startDevice(clientId, { send: async () => { sends++; return response(device); },
    now: () => time, wait: async milliseconds => { time += milliseconds; } });
  flow.cancel();
  await assert.rejects(flow.authorize(), /cancelled/);
  assert.equal(sends, 1);
  const expired = await startDevice(clientId, { send: async () => response(device), now: () => time });
  time += 60001;
  await assert.rejects(expired.authorize(), /authorization-expired/);
});

test('provider destinations, denial, malformed tokens and late abort fail safely', async () => {
  for (const verification_uri of ['https://evil.invalid/login/device', 'https://github.com/login/device?other=1']) {
    await assert.rejects(startDevice(clientId, { send: async () => response({ ...device, verification_uri }) }), /invalid-device-response/);
  }
  let index = 0;
  const denied = await startDevice(clientId, { send: async () => response(index++ ?
    { error: 'access_denied', error_description: 'SECRET-DO-NOT-PRINT' } : device), wait: async () => {} });
  await assert.rejects(denied.authorize(), error => error.message === 'authorization-denied');
  index = 0;
  const malformed = await startDevice(clientId, { send: async () => response(index++ ?
    { ...token, access_token: 'ghp_broad_token' } : device), wait: async () => {} });
  await assert.rejects(malformed.authorize(), /invalid-token-response/);
  const cancellation = new AbortController();
  await assert.rejects(startDevice(clientId, { signal: cancellation.signal, send: async () => {
    cancellation.abort(); return response(device);
  } }), /cancelled/);
});

test('responses are bounded and transport errors never echo credentials', async () => {
  await assert.rejects(startDevice(clientId, { send: async () => new Response('x'.repeat(65537)) }), /response-too-large/);
  await assert.rejects(startDevice(clientId, { send: async () => { throw new Error('ghu_SECRET'); } }),
    error => error.message === 'transport-failed');
  await assert.rejects(startDevice(clientId, { send: async () => new Response('sensitive', { status: 403 }) }), /http-403/);
});

test('device-issued token refresh needs no secret and rejects broad token substitution', async () => {
  const refreshed = await refreshDevice(clientId, token.refresh_token, { send: async (url, options) => {
    assert.equal(url, 'https://github.com/login/oauth/access_token');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), token.refresh_token);
    assert.equal(body.has('client_secret'), false);
    return response({ ...token, access_token: 'ghu_synthetic_rotated' });
  } });
  assert.equal(refreshed.accessToken, 'ghu_synthetic_rotated');
  await assert.rejects(refreshDevice(clientId, 'ghp_wrong-kind'), /invalid-refresh-token/);
});
