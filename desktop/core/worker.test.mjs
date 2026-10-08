import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';

const settings = fs.readFileSync(new URL('./settings.mjs', import.meta.url), 'utf8');
const settingsPrimitives = settings.slice(0, settings.indexOf('\nconst identifier')).replace(/^export /gm, '');

const source = fs.readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
  .replaceAll('import.meta.url', JSON.stringify(new URL('./worker.mjs', import.meta.url).href));

function workerFixture(root, respond) {
  // Actual files and synthetic short paths/native responses; this cannot qualify a VM.
  const mapped = value => {
    if (typeof value === 'number') return value;
    assert.ok(value === '/owned' || value.startsWith('/owned/')); return root + value.slice('/owned'.length);
  };
  const context = { Buffer, URL, process, join, dirname, createHash, randomUUID, fileURLToPath,
    constants: fs.constants, setTimeout, clearTimeout, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync,
    realpathSync: value => '/owned' + fs.realpathSync(mapped(value)).slice(root.length),
    spawn(file, args, options) {
      assert.equal(file, '/opt/homebrew/bin/limactl');
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {}; child.stdin = new EventEmitter();
      child.finish = (output = '', code = 0) => { child.stdout.emit('data', output); child.emit('close', code, null); };
      child.stdin.end = () => queueMicrotask(() => { const output = respond([...args], options, child); if (output !== undefined) child.finish(output); });
      return child;
    } };
  for (const name of ['existsSync', 'mkdirSync', 'lstatSync', 'readFileSync', 'writeFileSync', 'openSync', 'unlinkSync'])
    context[name] = (value, ...args) => fs[name](mapped(value), ...args);
  context.renameSync = (from, to) => fs.renameSync(mapped(from), mapped(to));
  return runInNewContext(settingsPrimitives + '\n' + source + '\n({openWorkerEnvironment,workerDisk,parse:JSON.parse});', context, { timeout: 1000 });
}

test('cold worker inspection refuses missing state without creating files or exposing execution controls', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  for (const mode of ['missing-root', 'existing', 'missing-home', 'missing-lima', 'missing-marker', 'missing-config', 'changed-config']) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pipeliner-54-cold-worker-'))), commands = [];
    try {
      const api = workerFixture(root, (args, options) => {
        assert.deepEqual(args, ['list', '--json']);
        commands.push({ args, home: options.env.HOME, lima: options.env.LIMA_HOME });
        return '{"name":"engine","status":"Stopped"}\n';
      });
      if (mode !== 'missing-root') {
        const ordinary = api.openWorkerEnvironment('/owned');
        assert.equal(typeof ordinary.prepare, 'function'); assert.equal(typeof ordinary.destroy, 'function');
        assert.equal(commands.length, 0);
      }
      const missing = { 'missing-home': 'home', 'missing-lima': 'lima', 'missing-marker': 'environment.json', 'missing-config': 'worker.yaml' }[mode];
      if (missing) fs.rmSync(join(root, missing), { recursive: true });
      if (mode === 'changed-config') fs.writeFileSync(join(root, 'worker.yaml'), 'Synthetic configuration drift', { mode: 0o600 });
      function snapshot() {
        const rows = [], pending = [root];
        while (pending.length) {
          const path = pending.pop(), value = fs.lstatSync(path, { bigint: true });
          const row = { path: path.slice(root.length), identity: ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => value[key].toString()) };
          if (value.isDirectory()) pending.push(...fs.readdirSync(path).map(name => join(path, name)));
          else row.sha256 = createHash('sha256').update(fs.readFileSync(path)).digest('hex');
          rows.push(row);
        }
        return rows.sort((a, b) => a.path.localeCompare(b.path));
      }
      const before = snapshot();
      if (mode === 'existing') {
        const inspection = api.openWorkerEnvironment('/owned', { inspectionOnly: true });
        assert.equal(Object.isFrozen(inspection), true); assert.deepEqual(Object.keys(inspection).sort(), ['inspect', 'inventory', 'verifyIdle']);
        assert.equal(commands.length, 0);
        assert.equal((await inspection.inventory()).status, 'Stopped');
        const result = await inspection.inspect({ name: 'pipeliner-' + 'a'.repeat(32) }); assert.equal(result.state, 'vm-stopped');
        assert.deepEqual(commands, [{ args: ['list', '--json'], home: '/owned/home', lima: '/owned/lima' }, { args: ['list', '--json'], home: '/owned/home', lima: '/owned/lima' }]);
      } else {
        const directory = mode === 'missing-root' ? '/owned/missing' : '/owned';
        assert.throws(() => api.openWorkerEnvironment(directory, { inspectionOnly: true })); assert.equal(commands.length, 0);
      }
      assert.deepEqual(snapshot(), before);
      assert.throws(() => api.openWorkerEnvironment('/owned/missing', { inspectionOnly: 'yes' }));
      assert.deepEqual(snapshot(), before);
    } finally { fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false); }
  }
});

