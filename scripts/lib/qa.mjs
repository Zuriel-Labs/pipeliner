import { cleanupComplete } from './cleanup.mjs';

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
  return qa;
}
export function migrateQA(profile, qa) {
  validateQA(qa);
  return { ...structuredClone(profile), qa: structuredClone(qa) };
}
function matches(keys, left, right) {
  return keys.every(key => typeof left?.[key] === 'string' && left[key].trim() && left[key] === right?.[key]);
}
export function evaluateQA(qa, candidate, records) {
  validateQA(qa);
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
