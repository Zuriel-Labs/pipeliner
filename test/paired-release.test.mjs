import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planAdoption, applyAdoptionPlan } from '../scripts/lib/adoption.mjs';
import { validateQA, evaluateQA, requirePairedQA } from '../scripts/lib/qa.mjs';
import { clarificationDecision } from '../scripts/lib/lifecycle.mjs';
import { resolveHome } from '../scripts/lib/home.mjs';
import { validateCycle, issueBranch, evaluatePhase, releaseScopeKey } from '../scripts/lib/release-cycle.mjs';
import { validateOperationalText } from '../scripts/lib/validation.mjs';

const c1 = { sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40) };
const c2 = { sourceCommit: 'c'.repeat(40), gitTree: 'd'.repeat(40) };
function qa(count = 3) {
  const ids = Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i));
  return { mode: 'circulating', applicationType: 'tooling', runtimePlatforms: [{ os: 'linux', architecture: 'x64' }],
    candidateIdentity: ['sourceCommit', 'gitTree'],
    developers: ids.map(id => ({ id, kind: 'agent', github: `account-${id}`, environments: ['local'] })),
    pms: ids.map(id => ({ id: `pm-${id}`, kind: 'human' })),
    environments: [{ id: 'local', os: 'linux', architecture: 'x64', prerequisites: [], setup: [], suite: ['test'], teardown: [] }],
    turns: ids.map(id => ({ id, developer: id, pm: `pm-${id}`, environment: 'local', approvalPhrase: 'Approved' })) };
}
function record(id, candidate = c1, round = 1, scope = 'issue') {
  return { turn: id, round, candidate, developer: id, environment: 'local', session: `session-${round}-${id}`,
    host: { available: true, os: 'linux', architecture: 'x64' }, pickedUp: true, candidateAvailable: true, nextCandidateAvailable: true,
    review: { candidate, evidence: 'Agent reviewed full diff and behavior' },
    suite: [{ command: 'test', exitCode: 0, evidence: 'full log' }],
    pm: { owner: `pm-${id}`, phrase: 'Approved', candidate, evidence: 'Actual PM reply' },
    cleanup: { verified: true, evidence: 'empty inventory verified', resources: [] },
    showcase: { scope, issue: 9, candidate, summary: 'Changes in this candidate', findings: [], testResults: ['test: passed'],
      target: 'local verified artifact', prerequisites: [], steps: [{ action: 'Exercise changed behavior', expected: 'Correct result' }],
      regressions: ['Existing behavior preserved'], limitations: [], nextOutcome: 'Next pair or release gate', approvalPhrase: 'Approved' } };
}
function profile() {
  return { repository: { owner: 'Example', name: 'app', defaultBranch: 'main' }, qa: qa(), release: {
    candidateIdentity: ['sourceCommit', 'gitTree'], environments: [{ name: 'preview' }, { name: 'production' }],
    cycle: { phases: [
      { id: 'alpha', kind: 'development', branch: 'develop', environments: ['preview'], approvalPhrase: 'Approved', readiness: ['scope complete'], promotion: 'source', forwardPortTo: [] },
      { id: 'beta', kind: 'stabilization', branch: 'release/1.0', environments: ['preview'], approvalPhrase: 'Approved', readiness: ['no blockers'], promotion: 'same-artifact', forwardPortTo: ['alpha'] },
      { id: 'stable', kind: 'production', branch: 'main', environments: ['production'], approvalPhrase: 'Approved', readiness: ['verified'], promotion: 'same-artifact', forwardPortTo: [] }
    ] } } };
}
test('native capability never changes message-only indefinite waiting', () => {
  assert.deepEqual(clarificationDecision({ nativeAvailable: true, nativePermitted: true }), { channel: 'message', state: 'waiting', timeout: null });
});
test('reconciled policy cannot retain superseded question or QA restart instructions', () => {
  for (const text of ['Prefer a supported native question; fall back to messages.',
    'Candidate changes require retest from the first turn.', 'Use permitted native app questions or a clearly marked message fallback.']) {
    assert.ok(validateOperationalText(text).length > 0);
  }
  assert.deepEqual(validateOperationalText('Never use native question controls. Finish the current pair before handing off.'), []);
});
test('paired QA validates explicit Agent/Human identity and complete PM coverage', () => {
  assert.equal(requirePairedQA(qa()).mode, 'circulating');
  for (const mutate of [q => q.pms.push({ id: 'uncovered', kind: 'human' }), q => { q.developers[0].kind = 'human'; }, q => { q.turns[0].pm = 'unknown'; }, q => { delete q.developers[0].github; }]) {
    const q = qa(); mutate(q); assert.throws(() => validateQA(q));
  }
  const legacy = qa(); delete legacy.mode; delete legacy.pms;
  legacy.developers.forEach(d => { delete d.kind; delete d.github; });
  assert.doesNotThrow(() => validateQA(legacy));
  assert.throws(() => requirePairedQA(legacy), /discovery/);
});
test('current remediating pair finishes before rotating to stale pairs', () => {
  const q = qa(); const records = [record('a'), record('b', c2, 2)];
  let result = evaluateQA(q, c2, records, { issue: 9, currentTurn: 'b' });
  assert.equal(result.state, 'pickup'); assert.equal(result.current.id, 'c');
  records.push(record('c', c2, 2));
  result = evaluateQA(q, c2, records, { issue: 9, currentTurn: 'c' });
  assert.equal(result.current.id, 'a');
  records.push(record('a', c2, 2));
  assert.equal(evaluateQA(q, c2, records, { issue: 9, currentTurn: 'a' }).state, 'complete');
  records[1].cleanup.verified = false;
  assert.equal(evaluateQA(q, c2, records, { issue: 9, currentTurn: 'b' }).state, 'waiting');
});
test('every current pair requires review, Showcase, full suite, PM and cleanup', () => {
  for (const mutate of [r => { delete r.showcase; }, r => { r.showcase.steps = []; }, r => { r.review.candidate = c1; },
    r => { r.pm.owner = 'other'; }, r => { r.host.available = false; }, r => { r.suite[0].exitCode = 1; },
    r => { r.cleanup.verified = false; }, r => { r.nextCandidateAvailable = false; }]) {
    const r = record('b', c2, 2); mutate(r);
    assert.notEqual(evaluateQA(qa(), c2, [record('a'), r], { issue: 9, currentTurn: 'b' }).state, 'pickup');
  }
});
test('history never resurrects approval after later failed or stale attempt', () => {
  const q = qa(1); const old = record('a'); const latest = record('a', c1, 2); latest.suite[0].exitCode = 1;
  assert.notEqual(evaluateQA(q, c1, [latest, old], { issue: 9, currentTurn: 'a' }).state, 'complete');
  assert.throws(() => evaluateQA(q, c1, [old, old], { issue: 9, currentTurn: 'a' }), /round/);
  assert.throws(() => evaluateQA(q, c1, [old], { issue: 9, currentTurn: 'missing' }), /turn/i);
  assert.throws(() => evaluateQA(q, c1, [old], { issue: 9 }), /currentTurn/);
});
test('same PM can partner with several Agents while every turn is required', () => {
  const q = qa(2); q.pms = [q.pms[0]]; q.turns[1].pm = 'pm-a';
  assert.doesNotThrow(() => validateQA(q));
  assert.equal(evaluateQA(qa(1), c1, [record('a')], { issue: 9, currentTurn: 'a' }).baton, false);
});
test('home follows installed canonical path and verifies Git fetch and push identity', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-home-')); t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:Example/app.git']);
  await writeFile(path.join(root, 'AGENTS.md'), '# Home');
  await writeFile(path.join(root, 'pipeliner.config.json'), JSON.stringify(profile()));
  const skill = path.join(root, '.agents/skills/work'); await mkdir(skill, { recursive: true });
  assert.equal((await resolveHome(skill)).repository, 'Example/app');
  execFileSync('git', ['-C', root, 'remote', 'set-url', '--push', 'origin', 'https://github.com/Other/app.git']);
  await assert.rejects(resolveHome(skill), /identity/);
});
test('cycle rejects unknown environment, branch collisions and forward-port targets', () => {
  assert.doesNotThrow(() => validateCycle(profile()));
  for (const mutate of [p => { p.release.cycle.phases[1].branch = 'develop'; }, p => { p.release.cycle.phases[0].environments = ['unknown']; },
    p => { p.release.cycle.phases[1].forwardPortTo = ['stable']; }]) {
    const p = profile(); mutate(p); assert.throws(() => validateCycle(p));
  }
});
test('phase-aware branches reject new features in frozen Beta and route fixes forward', () => {
  assert.equal(issueBranch(profile(), { phase: 'alpha', kind: 'feature' }).base, 'develop');
  assert.throws(() => issueBranch(profile(), { phase: 'beta', kind: 'feature' }), /frozen/);
  assert.deepEqual(issueBranch(profile(), { phase: 'beta', kind: 'fix' }).forwardPort, ['develop']);
  assert.throws(() => issueBranch(profile(), { phase: 'unknown', kind: 'fix' }));
});
function phaseState() {
  const candidate = { ...c1, releaseScope: releaseScopeKey({ target: '1.0', releaseIssue: 9, phase: 'alpha', issues: [{ number: 10 }] }) };
  return { target: '1.0', releaseIssue: 9, phase: 'alpha', candidate, currentTurn: 'c',
    issues: [{ number: 10, accepted: true, evidence: 'verified phase integration' }], frozenIssues: [10], blockers: [],
    records: ['a', 'b', 'c'].map(id => record(id, candidate, 1, 'release')),
    approvals: ['a', 'b', 'c'].map(id => ({ pm: `pm-${id}`, phase: 'alpha', candidate, phrase: 'Approved', evidence: 'actual readiness approval' })),
    readiness: [{ criterion: 'scope complete', passed: true, evidence: 'scope verified' }],
    verification: { candidate, passed: true, evidence: 'integrated behavior passed', environments: [{ name: 'preview', candidate, passed: true, evidence: 'preview verified' }] }, rollback: { target: 'known-good', evidence: 'verified target' }, forwardPorts: [] };
}
test('aggregate gate requires release Showcase and every required PM, scope and readiness', () => {
  assert.equal(evaluatePhase(profile(), phaseState()).state, 'ready');
  for (const mutate of [s => s.approvals.pop(), s => s.records.pop(), s => { s.records[0].showcase.scope = 'issue'; },
    s => { s.blockers = [12]; }, s => { s.frozenIssues = []; }, s => { s.issues[0].accepted = false; },
    s => { s.approvals[0].candidate = c2; }, s => { s.verification.passed = false; }, s => { s.readiness = []; }, s => { delete s.rollback; }]) {
    const s = phaseState(); mutate(s); assert.notEqual(evaluatePhase(profile(), s).state, 'ready');
  }
});

