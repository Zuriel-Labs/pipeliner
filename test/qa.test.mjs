import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateQA, migrateQA, evaluateQA } from '../scripts/lib/qa.mjs';
import { intakeDecision } from '../scripts/lib/intake.mjs';

export function topology(mode = 'split') {
  const environments = ['windows', 'macos'].map(id => ({ id, os: id, architecture: 'x64',
    prerequisites: ['Compatible host'], setup: ['setup'], suite: ['test', 'build'], teardown: ['cleanup'] }));
  if (mode === 'single' || mode === 'shared') environments.pop();
  const developers = [{ id: 'dev-a', environments: environments.map(e => e.id) }];
  if (mode === 'split' || mode === 'shared') developers.push({ id: 'dev-b', environments: [environments.at(-1).id] });
  const turns = [{ id: 'first', developer: 'dev-a', environment: 'windows', pm: 'pm', approvalPhrase: 'QA approved' }];
  if (mode !== 'single') turns.push({ id: 'second', developer: mode === 'self' ? 'dev-a' : 'dev-b',
    environment: environments.at(-1).id, pm: 'pm', approvalPhrase: 'QA approved' });
  return { applicationType: 'native', runtimePlatforms: environments.map(({ os, architecture }) => ({ os, architecture })),
    candidateIdentity: ['sourceCommit', 'gitTree'], developers, environments, turns };
}
const candidate = { sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40) };
function evidence(qa, index) {
  const turn = qa.turns[index];
  return { turn: turn.id, developer: turn.developer, environment: turn.environment, candidate,
    session: `run-${index}`, host: { available: true, os: turn.environment, architecture: 'x64' },
    pickedUp: true, candidateAvailable: true, nextCandidateAvailable: true,
    suite: ['test', 'build'].map(command => ({ command, exitCode: 0, evidence: 'local log' })),
    pm: { owner: 'pm', phrase: 'QA approved', candidate, evidence: 'PM message' },
    cleanup: { verified: true, evidence: 'inventory empty', resources: [] } };
}
test('intake waits for missing target and never equates access failure with absence', () => {
  assert.equal(intakeDecision({}).action, 'ask');
  assert.equal(intakeDecision({ intent: 'create' }).action, 'ask');
  for (const probe of ['inaccessible', 'unknown', 'not-found']) {
    assert.equal(intakeDecision({ target: 'Org/app', intent: 'create', probe }).action, 'blocked');
  }
  assert.equal(intakeDecision({ target: 'Org/app', probe: 'exists', identityVerified: true }).action, 'adopt');
  const request = { target: 'Org/app', intent: 'create', probe: 'confirmed-absent', authorized: true,
    owner: 'Org', name: 'app', purpose: 'App', visibility: 'private', destination: '/new/app' };
  assert.equal(intakeDecision(request).action, 'create');
  assert.equal(intakeDecision({ ...request, visibility: undefined }).action, 'ask');
  assert.equal(intakeDecision({ ...request, authorized: false }).action, 'ask');
});
test('four independent developer and OS arrangements validate', () => {
  for (const mode of ['single', 'self', 'shared', 'split']) assert.equal(validateQA(topology(mode)).applicationType, 'native');
  const qa = topology(); qa.turns[1].developer = 'missing';
  assert.throws(() => validateQA(qa), /developer/);
  const bad = topology(); bad.developers[1].environments = ['windows'];
  assert.throws(() => validateQA(bad), /available/);
});
test('migration requires explicit topology and preserves release configuration', async () => {
  const profile = JSON.parse(await readFile(new URL('../pipeliner.config.json', import.meta.url)));
  delete profile.qa;
  assert.throws(() => migrateQA(profile), /discovery/);
  const migrated = migrateQA(profile, topology());
  assert.deepEqual(migrated.release, profile.release);
  assert.equal(profile.qa, undefined);
});
test('QA requires complete ordered evidence, supports self and shared-OS pickup', () => {
  for (const mode of ['single', 'self', 'shared', 'split']) {
    const qa = topology(mode);
    assert.equal(evaluateQA(qa, candidate, []).state, 'pickup');
    const first = evidence(qa, 0);
    const state = evaluateQA(qa, candidate, [first]);
    assert.equal(state.baton, mode !== 'single');
    assert.equal(state.state, mode === 'single' ? 'complete' : 'pickup');
    if (mode !== 'single') {
      assert.equal(state.current.developer, qa.turns[1].developer);
      assert.equal(evaluateQA(qa, candidate, [first, evidence(qa, 1)]).state, 'complete');
    }
  }
});
test('missing host, changed candidate, wrong PM, missing suite and cleanup never complete', () => {
  const qa = topology('single');
  const mutations = [e => { e.host.available = false; }, e => { e.candidate = { ...candidate, gitTree: 'c'.repeat(40) }; },
    e => { e.pm.owner = 'other'; }, e => { e.suite.pop(); }, e => { e.suite[0].exitCode = 1; },
    e => { e.cleanup.verified = false; }, e => { e.cleanup.resources = [{ status: 'retained', owner: 'pm', cleanupTrigger: 'after PM' }]; },
    e => { e.candidateAvailable = false; }, e => { e.host.os = 'linux'; }];
  for (const mutate of mutations) {
    const item = evidence(qa, 0); mutate(item);
    assert.notEqual(evaluateQA(qa, candidate, [item]).state, 'complete');
  }
  assert.throws(() => evaluateQA(qa, {}, []), /candidate/);
});

test('native runtime coverage and shared identity cannot silently omit a platform', () => {
  const qa = topology('single');
  qa.runtimePlatforms.push({ os: 'macos', architecture: 'arm64' });
  assert.throws(() => validateQA(qa), /runtime platform/);
});

test('outgoing turn cannot pass baton without next-candidate availability', () => {
  const qa = topology('split');
  const record = evidence(qa, 0); record.nextCandidateAvailable = false;
  const result = evaluateQA(qa, candidate, [record]);
  assert.equal(result.state, 'waiting');
  assert.equal(result.current.id, 'first');
  assert.equal(result.projectStatus, 'In Progress');
});
