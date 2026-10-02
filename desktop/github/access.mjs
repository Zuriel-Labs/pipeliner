import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { collectConnection } from '../../scripts/lib/project.mjs';
import { planOperation, readProject } from './operations.mjs';
import { makeRequest, appPermissions } from './transport.mjs';
export { appPermissions } from './transport.mjs';

// Qualification scope only; these fixtures were explicitly designated by the PM.
export const fixtures = Object.freeze([
  Object.freeze({ owner: 'brimdor', ownerNode: 'MDQ6VXNlcjEyMDI4MzE=', type: 'User', name: 'pipeliner-d05-26-personal', id: 1399877876, node: 'R_kgDOU3Bw9A',
    issue: Object.freeze({ number: 1, id: 5668446817, node: 'I_kwDOU3Bw9M8AAAABUd2iYQ' }) }),
  Object.freeze({ owner: 'Zuriel-Labs', ownerNode: 'O_kgDOETTHSA', type: 'Organization', name: 'pipeliner-d05-26-org', id: 1399878351, node: 'R_kgDOU3Byzw' }),
]);
// Existing selected repository is installation evidence only; never an operation target.
const existingSelection = Object.freeze({ id: 1363240768, node: 'R_kgDOUUFnQA', owner: 'Zuriel-Labs', name: 'pipeliner', private: false });
const matchesRepository = (actual, expected) => actual?.id === expected.id && actual.node_id === expected.node &&
  actual.full_name === `${expected.owner}/${expected.name}` && actual.private === (expected.private ?? true);
const matchesAccount = account => account?.login === 'brimdor' && account.id === 1202831 &&
  account.node_id === fixtures[0].ownerNode && account.type === 'User';
const projectDefinitions = [
  { name: 'Status', choices: ['Backlog', 'In Progress', 'In Review', 'Pending Review', 'Done'], value: 'In Progress' },
  { name: 'Priority', choices: ['P0', 'P1', 'P2', 'P3'], value: 'P0' },
  { name: 'Impact', choices: ['High', 'Medium', 'Low'], value: 'High' },
  { name: 'Effort', choices: ['XS', 'S', 'M', 'L', 'XL'], value: 'L' },
];
const safeError = error => /^(http-\d{3}|graphql-(forbidden|rejected|insufficient-scopes|validation|not-found)|readback-mismatch|write-result-uncertain|response-invalid|response-too-large|cancelled|read-failed|fixture-collision|dependency-unqualified)$/.test(error?.message)
  ? error.message : 'qualification-failed';

export const setupTargets = Object.freeze(fixtures.map(fixture => Object.freeze({
  owner: fixture.owner, ownerNode: fixture.ownerNode, type: fixture.type,
  name: fixture.type === 'User' ? 'pipeliner-d05-26-oauth-personal' : 'pipeliner-d05-26-oauth-org',
  title: `Pipeliner D-05 #26 OAuth ${fixture.type === 'User' ? 'Personal' : 'Organization'} Fixture`,
  ...(fixture.type === 'User' ? { existing: Object.freeze({ id: 1400801012, node: 'R_kgDOU36G9A',
    issue: Object.freeze({ number: 1, id: 5670334810, node: 'I_kwDOU36G9M8AAAABUfpxWg' }) }) } : {}),
})));
const setupToken = token => typeof token === 'string' && /^gho_[A-Za-z0-9_]{8,200}$/.test(token);

// Separate trusted setup entry point. Repository/Git worker entry points require App tokens.
export async function qualifySetup(accessToken, { send = fetch, signal, onResult } = {}) {
  if (!setupToken(accessToken)) throw new Error('setup-token-required');
  const request = makeRequest(accessToken, send, signal);
  const account = await request('GET', '/user');
  if (!matchesAccount(account)) throw new Error('account-mismatch');
  await verifySetupOrganization(request);
  for (const target of setupTargets) {
    let repositories, projects;
    for (const collection of ['repositories', 'projectsV2']) {
      try {
        const values = await readOwnerCollection(request, target, collection);
        if (collection === 'repositories') repositories = values; else projects = values;
      } catch (error) {
        onResult?.({ fixture: `${target.owner}/${target.name}`, operation: `${collection}-discovery`,
          status: 'failed', detail: { code: safeError(error), fields: error.fields ?? [] } });
        throw error;
      }
    }
    const named = repositories.filter(repository => repository.nameWithOwner === `${target.owner}/${target.name}`);
    if ((target.existing ? named.length !== 1 || named[0].id !== target.existing.node || named[0].isPrivate !== true : named.length !== 0) ||
      projects.some(project => project.title === target.title)) throw new Error('fixture-collision');
    let absent = false;
    try {
      const actual = await request('GET', `/repos/${target.owner}/${target.name}`);
      if (target.existing && !matchesRepository(actual, { ...target, ...target.existing })) throw new Error('repository-mismatch');
    }
    catch (error) { if (error.message !== 'http-404') throw error; absent = true; }
    if (absent === Boolean(target.existing)) throw new Error('fixture-collision');
  }
  const rows = [], owned = [];
  const confirm = (read, identity, matches) => confirmRead(read, identity, matches, signal);
  async function record(target, operation, action) {
    const started = performance.now();
    try {
      const detail = await action();
      const row = { fixture: `${target.owner}/${target.name}`, operation, status: 'passed', detail,
        milliseconds: performance.now() - started };
      rows.push(row); onResult?.(row); return detail;
    } catch (error) {
      onResult?.({ fixture: `${target.owner}/${target.name}`, operation, status: 'failed', detail: safeError(error),
        milliseconds: performance.now() - started });
      throw new Error(safeError(error));
    }
  }
  for (const target of setupTargets) {
    const prefix = `/repos/${target.owner}/${target.name}`;
    const fixture = await record(target, target.existing ? 'owned-repository-readback' : 'repository-create-readback', async () => {
      if (target.existing) {
        const fixture = { ...target, ...target.existing };
        if (!matchesRepository(await request('GET', prefix), fixture)) throw new Error('repository-mismatch');
        return fixture;
      }
      const created = await request('POST', target.type === 'User' ? '/user/repos' : `/orgs/${target.owner}/repos`, {
        name: target.name, private: true, auto_init: true,
        description: 'Disposable synthetic OAuth qualification fixture for Pipeliner Issue #26 (D-05); remove after qualification.',
      });
      if (!Number.isSafeInteger(created.id) || created.id < 1 || typeof created.node_id !== 'string' ||
        !/^R_[A-Za-z0-9_-]+$/.test(created.node_id) || created.full_name !== `${target.owner}/${target.name}` ||
        created.private !== true) throw new Error('readback-mismatch');
      const fixture = { ...target, id: created.id, node: created.node_id };
      onResult?.({ fixture: `${target.owner}/${target.name}`, operation: 'repository-created', status: 'passed',
        detail: { id: created.id, node: created.node_id, private: true } });
      const actual = await request('GET', prefix);
      if (!matchesRepository(actual, fixture)) throw new Error('readback-mismatch');
      return fixture;
    });
    const issue = await record(target, 'setup-issue-readback', async () => {
      const issue = fixture.issue ? await request('GET', `${prefix}/issues/${fixture.issue.number}`)
        : await request('POST', `${prefix}/issues`, { title: 'D-05 synthetic setup Issue',
          body: 'Task-owned OAuth Project linkage fixture for Pipeliner Issue #26. No product or private data.', assignees: ['brimdor'] });
      if (!Number.isSafeInteger(issue.id) || issue.id < 1 || !Number.isSafeInteger(issue.number) || issue.number < 1 ||
        typeof issue.node_id !== 'string' || !/^I_[A-Za-z0-9_-]+$/.test(issue.node_id)) throw new Error('readback-mismatch');
      if (fixture.issue && (issue.id !== fixture.issue.id || issue.number !== fixture.issue.number ||
        issue.node_id !== fixture.issue.node || issue.title !== 'D-05 synthetic setup Issue')) throw new Error('readback-mismatch');
      const actual = await request('GET', `${prefix}/issues/${issue.number}`);
      if (actual.id !== issue.id || actual.node_id !== issue.node_id || actual.number !== issue.number || actual.state !== 'open' ||
        !Array.isArray(actual.assignees) || actual.assignees.length !== 1 || actual.assignees[0].login !== 'brimdor') throw new Error('readback-mismatch');
      return { id: actual.id, number: actual.number, node_id: actual.node_id };
    });
    const project = await record(target, 'project-create-fields-status-readback', () =>
      setupProject(request, fixture, issue, target.title, onResult, confirm));
    owned.push({ fixture: { ...fixture, issue: { id: issue.id, node: issue.node_id, number: issue.number } }, project });
  }
  return { setup: 'passed', rows, async verify(token) {
    if (!setupToken(token)) throw new Error('setup-token-required');
    return verifySetupOwned(token, owned, send, signal);
  } };
}