test('first and last pairs circulate until latest candidate coverage converges', () => {
  for (const count of [2, 3]) {
    const q = qa(count); const last = q.turns.at(-1).id;
    const history = q.turns.map(t => record(t.id));
    history.push(record(last, c2, 2));
    assert.equal(evaluateQA(q, c2, history, { issue: 9, currentTurn: last }).current.id, 'a');
    for (const turn of q.turns.slice(0, -1)) history.push(record(turn.id, c2, 2));
    assert.equal(evaluateQA(q, c2, history, { issue: 9, currentTurn: 'a' }).state, 'complete');
    history[0].cleanup.verified = false;
    assert.notEqual(evaluateQA(q, c2, history, { issue: 9, currentTurn: 'a' }).state, 'complete');
  }
});
test('official approval word remains bound to Human, Issue and exact candidate', () => {
  const q = qa(1);
  for (const phrase of ['approved', 'Beta approved', 'Approved to complete Issue #9', 'Approved ']) {
    const r = record('a'); r.pm.phrase = phrase;
    assert.notEqual(evaluateQA(q, c1, [r], { issue: 9, currentTurn: 'a' }).state, 'complete');
  }
  for (const mutate of [r => { r.pm.owner = 'another-pm'; }, r => { r.pm.candidate = c2; }, r => { r.showcase.issue = 10; }]) {
    const r = record('a'); mutate(r);
    assert.notEqual(evaluateQA(q, c1, [r], { issue: 9, currentTurn: 'a' }).state, 'complete');
  }
  assert.equal(evaluateQA(q, c1, [record('a')], { issue: 9, currentTurn: 'a' }).state, 'complete');
});

