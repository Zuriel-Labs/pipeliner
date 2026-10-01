import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { qualifyAccess, qualifySetup, fixtures } from './access.mjs';

const permissions = { actions: 'read', checks: 'read', contents: 'write', issues: 'write', metadata: 'read',
  organization_projects: 'write', pull_requests: 'write', statuses: 'read' };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
function transport(change = {}, calls = []) {
  const targets = change.setup ? fixtures.map(f => ({ ...f,
    ...(f.type === 'User' ? { id: 1400801012, node: 'R_kgDOU36G9A',
      issue: { id: 5670334810, node: 'I_kwDOU36G9M8AAAABUfpxWg', number: 1 } } : { issue: undefined }),
    name: f.type === 'User' ? 'pipeliner-d05-26-oauth-personal' : 'pipeliner-d05-26-oauth-org' })) : fixtures;
  const states = new Map(targets.map(f => [f.id, { labels: [], merged: false, release: null, asset: null,
    created: !change.setup || f.type === 'User', projectCreated: false,
    fields: [{ id: `status-${f.id}`, name: 'Status', options: [{ id: 'todo', name: 'Todo' }] }], values: {}, item: false }]));
  return async (url, options) => {
    calls.push({ url, method: options.method, body: options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : null });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, change.setup ? 'Bearer gho_synthetic_setup' : 'Bearer ghu_synthetic_fixture');
    const path = new URL(url).pathname;
    if (path === '/user') return reply({ login: change.account ?? 'brimdor', id: change.accountId ?? 1202831,
      node_id: fixtures[0].ownerNode, type: 'User' });
    if (path === '/user/installations') {
      const installations = fixtures.map((f, i) => ({ id: i + 1, app_id: 5148613, account: { login: f.owner, type: f.type },
        repository_selection: 'selected', permissions: f.type === 'User'
          ? Object.fromEntries(Object.entries(permissions).filter(([key]) => key !== 'organization_projects')) : permissions }))
        .filter(i => !change.onlyInstallation || i.account.login === change.onlyInstallation);
      if (change.foreignInstallation) installations[0].account.login = 'unapproved-owner';
      if (change.duplicateOwner) installations[1].account = installations[0].account;
      return reply({ total_count: change.total ?? installations.length, installations });
    }
    if (/^\/user\/installations\/\d+\/repositories$/.test(path)) {
      const f = fixtures[Number(path.split('/')[3]) - 1];
      const repositories = change.emptyRepositories ? [] : [{ id: change.repoId ?? f.id, node_id: change.repoNode ?? f.node,
        full_name: change.repoPath ?? `${f.owner}/${f.name}`, private: change.repoPrivate ?? true }];
      if (change.extraRepository) repositories.push({ id: f.id + 10, node_id: 'R_ghu_DO_NOT_ECHO',
        full_name: 'private-owner/ghu_DO_NOT_ECHO', private: true });
      if (change.existingRepository && f.type === 'Organization') repositories.unshift({ id: 1363240768,
        node_id: change.existingNode ?? 'R_kgDOUUFnQA', full_name: 'Zuriel-Labs/pipeliner', private: false });
      return reply({ total_count: repositories.length, repositories });
    }
    if (path === '/graphql') {
      if (!change.projects) return reply({ errors: [{ type: 'FORBIDDEN', message: 'ghu_DO_NOT_ECHO' }] });
      const { query, variables } = JSON.parse(options.body);
      const f = targets.find(f => variables.login === f.owner || variables.owner === f.ownerNode ||
        [variables.project, variables.id].includes(`PVT_${f.id}`) || variables.field === `status-${f.id}`);
      if (!f) throw new Error('Unexpected Project target');
      const state = states.get(f.id), project = { id: `PVT_${f.id}`, number: 9,
        title: `Pipeliner D-05 #26 ${change.setup ? 'OAuth ' : ''}${f.type === 'User' ? 'Personal' : 'Organization'} Fixture`,
        public: false, owner: { id: f.ownerNode, login: f.owner } };
      const connection = nodes => ({ totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false, endCursor: null } });
      const ownerKey = query.includes('node(id:$owner)') ? 'node' : f.type === 'User' ? 'user' : 'organization';
      if (query.includes('repositories(first:100')) return reply({ data: { [ownerKey]:
        { id: change.wrongOwner ? 'O_other' : f.ownerNode, login: f.owner,
          repositories: change.partialRepositories ? { ...connection([]), totalCount: 1 } : connection(change.repositoryCollision || (change.setup && f.type === 'User') ?
            [{ id: f.node, nameWithOwner: `${f.owner}/${f.name}`, isPrivate: true }] : []) } } });
      if (query.includes('projectsV2(first:100')) return reply({ data: { [ownerKey]:
        { id: change.wrongOwner ? 'O_other' : f.ownerNode, login: f.owner,
          projectsV2: connection(state.projectCreated || change.projectCollision ? [project] : []) } } });
      if (query.includes('createProjectV2(')) { state.projectCreated = true; return reply({ data: { createProjectV2: { projectV2: project } } }); }
      if (query.includes('fields(first:100')) return reply({ data: { node: { id: project.id, fields: connection(state.fields) } } });
      if (query.includes('updateProjectV2Field(')) {
        state.fields[0].options = variables.options.map((option, i) => ({ id: `status-option-${i}`, name: option.name }));
        return reply({ data: { updateProjectV2Field: { projectV2Field: state.fields[0] } } });
      }
      if (query.includes('createProjectV2Field(')) {
        const field = { id: `field-${variables.name}`, name: variables.name,
          options: variables.options.map((option, i) => ({ id: `${variables.name}-${i}`, name: option.name })) };
        state.fields.push(field);
        return reply({ data: { createProjectV2Field: { projectV2Field: field } } });
      }
      if (query.includes('addProjectV2ItemById(')) { state.item = true; return reply({ data: { addProjectV2ItemById: { item: { id: `PVTI_${f.id}` } } } }); }
      if (query.includes('updateProjectV2ItemFieldValue(')) { state.values[variables.field] = variables.option;
        return reply({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: `PVTI_${f.id}` } } } }); }
      if (query.includes('items(first:100')) return reply({ data: { node: { id: project.id, items: connection(state.item ? [{ id: `PVTI_${f.id}`,
        content: { id: f.issue?.node ?? `I_${f.id}`, number: 1, state: 'OPEN', repository: { id: f.node } },
        fieldValues: connection(state.fields.filter(field => state.values[field.id]).map(field => ({
          name: field.options.find(option => option.id === state.values[field.id]).name, field: { id: field.id, name: field.name } }))) }] : []) } } });
      throw new Error('Unexpected Project operation');
    }
    if (change.setup && path === '/orgs/Zuriel-Labs' && options.method === 'GET') {
      return reply({ node_id: change.wrongOwner ? 'O_other' : fixtures[1].ownerNode, login: fixtures[1].owner, type: 'Organization' });
    }
    if (path === '/user/repos' || /^\/orgs\//.test(path)) {
      if (!change.setup) return reply({ message: 'ghu_DO_NOT_ECHO' }, 403);
      const f = targets.find(f => f.name === JSON.parse(options.body).name);
      if (!f) throw new Error('Unexpected creation target');
      states.get(f.id).created = true;
      return reply({ id: f.id, node_id: f.node, full_name: `${f.owner}/${f.name}`, private: true }, 201);
    }
    const f = targets.find(f => path.startsWith(`/repos/${f.owner}/${f.name}`));
    if (!f) throw new Error('Unexpected route or ghp_SECRET');
    const state = states.get(f.id), prefix = `/repos/${f.owner}/${f.name}`;
    const pull = () => ({ id: f.id + 2, node_id: `PR_${f.id}`, number: 2, state: state.merged ? 'closed' : 'open',
      merged: state.merged, merge_commit_sha: state.merged ? 'd'.repeat(40) : null,
      head: { sha: change.stalePR ? 'e'.repeat(40) : 'b'.repeat(40), ref: 'd05-26-qualification', repo: { id: f.id, node_id: f.node } },
      base: { ref: 'main', repo: { id: f.id, node_id: f.node } } });
    if (path === `${prefix}/labels`) {
      if (options.method === 'POST') state.labels.push(JSON.parse(options.body));
      return reply(options.method === 'GET' ? state.labels : state.labels.at(-1));
    }
    if (path === `${prefix}/labels/d05-qualification`) {
      if (options.method === 'PATCH') Object.assign(state.labels[0], JSON.parse(options.body));
      return reply(state.labels[0]);
    }
    if (path === `${prefix}/issues/1/labels`) return reply([{ name: 'Ready for Development' }, { name: 'd05-qualification' }]);
    if (path === `${prefix}/git/matching-refs/heads/d05-26-qualification`) return reply([]);
    if (path === `${prefix}/git/ref/heads/main`) return reply({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (path === `${prefix}/git/refs`) return reply({ ref: 'refs/heads/d05-26-qualification', object: { type: 'commit', sha: 'a'.repeat(40) } }, 201);
    if (path === `${prefix}/contents/d05-qualification.txt`) return reply({ content: { sha: 'c'.repeat(40) }, commit: { sha: 'b'.repeat(40) } }, 201);
    if (path === `${prefix}/pulls` || path === `${prefix}/pulls/2`) return reply(pull(), options.method === 'POST' ? 201 : 200);
    if (path === `${prefix}/commits/${'b'.repeat(40)}/check-runs`) return reply({ total_count: 0, check_runs: [] });
    if (path === `${prefix}/commits/${'b'.repeat(40)}/status`) return reply({ sha: 'b'.repeat(40), total_count: 0, state: 'pending', statuses: [] });
    if (path === `${prefix}/pulls/2/merge`) { state.merged = true; return reply({ merged: true, sha: 'd'.repeat(40) }); }
    if (path === `${prefix}/releases`) {
      if (options.method === 'GET') return reply(state.release ? [state.release] : []);
      state.release = { id: f.id + 3, node_id: `RE_${f.id}`, ...JSON.parse(options.body) };
      return reply(state.release, 201);
    }
    if (path === `${prefix}/releases/${f.id + 3}/assets`) {
      state.asset = { id: f.id + 4, name: 'd05-qualification.txt', size: Buffer.byteLength('Pipeliner D-05 synthetic asset\n'),
        digest: `sha256:${createHash('sha256').update('Pipeliner D-05 synthetic asset\n').digest('hex')}` };
      return reply(state.asset, 201);
    }
    if (path === `${prefix}/releases/${f.id + 3}`) return reply({ ...state.release, assets: [state.asset] });
    if (path === `/repos/${f.owner}/${f.name}`) return state.created || change.repositoryCollision ? reply({ id: change.directId ?? f.id, node_id: f.node,
      full_name: `${f.owner}/${f.name}`, private: true }) : reply({}, 404);
    if (options.method === 'POST') return reply({ id: f.issue?.id ?? f.id + 1, node_id: f.issue?.node ?? `I_${f.id}`, number: 1,
      ...JSON.parse(options.body), state: 'open', assignees: [{ login: 'brimdor' }] }, 201);
    if (options.method === 'PATCH') return reply({ id: f.issue?.id ?? f.id + 1, node_id: f.issue?.node ?? `I_${f.id}`, number: 1,
      ...JSON.parse(options.body), state: 'open', assignees: [{ login: 'brimdor' }] });
    return reply({ id: f.issue?.id ?? f.id + 1, node_id: f.issue?.node ?? `I_${f.id}`, number: 1, title: change.setup ? 'D-05 synthetic setup Issue' : 'D-05 synthetic Issue — updated',
      state: 'open', assignees: [{ login: 'brimdor' }], labels: [{ name: 'Ready for Development' }, { name: 'd05-qualification' }] });
  };
}

