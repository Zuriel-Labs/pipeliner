import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevelopmentNotices } from './notices.mjs';

const state = (extra = {}) => ({ workspaceId: 'repoA', run: { id: 'runA', issue: 54, control: 'running' }, development: { state: 'executing' }, error: null, qa: null, ...extra });
test('optional notices require recorded meaningful transitions and deduplicate unchanged checks', () => {
  const notices = createDevelopmentNotices();
  assert.equal(notices.observe(state()), null);
  const waiting = state({ qa: { hash: 'candidateA', decision: null } });
  assert.deepEqual(notices.observe(waiting), { target: 'repoA', title: 'Issue #54 · PM Testing is ready', kind: 'action' });
  assert.equal(notices.observe({ ...waiting, revision: 100 }), null);
  assert.equal(notices.observe(state({ qa: { hash: 'candidateA', decision: 'approve' } })), null);
  assert.equal(notices.observe(state({ qa: { hash: 'candidateA', decision: 'approve' }, development: { state: 'candidate' } })), null);
  assert.equal(notices.observe(waiting), null);
  assert.equal(notices.observe(state({ qa: { hash: 'candidateB', decision: null } })).kind, 'action');
  assert.deepEqual(notices.observe(state({ error: 'A private provider string must not enter the notice' })), { target: 'repoA', title: 'Issue #54 · Development needs attention', kind: 'failure' });
  assert.equal(notices.observe(state({ error: 'Different provider output' })), null);
  assert.equal(notices.observe(state({ development: { state: 'candidate' } })).kind, 'ready');
  assert.equal(notices.observe(state({ development: { state: 'executing' } })), null);
  assert.equal(notices.observe(state({ development: { state: 'candidate' } })), null);
});
test('notice identity stays within repository/run; disabled output consumes events rather than replaying them', () => {
  const notices = createDevelopmentNotices(), failed = state({ error: 'bounded error' });
  assert.equal(notices.observe(failed, false), null);
  assert.equal(notices.observe(failed, true), null);
  assert.equal(notices.observe({ ...failed, workspaceId: 'repoB' }, true).target, 'repoB');
  assert.equal(notices.observe(state({ error: 'bounded error', run: { id: 'runB', issue: 55 } })).title, 'Issue #55 · Development needs attention');
  for (const snapshot of [state({ workspaceId: null }), state({ run: null }), state({ run: { id: 'run', issue: 'untrusted' } }), state({ qa: { hash: {}, decision: null } })]) assert.equal(notices.observe(snapshot), null);
  // Switching to another repository's first observed active run stays quiet.
  assert.equal(notices.observe(state({ workspaceId: 'repoC' })), null);
});
