import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, existsSync, copyFileSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestVault } from '../connections/test-vault.mjs';
import { verifyProtectedBackup } from '../privacy/backup.mjs';
import { openWorkspaceStore } from './store.mjs';
import { legacyWorkspace } from './legacy-fixture.mjs';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-protected-workspace-'))), vault = await openTestVault(root);
  t.after(() => { vault.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); });
  return { root, vault };
}
const workspace = (root, id = 'first') => ({ id, repositoryId: 'R_' + id, slug: 'fixture/' + id, localKey: '1:2', path: root, project: { id: 'P1' }, name: 'Private workspace marker' });
test('sensitive workspace storage refuses missing or closed protection before creating a file', async t => {
  const f = await fixture(t), path = join(f.root, 'workspaces.sqlite');
  assert.throws(() => openWorkspaceStore(f.root), /protected-record-unavailable/); assert.equal(existsSync(path), false);
  f.vault.close(); assert.throws(() => openWorkspaceStore(f.root, { vault: f.vault }), /protected-record-unavailable/); assert.equal(existsSync(path), false);
});
for (const version of [1, 2, 3, 4]) test('actual plaintext workspace schema ' + version + ' migrates without data loss or replay', async t => {
  const f = await fixture(t), effect = { id: 'effect-1', job: 'setup', step: 'create', binding: { kind: 'setup', repository: 'first', text: 'Private effect marker' }, state: 'uncertain', result: { text: 'Private result marker' } };
  legacyWorkspace(f.root, version, { workspaces: [workspace(f.root)], draft: { id: 'draft', text: 'Private draft marker' }, selected: 'first', effects: [effect],
    ...(version >= 2 ? { issues: { first: { selected: 7, text: 'Private Issue marker' } }, ready: [{ repository: 'first', issue: 'I7', ready: true, observedAt: 10 }] } : {}),
    ...(version >= 3 ? { pipelines: [{ context: { repository: 'first', kind: 'development' }, value: { text: 'Private pipeline marker' } }] } : {}),
    ...(version >= 4 ? { schedules: { first: { text: 'Private schedule marker' } } } : {}) });
  const original = readFileSync(join(f.root, 'workspaces.sqlite')), hash = createHash('sha256').update(original).digest('hex');
  let store = openWorkspaceStore(f.root, { vault: f.vault });
  try {
    assert.equal(store.selected(), 'first'); assert.equal(store.workspaces()[0].name, 'Private workspace marker'); assert.equal(store.draft().text, 'Private draft marker');
    assert.deepEqual(store.pending()[0], effect); assert.equal(store.dispatch(effect.id), false);
    if (version >= 2) { assert.equal(store.issueContext('first').selected, 7); assert.equal(store.observeReady('first', 'I7', false, 11).drift, true); }
    if (version >= 3) assert.equal(store.pipelineDraft('first', 'development').text, 'Private pipeline marker');
    if (version >= 4) assert.equal(store.schedule('first').text, 'Private schedule marker');
    store.finish(effect.id, 'verified', { text: 'Private final marker' }); store.close(); store = openWorkspaceStore(f.root, { vault: f.vault });
    assert.equal(store.effects('setup')[0].state, 'verified'); assert.equal(store.effects('setup')[0].result.text, 'Private final marker');
    const backup = readdirSync(f.root).find(name => name.endsWith('.pipeliner-backup')); assert(backup);
    assert.equal(verifyProtectedBackup(join(f.root, backup), { vault: f.vault, store: 'workspaces', version }).sourceHash, hash);
    for (const name of readdirSync(f.root).filter(name => name.startsWith('workspaces'))) assert.equal(readFileSync(join(f.root, name)).includes('Private '), false, name);
  } finally { store.close(); }
});
test('workspace ciphertext binds mutable effect state, Ready observations, repository metadata and selection', async t => {
  const f = await fixture(t); let store = openWorkspaceStore(f.root, { vault: f.vault });
  store.register(workspace(f.root)); store.select('first'); store.observeReady('first', 'I7', true, 10);
  const effect = store.prepare('setup', 'create', { repository: 'first' }); store.dispatch(effect.id); store.close();
  for (const sql of ["UPDATE setup_effects SET state='verified'", 'UPDATE issue_ready SET ready=0', "UPDATE workspaces SET slug='fixture/changed'", 'UPDATE workspace_selection SET workspace=NULL']) {
    const db = new DatabaseSync(join(f.root, 'workspaces.sqlite')), before = readFileSync(join(f.root, 'workspaces.sqlite'));
    db.exec(sql); db.close(); assert.throws(() => openWorkspaceStore(f.root, { vault: f.vault }), /invalid/);
    // Restore only this owned fixture, after the rejected store closes.
    writeFileSync(join(f.root, 'workspaces.sqlite'), before);
  }
});
test('historical compatible snapshots become verified encrypted originals; linked and unrelated files remain untouched', async t => {
  const f = await fixture(t); legacyWorkspace(f.root, 3, { workspaces: [workspace(f.root)], issues: { first: { text: 'Private older snapshot marker' } } });
  const source = join(f.root, 'workspaces.sqlite'), snapshot = join(f.root, 'workspaces-v3-11111111-1111-1111-1111-111111111111.sqlite');
  copyFileSync(source, snapshot); const hash = createHash('sha256').update(readFileSync(snapshot)).digest('hex');
  const other = join(f.root, 'unrelated.sqlite'); writeFileSync(other, 'Preserve unrelated bytes', { mode: 0o600 });
  const store = openWorkspaceStore(f.root, { vault: f.vault }); store.close(); assert.equal(existsSync(snapshot), false); assert.equal(readFileSync(other, 'utf8'), 'Preserve unrelated bytes');
  const backups = readdirSync(f.root).filter(name => name.endsWith('.pipeliner-backup'));
  assert.equal(backups.length, 2); for (const name of backups) assert.equal(verifyProtectedBackup(join(f.root, name), { vault: f.vault, store: 'workspaces', version: 3 }).sourceHash, hash);
  // A hard-linked legacy snapshot is never adopted or removed.
  writeFileSync(snapshot, 'Private linked marker', { mode: 0o600 }); const alias = join(f.root, 'neighbor'); linkSync(snapshot, alias);
  assert.throws(() => openWorkspaceStore(f.root, { vault: f.vault }), /backup-recovery-required/);
  assert.equal(readFileSync(snapshot, 'utf8'), 'Private linked marker'); assert.equal(readFileSync(alias, 'utf8'), 'Private linked marker'); unlinkSync(alias);
});
test('corrupt legacy workspace migration preserves the original schema and verified encrypted backup', async t => {
  const f = await fixture(t); legacyWorkspace(f.root, 4, { workspaces: [workspace(f.root)] });
  const db = new DatabaseSync(join(f.root, 'workspaces.sqlite')); db.exec("UPDATE workspaces SET hash='changed'"); db.close();
  const path = join(f.root, 'workspaces.sqlite'), before = readFileSync(path);
  assert.throws(() => openWorkspaceStore(f.root, { vault: f.vault }), /migration-failed/); assert.deepEqual(readFileSync(path), before);
  const backup = readdirSync(f.root).find(name => name.endsWith('.pipeliner-backup')); assert(backup);
  assert.equal(verifyProtectedBackup(join(f.root, backup), { vault: f.vault, store: 'workspaces', version: 4 }).sourceHash, createHash('sha256').update(before).digest('hex'));
});
test('a forged state cannot hide a pending workspace effect from the running recovery inventory', async t => {
  const f = await fixture(t), store = openWorkspaceStore(f.root, { vault: f.vault });
  try {
    const effect = store.prepare('setup', 'create', { repository: 'first' }); store.dispatch(effect.id);
    const db = new DatabaseSync(join(f.root, 'workspaces.sqlite')); try { db.exec("UPDATE setup_effects SET state='verified'"); } finally { db.close(); }
    assert.throws(() => store.pending(), /invalid/);
  } finally { store.close(); }
});
test('previously supported full-length workspace identifiers remain protected across reopen', async t => {
  const f = await fixture(t), id = '_' + 'a'.repeat(179); let store = openWorkspaceStore(f.root, { vault: f.vault });
  try {
    store.register({ ...workspace(f.root), id }); store.select(id); store.savePipelineDraft(id, 'development', { text: 'Private long identity marker' });
    store.close(); store = openWorkspaceStore(f.root, { vault: f.vault });
    assert.equal(store.selected(), id); assert.equal(store.pipelineDraft(id, 'development').text, 'Private long identity marker');
  } finally { store.close(); }
});
