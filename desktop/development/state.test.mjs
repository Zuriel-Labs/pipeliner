import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJSON, developmentTemplate } from '../core/settings.mjs';
import { openDevelopmentStore, documentHTML } from './state.mjs';
import { presetChanges } from '../pipelines/model.mjs';

const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const source = { sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40) };
function fixture(edit = () => {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-state-')));
  const pipeline = structuredClone(developmentTemplate);
  edit(pipeline);
  const run = { id: 'run-one', repository: 'repo-one', issue: 1, dev: 'dev-one', epoch: 1, policyRevision: 1,
    policyHash: 'c'.repeat(64), pipelineHash: hash(pipeline), limits: { 'limits.stepTurns': 3, 'limits.issueTurns': 5, 'limits.agentSeconds': 1800 } };
  const captured = { pipeline, source, executionProfile: { kind: 'pipeliner-desktop', version: 1 }, developer: { id: run.dev, connection: 'ollama', model: 'test-model' }, skillsHash: 'd'.repeat(64), issueHash: 'e'.repeat(64), checks: [{ name: 'Repository checks', command: 'node --test' }], logBytes: 1048576 };
  let store = openDevelopmentStore(directory); store.create(run, captured);
  return { run, captured, directory, binding: { runId: run.id, epoch: 1 }, get store() { return store; }, reopen() { store.close(); store = openDevelopmentStore(directory); }, cleanup() { store.close(); rmSync(directory, { recursive: true }); } };
}
const output = evidence => ({ outcome: 'success', summary: 'Verified source examined.', evidence, documents: [], findings: [] });

function qaCandidate(f) {
  for (const [kind, result] of [['source', {}], ['implementation', {}], ['tests', { name: 'Repository checks', command: 'node --test', exitCode: 0 }], ['review', {}]]) {
    f.store.begin(f.binding); f.store.turn(f.binding);
    const request = f.store.prepare(f.binding, kind, kind, {}); f.store.dispatch(f.binding, request.id);
    f.store.finish(f.binding, request.id, { candidate: source, result }); f.store.advance(f.binding, output([request.id]));
  }
  f.store.begin(f.binding);
  return { scope: 'issue', issue: 1, summary: 'Synthetic unit candidate.', findings: [], testResults: ['Repository checks passed.'],
    target: 'Synthetic unit source', prerequisites: [], steps: [{ action: 'Inspect the source.', expected: 'Scoped value change.' }], regressions: ['Original source preserved.'],
    limitations: ['Synthetic unit test; no Human QA.'], nextOutcome: 'Integrate the exact source and close the Issue.', approvalPhrase: 'Approved', candidate: source };
}

test('captured ungated policy integrates without creating QA; candidate drift and gated bypass fail', () => {
  const f = fixture(pipeline => Object.assign(pipeline, presetChanges('pm-autonomous')['pipelines.development']));
  const proof = { candidate: { ...source, sourceCommit: 'f'.repeat(40) }, source, resultHash: 'f'.repeat(64), pullRequest: 3 };
  try {
    qaCandidate(f); assert.equal(f.store.status(f.run.id).step, 'integrate');
    f.store.recordIntegration(f.binding, proof); f.reopen(); f.store.complete(f.binding, proof.resultHash);
    assert.equal(f.store.status(f.run.id).state, 'complete'); assert.equal(f.store.status(f.run.id).qa, undefined);
    assert.equal(f.store.status(f.run.id).qaHistory, undefined);
  } finally { f.cleanup(); }
  const gated = fixture();
  try { qaCandidate(gated); assert.throws(() => gated.store.recordIntegration(gated.binding, proof), /integration|candidate/i); }
  finally { gated.cleanup(); }
  const drift = fixture(pipeline => Object.assign(pipeline, presetChanges('pm-autonomous')['pipelines.development']));
  try { qaCandidate(drift); drift.store.setCandidate(drift.binding, { ...source, gitTree: 'e'.repeat(40) });
    assert.throws(() => drift.store.recordIntegration(drift.binding, proof), /integration|candidate/i); }
  finally { drift.cleanup(); }
});

test('legacy gated captures remain readable; ungated captures require the exact Desktop migration version', () => {
  const f = fixture(), { executionProfile: _profile, ...legacy } = f.captured;
  try {
    const run = { ...f.run, id: 'legacy-run' }; f.store.create(run, legacy); f.reopen();
    assert.equal(f.store.captured(run.id).executionProfile, undefined);
    const pipeline = presetChanges('pm-autonomous')['pipelines.development'], autonomous = { ...legacy, pipeline };
    const next = { ...f.run, id: 'autonomous-run', pipelineHash: hash(pipeline) };
    assert.throws(() => f.store.create(next, autonomous), /explicit Desktop profile migration/);
    assert.throws(() => f.store.create(next, { ...autonomous, executionProfile: { kind: 'pipeliner-desktop', version: 2 } }), /Invalid Desktop execution profile/);
  } finally { f.cleanup(); }
});

test('PM QA decisions bind to the current Showcase; feedback preserves counters and invalidates approval', () => {
  const f = fixture();
  try {
    const showcase = qaCandidate(f), qa = f.store.offerQA(f.binding, showcase), turns = f.store.status(f.run.id).turns;
    assert.throws(() => f.store.decideQA(f.binding, { inputId: 'wrong', hash: 'a'.repeat(64), decision: 'approve', text: 'Approved' }), /changed|Showcase/);
    f.store.decideQA(f.binding, { inputId: 'feedback-one', hash: qa.hash, decision: 'feedback', text: 'The value needs a correction.' });
    assert.equal(f.store.status(f.run.id).step, 'implement'); assert.equal(f.store.status(f.run.id).state, 'ready');
    assert.equal(f.store.status(f.run.id).turns, turns); assert.equal(f.store.status(f.run.id).qa, null);
    assert.equal(f.store.status(f.run.id).qaHistory[0].decision, 'feedback'); f.reopen();
    assert.equal(f.store.status(f.run.id).feedback.text, 'The value needs a correction.');
    assert.throws(() => f.store.decideQA(f.binding, { inputId: 'feedback-one', hash: qa.hash, decision: 'approve', text: 'Approved' }), /Showcase|pending|duplicate/);
  } finally { f.cleanup(); }
});

test('current direct approval advances only the captured integration route and cannot be replayed', () => {
  const f = fixture();
  try {
    const qa = f.store.offerQA(f.binding, qaCandidate(f));
    f.store.decideQA(f.binding, { inputId: 'approval-one', hash: qa.hash, decision: 'approve', text: 'I approve this tested version.' });
    assert.equal(f.store.status(f.run.id).step, 'integrate'); assert.equal(f.store.status(f.run.id).qa.decision, 'approve');
    assert.throws(() => f.store.decideQA(f.binding, { inputId: 'approval-one', hash: qa.hash, decision: 'approve', text: 'Approved' }), /pending|duplicate/);
    f.reopen(); assert.equal(f.store.status(f.run.id).qa.decision, 'approve');
    f.store.setCandidate(f.binding, { ...source, gitTree: 'f'.repeat(40) });
    assert.equal(f.store.status(f.run.id).qa, null);
  } finally { f.cleanup(); }
});

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
