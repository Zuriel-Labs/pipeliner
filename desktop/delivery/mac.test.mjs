import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { signingPrerequisites, inspectMacDelivery } from './mac.mjs';

test('signing prerequisites distinguish valid absence from incomplete reads without exposing identity names', () => {
  const value = signingPrerequisites('  1) ' + 'A'.repeat(40) + ' "Apple Development: private account"\n  2) ' + 'B'.repeat(40) + ' "Developer ID Application: private organization"\n     2 valid identities found\n');
  assert.deepEqual(value, { developerId: 'detected', localReview: 'detected' }); assert.doesNotMatch(JSON.stringify(value), /private/);
  assert.deepEqual(signingPrerequisites('     0 valid identities found\n'), { developerId: 'missing', localReview: 'missing' });
  for (const input of ['permission denied', '1 valid identities found', ' 1) invalid "Apple Development: fake"\n1 valid identities found', '']) assert.throws(() => signingPrerequisites(input));
});

test('Mac prerequisite cancellation waits for callback and child close without admitting a later probe', async () => {
  const processes = createRequire(import.meta.url)('node:child_process'), original = processes.execFile, children = [];
  processes.execFile = (file, args, options, callback) => {
    const child = new EventEmitter(); children.push({ child, callback, file, args, options }); return child;
  };
  syncBuiltinESMExports();
  try {
    for (const order of ['error-first', 'success-then-abort', 'close-first']) {
      const controller = new AbortController(); let result = 'pending';
      const inspection = inspectMacDelivery(controller.signal);
      inspection.then(() => { result = 'success'; }, () => { result = 'refused'; });
      const observed = children.at(-1), count = children.length;
      assert.equal(observed.file, '/usr/bin/sw_vers'); assert.deepEqual(observed.args, ['-productVersion']);
      assert.equal(observed.options.timeout, 5000); assert.equal(observed.options.maxBuffer, 32768);
      if (order === 'close-first') observed.child.emit('close');
      else observed.callback(order === 'error-first' ? Error('Synthetic private native error') : null, '27.0.1\n');
      if (order === 'success-then-abort') controller.abort();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(result, 'pending'); assert.equal(children.length, count);
      if (order === 'close-first') observed.callback(Error('Synthetic private native error'), 'Synthetic private output');
      else observed.child.emit('close');
      await assert.rejects(inspection, error => {
        assert.equal(error.message, 'Mac prerequisite check unavailable');
        assert.deepEqual(Object.keys(error), []); return true;
      });
      assert.equal(children.length, count); assert.equal(result, 'refused');
    }
  } finally {
    processes.execFile = original; syncBuiltinESMExports();
    for (const observed of children) observed.child.emit('close');
  }
});
