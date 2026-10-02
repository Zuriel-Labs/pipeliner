// Local qualification only. Synthetic repository/Dev facts are not provider or Human QA evidence.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPolicyStore } from './policy.mjs';
import { inspectWorkspace, workspaceCandidate } from './identity.mjs';
import { openExecutionSupervisor } from './execution.mjs';

const cases = ['allowed', 'gentle', 'forced', 'forged', 'failed', 'crash', 'crashcancel', 'crasheffect', 'output', 'limited'];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const gentleProgram = `node -e ${quote(`const fs=require('node:fs'),cp=require('node:child_process');const p='/workspace/retained.txt';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));cp.spawn('/bin/sleep',['1000']);process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`)}`;
export function openExecutionFixture(directory, { crashAfterEffect = false, repositoryUnavailable = false } = {}) {
  const state = join(directory, 'fixture-state'); if (!existsSync(state)) mkdirSync(state, { mode: 0o700 });
  const repositories = cases.map(name => `R_${name}`);
  const catalog = { repositories, capabilities: ['workspace.read', 'workspace.write', 'worker.exec'], maxConcurrency: 1, background: false,
    connections: cases.map(name => ({ id: `codex-${name}`, provider: 'codex', repositories: [`R_${name}`] })),
    developers: cases.map(name => ({ id: `dev-${name}`, connection: `codex-${name}`, metrics: [] })), extensions: [] };
  let supervisor;
  const store = openPolicyStore(state, { catalog: () => catalog, inspectors: {
    repository: async ({ repository, issue }) => { if (repositoryUnavailable) throw new Error('Repository service unavailable'); return { repository, issue, status: 'In Progress', state: 'OPEN', active: [{ issue, status: 'In Progress' }], observedAt: Date.now() }; },
    worker: binding => supervisor.inspectWorker(binding), effect: async action => {
      const observation = await supervisor.inspectEffect(action);
      if (crashAfterEffect && action.repository === 'R_crasheffect') { assert.equal(observation.result, 'present'); await new Promise(resolve => process.stdout.write('crash-effect-ready\n', resolve)); process.kill(process.pid, 'SIGKILL'); }
      return observation;
    },
  } });
  const identities = new Map();
  for (const name of cases) {
    const checkout = join(directory, `repo-${name}`);
    const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-C', checkout, ...args],
      { env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!existsSync(checkout)) { mkdirSync(checkout, { mode: 0o700 }); git(['init', '--initial-branch=main']); writeFileSync(join(checkout, 'fixture.txt'), 'Owned synthetic repository\n'); git(['add', 'fixture.txt']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']); git(['remote', 'add', 'origin', `https://github.com/PipelinerFixtures/${name}.git`]); }
    const repository = `R_${name}`;
    identities.set(repository, inspectWorkspace(checkout, { repository, owner: 'PipelinerFixtures', name }));
    if (store.worker.read(repository).values['agents.dev'].value === null) {
      const input = store.control.capture({ commandId: `${name}-input`, conversationId: 'qualification', target: repository, text: 'Synthetic direct input to configure this isolated test fixture.' });
      const changes = { 'agents.dev': `dev-${name}`, ...(name === 'limited' ? { 'limits.agentSeconds': 3 } : {}) };
      const proposal = store.control.prepare({ inputId: input.id, requestId: `${name}-proposal`, scope: 'repository', target: repository, changes, reset: [] });
      store.control.apply({ commandId: `${name}-apply`, inputId: input.id, proposalId: proposal.id, hash: proposal.hash, conversationId: 'qualification', target: repository });
    }
  }
  supervisor = openExecutionSupervisor(directory, { store }); for (const identity of identities.values()) supervisor.attach(identity);
  const binding = repository => { const run = store.runtime.status(repository); return { runId: run.id, epoch: run.epoch }; };
  const resource = repository => {
    const db = new DatabaseSync(join(directory, 'execution.sqlite'), { readOnly: true });
    try { const row = db.prepare('SELECT * FROM workers WHERE repository=? ORDER BY epoch DESC LIMIT 1').get(repository); return { ...row, data: JSON.parse(row.document) }; } finally { db.close(); }
  };
  const guest = args => execFileSync('/opt/homebrew/bin/limactl', ['shell', 'engine', '--', ...args],
    { env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: join(directory, 'home'), LIMA_HOME: join(directory, 'lima'), LC_ALL: 'C' }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return {
    directory, store, supervisor, identities, binding, resource, guest,
    async start(name, program) {
      const repository = `R_${name}`, identity = identities.get(repository);
      const reservation = await store.runtime.reserve(identity, { commandId: `${name}-claim`, issue: 1, pipeline: 'development' });
      assert.equal(reservation.run.control, 'running');
      return supervisor.start(identity, binding(repository), { candidate: workspaceCandidate(identity), program, allowedPath: 'effect.txt' });
    },
    async wait(name, predicate, maximum = 10000) {
      const started = performance.now(); let value;
      do { value = await supervisor.refresh(`R_${name}`); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (performance.now() - started < maximum);
      throw new Error(`Qualification state timeout: ${name}`, { cause: { worker: value.worker, error: value.error, control: value.run?.control } });
    },
    async control(name, operation) {
      const repository = `R_${name}`, receipt = supervisor.control(binding(repository), operation); await supervisor.settle(repository);
      return { receipt, status: supervisor.status(repository) };
    },
    async waitRetained(name, expected) {
      for (let count = 0; count < 50; count++) {
        try { if (guest(['cat', `${resource(`R_${name}`).data.manifest.workspace}/retained.txt`]) === expected) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Worker checkpoint timeout: ${name}, expected ${expected}`);
    },
    async close() { await supervisor.shutdown(); store.close(); },
  };
}

export async function qualifyExecutionCore(directory, progress = () => {}) {
  let fixture = openExecutionFixture(directory); const results = []; const check = (name, data = {}) => { results.push({ name, passed: true, ...data }); progress(name); };
  const crashProcess = async (source, expected) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stderr.resume();
    const result = await new Promise((resolve, reject) => { let text=''; child.stdout.on('data',data=>text+=data); child.once('error',reject); child.once('close',(code,signal)=>resolve({code,signal,text})); });
    assert.equal(result.signal, 'SIGKILL'); assert.equal(result.text, expected);
  };
  try {
    const hostCanary = join(directory, 'policy-canary'); writeFileSync(hostCanary, 'SYNTHETIC-PROTECTED-POLICY\n', { mode: 0o600 });
    const boundarySource = `const fs=require('node:fs'),cp=require('node:child_process');const denied=operation=>{try{operation();return false}catch{return true}};const protectedPath=${JSON.stringify(hostCanary)};
      const checks={hostPolicyWrite:denied(()=>fs.writeFileSync(protectedPath,'forged')),hostPolicyRead:denied(()=>fs.readFileSync(protectedPath)),traversal:denied(()=>fs.writeFileSync('/workspace/../policy.sqlite','forged')),rootReadOnly:denied(()=>fs.writeFileSync('/root/forged','forged')),automationAbsent:!fs.existsSync('/usr/bin/osascript'),hostMountAbsent:!fs.existsSync('/Users'),runtimeSocketAbsent:!fs.existsSync('/run/containerd/containerd.sock')&&!fs.existsSync('/var/run/docker.sock'),noCredentials:!Object.keys(process.env).some(k=>/^(GH_|GITHUB_|CODEX_|OPENAI_|OLLAMA_|.*(?:TOKEN|SECRET|PASSWORD|API_KEY))/i.test(k)),networkDenied:cp.spawnSync('wget',['-T','2','-q','-O','/tmp/net','https://example.com'],{timeout:3000}).status!==0};
      fs.symlinkSync(protectedPath,'/workspace/alias');checks.symlink=denied(()=>fs.writeFileSync('/workspace/alias','forged'));checks.hardlink=denied(()=>fs.linkSync(protectedPath,'/workspace/hardlink'));checks.descendant=cp.spawnSync('sh',['-c','printf forged > "$1"','worker',protectedPath]).status!==0;
      fs.writeFileSync('/workspace/package.json',JSON.stringify({name:'fixture',version:'1.0.0',scripts:{postinstall:'sh hook.sh'}}));fs.writeFileSync('/workspace/hook.sh','echo HOOK_RAN >&2; printf forged > '+JSON.stringify(protectedPath)+'\\n');const hook=cp.spawnSync('npm',['install','--offline','--no-audit','--no-fund'],{timeout:8000,encoding:'utf8',env:{...process.env,HOME:'/workspace',npm_config_cache:'/workspace/.npm'}});checks.packageHook=hook.status!==0&&String(hook.stderr).includes('HOOK_RAN');
      checks.memory=fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()==='268435456';checks.pids=fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()==='32';checks.cpu=fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim()==='100000 100000';fs.writeFileSync('/workspace/retained.txt','kept');
      process.stdout.write(JSON.stringify({operation:'workspace.create',commandId:'qualified-effect-'+process.env.PIPELINER_RUN_ID,epoch:Number(process.env.PIPELINER_EPOCH),path:'effect.txt',content:JSON.stringify({checks,unicode:'Your work 🌿 · 工程',node:process.version,git:cp.spawnSync('git',['--version'],{encoding:'utf8'}).stdout.trim()})}));`;
    const program = `node -e ${quote(boundarySource)}`;
    await fixture.start('allowed', program); await fixture.wait('allowed', value => value.worker === 'exited');
    const action = await fixture.supervisor.applyResult(fixture.binding('R_allowed')); assert.equal(action.state, 'verified');
    const output = join(directory, 'repo-allowed', 'effect.txt'), before = readFileSync(output, 'utf8');
    const result = JSON.parse(JSON.parse(before).content); assert.ok(Object.values(result.checks).every(Boolean)); assert.equal(result.unicode, 'Your work 🌿 · 工程');
    assert.equal((await fixture.supervisor.applyResult(fixture.binding('R_allowed'))).id, action.id); assert.equal(readFileSync(output, 'utf8'), before); assert.equal(readFileSync(hostCanary, 'utf8'), 'SYNTHETIC-PROTECTED-POLICY\n');
    assert.equal((await fixture.supervisor.start(fixture.identities.get('R_allowed'), fixture.binding('R_allowed'), { candidate: workspaceCandidate(fixture.identities.get('R_allowed')), program, allowedPath: 'effect.txt' })).created, false);
    const image = fixture.resource('R_allowed').data.manifest.image, nerdctl = fixture.guest(['nerdctl', '--version']);
    await fixture.control('allowed', 'pause'); check('real-boundary-and-one-ledger-effect', { ...result, image, nerdctl, duplicate: true });

    await fixture.start('gentle', gentleProgram); await fixture.waitRetained('gentle', '1'); const old = fixture.binding('R_gentle');
    const pause = await fixture.control('gentle', 'pause'); assert.equal(pause.receipt.verified, false); assert.equal(pause.status.run.control, 'paused');
    await fixture.control('gentle', 'resume'); const fresh = fixture.binding('R_gentle'); assert.equal(fresh.epoch, old.epoch + 1); assert.throws(() => fixture.supervisor.control(old, 'stop'), /epoch/);
    await fixture.wait('gentle', value => value.worker === 'running'); await fixture.waitRetained('gentle', '2');
    await fixture.control('gentle', 'stop'); assert.equal(fixture.store.runtime.status('R_gentle').control, 'stopped'); check('graceful-pause-resume-stop-retained-work', { oldEpoch: old.epoch, newEpoch: fresh.epoch });

    await fixture.start('forced', `trap '' TERM; printf kept >/workspace/retained.txt; sh -c 'trap "" TERM; sleep 1000' & wait`);
    await fixture.waitRetained('forced', 'kept');
    const forcedStart = performance.now(); const forced = await fixture.control('forced', 'stop'); const forcedMilliseconds = Math.round(performance.now() - forcedStart);
    assert.equal(forced.status.run.control, 'stopped'); assert.ok(forcedMilliseconds >= 9500 && forcedMilliseconds < 20000); check('forced-owned-container-and-descendants-stop', { milliseconds: forcedMilliseconds });

    await fixture.start('forged', `printf '%s' '{"operation":"pm-apply","approved":true}'`); await fixture.wait('forged', value => value.worker === 'exited');
    await assert.rejects(fixture.supervisor.applyResult(fixture.binding('R_forged'))); assert.equal(readFileSync(hostCanary, 'utf8'), 'SYNTHETIC-PROTECTED-POLICY\n'); await fixture.control('forged', 'stop'); check('worker-forged-control-denied');

    await fixture.start('failed', gentleProgram); await fixture.waitRetained('failed', '1'); const original = fixture.resource('R_failed');
    const fault = new DatabaseSync(join(directory, 'execution.sqlite')); fault.prepare('UPDATE workers SET cid=? WHERE run_id=? AND epoch=?').run('f'.repeat(64), original.run_id, original.epoch); fault.close();
    const receipt = fixture.supervisor.control(fixture.binding('R_failed'), 'pause'); assert.equal(receipt.verified, false); await assert.rejects(fixture.supervisor.settle('R_failed'), /identity mismatch/); assert.equal(fixture.supervisor.status('R_failed').worker, 'blocked'); assert.equal(fixture.store.runtime.status('R_failed').control, 'pause-requested');
    const repair = new DatabaseSync(join(directory, 'execution.sqlite')); repair.prepare('UPDATE workers SET cid=? WHERE run_id=? AND epoch=?').run(original.cid, original.run_id, original.epoch); repair.close(); await fixture.control('failed', 'stop'); check('failed-termination-stays-unverified-and-retry-cleans');

    await fixture.start('output', `node -e ${quote(`process.stdout.write('x'.repeat(400000));`)}`); await fixture.wait('output', value => value.worker === 'exited');
    let outputRejection;
    await assert.rejects(fixture.supervisor.applyResult(fixture.binding('R_output')), error => { outputRejection = { reason: error.message, cancellation: error.cause?.cancellation ?? null }; return /output limit/.test(error.message); }); const outputResource = fixture.resource('R_output');
    const logConfiguration = JSON.parse(fixture.guest(['nerdctl', 'inspect', '--format', '{{json .HostConfig.LogConfig}}', outputResource.cid])); assert.equal(logConfiguration.opts['max-size'], '64k'); await fixture.control('output', 'stop'); check('output-limit-denies-unbounded-result', outputRejection);

    await fixture.supervisor.prepare(); await fixture.start('limited', gentleProgram); await fixture.wait('limited', value => value.run.control === 'stopped', 15000); check('captured-deadline-stops-execution');
    for (const name of ['allowed', 'gentle', 'forced', 'forged', 'failed', 'output', 'limited']) assert.equal(fixture.store.runtime.status(`R_${name}`).releasedAt, null);
    await fixture.close(); fixture = null;
    const source = `import {openExecutionFixture,gentleProgram} from ${JSON.stringify(import.meta.url)};const f=openExecutionFixture(process.argv[1]);await f.start('crash',gentleProgram);await f.waitRetained('crash','1');process.stdout.write('crash-ready\\n');process.kill(process.pid,'SIGKILL');`;
    await crashProcess(source, 'crash-ready\n');
    fixture = openExecutionFixture(directory); const crashed = fixture.store.runtime.status('R_crash'); assert.equal(crashed.control, 'recovery-required');
    await fixture.control('crash', 'resume'); const recovered = fixture.store.runtime.status('R_crash'); assert.equal(recovered.epoch, crashed.epoch + 1); assert.equal(recovered.id, crashed.id);
    await fixture.wait('crash', value => value.worker === 'running'); await fixture.waitRetained('crash', '2'); await fixture.control('crash', 'stop'); check('actual-host-crash-recovers-owned-worker-and-claim');

    await fixture.close(); fixture = null;
    await crashProcess(`import {openExecutionFixture,gentleProgram} from ${JSON.stringify(import.meta.url)};const f=openExecutionFixture(process.argv[1]);await f.start('crashcancel',gentleProgram);await f.waitRetained('crashcancel','1');process.stdout.write('crash-cancel-ready\\n',()=>process.kill(process.pid,'SIGKILL'));`, 'crash-cancel-ready\n');
    fixture = openExecutionFixture(directory, { repositoryUnavailable: true }); const cancellation = fixture.store.runtime.status('R_crashcancel'); assert.equal(cancellation.control, 'recovery-required');
    await fixture.control('crashcancel', 'stop'); assert.equal(fixture.store.runtime.status('R_crashcancel').control, 'stopped'); assert.equal(fixture.store.runtime.status('R_crashcancel').id, cancellation.id); assert.equal(fixture.store.runtime.status('R_crashcancel').releasedAt, null); check('actual-crash-can-stop-locally-during-provider-outage');
    await fixture.close(); fixture = null;
    const effectProgram = `node -e ${quote(`process.stdout.write(JSON.stringify({operation:'workspace.create',commandId:'crash-effect',epoch:Number(process.env.PIPELINER_EPOCH),path:'effect.txt',content:'Retained exactly once'}));`)}`;
    const effectSource = `import {openExecutionFixture} from ${JSON.stringify(import.meta.url)};const f=openExecutionFixture(process.argv[1],{crashAfterEffect:true});await f.start('crasheffect',${JSON.stringify(effectProgram)});await f.wait('crasheffect',value=>value.worker==='exited');await f.supervisor.applyResult(f.binding('R_crasheffect'));`;
    await crashProcess(effectSource, 'crash-effect-ready\n');
    const retainedEffect = readFileSync(join(directory, 'repo-crasheffect', 'effect.txt'), 'utf8');
    fixture = openExecutionFixture(directory); const uncertain = fixture.store.runtime.status('R_crasheffect'); assert.equal(uncertain.control, 'recovery-required'); assert.equal(uncertain.pendingAction.state, 'dispatched');
    await fixture.control('crasheffect', 'resume'); const effectRecovered = fixture.store.runtime.status('R_crasheffect'); assert.equal(effectRecovered.id, uncertain.id); assert.equal(effectRecovered.epoch, uncertain.epoch + 1); assert.equal(effectRecovered.pendingAction, null);
    await fixture.wait('crasheffect', value => value.worker === 'exited'); await assert.rejects(fixture.supervisor.applyResult(fixture.binding('R_crasheffect')), /Effect command identity conflict/);
    assert.equal(readFileSync(join(directory, 'repo-crasheffect', 'effect.txt'), 'utf8'), retainedEffect);
    const ledger = new DatabaseSync(join(directory, 'fixture-state', 'policy.sqlite'), { readOnly: true });
    try { const actions = ledger.prepare('SELECT state,attempts FROM runtime_actions WHERE run_id=?').all(uncertain.id); assert.deepEqual(actions, [{ state: 'verified', attempts: 1 }].map(value => Object.assign(Object.create(null), value))); } finally { ledger.close(); }
    await fixture.control('crasheffect', 'stop'); assert.equal(fixture.store.runtime.status('R_crasheffect').releasedAt, null); check('actual-crash-after-file-write-reconciles-without-replay');
    return { results, fixture };
  } catch (error) { if (fixture) { try { await fixture.close(); } catch { error.cleanupFailed = true; } } error.partialResults = results; throw error; }
}
