'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const admission = require('./desktop-test-process.cjs'); admission.activate();
assert.throws(() => admission.activate({ run: '/tmp/foreign' }), /test-process-context-mismatch/);
const closed = child => new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
let stage = 'spawn', passed = 0;
async function main() {
  const child = cp.spawn('/bin/sh', ['-c', 'printf "%s\\n" "$$"; /bin/ps -p "$$" -o pgid=; exit 7'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => output += bytes);
  assert.equal(await closed(child), 7); assert.deepEqual(output.trim().split(/\s+/).map(Number), [child.pid, child.pid]);
  assert.equal(child.spawnfile, '/bin/sh');
  assert.equal(child[Symbol.for('pipeliner.developer.process-admission')].sequence, 1);
  passed++; stage = 'promisified-exec-file';
  const task = promisify(cp.execFile)('/bin/sh', ['-c', 'printf "%s" "$$"'], { detached: true, encoding: 'utf8' });
  assert(Number.isSafeInteger(task.child.pid)); assert.equal((await task).stdout, String(task.child.pid));
  // Node 22 execFile does not forward detached; preserve its actual API behavior.
  assert.equal(task.child[Symbol.for('pipeliner.developer.process-admission')], undefined);
  passed++; stage = 'cleared-environment-nested-node';
  const nested = cp.execFileSync(process.execPath, ['-e', `
    const cp=require('node:child_process');
    if(!globalThis[Symbol.for('pipeliner.developer.process-admission')])throw Error('nested-admission-missing');
    if(process.env.TEST_ARTIFACT_RUN!==undefined)throw Error('cleared environment changed');
    const child=cp.spawn('/bin/sh',['-c','printf nested'],{detached:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',bytes=>output+=bytes);child.once('error',()=>process.exit(1));child.once('close',code=>{
      console.log(JSON.stringify({output,admission:child[Symbol.for('pipeliner.developer.process-admission')]}));process.exit(code);
    });
  `], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20000 });
  const observed = JSON.parse(nested); assert.equal(observed.output, 'nested'); assert.equal(observed.admission.sequence, 2);
  passed++; stage = 'receipt-readback';
  const receipt = JSON.parse(fs.readFileSync(path.join(process.env.TEST_ARTIFACT_RUN, 'manifest.json')));
  assert.equal(receipt.quality_groups.registration_sequence, 2);
  console.log(JSON.stringify({ testProcessProbe: true, passed: 3, failures: 0, clearedEnvironmentPreserved: true,
    detachedPidPreserved: true, promisifiedChildPreserved: true, enrollmentSequence: 2 }));
}
main().catch(error => { console.error(JSON.stringify({ testProcessProbe: true, passed, stage, error: error.code || 'probe-failed',
  line: Number(/desktop-test-process-probe\.cjs:(\d+)/.exec(error.stack)?.[1]) || null })); process.exitCode = 1; });
