import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJSON } from '../core/settings.mjs';
import { githubRequest } from '../repositories/github.mjs';
import { developmentIntegrationAuthority } from './state.mjs';

export const integrationHash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const currentTree = (row, candidate) => canonicalJSON(row.candidate) === canonicalJSON(candidate);
const prefix = workspace => '/repos/' + workspace.slug;
function pending(name) { const error = new Error('Development integration evidence is pending: ' + name); error.code = 'integration-pending'; return error; }

export async function readAutonomousBranch(lease, workspace, profile, sourceCommit) {
  const name = profile.repository.defaultBranch, branch = await githubRequest(lease, 'GET', prefix(workspace) + '/branches/' + encodeURIComponent(name));
  if (branch.name !== name || branch.commit?.sha !== sourceCommit || branch.protected !== false) throw new Error('Development protected or changed integration branch needs a qualified autonomous path before execution.');
}

export function verifyDevelopmentEvidence({ ledger, run, publication }) {
  const state = ledger.status(run.id), outputs = ledger.outputs(run.id).filter(row => currentTree(row, state.candidate) && row.output.outcome === 'success');
  const evidence = ledger.evidence({ runId: run.id, epoch: run.epoch }), results = evidence.filter(row => row.kind === 'tests' && row.state === 'verified' && currentTree(row.result, state.candidate));
  const captured = ledger.captured(run.id), latest = outputs.filter(row => row.output.documents.some(document => document.kind === 'review')).at(-1)?.output;
  if (!latest || latest.findings.some(finding => ['high', 'critical'].includes(finding.severity))
    || !evidence.some(row => row.kind === 'review' && row.state === 'verified' && currentTree(row.result, state.candidate))
    || publication.candidate.gitTree !== state.candidate.gitTree || !captured.checks.every(check => results.some(row => row.result.result.name === check.name
    && row.result.result.command === check.command && row.result.result.exitCode === 0 && !row.result.result.truncated && !row.result.result.timedOut))) throw new Error('Development integration requires actual current checks and review');
  return { captured, latest };
}
export function buildDevelopmentShowcase({ ledger, run, workspace, publication }) {
  const { captured, latest } = verifyDevelopmentEvidence({ ledger, run, publication });
  const findings = (latest.findings ?? []).map(finding => ({ problem: finding.text, remediation: 'Review this reported ' + finding.severity + ' finding before approval.', evidence: 'Current candidate review.' }));
  return { scope: 'issue', issue: run.issue, summary: latest.summary, findings,
    testResults: captured.checks.map(check => check.name + ': passed actual ' + check.command + ' on this tree.'),
    target: 'Source-only candidate: ' + (publication.url ?? 'https://github.com/' + workspace.slug + '/pull/' + publication.number),
    prerequisites: ['Access to this repository and its prepared PR.', 'This is a source-only outcome; no application or installer test target is claimed.'],
    steps: [{ action: 'Open the prepared PR and inspect the requested change.', expected: latest.summary },
      { action: 'Review the recorded repository checks and candidate review.', expected: 'All captured checks pass on this exact tree; reported findings and limitations remain visible.' },
      { action: 'Compare the change with this Issue. Approve the tested version or describe the correction needed.', expected: 'Approval integrates this exact candidate; feedback returns to the same Issue and requires fresh testing.' }],
    regressions: ['Check that the change stays within this Issue.', 'Original local modified and untracked work remains preserved.', 'Stale candidate, missing checks and external controls block integration.'],
    limitations: ['Human application/installer testing needs a built target and remains pending for this source-only run.', 'Provider, native accessibility and other-platform evidence are separate from these source checks.'],
    nextOutcome: 'Merge this exact source candidate, verify the integrated tree, close this Issue and its Project card, clean run-owned resources and release its reservation. No additional PR or completion approval.',
    approvalPhrase: 'Approved', candidate: publication.candidate };
}

