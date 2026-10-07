import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

test('native qualification progress forwards only finite phases and numeric checks without child payloads', () => {
  const { progress } = createRequire(import.meta.url)('./qualification-progress.cjs');
  for (const value of [{ desktopPhase: 'window-load-started', milliseconds: 7 }, { desktopCheck: 1, stage: 'started' },
    { desktopCheck: 1, stage: 'passed' }, { desktopCheck: 256, stage: 'failed' }]) assert.deepEqual(progress(JSON.stringify(value)), value);
  for (const value of [{ desktopPhase: 'provider-secret', milliseconds: 7 }, { desktopPhase: 'window-load-started', milliseconds: -1 },
    { desktopPhase: 'window-load-started', milliseconds: 600001 }, { desktopPhase: 'window-load-started', milliseconds: 1.5 },
    { desktopPhase: 'window-load-started', milliseconds: null }, { desktopPhase: 'window-load-started', milliseconds: 0, error: 'private' },
    { desktopCheck: 0, stage: 'started' }, { desktopCheck: 257, stage: 'started' }, { desktopCheck: 1, stage: 'private-error' },
    { desktopCheck: 1, stage: 'passed', name: 'private' }, [], null, { desktopPhase: 'window-load-started' }]) assert.equal(progress(JSON.stringify(value)), null);
  for (const text of ['not JSON', '"private"', '{"desktopCheck":1,"stage":"passed"}\nprivate', ' '.repeat(513)]) assert.equal(progress(text), null);
});