test('setup OAuth binds the owned partial fixture and creates the new organization repository and both Projects', async () => {
  const calls = [];
  const base = transport({ setup: true, projects: true }, calls);
  const result = await qualifySetup('gho_synthetic_setup', { send: async (url, request) => {
    if (url.endsWith('/graphql')) {
      const query = JSON.parse(request.body).query;
      if (query.includes('repositories(first:100')) assert.equal(query.includes('ownerAffiliations:[OWNER]'), true);
      if (query.includes('repositories(first:100') || query.includes('projectsV2(first:100')) assert.equal(query.includes('node(id:$owner)'), true);
      assert.equal(query.includes('id login'), false);
    }
    return base(url, request);
  } });
  assert.equal(result.setup, 'passed');
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows.every(row => row.status === 'passed'), true);
  assert.deepEqual(Object.keys(result.rows.find(row => row.operation === 'setup-issue-readback').detail).sort(), ['id', 'node_id', 'number']);
  assert.equal(calls.filter(call => call.url.endsWith('/user/repos')).length, 0);
  assert.equal(calls.filter(call => call.url.endsWith('/orgs/Zuriel-Labs/repos')).length, 1);
  assert.equal(calls.some(call => /\/installations|\/pulls|\/git\/|\/labels|\/releases/.test(call.url)), false);
  for (const row of result.rows.filter(row => row.operation === 'project-create-fields-status-readback')) {
    assert.deepEqual(row.detail.statuses, ['In Progress', 'In Review', 'Pending Review', 'In Progress']);
  }
  const before = calls.length;
  await result.verify('gho_synthetic_setup');
  assert.equal(calls.slice(before).every(call => call.method === 'GET' || call.body?.query.startsWith('query(')), true);
});

