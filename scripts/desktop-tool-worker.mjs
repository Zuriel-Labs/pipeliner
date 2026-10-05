// Compatible local Mac only. Synthetic inputs and this owned worker do not establish provider or Human QA.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openWorkerEnvironment, workerDisk } from '../desktop/core/worker.mjs';
import { developmentWorkerProgram } from '../desktop/development/worker-tools.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Compatible qualified Mac required.');
const directory = realpathSync(mkdtempSync('/private/tmp/pipeliner-tools-')), runId = randomUUID().replaceAll('-', '');
const ownership = { issue: 54, owner: 'brimdor', directory, runId }, marker = join(directory, 'ownership.json');
writeFileSync(marker, JSON.stringify(ownership), { mode: 0o600, flag: 'wx' }); const owned = lstatSync(marker);
const environment = openWorkerEnvironment(directory), started = performance.now(), results = [];
let manifest, id, error = null, cleanup = null;
const progress = stage => console.log(JSON.stringify({ issue: 54, stage }));
console.log(JSON.stringify({ inventory: ownership, resources: 'Private VM/disk/image, container, workspace and child processes. Exact teardown in finally.' }));
try {
  progress('preparing-owned-worker'); const prepared = await environment.prepare();
  manifest = { name: 'pipeliner-' + runId, nonce: runId, runId, repository: 'R_tool_fixture', epoch: 1, workspace: prepared.workspaceRoot + '/' + runId, image: prepared.image };
  progress('creating-restricted-container'); id = await environment.create(manifest, developmentWorkerProgram); await environment.start(manifest, id);
  const call = request => environment.tool(manifest, id, request);
  const seeded = await call({ operation: 'seed', files: [{ path: 'fixture.txt', mode: '100644', content: Buffer.from('Synthetic owned source.\n').toString('base64') }] }); assert.equal(seeded.ok, true);
  const input = { title: "$(touch escaped); 'quoted'; newline\nsecond line" };
  progress('typed-custom-command');
  const before = performance.now(), result = await call({ operation: 'run', input, timeoutMs: 1000,
    command: "node -e 'const fs=require(\"fs\");const path=process.env.PIPELINER_STEP_INPUT_FILE;console.log(JSON.stringify({input:JSON.parse(fs.readFileSync(path,\"utf8\")),path,node:process.version}));'" });
  assert.equal(result.ok, true); assert.equal(result.result.exitCode, 0); assert.equal(result.result.truncated, false); assert.equal(result.result.timedOut, false);
  const observed = JSON.parse(result.result.output.trim()); assert.deepEqual(observed.input, input); assert.match(observed.path, /^\/tmp\/pipeliner-step-[A-Za-z0-9]+\/input.json$/);
  const listing = await call({ operation: 'list' }); assert.equal(listing.ok, true); assert.deepEqual(listing.result.files.map(file => file.path), ['fixture.txt']);
  results.push({ name: 'typed-data-through-real-restricted-worker', passed: true, milliseconds: Number((performance.now() - before).toFixed(3)), guestNode: observed.node, image: prepared.image, disk: workerDisk.digest });
  const absent = await call({ operation: 'run', input: {}, timeoutMs: 1000, command: "test ! -e '" + observed.path + "'" }); assert.equal(absent.result.exitCode, 0);
  results.push({ name: 'verified-container-restart-clears-owned-temporary-input', passed: true });
  await assert.rejects(call({ operation: 'run', input: JSON.parse('{"__proto__":{"admin":true}}'), timeoutMs: 1000, command: 'touch forbidden' }), /MCP data/);
  const final = await call({ operation: 'list' }); assert.deepEqual(final.result.files.map(file => file.path), ['fixture.txt']);
  results.push({ name: 'reserved-input-denied-before-command', passed: true });
} catch { error = 'Native custom-command qualification failed; inspect the last recorded stage.'; }
finally {
  progress('verifying-owned-cleanup');
  try {
    if (manifest) { await environment.remove(manifest, id ?? null); await environment.removeWorkspace(manifest); }
    cleanup = await environment.destroy();
    const current = lstatSync(marker);
    assert.equal(current.dev, owned.dev); assert.equal(current.ino, owned.ino); assert.equal(current.isSymbolicLink(), false); assert.equal(current.nlink, 1);
    assert.equal(readFileSync(marker, 'utf8'), JSON.stringify(ownership)); assert.equal(realpathSync(directory), directory);
    rmSync(directory, { recursive: true }); cleanup.workspaceRemoved = !existsSync(directory); assert.equal(cleanup.workspaceRemoved, true);
  } catch { cleanup = { ...cleanup, failed: true, retainedOwner: ownership.owner, trigger: 'Repair exact owned teardown before further qualification.' }; }
}
const passed = !error && results.length === 3 && cleanup?.workspaceRemoved === true && !cleanup.failed;
console.log(JSON.stringify({ issue: 54, passed, milliseconds: Math.round(performance.now() - started), hostNode: process.version, pid: process.pid, results, error, cleanup }));
process.exitCode = passed ? 0 : 1;
