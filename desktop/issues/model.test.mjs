import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft, draftBody, checkReadyAction } from './model.mjs';
import { issueCommand } from './commands.mjs';

const workspace = { id: 'repo_fixture', repositoryId: 'R1', slug: 'fixture/repo', project: { fields: Object.fromEntries([
  ['Priority', ['P0', 'P1', 'P2', 'P3']], ['Impact', ['High', 'Medium', 'Low']], ['Effort', ['XS', 'S', 'M', 'L', 'XL']],
].map(([role, names]) => [role, { id: 'F-' + role, options: names.map(name => ({ id: 'O-' + name, name })) }])) } };
const values = { title: 'Preserve my work', summary: 'Import without changing existing files.', acceptance: ['Tracked and untracked files remain intact.'], priority: 'P1', impact: 'High', effort: 'M', labels: ['type:feature'], dependencies: [3] };
test('intake preview validates exact metadata and dependencies without granting Ready or interpreting HTML', () => {
  const catalog = { labels: ['type:feature'], issues: [{ number: 3, repositoryId: 'R1' }] };
  assert.deepEqual(validateDraft(values, workspace, catalog), values);
  const body = draftBody({ ...values, title: '<script>untrusted</script>' }, workspace);
  assert.match(body, /color-scheme:dark/); assert.match(body, /&lt;script&gt;untrusted&lt;\/script&gt;/);
  assert.equal(body.includes('<script>'), false); assert.match(body, /Tracked and untracked files remain intact/);
  for (const changed of [{ labels: ['Ready for Development'] }, { labels: [' Ｒｅａｄｙ for Development '] }, { dependencies: [9] }, { priority: 'unknown' }, { acceptance: [] }, { summary: 'ghu_syntheticSecret123' }, { origin: 'pm' }]) {
    assert.throws(() => validateDraft({ ...values, ...changed }, workspace, catalog));
  }
});
test('Ready removal denies all three active statuses, conflicts and incomplete evidence', () => {
  const snapshot = { complete: true, repositoryId: 'R1', active: [], issue: { id: 'I1', repositoryId: 'R1', state: 'OPEN', status: 'Backlog' } };
  assert.equal(checkReadyAction(snapshot, workspace, false), true);
  for (const status of ['In Progress', 'In Review', 'Pending Review']) {
    const live = { ...snapshot, active: [{ id: 'I1', number: 1, status }], issue: { ...snapshot.issue, status } };
    assert.throws(() => checkReadyAction(live, workspace, false), /ready-active/);
    assert.equal(checkReadyAction(live, workspace, true), true);
  }
  for (const live of [{ ...snapshot, complete: false }, { ...snapshot, repositoryId: 'R2' }, { ...snapshot, active: [{ id: 'I2' }, { id: 'I3' }] }, { ...snapshot, issue: { ...snapshot.issue, status: null } }]) assert.throws(() => checkReadyAction(live, workspace, false));
});
test('ordinary Issue controls require explicit unquoted target and never accept a role override', () => {
  assert.deepEqual(issueCommand('Mark Issue #7 Ready'), { operation: 'ready', number: 7, enabled: true });
  assert.deepEqual(issueCommand('Remove Ready from Issue #7'), { operation: 'ready', number: 7, enabled: false });
  assert.equal(issueCommand('Draft an Issue called Keep my files').values.title, 'Keep my files');
  assert.equal(issueCommand('Show Issues').operation, 'refresh');
  for (const text of ['"Mark Issue #7 Ready"', '> Remove Ready from Issue #7', 'Mark the other repository Ready', 'ghu_syntheticSecret123']) assert.equal(issueCommand(text), null);
});