test('verified Project addition may have an empty complete read before becoming visible', async () => {
  const fixture = fixtures[1], calls = [], base = transport({ projects: true }, calls);
  let itemReads = 0;
  const result = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixture.id, send: async (url, request) => {
    if (url.endsWith('/graphql') && JSON.parse(request.body).query.includes('items(first:100') && itemReads++ === 0) {
      return reply({ data: { node: { id: `PVT_${fixture.id}`, items: {
        totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
      } } } });
    }
    return base(url, request);
  } });
  assert.equal(result.rows.find(row => row.operation === 'project-create-fields-status-readback').status, 'passed');
  assert.equal(calls.filter(call => call.body?.query?.includes('addProjectV2ItemById(')).length, 1);
  assert.equal(calls.filter(call => call.body?.query?.includes('updateProjectV2ItemFieldValue(')).length, 7);
});

test('setup rejects identity, collisions, partial discovery and uncertain creation without replay', async () => {
  for (const change of [{ accountId: 7 }, { wrongOwner: true }, { repositoryCollision: true },
    { projectCollision: true }, { partialRepositories: true }]) {
    const calls = [];
    await assert.rejects(qualifySetup('gho_synthetic_setup', { send: transport({ setup: true, projects: true, ...change }, calls) }));
    assert.equal(calls.some(call => call.method !== 'GET' && !call.body?.query.startsWith('query(')), false);
  }
  const calls = [], base = transport({ setup: true, projects: true }, calls);
  let creations = 0;
  await assert.rejects(qualifySetup('gho_synthetic_setup', { send: async (url, request) => {
    if (url.endsWith('/orgs/Zuriel-Labs/repos')) { creations++; throw new Error('gho_SECRET_LOST_RESPONSE'); }
    return base(url, request);
  } }), /write-result-uncertain/);
  assert.equal(creations, 1);
  assert.equal(calls.some(call => call.url.includes('/repos/Zuriel-Labs/') && call.url.includes('/issues')), false);
  await assert.rejects(qualifySetup('ghu_synthetic_fixture'), /setup-token-required/);
  await assert.rejects(qualifyAccess('gho_synthetic_setup'), /app-token-required/);
});

