import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planOperation, readProject, verifyReadback } from './operations.mjs';

const scope = { repository: { owner: 'fixture-owner', name: 'fixture-repo', id: 'R_fixture' },
  issue: { number: 7, id: 'I_fixture' }, project: { id: 'PVT_fixture', itemId: 'PVTI_fixture',
    statusFieldId: 'PVTSSF_fixture', statuses: { Backlog: 'backlog-id', 'In Progress': 'progress-id',
      'In Review': 'review-id', 'Pending Review': 'pending-id', Done: 'done-id' } },
  pullRequest: { number: 9, id: 'PR_fixture', head: 'a'.repeat(40) },
  mergeAuthorizedHead: 'a'.repeat(40), runId: 'run-fixture', epoch: 3, policyVersion: 2 };
const live = { complete: true, repositoryId: 'R_fixture', issueId: 'I_fixture', issueState: 'OPEN',
  status: 'In Progress', labels: ['Ready for Development', 'ordinary'], head: 'a'.repeat(40),
  pullRequestId: 'PR_fixture', checksHead: 'a'.repeat(40), checksPassed: true,
  projectId: scope.project.id, itemId: scope.project.itemId, statusFieldId: scope.project.statusFieldId,
  activeIssueIds: ['I_fixture'] };
const request = (operation, payload = {}) => ({ operation, payload, repositoryId: scope.repository.id,
  issueId: scope.issue.id, runId: scope.runId, epoch: scope.epoch, policyVersion: scope.policyVersion });

test('typed ordinary Issue operations produce one exact repository path', () => {
  assert.deepEqual(planOperation(request('issue-edit', { title: 'Updated title' }), scope, live),
    { method: 'PATCH', path: '/repos/fixture-owner/fixture-repo/issues/7', body: { title: 'Updated title' } });
  const labels = planOperation(request('labels-add', { labels: ['new-label'] }), scope, live);
  assert.equal(labels.method, 'POST');
  assert.deepEqual(labels.body.labels, ['new-label']);
  assert.throws(() => planOperation(request('labels-replace', { labels: ['new-label'] }), scope, live), /operation-denied/);
  const removal = planOperation(request('label-remove', { label: 'ordinary/label' }), scope, live);
  assert.equal(removal.path, '/repos/fixture-owner/fixture-repo/issues/7/labels/ordinary%2Flabel');
  const status = planOperation(request('project-status', { status: 'In Review' }), scope, live);
  assert.equal(status.path, '/graphql');
  assert.equal(status.body.variables.option, 'review-id');
  assert.equal(status.body.variables.project, 'PVT_fixture');
});

test('wrong target, stale worker/policy and incomplete state deny before mutation', () => {
  for (const changed of [{ repositoryId: 'R_other' }, { issueId: 'I_other' }, { runId: 'other' },
    { epoch: 2 }, { policyVersion: 1 }, { actor: 'pm' }]) {
    assert.throws(() => planOperation({ ...request('issue-edit', { title: 'Updated' }), ...changed }, scope, live));
  }
  for (const changed of [{ complete: false }, { repositoryId: 'R_other' }, { issueId: 'I_other' },
    { issueState: 'CLOSED' }, { status: 'Unknown' }, { projectId: 'PVT_other' },
    { itemId: 'PVTI_other' }, { activeIssueIds: ['I_fixture', 'I_other'] }, { activeIssueIds: [] }]) {
    assert.throws(() => planOperation(request('issue-edit', { title: 'Updated' }), scope, { ...live, ...changed }));
  }
  for (const key of ['id', 'itemId', 'statusFieldId']) {
    const incomplete = { ...scope, project: { ...scope.project, [key]: undefined } };
    const liveKey = { id: 'projectId', itemId: 'itemId', statusFieldId: 'statusFieldId' }[key];
    assert.throws(() => planOperation(request('issue-edit', { title: 'Updated' }), incomplete,
      { ...live, [liveKey]: undefined }), /invalid-scope/);
  }
});

