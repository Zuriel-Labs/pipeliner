'use strict';
// Qualification only; the packaged app excludes this module and rejects its option.
const { setTimeout: delay } = require('node:timers/promises');
const soakDurationMs = 86400000;
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
module.exports = { measureSoak, soakDurationMs };