export async function readSetupResources(token, { send = fetch, signal } = {}) {
  if (!setupToken(token)) throw new Error('setup-token-required');
  return verifySetupOwned(token, [
    { fixture: { ...setupTargets[0], ...setupTargets[0].existing }, project: { id: 'PVT_kwHOABJaj84BlZGv' } },
    { fixture: { ...setupTargets[1], id: 1400818609, node: 'R_kgDOU37LsQ',
      issue: { number: 1, id: 5670566543, node: 'I_kwDOU37Lsc8AAAABUf36jw' } }, project: { id: 'PVT_kwDOETTHSM4BlZGz' } },
  ], send, signal);
}

async function verifySetupOwned(token, owned, send, signal) {
  const read = makeRequest(token, send, signal);
  if (!matchesAccount(await read('GET', '/user'))) throw new Error('account-mismatch');
  await verifySetupOrganization(read);
  for (const { fixture, project } of owned) {
    const prefix = `/repos/${fixture.owner}/${fixture.name}`;
    if (!matchesRepository(await read('GET', prefix), fixture)) throw new Error('repository-mismatch');
    const issue = await read('GET', `${prefix}/issues/${fixture.issue.number}`);
    if (issue.id !== fixture.issue.id || issue.node_id !== fixture.issue.node || issue.number !== fixture.issue.number ||
      issue.state !== 'open' || issue.title !== 'D-05 synthetic setup Issue') throw new Error('readback-mismatch');
    const projects = await readOwnerCollection(read, fixture, 'projectsV2');
    if (projects.filter(actual => actual.id === project.id && actual.title === fixture.title && actual.public === false).length !== 1) throw new Error('readback-mismatch');
  }
  return { resources: owned.length, readOnly: true };
}

async function verifySetupOrganization(request) {
  const organization = await request('GET', '/orgs/Zuriel-Labs');
  if (organization.node_id !== fixtures[1].ownerNode || organization.login !== fixtures[1].owner ||
    organization.type !== 'Organization') throw new Error('readback-mismatch');
}

async function readOwnerCollection(request, target, collection) {
  const values = await collectConnection(async cursor => {
    const data = await request('POST', '/graphql', { query:
      `query($owner:ID!,$cursor:String){node(id:$owner){... on ${target.type}{id ${collection}(first:100,after:$cursor${collection === 'repositories' ? ',ownerAffiliations:[OWNER]' : ''}){totalCount nodes{${collection === 'projectsV2' ? 'id title public' : 'id nameWithOwner isPrivate'}} pageInfo{hasNextPage endCursor}}}}}`,
      variables: { owner: target.ownerNode, cursor } });
    if (data.data?.node?.id !== target.ownerNode) throw new Error('readback-mismatch');
    return data.data.node[collection];
  }).catch(error => {
    if (/^(incomplete Project connection|Project connection changed during pagination; retry audit|unreadable Project node|duplicate Project node during pagination|incomplete or inconsistent Project connection|invalid or repeated pagination cursor)$/.test(error.message)) {
      throw new Error('incomplete-list');
    }
    throw error;
  });
  if (values.some(value => collection === 'projectsV2'
    ? typeof value.title !== 'string' || !value.title || typeof value.public !== 'boolean'
    : typeof value.nameWithOwner !== 'string' || !value.nameWithOwner.startsWith(`${target.owner}/`) ||
      typeof value.isPrivate !== 'boolean')) throw new Error('response-invalid');
  return values;
}

