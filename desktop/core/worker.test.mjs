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

test('cold worker inspection refuses missing state without creating files or exposing execution controls', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  for (const mode of ['missing-root', 'existing', 'missing-home', 'missing-lima', 'missing-marker', 'missing-config', 'changed-config']) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pipeliner-54-cold-worker-'))), commands = [];
    try {
      // Actual owned files, with synthetic short path names and native command responses.
      // The external run prefix exceeds the unchanged Lima socket limit; this is not native qualification.
      const mapped = value => {
        if (typeof value === 'number') return value;
        assert.ok(value === '/owned' || value.startsWith('/owned/')); return root + value.slice('/owned'.length);
      };
      const context = { Buffer, URL, process, join, dirname, createHash, randomUUID, fileURLToPath,
        constants: fs.constants, setTimeout, clearTimeout, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync,
        realpathSync: value => '/owned' + fs.realpathSync(mapped(value)).slice(root.length),
        spawn(file, args, options) {
          assert.equal(file, '/opt/homebrew/bin/limactl'); assert.deepEqual([...args], ['list', '--json']);
          commands.push({ args: [...args], home: options.env.HOME, lima: options.env.LIMA_HOME });
          const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdout.setEncoding = () => {}; child.stdin = new EventEmitter();
          child.stdin.end = () => queueMicrotask(() => { child.stdout.emit('data', '{"name":"engine","status":"Stopped"}\n'); child.emit('close', 0, null); });
          return child;
        } };
      for (const name of ['existsSync', 'mkdirSync', 'lstatSync', 'readFileSync', 'writeFileSync', 'openSync', 'unlinkSync'])
        context[name] = (value, ...args) => fs[name](mapped(value), ...args);
      context.renameSync = (from, to) => fs.renameSync(mapped(from), mapped(to));
      const api = runInNewContext(settingsPrimitives + '\n' + source + '\n({openWorkerEnvironment});', context, { timeout: 1000 });
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
        assert.equal(Object.isFrozen(inspection), true); assert.deepEqual(Object.keys(inspection).sort(), ['inspect', 'inventory']);
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
