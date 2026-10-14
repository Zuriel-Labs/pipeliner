import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
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

test('sample observer times out a stalled phase and retains only numeric visibility evidence', async () => {
  const { observeSoakSample } = require('./qualify-soak.cjs');
  const records = []; let visible = 1, mark;
  await assert.rejects(observeSoakSample({ timeoutMs: 15, write: value => records.push(value),
    windowState: () => ({ windowVisible: visible, windowFocused: 0 }),
    sample: phase => { mark = phase; phase(4, 0); visible = 0; return new Promise(() => {}); }
  }), /soak-sample-timeout/);
  assert.deepEqual(Object.keys(records.at(-1)).sort(), ['outcome', 'phase', 'rendererVisible', 'sampleMs', 'windowFocused', 'windowVisible']);
  assert.equal(records.at(-1).phase, 4); assert.equal(records.at(-1).outcome, 3);
  assert.equal(records.at(-1).rendererVisible, 0); assert.equal(records.at(-1).windowVisible, 0);
  assert(records.every(record => Object.values(record).every(Number.isFinite)));
  const count = records.length; assert.throws(() => mark(5), /soak-sample-settled/); assert.equal(records.length, count);
  let clock = 0;
  await assert.rejects(observeSoakSample({ timeoutMs: 15, clock: () => clock, write: value => records.push(value),
    windowState: () => ({ windowVisible: 1, windowFocused: 1 }), sample: async () => { clock = 16; return {}; }
  }), /soak-sample-timeout/);
  assert.equal(records.at(-1).outcome, 3);
});

test('sample observer preserves passed measurements, original failures and cancellation without leaking arbitrary fields', async () => {
  const { observeSoakSample } = require('./qualify-soak.cjs');
  const records = [], value = { navigationMs: 10, controlMs: 2, rssBytes: 100, heapUsedBytes: 50 };
  const options = { timeoutMs: 1000, write: value => records.push(value), windowState: () => ({ windowVisible: 1, windowFocused: 1 }) };
  assert.equal(await observeSoakSample({ ...options, sample: async phase => { phase(2, 1); return value; } }), value);
  assert.equal(records.at(-1).outcome, 1);
  const failure = new Error('private failure text');
  await assert.rejects(observeSoakSample({ ...options, sample: async () => { throw failure; } }), error => error === failure);
  assert.equal(records.at(-1).outcome, 2); assert(!JSON.stringify(records).includes(failure.message));
  const controller = new AbortController();
  await assert.rejects(observeSoakSample({ ...options, signal: controller.signal, sample: () => { controller.abort(); return new Promise(() => {}); } }), { name: 'AbortError' });
  assert.equal(records.at(-1).outcome, 4);
  const count = records.length; await delay(20); assert.equal(records.length, count);
  await assert.rejects(observeSoakSample({ ...options, windowState: () => ({ windowVisible: 1, windowFocused: 1, privateText: 'never retain' }), sample: async () => value }), /soak-window-state-invalid/);
  await assert.rejects(observeSoakSample({ ...options, sample: async phase => phase('private phase') }), /soak-phase-invalid/);
});

test('foreground frame observation requires both visible frames and cleans callbacks/listeners on success or hiding', async () => {
  const { observeSoakFrames } = require('./qualify-soak.cjs');
  const callbacks = new Map(), listeners = new Set(); let next = 0;
  const document = { visibilityState: 'visible', addEventListener: (_name, listener) => listeners.add(listener), removeEventListener: (_name, listener) => listeners.delete(listener) };
  const options = { document, requestAnimationFrame: callback => { const id = ++next; callbacks.set(id, callback); return id; }, cancelAnimationFrame: id => callbacks.delete(id) };
  const fire = () => { const [id, callback] = callbacks.entries().next().value; callbacks.delete(id); callback(); };
  const passed = observeSoakFrames(options); fire(); assert.equal(listeners.size, 1); fire();
  assert.deepEqual(await passed, { frames: 2, rendererVisible: 1 }); assert.equal(listeners.size, 0); assert.equal(callbacks.size, 0);
  const hidden = observeSoakFrames(options); fire(); document.visibilityState = 'hidden'; for (const listener of [...listeners]) listener();
  assert.deepEqual(await hidden, { frames: 0, rendererVisible: 0 }); assert.equal(listeners.size, 0); assert.equal(callbacks.size, 0);
  assert.deepEqual(await observeSoakFrames(options), { frames: 0, rendererVisible: 0 }); assert.equal(listeners.size, 0); assert.equal(callbacks.size, 0);
});