test('GraphQL setup denials report only a fixed error class before any creation', async () => {
  for (const [provider, code] of [[{ type: 'INSUFFICIENT_SCOPES' }, 'graphql-insufficient-scopes'],
    [{ type: 'FORBIDDEN' }, 'graphql-forbidden'], [{ extensions: { code: 'undefinedField' } }, 'graphql-validation'],
    [{ type: 'gho_SECRET' }, 'graphql-rejected']]) {
    const calls = [], base = transport({ setup: true, projects: true }, calls);
    await assert.rejects(qualifySetup('gho_synthetic_setup', { send: async (url, request) => {
      if (url.endsWith('/graphql')) return reply({ errors: [{ ...provider, message: 'gho_SECRET' }] });
      return base(url, request);
    } }), error => error.message === code);
    assert.equal(calls.every(call => call.method === 'GET'), true);
  }
});

test('App preflight binds both exact selected fixtures and reports actual endpoint denial', async () => {
  const calls = [];
  const result = await qualifyAccess('ghu_synthetic_fixture', { send: transport({}, calls) });
  assert.equal(result.installations, 'passed');
  assert.equal(result.rows.filter(r => r.operation === 'issue-create-edit-assignment-readback' && r.status === 'passed').length, 2);
  assert.equal(result.rows.filter(r => r.operation === 'repository-creation' && r.detail === 'http-403').length, 2);
  assert.equal(result.rows.filter(r => r.operation === 'projects-access' && r.detail === 'graphql-forbidden').length, 2);
  assert.equal(JSON.stringify(result).includes('DO_NOT_ECHO'), false);
  assert.equal(calls.filter(c => c.method === 'PATCH' && new URL(c.url).pathname.includes('/issues/')).length, 2);
});