test('maintenance inspects the whole private runtime and refuses changed custody or unsettled cancellation', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const manifest = { name: `pipeliner-${'a'.repeat(32)}`, nonce: 'a'.repeat(32), runId: 'run-one', repository: 'R_fixture', epoch: 1,
    workspace: `/home/fixture/.local/share/pipeliner/workspaces/${'a'.repeat(32)}`, image: `sha256:${'c'.repeat(64)}` };
  const id = 'd'.repeat(64), modes = ['stopped', 'missing', 'empty', 'empty-other', 'stopped-absent', 'exited', 'unrecorded', 'other-namespace', 'duplicate-vm', 'duplicate-container', 'replaced-container',
    'running', 'forged-label', 'missing-exited', 'vm-change', 'container-change', 'lost-authority', 'changed-marker', 'changed-config', 'abort-before', 'abort-during', 'async-checkpoint', 'duplicate-record'];
  for (const mode of modes) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pipeliner-54-idle-worker-'))), commands = [], controller = new AbortController();
    let authority = true, lists = 0, containers = 0, held, work;
    try {
      const api = workerFixture(root, (args, options, child) => {
        commands.push(args); assert.equal(options.env.LIMA_HOME, '/owned/lima');
        if (mode === 'abort-during') { held = child; return; }
        if (mode === 'lost-authority') authority = false;
        if (mode === 'changed-marker') fs.writeFileSync(join(root, 'environment.json'), '{}');
        if (mode === 'changed-config') fs.writeFileSync(join(root, 'worker.yaml'), 'changed');
        if (args[0] === 'list') {
          lists++;
          if (mode === 'missing') return '';
          const row = { name: 'engine', status: mode === 'stopped' || mode === 'vm-change' && lists > 2 ? 'Stopped' : 'Running',
            vmType: 'vz', arch: 'aarch64', cpus: 2, memory: 1073741824, disk: 8589934592,
            config: { mounts: [], ssh: { forwardAgent: false, loadDotSSHPubKeys: false, forwardX11: false }, containerd: { system: false, user: true },
              propagateProxyEnv: false, images: [{ location: api.workerDisk.url, digest: api.workerDisk.digest }], portForwards: [{ ignore: true }] } };
          return JSON.stringify(row) + (mode === 'duplicate-vm' ? '\n' + JSON.stringify(row) : '');
        }
        assert.deepEqual(args.slice(0, 3), ['shell', 'engine', '--']);
        const guest = args.slice(3);
        if (guest[0] === 'sh') return '';
        if (guest[1] === 'info') return '{"SecurityOptions":["rootless"]}';
        if (guest[1] === 'namespace') return ['other-namespace', 'empty-other'].includes(mode) ? 'default\nother' : 'default';
        if (guest.includes('ps')) {
          containers++;
          if (['empty', 'empty-other', 'stopped-absent', 'missing-exited'].includes(mode)) return '';
          if (guest.includes('other')) return 'unrecorded';
          const line = guest.includes('--no-trunc') ? (mode === 'replaced-container' ? 'e'.repeat(64) : id) + '\t' + manifest.name : manifest.name;
          if (mode === 'unrecorded' || mode === 'container-change' && containers > 1) return line + '\nunrecorded';
          if (mode === 'duplicate-container') return line + '\n' + line;
          return line;
        }
        if (guest[1] === 'image') return manifest.image;
        assert.equal(guest[1], 'inspect');
        if (guest.includes('--mode=native')) return JSON.stringify({ ID: id, Image: manifest.image, Spec: {
          process: { noNewPrivileges: true, capabilities: {} }, root: { readonly: true }, linux: {
            namespaces: [{ type: 'pid' }, { type: 'network' }], resources: { pids: { limit: 32 }, memory: { limit: 268435456 }, cpu: { quota: 100000, period: 100000 } } } } });
        return JSON.stringify({ Id: id, Name: '/' + manifest.name, Config: { Labels: { 'pipeliner.owner': mode === 'forged-label' ? 'forged' : manifest.nonce,
          'pipeliner.run': manifest.runId, 'pipeliner.repository': manifest.repository, 'pipeliner.epoch': '1' } },
          HostConfig: { NetworkMode: 'none', Privileged: false, RestartPolicy: { Name: 'no' } }, State: { Status: mode === 'running' ? 'running' : 'exited', Pid: mode === 'running' ? 12 : 0, ExitCode: 0 } });
      });
      api.openWorkerEnvironment('/owned');
      const inspector = api.openWorkerEnvironment('/owned', { inspectionOnly: true });
      assert.equal(typeof inspector.verifyIdle, 'function');
      const binding = { manifest, state: mode === 'stopped-absent' ? 'stopped' : 'exited', cid: id };
      const rows = ['empty', 'empty-other'].includes(mode) ? [] : mode === 'duplicate-record' ? [binding, binding] : [binding];
      const checkpoint = mode === 'async-checkpoint' ? async () => true : () => { if (!authority) throw Error('Authority changed'); };
      if (mode === 'abort-before') controller.abort();
      work = inspector.verifyIdle(api.parse(JSON.stringify(rows)), { signal: controller.signal, checkpoint });
      if (mode === 'abort-during') {
        let settled = false; work.then(() => { settled = true; }, () => { settled = true; });
        await new Promise(resolve => setImmediate(resolve)); assert.ok(held); controller.abort();
        await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
        held.finish(); held = null;
      }
      if (['stopped', 'missing', 'empty', 'empty-other', 'stopped-absent', 'exited'].includes(mode)) assert.equal(await work, true, mode);
      else await assert.rejects(work, undefined, mode);
      if (['abort-before', 'async-checkpoint', 'duplicate-record'].includes(mode)) assert.equal(commands.length, 0, mode);
      if (['abort-during', 'lost-authority', 'changed-marker', 'changed-config', 'duplicate-vm'].includes(mode)) assert.equal(commands.length, 1, mode);
    } finally {
      controller.abort(); held?.finish(); await work?.catch(() => {});
      fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false);
    }
  }
});
