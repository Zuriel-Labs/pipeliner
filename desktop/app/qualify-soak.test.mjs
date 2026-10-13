import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('soak retains initial/final observations and never passes a missed interval, failed sample or cancellation', async () => {
  const { measureSoak, soakDurationMs } = require('./qualify-soak.cjs');
  assert.equal(soakDurationMs, 86400000);
  let clock = 0; const elapsed = [];
  const options = { durationMs: 3, intervalMs: 1, clock: () => clock, wait: async delay => { clock += delay; },
    sample: async milliseconds => { elapsed.push(milliseconds); return { navigationMs: 10, controlMs: 2, rssBytes: 100, heapUsedBytes: 50 }; }, write: () => {} };
  const result = await measureSoak(options);
  assert.deepEqual(elapsed, [0, 1, 2, 3]); assert.equal(result.elapsedMs, 3); assert.equal(result.samples, 4);
  clock = 0; await assert.rejects(measureSoak({ ...options, wait: async () => { clock += 3; } }), /soak-observation-gap/);
  clock = 0; await assert.rejects(measureSoak({ ...options, sample: async () => { throw Error('observed-failure'); } }), /observed-failure/);
  const controller = new AbortController(); clock = 0;
  await assert.rejects(measureSoak({ ...options, signal: controller.signal, wait: async () => { controller.abort(); } }), { name: 'AbortError' });
  clock = 0; await assert.rejects(measureSoak({ ...options, sample: async () => ({ navigationMs: 10, controlMs: 2, rssBytes: 100, heapUsedBytes: 50, privateText: 'never retain' }) }), /soak-sample-invalid/);
});
