import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { qualifyAccess, qualifySetup, qualifyRemaining, qualifyKnownProject, readSetupResources, awaitRevocation, continuations, fixtures } from './access.mjs';

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
      const { query, variables } = JSON.parse(options.body);
      if (query.includes('... on PullRequest')) {
        const f = targets.find(f => variables.id === `PR_${f.id}`);
        if (!f) throw new Error('Unexpected PR target');
        const merged = states.get(f.id).merged;
        return reply({ data: { node: { id: variables.id, number: 2, state: merged ? 'MERGED' : 'OPEN', merged,
          headRefOid: 'b'.repeat(40), repository: { id: f.node },
          mergeCommit: merged ? { oid: 'd'.repeat(40), repository: { id: f.node } } : null } } });
      }
      if (!change.projects) return reply({ errors: [{ type: 'FORBIDDEN', message: 'ghu_DO_NOT_ECHO' }] });
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
      merged: state.merged,
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
      return reply({ ...data, state: 'open', merged: false });
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

function remainingTransport(change = {}, calls = []) {
  const base = transport({}, calls), states = new Map(continuations.map(f => [f.id, { success: false, merged: false,
    label: !!f.control, body: f.control ? 'D-05 synthetic lost-acknowledgement test. No private data.' : '', asset: null }]));
  const bytes = Buffer.from('Pipeliner D-05 synthetic asset\n'), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const send = async (url, options) => {
    if (new URL(url).pathname === '/graphql' && JSON.parse(options.body).query.includes('... on PullRequest')) {
      const { variables } = JSON.parse(options.body);
      const f = continuations.find(f => [f.pull.node, f.control?.node ?? `PR_${f.id}_new`].includes(variables.id));
      if (!f) throw new Error('Unexpected remaining PR target');
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      const old = variables.id === f.pull.node, merged = old || states.get(f.id).merged;
      return reply({ data: { node: { id: variables.id, number: old ? 2 : 3, state: merged ? 'MERGED' : 'OPEN', merged,
        headRefOid: old ? f.pull.head : f.head, repository: { id: f.node },
        mergeCommit: merged ? { oid: old ? f.main : 'f'.repeat(40), repository: { id: f.node } } : null } } });
    }
    const path = new URL(url).pathname, f = continuations.find(f => path.startsWith(`/repos/${f.owner}/${f.name}`));
    if (!f) return base(url, options);
    calls.push({ url, method: options.method, body: options.body && !Buffer.isBuffer(options.body) ? JSON.parse(options.body) : null,
      authorization: options.headers.Authorization });
    const state = states.get(f.id), prefix = `/repos/${f.owner}/${f.name}`;
    const pull = () => ({ id: f.control?.id ?? f.id + 9, node_id: f.control?.node ?? `PR_${f.id}_new`, number: 3, state: state.merged ? 'closed' : 'open',
      merged: state.merged,
      body: 'D-05 synthetic PR — updated', head: { sha: change.head ?? f.head, ref: 'd05-26-controls', repo: { id: f.id, node_id: f.node } },
      base: { ref: 'main', repo: { id: f.id, node_id: f.node } } });
    if (path === `${prefix}/branches/main`) return reply({ name: 'main', protected: f.protected, commit: { sha: state.merged ? 'f'.repeat(40) : f.main } });
    if (path === `${prefix}/git/ref/heads/d05-26-controls`) return reply({ ref: 'refs/heads/d05-26-controls', object: { type: 'commit', sha: change.head ?? f.head } });
    if (path.includes('/compare/')) return reply({ status: 'ahead', ahead_by: 2, total_commits: 2,
      commits: [{ sha: f.oldHead }, { sha: f.head }], files: [{ filename: '.github/workflows/d05-controls.yml', status: 'added', sha: f.workflowBlob },
        { filename: 'd05-controls.txt', status: 'added', sha: f.controlBlob }] });
    if (path === `${prefix}/issues/1`) {
      if (options.method === 'PATCH') state.body = JSON.parse(options.body).body;
      return reply({ id: f.issue.id, node_id: f.issue.node, number: 1, state: 'open', title: 'D-05 synthetic Issue — updated', body: state.body,
        assignees: [{ login: 'brimdor' }], labels: [{ id: f.ready, name: 'Ready for Development' }, ...(state.label ? [{ id: f.control?.label ?? f.id + 10, name: 'd05-remaining' }] : [])] });
    }
    if (path === `${prefix}/issues/1/labels`) { state.label = true; return reply([]); }
    if (path === `${prefix}/labels/d05-remaining`) return reply({ id: change.labelId ?? f.control?.label, name: 'd05-remaining' });
    if (path === `${prefix}/labels` && options.method === 'GET') return reply([{ id: f.ready, name: 'Ready for Development' },
      ...(f.control ? [{ id: f.control.label, name: 'd05-remaining' }] : [])]);
    if (path === `${prefix}/labels`) return reply({ id: f.id + 10, name: 'd05-remaining' }, 201);
    if (path === `${prefix}/pulls/2`) return reply({ id: change.oldPullId ?? f.pull.id, node_id: f.pull.node, number: 2,
      state: 'closed', merged: true, head: { sha: f.pull.head, ref: 'd05-26-qualification', repo: { id: f.id, node_id: f.node } },
      base: { ref: 'main', repo: { id: f.id, node_id: f.node } } });
    if (path === `${prefix}/pulls` && options.method === 'GET') return reply(f.control ? [{ ...pull(), merged: undefined }] : []);
    if (path === `${prefix}/pulls`) return reply(pull(), 201);
    if (path === `${prefix}/pulls/3`) return reply(pull());
    if (path === `${prefix}/pulls/3/merge`) {
      if (!state.success) { assert.equal(f.protected, true); return reply({}, 405); }
      state.merged = true; return reply({ merged: true, sha: 'f'.repeat(40) });
    }
    if (path.endsWith('/status')) {
      const old = path.includes(f.oldHead), status = old ? 'failure' : state.success ? 'success' : 'pending';
      return reply({ sha: old ? f.oldHead : f.head, state: status, total_count: 1,
        statuses: [{ id: f.id + 11, context: 'pipeliner-d05/qualification', state: status }] });
    }
    if (path.endsWith('/check-runs')) return reply({ total_count: change.checkCount ?? 2, check_runs: [{ id: f.check, name: 'd05-smoke',
      head_sha: change.checkHead ?? f.head, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
    { id: change.extraId ?? f.id + 20, name: 'Existing security check', head_sha: change.extraHead ?? f.head,
      status: change.extraStatus ?? 'completed', conclusion: change.extraConclusion ?? 'success', app: { slug: 'gitguardian' } }] });
    if (path.endsWith('/actions/runs')) return reply({ total_count: 1, workflow_runs: [{ id: f.run, name: 'Pipeliner D-05 check fixture',
      head_sha: f.head, head_branch: 'd05-26-controls', event: 'push', status: 'completed', conclusion: 'success' }] });
    if (path === `${prefix}/releases` && options.method === 'GET') return reply([]);
    const release = () => ({ id: f.id + 12, node_id: `RE_${f.id}`, tag_name: 'd05-26-qualification', target_commitish: 'f'.repeat(40),
      draft: true, prerelease: true, assets: state.asset ? [state.asset] : [] });
    if (path === `${prefix}/releases`) return reply(release(), 201);
    if (path === `${prefix}/releases/${f.id + 12}/assets`) {
      if (state.asset) return reply({}, 422);
      state.asset = { id: f.id + 13, name: 'd05-qualification.txt', state: 'uploaded', size: bytes.length, digest };
      return reply(state.asset, 201);
    }
    if (path === `${prefix}/releases/${f.id + 12}`) return reply(release());
    if (path === `${prefix}/releases/assets/${f.id + 13}`) {
      if (change.redirect) return new Response(null, { status: 302, headers: { Location: change.redirect(f) } });
      return new Response(change.badDigest ? 'wrong bytes' : bytes);
    }
    if (path === prefix) return reply({ id: f.id, node_id: f.node, full_name: `${f.owner}/${f.name}`, private: true });
    throw new Error('Unexpected remaining route');
  };
  return { send, onResult(row) { if (row.operation === 'fixture-status-success-required') states.get(continuations.find(f => row.fixture === `${f.owner}/${f.name}`).id).success = true; } };
}

test('remaining App qualification reads exact completed effects, verifies Ready/checks and never replays writes', async () => {
  const calls = [], model = remainingTransport({}, calls);
  const result = await qualifyRemaining('ghu_synthetic_fixture', model);
  assert.equal(result.installations, 'passed');
  assert.equal(result.rows.filter(row => row.status === 'not-run').length, 1);
  for (const f of continuations) {
    const prefix = `/repos/${f.owner}/${f.name}`;
    assert.equal(calls.filter(call => new URL(call.url).pathname === `${prefix}/pulls/3/merge`).length, f.protected ? 2 : 1);
    assert.equal(calls.filter(call => new URL(call.url).pathname === `${prefix}/issues/1` && call.method === 'PATCH').length, f.control ? 0 : 1);
    assert.equal(calls.filter(call => new URL(call.url).pathname === `${prefix}/pulls` && call.method === 'POST').length, f.control ? 0 : 1);
    assert.equal(calls.filter(call => new URL(call.url).pathname === `${prefix}/pulls/2` && call.method !== 'GET').length, 0);
  }
  assert.equal(result.rows.filter(row => row.operation === 'lost-acknowledgement-reconciliation').every(row => row.detail.reconciled === true), true);
  assert.equal(result.rows.filter(row => row.operation === 'draft-asset-download').every(row => row.detail.downloadedDigest === row.detail.digest), true);
  assert.equal(result.rows.filter(row => row.operation === 'candidate-check-merge-readback').every(row => row.detail.readOnly === undefined), true);
});

test('remaining identity/check failure stops before unrelated writes and OAuth never enters App work', async () => {
  for (const change of [{ oldPullId: 7 }, { head: 'a'.repeat(40) }, { checkHead: 'a'.repeat(40) }]) {
    const calls = [], model = remainingTransport(change, calls);
    await assert.rejects(qualifyRemaining('ghu_synthetic_fixture', model), /readback-mismatch/);
    assert.equal(calls.some(call => call.method !== 'GET' && !call.body?.query?.startsWith('query(')), false);
  }
  await assert.rejects(qualifyRemaining('gho_synthetic_setup'), /app-token-required/);
});

test('REST 2026 merge verification binds the same GraphQL PR and rejects changed immutable receipts before writes', async () => {
  for (const changed of [
    node => { node.id = 'PR_other'; }, node => { node.number = 7; },
    node => { node.headRefOid = 'a'.repeat(40); }, node => { node.repository.id = 'R_other'; },
    node => { node.mergeCommit.oid = 'a'.repeat(40); }, node => { node.mergeCommit.repository.id = 'R_other'; },
    node => { delete node.mergeCommit; },
  ]) {
    const calls = [], model = remainingTransport({}, calls);
    let mergeReads = 0;
    await assert.rejects(qualifyRemaining('ghu_synthetic_fixture', { ...model, send: async (url, options) => {
      assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
      const response = await model.send(url, options);
      if (new URL(url).pathname !== '/graphql') return response;
      mergeReads++;
      const data = await response.json(); changed(data.data.node); return reply(data);
    } }), /readback-mismatch/);
    assert.equal(mergeReads, 1);
    assert.equal(calls.some(call => call.method !== 'GET' && !call.body?.query?.startsWith('query(')), false);
  }
});

test('complete check lists preserve existing integrations and deny pending, failed, foreign, duplicate or partial evidence', async () => {
  for (const change of [{ extraStatus: 'in_progress', extraConclusion: null }, { extraConclusion: 'failure' },
    { extraHead: 'a'.repeat(40) }, { extraId: continuations[0].check }, { checkCount: 3 }]) {
    const calls = [], model = remainingTransport(change, calls);
    await assert.rejects(qualifyRemaining('ghu_synthetic_fixture', model), /readback-mismatch/);
    assert.equal(calls.some(call => call.method !== 'GET' && !call.body?.query?.startsWith('query(')), false);
  }
});

test('a null GraphQL merge receipt retries reads only, and remains bounded when unavailable', async () => {
  for (const unavailable of [false, true]) {
    const calls = [], model = remainingTransport({}, calls);
    let reads = 0;
    const run = qualifyRemaining('ghu_synthetic_fixture', { ...model, send: async (url, options) => {
      const response = await model.send(url, options);
      if (new URL(url).pathname !== '/graphql' || JSON.parse(options.body).variables.id !== continuations[0].pull.node) return response;
      const data = await response.json(); reads++;
      if (unavailable || reads === 1) data.data.node.mergeCommit = null;
      return reply(data);
    } });
    if (unavailable) {
      await assert.rejects(run, /readback-mismatch/);
      assert.equal(reads, 5);
      assert.equal(calls.some(call => call.method !== 'GET' && !call.body?.query?.startsWith('query(')), false);
    } else { await run; assert.equal(reads, 2); }
  }
});

test('download follows only one exact GitHub asset redirect without forwarding credentials', async () => {
  const calls = [], model = remainingTransport({ redirect: f => `https://release-assets.githubusercontent.com/github-production-release-asset/${f.id}/synthetic?signed=DO_NOT_LOG` }, calls);
  const send = async (url, options) => {
    if (new URL(url).hostname === 'release-assets.githubusercontent.com') {
      assert.equal(options.headers.Authorization, undefined); assert.equal(options.redirect, 'error');
      return new Response('Pipeliner D-05 synthetic asset\n');
    }
    return model.send(url, options);
  };
  const result = await qualifyRemaining('ghu_synthetic_fixture', { ...model, send });
  assert.equal(result.rows.filter(row => row.operation === 'draft-asset-download').every(row => row.detail.redirected), true);
  assert.equal(JSON.stringify(result).includes('DO_NOT_LOG'), false);
  for (const change of [{ redirect: () => 'https://example.com/DO_NOT_LOG' }, { badDigest: true }]) {
    await assert.rejects(qualifyRemaining('ghu_synthetic_fixture', remainingTransport(change)), /asset-download-invalid/);
  }
});

test('revocation observes only authenticated access denial, never an arbitrary permission failure', async () => {
  let count = 0;
  const result = await awaitRevocation('ghu_synthetic_fixture', { wait: async () => {}, send: async (url, options) => {
    assert.equal(url, 'https://api.github.com/user'); assert.equal(options.method, 'GET');
    return count++ ? reply({}, 401) : reply({ id: 1202831, login: 'brimdor', node_id: fixtures[0].ownerNode, type: 'User' });
  } });
  assert.equal(result.accessDenied, true); assert.equal(count, 2);
  await assert.rejects(awaitRevocation('ghu_synthetic_fixture', { send: async () => reply({}, 403) }), /http-403/);
  await assert.rejects(awaitRevocation('ghp_unqualified'), /connection-token-required/);
});

test('known Project continuation changes only its exact status and rejects changed owner/schema/item before writes', async () => {
  const project = 'PVT_kwDOETTHSM4BlYox', item = 'PVTI_lADOETTHSM4BlYoxzg-AJuU', f = continuations[1];
  for (const change of [{}, { owner: 'wrong' }, { wrongOptions: true }, { absent: true }, { wrongRepository: true }]) {
    const calls = [], base = transport({}, calls);
    const choices = { Status: ['Backlog', 'In Progress', 'In Review', 'Pending Review', 'Done'], Priority: ['P0', 'P1', 'P2', 'P3'],
      Impact: ['High', 'Medium', 'Low'], Effort: ['XS', 'S', 'M', 'L', 'XL'] };
    const fields = Object.entries(choices).map(([name, names]) => ({ id: `field-${name}`, name,
      options: names.map(name => ({ id: `option-${name}`, name })) }));
    const values = { Status: 'In Progress', Priority: 'P0', Impact: 'High', Effort: 'L' };
    const connection = nodes => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });
    const send = async (url, options) => {
      if (url.endsWith(`/repos/${f.owner}/${f.name}/issues/1`)) return reply({ id: f.issue.id, node_id: f.issue.node, number: 1, state: 'open' });
      if (!url.endsWith('/graphql')) return base(url, options);
      const body = JSON.parse(options.body); calls.push({ method: options.method, body });
      if (body.query.includes('owner{')) return reply({ data: { node: { id: project, number: 8,
        title: 'Pipeliner D-05 #26 Organization Fixture', public: false, owner: { id: change.owner ?? f.ownerNode } } } });
      if (body.query.includes('fields(first:100')) return reply({ data: { node: { id: project,
        fields: connection(change.wrongOptions ? fields.map(field => ({ ...field, options: [] })) : fields) } } });
      if (body.query.includes('items(first:100')) return reply({ data: { node: { id: project, items: connection(change.absent ? [] : [{ id: item,
        content: { id: f.issue.node, number: 1, state: 'OPEN', repository: { id: change.wrongRepository ? 'wrong' : f.node } },
        fieldValues: connection(fields.map(field => ({ name: values[field.name], field: { id: field.id, name: field.name } }))) }]) } } });
      assert.equal(body.query.includes('updateProjectV2ItemFieldValue('), true);
      assert.equal(body.variables.project, project); assert.equal(body.variables.item, item); assert.equal(body.variables.field, 'field-Status');
      values.Status = body.variables.option.slice('option-'.length);
      return reply({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item } } } });
    };
    if (Object.keys(change).length) {
      await assert.rejects(qualifyKnownProject('ghu_synthetic_fixture', { send }));
      assert.equal(calls.some(call => call.body?.query?.startsWith('mutation(')), false);
    } else {
      const result = await qualifyKnownProject('ghu_synthetic_fixture', { send });
      assert.deepEqual(result.statuses, ['In Progress', 'In Review', 'Pending Review', 'In Progress']);
      assert.equal(calls.filter(call => call.body?.query?.startsWith('mutation(')).length, 3);
    }
  }
});

