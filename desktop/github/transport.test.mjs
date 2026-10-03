import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRequest } from './transport.mjs';

test('bounded transient reads retry; uncertain writes, malformed replies and unfit guidance never replay', async () => {
  let calls = 0;
  const request = makeRequest('synthetic', async () => ++calls === 1 ? new Response(null, { status: 503 }) : Response.json({ ok: true }), undefined,
    { attempts: 3, deadlineAt: Date.now() + 10000 });
  assert.deepEqual(await request('GET', '/fixture'), { ok: true }); assert.equal(calls, 2);
  for (const scenario of ['write', 'malformed', 'guidance']) {
    calls = 0;
    const bounded = makeRequest('synthetic', async () => {
      calls++;
      if (scenario === 'write') throw Error('lost synthetic reply');
      if (scenario === 'malformed') return new Response('invalid JSON');
      return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
    }, undefined, { attempts: 3, deadlineAt: Date.now() + 10000 });
    await assert.rejects(bounded(scenario === 'write' ? 'POST' : 'GET', '/fixture', scenario === 'write' ? {} : undefined),
      scenario === 'write' ? /write-result-uncertain/ : scenario === 'malformed' ? /response-invalid/ : /remaining deadline/);
    assert.equal(calls, 1, scenario);
  }
});

test('GitHub rate-limit timing is bounded; permission denial and writes are never retried', async () => {
  for (const [status, headers, method, expected] of [[403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) }, 'GET', /remaining deadline/],
    [429, {}, 'GET', /remaining deadline/], [403, {}, 'GET', /http-403/], [403, { 'Retry-After': '60' }, 'PATCH', /http-403/]]) {
    let calls = 0;
    const request = makeRequest('synthetic', async () => { calls++; return new Response(null, { status, headers }); }, undefined, { attempts: 3, deadlineAt: Date.now() + 10000 });
    await assert.rejects(request(method, '/fixture', method === 'PATCH' ? {} : undefined), expected); assert.equal(calls, 1);
  }
});