test('agent Ready edits, metadata injection and generic API routes are rejected', () => {
  for (const operation of ['pm-ready', 'http', 'graphql', 'shell']) {
    assert.throws(() => planOperation(request(operation), scope, live), /operation-denied/);
  }
  for (const payload of [{ title: 'Updated', labels: [] }, { title: 'Updated', url: 'https://evil.invalid' },
    { title: 'Updated', assignees: ['other'] }]) {
    assert.throws(() => planOperation(request('issue-edit', payload), scope, live));
  }
  for (const labels of [['Ready for Development'], ['ready for development'], [' READY FOR DEVELOPMENT '], ['a', 'a']]) {
    assert.throws(() => planOperation(request('labels-add', { labels }), scope, live));
  }
  assert.throws(() => planOperation(request('label-remove', { label: 'Ready for Development' }), scope, live));
  assert.throws(() => planOperation(request('project-status', { status: 'On Hold' }), scope, live));
});

test('merge requires unchanged candidate and verified current checks', () => {
  const expected = live.head;
  const plan = planOperation(request('pr-merge', { number: 9, head: expected }), scope, live);
  assert.equal(plan.body.sha, expected);
  assert.equal(plan.path, '/repos/fixture-owner/fixture-repo/pulls/9/merge');
  assert.throws(() => planOperation(request('pr-merge', { number: 9, head: 'b'.repeat(40) }), scope, live));
  assert.throws(() => planOperation(request('pr-merge', { number: 9, head: expected }), scope, { ...live, checksPassed: false }));
  assert.throws(() => planOperation(request('pr-merge', { number: 10, head: expected }), scope, live));
  assert.throws(() => planOperation(request('pr-merge', { number: 9, head: expected }), scope, { ...live, checksHead: 'b'.repeat(40) }));
  assert.throws(() => planOperation(request('pr-merge', { number: 9, head: expected }), { ...scope, mergeAuthorizedHead: null }, live));
});

test('verified readback compares exact identity and values without treating missing data as success', () => {
  assert.equal(verifyReadback({ id: 'I_fixture', title: 'Updated' }, { id: 'I_fixture', title: 'Updated' }), true);
  assert.throws(() => verifyReadback({ id: 'I_other', title: 'Updated' }, { id: 'I_fixture', title: 'Updated' }));
  assert.throws(() => verifyReadback(null, { id: 'I_fixture' }));
});

test('Project pagination reuses complete-connection validation and rejects partial GraphQL', async () => {
  const calls = [];
  const result = await readProject(scope.project.id, async (query, variables) => {
    calls.push({ query, variables });
    const index = variables.cursor ? 1 : 0;
    return { data: { node: { id: scope.project.id, items: { totalCount: 2,
      nodes: [{ id: `item-${index}`, content: { id: `issue-${index}`, repository: { id: 'R_fixture' } },
        fieldValues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }],
      pageInfo: { hasNextPage: index === 0, endCursor: index === 0 ? 'next' : null } } } } };
  });
  assert.equal(result.length, 2);
  assert.equal(calls[1].variables.cursor, 'next');
  await assert.rejects(readProject(scope.project.id, async () => ({ errors: [{ message: 'private' }], data: {} })), /partial-project/);
  await assert.rejects(readProject(scope.project.id, async () => ({ data: { node: { id: 'PVT_other' } } })), /project-identity/);
  await assert.rejects(readProject(scope.project.id, async () => ({ data: { node: { id: scope.project.id,
    items: { totalCount: 1, nodes: [{ id: 'partial', content: { repository: { id: 'R_fixture' } },
      fieldValues: { totalCount: 1, nodes: [], pageInfo: { hasNextPage: false } } }],
    pageInfo: { hasNextPage: false } } } } })), /incomplete-project-item/);
});
