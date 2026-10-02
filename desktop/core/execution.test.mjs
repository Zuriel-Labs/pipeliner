import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireExecutionOwner } from './execution.mjs';
import { restrictedWorkerArgs, workerVMConfiguration } from './worker.mjs';
import { createExecutionControlChannel } from './control.mjs';
import { guardForegroundClose } from './control.mjs';
import { EventEmitter } from 'node:events';

test('exclusive execution owner survives contention and releases after a real process crash', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-execution-test-')));
  let child;
  try {
    const source = `import {acquireExecutionOwner} from ${JSON.stringify(new URL('./execution.mjs', import.meta.url).href)};acquireExecutionOwner(process.argv[1]);process.stdout.write('owned\\n');setInterval(()=>{},1000);`;
    child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.resume();
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Owner exited before acquisition'))); });
    assert.throws(() => acquireExecutionOwner(directory), /Execution owner unavailable/);
    const exited = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await exited;
    const owner = acquireExecutionOwner(directory); assert.throws(() => acquireExecutionOwner(directory), /Execution owner unavailable/); owner.close(); owner.close();
    const next = acquireExecutionOwner(directory); next.close();
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { const done = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await done; }
    rmSync(directory, { recursive: true }); assert.equal(existsSync(directory), false);
  }
});

test('final foreground close waits for verified Pause and keeps failed verification visible', async () => {
  const window = new EventEmitter(); let closes = 0, prevented = 0, unblock; const messages = [];
  window.close = () => { closes++; window.emit('close', { preventDefault() { prevented++; } }); };
  window.isDestroyed = () => false; window.webContents = { send: (...value) => messages.push(value) };
  const supervisor = { pauseForeground: () => new Promise(resolve => { unblock = resolve; }) };
  guardForegroundClose(window, { supervisor, isLastWindow: () => true, backgroundEnabled: () => false });
  window.emit('close', { preventDefault() { prevented++; } }); assert.equal(prevented, 1); assert.equal(closes, 0);
  unblock(); await new Promise(resolve => setImmediate(resolve)); assert.equal(closes, 1); assert.equal(prevented, 1);
  const failed = new EventEmitter(); failed.isDestroyed = () => false; failed.close = () => { throw new Error('Unverified close'); }; failed.webContents = window.webContents;
  guardForegroundClose(failed, { supervisor: { pauseForeground: async () => { throw new Error('Unknown termination'); } }, isLastWindow: () => true, backgroundEnabled: () => false });
  failed.emit('close', { preventDefault() { prevented++; } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1); assert.equal(messages[0][0], 'execution:blocked'); assert.match(messages[0][1], /Window kept open/);
});

test('local controls use the registered PM frame, host target and current epoch', () => {
  const frame = { parent: null, url: 'pipeliner://app/execution.html' };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  const calls = []; let revision = 1;
  const supervisor = { status: repository => ({ repository }), control: (binding, operation) => { calls.push({ binding, operation }); return { received: true, verified: false }; } };
  const channel = createExecutionControlChannel(supervisor, { contents, url: frame.url, context: () => ({ revision, target: 'R_fixture', binding: { runId: 'run-one', epoch: revision } }) });
  assert.deepEqual(channel.dispatch(event, { operation: 'status' }), { repository: 'R_fixture', contextRevision: 1 });
  assert.equal(channel.dispatch(event, { operation: 'pause', contextRevision: 1 }).received, true);
  assert.deepEqual(calls, [{ binding: { runId: 'run-one', epoch: 1 }, operation: 'pause' }]);
  assert.throws(() => channel.dispatch({ sender: {}, senderFrame: frame }, { operation: 'stop', contextRevision: 1 }), /Untrusted/);
  assert.throws(() => channel.dispatch(event, { operation: 'stop', contextRevision: 1, role: 'pm' }));
  revision = 2; assert.throws(() => channel.dispatch(event, { operation: 'stop', contextRevision: 1 }), /context changed/);
  assert.equal(channel.dispatch(event, { operation: 'status' }).contextRevision, 2);
  assert.equal(calls.length, 1);
});

test('restricted worker parameters bind ownership and enforce finite guest-only resources', () => {
  const manifest = { name: `pipeliner-${'a'.repeat(32)}`, nonce: 'b'.repeat(32), runId: 'run-one', repository: 'R_fixture', epoch: 1, workspace: `/home/fixture.guest/.local/share/pipeliner/workspaces/${'a'.repeat(32)}`, image: `sha256:${'c'.repeat(64)}` };
  const args = restrictedWorkerArgs(manifest, 'printf fixture');
  for (const [flag, value] of [['--network', 'none'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--pids-limit', '32'], ['--memory', '256m'], ['--cpus', '1']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('max-size=64k')); assert.ok(args.includes('max-file=1'));
  assert.equal(args[args.indexOf('-v') + 1], `${manifest.workspace}:/workspace:rw`);
  assert.throws(() => restrictedWorkerArgs({ ...manifest, workspace: '/Users/chris' }, 'true'));
  assert.throws(() => restrictedWorkerArgs({ ...manifest, workspace: `/tmp/pipeliner-${'a'.repeat(32)}` }, 'true'));
  assert.throws(() => restrictedWorkerArgs({ ...manifest, epoch: 0 }, 'true'));
  assert.throws(() => restrictedWorkerArgs({ ...manifest, approved: true }, 'true'));
  assert.throws(() => restrictedWorkerArgs(manifest, 'a'.repeat(32769)));
  assert.match(workerVMConfiguration, /mounts: \[\]/); assert.match(workerVMConfiguration, /forwardAgent: false/); assert.match(workerVMConfiguration, /loadDotSSHPubKeys: false/);
  assert.ok(!workerVMConfiguration.includes('template:')); assert.ok(!workerVMConfiguration.includes('latest'));
});

test('execution ownership rejects linked storage and does not overwrite its target', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-execution-test-')));
  try {
    const target = join(directory, 'protected'); writeFileSync(target, 'unchanged', { mode: 0o600 });
    symlinkSync(target, join(directory, 'owner.sqlite'));
    assert.throws(() => acquireExecutionOwner(directory), /Invalid protected file/);
    assert.equal(execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', target], { encoding: 'utf8' }), 'unchanged');
  } finally { rmSync(directory, { recursive: true }); assert.equal(existsSync(directory), false); }
});
