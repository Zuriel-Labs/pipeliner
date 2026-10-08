import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./execution.mjs', import.meta.url), 'utf8');
const method = source.slice(source.indexOf('    async verifyIdle(signal) {'), source.indexOf('    async start(identity, binding,'));

test('normal maintenance verifies the native scope even with no recorded workers', async () => {
  let calls = 0, nativeFailure = true, mutated = false;
  const context = { requireOpen() {}, maintenance: () => true, inFlight: new Map(), pendingControls: new Map(),
    monitorWork: null, foregroundPausing: false, foregroundError: null, canonicalJSON: JSON.stringify,
    executionRecord: row => row, db: { prepare: sql => ({ get: () => null, all: () => mutated ? [{ unexpected: true }] : [] }) },
    environment: { async verifyIdle(workers, options) {
      calls++; assert.equal(workers.length, 0); options.checkpoint();
      if (nativeFailure) throw Error('Unrecorded container in the private execution scope');
      mutated = true; options.checkpoint();
    } } };
  const supervisor = runInNewContext('({' + method + '})', context);
  await assert.rejects(supervisor.verifyIdle(), /Unrecorded container/); assert.equal(calls, 1);
  nativeFailure = false;
  await assert.rejects(supervisor.verifyIdle(), /Execution inventory changed/); assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(supervisor.verifyIdle(controller.signal)); assert.equal(calls, 2);
});
