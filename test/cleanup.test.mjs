import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestWorkspace, removeTestWorkspace, cleanupComplete } from '../scripts/lib/cleanup.mjs';

test('success and failed-run cleanup remove only the owned workspace', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-cleanup-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sentinel = path.join(parent, 'unrelated'); await writeFile(sentinel, 'keep');
  for (const failed of [false, true]) {
    const workspace = await createTestWorkspace(parent);
    try { await writeFile(path.join(workspace.path, 'artifact'), 'test'); if (failed) throw new Error('suite failure'); }
    catch (error) { assert.equal(error.message, 'suite failure'); }
    finally { await removeTestWorkspace(workspace); }
    await assert.rejects(readFile(path.join(workspace.path, 'artifact')), /ENOENT/);
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});
test('cleanup rejects forged ownership and a substituted symlink', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-cleanup-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = await createTestWorkspace(parent);
  await assert.rejects(removeTestWorkspace({ ...workspace, token: 'wrong' }), /ownership/);
  await rm(workspace.path, { recursive: true });
  await symlink(parent, workspace.path);
  await assert.rejects(removeTestWorkspace(workspace), /symlink/);
});
test('PM retention and cleanup failure block until exact resources are removed', () => {
  const resource = { kind: 'container', id: 'exact-id', run: 'run-1', owner: 'dev', status: 'retained', cleanupTrigger: 'after PM' };
  assert.equal(cleanupComplete({ verified: true, evidence: 'inspect', resources: [resource] }), false);
  assert.equal(cleanupComplete({ verified: true, evidence: 'inspect', resources: [{ ...resource, status: 'removed', evidence: 'not found by exact ID' }] }), true);
  assert.equal(cleanupComplete({ verified: false, evidence: 'failed', resources: [] }), false);
});