export async function qualifyAccess(accessToken, { fixtureId, readOnly = false, send = fetch, signal, onResult } = {}) {
  if (typeof accessToken !== 'string' || !/^ghu_[A-Za-z0-9_]{8,200}$/.test(accessToken)) throw new Error('app-token-required');
  if (typeof readOnly !== 'boolean') throw new Error('invalid-read-mode');
  const selectedFixtures = fixtureId === undefined ? fixtures : fixtures.filter(fixture => fixture.id === fixtureId);
  if (!selectedFixtures.length) throw new Error('fixture-not-approved');
  const rows = [];
  const request = makeRequest(accessToken, send, signal);
  async function list(path, key) {
    const values = [];
    let total;
    for (let page = 1; page <= 100; page++) {
      const data = await request('GET', `${path}?per_page=100&page=${page}`);
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
        !Array.isArray(data[key]) || data[key].length > 100 || (total !== undefined && total !== data.total_count)) throw new Error('incomplete-list');
      total = data.total_count;
      values.push(...data[key]);
      if (values.some(v => !Number.isSafeInteger(v.id) || v.id < 1) || new Set(values.map(v => v.id)).size !== values.length ||
        values.length > total) throw new Error('incomplete-list');
      if (values.length === total) return values;
      if (data[key].length !== 100) throw new Error('incomplete-list');
    }
    throw new Error('incomplete-list');
  }
  const confirm = (read, identity, matches) => confirmRead(read, identity, matches, signal);
  if (!matchesAccount(await request('GET', '/user'))) throw new Error('account-mismatch');
  const installations = (await list('/user/installations', 'installations')).filter(i => i.app_id === 5148613);
  if (installations.length < selectedFixtures.length || installations.length > fixtures.length ||
    new Set(installations.map(i => i.account?.login)).size !== installations.length) throw new Error('installation-mismatch');
  for (const installation of installations) {
    const fixture = fixtures.find(f => f.owner === installation.account?.login && f.type === installation.account.type);
    if (!fixture) throw new Error('installation-mismatch');
    const expected = fixture.type === 'User' ? Object.fromEntries(Object.entries(appPermissions).filter(([key]) => key !== 'organization_projects')) : appPermissions;
    if (installation.repository_selection !== 'selected' ||
      !(isDeepStrictEqual(installation.permissions, expected) || isDeepStrictEqual(installation.permissions, appPermissions))) throw new Error('installation-mismatch');
  }
  for (const fixture of selectedFixtures) {
    const installation = installations.find(i => i.account.login === fixture.owner && i.account.type === fixture.type);
    if (!installation) throw new Error('installation-mismatch');
    const repositories = await list(`/user/installations/${installation.id}/repositories`, 'repositories');
    const selected = repositories.some(repository => matchesRepository(repository, fixture)) &&
      repositories.every(repository => matchesRepository(repository, fixture) ||
        (fixture.type === 'Organization' && matchesRepository(repository, existingSelection)));
    const repository = selected ? await request('GET', `/repos/${fixture.owner}/${fixture.name}`)
      : repositories.find(repository => repository.id === fixture.id) ?? repositories[0];
    if (!selected || !matchesRepository(repository, fixture)) {
      onResult?.({ fixture: `${fixture.owner}/${fixture.name}`, operation: 'repository-binding', status: 'failed', detail: {
        count: repositories.length, idMatches: repository?.id === fixture.id, nodeMatches: repository?.node_id === fixture.node,
        pathMatches: repository?.full_name === `${fixture.owner}/${fixture.name}`, privateMatches: repository?.private === true,
      } });
      throw new Error('repository-mismatch');
    }
  }
  if (readOnly) return { installations: 'passed', rows };
  async function record(fixture, operation, action) {
    const started = performance.now();
    try {
      const detail = await action();
      rows.push({ fixture: `${fixture.owner}/${fixture.name}`, operation,
        status: detail?.unexpectedCreation ? 'failed' : 'passed', detail, milliseconds: performance.now() - started });
    }
    catch (error) { rows.push({ fixture: `${fixture.owner}/${fixture.name}`, operation,
      status: /^(http-(401|403|404)|graphql-forbidden)$/.test(error?.message) ? 'blocked' : 'failed',
      detail: safeError(error), milliseconds: performance.now() - started }); }
    onResult?.(rows.at(-1));
  }
  for (const fixture of selectedFixtures) {
    const prefix = `/repos/${fixture.owner}/${fixture.name}`;
    let fixtureIssue, mergedHead, projectAbsent = false;
    await record(fixture, 'issue-create-edit-assignment-readback', async () => {
      const issue = fixture.issue ? await request('GET', `${prefix}/issues/${fixture.issue.number}`)
        : await request('POST', `${prefix}/issues`, { title: 'D-05 synthetic Issue',
          body: 'Task-owned qualification fixture for Pipeliner Issue #26. No product or private data.', assignees: ['brimdor'] });
      if (!Number.isSafeInteger(issue.number) || issue.number < 1 || !Number.isSafeInteger(issue.id) || typeof issue.node_id !== 'string') throw new Error('readback-mismatch');
      if (fixture.issue && (issue.number !== fixture.issue.number || issue.id !== fixture.issue.id ||
        issue.node_id !== fixture.issue.node || issue.title !== 'D-05 synthetic Issue — updated')) throw new Error('readback-mismatch');
      await request('PATCH', `${prefix}/issues/${issue.number}`, { title: 'D-05 synthetic Issue — updated' });
      const actual = await request('GET', `${prefix}/issues/${issue.number}`);
      if (actual.id !== issue.id || actual.node_id !== issue.node_id || actual.number !== issue.number ||
        actual.title !== 'D-05 synthetic Issue — updated' || actual.state !== 'open' ||
        !Array.isArray(actual.assignees) || actual.assignees.length !== 1 || actual.assignees[0].login !== 'brimdor') throw new Error('readback-mismatch');
      fixtureIssue = actual;
      return { number: issue.number, id: issue.id, node: issue.node_id, reused: Boolean(fixture.issue) };
    });
    await record(fixture, 'labels-create-edit-readback', async () => {
      if (!fixtureIssue) throw new Error('dependency-unqualified');
      const labels = await request('GET', `${prefix}/labels?per_page=100`);
      if (!Array.isArray(labels) || labels.length >= 100) throw new Error('response-invalid');
      if (labels.some(label => label.name === 'd05-qualification')) throw new Error('fixture-collision');
      const before = await request('GET', `${prefix}/issues/${fixtureIssue.number}`);
      if (before.id !== fixtureIssue.id || !Array.isArray(before.labels)) throw new Error('readback-mismatch');
      await request('POST', `${prefix}/labels`, { name: 'd05-qualification', color: '82d3c1', description: 'Task-owned D-05 fixture' });
      await request('PATCH', `${prefix}/labels/d05-qualification`, { description: 'Task-owned D-05 fixture — updated' });
      const label = await request('GET', `${prefix}/labels/d05-qualification`);
      if (label.name !== 'd05-qualification' || label.description !== 'Task-owned D-05 fixture — updated') throw new Error('readback-mismatch');
      await request('POST', `${prefix}/issues/${fixtureIssue.number}/labels`, { labels: ['d05-qualification'] });
      const actual = await request('GET', `${prefix}/issues/${fixtureIssue.number}`);
      if (actual.id !== fixtureIssue.id || !Array.isArray(actual.labels) ||
        !actual.labels.some(label => label.name === 'd05-qualification') ||
        (before.labels.some(label => label.name === 'Ready for Development') &&
          !actual.labels.some(label => label.name === 'Ready for Development'))) throw new Error('readback-mismatch');
      const protectedLabelPresent = before.labels.some(label => label.name === 'Ready for Development');
      return { ordinaryLabel: 'passed', protectedLabelPresent, protectedLabelPreserved: protectedLabelPresent ? true : null };
    });
    await record(fixture, 'branch-pr-check-merge-readback', async () => {
      const matches = await request('GET', `${prefix}/git/matching-refs/heads/d05-26-qualification`);
      if (!Array.isArray(matches)) throw new Error('response-invalid');
      if (matches.length) throw new Error('fixture-collision');
      const main = await request('GET', `${prefix}/git/ref/heads/main`);
      if (main.ref !== 'refs/heads/main' || main.object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(main.object.sha)) throw new Error('readback-mismatch');
      const branch = await request('POST', `${prefix}/git/refs`, { ref: 'refs/heads/d05-26-qualification', sha: main.object.sha });
      if (branch.ref !== 'refs/heads/d05-26-qualification' || branch.object?.sha !== main.object.sha) throw new Error('readback-mismatch');
      const content = await request('PUT', `${prefix}/contents/d05-qualification.txt`, { message: 'D-05 synthetic fixture content',
        branch: 'd05-26-qualification', content: Buffer.from('Pipeliner D-05 synthetic content\n').toString('base64') });
      const head = content.commit?.sha;
      if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(content.content?.sha)) throw new Error('readback-mismatch');
      const pull = await request('POST', `${prefix}/pulls`, { title: 'D-05 synthetic fixture PR',
        head: 'd05-26-qualification', base: 'main', body: 'Task-owned qualification fixture for Pipeliner Issue #26.' });
      if (!Number.isSafeInteger(pull.number) || pull.number < 1 || !Number.isSafeInteger(pull.id) || typeof pull.node_id !== 'string') throw new Error('readback-mismatch');
      const actual = await request('GET', `${prefix}/pulls/${pull.number}`);
      if (actual.id !== pull.id || actual.node_id !== pull.node_id || actual.number !== pull.number || actual.state !== 'open' ||
        actual.head?.sha !== head || actual.head.ref !== 'd05-26-qualification' || actual.head.repo?.id !== fixture.id ||
        actual.head.repo.node_id !== fixture.node || actual.base?.ref !== 'main' || actual.base.repo?.id !== fixture.id ||
        actual.base.repo.node_id !== fixture.node) throw new Error('readback-mismatch');
      const checks = await list(`${prefix}/commits/${head}/check-runs`, 'check_runs');
      const status = await request('GET', `${prefix}/commits/${head}/status?per_page=100`);
      if (checks.some(check => check.head_sha !== head) || status.sha !== head || !Array.isArray(status.statuses) ||
        status.total_count !== status.statuses.length || status.statuses.length >= 100) throw new Error('readback-mismatch');
      // Only this disposable fixture merge is authorized. GitHub enforces its own branch rules.
      const merge = await request('PUT', `${prefix}/pulls/${pull.number}/merge`, { sha: head, merge_method: 'squash' });
      if (merge.merged !== true || !/^[0-9a-f]{40}$/.test(merge.sha)) throw new Error('readback-mismatch');
      await readMergedPull(request, fixture, { number: pull.number, id: pull.id, node: pull.node_id,
        head, ref: 'd05-26-qualification' }, merge.sha, signal);
      mergedHead = merge.sha;
      return { number: pull.number, id: pull.id, node: pull.node_id, head, merge: merge.sha,
        checkCount: checks.length, statusCount: status.statuses.length };
    });
    await record(fixture, 'release-asset-readback', async () => {
      if (!mergedHead) throw new Error('dependency-unqualified');
      const releases = await request('GET', `${prefix}/releases?per_page=100`);
      if (!Array.isArray(releases) || releases.length >= 100) throw new Error('response-invalid');
      if (releases.some(release => release.tag_name === 'd05-26-qualification')) throw new Error('fixture-collision');
      const release = await request('POST', `${prefix}/releases`, { tag_name: 'd05-26-qualification',
        target_commitish: mergedHead, name: 'D-05 synthetic fixture release', draft: true, prerelease: true });
      if (!Number.isSafeInteger(release.id) || release.id < 1 || typeof release.node_id !== 'string' ||
        release.tag_name !== 'd05-26-qualification' || release.target_commitish !== mergedHead ||
        release.draft !== true || release.prerelease !== true) throw new Error('readback-mismatch');
      const bytes = Buffer.from('Pipeliner D-05 synthetic asset\n');
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const asset = await request('POST', `${prefix}/releases/${release.id}/assets?name=d05-qualification.txt`, bytes, true);
      if (!Number.isSafeInteger(asset.id) || asset.id < 1 || asset.name !== 'd05-qualification.txt' ||
        asset.size !== bytes.length || asset.digest !== digest) throw new Error('readback-mismatch');
      const actual = await request('GET', `${prefix}/releases/${release.id}`);
      if (actual.id !== release.id || actual.node_id !== release.node_id || actual.tag_name !== release.tag_name ||
        actual.target_commitish !== mergedHead || actual.draft !== true || !Array.isArray(actual.assets) ||
        actual.assets.length !== 1 || actual.assets[0].id !== asset.id || actual.assets[0].digest !== digest) throw new Error('readback-mismatch');
      return { id: release.id, node: release.node_id, assetId: asset.id, digest, draft: true };
    });
    await record(fixture, 'repository-creation', async () => {
      const created = await request('POST', fixture.type === 'User' ? '/user/repos' : `/orgs/${fixture.owner}/repos`,
        { name: fixture.name, private: true, description: 'Disposable Pipeliner D-05 qualification fixture' });
      // The designated name already exists. An unexpected creation is retained for reconciliation, never silently adopted.
      if (!Number.isSafeInteger(created.id) || created.full_name !== `${fixture.owner}/${fixture.name}` || created.private !== true) throw new Error('readback-mismatch');
      return { unexpectedCreation: true, id: created.id, node: created.node_id };
    });
    await record(fixture, 'projects-access', async () => {
      const kind = fixture.type === 'User' ? 'user' : 'organization';
      const projects = await collectConnection(async cursor => {
        const data = await request('POST', '/graphql', { query:
          `query($login:String!,$cursor:String){${kind}(login:$login){id login projectsV2(first:100,after:$cursor){totalCount nodes{id title public} pageInfo{hasNextPage endCursor}}}}`,
          variables: { login: fixture.owner, cursor } });
        if (data.data?.[kind]?.login !== fixture.owner || data.data[kind].id !== fixture.ownerNode) throw new Error('readback-mismatch');
        return data.data[kind].projectsV2;
      });
      const title = `Pipeliner D-05 #26 ${fixture.type === 'User' ? 'Personal' : 'Organization'} Fixture`;
      projectAbsent = !projects.some(p => p.title === title);
      return { count: projects.length, fixtureCollision: !projectAbsent };
    });
    await record(fixture, 'project-create-fields-status-readback', async () => {
      if (!fixtureIssue || !projectAbsent) throw new Error('dependency-unqualified');
      const title = `Pipeliner D-05 #26 ${fixture.type === 'User' ? 'Personal' : 'Organization'} Fixture`;
      return setupProject(request, fixture, fixtureIssue, title, onResult, confirm);
    });
  }
  return { installations: 'passed', rows, limitations: [
    'Repository creation at an existing fixture name cannot prove successful creation; HTTP 422 is inconclusive.',
    'Each Project row reports actual setup access. PM Ready origin, required-check execution, protected-branch denial, release download/publication, revocation and full native product integration remain separately qualified. Git transport has separate native receipts.',
    'Uncertain writes require reconciliation before a later attempt; this function never retries them.',
  ] };
}

