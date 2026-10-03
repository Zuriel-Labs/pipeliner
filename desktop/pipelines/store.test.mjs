import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStore } from '../repositories/store.mjs';

test('pipeline draft migration retains a readable private v2 backup and scopes drafts across reopen and discard', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-40-drafts-'))); let store;
  t.after(() => { store?.close(); rmSync(root, { recursive: true }); assert(!existsSync(root)); });
  store = openWorkspaceStore(root);
  store.register({ id: 'repo_one', repositoryId: 'R1', slug: 'fixture/one', localKey: '1:2', path: root, project: { id: 'P1' } });
  store.saveIssueContext('repo_one', { selected: 7 }); store.observeReady('repo_one', 'I7', true, 1000); store.close(); store = null;
  const legacy = new DatabaseSync(join(root, 'workspaces.sqlite'));
  legacy.exec('DROP TABLE schedule_states; DROP TABLE pipeline_drafts; PRAGMA user_version=2;'); legacy.close();
  store = openWorkspaceStore(root);
  const backupPath = readdirSync(root).find(name => /^workspaces-v2-[a-f0-9-]+\.sqlite$/.test(name)); assert(backupPath);
  const backup = new DatabaseSync(join(root, backupPath), { readOnly: true });
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2); assert.equal(JSON.parse(backup.prepare('SELECT data FROM issue_contexts').get().data).selected, 7);
    assert.equal(backup.prepare('SELECT ready FROM issue_ready').get().ready, 1); } finally { backup.close(); }
  store.savePipelineDraft('repo_one', 'development', { baseRevision: 1, value: 'Repository draft' });
  store.savePipelineDraft(null, 'development', { baseRevision: 2, value: 'Global draft' });
  store.savePipelineDraft('repo_one', 'release', { baseRevision: 3, value: 'Release draft' });
  assert.throws(() => store.savePipelineDraft('unknown', 'development', {}), /workspace-unavailable/);
  assert.throws(() => store.savePipelineDraft('repo_one', 'unknown', {}), /pipeline-kind-invalid/);
  store.close(); store = openWorkspaceStore(root);
  assert.equal(store.issueContext('repo_one').selected, 7);
  assert.equal(store.pipelineDraft('repo_one', 'development').value, 'Repository draft');
  assert.equal(store.pipelineDraft(null, 'development').value, 'Global draft');
  store.clearPipelineDraft('repo_one', 'development');
  assert.equal(store.pipelineDraft('repo_one', 'development'), null);
  assert.equal(store.pipelineDraft('repo_one', 'release').value, 'Release draft');
  assert.equal(store.pipelineDraft(null, 'development').value, 'Global draft');
});
