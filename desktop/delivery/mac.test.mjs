import test from 'node:test';
import assert from 'node:assert/strict';
import { signingPrerequisites } from './mac.mjs';

test('signing prerequisites distinguish valid absence from incomplete reads without exposing identity names', () => {
  const value = signingPrerequisites('  1) ' + 'A'.repeat(40) + ' "Apple Development: private account"\n  2) ' + 'B'.repeat(40) + ' "Developer ID Application: private organization"\n     2 valid identities found\n');
  assert.deepEqual(value, { developerId: 'detected', localReview: 'detected' }); assert.doesNotMatch(JSON.stringify(value), /private/);
  assert.deepEqual(signingPrerequisites('     0 valid identities found\n'), { developerId: 'missing', localReview: 'missing' });
  for (const input of ['permission denied', '1 valid identities found', ' 1) invalid "Apple Development: fake"\n1 valid identities found', '']) assert.throws(() => signingPrerequisites(input));
});
