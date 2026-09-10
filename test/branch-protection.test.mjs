import assert from 'node:assert/strict';
import test from 'node:test';
import { branchProtectionDecision } from '../scripts/lib/intake.mjs';
import { readFile } from 'node:fs/promises';
import { validateProfile } from '../scripts/lib/config.mjs';

test('bootstrapping never enables or removes branch protection by default', () => {
  for (const current of [false, true]) {
    assert.equal(branchProtectionDecision({ current }).action, 'ask');
    assert.equal(branchProtectionDecision({ current, choice: 'disabled' }).action, current ? 'remove' : 'unchanged');
    assert.equal(branchProtectionDecision({ current, choice: 'enabled' }).action, 'ask-rules');
  }
  assert.equal(branchProtectionDecision({ choice: 'disabled' }).action, 'blocked');
  assert.throws(() => branchProtectionDecision({ current: false, choice: 'automatic' }), /choice/);
});

test('profiles preserve explicit protection choice and never infer one when omitted', async () => {
  const profile = JSON.parse(await readFile(new URL('../pipeliner.config.json', import.meta.url), 'utf8'));
  assert.equal(validateProfile(profile).workflow.branchProtection, 'disabled');
  delete profile.workflow.branchProtection;
  assert.equal(validateProfile(profile).workflow.branchProtection, undefined);
  profile.workflow.branchProtection = 'automatic';
  assert.throws(() => validateProfile(profile), /branchProtection/);
});
