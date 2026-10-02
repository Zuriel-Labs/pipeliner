import { randomUUID } from 'node:crypto';
import { developmentTemplate, releaseTemplate, capabilityNames, canonicalJSON, record } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';
import { stepTypes, inputNames, evidenceNames } from './commands.mjs';

const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 240 && !/[\p{Cc}\p{Cf}]/u.test(value) && !containsSecret(value);
export function presetChanges(scenario) {
  if (!['supervised', 'pm-autonomous', 'scheduled-autonomous'].includes(scenario)) throw new Error('Unknown pipeline preset');
  const development = structuredClone(developmentTemplate);
  if (scenario !== 'supervised') {
    development.steps = development.steps.filter(step => step.kind !== 'pm-qa');
    development.steps.find(step => step.routes.success === 'pm-testing').routes.success = 'integrate';
  }
  return { 'autonomy.scenario': scenario, 'intake.trigger': scenario === 'scheduled-autonomous' ? 'schedule' : 'pm',
    'pipelines.development': development, 'pipelines.release': structuredClone(releaseTemplate), 'delivery.publish': false };
}
export function editDefinition(value, action, newId = () => 'step_' + randomUUID().replaceAll('-', '')) {
  canonicalJSON(value); canonicalJSON(action); if (containsSecret(canonicalJSON(action))) throw new Error('Sensitive pipeline input');
  const graph = structuredClone(value), get = number => {
    if (!Number.isSafeInteger(number) || number < 1 || number > graph.steps.length) throw new Error('Choose an existing step'); return graph.steps[number - 1];
  };
  if (action.operation === 'add') {
    record(action, ['operation', 'step', 'kind', 'label']);
    if (graph.steps.length >= 64 || !Object.hasOwn(stepTypes, action.kind) || !name(action.label)) throw new Error('Invalid new pipeline step');
    const previous = action.step === 0 ? null : get(action.step), id = newId();
    if (graph.steps.some(step => step.id === id)) throw new Error('Pipeline step identity conflict');
    const step = { id, label: action.label, kind: action.kind, permissions: [], inputs: ['issue'], expectedResult: action.label, evidence: ['verified-result'],
      routes: { success: previous ? previous.routes.success : graph.entry, failure: 'blocked', feedback: 'blocked' }, retryLimit: 0, visitLimit: 4 };
    if (previous) previous.routes.success = id; else graph.entry = id;
    graph.steps.splice(action.step, 0, step);
  } else if (action.operation === 'remove') {
    record(action, ['operation', 'step']); get(action.step); graph.steps.splice(action.step - 1, 1); // Dangling routes remain visible until explicitly corrected.
  } else if (action.operation === 'move') {
    record(action, ['operation', 'step', 'before']); const moving = get(action.step), before = get(action.before);
    if (moving === before) return graph;
    graph.steps.splice(action.step - 1, 1); graph.steps.splice(graph.steps.indexOf(before), 0, moving);
    graph.entry = graph.steps[0].id;
    graph.steps.forEach((step, index) => { step.routes.success = graph.steps[index + 1]?.id ?? 'complete'; });
  } else if (action.operation === 'entry') {
    record(action, ['operation', 'step']); graph.entry = get(action.step).id;
  } else if (action.operation === 'set') {
    record(action, ['operation', 'step', 'field', 'value']); const step = get(action.step), field = action.field;
    if (['success', 'failure', 'feedback'].includes(field)) {
      const destination = typeof action.value === 'number' ? get(action.value).id : action.value;
      if (!['complete', 'blocked', ...graph.steps.map(step => step.id)].includes(destination)) throw new Error('Choose an existing destination'); step.routes[field] = destination;
    } else if (['inputs', 'evidence', 'permissions'].includes(field)) {
      if (!Array.isArray(action.value) || action.value.length > 64 || action.value.some(value => typeof value !== 'string' || !value.length || value.length > 240)) throw new Error('Invalid step declarations');
      const choices = field === 'inputs' ? inputNames : field === 'evidence' ? evidenceNames : Object.fromEntries(capabilityNames.map(value => [value, value.replaceAll('.', ' ')]));
      step[field] = action.value.map(value => Object.hasOwn(choices, value) ? value : Object.entries(choices).find(([, label]) => label.toLowerCase() === value.toLowerCase())?.[0] ?? (step[field].includes(value) ? value : null));
      if (step[field].some(value => value === null)) throw new Error('Choose a declared input, evidence or permission');
    } else if (['label', 'expectedResult'].includes(field)) { if (!name(action.value)) throw new Error('Invalid pipeline text'); step[field] = action.value; }
    else if (field === 'kind') { if (!Object.hasOwn(stepTypes, action.value)) throw new Error('Unknown pipeline step type'); step.kind = action.value; }
    else if (['retryLimit', 'visitLimit'].includes(field)) { if (!Number.isSafeInteger(action.value) || action.value < 0 || action.value > 1000000) throw new Error('Invalid pipeline bound'); step[field] = action.value; }
    else throw new Error('Unknown pipeline step field');
  } else throw new Error('Unknown pipeline edit');
  canonicalJSON(graph); return graph;
}
export function editTesting(value, action) {
  canonicalJSON(action); if (containsSecret(canonicalJSON(action))) throw new Error('Sensitive pipeline input'); const instructions = structuredClone(value);
  if (action.operation === 'add') {
    record(action, ['operation', 'action', 'expected']);
    if (instructions.length >= 64 || !name(action.action) || !name(action.expected)) throw new Error('Invalid PM test action'); instructions.push({ action: action.action, expected: action.expected });
  } else {
    record(action, ['operation', 'index'], action.operation === 'set' ? ['field', 'value'] : []);
    if (!Number.isSafeInteger(action.index) || action.index < 1 || action.index > instructions.length) throw new Error('Choose an existing PM test action');
    if (action.operation === 'remove') instructions.splice(action.index - 1, 1);
    else if (action.operation === 'set' && ['action', 'expected'].includes(action.field) && name(action.value)) instructions[action.index - 1][action.field] = action.value;
    else throw new Error('Invalid PM test edit');
  }
  return instructions;
}
