// Compatible local Mac only. Synthetic inputs and this owned worker do not establish provider or Human QA.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openWorkerEnvironment, workerDisk } from '../desktop/core/worker.mjs';
import { developmentWorkerProgram } from '../desktop/development/worker-tools.mjs';
import { sourceCandidate, committedInput } from '../desktop/package/source.mjs';
import testStorage from '../desktop/test-storage.cjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Compatible qualified Mac required.');
const storage = testStorage.qualificationContext(), repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await sourceCandidate(repository), candidate = { source: source.sourceCommit, tree: source.gitTree };
for (const file of ['scripts/desktop-tool-worker.mjs', 'desktop/core/worker.mjs', 'desktop/development/worker-tools.mjs', 'desktop/authority/Dockerfile']) await committedInput(repository, source, file);
mkdirSync(storage.paths.outputs, { mode: 0o700, recursive: true }); testStorage.validateOwnedDataDirectory(storage, storage.paths.outputs);
const directory = realpathSync(mkdtempSync(join(storage.paths.tmp, 'w-'))), runId = randomUUID().replaceAll('-', '');
testStorage.validateOwnedDataDirectory(storage, directory); const rootIdentity = lstatSync(directory);
const ownership = { issue: 54, owner: 'brimdor', directory, runId, candidate }, marker = join(directory, 'ownership.json');
writeFileSync(marker, JSON.stringify(ownership), { mode: 0o600, flag: 'wx' }); const owned = lstatSync(marker);
let environment, manifest, id, error = null, cleanup = null, stage = 'startup';
const started = performance.now(), results = [], bindings = [], jobs = [], signals = new AbortController();
const abort = () => signals.abort(); process.on('SIGTERM', abort); process.on('SIGINT', abort);
const progress = value => { stage = value; signals.signal.throwIfAborted(); console.log(JSON.stringify({ issue: 54, stage })); };
const verifyRoot = () => {
  testStorage.validateOwnedDataDirectory(storage, directory); const current = lstatSync(directory), currentMarker = lstatSync(marker);
  assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino);
  assert.equal(currentMarker.dev, owned.dev); assert.equal(currentMarker.ino, owned.ino); assert.equal(currentMarker.nlink, 1);
  assert.equal(currentMarker.isFile(), true); assert.equal(currentMarker.isSymbolicLink(), false); assert.equal(currentMarker.uid, process.getuid());
  assert.equal(currentMarker.mode & 0o777, 0o600); assert.equal(readFileSync(marker, 'utf8'), JSON.stringify(ownership));
};
console.log(JSON.stringify({ inventory: ownership, resources: 'Private VM/disk/image, container, workspace and child processes. Exact teardown in finally.' }));
try {
  environment = openWorkerEnvironment(directory);
  progress('preparing-owned-worker'); const prepared = await environment.prepare();
  const preparationMilliseconds = performance.now() - started; signals.signal.throwIfAborted();
  manifest = { name: 'pipeliner-' + runId, nonce: runId, runId, repository: 'R_tool_fixture', epoch: 1, workspace: prepared.workspaceRoot + '/' + runId, image: prepared.image };
  bindings.push({ manifest, id: null });
  progress('creating-restricted-container'); id = await environment.create(manifest, developmentWorkerProgram); bindings[0].id = id; await environment.start(manifest, id);
  const call = request => environment.tool(manifest, id, request, { signal: signals.signal });
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
  await environment.remove(manifest, id); await environment.removeWorkspace(manifest); bindings.length = 0;
  progress('five-owned-workers'); const batchStarted = performance.now(), batch = [];
  for (let index = 0; index < 5; index++) {
    signals.signal.throwIfAborted(); const nonce = randomUUID().replaceAll('-', ''), value = `Synthetic repository ${index}.\n`;
    const manifest = { name: 'pipeliner-' + nonce, nonce, runId: nonce, repository: 'R_native_' + index, epoch: 1, workspace: prepared.workspaceRoot + '/' + nonce, image: prepared.image };
    const binding = { manifest, id: null, value }; bindings.push(binding); batch.push(binding);
    binding.id = await environment.create(manifest, developmentWorkerProgram); await environment.start(manifest, binding.id);
    const seeded = await environment.tool(manifest, binding.id, { operation: 'seed', files: [{ path: 'fixture.txt', mode: '100644', content: Buffer.from(value).toString('base64') }] }, { signal: signals.signal }); assert.equal(seeded.ok, true);
  }
  const observations = await Promise.all(batch.map(binding => environment.inspect(binding.manifest, binding.id)));
  assert.equal(new Set(observations.map(value => value.id)).size, 5);
  for (const observed of observations) { assert.equal(observed.state, 'running'); assert.ok(observed.pid > 0); }
  const command = `node -e 'const fs=require("fs");const input=JSON.parse(fs.readFileSync(process.env.PIPELINER_STEP_INPUT_FILE,"utf8"));fs.writeFileSync("ready.json",JSON.stringify({repository:input.repository,pid:process.pid}));const began=performance.now();const timer=setInterval(()=>{if(!fs.existsSync("release.txt"))return;clearInterval(timer);let sum=0;for(let i=0;i<500000;i++)sum=(sum+i)%1000003;console.log(JSON.stringify({repository:input.repository,pid:process.pid,value:fs.readFileSync("fixture.txt","utf8"),sum,milliseconds:performance.now()-began,node:process.version}));},25);'`;
  for (const binding of batch) jobs.push(environment.tool(binding.manifest, binding.id, { operation: 'run', input: { repository: binding.manifest.repository }, command, timeoutMs: 60000 }, { signal: signals.signal }).then(value => ({ value }), error => ({ error })));
  const ready = new Map(), readinessStarted = performance.now();
  while (ready.size < 5) {
    signals.signal.throwIfAborted(); assert.ok(performance.now() - readinessStarted < 30000, 'Five-command readiness exceeded its operation bound');
    const values = await Promise.all(batch.map(binding => environment.tool(binding.manifest, binding.id, { operation: 'read', path: 'ready.json' }, { signal: signals.signal })));
    for (let index = 0; index < values.length; index++) if (values[index].ok) {
      const value = JSON.parse(values[index].result.content); assert.equal(value.repository, batch[index].manifest.repository); assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0); ready.set(value.repository, value);
    }
    if (ready.size < 5) await new Promise(done => setTimeout(done, 100));
  }
  progress('releasing-five-ready-commands');
  for (const binding of batch) { const result = await environment.tool(binding.manifest, binding.id, { operation: 'write', path: 'release.txt', content: Buffer.from('Release owned fixture.\n').toString('base64'), mode: '100644', beforeHash: null }, { signal: signals.signal }); assert.equal(result.ok, true); }
  const completed = await Promise.all(jobs), measurements = [];
  for (let index = 0; index < completed.length; index++) {
    if (completed[index].error) throw completed[index].error;
    const result = completed[index].value; assert.equal(result.ok, true); assert.equal(result.result.exitCode, 0); assert.equal(result.result.truncated, false); assert.equal(result.result.timedOut, false);
    const value = JSON.parse(result.result.output.trim()); assert.equal(value.value, batch[index].value); assert.equal(value.repository, batch[index].manifest.repository); assert.equal(value.pid, ready.get(value.repository).pid); assert.equal(value.sum, (499999 * 500000 / 2) % 1000003);
    measurements.push({ repository: value.repository, milliseconds: value.milliseconds, guestNode: value.node });
  }
  results.push({ name: 'five-concurrent-bounded-native-commands', passed: true, preparationMilliseconds, milliseconds: performance.now() - batchStarted, readyTogether: ready.size, measurements, image: prepared.image, disk: prepared.disk, configuration: prepared.configuration, scope: 'Worker mechanism; synthetic repositories, not full Development runs.' });
} catch (failure) { error = { stage, message: failure.message, code: failure.cause?.code ?? null }; }
finally {
  signals.abort(); await Promise.all(jobs); stage = 'verifying-owned-cleanup'; console.log(JSON.stringify({ issue: 54, stage }));
  try {
    verifyRoot(); const engine = join(directory, 'lima', 'engine'), helperPIDs = [];
    if (existsSync(engine)) for (const file of readdirSync(engine).filter(name => /^[A-Za-z0-9_.-]+\.pid$/.test(name))) {
      const path = join(engine, file), info = lstatSync(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 && info.size <= 64);
      const raw = readFileSync(path, 'utf8').trim(); if (/^[1-9][0-9]*$/.test(raw)) helperPIDs.push(Number(raw)); else throw new Error('Owned helper PID unavailable');
    }
    if (error && existsSync(engine)) for (const name of ['ha.stderr.log', 'ha.stdout.log', 'serial.log']) {
      const file = join(engine, name); if (!existsSync(file)) continue; const info = lstatSync(file); assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 && info.size <= 1048576);
      writeFileSync(join(storage.paths.outputs, `${runId}-${name}`), readFileSync(file).subarray(-32768), { flag: 'wx', mode: 0o600 });
    }
    if (environment) {
      for (const binding of bindings) { await environment.remove(binding.manifest, binding.id); await environment.removeWorkspace(binding.manifest); }
      await environment.verifyIdle([], { checkpoint: verifyRoot }); cleanup = await environment.destroy();
    }
    for (const pid of new Set(helperPIDs)) { try { process.kill(pid, 0); throw new Error('Owned helper still present'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; } }
    const handles = spawnSync('/usr/sbin/lsof', ['+D', directory], { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 });
    assert.equal(handles.error, undefined); assert.equal(handles.status, 1); assert.equal(handles.stdout, ''); assert.equal(handles.stderr, ''); verifyRoot();
    rmSync(directory, { recursive: true }); cleanup ??= { environmentOpened: false }; cleanup.workspaceRemoved = !existsSync(directory); assert.equal(cleanup.workspaceRemoved, true);
    cleanup.helperPIDsAbsent = true; cleanup.openHandlesAbsent = true;
  } catch (failure) { cleanup = { ...cleanup, failed: true, message: failure.message, retainedOwner: ownership.owner, trigger: 'Repair exact owned teardown before further qualification.' }; }
  process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
}
const passed = !error && results.length === 4 && cleanup?.workspaceRemoved === true && !cleanup.failed;
const report = { issue: 54, passed, candidate, milliseconds: Math.round(performance.now() - started), hostNode: process.version, pid: process.pid, results, error, cleanup };
writeFileSync(join(storage.paths.outputs, `native-worker-${runId}.json`), JSON.stringify(report), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(report));
process.exitCode = passed ? 0 : 1;
