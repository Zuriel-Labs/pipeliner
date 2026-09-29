import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repositories, journeys, settings, makeProposal, applyProposal } from './state.mjs';

test('prototype covers the agreed journeys and Settings without granting authority', () => {
  assert.equal(journeys.length, 8);
  assert.equal(settings.length, 15);
  assert.equal(new Set(journeys.map(item => item.id)).size, 8);
  assert.equal(new Set(settings.map(item => item.code)).size, 15);
  assert.ok(settings.every(item => item.scope && item.source && item.value && item.timing));
  assert.equal(settings.find(item => item.id === 'background').value, 'Off');
  assert.equal(settings.find(item => item.id === 'appearance').available, false);
  const proposal = makeProposal({ repositoryId: repositories[0].id, settingId: 'scheduling', version: 4 });
  assert.deepEqual(applyProposal(proposal, { repositoryId: repositories[1].id, settingId: 'scheduling', version: 4 }),
    { applied: false, reason: 'Target changed. Review the proposal again.' });
  assert.equal(applyProposal(proposal, { repositoryId: repositories[0].id, settingId: 'testing', version: 4 }).applied, false);
  assert.equal(applyProposal(proposal, { repositoryId: repositories[0].id, settingId: 'scheduling', version: 5 }).applied, false);
  assert.deepEqual(applyProposal(proposal, { repositoryId: repositories[0].id, settingId: 'scheduling', version: 4 }),
    { applied: true, version: 5 });
  assert.throws(() => makeProposal({ repositoryId: repositories[0].id, settingId: 'connections', version: 4 }), /unavailable/);
});