// Exact owned effects/preparation captured on Issue #26. No name-based adoption or product configuration.
export const continuations = Object.freeze([
  Object.freeze({ ...fixtures[0], main: '19239b455c2c09aa7809bbbdac98e9764ba3f13c',
    oldHead: '3ac24b1f1afd2477e60846ee7b5a20c2f8b800b3', head: 'cde8264ed2f436748ec244ed626776595007fb81',
    check: 110636008869, run: 36942183342, ready: 12501706410, protected: false,
    control: Object.freeze({ id: 4711215755, node: 'PR_kwDOU3Bw9M8AAAABGM9yiw', number: 3, label: 12501999457 }),
    workflowBlob: '0651bdcef4ee29938a0ca90eea3853b56f45dfdf', controlBlob: '5ffa4a1a69be64a8c1365f04fe7c0304c0ccdc99',
    pull: Object.freeze({ id: 4709916793, node: 'PR_kwDOU3Bw9M8AAAABGLugeQ', head: 'c64f4cc6f91102761edaf5ab501e4d00a7e80ac5' }) }),
  Object.freeze({ ...fixtures[1], issue: Object.freeze({ number: 1, id: 5669527454, node: 'I_kwDOU3Byz88AAAABUe4fng' }),
    main: '29e99c819595660ca3f653d8425165acab40088c', oldHead: '7ed2cc766ec8484aead11f4dc75f7a011647ff64',
    head: '09803b3e23e6581d248fca7fa889e88433c491f4', check: 110636022290, run: 36942187279, ready: 12501706864, protected: true,
    workflowBlob: '0651bdcef4ee29938a0ca90eea3853b56f45dfdf', controlBlob: '5ffa4a1a69be64a8c1365f04fe7c0304c0ccdc99',
    pull: Object.freeze({ id: 4709919531, node: 'PR_kwDOU3Byz88AAAABGLurKw', head: '10323df3c3630a485ab227ae0ff84da9b779526b' }) }),
]);

