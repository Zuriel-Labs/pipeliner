'use strict';
// Qualification only; the packaged app excludes this module and rejects its option.
const { setTimeout: delay } = require('node:timers/promises');
const soakDurationMs = 86400000;
async function observeSoakSample({ sample, write, windowState, signal, clock = () => performance.now(), timeoutMs = 120000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw Error('soak-sample-limit-invalid');
  signal?.throwIfAborted();
  const began = clock(), timeoutError = Error('soak-sample-timeout');
  let phase = 0, rendererVisible = -1, settled = false, observing = false, timer, abort;
  const record = outcome => {
    const state = windowState(), sampleMs = clock() - began;
    if (!state || Object.keys(state).sort().join(',') !== 'windowFocused,windowVisible'
      || Object.values(state).some(value => value !== 0 && value !== 1)) throw Error('soak-window-state-invalid');
    if (!Number.isFinite(sampleMs) || sampleMs < 0 || sampleMs > Number.MAX_SAFE_INTEGER) throw Error('soak-phase-time-invalid');
    write({ phase, outcome, sampleMs, ...state, rendererVisible });
  };
  const mark = (next, visibility = rendererVisible) => {
    if (settled) throw Error('soak-sample-settled');
    if (!Number.isInteger(next) || next < 0 || next > 5 || ![-1, 0, 1].includes(visibility)) throw Error('soak-phase-invalid');
    phase = next; rendererVisible = visibility; record(0);
  };
  try {
    record(0); observing = true;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs); });
    const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); });
    const value = await Promise.race([Promise.resolve().then(() => { signal?.throwIfAborted(); return sample(mark); }), timeout, cancelled]);
    if (clock() - began > timeoutMs) throw timeoutError;
    record(1); return value;
  } catch (error) {
    try { if (observing) record(error === timeoutError ? 3 : signal?.aborted ? 4 : 2); }
    catch (evidenceError) { throw new AggregateError([error, evidenceError], 'soak-phase-evidence-failed'); }
    throw error;
  } finally { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function observeSoakFrames({ document = globalThis.document, requestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis), cancelAnimationFrame = globalThis.cancelAnimationFrame.bind(globalThis) } = {}) {
  return new Promise(resolve => {
    let frame, settled = false;
    const finish = frames => {
      if (settled) return;
      settled = true; document.removeEventListener('visibilitychange', hidden);
      if (frame !== undefined) cancelAnimationFrame(frame);
      resolve({ frames, rendererVisible: document.visibilityState === 'visible' ? 1 : 0 });
    };
    const hidden = () => { if (document.visibilityState !== 'visible') finish(0); };
    document.addEventListener('visibilitychange', hidden); hidden();
    if (!settled) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => finish(document.visibilityState === 'visible' ? 2 : 0)); });
  });
}
async function measureSoak({ sample, write, signal, clock = () => performance.now(), wait = milliseconds => delay(milliseconds, undefined, { signal }),
  durationMs = soakDurationMs, intervalMs = 60000 }) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) throw Error('soak-period-invalid');
  const began = clock(), navigation = [], controls = [];
  let previous = 0, samples = 0, peakRssBytes = 0, peakHeapUsedBytes = 0;
  for (;;) {
    signal?.throwIfAborted();
    const elapsedMs = clock() - began;
    if (!Number.isFinite(elapsedMs) || elapsedMs < previous || elapsedMs - previous > intervalMs * 2) throw Error('soak-observation-gap');
    if (++samples > Math.ceil(durationMs / intervalMs) + 2) throw Error('soak-sample-count');
    const value = await sample(elapsedMs, samples - 1); signal?.throwIfAborted();
    if (!value || Object.keys(value).sort().join(',') !== 'controlMs,heapUsedBytes,navigationMs,rssBytes'
      || Object.values(value).some(number => !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER)) throw Error('soak-sample-invalid');
    await write({ elapsedMs, ...value });
    navigation.push(value.navigationMs); controls.push(value.controlMs);
    peakRssBytes = Math.max(peakRssBytes, value.rssBytes); peakHeapUsedBytes = Math.max(peakHeapUsedBytes, value.heapUsedBytes);
    if (elapsedMs >= durationMs) {
      const p95 = values => values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
      return { elapsedMs, samples, navigationP95Ms: p95(navigation), controlP95Ms: p95(controls), peakRssBytes, peakHeapUsedBytes };
    }
    previous = elapsedMs; await wait(Math.min(intervalMs, durationMs - (clock() - began)));
  }
}
module.exports = { measureSoak, soakDurationMs, observeSoakSample, observeSoakFrames };