test('one Agent across environments and shared PM still require independent full turns', () => {
  const q = qa(2); q.developers = [q.developers[0]]; q.pms = [q.pms[0]];
  q.environments.push({ ...q.environments[0], id: 'second', os: 'macos' });
  q.developers[0].environments.push('second'); q.turns[1] = { ...q.turns[1], developer: 'a', pm: 'pm-a', environment: 'second' };
  assert.doesNotThrow(() => requirePairedQA(q));
  const a = record('a'), b = record('b'); b.developer = 'a'; b.environment = 'second'; b.host.os = 'macos'; b.pm.owner = 'pm-a';
  assert.equal(evaluateQA(q, c1, [a], { issue: 9, currentTurn: 'a' }).current.id, 'b');
  assert.equal(evaluateQA(q, c1, [a, b], { issue: 9, currentTurn: 'b' }).state, 'complete');
});
test('approvals bind the actual Issue number and every phase environment', () => {
  const q = qa(1); q.turns[0].approvalPhrase = 'Approve Issue #{number}';
  const r = record('a'); r.pm.phrase = r.showcase.approvalPhrase = 'Approve Issue #9';
  assert.equal(evaluateQA(q, c1, [r], { issue: 9, currentTurn: 'a' }).state, 'complete');
  assert.notEqual(evaluateQA(q, c1, [r], { issue: 10, currentTurn: 'a' }).state, 'complete');
  const p = profile(); p.release.cycle.phases[0].approvalPhrase = 'Ready Issue #{number}';
  const s = phaseState(); s.approvals.forEach(a => { a.phrase = 'Ready Issue #9'; });
  assert.equal(evaluatePhase(p, s).state, 'ready');
  s.verification.environments = [];
  assert.equal(evaluatePhase(p, s).state, 'waiting');
});
test('stabilization requires verified forward-port and approved identical artifact', () => {
  const p = profile(), s = phaseState(); s.phase = 'beta';
  s.candidate.releaseScope = releaseScopeKey(s); s.candidate.artifactDigest = 'sha256:abc';
  s.readiness = [{ criterion: 'no blockers', passed: true, evidence: 'verified' }];
  s.approvals.forEach(a => { a.phase = 'beta'; a.phrase = 'Approved'; a.artifactDigest = 'sha256:abc'; });
  s.artifact = { candidate: s.candidate, digest: 'sha256:abc', previousDigest: 'sha256:abc', verified: true, evidence: 'manifest' };
  assert.equal(evaluatePhase(p, s).state, 'waiting');
  s.forwardPorts = [{ phase: 'alpha', sourceCandidate: s.candidate, commit: c2.sourceCommit, gitTree: c2.gitTree, verified: true, evidence: 'forward integration passed' }];
  assert.equal(evaluatePhase(p, s).state, 'ready');
  const mismatch = JSON.parse(JSON.stringify(s));
  mismatch.candidate.artifactDigest = mismatch.artifact.digest = mismatch.artifact.previousDigest = 'sha256:new';
  mismatch.approvals.forEach(a => { a.artifactDigest = 'sha256:new'; });
  assert.equal(evaluatePhase(p, mismatch).state, 'waiting');
  s.artifact.previousDigest = 'sha256:other'; assert.equal(evaluatePhase(p, s).state, 'waiting');
  p.release.cycle.phases[1].promotion = 'distinct-artifact';
  assert.equal(evaluatePhase(p, s).state, 'waiting');
  s.artifact.channelInputs = 'reviewed beta channel inputs'; assert.equal(evaluatePhase(p, s).state, 'ready');
  s.approvals[0].artifactDigest = 'other'; assert.equal(evaluatePhase(p, s).state, 'waiting');
  s.approvals[0].artifactDigest = 'sha256:abc'; s.candidate.artifactDigest = 'sha256:different';
  assert.equal(evaluatePhase(p, s).state, 'waiting');
});

