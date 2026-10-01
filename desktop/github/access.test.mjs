import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifyAccess, fixtures } from './access.mjs';

const permissions = { actions: 'read', checks: 'read', contents: 'write', issues: 'write', metadata: 'read',
  organization_projects: 'write', pull_requests: 'write', statuses: 'read' };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
function transport(change = {}, calls = []) {
  return async (url, options) => {
    calls.push({ url, method: options.method });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ghu_synthetic_fixture');
    const path = new URL(url).pathname;
    if (path === '/user') return reply({ login: change.account ?? 'brimdor' });
    if (path === '/user/installations') return reply({ total_count: change.total ?? 2, installations:
      fixtures.map((f, i) => ({ id: i + 1, app_id: 5148613, account: { login: f.owner, type: f.type },
        repository_selection: 'selected', permissions: f.type === 'User'
          ? Object.fromEntries(Object.entries(permissions).filter(([key]) => key !== 'organization_projects')) : permissions })) });
    if (/^\/user\/installations\/\d+\/repositories$/.test(path)) {
      const f = fixtures[Number(path.split('/')[3]) - 1];
      const repositories = change.emptyRepositories ? [] : [{ id: change.repoId ?? f.id, node_id: change.repoNode ?? f.node,
        full_name: change.repoPath ?? `${f.owner}/${f.name}`, private: change.repoPrivate ?? true }];
      if (change.extraRepository) repositories.push({ id: f.id + 10, node_id: 'R_ghu_DO_NOT_ECHO',
        full_name: 'private-owner/ghu_DO_NOT_ECHO', private: true });
      return reply({ total_count: repositories.length, repositories });
    }
    if (path === '/graphql') return reply({ errors: [{ type: 'FORBIDDEN', message: 'ghu_DO_NOT_ECHO' }] });
    if (path === '/user/repos' || /^\/orgs\//.test(path)) return reply({ message: 'ghu_DO_NOT_ECHO' }, 403);
    const f = fixtures.find(f => path.startsWith(`/repos/${f.owner}/${f.name}`));
    if (!f) throw new Error('Unexpected route or ghp_SECRET');
    if (options.method === 'POST') return reply({ id: f.id + 1, node_id: `I_${f.id}`, number: 1,
      ...JSON.parse(options.body), state: 'open', assignees: [{ login: 'brimdor' }] }, 201);
    if (options.method === 'PATCH') return reply({ id: f.id + 1, node_id: `I_${f.id}`, number: 1,
      ...JSON.parse(options.body), state: 'open', assignees: [{ login: 'brimdor' }] });
    return reply({ id: f.id + 1, node_id: `I_${f.id}`, number: 1, title: 'D-05 synthetic Issue — updated',
      state: 'open', assignees: [{ login: 'brimdor' }] });
  };
}

test('App preflight binds both exact selected fixtures and reports actual endpoint denial', async () => {
  const calls = [];
  const result = await qualifyAccess('ghu_synthetic_fixture', { send: transport({}, calls) });
  assert.equal(result.installations, 'passed');
  assert.equal(result.rows.filter(r => r.operation === 'issue-create-edit-assignment-readback' && r.status === 'passed').length, 2);
  assert.equal(result.rows.filter(r => r.operation === 'repository-creation' && r.detail === 'http-403').length, 2);
  assert.equal(result.rows.filter(r => r.operation === 'projects-access' && r.detail === 'graphql-forbidden').length, 2);
  assert.equal(JSON.stringify(result).includes('DO_NOT_ECHO'), false);
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 2);
});

test('wrong account, changed fixture identity and incomplete lists dispatch no write', async () => {
  for (const change of [{ account: 'other' }, { repoId: 123 }, { total: 3 }]) {
    const calls = [];
    await assert.rejects(qualifyAccess('ghu_synthetic_fixture', { send: transport(change, calls) }));
    assert.equal(calls.some(c => c.method !== 'GET'), false);
  }
  await assert.rejects(qualifyAccess('ghp_wrong-token'), /app-token-required/);
});

test('repository mismatch reports only fixed identity booleans and count before any mutation', async () => {
  for (const [change, failedField, count] of [
    [{ repoId: 123 }, 'idMatches', 1], [{ repoNode: 'R_ghu_DO_NOT_ECHO' }, 'nodeMatches', 1],
    [{ repoPath: 'private-owner/ghu_DO_NOT_ECHO' }, 'pathMatches', 1], [{ repoPrivate: false }, 'privateMatches', 1],
    [{ emptyRepositories: true }, 'idMatches', 0], [{ extraRepository: true }, null, 2],
  ]) {
    const calls = [], receipts = [];
    await assert.rejects(qualifyAccess('ghu_synthetic_fixture', { send: transport(change, calls),
      onResult: receipt => receipts.push(receipt) }), /repository-mismatch/);
    assert.equal(calls.some(call => call.method !== 'GET'), false);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].fixture, `${fixtures[0].owner}/${fixtures[0].name}`);
    assert.equal(receipts[0].operation, 'repository-binding');
    assert.equal(receipts[0].status, 'failed');
    assert.deepEqual(Object.keys(receipts[0].detail).sort(), ['count', 'idMatches', 'nodeMatches', 'pathMatches', 'privateMatches'].sort());
    assert.equal(receipts[0].detail.count, count);
    for (const [field, value] of Object.entries(receipts[0].detail)) if (field !== 'count') assert.equal(typeof value, 'boolean');
    if (failedField) assert.equal(receipts[0].detail[failedField], false);
    assert.equal(JSON.stringify(receipts).includes('DO_NOT_ECHO'), false);
  }
});

test('an uncertain write is never retried or echoed', async () => {
  for (const fault of [() => { throw new Error('ghu_DO_NOT_ECHO'); },
    () => new Response('invalid ghu_DO_NOT_ECHO'), () => new Response('x'.repeat(1048577))]) {
    const calls = [], receipts = [];
    const base = transport({}, calls);
    const result = await qualifyAccess('ghu_synthetic_fixture', { onResult: row => receipts.push(row), send: async (url, options) => {
      if (new URL(url).pathname.endsWith('/issues') && options.method === 'POST') {
        calls.push({ url, method: 'POST' });
        return fault();
      }
      return base(url, options);
    } });
    assert.equal(calls.filter(c => new URL(c.url).pathname.endsWith('/issues') && c.method === 'POST').length, 2);
    assert.equal(result.rows.filter(r => r.detail === 'write-result-uncertain').length, 2);
    assert.equal(receipts.length, result.rows.length);
    assert.equal(JSON.stringify(result).includes('DO_NOT_ECHO'), false);
  }
});
