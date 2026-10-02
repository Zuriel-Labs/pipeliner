import { containsSecret } from '../connections/commands.mjs';

export const stepTypes = Object.freeze({ agent: 'Agent task', check: 'Repository check', 'pm-qa': 'PM testing gate', 'pr-integration': 'PR integration', build: 'Local build',
  'artifact-verify': 'Artifact verification', retain: 'Artifact retention', publish: 'Artifact publication', extension: 'Extension step' });
export const inputNames = Object.freeze({ issue: 'Issue', workspace: 'Working files', candidate: 'Current candidate', artifact: 'Verified artifact', results: 'Prior results' });
export const evidenceNames = Object.freeze({ 'verified-result': 'Verified result', tests: 'Test results', review: 'Review notes', artifact: 'Verified artifact', implementation: 'Changed source' });
export const pipelineShapes = Object.freeze({ view: [[], ['scope', 'kind']], begin: [[], ['scope', 'kind']], preset: [['scenario'], []], edit: [['action'], []], testing: [['action'], []],
  prepare: [[], []], apply: [[], ['hash']], discard: [[], []], reset: [[], ['kind']], restore: [['version'], ['kind']], rebase: [[], []], chat: [['text'], []] });
const kind = text => Object.entries(stepTypes).find(([, label]) => label.toLowerCase() === text.toLowerCase())?.[0];
// ponytail: deterministic guided phrases; model assistance must propose through this boundary without gaining PM apply.
export function pipelineCommand(text) {
  if (typeof text !== 'string' || text.length > 4096 || containsSecret(text)) return null;
  const value = text.trim().replace(/[.!?]$/, ''); let match;
  if ((match = /^(show|inspect|edit) (?:(global|repository) )?(development|release) pipeline$/i.exec(value))) return { operation: match[1].toLowerCase() === 'edit' ? 'begin' : 'view', ...(match[2] ? { scope: match[2].toLowerCase() } : {}), kind: match[3].toLowerCase() };
  if ((match = /^use (supervised dev|pm-triggered autonomous dev|scheduled autonomous dev)(?: preset)?$/i.exec(value))) return { operation: 'preset', scenario: ({ 'supervised dev': 'supervised', 'pm-triggered autonomous dev': 'pm-autonomous', 'scheduled autonomous dev': 'scheduled-autonomous' })[match[1].toLowerCase()] };
  if (/^(?:review|preview) (?:this |the )?pipeline(?: draft)?$/i.test(value)) return { operation: 'prepare' };
  if (/^(?:apply|publish) (?:this |the )?pipeline(?: change)?$/i.test(value)) return { operation: 'apply' };
  if (/^(?:discard|cancel) (?:this |the )?pipeline(?: draft| change)?$/i.test(value)) return { operation: 'discard' };
  if (/^refresh (?:this |the )?pipeline draft$/i.test(value)) return { operation: 'rebase' };
  if ((match = /^reset (development|release) pipeline to inherit$/i.exec(value))) return { operation: 'reset', kind: match[1].toLowerCase() };
  if ((match = /^restore (development|release) pipeline from version (\d+)$/i.exec(value))) return { operation: 'restore', kind: match[1].toLowerCase(), version: Number(match[2]) };
  let action;
  if ((match = /^add (?:a |an )?(.+) after step (\d+) called (.{1,240})$/i.exec(value)) && kind(match[1])) action = { operation: 'add', step: Number(match[2]), kind: kind(match[1]), label: match[3] };
  else if ((match = /^remove step (\d+)$/i.exec(value))) action = { operation: 'remove', step: Number(match[1]) };
  else if ((match = /^rename step (\d+) to (.{1,240})$/i.exec(value))) action = { operation: 'set', step: Number(match[1]), field: 'label', value: match[2] };
  else if ((match = /^move step (\d+) before step (\d+)$/i.exec(value))) action = { operation: 'move', step: Number(match[1]), before: Number(match[2]) };
  else if ((match = /^start (?:this |the )?pipeline at step (\d+)$/i.exec(value))) action = { operation: 'entry', step: Number(match[1]) };
  else if ((match = /^send step (\d+) (success|failure|feedback) to (?:step (\d+)|(complete|blocked))$/i.exec(value))) action = { operation: 'set', step: Number(match[1]), field: match[2].toLowerCase(), value: match[3] ? Number(match[3]) : match[4].toLowerCase() };
  else if ((match = /^set step (\d+) (retries|visits) to (\d+)$/i.exec(value))) action = { operation: 'set', step: Number(match[1]), field: match[2].toLowerCase() === 'retries' ? 'retryLimit' : 'visitLimit', value: Number(match[3]) };
  else if ((match = /^set step (\d+) (inputs|evidence|permissions) to (.{1,2000})$/i.exec(value))) action = { operation: 'set', step: Number(match[1]), field: match[2].toLowerCase(), value: match[3].toLowerCase() === 'none' ? [] : match[3].split(',').map(value => value.trim()) };
  else if ((match = /^set step (\d+) (?:outcome|expected result) to (.{1,240})$/i.exec(value))) action = { operation: 'set', step: Number(match[1]), field: 'expectedResult', value: match[2] };
  else if ((match = /^set step (\d+) type to (.+)$/i.exec(value)) && kind(match[2])) action = { operation: 'set', step: Number(match[1]), field: 'kind', value: kind(match[2]) };
  if (action) return { operation: 'edit', action };
  if ((match = /^add pm test action (.{1,240}) expect (.{1,240})$/i.exec(value))) return { operation: 'testing', action: { operation: 'add', action: match[1], expected: match[2] } };
  if ((match = /^remove pm test action (\d+)$/i.exec(value))) return { operation: 'testing', action: { operation: 'remove', index: Number(match[1]) } };
  if ((match = /^set pm test action (\d+) (action|expected) to (.{1,240})$/i.exec(value))) return { operation: 'testing', action: { operation: 'set', index: Number(match[1]), field: match[2].toLowerCase(), value: match[3] } };
  return null;
}
