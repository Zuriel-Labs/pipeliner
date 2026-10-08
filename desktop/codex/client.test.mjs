import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

test('Codex close settles its own Mac group once and retains unverified cleanup', async () => {
  const source = readFileSync(new URL('./client.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  for (const mode of ['held', 'force', 'root-force', 'stuck', 'refused', 'unexpected', 'spawn-error', 'other-host']) {
    const child = new EventEmitter(), groupSignals = [], rootSignals = [], timers = new Set();
    Object.assign(child, { pid: mode === 'spawn-error' ? undefined : 12345, exitCode: null, signalCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end() {}, write() {} }) });
    let members = true, entered;
    const observed = new Promise(resolve => { entered = resolve; });
    child.kill = signal => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return false;
      rootSignals.push(signal);
      if (mode === 'root-force' && signal === 'SIGTERM') return true;
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null)); return true;
    };
    const context = vm.createContext({ spawn(file, args, options) {
      assert.equal(file, '/synthetic/codex'); assert.deepEqual(Array.from(args), ['app-server', '--listen', 'stdio://', '--strict-config']);
      assert.equal(options.env.CODEX_HOME, '/synthetic/private-home'); assert.equal(options.env.HOME, '/synthetic/user');
      assert.equal(options.detached, mode !== 'other-host');
      if (mode === 'spawn-error') queueMicrotask(() => child.emit('error', Error('Synthetic unavailable helper')));
      return child;
    }, process: { platform: mode === 'other-host' ? 'win32' : 'darwin', kill(pid, signal) {
      assert.equal(pid, -12345); groupSignals.push(signal); entered();
      if (mode === 'refused') throw Object.assign(Error('Synthetic custody refusal'), { code: 'EPERM' });
      if (!members) throw Object.assign(Error('Synthetic group absent'), { code: 'ESRCH' });
      if (signal === 'SIGKILL' && mode !== 'stuck' || signal === 'SIGTERM' && !['held', 'force', 'stuck'].includes(mode)) members = false;
      return true;
    } }, homedir: () => '/synthetic/user', packagedCodexPath: () => '/synthetic/codex',
    createInterface: () => new EventEmitter(), writeFile: async () => assert.fail('No provider tool'),
    setTimeout(callback) { const handle = setImmediate(() => { timers.delete(handle); callback(); }); timers.add(handle); return handle; },
    clearTimeout(handle) { clearImmediate(handle); timers.delete(handle); } });
    let pending;
    try {
      const AppServer = vm.runInContext(source + '\nAppServer;', context), server = new AppServer('/synthetic/private-home');
      if (mode === 'unexpected') { child.exitCode = 7; child.emit('exit', 7); await observed; }
      let finished = false;
      pending = server.close(); pending.then(() => { finished = true; }, () => {});
      assert.equal(server.close(), pending);
      if (mode === 'held') { await observed; await new Promise(setImmediate); assert.equal(finished, false); members = false; }
      if (['stuck', 'refused'].includes(mode)) await assert.rejects(pending);
      else await pending;
      assert.equal(rootSignals.length, ['unexpected', 'spawn-error'].includes(mode) ? 0 : mode === 'root-force' ? 2 : 1);
      if (mode === 'root-force') assert.deepEqual(rootSignals, ['SIGTERM', 'SIGKILL']);
      if (mode === 'other-host' || mode === 'spawn-error') assert.deepEqual(groupSignals, []);
      else if (mode === 'force') { assert.equal(members, false); assert.equal(groupSignals.filter(signal => signal === 'SIGKILL').length, 1); }
      else if (!['stuck', 'refused'].includes(mode)) assert.equal(members, false);
      const sent = groupSignals.length; assert.equal(server.close(), pending);
      await Promise.allSettled([server.close()]); assert.equal(groupSignals.length, sent);
    } finally {
      members = false; await Promise.allSettled(pending ? [pending] : []);
      for (const handle of timers) clearImmediate(handle);
    }
  }
});