test('one approved fixture restricts every operation while retaining strict repository binding', async () => {
  for (const fixture of fixtures) {
    const calls = [];
    const result = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixture.id, send: transport({}, calls) });
    assert.equal(result.rows.length, 7);
    assert.equal(result.rows.every(row => row.fixture === `${fixture.owner}/${fixture.name}`), true);
    assert.equal(calls.filter(call => call.method === 'PATCH' && new URL(call.url).pathname.includes('/issues/')).length, 1);
    const other = fixtures.find(f => f.id !== fixture.id);
    assert.equal(calls.some(call => call.url.includes(`/repos/${other.owner}/${other.name}`)), false);
    const rejected = [];
    await assert.rejects(qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixture.id,
      send: transport({ extraRepository: true }, rejected) }), /repository-mismatch/);
    assert.equal(rejected.some(call => call.method !== 'GET'), false);
    const restricted = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixture.id,
      send: transport({ onlyInstallation: fixture.owner }) });
    assert.equal(restricted.installations, 'passed');
    for (const change of [{ foreignInstallation: true }, { duplicateOwner: true }, { onlyInstallation: other.owner }]) {
      const denied = [];
      await assert.rejects(qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixture.id,
        send: transport(change, denied) }), /installation-mismatch/);
      assert.equal(denied.some(call => call.method !== 'GET'), false);
    }
  }
  for (const fixtureId of [123, '1399878351', null]) {
    let dispatched = false;
    await assert.rejects(qualifyAccess('ghu_synthetic_fixture', { fixtureId, send: async () => { dispatched = true; return reply({}); } }), /fixture-not-approved/);
    assert.equal(dispatched, false);
  }
});

test('known existing installation selection never becomes a fixture operation target', async () => {
  const calls = [];
  const result = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixtures[1].id,
    send: transport({ existingRepository: true }, calls) });
  assert.equal(result.installations, 'passed');
  assert.equal(result.rows.length, 7);
  assert.equal(calls.some(call => new URL(call.url).pathname.startsWith('/repos/Zuriel-Labs/pipeliner/')), false);
  for (const change of [{ existingRepository: true, existingNode: 'R_other' }, { directId: 123 }]) {
    const denied = [];
    await assert.rejects(qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixtures[1].id,
      send: transport(change, denied) }), /repository-mismatch/);
    assert.equal(denied.some(call => call.method !== 'GET'), false);
  }
});

test('bounded fixture operations preserve Ready, bind merge head and verify asset digest', async () => {
  const calls = [];
  const result = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixtures[0].id,
    send: transport({}, calls) });
  for (const operation of ['labels-create-edit-readback', 'branch-pr-check-merge-readback', 'release-asset-readback']) {
    assert.equal(result.rows.find(row => row.operation === operation)?.status, 'passed');
  }
  assert.equal(calls.some(call => call.method === 'POST' && new URL(call.url).pathname.endsWith('/issues')), false);
  assert.equal(calls.find(call => new URL(call.url).pathname.endsWith('/merge')).body.sha, 'b'.repeat(40));
  assert.equal(calls.filter(call => call.method !== 'GET').some(call => JSON.stringify(call.body).includes('Ready for Development')), false);
  const denied = [];
  const stale = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixtures[1].id,
    send: transport({ stalePR: true }, denied) });
  assert.equal(stale.rows.find(row => row.operation === 'branch-pr-check-merge-readback').status, 'failed');
  assert.equal(denied.some(call => new URL(call.url).pathname.endsWith('/merge')), false);
  assert.equal(denied.some(call => call.method === 'POST' && new URL(call.url).pathname.endsWith('/releases')), false);
});

