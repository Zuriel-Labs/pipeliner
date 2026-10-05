import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openTestVault } from '../connections/test-vault.mjs';
import { legacyWorkspace } from '../repositories/legacy-fixture.mjs';
import { verifyProtectedBackup } from '../privacy/backup.mjs';

test('pipeline draft migration retains an authenticated encrypted v2 backup and scopes drafts across reopen and discard', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-40-drafts-'))); let store;
  const vault = await openTestVault(root);
  t.after(() => { store?.close(); vault.close(); rmSync(root, { recursive: true }); assert(!existsSync(root)); });
  legacyWorkspace(root, 2, { workspaces: [{ id: 'repo_one', repositoryId: 'R1', slug: 'fixture/one', localKey: '1:2', path: root, project: { id: 'P1' } }],
    issues: { repo_one: { selected: 7 } }, ready: [{ repository: 'repo_one', issue: 'I7', ready: true, observedAt: 1000 }] });
  const originalHash = createHash('sha256').update(readFileSync(join(root, 'workspaces.sqlite'))).digest('hex');
  store = openWorkspaceStore(root, { vault });
  const backupPath = readdirSync(root).find(name => /^workspaces-v2-[a-f0-9-]+\.pipeliner-backup$/.test(name)); assert(backupPath);
  assert.equal(verifyProtectedBackup(join(root, backupPath), { vault, store: 'workspaces', version: 2 }).sourceHash, originalHash);
  assert.equal(store.observeReady('repo_one', 'I7', true, 1001).drift, false);
  store.savePipelineDraft('repo_one', 'development', { baseRevision: 1, value: 'Repository draft' });
  store.savePipelineDraft(null, 'development', { baseRevision: 2, value: 'Global draft' });
  store.savePipelineDraft('repo_one', 'release', { baseRevision: 3, value: 'Release draft' });
  assert.throws(() => store.savePipelineDraft('unknown', 'development', {}), /workspace-unavailable/);
  assert.throws(() => store.savePipelineDraft('repo_one', 'unknown', {}), /pipeline-kind-invalid/);
  store.close(); store = openWorkspaceStore(root, { vault });
  assert.equal(store.issueContext('repo_one').selected, 7);
  assert.equal(store.pipelineDraft('repo_one', 'development').value, 'Repository draft');
  assert.equal(store.pipelineDraft(null, 'development').value, 'Global draft');
  store.clearPipelineDraft('repo_one', 'development');
  assert.equal(store.pipelineDraft('repo_one', 'development'), null);
  assert.equal(store.pipelineDraft('repo_one', 'release').value, 'Release draft');
  assert.equal(store.pipelineDraft(null, 'development').value, 'Global draft');
});
