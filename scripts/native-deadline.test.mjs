import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { nativeDeadline } from './native-deadline.mjs';

test('qualification deadline escalates only its owned child and cancels after natural closure', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready\\n')"], { stdio: ['ignore', 'pipe', 'pipe'] });
  let cancel;
  try {
    await once(child.stdout, 'data'); cancel = nativeDeadline(child, 30, 30);
    assert.deepEqual(await once(child, 'close'), [null, 'SIGKILL']); assert.equal(child.signalCode, 'SIGKILL'); cancel();
    const natural = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const closed = once(natural, 'close'), cancelNatural = nativeDeadline(natural, 1000, 30);
    assert.deepEqual(await closed, [0, null]); cancelNatural(); assert.equal(natural.signalCode, null);
  } finally { cancel?.(); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); } }
});
