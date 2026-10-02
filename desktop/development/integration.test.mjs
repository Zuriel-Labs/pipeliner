import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { readIntegrationCandidate, verifyMergedCandidate, buildDevelopmentShowcase, mergeDevelopmentCandidate, integrationObservation, readIntegrationMethod } from './integration.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), tree = 'c'.repeat(40), merged = 'd'.repeat(40);
function fixture() {
  let mode = 'open', check = 'success', current = head, mergeWrites = 0, reply = 'lost', revoked = false, protectedBranch = false, method = 'merge';
  const workspace = { slug: 'fixture/repo', repositoryId: 'R1', numericId: 1 }, publication = { number: 3, head, branch: 'issue/7-fixture', base, baseBranch: 'main', candidate: { sourceCommit: head, gitTree: tree } };
  const lease = { check() { if (revoked) throw new Error('connection-changed'); }, signal: new AbortController().signal, value: { credential: { accessToken: 'synthetic-app' } }, send: async (url, request) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/pulls/3/merge')) { assert.equal(request.method, 'PUT'); assert.deepEqual(JSON.parse(request.body), { sha: head, merge_method: method }); mergeWrites++;
      if (reply === 'denied') return Response.json({}, { status: 405 });
      mode = 'merged'; if (reply === 'lost') throw Error('lost synthetic merge reply');
      if (reply === 'revoked') revoked = true;
      return Response.json({ merged: true, sha: merged }); }
    assert.equal(request.method, 'GET');
    if (path === '/repos/fixture/repo') return Response.json({ id: 1, node_id: 'R1', allow_merge_commit: method === 'merge', allow_squash_merge: true });
    if (path.endsWith('/pulls/3')) return Response.json({ number: 3, state: mode === 'open' ? 'open' : 'closed', merged: mode !== 'open', merge_commit_sha: mode === 'open' ? null : merged,
      draft: false, mergeable: true, head: { ref: publication.branch, sha: current, repo: { id: 1, node_id: 'R1' } }, base: { ref: 'main', sha: base, repo: { id: 1, node_id: 'R1' } } });
    if (path.endsWith('/git/ref/heads/main')) return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: mode === 'open' ? base : merged } });
    if (path.endsWith('/branches/main')) return Response.json({ name: 'main', commit: { sha: base }, protected: protectedBranch });
    if (path.endsWith('/git/commits/' + head)) return Response.json({ sha: head, tree: { sha: tree } });
    if (path.endsWith('/git/commits/' + merged)) return Response.json({ sha: merged, tree: { sha: mode === 'wrong-tree' ? 'f'.repeat(40) : tree }, parents: method === 'squash' ? [{ sha: base }] : [{ sha: base }, { sha: head }] });
    if (path.endsWith('/check-runs')) return Response.json({ total_count: check === 'missing' ? 0 : 1, check_runs: check === 'missing' ? [] : [{ id: 10, name: 'verify', head_sha: head, status: 'completed', conclusion: check, check_suite: { id: 20, app: { slug: 'github-actions' } } }] });
    if (path.endsWith('/status')) return Response.json({ sha: head, total_count: check === 'spoof-status' ? 1 : 0, statuses: check === 'spoof-status' ? [{ id: 99, context: 'Quality / verify', state: 'success' }] : [] });
    if (path.endsWith('/actions/runs')) { const runs = [{ id: 30, name: 'Quality', head_sha: head, check_suite_id: 20, status: 'completed', conclusion: 'success' }];
      if (check === 'new-failed') runs.push({ ...runs[0], id: 31, check_suite_id: 21, conclusion: 'failure' }); else runs[0].conclusion = check;
      return Response.json({ total_count: runs.length, workflow_runs: runs }); }
    throw Error('Unexpected unit API path');
  } };
  return { workspace, publication, lease, profile: { repository: { defaultBranch: 'main' }, quality: { requiredChecks: ['Quality / verify'] }, release: { strategy: 'none' } }, method: value => { method = value; }, mode: value => { mode = value; }, check: value => { check = value; }, protect: value => { protectedBranch = value; }, head: value => { current = value; }, reply: value => { reply = value; }, writes: () => mergeWrites };
}