test('setup revocation preflight reads only its exact created resources and rejects changed identity', async () => {
  for (const changed of [false, true]) {
    let writes = 0;
    const send = async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer gho_synthetic_setup');
      const path = new URL(url).pathname;
      if (options.method !== 'GET') {
        const body = JSON.parse(options.body); assert.equal(body.query.startsWith('query('), true);
        if (!body.query.startsWith('query(')) writes++;
        const personal = body.variables.owner === fixtures[0].ownerNode;
        return reply({ data: { node: { id: body.variables.owner, projectsV2: { totalCount: 1,
          nodes: [{ id: personal ? 'PVT_kwHOABJaj84BlZGv' : 'PVT_kwDOETTHSM4BlZGz', public: false,
            title: `Pipeliner D-05 #26 OAuth ${personal ? 'Personal' : 'Organization'} Fixture` }],
          pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      if (path === '/user') return reply({ id: 1202831, login: 'brimdor', node_id: fixtures[0].ownerNode, type: 'User' });
      if (path === '/orgs/Zuriel-Labs') return reply({ login: 'Zuriel-Labs', node_id: fixtures[1].ownerNode, type: 'Organization' });
      const personal = path.includes('/brimdor/');
      if (path.endsWith('/issues/1')) return reply({ id: personal ? 5670334810 : 5670566543,
        node_id: personal ? 'I_kwDOU36G9M8AAAABUfpxWg' : 'I_kwDOU37Lsc8AAAABUf36jw', number: 1, state: 'open', title: 'D-05 synthetic setup Issue' });
      return reply({ id: changed ? 7 : personal ? 1400801012 : 1400818609, node_id: personal ? 'R_kgDOU36G9A' : 'R_kgDOU37LsQ',
        full_name: personal ? 'brimdor/pipeliner-d05-26-oauth-personal' : 'Zuriel-Labs/pipeliner-d05-26-oauth-org', private: true });
    };
    if (changed) await assert.rejects(readSetupResources('gho_synthetic_setup', { send }), /repository-mismatch/);
    else assert.deepEqual(await readSetupResources('gho_synthetic_setup', { send }), { resources: 2, readOnly: true });
    assert.equal(writes, 0);
  }
});
