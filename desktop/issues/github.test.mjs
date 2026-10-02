import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog, readDetail, createIssue, setReady } from './github.mjs';

const page = nodes => ({ totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const fields = Object.fromEntries([['Status', ['Backlog', 'In Progress', 'In Review', 'Pending Review', 'Done']], ['Priority', ['P0', 'P1']], ['Impact', ['High']], ['Effort', ['M']]].map(([role, names]) => [role, { id: 'F_' + role, name: role, options: names.map((name, i) => ({ id: 'O_' + role + i, name })) }]));
const workspace = { repositoryId: 'R1', numericId: 1, slug: 'fixture/repo', private: true, project: { id: 'P1', owner: { id: 'ORG1' }, fields } };
const rawIssue = (number = 7) => ({ id: number, node_id: 'I' + number, number, title: 'Preserve my work', body: 'Acceptance', state: 'open', labels: [], assignees: [], html_url: `https://github.com/fixture/repo/issues/${number}` });
function fixture() {
  let issues = [rawIssue()], statuses = ['Backlog'], partial = false, drop = false; const writes = [];
  const send = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.github.com'); const body = options.body ? JSON.parse(options.body) : null, path = new URL(url).pathname; let result;
    if (options.method !== 'GET' && path !== '/graphql') writes.push({ path, method: options.method, body });
    if (path === '/repos/fixture/repo') result = { id: 1, node_id: 'R1', owner: { id: 2, node_id: 'ORG1', login: 'fixture', type: 'Organization' }, full_name: 'fixture/repo', name: 'repo', private: true, archived: false, disabled: false, has_issues: true, permissions: { pull: true } };
    else if (path === '/graphql') {
      const q = body.query;
      if (q.includes('viewerCanUpdate owner')) result = { data: { node: { id: 'P1', number: 1, title: 'Fixture', public: false, closed: false, viewerCanUpdate: true, owner: { id: 'ORG1' } } } };
      else if (q.includes('fields(first:')) result = { data: { node: { id: 'P1', fields: page(Object.values(fields)) } } };
      else if (q.includes('repositories(first:')) result = { data: { node: { id: 'P1', repositories: page([{ id: 'R1', nameWithOwner: 'fixture/repo' }]) } } };
      else if (q.includes('closedByPullRequestsReferences')) result = { data: { node: { id: 'I7', closedByPullRequestsReferences: page([]) } } };
      else if (q.includes('timelineItems')) result = { data: { node: { id: 'I7', timelineItems: page([{ id: 'REF1', __typename: 'CrossReferencedEvent', source: { __typename: 'PullRequest', id: 'PR9', number: 9, title: 'Refs #7', state: 'OPEN', repository: { id: 'R1', nameWithOwner: 'fixture/repo' }, headRefOid: 'a'.repeat(40), commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: { state: 'SUCCESS', contexts: page([{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }]) } } }] } } }]) } } };
      else result = { data: { node: { id: 'P1', items: page([...issues.map((issue, i) => ({ id: 'ITEM' + issue.number, content: { __typename: 'Issue', id: issue.node_id, number: issue.number, state: 'OPEN', repository: { id: 'R1' } }, fieldValues: { ...page([{ __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: fields.Status.options.find(option => option.name === statuses[i]).id, name: statuses[i], field: { id: fields.Status.id } }]), pageInfo: { hasNextPage: partial, endCursor: null } } })), { id: 'DRAFT', content: { __typename: 'DraftIssue', id: 'DI1' }, fieldValues: page([]) }]) } } };
    } else if (path.endsWith('/labels') || path.includes('/labels/')) result = options.method === 'GET' ? [{ id: 1, name: 'type:feature' }] : [];
    else if (path.endsWith('/dependencies/blocked_by')) result = [];
    else if (path.endsWith('/issues/7')) result = rawIssue();
    else if (path.endsWith('/issues')) {
      if (options.method === 'GET') { assert.equal(new URL(url).searchParams.get('state'), 'all'); result = issues; }
      else result = { ...rawIssue(8), ...body, labels: drop ? [] : body.labels.map((name, i) => ({ id: i + 1, name })) };
    } else throw new Error('unexpected-request');
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const lease = { id: 'github', value: { credential: { accessToken: 'synthetic' }, view: { repositories: [{ id: 'R1', numericId: 1, name: 'fixture/repo', private: true, permissions: ['pull'] }] } }, check() {}, send };
  return { lease, writes, partial: () => { partial = true; }, active: () => { issues = [rawIssue(7), rawIssue(8)]; statuses = ['In Progress', 'Pending Review']; }, drop: () => { drop = true; } };
}
test('live intake reads all Issues and Project cards, preserving Draft cards and failing closed on partial or conflicting activity', async () => {
  const f = fixture(), data = await readCatalog(f.lease, f.lease, workspace);
  assert.equal(data.issues[0].status, 'Backlog'); assert.deepEqual(data.active, []); assert.equal(f.writes.length, 0);
  f.partial(); await assert.rejects(readCatalog(f.lease, f.lease, workspace), /partial-access/);
  const conflict = fixture(); conflict.active(); await assert.rejects(readCatalog(conflict.lease, conflict.lease, workspace), /issue-state-conflict/);
});
test('Issue creation detects silently dropped labels; PM Ready uses narrow additions and exact removal', async () => {
  const f = fixture(), values = { title: 'Preserve my work', labels: ['type:feature'] };
  assert.equal((await createIssue(f.lease, workspace, values, 'Acceptance')).number, 8);
  f.drop(); await assert.rejects(createIssue(f.lease, workspace, values, 'Acceptance'), /readback-mismatch/);
  await setReady(f.lease, workspace, { number: 7 }, true); await setReady(f.lease, workspace, { number: 7 }, false);
  assert.deepEqual(f.writes.at(-2).body, { labels: ['Ready for Development'] });
  assert.equal(f.writes.at(-1).method, 'DELETE'); assert.match(f.writes.at(-1).path, /Ready%20for%20Development$/);
});
test('non-closing PR references display their own repository and current check head without inventing release evidence', async () => {
  const f = fixture(), detail = await readDetail(f.lease, workspace, 7);
  assert.equal(detail.pullRequests[0].relationship, 'referenced'); assert.equal(detail.pullRequests[0].repositoryName, 'fixture/repo');
  assert.equal(detail.pullRequests[0].checks.current, true); assert.equal(detail.pullRequests[0].checks.results[0].state, 'SUCCESS');
  assert.equal(detail.releaseEvidence.status, 'unavailable');
});