async function collection(lease, path, key, binding = () => true) {
  const all = [], seen = new Set(); let total;
  for (let page = 1; page <= 100; page++) {
    const result = await githubRequest(lease, 'GET', path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
    if (!Number.isSafeInteger(result.total_count) || result.total_count < 0 || result.total_count > 10000 || total !== undefined && total !== result.total_count
      || !Array.isArray(result[key]) || result[key].length > 100 || !binding(result)) throw new Error('Development checks readback incomplete');
    total = result.total_count;
    for (const item of result[key]) { if (!positive(item.id) || seen.has(item.id)) throw new Error('Development checks readback incomplete'); seen.add(item.id); all.push(item); }
    if (all.length === total) return all;
    if (!result[key].length || all.length > total) throw new Error('Development checks readback incomplete');
  }
  throw new Error('Development checks readback incomplete');
}

export async function readRequiredChecks(lease, workspace, head, required) {
  if (!sha(head) || !Array.isArray(required) || required.length > 64 || new Set(required).size !== required.length
    || !required.every(name => typeof name === 'string' && name.trim() && name.length <= 240)) throw new Error('Development required check configuration invalid');
  if (!required.length) return [];
  const root = prefix(workspace), checks = await collection(lease, root + '/commits/' + head + '/check-runs?filter=latest', 'check_runs');
  const statuses = await collection(lease, root + '/commits/' + head + '/status', 'statuses', value => value.sha === head);
  if (checks.some(check => check.head_sha !== head || typeof check.name !== 'string' || !positive(check.check_suite?.id)
    || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(check.status))
    || statuses.some(status => typeof status.context !== 'string' || !['error', 'failure', 'pending', 'success'].includes(status.state))) throw new Error('Development checks candidate mismatch');
  const workflows = required.some(name => name.includes(' / ')) ? await collection(lease, root + '/actions/runs?head_sha=' + head, 'workflow_runs') : [];
  if (workflows.some(run => run.head_sha !== head || !positive(run.check_suite_id) || typeof run.name !== 'string')) throw new Error('Development checks workflow binding invalid');
  return required.map(name => {
    const split = name.lastIndexOf(' / '), workflow = split >= 0 ? name.slice(0, split) : null, job = split >= 0 ? name.slice(split + 3) : name;
    const direct = statuses.filter(status => status.context === name);
    let matches = checks.filter(check => check.name === job);
    if (!workflow && direct.length) {
      if (direct.length !== 1 || matches.length) throw new Error('Development required check is ambiguous: ' + name);
      if (direct[0].state === 'pending') throw pending(name);
      if (direct[0].state !== 'success') throw new Error('Development required check failed: ' + name);
      return { name, kind: 'status', id: direct[0].id, head, state: 'success' };
    }
    if (workflow) {
      const runs = workflows.filter(run => run.name === workflow).sort((a, b) => b.id - a.id), latest = runs[0];
      if (!latest || latest.status !== 'completed') throw pending(name);
      if (latest.conclusion !== 'success') throw new Error('Development required workflow check failed: ' + name);
      matches = matches.filter(check => check.check_suite.app?.slug === 'github-actions' && check.check_suite.id === latest.check_suite_id);
    }
    if (!matches.length || matches.length === 1 && matches[0].status !== 'completed') throw pending(name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') throw new Error('Development required check failed or ambiguous: ' + name);
    return { name, kind: 'check-run', id: matches[0].id, head, state: 'success' };
  });
}

function pullBinding(pull, workspace, publication) {
  if (!positive(publication.number) || !sha(publication.head) || publication.candidate.sourceCommit !== publication.head || !sha(publication.base) || !sha(publication.candidate.gitTree)
    || pull.number !== publication.number || pull.head?.sha !== publication.head || pull.head.ref !== publication.branch
    || pull.head.repo?.id !== workspace.numericId || pull.head.repo.node_id !== workspace.repositoryId
    || pull.base?.repo?.id !== workspace.numericId || pull.base.repo.node_id !== workspace.repositoryId || typeof publication.baseBranch !== 'string'
    || pull.base.ref !== publication.baseBranch || pull.draft !== false) throw new Error('Development PR candidate head, base or repository changed');
}
export async function readDevelopmentCandidate({ lease, workspace, publication, profile, capturedSource }) {
  const root = prefix(workspace), pull = await githubRequest(lease, 'GET', root + '/pulls/' + publication.number); pullBinding(pull, workspace, publication);
  if (pull.base.ref !== profile.repository.defaultBranch || publication.base !== capturedSource.sourceCommit) throw new Error('Development integration base changed');
  const commit = await githubRequest(lease, 'GET', root + '/git/commits/' + publication.head);
  if (commit.sha !== publication.head || commit.tree?.sha !== publication.candidate.gitTree) throw new Error('Development candidate tree changed');
  return { candidate: publication.candidate, pull };
}
export async function readIntegrationCandidate(input) {
  const { lease, workspace, publication, profile } = input, root = prefix(workspace), { pull } = await readDevelopmentCandidate(input);
  const checks = await readRequiredChecks(lease, workspace, publication.head, profile.quality.requiredChecks);
  if (pull.merged === true) return { candidate: publication.candidate, checks, merged: true, pull };
  const base = await githubRequest(lease, 'GET', root + '/git/ref/heads/' + encodeURIComponent(profile.repository.defaultBranch));
  if (pull.state !== 'open' || pull.merged !== false || ['blocked', 'dirty'].includes(pull.mergeable_state)
    || pull.base.sha !== publication.base || base.ref !== 'refs/heads/' + profile.repository.defaultBranch || base.object?.type !== 'commit' || base.object.sha !== publication.base) throw new Error('Development integration candidate or external control changed');
  if (pull.mergeable === null || pull.mergeable_state === 'unknown') throw pending('GitHub mergeability');
  if (pull.mergeable !== true) throw new Error('Development integration candidate or external control changed');
  return { candidate: publication.candidate, checks, merged: false, pull };
}

export async function verifyMergedCandidate({ lease, workspace, publication }) {
  const root = prefix(workspace), pull = await githubRequest(lease, 'GET', root + '/pulls/' + publication.number); pullBinding(pull, workspace, publication);
  if (pull.merged !== true || pull.state !== 'closed' || !sha(pull.merge_commit_sha)) throw new Error('Development integration is not verified merged');
  const commit = await githubRequest(lease, 'GET', root + '/git/commits/' + pull.merge_commit_sha);
  if (commit.sha !== pull.merge_commit_sha || commit.tree?.sha !== publication.candidate.gitTree || !Array.isArray(commit.parents)
    || !(commit.parents.length === 2 && commit.parents[0].sha === publication.base && commit.parents[1].sha === publication.head
      || commit.parents.length === 1 && commit.parents[0].sha === publication.base)) throw new Error('Development integration tree or lineage changed');
  const base = await githubRequest(lease, 'GET', root + '/git/ref/heads/' + encodeURIComponent(pull.base.ref));
  if (base.ref !== 'refs/heads/' + pull.base.ref || base.object?.type !== 'commit' || base.object.sha !== commit.sha) throw new Error('Development integrated default branch changed; reconciliation required');
  return { candidate: { sourceCommit: commit.sha, gitTree: commit.tree.sha }, source: publication.candidate, pullRequest: publication.number };
}

export const integrationOutcome = publication => integrationHash({ kind: 'exact-pr-integration', number: publication.number, base: publication.base, source: publication.candidate });
export function integrationObservation(action, proof) {
  if (canonicalJSON(action.candidate) !== canonicalJSON(proof.source) || proof.candidate.gitTree !== action.candidate.gitTree) throw new Error('Development integration effect binding changed');
  const keys = ['runId', 'repository', 'issue', 'step', 'epoch', 'operation', 'candidate', 'commandId', 'requestHash', 'preconditionsHash', 'expectedHash', 'fingerprint', 'attempts', 'dispatchEpoch'];
  return { ...Object.fromEntries(keys.map(key => [key, action[key]])), result: 'present', resultHash: action.expectedHash,
    observationHash: integrationHash(proof), observedAt: Date.now() };
}

export async function mergeDevelopmentCandidate({ store, runtime, ledger, lease, workspace, run, publication, profile, authority }) {
  const binding = { runId: run.id, epoch: run.epoch }, state = ledger.status(run.id), captured = ledger.captured(run.id);
  const current = () => { lease.check(); authority(); };
  current();
  if (profile.release?.strategy !== 'none') throw new Error('Development source-only integration unavailable');
  const approval = developmentIntegrationAuthority(captured, state, publication.candidate);
  verifyDevelopmentEvidence({ ledger, run, publication });
  let inspected;
  for (;;) {
    current();
    try { inspected = await readIntegrationCandidate({ lease, workspace, publication, profile, capturedSource: captured.source }); break; }
    catch (error) {
      if (error.code !== 'integration-pending') throw error;
      const remaining = run.createdAt + run.limits?.['limits.agentSeconds'] * 1000 - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Development captured deadline exhausted while waiting for integration evidence.');
      await delay(Math.min(2000, remaining), undefined, { signal: lease.signal });
    }
  }
  current();
  if (approval.kind === 'standing-policy' && !inspected.merged) { await readAutonomousBranch(lease, workspace, profile, publication.base); current(); }
  const request = { sha: publication.head, merge_method: 'merge' }, expectedHash = integrationOutcome(publication);
  const action = runtime.intent(binding, { commandId: 'integrate-' + publication.head, step: state.step, operation: 'github.pr.merge', candidate: publication.candidate,
    requestHash: integrationHash(request), preconditionsHash: integrationHash({ base: publication.base, checks: inspected.checks, authority: approval }), expectedHash });
  const intent = store.prepare(run.id + '-integration', 'merge-' + publication.head, { kind: 'development', runId: run.id, repository: run.repository,
    issue: run.issue, candidate: publication.candidate, publication, actionId: action.id, expectedHash });
  if (intent.state === 'denied') throw new Error('Development merge was denied; explicit recovery is required');
  if (intent.state === 'prepared') {
    if (inspected.merged) {
      // An external merge still passes captured authority, checks and exact integration readback.
      if (!runtime.dispatch(binding, action.id).dispatched || !store.dispatch(intent.id)) throw new Error('Development external integration record changed');
    } else {
      current(); if (!runtime.dispatch(binding, action.id).dispatched || !store.dispatch(intent.id)) throw new Error('Development merge dispatch changed');
      try {
        const result = await githubRequest(lease, 'PUT', prefix(workspace) + '/pulls/' + publication.number + '/merge', request); current();
        if (result.merged !== true || !sha(result.sha)) throw new Error('Development merge reply incomplete');
        store.checkpoint(intent.id, { mergeCommit: result.sha });
      } catch (error) {
        store.finish(intent.id, 'uncertain', { error: 'merge-needs-readback' });
        if (error.message !== 'write-result-uncertain') throw error;
      }
    }
  }
  current(); const verified = await verifyMergedCandidate({ lease, workspace, publication }); current();
  const proof = { ...verified, resultHash: expectedHash };
  const before = store.effects(run.id + '-integration').find(value => value.id === intent.id);
  if (before.state !== 'verified') store.finish(intent.id, 'verified', proof);
  ledger.recordIntegration(binding, proof);
  const result = await runtime.reconcile(binding, action.id); current();
  if (result.state !== 'verified' || result.resultHash !== expectedHash) throw new Error('Development runtime integration still needs reconciliation');
  return proof;
}
