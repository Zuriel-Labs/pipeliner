import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { collectConnection } from '../../scripts/lib/project.mjs';
import { planOperation, readProject } from './operations.mjs';

// Qualification scope only; these fixtures were explicitly designated by the PM.
export const fixtures = Object.freeze([
  Object.freeze({ owner: 'brimdor', ownerNode: 'MDQ6VXNlcjEyMDI4MzE=', type: 'User', name: 'pipeliner-d05-26-personal', id: 1399877876, node: 'R_kgDOU3Bw9A',
    issue: Object.freeze({ number: 1, id: 5668446817, node: 'I_kwDOU3Bw9M8AAAABUd2iYQ' }) }),
  Object.freeze({ owner: 'Zuriel-Labs', ownerNode: 'O_kgDOETTHSA', type: 'Organization', name: 'pipeliner-d05-26-org', id: 1399878351, node: 'R_kgDOU3Byzw' }),
]);
export const appPermissions = Object.freeze({ actions: 'read', checks: 'read', contents: 'write', issues: 'write', metadata: 'read',
  organization_projects: 'write', pull_requests: 'write', statuses: 'read' });
// Existing selected repository is installation evidence only; never an operation target.
const existingSelection = Object.freeze({ id: 1363240768, node: 'R_kgDOUUFnQA', owner: 'Zuriel-Labs', name: 'pipeliner', private: false });
const matchesRepository = (actual, expected) => actual?.id === expected.id && actual.node_id === expected.node &&
  actual.full_name === `${expected.owner}/${expected.name}` && actual.private === (expected.private ?? true);
const safeError = error => /^(http-\d{3}|graphql-(forbidden|rejected)|readback-mismatch|write-result-uncertain|response-invalid|response-too-large|cancelled|read-failed|fixture-collision|dependency-unqualified)$/.test(error?.message)
  ? error.message : 'qualification-failed';