test('Project setup verifies owner, complete fields, values and all active statuses', async () => {
  const calls = [], receipts = [];
  const result = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixtures[1].id,
    send: transport({ projects: true }, calls), onResult: row => receipts.push(row) });
  assert.equal(result.rows.find(row => row.operation === 'project-create-fields-status-readback')?.status, 'passed');
  assert.equal(receipts.find(row => row.operation === 'project-created')?.detail.id, `PVT_${fixtures[1].id}`);
  assert.deepEqual(result.rows.find(row => row.operation === 'project-create-fields-status-readback').detail.statuses,
    ['In Progress', 'In Review', 'Pending Review', 'In Progress']);
  const denied = [];
  await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixtures[1].id,
    send: transport({ projects: true, wrongOwner: true }, denied) });
  assert.equal(denied.some(call => call.body?.query?.includes('createProjectV2(')), false);
});

test('post-write read lag is bounded to reads and never repeats a fixture mutation', async () => {
  const calls = [], base = transport({ projects: true }, calls);
  let merged = false, staleMerge = true, staleStatus = true;
  const result = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixtures[1].id, send: async (url, options) => {
    const response = await base(url, options), path = new URL(url).pathname;
    if (path.endsWith('/pulls/2/merge')) merged = true;
    if (options.method === 'GET' && path.endsWith('/pulls/2') && merged && staleMerge) {
      staleMerge = false;
      const data = await response.json();
      return reply({ ...data, state: 'open', merged: false, merge_commit_sha: null });
    }
    if (path === '/graphql' && JSON.parse(options.body).query.includes('items(first:100') && staleStatus) {
      staleStatus = false;
      const data = await response.json();
      data.data.node.items.nodes[0].fieldValues.nodes.find(value => value.field.name === 'Status').name = 'Backlog';
      return reply(data);
    }
    return response;
  } });
  for (const operation of ['branch-pr-check-merge-readback', 'project-create-fields-status-readback'])
    assert.equal(result.rows.find(row => row.operation === operation)?.status, 'passed');
  assert.equal(calls.filter(call => new URL(call.url).pathname.endsWith('/merge')).length, 1);
  assert.equal(calls.filter(call => call.body?.query?.includes('createProjectV2(')).length, 1);
  assert.equal(calls.filter(call => call.body?.query?.includes('updateProjectV2ItemFieldValue(')).length, 7);
});

test('read-only binding verifies fresh or rotated access without repeating fixture writes', async () => {
  const fixture = fixtures[1];
  const calls = [];
  const result = await qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixture.id,
    readOnly: true, send: transport({}, calls) });
  assert.equal(result.installations, 'passed');
  assert.deepEqual(result.rows, []);
  assert.equal(calls.every(call => call.method === 'GET'), true);
  for (const change of [{ extraRepository: true }, { repoId: 123 }, { total: 3 }]) {
    const denied = [];
    await assert.rejects(qualifyAccess('ghu_synthetic_fixture', { fixtureId: fixture.id,
      readOnly: true, send: transport(change, denied) }));
    assert.equal(denied.some(call => call.method !== 'GET'), false);
  }
  for (const readOnly of ['true', 1, null]) {
    let dispatched = false;
    await assert.rejects(qualifyAccess('ghu_synthetic_fixture', { readOnly,
      send: async () => { dispatched = true; return reply({}); } }), /invalid-read-mode/);
    assert.equal(dispatched, false);
  }
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
    assert.equal(calls.filter(c => new URL(c.url).pathname.endsWith('/issues') && c.method === 'POST').length, 1);
    assert.equal(result.rows.filter(r => r.detail === 'write-result-uncertain').length, 1);
    assert.equal(receipts.length, result.rows.length);
    assert.equal(JSON.stringify(result).includes('DO_NOT_ECHO'), false);
  }
});