test('release approvals cannot be reused for another target, phase or frozen scope', () => {
  for (const mutate of [s => { s.target = '2.0'; }, s => { s.issues[0].number = 99; s.frozenIssues = [99]; }, s => { s.phase = 'beta'; }]) {
    const s = phaseState(); mutate(s); assert.equal(evaluatePhase(profile(), s).state, 'waiting');
  }
});
test('malformed nested release evidence fails closed with a decision', () => {
  for (const mutate of [s => { s.readiness = [null]; }, s => { s.approvals[0] = null; }, s => { s.verification.environments = [null]; },
    s => { s.issues = [null]; }, s => { s.forwardPorts = [null]; }]) {
    const s = phaseState(); mutate(s); assert.equal(evaluatePhase(profile(), s).state, 'waiting');
  }
});
test('immutable strategy cannot configure distinct Production artifact', () => {
  const p = profile(); p.release.strategy = 'immutable-promotion'; p.release.cycle.phases[2].promotion = 'distinct-artifact';
  assert.throws(() => validateCycle(p), /same-artifact/);
});
test('later exact cleanup resolution preserves historical retained-resource record', () => {
  const old = record('a'), latest = record('a', c2, 2);
  const resource = { kind: 'process', id: '123', run: 'run-1', owner: 'a', status: 'retained', evidence: 'retained for PM', cleanupTrigger: 'after PM' };
  old.cleanup = { verified: false, evidence: 'pending', resources: [resource] };
  const resolution = { turn: 'a', round: 1, cleanup: { verified: true, evidence: 'process absence verified later', resources: [{ ...resource, status: 'removed' }] } };
  assert.equal(evaluateQA(qa(1), c2, [old, latest], { issue: 9, currentTurn: 'a', cleanupResolutions: [resolution] }).state, 'complete');
  assert.equal(old.cleanup.resources[0].status, 'retained');
  resolution.cleanup.resources[0].run = 'unrelated';
  assert.equal(evaluateQA(qa(1), c2, [old, latest], { issue: 9, currentTurn: 'a', cleanupResolutions: [resolution] }).state, 'waiting');
});
test('future deployment identity never blocks pre-release but is required for Production', () => {
  const p = profile(), s = phaseState(); p.release.candidateIdentity.push('deploymentId'); p.release.preReleaseIdentity = ['sourceCommit', 'gitTree'];
  assert.equal(evaluatePhase(p, s).state, 'ready');
  s.phase = 'stable'; assert.equal(evaluatePhase(p, s).state, 'waiting');
});

