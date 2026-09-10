// Read-only decisions over agent-verified evidence, never execution or approval proof.
export function selectWork(profile, { issues, requested, intent = 'start' }) {
  if (intent !== 'start') return { state: 'read-only' };
  if (!Array.isArray(issues)) return { state: 'blocked', reason: 'Complete live Issue/Project inventory required.' };
  const statuses = profile.project.statuses;
  if (issues.some(issue => !issue || !Number.isInteger(issue.number) || issue.number < 1 || !['OPEN', 'CLOSED'].includes(issue.state) || !Object.values(statuses).includes(issue.status)) || new Set(issues.map(issue => issue.number)).size !== issues.length) return { state: 'blocked', reason: 'Issue inventory has missing or conflicting identity/state.' };
  const active = issues.filter(issue => [statuses.inProgress, statuses.inReview].includes(issue.status));
  if (active.length > 1) return { state: 'blocked', reason: 'Multiple active Issues.' };
  if (active.length) {
    if (active[0].state !== 'OPEN' || (requested !== undefined && requested !== active[0].number)) return { state: 'blocked', reason: 'Resolve the active Issue before selecting another.' };
    return { state: 'continue', issue: active[0] };
  }
  const pool = requested === undefined ? issues.filter(issue => issue.state === 'OPEN' && issue.status === statuses.backlog) : issues.filter(issue => issue.number === requested);
  if (requested !== undefined && (pool.length !== 1 || pool[0].state !== 'OPEN' || pool[0].status !== statuses.backlog)) return { state: 'blocked', reason: 'Requested Issue must be open Backlog; On Hold requires explicit resumption.' };
  const priorities = profile.project.metadataFields.priority.options;
  if (pool.some(issue => typeof issue.ready !== 'boolean' || !Number.isInteger(issue.number) || issue.number < 1 || !priorities.includes(issue.priority))) return { state: 'question', reason: 'Resolve missing readiness or priority evidence.' };
  const ready = pool.filter(issue => issue.ready).sort((a, b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority) || a.number - b.number);
  return ready.length ? { state: 'start', issue: ready[0] } : { state: 'blocked', reason: 'No ready Issue in scope.' };
}

export function clarificationDecision({ answered = false } = {}) {
  return { channel: 'message', state: answered === true ? 'answered' : 'waiting', timeout: null, endTurn: answered !== true };
}

export function reviewRoute({ status, pullRequestState, findings = false }, statuses = { inProgress: 'In Progress', inReview: 'In Review' }) {
  if (![statuses.inProgress, statuses.inReview].includes(status)) return 'blocked';
  if (pullRequestState === 'MERGED') return findings ? 'new-remediation-pr' : 'acceptance';
  if (pullRequestState === 'OPEN') return findings ? 'remediate' : 'review';
  return 'blocked';
}

export function identityKeys(profile, phase) {
  if (phase === 'released') return [...profile.release.candidateIdentity];
  if (phase !== 'pre-release') throw new Error('unknown identity phase');
  return [...(profile.release.preReleaseIdentity ?? (['none', 'direct-production'].includes(profile.release.strategy) ? ['sourceCommit', 'gitTree'] : profile.release.candidateIdentity))];
}

export function releaseStages(strategy, { hasProduction = false } = {}) {
  switch (strategy) {
    // Local QA includes every required Human approval; no duplicate closure gate.
    case 'none': return ['agent-review', 'local-qa', 'merge', 'verify-source', 'close'];
    case 'direct-production': return ['agent-review', 'local-qa', 'production-approval', 'merge', 'deploy', 'verify-release', 'completion-approval', 'close'];
    case 'immutable-promotion': return ['agent-review', 'review-deploy', 'local-qa', 'production-approval', 'merge', 'promote-same-artifact', 'verify-release', 'completion-approval', 'close'];
    case 'multi-environment': return ['agent-review', 'prepare-native', 'local-qa', ...(hasProduction ? ['production-approval'] : []), 'merge', ...(hasProduction ? ['deploy'] : []), 'verify-release', ...(hasProduction ? ['completion-approval'] : []), 'close'];
    default: throw new Error('unknown release strategy');
  }
}
