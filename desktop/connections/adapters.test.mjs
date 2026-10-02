import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGitHub, githubApp, githubAdapter } from './github.mjs';
import { appPermissions } from '../github/transport.mjs';
import { ollamaAdapter, codexModels } from './providers.mjs';

test('GitHub complete scoped discovery rejects missing/duplicate resources and reports limited Projects', async () => {
  const credential = { accessToken: 'ghu_syntheticFixtureOnly123', expiresAt: 200000, refreshToken: 'ghr_syntheticRefresh123', refreshExpiresAt: 300000 };
  let mode = 'complete';
  const send = async (url, request) => {
    const path = new URL(url).pathname;
    if (mode === 'revoked') return new Response('{}', { status: 401 });
    if (path !== '/apps/pipeliner-desktop') assert.equal(request.headers.Authorization, `Bearer ${credential.accessToken}`);
    if (path === '/user') return Response.json({ id: 1, node_id: 'U1', login: 'fixture', type: 'User' });
    if (path === '/apps/pipeliner-desktop') return Response.json({ ...githubApp, client_id: githubApp.clientId, name: 'Pipeliner', owner: { login: githubApp.owner, type: 'Organization' }, permissions: appPermissions });
    if (path === '/user/installations') return Response.json({ total_count: 1, installations: [{ id: 10, app_id: githubApp.id, account: { id: 2, node_id: 'O2', login: 'fixture-org', type: 'Organization' }, repository_selection: 'selected', permissions: appPermissions }] });
    if (path === '/user/installations/10/repositories') {
      const repo = { id: 3, node_id: 'R3', owner: { id: 2, login: 'fixture-org' }, name: 'repo', full_name: 'fixture-org/repo', private: true, permissions: { pull: true, push: false } };
      return Response.json({ total_count: mode === 'partial' ? 2 : mode === 'duplicate' ? 2 : 1, repositories: mode === 'duplicate' ? [repo, repo] : [repo] });
    }
    if (path === '/graphql') return Response.json(mode === 'limited' ? { errors: [{ type: 'FORBIDDEN' }] } : { data: { node: { id: 'O2', projectsV2: { totalCount: 1, nodes: [{ id: 'P1', number: 1, title: 'Fixture Project', public: false }], pageInfo: { hasNextPage: false } } } } });
    throw new Error('unexpected-test-request');
  };
  const record = await inspectGitHub(credential, { send, now: () => 100000 });
  assert.equal(record.view.repositories[0].id, 'R3'); assert.deepEqual(record.view.repositories[0].permissions, ['pull']);
  assert.equal(record.view.projects[0].ownerId, 'O2'); assert.equal(record.view.health, 'connected');
  for (mode of ['partial', 'duplicate']) await assert.rejects(inspectGitHub(credential, { send }), /partial-access/);
  mode = 'limited'; assert.equal((await inspectGitHub(credential, { send })).view.resourceCompleteness.projects, false);
  mode = 'revoked'; await assert.rejects(inspectGitHub(credential, { send }), /http-401/);
  await assert.rejects(inspectGitHub(credential, { send: async () => Response.json({ id: 99, node_id: 'U99', login: 'other', type: 'User' }), previousAccount: record.account }), /account-changed/);
  const adapter = githubAdapter({ now: () => 400000, send });
  await assert.rejects(adapter.refresh({ value: record, signal: new AbortController().signal }), /reauthentication-required/);
});

