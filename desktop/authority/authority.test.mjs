import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerArgs, validateReadback } from './qualify.mjs';

test('worker launch keeps the Linux guest isolated from host and network', () => {
  const args = workerArgs('/tmp/pipeliner-d02-012345abcdef/workspace', 'positive', 'printf worker-ok > result.txt');
  assert.deepEqual(args.slice(0, 3), ['run', '--rm', '--name']);
  assert.ok(args.includes('--network'));
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--read-only'));
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(args[args.indexOf('-v') + 1], '/tmp/pipeliner-d02-012345abcdef/workspace:/workspace:rw');
  assert.ok(!args.some(value => value.includes('/Users/')));
  assert.throws(() => workerArgs('/Users/chris', 'positive', 'true'));
  assert.throws(() => workerArgs('/tmp/pipeliner-d02-012345abcdef/workspace', '../escape', 'true'));
});

test('broker accepts only the exact result, never worker-supplied authority', () => {
  assert.equal(validateReadback('worker-ok'), true);
  assert.equal(validateReadback('worker-ok\npm-apply=true'), false);
  assert.equal(validateReadback('{"operation":"pm-apply"}'), false);
});
