import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestVault } from '../connections/test-vault.mjs';
import { verifyProtectedBackup } from '../privacy/backup.mjs';
import { legacyDevelopment } from './legacy-fixture.mjs';
import { canonicalJSON, developmentTemplate } from '../core/settings.mjs';
import { openDevelopmentStore } from './state.mjs';

const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const source = { sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40) };
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-protected-development-'))), vault = await openTestVault(root);
  t.after(() => { vault.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); });
  return { root, vault };
}
function legacy(root, wal = false) {
  const run = { id: 'run-one', repository: 'repo-one', issue: 1, dev: 'dev-one', policyRevision: 1, policyHash: 'c'.repeat(64), pipelineHash: hash(developmentTemplate), limits: { 'limits.stepTurns': 3, 'limits.issueTurns': 5, 'limits.agentSeconds': 1800 } };
  const captured = { run, pipeline: structuredClone(developmentTemplate), source, developer: { id: run.dev, connection: 'ollama', model: 'test-model' }, skillsHash: 'd'.repeat(64), issueHash: 'e'.repeat(64), checks: [{ name: 'Private check marker', command: 'node --test' }], logBytes: 1048576 };
  const state = { runId: run.id, epoch: 3, step: 'research', state: 'executing', candidate: source, visits: { research: 2 }, retries: {}, visit: 2, turns: 2, stepTurns: 2,
    budgets: { research: { turns: 2, spentMs: 400, activeAt: null } }, attempts: {}, remediationCycles: 1, developer: run.dev, takeovers: [], budgetClock: 1000, usage: { input: 2, output: 3, unavailable: false }, message: 'Private state marker' };
  const request = { id: 'source', runId: run.id, epoch: 3, step: 'research', visit: 2, kind: 'source', candidate: source, payload: { text: 'Private request marker' } };
  const result = { candidate: source, result: { text: 'Private reply marker' } }, output = { outcome: 'failure', summary: 'Private output marker', evidence: [], documents: [], findings: [] };
  legacyDevelopment(root, { captured, state, requests: [{ document: request, state: 'uncertain', result }], outputs: [{ run: run.id, visit: 1, step: 'research', candidate: source, output }] }, { wal });
  return { captured, state, request, result, output, binding: { runId: run.id, epoch: 3 } };
}
test('Development protection is mandatory before creating storage', async t => {
  const f = await fixture(t), path = join(f.root, 'development.sqlite');
  assert.throws(() => openDevelopmentStore(f.root), /protected-record-unavailable/); assert.equal(existsSync(path), false);
  f.vault.close(); assert.throws(() => openDevelopmentStore(f.root, { vault: f.vault }), /protected-record-unavailable/); assert.equal(existsSync(path), false);
});
test('actual legacy Development migration preserves budgets, candidates, uncertain evidence and documents without replay', async t => {
  const f = await fixture(t), data = legacy(f.root), path = join(f.root, 'development.sqlite'), before = readFileSync(path);
  const store = openDevelopmentStore(f.root, { vault: f.vault });
  try {
    assert.deepEqual(store.captured('run-one'), data.captured); assert.deepEqual(store.status('run-one'), data.state);
    assert.deepEqual(store.evidence(data.binding)[0], { ...data.request, state: 'uncertain', result: data.result }); assert.equal(store.dispatch(data.binding, 'source'), false);
    assert.deepEqual(store.outputs('run-one')[0], { step: 'research', visit: 1, candidate: source, output: data.output });
    assert.throws(() => store.rebind('run-one', 4), /recovery/);
    assert.deepEqual(store.recovery(), [{ runId: 'run-one', repository: 'repo-one', state: 'executing', uncertainEffects: 1 }]);
  } finally { store.close(); }
  const backup = readdirSync(f.root).find(name => name.endsWith('.pipeliner-backup')); assert(backup);
  assert.equal(verifyProtectedBackup(join(f.root, backup), { vault: f.vault, store: 'development', version: 1 }).sourceHash, createHash('sha256').update(before).digest('hex'));
  for (const name of readdirSync(f.root).filter(name => name.startsWith('development'))) assert.equal(readFileSync(join(f.root, name)).includes('Private '), false, name);
  const reopened = openDevelopmentStore(f.root, { vault: f.vault }); try { assert.deepEqual(reopened.status('run-one'), data.state); } finally { reopened.close(); }
});
test('Development mutable state and result substitutions fail closed; immutable triggers survive migration', async t => {
  const f = await fixture(t); legacy(f.root); openDevelopmentStore(f.root, { vault: f.vault }).close(); const path = join(f.root, 'development.sqlite');
  for (const sql of ["UPDATE development_requests SET state='verified'", "UPDATE development_requests SET result='{}'", "UPDATE development_runs SET state='{}'", "DROP TRIGGER immutable_development_binding; UPDATE development_runs SET repository='other'"]) {
    const before = readFileSync(path), db = new DatabaseSync(path); db.exec(sql); db.close();
    assert.throws(() => openDevelopmentStore(f.root, { vault: f.vault }), /invalid|integrity/); writeFileSync(path, before);
  }
  const db = new DatabaseSync(path); try {
    for (const sql of ["UPDATE development_runs SET captured='{}'", "UPDATE development_runs SET repository='other'", "UPDATE development_requests SET document='{}'", "UPDATE development_outputs SET document='{}'"]) assert.throws(() => db.exec(sql), /Immutable Development/);
  } finally { db.close(); }
});
test('legacy WAL storage checkpoints into a compatible encrypted snapshot and preserves logical recovery', async t => {
  const f = await fixture(t), data = legacy(f.root, true), path = join(f.root, 'development.sqlite');
  assert.equal(readFileSync(path).readUInt8(18), 2);
  const store = openDevelopmentStore(f.root, { vault: f.vault }); try { assert.deepEqual(store.status('run-one'), data.state); } finally { store.close(); }
  const backup = readdirSync(f.root).find(name => name.endsWith('.pipeliner-backup')); assert(backup);
  assert.equal(verifyProtectedBackup(join(f.root, backup), { vault: f.vault, store: 'development', version: 1 }).schemaVersion, 1);
  assert.equal(existsSync(path + '-wal'), false); assert.equal(existsSync(path + '-shm'), false);
});
test('encrypted request and control bytes obey the captured log ceiling without affecting another run', async t => {
  const f = await fixture(t), data = legacy(f.root), store = openDevelopmentStore(f.root, { vault: f.vault });
  try {
    store.finish(data.binding, 'source', { candidate: source, result: {} });
    const value = 'x'.repeat(500000), request = store.prepare(data.binding, 'large', 'source', { text: value });
    store.dispatch(data.binding, request.id); store.finish(data.binding, request.id, { candidate: source, result: { text: value } });
    assert.throws(() => store.prepare(data.binding, 'over-limit', 'source', {}), /log limit/);
    assert.equal(store.evidence(data.binding).some(row => row.id === 'over-limit'), false); assert.equal(store.status('run-one').turns, 2);
    const { run: originalRun, ...settings } = data.captured;
    store.create({ ...originalRun, id: 'other-run', epoch: 1 }, settings); const other = { runId: 'other-run', epoch: 1 }; store.begin(other);
    assert.equal(store.prepare(other, 'small', 'source', {}).state, 'prepared');
  } finally { store.close(); }
});
test('failed Development sealing rolls back the original and keeps an authenticated compatible snapshot', async t => {
  const f = await fixture(t); legacy(f.root); const path = join(f.root, 'development.sqlite'), before = readFileSync(path);
  const failing = { ...f.vault, sealPayload(binding, bytes) { if (binding.purpose === 'development' && bytes.length) throw Error('synthetic seal failure'); return f.vault.sealPayload(binding, bytes); } };
  assert.throws(() => openDevelopmentStore(f.root, { vault: failing }), /migration-failed/); assert.deepEqual(readFileSync(path), before);
  const backup = readdirSync(f.root).find(name => name.endsWith('.pipeliner-backup')); assert(backup);
  assert.equal(verifyProtectedBackup(join(f.root, backup), { vault: f.vault, store: 'development', version: 1 }).sourceHash, createHash('sha256').update(before).digest('hex'));
  openDevelopmentStore(f.root, { vault: f.vault }).close();
});
