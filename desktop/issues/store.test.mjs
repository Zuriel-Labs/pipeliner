import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStore } from '../repositories/store.mjs';

test('workspace migration preserves setup evidence and separates repository Issue context and Ready drift', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-38-store-'))); let store;
  const workspace = id => ({ id, repositoryId: 'R_' + id, slug: 'fixture/' + id, localKey: id === 'first' ? '1:2' : '1:3', path: root, project: { id: 'P1' } });
  try {
    store = openWorkspaceStore(root); store.register(workspace('first')); store.register(workspace('second')); store.select('first');
    store.saveDraft({ id: 'setup', state: 'choosing' }); store.close(); store = null;
    const legacy = new DatabaseSync(join(root, 'workspaces.sqlite'));
    legacy.exec('DROP TABLE schedule_states; DROP TABLE issue_contexts; DROP TABLE issue_ready; DROP TABLE pipeline_drafts; PRAGMA user_version=1;'); legacy.close();
    store = openWorkspaceStore(root);
    assert.equal(store.selected(), 'first'); assert.equal(store.workspaces().length, 2); assert.equal(store.draft().id, 'setup');
    store.saveIssueContext('first', { selected: 7, draft: { title: 'First repository' } });
    store.saveIssueContext('second', { selected: 9 });
    assert.throws(() => store.saveIssueContext('missing', {}), /workspace-unavailable/);
    assert.equal(store.observeReady('first', 'I7', false, 1).drift, false);
    assert.equal(store.observeReady('first', 'I7', true, 2).drift, true);
    assert.equal(store.observeReady('first', 'I7', false, 3, true).drift, false);
    assert.equal(store.observeReady('second', 'I7', true, 4).drift, false);
    for (const kind of ['setup', 'issue']) {
      const effect = store.prepare(kind, 'write', { kind, repository: 'first' }); assert.equal(store.dispatch(effect.id), true);
    }
    assert.equal(store.pending('setup').length, 1); assert.equal(store.pending('issue').length, 1);
    store.close(); store = openWorkspaceStore(root);
    assert.equal(store.issueContext('first').selected, 7); assert.equal(store.issueContext('second').selected, 9);
    assert.equal(store.pending('issue')[0].state, 'dispatched');
    assert.equal(store.observeReady('first', 'I7', true, 5).drift, true);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});
