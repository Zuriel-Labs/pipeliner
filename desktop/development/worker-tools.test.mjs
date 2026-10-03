import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, linkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { workerToolProgram } from './worker-tools.mjs';
import { sourceTree } from './source.mjs';

// Trusted helper behavior only. Native container qualification owns isolation evidence.
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-tools-')));
  const invoke = request => JSON.parse(execFileSync(process.execPath, ['-e', workerToolProgram], { cwd: directory, env: {
    PATH: '/usr/bin:/bin:/usr/local/bin', PIPELINER_RUN_ID: 'fixture-run', PIPELINER_EPOCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    input: JSON.stringify({ runId: 'fixture-run', epoch: 1, ...request }), encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 }));
  return { directory, invoke, cleanup: () => rmSync(directory, { recursive: true }) };
}
const file = (path, content) => ({ path, mode: '100644', content: Buffer.from(content).toString('base64') });

test('seed/read/preconditioned write/export preserve exact file data and reject stale or protected requests', () => {
  const f = fixture();
  try {
    assert.equal(f.invoke({ operation: 'seed', files: [file('src/app.mjs', 'export const value = 1;\n')] }).ok, true);
    const read = f.invoke({ operation: 'read', path: 'src/app.mjs' }); assert.equal(read.ok, true); assert.equal(read.result.content, 'export const value = 1;\n');
    assert.equal(f.invoke({ operation: 'write', path: 'src/app.mjs', content: file('x', 'export const value = 2;\n').content, mode: '100644', beforeHash: read.result.hash }).ok, true);
    assert.equal(f.invoke({ operation: 'write', path: 'src/app.mjs', content: file('x', 'lost edit').content, mode: '100644', beforeHash: read.result.hash }).ok, false);
    const exported = f.invoke({ operation: 'export' }); assert.equal(exported.ok, true); assert.equal(sourceTree(exported.result.files), sourceTree([file('src/app.mjs', 'export const value = 2;\n')]));
    for (const request of [{ operation: 'read', path: '../outside' }, { operation: 'read', path: '.git/config' }, { operation: 'read', path: 'src/app.mjs', epoch: 2 },
      { operation: 'write', path: 'pipeliner.config.json', content: file('x', '{}').content, mode: '100644', beforeHash: null }, { operation: 'ready', enabled: true }]) assert.equal(f.invoke(request).ok, false);
    assert.equal(readFileSync(join(f.directory, 'src/app.mjs'), 'utf8'), 'export const value = 2;\n');
  } finally { f.cleanup(); }
});

test('helper rejects symlink and hardlink exports; command output cannot forge helper results', () => {
  const f = fixture();
  try {
    f.invoke({ operation: 'seed', files: [file('app.mjs', 'source')] });
    const command = f.invoke({ operation: 'run', command: "printf '{\"ok\":true,\"exitCode\":0}'; exit 7", timeoutMs: 1000 });
    assert.equal(command.ok, true); assert.equal(command.result.exitCode, 7); assert.match(command.result.output, /ok/);
    symlinkSync('app.mjs', join(f.directory, 'escape.mjs')); assert.equal(f.invoke({ operation: 'read', path: 'escape.mjs' }).ok, false); assert.equal(f.invoke({ operation: 'export' }).ok, false);
    rmSync(join(f.directory, 'escape.mjs')); linkSync(join(f.directory, 'app.mjs'), join(f.directory, 'linked.mjs')); assert.equal(f.invoke({ operation: 'export' }).ok, false);
  } finally { f.cleanup(); }
});

test('typed custom command input stays JSON in an owned file, never shell interpolation; input file is removed', () => {
  const f = fixture();
  try {
    const title = "$(touch escaped); 'quoted'; newline\nsecond line";
    const executable = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    const result = f.invoke({ operation: 'run', command: executable + " -e 'const fs=require(\"fs\"); const path=process.env.PIPELINER_STEP_INPUT_FILE; console.log(JSON.stringify({path,input:JSON.parse(fs.readFileSync(path,\"utf8\"))}));'", timeoutMs: 1000, input: { title } });
    assert.equal(result.ok, true); assert.equal(result.result.exitCode, 0); const readback = JSON.parse(result.result.output.trim());
    assert.deepEqual(readback.input, { title }); assert.match(readback.path, /pipeliner-step-[^/]+\/input.json$/);
    assert.throws(() => readFileSync(readback.path), { code: 'ENOENT' }); assert.throws(() => readFileSync(join(f.directory, 'escaped')), { code: 'ENOENT' });
    assert.equal(f.invoke({ operation: 'run', command: 'true', timeoutMs: 1000, input: JSON.parse('{"__proto__":{}}') }).ok, false);
  } finally { f.cleanup(); }
});