export async function qualifyAccess(accessToken, { fixtureId, readOnly = false, send = fetch, signal, onResult } = {}) {
  if (typeof accessToken !== 'string' || !/^ghu_[A-Za-z0-9_]{8,200}$/.test(accessToken)) throw new Error('app-token-required');
  if (typeof readOnly !== 'boolean') throw new Error('invalid-read-mode');
  const selectedFixtures = fixtureId === undefined ? fixtures : fixtures.filter(fixture => fixture.id === fixtureId);
  if (!selectedFixtures.length) throw new Error('fixture-not-approved');
  const rows = [];
  async function request(method, path, body, upload = false) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    let reader, dispatched = false;
    const mutation = method !== 'GET' && !(path === '/graphql' && body?.query?.startsWith('query('));
    try {
      combined.throwIfAborted();
      dispatched = true;
      const response = await send(`https://${upload ? 'uploads' : 'api'}.github.com${path}`, { method, redirect: 'error', signal: combined,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Pipeliner-D05-Qualification',
          ...(body ? { 'Content-Type': upload ? 'application/octet-stream' : 'application/json' } : {}) },
        body: body ? upload ? body : JSON.stringify(body) : undefined });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`http-${response.status}`);
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error('response-invalid');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, text = '';
      while (true) {
        const part = await reader.read();
        combined.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1048576) throw new Error('response-too-large');
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('response-invalid'); }
      combined.throwIfAborted();
      if (!data || typeof data !== 'object') throw new Error('response-invalid');
      if (data.errors?.length) throw new Error(data.errors.some(e => e.type === 'FORBIDDEN') ? 'graphql-forbidden' : 'graphql-rejected');
      return data;
    } catch (error) {
      await reader?.cancel().catch(() => {});
      if (signal?.aborted) throw new Error(mutation && dispatched ? 'write-result-uncertain' : 'cancelled');
      if (/^(http-\d{3}|graphql-(forbidden|rejected))$/.test(error?.message)) throw error;
      if (!mutation && /^(response-invalid|response-too-large)$/.test(error?.message)) throw error;
      // A lost write reply never authorizes another dispatch.
      throw new Error(mutation && dispatched ? 'write-result-uncertain' : 'read-failed');
    } finally { reader?.releaseLock(); }
  }
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
  async function confirm(read, identity, matches) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const actual = await read();
      if (!identity(actual)) throw new Error('readback-mismatch');
      if (matches(actual)) return actual;
      if (attempt < 4) await delay(500, undefined, { signal }).catch(() => { throw new Error('cancelled'); });
    }
    throw new Error('readback-mismatch');
  }
  if ((await request('GET', '/user')).login !== 'brimdor') throw new Error('account-mismatch');
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
      await confirm(() => request('GET', `${prefix}/pulls/${pull.number}`),
        merged => merged.id === pull.id && merged.node_id === pull.node_id && merged.number === pull.number &&
          merged.head?.sha === head && typeof merged.merged === 'boolean' && ['open', 'closed'].includes(merged.state),
        merged => merged.state === 'closed' && merged.merged === true && merged.merge_commit_sha === merge.sha);
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
      const created = await request('POST', '/graphql', { query:
        'mutation($owner:ID!,$title:String!,$repository:ID!){createProjectV2(input:{ownerId:$owner,title:$title,repositoryId:$repository}){projectV2{id number title public owner{... on User{login} ... on Organization{login}}}}}',
        variables: { owner: fixture.ownerNode, title, repository: fixture.node } });
      const project = created.data?.createProjectV2?.projectV2;
      if (typeof project?.id !== 'string' || !Number.isSafeInteger(project.number) || project.number < 1 ||
        project.title !== title || project.public !== false || project.owner?.login !== fixture.owner) throw new Error('readback-mismatch');
      onResult?.({ fixture: `${fixture.owner}/${fixture.name}`, operation: 'project-created', status: 'passed',
        detail: { id: project.id, number: project.number, private: true } });
      const readFields = () => collectConnection(async cursor => {
        const data = await request('POST', '/graphql', { query:
          'query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{id fields(first:100,after:$cursor){totalCount nodes{... on ProjectV2Field{id name} ... on ProjectV2SingleSelectField{id name options{id name}} ... on ProjectV2IterationField{id name}} pageInfo{hasNextPage endCursor}}}}}',
          variables: { id: project.id, cursor } });
        if (data.data?.node?.id !== project.id) throw new Error('readback-mismatch');
        return data.data.node.fields;
      });
      const initial = await readFields();
      const statusFields = initial.filter(field => field.name === 'Status');
      if (statusFields.length !== 1 || !Array.isArray(statusFields[0].options)) throw new Error('readback-mismatch');
      const definitions = [
        { name: 'Status', choices: ['Backlog', 'In Progress', 'In Review', 'Pending Review', 'Done'], value: 'In Progress' },
        { name: 'Priority', choices: ['P0', 'P1', 'P2', 'P3'], value: 'P0' },
        { name: 'Impact', choices: ['High', 'Medium', 'Low'], value: 'High' },
        { name: 'Effort', choices: ['XS', 'S', 'M', 'L', 'XL'], value: 'L' },
      ];
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
      const readItem = async () => {
        const items = await readProject(project.id, (query, variables) => request('POST', '/graphql', { query, variables }));
        if (items.length !== 1 || items[0].id !== item || items[0].content?.id !== fixtureIssue.node_id ||
          items[0].content.repository?.id !== fixture.node || items[0].content.state !== 'OPEN') throw new Error('readback-mismatch');
        return items[0];
      };
      const statusField = fields.get('Status'), statuses = ['In Progress'];
      for (const next of ['In Review', 'Pending Review', 'In Progress']) {
        const current = await confirm(readItem, () => true, item =>
          item.fieldValues.nodes.find(value => value.field?.id === statusField.id)?.name === statuses.at(-1));
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
      await confirm(readItem, () => true, item => definitions.every(definition => item.fieldValues.nodes.some(value =>
        value.field?.id === fields.get(definition.name).id && value.name === definition.value)));
      return { id: project.id, number: project.number, item, fields: definitions.map(field => field.name), statuses };
    });
  }
  return { installations: 'passed', rows, limitations: [
    'Repository creation at an existing fixture name cannot prove successful creation; HTTP 422 is inconclusive.',
    'Each Project row reports actual setup access. PM Ready origin, required-check execution, protected-branch denial, release download/publication, revocation and full native product integration remain separately qualified. Git transport has separate native receipts.',
    'Uncertain writes require reconciliation before a later attempt; this function never retries them.',
  ] };
}
