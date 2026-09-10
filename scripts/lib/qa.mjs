import { cleanupComplete } from './cleanup.mjs';
import { identityMatches, nonempty, renderApproval, showcaseComplete } from './showcase.mjs';

const string = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
};
const array = (value, field, minimum = 1) => {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${field} requires at least ${minimum} entries`);
};
function strings(value, field, minimum = 1) {
  array(value, field, minimum); value.forEach(item => string(item, field));
  if (new Set(value).size !== value.length) throw new Error(`${field} contains duplicates`);
}
function registry(items, field) {
  array(items, field);
  items.forEach(item => string(item?.id, `${field}.id`));
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`${field} contains duplicate IDs`);
  return new Map(items.map(item => [item.id, item]));
}
export function validateQA(qa) {
  if (!qa || typeof qa !== 'object') throw new Error('QA discovery required');
  if (!['native', 'web', 'library', 'tooling'].includes(qa.applicationType)) throw new Error('qa.applicationType is invalid');
  strings(qa.candidateIdentity, 'qa.candidateIdentity', 2);
  for (const key of ['sourceCommit', 'gitTree']) if (!qa.candidateIdentity.includes(key)) throw new Error(`qa.candidateIdentity requires ${key}`);
  array(qa.runtimePlatforms, 'qa.runtimePlatforms');
  qa.runtimePlatforms.forEach(platform => { string(platform?.os, 'runtime OS'); string(platform?.architecture, 'runtime architecture'); });
  const environments = registry(qa.environments, 'qa.environments');
  for (const environment of environments.values()) {
    string(environment.os, 'environment.os'); string(environment.architecture, 'environment.architecture');
    for (const key of ['prerequisites', 'setup', 'suite', 'teardown']) strings(environment[key], `environment.${key}`, key === 'suite' ? 1 : 0);
  }
  if (qa.applicationType === 'native' && qa.runtimePlatforms.some(platform => !qa.environments.some(environment => environment.os === platform.os && environment.architecture === platform.architecture))) throw new Error('every native runtime platform requires a compatible QA environment');
  const developers = registry(qa.developers, 'qa.developers');
  for (const developer of developers.values()) {
    strings(developer.environments, 'developer.environments');
    if (developer.environments.some(id => !environments.has(id))) throw new Error('developer references unknown environment');
  }
  registry(qa.turns, 'qa.turns');
  for (const turn of qa.turns) {
    if (!developers.has(turn.developer)) throw new Error('turn references unknown developer');
    if (!environments.has(turn.environment)) throw new Error('turn references unknown environment');
    if (!developers.get(turn.developer).environments.includes(turn.environment)) throw new Error('turn environment is not available to developer');
    string(turn.pm, 'turn.pm'); string(turn.approvalPhrase, 'turn.approvalPhrase');
  }
  if ([...environments.keys()].some(id => !qa.turns.some(turn => turn.environment === id))) throw new Error('every QA environment requires a turn');
  if ([...developers.keys()].some(id => !qa.turns.some(turn => turn.developer === id))) throw new Error('every QA developer requires a turn');
  if (qa.mode !== undefined && qa.mode !== 'circulating') throw new Error('unknown QA mode');
  if (qa.mode === 'circulating' || qa.pms !== undefined || qa.developers.some(d => d.kind !== undefined || d.github !== undefined)) {
    if (qa.mode !== 'circulating') throw new Error('paired QA discovery required: circulating mode');
    const pms = registry(qa.pms, 'qa.pms');
    for (const pm of pms.values()) if (pm.kind !== 'human') throw new Error('PM must be human');
    for (const dev of developers.values()) {
      if (dev.kind !== 'agent') throw new Error('Dev must be agent');
      string(dev.github, 'developer.github');
    }
    if (qa.turns.some(turn => !pms.has(turn.pm))) throw new Error('turn references unknown PM');
    if ([...pms.keys()].some(id => !qa.turns.some(turn => turn.pm === id))) throw new Error('every PM requires a testing turn');
  }
  return qa;
}
export function requirePairedQA(qa) {
  validateQA(qa);
  if (qa.mode !== 'circulating') throw new Error('paired QA discovery required; resolve Agent Devs and Human PMs before new QA or adoption');
  return qa;
}
export function migrateQA(profile, qa) {
  validateQA(qa);
  return { ...structuredClone(profile), qa: structuredClone(qa) };
}
function matches(keys, left, right) {
  return keys.every(key => typeof left?.[key] === 'string' && left[key].trim() && left[key] === right?.[key]);
}
export function evaluateQA(qa, candidate, records, options = {}) {
  validateQA(qa);
  if (qa.mode === 'circulating') return evaluateCirculation(qa, candidate, records, options);
  if (!matches(qa.candidateIdentity, candidate, candidate)) throw new Error('incomplete candidate identity');
  if (!Array.isArray(records)) throw new Error('QA records must be an array');
  const ids = records.map(record => record?.turn);
  if (new Set(ids).size !== ids.length || ids.some(id => !qa.turns.some(turn => turn.id === id))) throw new Error('duplicate or unknown QA turn evidence');
  const baton = qa.developers.length > 1 || qa.environments.length > 1;
  for (const [index, turn] of qa.turns.entries()) {
    const result = (state, reason) => ({ state, reason, baton, current: turn, next: qa.turns[index + 1] ?? null, projectStatus: 'In Progress' });
    const record = records.find(item => item.turn === turn.id);
    if (!record) return result('pickup', 'Incoming owner must verify candidate and pick up this turn.');
    if (!matches(qa.candidateIdentity, candidate, record.candidate)) return result('remediation', 'Candidate changed; all stale QA evidence and approvals require retesting.');
    if (record.developer !== turn.developer || record.environment !== turn.environment) return result('remediation', 'Wrong owner or environment.');
    const environment = qa.environments.find(item => item.id === turn.environment);
    if (record.host?.available !== true || record.host.os !== environment.os || record.host.architecture !== environment.architecture) return result('waiting', 'Compatible local host pending verification.');
    if (record.candidateAvailable !== true || record.pickedUp !== true) return result('waiting', 'Exact candidate availability and incoming pickup required.');
    if (typeof record.session !== 'string' || !record.session.trim()) return result('waiting', 'Validation session required.');
    if (!Array.isArray(record.suite) || record.suite.length !== environment.suite.length || environment.suite.some((command, i) => record.suite[i]?.command !== command || record.suite[i].exitCode !== 0 || typeof record.suite[i].evidence !== 'string' || !record.suite[i].evidence.trim())) return result('remediation', 'Full ordered local suite and successful evidence required.');
    if (record.pm?.owner !== turn.pm || record.pm.phrase !== turn.approvalPhrase || !matches(qa.candidateIdentity, candidate, record.pm.candidate) || typeof record.pm.evidence !== 'string' || !record.pm.evidence.trim()) return result('waiting', 'Exact-candidate PM Testing approval required.');
    if (!cleanupComplete(record.cleanup)) return result('waiting', 'Cleanup unresolved; retained PM resources must be removed and verified.');
    if (index + 1 < qa.turns.length && record.nextCandidateAvailable !== true) return result('waiting', 'Outgoing owner must verify exact candidate is available to the next environment.');
  }
  return { state: 'complete', baton, current: null, next: null, projectStatus: 'In Review', reason: 'Local QA complete; release and Issue completion gates remain separate.' };
}

function evaluateCirculation(qa, candidate, records, { currentTurn, scope = 'issue', issue, cleanupResolutions = [] } = {}) {
  if (!identityMatches(qa.candidateIdentity, candidate, candidate)) throw new Error('incomplete candidate identity');
  if (!['issue', 'release'].includes(scope)) throw new Error('invalid QA scope');
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('owning Issue number required for QA');
  const start = qa.turns.findIndex(turn => turn.id === currentTurn);
  if (start < 0) throw new Error('valid currentTurn required for circulating QA');
  if (!Array.isArray(records)) throw new Error('QA records must be an array');
  const latest = new Map(); const rounds = new Set();
  for (const record of records) {
    if (!qa.turns.some(t => t.id === record?.turn) || !Number.isSafeInteger(record.round) || record.round < 1) throw new Error('unknown turn or invalid round');
    const key = `${record.turn}:${record.round}`;
    if (rounds.has(key)) throw new Error('duplicate QA round');
    rounds.add(key);
    if (!latest.has(record.turn) || latest.get(record.turn).round < record.round) latest.set(record.turn, record);
  }
  if (!Array.isArray(cleanupResolutions)) throw new Error('cleanup resolutions must be an array');
  const resolutions = new Map();
  for (const resolution of cleanupResolutions) {
    const key = `${resolution?.turn}:${resolution?.round}`;
    if (!rounds.has(key) || resolutions.has(key) || !cleanupComplete(resolution.cleanup)) throw new Error('invalid or duplicate cleanup resolution');
    resolutions.set(key, resolution.cleanup);
  }
  const cleaned = record => {
    if (cleanupComplete(record.cleanup)) return true;
    const resolved = resolutions.get(`${record.turn}:${record.round}`);
    return resolved && Array.isArray(record.cleanup?.resources) && record.cleanup.resources.every(resource =>
      resource && ['kind', 'id', 'run', 'owner'].every(key => nonempty(resource[key])) &&
      resolved.resources.some(item => ['kind', 'id', 'run', 'owner'].every(key => item[key] === resource[key])));
  };
  const baton = qa.turns.length > 1;
  const checks = new Map(qa.turns.map(turn => {
    const record = latest.get(turn.id);
    const problem = (state, reason) => [turn.id, { state, reason }];
    if (!record || !identityMatches(qa.candidateIdentity, candidate, record.candidate)) return problem('pickup', 'Latest candidate requires this pair to review and test.');
    if (record.developer !== turn.developer || record.environment !== turn.environment) return problem('remediation', 'Wrong owner or environment.');
    const env = qa.environments.find(e => e.id === turn.environment);
    if (record.host?.available !== true || record.host.os !== env.os || record.host.architecture !== env.architecture || record.pickedUp !== true || record.candidateAvailable !== true || !nonempty(record.session)) return problem('waiting', 'Compatible host, exact candidate and verified pickup required.');
    if (!identityMatches(qa.candidateIdentity, candidate, record.review?.candidate) || !nonempty(record.review?.evidence)) return problem('remediation', 'Agent review evidence required.');
    if (!Array.isArray(record.suite) || record.suite.length !== env.suite.length || env.suite.some((command, i) => record.suite[i]?.command !== command || record.suite[i].exitCode !== 0 || !nonempty(record.suite[i].evidence))) return problem('remediation', 'Complete successful local suite required.');
    const phrase = renderApproval(turn.approvalPhrase, issue);
    if (!showcaseComplete(record.showcase, qa.candidateIdentity, candidate, phrase, { scope, issue })) return problem('remediation', 'Complete current-candidate Showcase required.');
    if (record.pm?.owner !== turn.pm || record.pm.phrase !== phrase || !identityMatches(qa.candidateIdentity, candidate, record.pm.candidate) || !nonempty(record.pm.evidence)) return problem('waiting', 'Partnered Human PM approval required.');
    if (!cleaned(record)) return problem('waiting', 'Cleanup unresolved.');
    return [turn.id, null];
  }));
  const order = [...qa.turns.slice(start), ...qa.turns.slice(0, start)];
  // Superseded approval is historical; superseded temporary resources still need cleanup.
  if (records.some(record => !cleaned(record))) return { state: 'waiting', reason: 'Current or historical test-resource cleanup unresolved.', baton, current: qa.turns[start], next: null, projectStatus: 'In Progress' };
  const pending = order.find(turn => checks.get(turn.id));
  if (!pending) return { state: 'complete', reason: 'Every required pair approved the latest candidate.', baton, current: null, next: null, projectStatus: 'In Review' };
  const current = qa.turns[start];
  if (pending.id !== current.id && latest.get(current.id)?.nextCandidateAvailable !== true) return { state: 'waiting', reason: 'Outgoing owner must prove next candidate availability.', baton, current, next: pending, projectStatus: 'In Progress' };
  return { ...checks.get(pending.id), baton, current: pending, next: order.find(turn => turn.id !== pending.id && checks.get(turn.id)) ?? null, projectStatus: 'In Progress' };
}
