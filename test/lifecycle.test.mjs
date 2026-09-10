import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { selectWork, clarificationDecision, reviewRoute, releaseStages, identityKeys } from '../scripts/lib/lifecycle.mjs';
import { validateProfile } from '../scripts/lib/config.mjs';

const profile = JSON.parse(await readFile(new URL('../pipeliner.config.json', import.meta.url)));
const issue = (number, priority = 'P1', status = 'Backlog') => ({ number, priority, status, state: 'OPEN', ready: true });

test('start selects ready priority then oldest Issue; explicit and active targets take precedence', () => {
  const issues = [issue(9), issue(8), issue(10, 'P0'), { ...issue(11, 'P0'), ready: false }];
  assert.equal(selectWork(profile, { issues }).issue.number, 10);
  assert.equal(selectWork(profile, { issues: issues.slice(0, 2) }).issue.number, 8);
  assert.equal(selectWork(profile, { issues, requested: 9 }).issue.number, 9);
  assert.equal(selectWork(profile, { issues: [...issues, issue(7, 'P2', 'In Review')] }).issue.number, 7);
  assert.equal(selectWork(profile, { issues: [...issues, issue(7, 'P2', 'In Review')], requested: 9 }).state, 'blocked');
});

test('selection fails closed on incomplete state, competing active Issues and On Hold', () => {
  assert.equal(selectWork(profile, { issues: [issue(1, 'P1', 'In Progress'), issue(2, 'P1', 'In Review')] }).state, 'blocked');
  assert.equal(selectWork(profile, { issues: [issue(1, 'unknown')] }).state, 'question');
  assert.equal(selectWork(profile, { issues: [{ ...issue(1), ready: undefined }] }).state, 'question');
  assert.equal(selectWork(profile, { issues: [issue(1, 'P1', 'On Hold')], requested: 1 }).state, 'blocked');
  assert.equal(selectWork(profile, { issues: [issue(1)], intent: 'audit' }).state, 'read-only');
  assert.equal(selectWork(profile, { issues: [issue(1), { ...issue(2), status: undefined }] }).state, 'blocked');
  assert.equal(selectWork(profile, { issues: [issue(1), issue(1)] }).state, 'blocked');
});

test('questions stay in messages regardless of native capability; silence never answers', () => {
  for (const elapsedMs of [0, 60000, 86400000]) {
    const pending = clarificationDecision({ nativeAvailable: true, nativePermitted: true, elapsedMs });
    assert.deepEqual(pending, { channel: 'message', state: 'waiting', timeout: null });
  }
  assert.equal(clarificationDecision({ nativeAvailable: true, nativePermitted: false }).channel, 'message');
  assert.equal(clarificationDecision({ nativeAvailable: false }).channel, 'message');
  assert.equal(clarificationDecision({ answered: true }).state, 'answered');
  assert.equal(clarificationDecision({ answered: 'false' }).state, 'waiting');
});

test('review resumes without demanding a reopened merged PR and remediates on same Issue', () => {
  assert.equal(reviewRoute({ status: 'In Review', pullRequestState: 'MERGED' }), 'acceptance');
  assert.equal(reviewRoute({ status: 'In Review', pullRequestState: 'OPEN' }), 'review');
  assert.equal(reviewRoute({ status: 'In Review', pullRequestState: 'MERGED', findings: true }), 'new-remediation-pr');
  assert.equal(reviewRoute({ status: 'In Progress', pullRequestState: 'OPEN', findings: true }), 'remediate');
  assert.equal(reviewRoute({ status: 'Done', pullRequestState: 'MERGED', findings: true }), 'blocked');
});

test('all release strategies order approval before mutation and final acceptance after deployment', () => {
  const direct = releaseStages('direct-production');
  assert.ok(direct.indexOf('production-approval') < direct.indexOf('merge'));
  assert.ok(direct.indexOf('verify-release') < direct.indexOf('completion-approval'));
  assert.ok(!direct.includes('review-deploy'));
  assert.deepEqual(releaseStages('none'), ['agent-review', 'local-qa', 'merge', 'verify-source', 'close']);
  const immutable = releaseStages('immutable-promotion');
  assert.ok(immutable.indexOf('review-deploy') < immutable.indexOf('production-approval'));
  assert.ok(immutable.includes('promote-same-artifact'));
  assert.deepEqual(releaseStages('multi-environment'), ['agent-review', 'prepare-native', 'local-qa', 'merge', 'verify-release', 'close']);
  const nativeProduction = releaseStages('multi-environment', { hasProduction: true });
  assert.ok(nativeProduction.indexOf('production-approval') < nativeProduction.indexOf('merge'));
  assert.ok(nativeProduction.indexOf('completion-approval') > nativeProduction.indexOf('verify-release'));
  assert.throws(() => releaseStages('unknown'), /strategy/);
});

test('future deployment identity is only required after release; configured pre-release evidence is preserved', () => {
  const p = structuredClone(profile);
  p.release = { strategy: 'direct-production', candidateIdentity: ['sourceCommit', 'gitTree', 'deploymentId'], environments: [{ name: 'Production', role: 'production', buildCommand: '', deployCommand: '', verifyCommand: 'verify' }] };
  assert.deepEqual(identityKeys(p, 'pre-release'), ['sourceCommit', 'gitTree']);
  assert.deepEqual(identityKeys(p, 'released'), ['sourceCommit', 'gitTree', 'deploymentId']);
  p.release.preReleaseIdentity = ['sourceCommit', 'gitTree', 'artifactDigest'];
  assert.throws(() => validateProfile(p), /preReleaseIdentity/);
  p.release.candidateIdentity.push('artifactDigest');
  validateProfile(p);
  assert.ok(identityKeys(p, 'pre-release').includes('artifactDigest'));
  assert.throws(() => identityKeys(p, 'typo'), /phase/);
});