export async function qualifyRemaining(accessToken, { send = fetch, signal, onResult } = {}) {
  await qualifyAccess(accessToken, { readOnly: true, send, signal });
  const request = makeRequest(accessToken, send, signal), rows = [];
  const issueMatches = (actual, f) => actual.id === f.issue.id && actual.node_id === f.issue.node && actual.number === 1 &&
    actual.title === 'D-05 synthetic Issue — updated' && actual.state === 'open' && actual.assignees?.length === 1 &&
    actual.assignees[0].login === 'brimdor' && Array.isArray(actual.labels) && actual.labels.length < 50 &&
    actual.labels.filter(label => label.id === f.ready && label.name === 'Ready for Development').length === 1;
  const pullMatches = (actual, f, number, id, node, head) => actual.number === number && actual.id === id && actual.node_id === node &&
    actual.head?.sha === head && actual.head.ref === (number === 2 ? 'd05-26-qualification' : 'd05-26-controls') &&
    actual.head.repo?.id === f.id && actual.head.repo.node_id === f.node && actual.base?.ref === 'main' &&
    actual.base.repo?.id === f.id && actual.base.repo.node_id === f.node;
  const status = async (f, head, read = request) => {
    const actual = await read('GET', `/repos/${f.owner}/${f.name}/commits/${head}/status?per_page=100`);
    if (actual.sha !== head || actual.total_count !== 1 || actual.statuses?.length !== 1 ||
      actual.statuses[0].context !== 'pipeliner-d05/qualification' || !Number.isSafeInteger(actual.statuses[0].id) ||
      !['failure', 'pending', 'success'].includes(actual.state) || actual.statuses[0].state !== actual.state) throw new Error('readback-mismatch');
    return actual.state;
  };
  const checks = async f => {
    const prefix = `/repos/${f.owner}/${f.name}`;
    const data = await request('GET', `${prefix}/commits/${f.head}/check-runs?per_page=100`);
    const runs = await request('GET', `${prefix}/actions/runs?head_sha=${f.head}&per_page=100`);
    const check = data.check_runs?.find(value => value.id === f.check), run = runs.workflow_runs?.[0];
    if (!Array.isArray(data.check_runs) || data.total_count !== data.check_runs.length || data.total_count < 1 || data.total_count >= 100 ||
      new Set(data.check_runs.map(value => value.id)).size !== data.total_count || data.check_runs.some(value =>
        !Number.isSafeInteger(value.id) || value.id < 1 || value.head_sha !== f.head || value.status !== 'completed' || value.conclusion !== 'success') ||
      data.check_runs.filter(value => value.id === f.check).length !== 1 || check.name !== 'd05-smoke' ||
      check.head_sha !== f.head || check.status !== 'completed' || check.conclusion !== 'success' || check.app?.slug !== 'github-actions' ||
      runs.total_count !== 1 || runs.workflow_runs?.length !== 1 || run?.id !== f.run || run.name !== 'Pipeliner D-05 check fixture' ||
      run.head_sha !== f.head || run.head_branch !== 'd05-26-controls' || run.event !== 'push' || run.status !== 'completed' ||
      run.conclusion !== 'success') throw new Error('readback-mismatch');
    return { head: f.head, check: check.id, checks: data.check_runs.map(value => value.id), workflowRun: run.id, conclusion: 'success' };
  };
  const record = async (f, operation, action) => {
    const started = performance.now();
    try {
      const detail = await action(), row = { fixture: `${f.owner}/${f.name}`, operation, status: 'passed', detail, milliseconds: performance.now() - started };
      rows.push(row); onResult?.(row); return detail;
    } catch (error) {
      onResult?.({ fixture: `${f.owner}/${f.name}`, operation, status: 'failed', detail: error.message === 'asset-download-invalid'
        ? error.message : safeError(error), milliseconds: performance.now() - started });
      throw error;
    }
  };
  // All prepared identities/checks/collisions are read before any new write.
  for (const f of continuations) {
    const prefix = `/repos/${f.owner}/${f.name}`;
    const main = await request('GET', `${prefix}/branches/main`), branch = await request('GET', `${prefix}/git/ref/heads/d05-26-controls`);
    const comparison = await request('GET', `${prefix}/compare/${f.main}...${f.head}`);
    if (main.name !== 'main' || main.commit?.sha !== f.main || main.protected !== f.protected || branch.ref !== 'refs/heads/d05-26-controls' ||
      branch.object?.type !== 'commit' || branch.object.sha !== f.head || comparison.status !== 'ahead' || comparison.ahead_by !== 2 ||
      comparison.total_commits !== 2 || comparison.commits?.length !== 2 || comparison.commits[0].sha !== f.oldHead || comparison.commits[1].sha !== f.head ||
      comparison.files?.length !== 2 || ![['.github/workflows/d05-controls.yml', f.workflowBlob], ['d05-controls.txt', f.controlBlob]].every(([name, sha]) =>
        comparison.files.some(file => file.filename === name && file.status === 'added' && file.sha === sha))) throw new Error('readback-mismatch');
    if (!issueMatches(await request('GET', `${prefix}/issues/1`), f)) throw new Error('readback-mismatch');
    await record(f, 'completed-merge-readback', async () => {
      await readMergedPull(request, f, { ...f.pull, number: 2, ref: 'd05-26-qualification' }, f.main, signal);
      return { number: 2, ...f.pull, merge: f.main, readOnly: true };
    });
    for (const [path, collision] of [[`${prefix}/labels?per_page=100`, value => value.name === 'd05-remaining' && value.id !== f.control?.label],
      [`${prefix}/pulls?state=all&head=${f.owner}:d05-26-controls&per_page=100`, value => !f.control ||
        !pullMatches(value, f, f.control.number, f.control.id, f.control.node, f.head) || value.state !== 'open'],
      [`${prefix}/releases?per_page=100`, value => value.tag_name === 'd05-26-qualification']]) {
      const values = await request('GET', path);
      if (!Array.isArray(values) || values.length >= 100) throw new Error('incomplete-list');
      if (values.some(collision)) throw new Error('fixture-collision');
    }
    await record(f, 'real-check-failure-pending-readback', async () => {
      if (await status(f, f.oldHead) !== 'failure' || await status(f, f.head) !== 'pending') throw new Error('readback-mismatch');
      return { ...await checks(f), oldHead: f.oldHead, oldStatus: 'failure', currentStatus: 'pending' };
    });
  }
  for (const f of continuations) {
    const prefix = `/repos/${f.owner}/${f.name}`;
    if (!f.control) {
      await record(f, 'ordinary-label-ready-preservation', async () => {
        const label = await request('POST', `${prefix}/labels`, { name: 'd05-remaining', color: '82d3c1', description: 'Synthetic D-05 Ready-preservation test' });
        if (!Number.isSafeInteger(label.id) || label.id < 1 || label.name !== 'd05-remaining') throw new Error('readback-mismatch');
        await request('POST', `${prefix}/issues/1/labels`, { labels: ['d05-remaining'] });
        const actual = await request('GET', `${prefix}/issues/1`);
        if (!issueMatches(actual, f) || !actual.labels.some(value => value.id === label.id && value.name === 'd05-remaining')) throw new Error('readback-mismatch');
        return { readyPresent: true, readyPreserved: true, ordinaryLabel: label.id, origin: 'synthetic fixture; PM origin not qualified' };
      });
      await record(f, 'lost-acknowledgement-reconciliation', async () => {
        const body = 'D-05 synthetic lost-acknowledgement test. No private data.';
        const fault = makeRequest(accessToken, async (url, options) => {
          const response = await send(url, options);
          if (!response.ok) return response;
          await response.body?.cancel();
          throw new Error('Synthetic discarded write acknowledgement');
        }, signal);
        try { await fault('PATCH', `${prefix}/issues/1`, { body }); throw new Error('readback-mismatch'); }
        catch (error) { if (error.message !== 'write-result-uncertain') throw error; }
        const actual = await request('GET', `${prefix}/issues/1`);
        if (!issueMatches(actual, f) || actual.body !== body) throw new Error('readback-mismatch');
        return { faultInjected: true, reconciled: true, mutationDispatches: 1, replayed: false };
      });
    }
    const pull = await record(f, f.control ? 'owned-control-effects-readback' : 'new-pr-create-update-readback', async () => {
      if (f.control) {
        const label = await request('GET', `${prefix}/labels/d05-remaining`), issue = await request('GET', `${prefix}/issues/1`);
        const actual = await request('GET', `${prefix}/pulls/${f.control.number}`);
        if (label.id !== f.control.label || label.name !== 'd05-remaining' || !issueMatches(issue, f) ||
          issue.body !== 'D-05 synthetic lost-acknowledgement test. No private data.' ||
          issue.labels.filter(value => value.id === label.id && value.name === label.name).length !== 1 ||
          !pullMatches(actual, f, f.control.number, f.control.id, f.control.node, f.head) || actual.state !== 'open' ||
          actual.merged !== false || actual.body !== 'D-05 synthetic PR — updated') throw new Error('readback-mismatch');
        return { number: actual.number, id: actual.id, node: actual.node_id, head: f.head, readOnly: true };
      }
      const created = await request('POST', `${prefix}/pulls`, { title: 'D-05 synthetic control PR', head: 'd05-26-controls', base: 'main', body: 'D-05 synthetic control fixture.' });
      if (!Number.isSafeInteger(created.id) || created.id < 1 || !Number.isSafeInteger(created.number) || created.number < 1 ||
        typeof created.node_id !== 'string' || !/^PR_[A-Za-z0-9_-]+$/.test(created.node_id)) throw new Error('readback-mismatch');
      onResult?.({ fixture: `${f.owner}/${f.name}`, operation: 'control-pr-created', status: 'passed', detail: { id: created.id, number: created.number, node: created.node_id } });
      await request('PATCH', `${prefix}/pulls/${created.number}`, { body: 'D-05 synthetic PR — updated' });
      const actual = await request('GET', `${prefix}/pulls/${created.number}`);
      if (!pullMatches(actual, f, created.number, created.id, created.node_id, f.head) || actual.state !== 'open' || actual.merged !== false ||
        actual.body !== 'D-05 synthetic PR — updated') throw new Error('readback-mismatch');
      return { number: created.number, id: created.id, node: created.node_id, head: f.head };
    });
    // Fixture-only planner context; this does not authenticate a production Project or PM gate.
    const scope = { repository: { owner: f.owner, name: f.name, id: f.node }, issue: { id: f.issue.node, number: 1 },
      project: { id: 'D05_synthetic_project', itemId: 'D05_synthetic_item', statusFieldId: 'D05_synthetic_status' },
      runId: 'd05-26-controls', epoch: 1, policyVersion: 1, pullRequest: { number: pull.number, id: pull.node, head: f.head }, mergeAuthorizedHead: f.head };
    const candidate = { operation: 'pr-merge', payload: { number: pull.number, head: f.head }, repositoryId: f.node, issueId: f.issue.node,
      runId: scope.runId, epoch: scope.epoch, policyVersion: scope.policyVersion };
    const fixtureLive = { complete: true, repositoryId: f.node, issueId: f.issue.node, projectId: scope.project.id, itemId: scope.project.itemId,
      statusFieldId: scope.project.statusFieldId, activeIssueIds: [f.issue.node], issueState: 'OPEN', status: 'In Progress',
      pullRequestId: pull.node, head: f.head, checksHead: f.head, checksPassed: false };
    await record(f, 'pending-candidate-denied', async () => {
      if (await status(f, f.head) !== 'pending') throw new Error('readback-mismatch');
      try { planOperation(candidate, scope, fixtureLive); throw new Error('readback-mismatch'); }
      catch (error) { if (error.message !== 'candidate-denied') throw error; }
      return { deniedBeforeDispatch: true, requiredStatus: 'pending', plannerContext: 'synthetic' };
    });
    if (f.protected) {
      await record(f, 'external-protected-merge-denial', async () => {
        try { await request('PUT', `${prefix}/pulls/${pull.number}/merge`, { sha: f.head, merge_method: 'squash' }); throw new Error('readback-mismatch'); }
        catch (error) { if (error.message !== 'http-405') throw error; }
        const actual = await request('GET', `${prefix}/pulls/${pull.number}`), main = await request('GET', `${prefix}/branches/main`);
        if (!pullMatches(actual, f, pull.number, pull.id, pull.node, f.head) || actual.state !== 'open' || actual.merged !== false ||
          main.commit?.sha !== f.main || main.protected !== true) throw new Error('readback-mismatch');
        return { denied: 'http-405', pendingRequiredStatus: true, openPrPreserved: true, mainUnchanged: true };
      });
    } else {
      const row = { fixture: `${f.owner}/${f.name}`, operation: 'external-protected-merge-denial', status: 'not-run',
        detail: 'Private personal fixture protection preparation returned HTTP 403 requiring GitHub Pro; no pending merge dispatched.' };
      rows.push(row); onResult?.(row);
    }
    onResult?.({ fixture: `${f.owner}/${f.name}`, operation: 'fixture-status-success-required', status: 'waiting', detail: { head: f.head, context: 'pipeliner-d05/qualification' } });
    const deadline = AbortSignal.timeout(60000), waitingSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const waitingRequest = makeRequest(accessToken, send, waitingSignal);
    let current;
    for (let attempt = 0; attempt < 60; attempt++) {
      current = await status(f, f.head, waitingRequest); if (current === 'success') break;
      if (current !== 'pending') throw new Error('readback-mismatch');
      await delay(1000, undefined, { signal: waitingSignal }).catch(() => { throw new Error('cancelled'); });
    }
    if (current !== 'success') throw new Error('readback-mismatch');
    const verifiedChecks = await record(f, 'current-pr-check-readback', () => checks(f));
    const merge = await record(f, 'candidate-check-merge-readback', async () => {
      const actual = await request('GET', `${prefix}/pulls/${pull.number}`);
      if (!pullMatches(actual, f, pull.number, pull.id, pull.node, f.head) || actual.state !== 'open' || actual.merged !== false) throw new Error('readback-mismatch');
      const live = { ...fixtureLive, head: actual.head.sha, checksHead: verifiedChecks.head, checksPassed: true };
      for (const denied of [
        { ...candidate, payload: { number: pull.number, head: f.oldHead } },
        { ...candidate, operation: 'labels-add', payload: { labels: ['Ready for Development'] } },
        { ...candidate, operation: 'label-remove', payload: { label: 'Ready for Development' } },
      ]) {
        try { planOperation(denied, scope, live); throw new Error('readback-mismatch'); }
        catch (error) { if (!['candidate-denied', 'protected-or-invalid-label'].includes(error.message)) throw error; }
      }
      const plan = planOperation(candidate, scope, live), result = await request(plan.method, plan.path, plan.body);
      if (result.merged !== true || !/^[0-9a-f]{40}$/.test(result.sha)) throw new Error('readback-mismatch');
      await readMergedPull(request, f, { ...pull, ref: 'd05-26-controls' }, result.sha, signal);
      return { number: pull.number, id: pull.id, node: pull.node, head: pull.head,
        merge: result.sha, check: verifiedChecks.check, workflowRun: verifiedChecks.workflowRun,
        status: 'success', staleHeadDenied: true, protectedLabelAddRemoveDenied: true, plannerContext: 'synthetic' };
    });
    await record(f, 'draft-asset-download', async () => {
      const release = await request('POST', `${prefix}/releases`, { tag_name: 'd05-26-qualification', target_commitish: merge.merge,
        name: 'D-05 synthetic fixture release', draft: true, prerelease: true });
      if (!Number.isSafeInteger(release.id) || release.id < 1 || typeof release.node_id !== 'string' || release.tag_name !== 'd05-26-qualification' ||
        release.target_commitish !== merge.merge || release.draft !== true || release.prerelease !== true) throw new Error('readback-mismatch');
      onResult?.({ fixture: `${f.owner}/${f.name}`, operation: 'draft-release-created', status: 'passed', detail: { id: release.id, node: release.node_id } });
      const bytes = Buffer.from('Pipeliner D-05 synthetic asset\n'), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const path = `${prefix}/releases/${release.id}/assets?name=d05-qualification.txt`, asset = await request('POST', path, bytes, true);
      if (!Number.isSafeInteger(asset.id) || asset.id < 1 || asset.name !== 'd05-qualification.txt' || asset.state !== 'uploaded' ||
        asset.size !== bytes.length || asset.digest !== digest) throw new Error('readback-mismatch');
      try { await request('POST', path, bytes, true); throw new Error('readback-mismatch'); }
      catch (error) { if (error.message !== 'http-422') throw error; }
      const actual = await request('GET', `${prefix}/releases/${release.id}`);
      if (actual.id !== release.id || actual.node_id !== release.node_id || actual.tag_name !== release.tag_name || actual.target_commitish !== merge.merge ||
        actual.draft !== true || actual.prerelease !== true || actual.assets?.length !== 1 || actual.assets[0].id !== asset.id ||
        actual.assets[0].digest !== digest || actual.assets[0].size !== bytes.length || actual.assets[0].state !== 'uploaded') throw new Error('readback-mismatch');
      const downloaded = await downloadAsset(accessToken, f, asset.id, bytes.length, digest, send, signal);
      return { release: release.id, asset: asset.id, digest, downloadedDigest: downloaded.digest, redirected: downloaded.redirected,
        bytes: bytes.length, duplicateDenied: 'http-422', draft: true };
    });
  }
  return { installations: 'passed', rows, limitations: ['Personal private fixture branch protection requires GitHub Pro; organization protection is tested.',
    'Planner context and Ready origin are synthetic; product PM-origin, durable state, secure storage and other hosts remain separate qualification.'] };
}

