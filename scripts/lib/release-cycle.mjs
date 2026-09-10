import { evaluateQA, requirePairedQA } from './qa.mjs';
import { identityMatches, nonempty, renderApproval } from './showcase.mjs';
import { createHash } from 'node:crypto';

export function releaseScopeKey(state) {
  const numbers = state.issues.map(i => i.number).sort((a, b) => a - b);
  return createHash('sha256').update(JSON.stringify([state.releaseIssue, state.target, state.phase, numbers])).digest('hex');
}

function strings(items, label, min = 0) {
  if (!Array.isArray(items) || items.length < min || items.some(v => !nonempty(v)) || new Set(items).size !== items.length) throw new Error(`${label} requires unique nonempty values`);
}
function branch(value) {
  // Literal branch authority, not a refspec, expression or inferred template.
  return nonempty(value) && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') &&
    !/[\s~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && value !== '@' &&
    value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}
export function validateCycle(profile) {
  const cycle = profile.release?.cycle;
  if (cycle === undefined) return;
  requirePairedQA(profile.qa);
  if (!cycle || !Array.isArray(cycle.phases) || cycle.phases.length < 2) throw new Error('release cycle needs at least two ordered phases');
  const phases = cycle.phases;
  strings(phases.map(p => p?.id), 'phase IDs', 2);
  strings(phases.map(p => p?.branch), 'phase branches', 2);
  if (phases[0].kind !== 'development' || phases.at(-1).kind !== 'production' || phases.slice(0, -1).some(p => p.kind === 'production')) throw new Error('cycle must run development through final production');
  let stabilized = false;
  for (const phase of phases) {
    if (!['development', 'stabilization', 'production'].includes(phase.kind) || !branch(phase.branch)) throw new Error('invalid phase kind or branch');
    if (phase.kind === 'stabilization') stabilized = true;
    if (stabilized && phase.kind === 'development') throw new Error('development cannot follow frozen stabilization');
    strings(phase.environments, 'phase environments', 1);
    if (phase.environments.some(name => !profile.release.environments.some(e => e.name === name))) throw new Error('unknown phase environment');
    strings(phase.readiness, 'readiness criteria', 1);
    if (!nonempty(phase.approvalPhrase) || !['source', 'same-artifact', 'distinct-artifact'].includes(phase.promotion)) throw new Error('phase approval and promotion required');
    strings(phase.forwardPortTo, 'forward-port targets');
    if (phase.forwardPortTo.some(id => !phases.some(p => p.id === id && p.kind === 'development')) || (phase.kind !== 'stabilization' && phase.forwardPortTo.length)) throw new Error('forward-port targets must be development phases for a stabilization phase');
    if (phase.kind === 'stabilization' && phase.forwardPortTo.length === 0) throw new Error('stabilization requires explicit development forward-port targets');
    if (phase.kind === 'production' && profile.release.strategy === 'immutable-promotion' && phase.promotion !== 'same-artifact') throw new Error('immutable-promotion requires same-artifact Production');
  }
  return cycle;
}
export function issueBranch(profile, { phase, kind } = {}) {
  if (!profile.release?.cycle) {
    if (phase !== undefined) throw new Error('phase requested without configured cycle');
    return { base: profile.repository.defaultBranch, forwardPort: [] };
  }
  validateCycle(profile);
  const selected = profile.release.cycle.phases.find(p => p.id === phase);
  if (!selected || !['feature', 'fix', 'release'].includes(kind)) throw new Error('known phase and Issue kind required');
  if (selected.kind === 'production' && kind !== 'release') throw new Error('production fixes must enter governed development or stabilization');
  if (selected.kind === 'stabilization' && kind === 'feature') throw new Error('Beta scope is frozen; new features require future development intake');
  return { base: selected.branch, forwardPort: selected.forwardPortTo.map(id => profile.release.cycle.phases.find(p => p.id === id).branch) };
}
export function evaluatePhase(profile, state) {
  validateCycle(profile);
  const phases = profile.release.cycle?.phases;
  const phase = phases?.find(p => p.id === state?.phase);
  const wait = reason => ({ state: 'waiting', reason });
  if (!phase || !nonempty(state.target) || !Number.isSafeInteger(state.releaseIssue) || state.releaseIssue < 1) return wait('Release target, owning Issue and configured phase required.');
  const stageKeys = phase.kind === 'production' ? profile.release.candidateIdentity : (profile.release.preReleaseIdentity ?? ['sourceCommit', 'gitTree']);
  const keys = [...new Set([...profile.qa.candidateIdentity, ...stageKeys, 'releaseScope', ...(phase.promotion === 'source' ? [] : ['artifactDigest'])])];
  if (!identityMatches(keys, state.candidate, state.candidate)) return wait('Complete aggregate candidate identity required.');
  if (!Array.isArray(state.issues) || state.issues.length === 0 || state.issues.some(i => !Number.isSafeInteger(i?.number) || i.number < 1 || i.number === state.releaseIssue || i.accepted !== true || !nonempty(i.evidence))) return wait('All scoped Issues need verified phase acceptance.');
  const numbers = state.issues.map(i => i.number);
  if (new Set(numbers).size !== numbers.length || !Array.isArray(state.frozenIssues) || state.frozenIssues.length !== numbers.length || new Set(state.frozenIssues).size !== numbers.length || state.frozenIssues.some(n => !numbers.includes(n))) return wait('Freeze exact accepted release scope.');
  if (!Array.isArray(state.blockers) || state.blockers.length) return wait('Resolve release blockers without bypassing the active slot.');
  if (state.candidate.releaseScope !== releaseScopeKey(state)) return wait('Candidate approval must bind the exact release target, phase and scope.');
  if (!Array.isArray(state.readiness) || state.readiness.length !== phase.readiness.length || phase.readiness.some(c => state.readiness.filter(r => r?.criterion === c && r.passed === true && nonempty(r.evidence)).length !== 1)) return wait('Every phase readiness criterion requires evidence.');
  let qa;
  try { qa = evaluateQA({ ...profile.qa, candidateIdentity: keys }, state.candidate, state.records, { currentTurn: state.currentTurn, scope: 'release', issue: state.releaseIssue, cleanupResolutions: state.cleanupResolutions }); }
  catch { return wait('Valid aggregate QA evidence required.'); }
  if (qa.state !== 'complete') return wait(`Aggregate QA: ${qa.reason}`);
  const verify = state.verification;
  if (verify?.passed !== true || !nonempty(verify.evidence) || !identityMatches(keys, state.candidate, verify.candidate)) return wait('Integrated candidate verification required.');
  if (!Array.isArray(verify.environments) || verify.environments.length !== phase.environments.length || phase.environments.some(name => verify.environments.filter(e => e?.name === name && e.passed === true && nonempty(e.evidence) && identityMatches(keys, state.candidate, e.candidate)).length !== 1)) return wait('Verify the exact candidate in every phase environment.');
  if (!nonempty(state.rollback?.target) || !nonempty(state.rollback?.evidence)) return wait('Known-good rollback evidence required.');
  if (!Array.isArray(state.approvals) || state.approvals.length !== profile.qa.pms.length || profile.qa.pms.some(pm => state.approvals.filter(a => a?.pm === pm.id && a.phase === phase.id && a.phrase === renderApproval(phase.approvalPhrase, state.releaseIssue) && identityMatches(keys, state.candidate, a.candidate) && nonempty(a.evidence)).length !== 1)) return wait('Every required Human PM must approve this exact phase candidate.');
  if (!Array.isArray(state.forwardPorts) || state.forwardPorts.length !== phase.forwardPortTo.length || phase.forwardPortTo.some(id => state.forwardPorts.filter(f => f?.phase === id && f.verified === true && identityMatches(keys, state.candidate, f.sourceCandidate) && nonempty(f.commit) && nonempty(f.gitTree) && nonempty(f.evidence)).length !== 1)) return wait('Verify every required forward-port integration.');
  if (phase.promotion !== 'source') {
    const artifact = state.artifact;
    if (!nonempty(artifact?.digest) || !nonempty(artifact.evidence) || artifact.verified !== true || !identityMatches(keys, state.candidate, artifact.candidate)) return wait('Verified artifact identity required.');
    if (state.candidate.artifactDigest !== artifact.digest) return wait('Artifact digest must equal the approved candidate artifactDigest.');
    if (phase.promotion === 'same-artifact' && artifact.previousDigest !== artifact.digest) return wait('Promotion must preserve the previous approved artifact digest.');
    if (phase.promotion === 'distinct-artifact' && !nonempty(artifact.channelInputs)) return wait('Governed channel inputs required for distinct artifact.');
    if (state.approvals.some(a => a.artifactDigest !== artifact.digest)) return wait('Every PM must approve the final artifact digest.');
  }
  return { state: 'ready', phase: phase.id, next: phases[phases.indexOf(phase) + 1]?.id ?? null,
    reason: 'Aggregate phase gate satisfied; verify live authority before mutation. Production authorization and final acceptance remain distinct.' };
}
