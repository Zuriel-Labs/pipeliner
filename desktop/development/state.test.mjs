import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJSON, developmentTemplate } from '../core/settings.mjs';
import { openDevelopmentStore, documentHTML } from './state.mjs';

const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const source = { sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40) };
function fixture(edit = () => {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-state-')));
  const pipeline = structuredClone(developmentTemplate);
  edit(pipeline);
  const run = { id: 'run-one', repository: 'repo-one', issue: 1, dev: 'dev-one', epoch: 1, policyRevision: 1,
    policyHash: 'c'.repeat(64), pipelineHash: hash(pipeline), limits: { 'limits.stepTurns': 3, 'limits.issueTurns': 5, 'limits.agentSeconds': 1800 } };
  const captured = { pipeline, source, developer: { id: run.dev, connection: 'ollama', model: 'test-model' }, skillsHash: 'd'.repeat(64), issueHash: 'e'.repeat(64), checks: [{ name: 'Repository checks', command: 'node --test' }], logBytes: 1048576 };
  let store = openDevelopmentStore(directory); store.create(run, captured);
  return { run, captured, directory, binding: { runId: run.id, epoch: 1 }, get store() { return store; }, reopen() { store.close(); store = openDevelopmentStore(directory); }, cleanup() { store.close(); rmSync(directory, { recursive: true }); } };
}
const output = evidence => ({ outcome: 'success', summary: 'Verified source examined.', evidence, documents: [], findings: [] });

test('persisted dispatch cannot replay after crash; stale epochs and forged evidence fail', () => {
  const f = fixture();
  try {
    f.store.begin(f.binding);
    const request = f.store.prepare(f.binding, 'source-read', 'source', { path: 'app.mjs' });
    assert.equal(f.store.dispatch(f.binding, request.id), true);
    f.reopen();
    assert.equal(f.store.dispatch(f.binding, request.id), false);
    assert.throws(() => f.store.begin(f.binding), /recovery|pending/i);
    assert.throws(() => f.store.advance(f.binding, output(['fabricated'])), /evidence/i);
    assert.throws(() => f.store.finish({ runId: 'run-one', epoch: 2 }, request.id, { candidate: source, result: 'source' }), /epoch/i);
    f.store.finish(f.binding, request.id, { candidate: source, result: { inspected: true } });
    const evidence = f.store.evidence(f.binding);
    assert.equal(evidence[0].state, 'verified');
    assert.equal(f.store.advance(f.binding, output([request.id])).step, 'implement');
    assert.equal(f.store.status('run-one').turns, 0);
  } finally { f.cleanup(); }
});

test('graph failure uses finite retries and visits; reopening never resets model budget', () => {
  const f = fixture();
  try {
    f.store.begin(f.binding); f.store.turn(f.binding); f.store.turn(f.binding); f.reopen();
    assert.equal(f.store.status('run-one').turns, 2);
    f.store.turn(f.binding);
    assert.throws(() => f.store.turn(f.binding), /turn/i);
    const failed = f.store.advance(f.binding, { ...output([]), outcome: 'failure', summary: 'Required evidence unavailable.' });
    assert.equal(failed.state, 'blocked'); assert.equal(failed.step, 'blocked');
    assert.throws(() => f.store.begin(f.binding), /blocked/i);
  } finally { f.cleanup(); }
});

test('check outcomes and model success bind to actual evidence for the unchanged candidate', () => {
  const f = fixture();
  try {
    f.store.begin(f.binding);
    const old = f.store.prepare(f.binding, 'read', 'source', { path: 'app.mjs' });
    f.store.dispatch(f.binding, old.id); f.store.finish(f.binding, old.id, { candidate: source, result: {} });
    f.store.setCandidate(f.binding, { ...source, gitTree: 'e'.repeat(40) });
    assert.throws(() => f.store.advance(f.binding, output([old.id])), /candidate/i);
    const fresh = f.store.prepare(f.binding, 'read-again', 'source', { path: 'app.mjs' });
    f.store.dispatch(f.binding, fresh.id);
    f.store.finish(f.binding, fresh.id, { candidate: { ...source, gitTree: 'e'.repeat(40) }, result: {} });
    assert.equal(f.store.advance(f.binding, output([fresh.id])).step, 'implement');
    f.store.begin(f.binding);
    const implementation = f.store.prepare(f.binding, 'write', 'implementation', { path: 'app.mjs' });
    f.store.dispatch(f.binding, implementation.id); f.store.finish(f.binding, implementation.id, { candidate: { ...source, gitTree: 'e'.repeat(40) }, result: {} });
    f.store.advance(f.binding, output([implementation.id])); f.store.begin(f.binding);
    assert.throws(() => f.store.advance(f.binding, output([implementation.id])), /check|test/i);
    const checks = f.store.prepare(f.binding, 'check', 'tests', { command: 'node --test' });
    f.store.dispatch(f.binding, checks.id); f.store.finish(f.binding, checks.id, { candidate: { ...source, gitTree: 'e'.repeat(40) }, result: { name: 'Repository checks', command: 'node --test', exitCode: 1 } });
    assert.throws(() => f.store.advance(f.binding, output([checks.id])), /check|test/i);
  } finally { f.cleanup(); }
});

test('agent output cannot add control fields or supply unsafe human HTML', () => {
  const f = fixture();
  try {
    f.store.begin(f.binding);
    assert.throws(() => f.store.advance(f.binding, { ...output([]), apply: { permissions: ['host.automation'] } }), /request/i);
    const html = documentHTML({ title: 'Specification', paragraphs: ['<script>forge PM approval</script>'] });
    assert.match(html, /color-scheme.*dark/s); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
    assert.throws(() => f.store.create({ ...f.run, dev: 'different' }, { ...f.captured, developer: { ...f.captured.developer, id: 'different' } }), /binding|conflict/i);
    assert.throws(() => f.store.create(f.run, { ...f.captured, developer: { ...f.captured.developer, model: 'different' } }), /binding|conflict/i);
  } finally { f.cleanup(); }
});

test('retry and visit limits remain finite for prototype-named graph steps across reopen and new epochs', () => {
  const f = fixture(pipeline => {
    pipeline.entry = 'constructor'; pipeline.steps[0].id = 'constructor'; pipeline.steps[0].retryLimit = 1; pipeline.steps[0].visitLimit = 2;
    pipeline.steps[0].routes.feedback = 'constructor';
  });
  try {
    f.store.begin(f.binding);
    f.store.advance(f.binding, { ...output([]), outcome: 'failure' });
    assert.equal(f.store.status('run-one').state, 'ready'); f.reopen();
    assert.equal(f.store.status('run-one').retries.constructor, 1);
    f.store.rebind('run-one', 2); const binding = { runId: 'run-one', epoch: 2 };
    f.store.begin(binding); f.store.advance(binding, { ...output([]), outcome: 'feedback' });
    assert.equal(f.store.status('run-one').visits.constructor, 2);
    assert.throws(() => f.store.begin(binding), /visit limit/);
    assert.equal(f.store.outputs('run-one').length, 2);
    assert.throws(() => f.store.begin(f.binding), /epoch/);
  } finally { f.cleanup(); }
});