test('integration requires exact head/base/tree and present successful current required checks', async () => {
  const f = fixture(), input = { ...f, capturedSource: { sourceCommit: base, gitTree: 'e'.repeat(40) } };
  assert.equal((await readIntegrationCandidate(input)).candidate.sourceCommit, head);
  for (const state of ['failure', 'pending', 'missing', 'neutral', 'new-failed', 'spoof-status']) { f.check(state); await assert.rejects(readIntegrationCandidate(input), /check|pending/i); }
  f.check('success'); f.head('f'.repeat(40)); await assert.rejects(readIntegrationCandidate(input), /candidate|head/i);
});

test('selects allowed merge or squash; absent, changed and rebase-only controls block', async () => {
  const workspace = { slug: 'fixture/repo', repositoryId: 'R1', numericId: 1 }; let methods = { allow_merge_commit: false, allow_squash_merge: true };
  const lease = { check() {}, value: { credential: { accessToken: 'synthetic-app' } }, send: async () => Response.json({ id: 1, node_id: 'R1', ...methods }) };
  assert.equal(await readIntegrationMethod(lease, workspace), 'squash');
  await assert.rejects(readIntegrationMethod(lease, workspace, 'merge'), /method|control/i);
  methods = { allow_merge_commit: true, allow_squash_merge: true }; assert.equal(await readIntegrationMethod(lease, workspace), 'merge');
  assert.equal(await readIntegrationMethod(lease, workspace, 'squash'), 'squash');
  for (const unavailable of [{}, { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true }, { id: 2, allow_merge_commit: true, allow_squash_merge: true }]) {
    methods = unavailable; await assert.rejects(readIntegrationMethod(lease, workspace), /method|control|repository/i);
  }
});

test('external or lost-reply merge proves exact integrated tree and lineage before completion', async () => {
  const f = fixture(); f.mode('merged');
  assert.deepEqual((await verifyMergedCandidate(f)).candidate, { sourceCommit: merged, gitTree: tree });
  f.mode('wrong-tree'); await assert.rejects(verifyMergedCandidate(f), /tree|integration/i);
  f.mode('merged'); f.publication.baseBranch = 'unapproved'; await assert.rejects(verifyMergedCandidate(f), /base/i); f.publication.baseBranch = 'main';
  f.mode('open'); await assert.rejects(verifyMergedCandidate(f), /merged|integration/i);
});

test('Showcase derives actual checks and findings, with an honest source-only target and one outcome', () => {
  const f = fixture(), run = { id: 'run-one', issue: 7 }, candidate = { sourceCommit: base, gitTree: tree };
  const ledger = { status: () => ({ candidate }), outputs: () => [{ candidate, output: { outcome: 'success', summary: 'Corrected the exported value.', findings: [], documents: [{ kind: 'review' }] } }],
    captured: () => ({ checks: [{ name: 'Tests', command: 'node --test' }] }), evidence: () => [{ kind: 'tests', state: 'verified', result: { candidate, result: { name: 'Tests', command: 'node --test', exitCode: 0 } } }, { kind: 'review', state: 'verified', result: { candidate } }] };
  const report = buildDevelopmentShowcase({ ledger, run, workspace: f.workspace, publication: f.publication });
  assert.equal(report.issue, 7); assert.equal(report.candidate.sourceCommit, head); assert.deepEqual(report.findings, []);
  assert.match(report.target, /source|Source/); assert.match(report.nextOutcome, /close|cleanup/i); assert.ok(report.steps.every(step => step.action && step.expected));
});