async function downloadAsset(token, fixture, id, size, digest, send, signal) {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  let response, reader, redirected = false;
  try {
    combined.throwIfAborted();
    response = await send(`https://api.github.com/repos/${fixture.owner}/${fixture.name}/releases/assets/${id}`, {
      method: 'GET', redirect: 'manual', signal: combined,
      headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Pipeliner-D05-Qualification' } });
    if (response.status === 302) {
      const destination = new URL(response.headers.get('location'));
      await response.body?.cancel();
      if (destination.protocol !== 'https:' || destination.hostname !== 'release-assets.githubusercontent.com' || destination.port ||
        destination.username || destination.password || destination.hash ||
        !destination.pathname.startsWith(`/github-production-release-asset/${fixture.id}/`)) throw new Error('asset-download-invalid');
      redirected = true;
      response = await send(destination.href, { method: 'GET', redirect: 'error', signal: combined,
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'Pipeliner-D05-Qualification' } });
    }
    if (response.status !== 200) throw new Error('asset-download-invalid');
    reader = response.body?.getReader(); if (!reader) throw new Error('asset-download-invalid');
    let length = 0; const hash = createHash('sha256');
    while (true) {
      const part = await reader.read(); combined.throwIfAborted(); if (part.done) break;
      length += part.value.byteLength; if (length > size) throw new Error('asset-download-invalid'); hash.update(part.value);
    }
    const actual = `sha256:${hash.digest('hex')}`;
    if (length !== size || actual !== digest) throw new Error('asset-download-invalid');
    return { digest: actual, redirected };
  } catch {
    await reader?.cancel().catch(() => {}); await response?.body?.cancel().catch(() => {});
    throw new Error(signal?.aborted ? 'cancelled' : 'asset-download-invalid');
  } finally { reader?.releaseLock(); }
}

export async function awaitRevocation(token, { send = fetch, signal, wait = delay } = {}) {
  if (typeof token !== 'string' || !/^gh[uo]_[A-Za-z0-9_]{8,200}$/.test(token)) throw new Error('connection-token-required');
  const deadline = AbortSignal.timeout(120000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const request = makeRequest(token, send, combined);
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if (!matchesAccount(await request('GET', '/user'))) throw new Error('account-mismatch'); }
    catch (error) {
      if (error.message === 'http-401') return { accessDenied: true };
      if (deadline.aborted && !signal?.aborted) throw new Error('revocation-not-observed');
      throw error;
    }
    await wait(2000, undefined, { signal: combined }).catch(() => { throw new Error(signal?.aborted ? 'cancelled' : 'revocation-not-observed'); });
  }
  throw new Error('revocation-not-observed');
}


