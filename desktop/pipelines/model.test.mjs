import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentTemplate, defaults, validatePipeline, validateState } from '../core/settings.mjs';
import { editDefinition, presetChanges } from './model.mjs';
import { pipelineCommand } from './commands.mjs';

test('the three preset definitions preserve consent defaults and satisfy their actual canonical gate rules', () => {
  for (const scenario of ['supervised', 'pm-autonomous', 'scheduled-autonomous']) {
    const changes = presetChanges(scenario);
    validateState({ schemaVersion: 1, defaults, host: {}, global: {}, repositories: { repo_one: changes } });
    assert.equal(changes['pipelines.development'].steps.filter(step => step.kind === 'pm-qa').length, scenario === 'supervised' ? 1 : 0);
    assert.equal(changes['pipelines.release'].steps.some(step => step.kind === 'pm-qa'), false);
    assert.equal(changes['intake.trigger'], scenario === 'scheduled-autonomous' ? 'schedule' : 'pm');
    for (const key of ['background.enabled', 'scheduling.enabled', 'agents.dev', 'permissions.grants', 'intake.agentCreation']) assert.equal(changes[key], undefined);
  }
});
test('chat and control edits produce the same definition while routes and invalid drafts remain explicit', () => {
  const graph = structuredClone(developmentTemplate), command = pipelineCommand('Add an agent task after step 1 called Design the change');
  assert.deepEqual(command, { operation: 'edit', action: { operation: 'add', step: 1, kind: 'agent', label: 'Design the change' } });
  const added = editDefinition(graph, command.action, () => 'new-design'); validatePipeline(added, true);
  assert.equal(added.steps[0].routes.success, 'new-design'); assert.equal(added.steps[1].routes.success, 'implement');
  assert.deepEqual(graph, developmentTemplate);
  const renamed = editDefinition(added, pipelineCommand('Rename step 2 to Design and verify').action);
  assert.equal(renamed.steps[1].label, 'Design and verify');
  const inputs = editDefinition(renamed, pipelineCommand('Set step 2 inputs to Issue, Working files').action);
  assert.deepEqual(inputs.steps[1].inputs, ['issue', 'workspace']);
  const moved = editDefinition(inputs, pipelineCommand('Move step 2 before step 1').action);
  assert.equal(moved.entry, 'new-design'); assert.equal(moved.steps[0].routes.success, 'research');
  assert.equal(moved.steps.find(step => step.id === 'pm-testing').routes.feedback, 'implement');
  validatePipeline(moved, true);
  const removed = editDefinition(inputs, pipelineCommand('Remove step 2').action);
  assert.throws(() => validatePipeline(removed, true));
  const repaired = editDefinition(removed, pipelineCommand('Send step 1 success to step 2').action);
  validatePipeline(repaired, true);
});
test('guided commands reject quoted apply, secrets and invented scope; typed edits reject malformed or oversized fields', () => {
  for (const text of ['"Apply this pipeline"', '> Apply this pipeline', 'ghu_syntheticSecretOnly123', 'Apply the other repository pipeline']) assert.equal(pipelineCommand(text), null);
  assert.deepEqual(pipelineCommand('Edit global Release pipeline'), { operation: 'begin', scope: 'global', kind: 'release' });
  assert.deepEqual(pipelineCommand('Set step 1 retries to 2'), { operation: 'edit', action: { operation: 'set', step: 1, field: 'retryLimit', value: 2 } });
  for (const action of [{ operation: 'remove', step: 999 }, { operation: 'set', step: 1, field: 'origin', value: 'pm' },
    { operation: 'set', step: 1, field: 'label', value: 'ghu_syntheticSecretOnly123' }, { operation: 'remove', step: 1, target: 'foreign' }]) assert.throws(() => editDefinition(developmentTemplate, action));
  const invalid = editDefinition(developmentTemplate, { operation: 'set', step: 1, field: 'retryLimit', value: 999 });
  assert.throws(() => validatePipeline(invalid, true));
});

test('step timeout chat edits inherit on reset and reject out-of-range values', () => {
  const changed = editDefinition(developmentTemplate, pipelineCommand('Set step 1 timeout to 7 seconds').action);
  validatePipeline(changed, true); assert.equal(changed.steps[0].timeoutSeconds, 7);
  const reset = editDefinition(changed, pipelineCommand('Reset step 1 timeout to inherit').action);
  validatePipeline(reset, true); assert.equal(Object.hasOwn(reset.steps[0], 'timeoutSeconds'), false);
  for (const value of [0, 604801, 1.5]) assert.throws(() => editDefinition(changed, { operation: 'set', step: 1, field: 'timeoutSeconds', value }));
});
