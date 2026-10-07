import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMacUpdateCommand } from './mac.mjs';

test('native runner distinguishes completed refusals and waits for actual child closure on cancellation and timeout', { timeout: 25000 }, async () => {
  const processes = createRequire(import.meta.url)('node:child_process'), original = processes.execFile, children = [];
  processes.execFile = (...args) => {
    const child = original(...args), observed = { child, closed: false }; children.push(observed);
    child.once('close', () => { observed.closed = true; }); return child;
  };
  syncBuiltinESMExports();
  const signal = () => new AbortController().signal;
  async function settled() {
    for (const observed of children) {
      assert.equal(observed.closed, true);
      if (observed.child.pid) assert.throws(() => process.kill(observed.child.pid, 0), error => error.code === 'ESRCH');
    }
  }
  async function refuses(file, args, selectedSignal, expectedExit) {
    await assert.rejects(runMacUpdateCommand(file, args, selectedSignal), error => {
      assert.equal(error.message, 'update-native-trust-unverified'); assert.equal(error.nativeExitCode, expectedExit);
      for (const key of ['stdout', 'stderr', 'cmd', 'path', 'signal', 'cause']) assert.equal(Object.hasOwn(error, key), false);
      if (expectedExit !== undefined) assert.equal(Object.getOwnPropertyDescriptor(error, 'nativeExitCode').writable, false);
      return true;
    });
    await settled();
  }
  try {
    assert.deepEqual(await runMacUpdateCommand('/usr/bin/true', [], signal()), { stdout: '', stderr: '' }); await settled();
    await refuses('/usr/bin/false', [], signal(), 1);
    await refuses(join(tmpdir(), 'pipeliner-54-missing-native-command'), [], signal(), undefined);
    await refuses('/usr/bin/yes', ['Synthetic bounded output.'], signal(), undefined);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30);
    try { await refuses('/bin/sleep', ['30'], controller.signal, undefined); } finally { clearTimeout(timer); }
    const started = performance.now(); await refuses('/bin/sleep', ['20'], signal(), undefined);
    assert(performance.now() - started >= 14000); assert(performance.now() - started < 20000);
  } finally {
    processes.execFile = original; syncBuiltinESMExports();
    for (const observed of children) if (!observed.closed) {
      const closed = new Promise(resolve => observed.child.once('close', resolve)); observed.child.kill('SIGKILL'); await closed;
    }
    await settled();
  }
});