async function confirmRead(read, identity, matches, signal) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const actual = await read();
    if (!identity(actual)) throw new Error('readback-mismatch');
    if (matches(actual)) return actual;
    if (attempt < 4) await delay(500, undefined, { signal }).catch(() => { throw new Error('cancelled'); });
  }
  throw new Error('readback-mismatch');
}

async function readMergedPull(request, fixture, pull, merge, signal) {
  // REST 2026 removed merge_commit_sha. Bind its full identity to the same GraphQL merge receipt.
  await confirmRead(async () => ({
    rest: await request('GET', `/repos/${fixture.owner}/${fixture.name}/pulls/${pull.number}`),
    node: (await request('POST', '/graphql', { query:
      'query($id:ID!){node(id:$id){... on PullRequest{id number state merged headRefOid repository{id} mergeCommit{oid repository{id}}}}}',
      variables: { id: pull.node } })).data?.node,
  }), ({ rest, node }) => rest.id === pull.id && rest.node_id === pull.node && rest.number === pull.number &&
    rest.head?.sha === pull.head && rest.head.ref === pull.ref && rest.head.repo?.id === fixture.id &&
    rest.head.repo.node_id === fixture.node && rest.base?.ref === 'main' && rest.base.repo?.id === fixture.id &&
    rest.base.repo.node_id === fixture.node && typeof rest.merged === 'boolean' && ['open', 'closed'].includes(rest.state) &&
    node?.id === pull.node && node.number === pull.number && node.headRefOid === pull.head && node.repository?.id === fixture.node &&
    typeof node.merged === 'boolean' && ['OPEN', 'CLOSED', 'MERGED'].includes(node.state) &&
    (node.mergeCommit === null || node.mergeCommit?.oid === merge && node.mergeCommit.repository?.id === fixture.node),
  ({ rest, node }) => rest.state === 'closed' && rest.merged === true && node.state === 'MERGED' && node.merged === true &&
    node.mergeCommit?.oid === merge, signal);
}