test('installed QA and phase CLIs execute full synthetic evidence and reject stale gates', async t => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-evidence-cli-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
  const p = JSON.parse(await readFile(path.join(sourceRoot, 'pipeliner.config.json')));
  p.qa = qa(); p.release = { ...profile().release, strategy: 'direct-production' };
  p.release.environments = p.release.environments.map(e => ({ ...e, role: e.name === 'production' ? 'production' : 'review', buildCommand: '', deployCommand: '', verifyCommand: 'verify' }));
  await applyAdoptionPlan(await planAdoption({ sourceRoot, targetRoot, profile: p }));
  const config = path.join(targetRoot, 'pipeliner.config.json'), evidenceFile = path.join(targetRoot, 'synthetic.json');
  const run = script => JSON.parse(execFileSync(process.execPath, [path.join(targetRoot, 'scripts', script), config, evidenceFile], { encoding: 'utf8', stdio: 'pipe' }));
  await writeFile(evidenceFile, JSON.stringify({ issue: 9, scope: 'issue', currentTurn: 'c', candidate: c1, records: ['a', 'b', 'c'].map(id => record(id)) }));
  assert.equal(run('evaluate-qa.mjs').state, 'complete');
  const s = phaseState(); await writeFile(evidenceFile, JSON.stringify(s));
  assert.equal(run('evaluate-release.mjs').state, 'ready');
  s.approvals.pop(); await writeFile(evidenceFile, JSON.stringify(s));
  assert.throws(() => run('evaluate-release.mjs'));
});