test('Cloud catalog is not inference; selected-model tool test is bounded and rejects a substituted response', async () => {
  let requests = 0, substitute = false;
  const send = async (url, request) => {
    assert.equal(new URL(url).origin, 'https://ollama.com'); assert.equal(request.headers.Authorization, 'Bearer synthetic-fixture-key');
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'test-model' }] });
    assert.equal(new URL(url).pathname, '/api/chat'); const body = JSON.parse(request.body); requests++;
    assert.equal(body.options.num_predict, 128); assert.equal(body.model, 'test-model');
    const part = { model: substitute ? 'deepseek-v4.1-flash' : body.model, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 6,
      message: body.tools ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup_fixture', arguments: {
        target: 'synthetic-pipeliner-connection', nonce: /nonce ([0-9a-f-]+),/.exec(body.messages[0].content)[1], epoch: 1 } } }] } : { role: 'assistant', content: 'fixture-ok' } };
    return new Response(`${JSON.stringify(part)}\n`);
  };
  const adapter = ollamaAdapter({ entry: async () => ({ key: 'synthetic-fixture-key' }), send });
  const signal = new AbortController().signal, value = await adapter.connect({ signal });
  assert.equal(value.view.health, 'limited'); assert.equal(value.view.capability, null); assert.equal(requests, 0);
  const result = await adapter.test({ value, model: 'test-model', signal });
  assert.equal(result.view.capability.toolLoop, true); assert.equal(result.view.credentialStatus, 'Key verified by inference'); assert.equal(requests, 2);
  assert.equal(JSON.stringify(result.view).includes(value.credential), false);
  substitute = true; await assert.rejects(adapter.test({ value, model: 'test-model', signal }), /model-mismatch/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(adapter.refresh({ value, signal: cancelled.signal }));
});

test('Codex model catalog checks every page and rejects repeated cursors', async () => {
  let requests = 0;
  const server = { request: async (method, params) => { assert.equal(method, 'model/list'); requests++;
    return params.cursor ? { data: [{ model: 'second', displayName: 'Second' }], nextCursor: null } : { data: [{ model: 'first', isDefault: true }], nextCursor: 'next' }; } };
  assert.deepEqual((await codexModels(server)).map(m => m.id), ['first', 'second']); assert.equal(requests, 2);
  await assert.rejects(codexModels({ request: async () => ({ data: [{ model: 'same' }], nextCursor: 'next' }) }), /catalog-invalid/);
});

test('Cloud turns keep historical qualification, enforce model/output bounds and use the direct Cloud route', async () => {
  let calls = 0, mode = 'ok';
  const send = async (url, request) => {
    assert.equal(new URL(url).origin, 'https://ollama.com'); assert.equal(request.headers.Authorization, 'Bearer synthetic-private-provider-key');
    if (url.endsWith('/api/tags')) return Response.json({ models: mode === 'removed' ? [] : [{ name: 'test-model' }] });
    calls++; const body = JSON.parse(request.body); assert.equal(body.model, 'test-model'); assert.equal(body.options.num_predict, 2048);
    return new Response(JSON.stringify({ model: mode === 'substituted' ? 'other-model' : 'test-model', done: true, done_reason: mode === 'truncated' ? 'length' : 'stop',
      prompt_eval_count: 11, eval_count: 4, message: { role: 'assistant', content: 'synthetic result' } }) + '\n');
  };
  const adapter = ollamaAdapter({ entry: async () => {}, send }), signal = new AbortController().signal;
  const value = { credential: 'synthetic-private-provider-key', view: { health: 'connected', selectedModel: 'test-model', models: [{ id: 'test-model' }],
    capability: { model: 'test-model', testedAt: 123, stream: true, toolLoop: true, resumed: true, scope: 'Synthetic provider path only.' } } };
  const refreshed = await adapter.refresh({ value, signal }); assert.deepEqual(refreshed.view.capability, value.view.capability); assert.equal(calls, 0);
  const request = { value: refreshed, model: 'test-model', messages: [{ role: 'user', content: 'Synthetic fixture.' }], tools: [], maxOutput: 2048, signal };
  const result = await adapter.turn(request); assert.equal(result.content, 'synthetic result'); assert.deepEqual(result.usage, { input: 11, output: 4 });
  await assert.rejects(adapter.turn({ ...request, model: 'other-model' }), /capability-unverified/);
  await assert.rejects(adapter.turn({ ...request, maxOutput: 0 }), /output-limit-invalid/); assert.equal(calls, 1);
  mode = 'substituted'; await assert.rejects(adapter.turn(request), /model-mismatch/);
  mode = 'truncated'; await assert.rejects(adapter.turn(request), /output-truncated/);
  mode = 'removed'; const removed = await adapter.refresh({ value, signal }); assert.equal(removed.view.health, 'limited'); assert.equal(removed.view.capability, null);
  await assert.rejects(adapter.turn({ ...request, value: removed }), /capability-unverified/); assert.equal(calls, 3);
});