async function setupProject(request, fixture, fixtureIssue, title, onResult, confirm) {
  const created = await request('POST', '/graphql', { query:
    'mutation($owner:ID!,$title:String!,$repository:ID!){createProjectV2(input:{ownerId:$owner,title:$title,repositoryId:$repository}){projectV2{id number title public owner{... on User{id} ... on Organization{id}}}}}',
    variables: { owner: fixture.ownerNode, title, repository: fixture.node } });
  const project = created.data?.createProjectV2?.projectV2;
  if (typeof project?.id !== 'string' || !Number.isSafeInteger(project.number) || project.number < 1 ||
    project.title !== title || project.public !== false || project.owner?.id !== fixture.ownerNode) throw new Error('readback-mismatch');
  onResult?.({ fixture: `${fixture.owner}/${fixture.name}`, operation: 'project-created', status: 'passed',
    detail: { id: project.id, number: project.number, private: true } });
  const readFields = () => readProjectFields(request, project.id);
  const initial = await readFields();
  const statusFields = initial.filter(field => field.name === 'Status');
  if (statusFields.length !== 1 || !Array.isArray(statusFields[0].options)) throw new Error('readback-mismatch');
  const definitions = projectDefinitions;
  const fields = new Map();
  for (const definition of definitions) {
    if (definition.name !== 'Status' && initial.some(field => field.name === definition.name)) throw new Error('fixture-collision');
    const options = definition.choices.map(name => ({ name, color: 'BLUE', description: 'Synthetic D-05 fixture option' }));
    const updating = definition.name === 'Status';
    const data = await request('POST', '/graphql', { query: updating
      ? 'mutation($field:ID!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){updateProjectV2Field(input:{fieldId:$field,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id name options{id name}}}}}'
      : 'mutation($project:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){createProjectV2Field(input:{projectId:$project,dataType:SINGLE_SELECT,name:$name,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id name options{id name}}}}}',
      variables: updating ? { field: statusFields[0].id, options } : { project: project.id, name: definition.name, options } });
    const field = data.data?.[updating ? 'updateProjectV2Field' : 'createProjectV2Field']?.projectV2Field;
    if (typeof field?.id !== 'string' || field.name !== definition.name || !Array.isArray(field.options) ||
      !isDeepStrictEqual(field.options.map(option => option.name), definition.choices) ||
      field.options.some(option => typeof option.id !== 'string' || !option.id) ||
      new Set(field.options.map(option => option.id)).size !== field.options.length) throw new Error('readback-mismatch');
    fields.set(definition.name, field);
  }
  const actualFields = await readFields();
  for (const [name, expected] of fields) {
    const actual = actualFields.filter(field => field.name === name);
    if (actual.length !== 1 || !isDeepStrictEqual(actual[0], expected)) throw new Error('readback-mismatch');
  }
  const added = await request('POST', '/graphql', { query:
    'mutation($project:ID!,$issue:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$issue}){item{id}}}',
    variables: { project: project.id, issue: fixtureIssue.node_id } });
  const item = added.data?.addProjectV2ItemById?.item?.id;
  if (typeof item !== 'string' || !item) throw new Error('readback-mismatch');
  for (const definition of definitions) {
    const field = fields.get(definition.name);
    const data = await request('POST', '/graphql', { query:
      'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}',
      variables: { project: project.id, item, field: field.id, option: field.options.find(option => option.name === definition.value).id } });
    if (data.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== item) throw new Error('readback-mismatch');
  }
  return exerciseProject(request, fixture, fixtureIssue, project, fields, item, onResult, confirm, true);
}

async function readProjectFields(request, id) {
  return collectConnection(async cursor => {
    const data = await request('POST', '/graphql', { query:
      'query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{id fields(first:100,after:$cursor){totalCount nodes{... on ProjectV2Field{id name} ... on ProjectV2SingleSelectField{id name options{id name}} ... on ProjectV2IterationField{id name}} pageInfo{hasNextPage endCursor}}}}}',
      variables: { id, cursor } });
    if (data.data?.node?.id !== id) throw new Error('readback-mismatch');
    return data.data.node.fields;
  });
}

export async function qualifyKnownProject(token, { send = fetch, signal, onResult } = {}) {
  const fixture = continuations[1];
  await qualifyAccess(token, { fixtureId: fixture.id, readOnly: true, send, signal });
  const request = makeRequest(token, send, signal), id = 'PVT_kwDOETTHSM4BlYox';
  const fixtureIssue = await request('GET', `/repos/${fixture.owner}/${fixture.name}/issues/1`);
  if (fixtureIssue.id !== fixture.issue.id || fixtureIssue.node_id !== fixture.issue.node || fixtureIssue.number !== 1 ||
    fixtureIssue.state !== 'open') throw new Error('readback-mismatch');
  const data = await request('POST', '/graphql', { query:
    'query($id:ID!){node(id:$id){... on ProjectV2{id number title public owner{... on User{id} ... on Organization{id}}}}}', variables: { id } });
  const project = data.data?.node;
  if (project?.id !== id || project.number !== 8 || project.title !== 'Pipeliner D-05 #26 Organization Fixture' ||
    project.public !== false || project.owner?.id !== fixture.ownerNode) throw new Error('readback-mismatch');
  const actual = await readProjectFields(request, id), fields = new Map();
  for (const definition of projectDefinitions) {
    const named = actual.filter(field => field.name === definition.name), field = named[0];
    if (named.length !== 1 || typeof field.id !== 'string' || !field.id || !Array.isArray(field.options) ||
      !isDeepStrictEqual(field.options.map(option => option.name), definition.choices) ||
      field.options.some(option => typeof option.id !== 'string' || !option.id) ||
      new Set(field.options.map(option => option.id)).size !== field.options.length) throw new Error('readback-mismatch');
    fields.set(definition.name, field);
  }
  return exerciseProject(request, fixture, fixtureIssue, project, fields,
    'PVTI_lADOETTHSM4BlYoxzg-AJuU', onResult,
    (read, identity, matches) => confirmRead(read, identity, matches, signal), false);
}

async function exerciseProject(request, fixture, fixtureIssue, project, fields, item, onResult, confirm, newAddition) {
  const definitions = projectDefinitions;
  const readItem = async () => {
    const items = await readProject(project.id, (query, variables) => request('POST', '/graphql', { query, variables }));
    // Only the verified new addition may be temporarily absent. Wrong identities still fail immediately.
    if (items.length === 0 && newAddition) return null;
    if (items.length !== 1 || items[0].id !== item || items[0].content?.id !== fixtureIssue.node_id ||
      items[0].content.repository?.id !== fixture.node || items[0].content.state !== 'OPEN') {
      onResult?.({ fixture: `${fixture.owner}/${fixture.name}`, operation: 'project-item-binding', status: 'failed', detail: {
        count: items.length, itemMatches: items[0]?.id === item, issueMatches: items[0]?.content?.id === fixtureIssue.node_id,
        repositoryMatches: items[0]?.content?.repository?.id === fixture.node, openState: items[0]?.content?.state === 'OPEN',
      } });
      throw new Error('readback-mismatch');
    }
    return items[0];
  };
  const statusField = fields.get('Status'), statuses = ['In Progress'];
  for (const next of ['In Review', 'Pending Review', 'In Progress']) {
    const current = await confirm(readItem, () => true, item =>
      item?.fieldValues.nodes.find(value => value.field?.id === statusField.id)?.name === statuses.at(-1));
    const status = current.fieldValues.nodes.find(value => value.field?.id === statusField.id)?.name;
    if (status !== statuses.at(-1)) throw new Error('readback-mismatch');
    const scope = { repository: { owner: fixture.owner, name: fixture.name, id: fixture.node },
      issue: { id: fixtureIssue.node_id, number: fixtureIssue.number }, runId: 'd05-26-fixture', epoch: 1, policyVersion: 1,
      project: { id: project.id, itemId: item, statusFieldId: statusField.id,
        statuses: Object.fromEntries(statusField.options.map(option => [option.name, option.id])) } };
    const plan = planOperation({ operation: 'project-status', payload: { status: next }, repositoryId: fixture.node,
      issueId: fixtureIssue.node_id, runId: scope.runId, epoch: scope.epoch, policyVersion: scope.policyVersion }, scope,
    { complete: true, repositoryId: fixture.node, issueId: fixtureIssue.node_id, projectId: project.id, itemId: item,
      statusFieldId: statusField.id, activeIssueIds: [fixtureIssue.node_id], issueState: 'OPEN', status });
    const data = await request(plan.method, plan.path, plan.body);
    if (data.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== item) throw new Error('readback-mismatch');
    statuses.push(next);
  }
  await confirm(readItem, () => true, item => Boolean(item) && definitions.every(definition => item.fieldValues.nodes.some(value =>
    value.field?.id === fields.get(definition.name).id && value.name === definition.value)));
  return { id: project.id, number: project.number, item, fields: definitions.map(field => field.name), statuses };
}
