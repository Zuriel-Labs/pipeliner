import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openTestVault } from '../connections/test-vault.mjs';
import { legacyWorkspace } from '../repositories/legacy-fixture.mjs';
import { createRecordCodec } from '../privacy/records.mjs';

test('workspace migration preserves setup evidence and separates repository Issue context and Ready drift', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-38-store-'))); let store;
  const vault = await openTestVault(root);
  const workspace = id => ({ id, repositoryId: 'R_' + id, slug: 'fixture/' + id, localKey: id === 'first' ? '1:2' : '1:3', path: root, project: { id: 'P1' } });
  try {
    legacyWorkspace(root, 1, { workspaces: [workspace('first'), workspace('second')], selected: 'first', draft: { id: 'setup', state: 'choosing' } });
    store = openWorkspaceStore(root, { vault });
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
    store.close(); store = openWorkspaceStore(root, { vault });
    assert.equal(store.issueContext('first').selected, 7); assert.equal(store.issueContext('second').selected, 9);
    assert.equal(store.pending('issue')[0].state, 'dispatched');
    assert.equal(store.observeReady('first', 'I7', true, 5).drift, true);
  } finally { store?.close(); vault.close(); rmSync(root, { recursive: true, force: true }); }
});

test('complete protected Ready catalogs commit together and roll back malformed or unauthenticated rows', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-ready-catalog-'))), vault = await openTestVault(root);
  let store, db;
  try {
    store = openWorkspaceStore(root, { vault });
    for (const [index, id] of ['first', 'second'].entries()) store.register({ id, repositoryId: 'R_' + id, slug: 'fixture/' + id,
      localKey: '1:' + (index + 2), path: root, project: { id: 'P1' } });
    const rows = Array.from({ length: 400 }, (_, i) => ({ issue: 'I' + i, ready: false, own: false }));
    assert.equal(store.observeReadyBatch('first', rows, 1).filter(value => value.drift).length, 0);
    assert.equal(store.observeReadyBatch('second', rows.map(row => ({ ...row, ready: true })), 1).filter(value => value.drift).length, 0);
    const changed = rows.map((row, i) => ({ ...row, ready: true, own: i === 0 })), results = store.observeReadyBatch('first', changed, 2);
    assert.equal(results.length, rows.length); assert.deepEqual(results[0], { ready: true, drift: false });
    assert(results.slice(1).every(value => value.ready && value.drift));
    db = new DatabaseSync(join(root, 'workspaces.sqlite'), { allowExtension: false });
    const read = repository => db.prepare('SELECT * FROM issue_ready WHERE repository=? ORDER BY issue').all(repository);
    const before = read('first'), other = read('second'), codec = createRecordCodec(vault, 'workspace');
    for (const row of before) assert.deepEqual(codec.decode({ repository: row.repository, table: 'issue_ready', key: row.issue }, row.payload),
      { ready: 1, observedAt: 2 });
    for (const invalid of [[...rows, { issue: 'late', ready: 'false', own: false }], [...rows, rows[0]],
      [{ issue: 'I0', ready: false, own: false, authority: true }], Array(10001).fill(rows[0])]) {
      assert.throws(() => store.observeReadyBatch('first', invalid, 3), /setup-record-invalid/);
      assert.deepEqual(read('first'), before);
    }
    assert.throws(() => store.observeReadyBatch('missing', rows, 3)); assert.deepEqual(read('first'), before);
    const last = before.at(-1), damaged = Buffer.from(last.payload); damaged[damaged.length - 1] ^= 1;
    db.prepare('UPDATE issue_ready SET payload=? WHERE repository=? AND issue=?').run(damaged, 'first', last.issue);
    const corrupt = read('first');
    await assert.rejects(async () => store.observeReadyBatch('first', rows, 3), /protected-record-invalid/);
    assert.deepEqual(read('first'), corrupt); assert.deepEqual(read('second'), other);
    db.prepare('UPDATE issue_ready SET payload=? WHERE repository=? AND issue=?').run(last.payload, 'first', last.issue);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    db.close(); db = undefined; store.close(); store = openWorkspaceStore(root, { vault });
    assert.equal(store.observeReady('first', 'I0', false, 4).drift, true);
    assert.equal(store.observeReady('second', 'I0', true, 4).drift, false);
    assert.equal(store.observeReadyBatch('first', [], 5).length, 0);
  } finally { db?.close(); store?.close(); vault.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});