test('merge journals dispatch once, verifies lost or external replies, and retains denied or revoked outcomes', async () => {
  for (const gated of [true, false]) {
  for (const scenario of ['lost', 'squash-lost', 'external', 'denied', 'revoked']) {
    const f = fixture(), root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-integration-'))), store = openWorkspaceStore(root);
    const method = scenario === 'squash-lost' ? 'squash' : 'merge'; f.method(method);
    const run = { id: 'run-one', repository: 'repo-one', issue: 7, epoch: 1, createdAt: Date.now(), limits: { 'limits.agentSeconds': 30 }, policyRevision: 1, policyHash: 'e'.repeat(64), pipelineHash: 'f'.repeat(64) },
      state = { state: 'candidate', step: 'integrate', candidate: { sourceCommit: base, gitTree: tree }, ...(gated ? { qa: { decision: 'approve', hash: 'e'.repeat(64), showcase: { candidate: f.publication.candidate } } } : {}) };
    const ledger = { status: () => state, captured: () => ({ run, integrationMethod: method, executionProfile: { kind: 'pipeliner-desktop', version: 1 }, checks: [{ name: 'Tests', command: 'node --test' }], source: { sourceCommit: base, gitTree: 'f'.repeat(40) },
      pipeline: { steps: [...(gated ? [{ id: 'qa', kind: 'pm-qa' }] : []), { id: 'integrate', kind: 'pr-integration', routes: { success: 'complete' } }] } }),
      outputs: () => [{ candidate: state.candidate, output: { outcome: 'success', summary: 'Synthetic current review.', documents: [{ kind: 'review' }], findings: [] } }],
      evidence: () => [{ kind: 'tests', state: 'verified', result: { candidate: state.candidate, result: { name: 'Tests', command: 'node --test', exitCode: 0 } } }, { kind: 'review', state: 'verified', result: { candidate: state.candidate } }],
      recordIntegration(binding, proof) { assert.deepEqual(binding, { runId: run.id, epoch: 1 }); state.integration = proof; } };
    let action, dispatches = 0;
    const runtime = { intent(binding, request) { action ??= { id: 'merge-action', ...request, ...binding, repository: run.repository, issue: 7, fingerprint: 'f'.repeat(64), attempts: 1, dispatchEpoch: 1 }; return action; },
      dispatch() { assert.equal(dispatches++, 0); return { dispatched: true }; },
      async reconcile() { return { state: 'verified', resultHash: integrationObservation(action, state.integration).resultHash }; } };
    const input = { ...f, run, store, ledger, runtime, authority() {} };
    try {
      f.reply(scenario); if (scenario === 'external') f.mode('merged');
      if (['denied', 'revoked'].includes(scenario)) {
        await assert.rejects(mergeDevelopmentCandidate(input), scenario === 'denied' ? /http-405/ : /connection-changed/);
        assert.equal(state.integration, undefined); assert.equal(store.pending('development').length, 1); assert.equal(f.writes(), 1);
        await assert.rejects(mergeDevelopmentCandidate(input)); assert.equal(f.writes(), 1);
      } else {
        if (!gated && scenario === 'lost') { f.protect(true); await assert.rejects(mergeDevelopmentCandidate(input), /protected/i); assert.equal(f.writes(), 0); f.protect(false); }
        if (!gated && scenario === 'lost') {
          const send = f.lease.send; let pendingReads = 0;
          f.lease.send = async (url, request) => {
            if (new URL(url).pathname.endsWith('/actions/runs') && pendingReads++ === 0) {
              assert.equal(f.writes(), 0); assert.equal(dispatches, 0);
              return Response.json({ total_count: 1, workflow_runs: [{ id: 30, name: 'Quality', head_sha: head, check_suite_id: 20, status: 'in_progress', conclusion: null }] });
            }
            return send(url, request);
          };
        }
        const proof = await mergeDevelopmentCandidate(input); assert.equal(proof.candidate.sourceCommit, merged);
        await mergeDevelopmentCandidate(input); assert.equal(dispatches, 1); assert.equal(f.writes(), scenario === 'external' ? 0 : 1);
        assert.equal(store.pending('development').length, 0);
      }
    } finally { store.close(); rmSync(root, { recursive: true }); }
  }
  }
});
