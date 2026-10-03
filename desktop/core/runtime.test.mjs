import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, symlinkSync, readdirSync, lstatSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openPolicyStore } from './policy.mjs';
import { inspectWorkspace } from './identity.mjs';
import { createRuntime, migrateRuntime, transact } from './runtime.mjs';

const repository = 'R_fixture';
const remote = { repository, owner: 'PipelinerFixtures', name: 'qualification' };
const hash = 'a'.repeat(64);
const candidate = { sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
const catalog = () => ({ repositories: [repository], capabilities: ['workspace.read', 'workspace.write', 'worker.exec', 'github.pr.write'], maxConcurrency: 1, background: false,
  connections: [{ id: 'codex-fixture', provider: 'codex', repositories: [repository] }], developers: [{ id: 'dev-fixture', connection: 'codex-fixture', metrics: [] }], extensions: [] });
function fixture(t, extraCatalog = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-d08-'))), directory = join(root, 'state'), checkout = join(root, 'repository');
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(checkout);
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-C', checkout, ...args], { env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  git(['init', '--initial-branch=main']); writeFileSync(join(checkout, 'fixture.txt'), 'Synthetic owned fixture.\n'); git(['add', 'fixture.txt']);
  git(['-c', 'user.name=Pipeliner Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  git(['remote', 'add', 'origin', 'https://github.com/PipelinerFixtures/qualification.git']);
  let now = 1000, status = 'In Progress', state = 'OPEN', active = [{ issue: 1, status }], worker = 'stopped', observations = new Map(), integration;
  const inspectors = {
    async repository({ repository: id, issue }) { return { repository: id, issue, status, state, active, ...(integration ? { integration } : {}), observedAt: now }; },
    async worker({ runId, epoch }) { return { runId, epoch, state: worker, observedAt: now }; },
    async effect(action) { const result = observations.get(action.id); if (!result) throw new Error('Readback unavailable'); const keys = ['runId', 'repository', 'issue', 'step', 'epoch', 'operation', 'candidate', 'commandId', 'requestHash', 'preconditionsHash', 'expectedHash', 'fingerprint', 'attempts', 'dispatchEpoch']; return { ...Object.fromEntries(keys.map(key => [key, action[key]])), ...result, observationHash: hash, observedAt: now }; },
  };
  const facts = () => ({ ...catalog(), ...extraCatalog });
  const stores = [], open = () => { const store = openPolicyStore(directory, { catalog: facts, clock: () => now, inspectors }); stores.push(store); return store; };
  const store = open(); let command = 0;
  const configure = (changes, scope = 'repository', target = repository) => {
    const input = store.control.capture({ commandId: `input-${++command}`, conversationId: 'fixture-chat', target, text: 'Configure synthetic fixture.' });
    const p = store.control.prepare({ inputId: input.id, requestId: `proposal-${command}`, scope, target, changes, reset: [] });
    return store.control.apply({ commandId: `apply-${command}`, proposalId: p.id, hash: p.hash, inputId: p.inputId, conversationId: p.conversationId, target: p.target });
  };
  configure({ 'agents.dev': 'dev-fixture' });
  t.after(() => { for (const s of stores) s.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); });
  const identity = inspectWorkspace(checkout, remote);
  const reserve = (s = store, commandId = 'claim-one', issue = 1, workspace = identity) => s.runtime.reserve(workspace, { commandId, issue, pipeline: 'development' });
  const intent = (binding, extra = {}, s = store) => s.runtime.intent(binding, { commandId: 'write-one', step: 'implement', operation: 'workspace.write', candidate, requestHash: hash, preconditionsHash: hash, expectedHash: hash, ...extra });
  return { store, open, root, directory, checkout, git, identity, reserve, intent, configure, inspectors, catalog: facts, observe: (id, result) => observations.set(id, result),
    advance: ms => { now += ms; }, setWorker: value => { worker = value; }, setIntegration: value => { integration = value; }, setStatus: (value, issues = [{ issue: 1, status: value }], issueState = 'OPEN') => { status = value; active = issues; state = issueState; } };
}
const binding = run => ({ runId: run.id, epoch: run.epoch });

test('ordered takeover requires stopped continuity, keeps one reservation and fences the old Dev', async t => {
  const f = fixture(t, { developers: [...catalog().developers, { id: 'dev-two', connection: 'codex-fixture', metrics: [] }] });
  f.configure({ 'agents.fallbacks': ['dev-two'], 'agents.takeover': true });
  const run = (await f.reserve()).run, b = binding(run);
  f.inspectors.continuity = async value => ({ ...value, verified: true, observedAt: 1000 });
  f.setWorker('running'); await assert.rejects(f.store.runtime.takeover(b, { dev: 'dev-two', candidate }), /stopped/i);
  f.setWorker('stopped'); f.store.runtime.requestControl(b, 'pause'); await f.store.runtime.verifyControl(b);
  f.setWorker('running'); await assert.rejects(f.store.runtime.takeover(b, { dev: 'dev-two', candidate }), /stopped/i); f.setWorker('stopped');
  await assert.rejects(f.store.runtime.takeover(b, { dev: 'unconfigured', candidate }), /configured|ordered/);
  f.inspectors.continuity = async value => ({ ...value, candidate: { ...candidate, gitTree: 'f'.repeat(40) }, verified: true, observedAt: 1000 });
  await assert.rejects(f.store.runtime.takeover(b, { dev: 'dev-two', candidate }), /continuity/);
  f.inspectors.continuity = async value => ({ ...value, verified: true, observedAt: 1000 });
  const next = await f.store.runtime.takeover(b, { dev: 'dev-two', candidate });
  assert.equal(next.id, run.id); assert.equal(next.issue, run.issue); assert.equal(next.policyHash, run.policyHash); assert.deepEqual(next.limits, run.limits);
  assert.equal(next.dev, 'dev-two'); assert.equal(next.epoch, run.epoch + 1); assert.equal(next.control, 'paused');
  assert.throws(() => f.intent(b), /epoch/);
  const reopened = f.open(); assert.equal(reopened.runtime.status(repository).dev, 'dev-two');
  const db = new DatabaseSync(join(f.directory, 'policy.sqlite'));
  try { assert.throws(() => db.exec('UPDATE runtime_assignments SET hash=hash'), /immutable/i);
    assert.throws(() => db.exec('DELETE FROM runtime_assignments'), /immutable/i); }
  finally { db.close(); }
  const resumed = await reopened.runtime.resume(binding(next)); assert.equal(resumed.dev, 'dev-two');
  f.configure({ 'agents.takeover': false }); assert.throws(() => f.intent(binding(resumed), {}, reopened), /authority|revoked/);
});

test('aliases, worktrees and duplicate clients share one durable repository claim', async t => {
  const f = fixture(t), alias = join(f.root, 'alias'), worktree = join(f.root, 'worktree'); symlinkSync(f.checkout, alias); f.git(['worktree', 'add', '--detach', worktree]);
  const first = await f.reserve(); assert.equal(first.created, true); assert.equal(first.run.dev, 'dev-fixture'); assert.equal(first.run.policyRevision, 1);
  const second = f.open();
  for (const path of [alias, worktree]) { const result = await f.reserve(second, `alias-${path === alias ? 'one' : 'two'}`, 1, inspectWorkspace(path, remote)); assert.equal(result.created, false); assert.equal(result.run.id, first.run.id); assert.equal(result.run.epoch, first.run.epoch); }
  assert.equal(second.runtime.status(repository).control, 'recovery-required');
  assert.throws(() => f.intent(binding(first.run), {}, second), /session|recovery/i);
  await assert.rejects(f.reserve(f.store, 'conflict', 2), /reserved|active/i);
  await assert.rejects(f.reserve(f.store, 'claim-one', 2), /conflict|active/i);
  await assert.rejects(f.reserve(f.store, 'fake', 1, { ...f.identity }), /identity/i);
});

test('three active statuses preserve ownership; inaccessible or conflicting readback has no effect', async t => {
  const f = fixture(t), first = await f.reserve();
  for (const status of ['In Progress', 'In Review', 'Pending Review']) { f.setStatus(status); assert.equal((await f.reserve(f.store, `status-${status.replaceAll(' ', '-')}`)).run.id, first.run.id); }
  f.setStatus('In Progress', [{ issue: 2, status: 'In Progress' }]); await assert.rejects(f.reserve(), /active|conflict/i);
  assert.equal(f.store.runtime.status(repository).id, first.run.id);
  f.inspectors.repository = async () => { throw new Error('Access denied'); }; await assert.rejects(f.reserve(), /denied/i);
  assert.equal(f.store.runtime.status(repository).epoch, first.run.epoch);
});

test('a policy change during reservation readback cannot create an unreviewed claim', async t => {
  const f = fixture(t), expected = f.store.worker.read(repository).hash, observe = f.inspectors.repository;
  f.inspectors.repository = async request => { f.configure({ 'limits.stepTurns': 21 }); return observe(request); };
  await assert.rejects(f.store.runtime.reserve(f.identity, { commandId: 'reviewed-claim', issue: 1, pipeline: 'development', policyHash: expected }), /configuration changed/);
  assert.equal(f.store.runtime.status(repository), null);
});

test('intent precedes dispatch; lost responses block replay and require exact readback', async t => {
  const f = fixture(t), run = (await f.reserve()).run, b = binding(run), action = f.intent(b);
  assert.equal(action.state, 'prepared'); assert.equal(f.store.runtime.dispatch(b, action.id).dispatched, true);
  assert.equal(f.store.runtime.dispatch(b, action.id).dispatched, false);
  assert.throws(() => f.intent(b, { commandId: 'another-write' }), /uncertain|pending/i);
  assert.throws(() => f.intent(b, { requestHash: 'd'.repeat(64) }), /conflict/i);
  await assert.rejects(f.store.runtime.reconcile(b, action.id), /unavailable/i);
  f.observe(action.id, { result: 'present', resultHash: 'e'.repeat(64) }); await assert.rejects(f.store.runtime.reconcile(b, action.id), /expected|readback/i);
  f.observe(action.id, { result: 'present', resultHash: hash }); assert.equal((await f.store.runtime.reconcile(b, action.id)).state, 'verified');
  assert.equal(f.intent(b).id, action.id); assert.equal(f.store.runtime.dispatch(b, action.id).dispatched, false);
});

test('restart preserves claims and uncertainty; verified recovery advances epoch and fences old input', async t => {
  const f = fixture(t), run = (await f.reserve()).run, b = binding(run), action = f.intent(b); f.store.runtime.dispatch(b, action.id); f.store.close();
  const reopened = f.open(); assert.equal(reopened.runtime.status(repository).control, 'recovery-required');
  await assert.rejects(reopened.runtime.resume(b), /uncertain|pending/i);
  f.observe(action.id, { result: 'present', resultHash: hash }); await reopened.runtime.reconcile(b, action.id);
  f.setWorker('running'); await assert.rejects(reopened.runtime.resume(b), /worker|stopped/i);
  f.setWorker('stopped'); const resumed = await reopened.runtime.resume(b); assert.equal(resumed.epoch, run.epoch + 1); assert.equal(resumed.policyRevision, run.policyRevision);
  assert.throws(() => f.intent(b, {}, reopened), /epoch/i);
  assert.equal(f.intent(binding(resumed), { commandId: 'after-recovery' }, reopened).epoch, resumed.epoch);
});

test('origin mismatch, credentials and changed filesystem binding cannot adopt state', async t => {
  const f = fixture(t);
  for (const url of ['https://synthetic:password@github.com/PipelinerFixtures/qualification.git', 'https://github.com/PipelinerFixtures/different.git', 'https://github.com/PipelinerFixtures/qualification.git?token=synthetic', 'https://example.invalid/PipelinerFixtures/qualification.git']) {
    f.git(['config', 'remote.origin.url', url]); assert.throws(() => inspectWorkspace(f.checkout, remote), /origin|mismatch/i); assert.equal(f.store.runtime.status(repository), null);
    await assert.rejects(f.reserve(), /origin|mismatch/i);
  }
  f.git(['config', 'remote.origin.url', 'git@github.com:PipelinerFixtures/qualification.git']); const first = await f.reserve(f.store, 'ssh-origin', 1, inspectWorkspace(f.checkout, remote));
  f.git(['config', 'remote.origin.pushurl', 'https://github.com/PipelinerFixtures/different.git']); assert.throws(() => inspectWorkspace(f.checkout, remote), /mismatch/i);
  f.git(['config', '--unset', 'remote.origin.pushurl']);
  const clone = join(f.root, 'clone'); f.git(['clone', '--no-hardlinks', f.checkout, clone]);
  execFileSync('/usr/bin/git', ['-C', clone, 'remote', 'set-url', 'origin', 'https://github.com/PipelinerFixtures/qualification.git']);
  assert.equal((await f.reserve(f.store, 'clone-origin', 1, inspectWorkspace(clone, remote))).run.id, first.run.id);
  assert.equal(f.store.worker.runtime, undefined); assert.equal(f.store.worker.reserve, undefined);
  renameSync(join(f.checkout, '.git'), join(f.checkout, '.git-retained')); f.git(['init', '--initial-branch=main']); f.git(['remote', 'add', 'origin', 'https://github.com/PipelinerFixtures/qualification.git']);
  await assert.rejects(f.reserve(), /filesystem identity/i);
  await assert.rejects(f.reserve(f.store, 'reused-path', 1, inspectWorkspace(f.checkout, remote)), /filesystem identity/i);
  assert.equal(f.store.runtime.status(repository).id, first.run.id);
});

test('verified absence permits bounded original retries; denial, permanent failure, expiry and revocation deny dispatch', async t => {
  const f = fixture(t), run = (await f.reserve()).run, b = binding(run), action = f.intent(b);
  f.configure({ 'limits.transientAttempts': 1 }); assert.equal(f.open().runtime.status(repository).limits['limits.transientAttempts'], 3);
  f.observe(action.id, { result: 'absent', resultHash: null });
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(f.store.runtime.dispatch(b, action.id).action.attempts, attempt); await f.store.runtime.reconcile(b, action.id);
    if (attempt < 3) await f.store.runtime.retry(b, action.id);
  }
  await assert.rejects(f.store.runtime.retry(b, action.id), /attempts/i);
  for (const result of ['denied', 'permanent']) {
    const denied = f.intent(b, { commandId: `failure-${result}` }); f.store.runtime.dispatch(b, denied.id); f.observe(denied.id, { result, resultHash: null }); await f.store.runtime.reconcile(b, denied.id);
    await assert.rejects(f.store.runtime.retry(b, denied.id), /denial|permanent/i);
  }
  const expired = f.intent(b, { commandId: 'expires' }); f.advance(1800000); assert.throws(() => f.store.runtime.dispatch(b, expired.id), /deadline/i);
  f.store.runtime.requestControl(b, 'pause'); await f.store.runtime.verifyControl(b); const resumed = await f.store.runtime.resume(b);
  const revoked = f.intent(binding(resumed), { commandId: 'revoked' }); f.configure({ 'permissions.grants': ['workspace.read'] });
  assert.throws(() => f.store.runtime.dispatch(binding(resumed), revoked.id), /revoked|authority/i);
});

test('Pause and Stop distinguish received from verified, retain claims and require inactive readback to release', async t => {
  const f = fixture(t), run = (await f.reserve()).run, b = binding(run); f.intent(b);
  assert.deepEqual(f.store.runtime.requestControl(b, 'pause'), { received: true, verified: false, requested: 'pause' });
  f.setWorker('running'); await assert.rejects(f.store.runtime.verifyControl(b), /stopped/i);
  assert.equal(f.store.runtime.status(repository).control, 'pause-requested'); assert.throws(() => f.intent(b, { commandId: 'paused-write' }), /paused/i);
  f.setWorker('stopped'); const paused = await f.store.runtime.verifyControl(b); assert.equal(paused.verified, true); assert.equal(paused.run.control, 'paused');
  const second = f.open(); assert.equal(second.runtime.status(repository).control, 'paused');
  await assert.rejects(second.runtime.release(b), /inactive/i);
  f.setStatus('Done', [], 'CLOSED'); await assert.rejects(second.runtime.release(b), /integration/i);
  f.setStatus('On Hold', []); const released = await second.runtime.release(b); assert.equal(released.status, 'On Hold'); assert.equal(f.store.runtime.status(repository), null);
  f.setStatus('In Progress'); const next = (await f.reserve(f.store, 'fresh-reservation')).run; assert.notEqual(next.id, run.id); assert.equal(next.epoch, run.epoch + 1);
});

test('recovered host can Stop locally without provider access or dispatch authority', async t => {
  const f = fixture(t), run = (await f.reserve()).run, b = binding(run); f.store.close();
  const recovered = f.open(); assert.equal(recovered.runtime.status(repository).control, 'recovery-required');
  let providerCalls = 0; f.inspectors.repository = async () => { providerCalls++; throw new Error('Provider unavailable'); };
  assert.deepEqual(recovered.runtime.requestControl(b, 'stop'), { received: true, verified: false, requested: 'stop' });
  f.setWorker('running'); await assert.rejects(recovered.runtime.verifyControl(b), /stopped/i);
  assert.throws(() => f.intent(b, {}, recovered), /session|recovery|stopped/i);
  f.setWorker('stopped'); const stopped = await recovered.runtime.verifyControl(b);
  assert.equal(stopped.run.control, 'stopped'); assert.equal(stopped.run.id, run.id); assert.equal(stopped.run.epoch, run.epoch); assert.equal(stopped.run.releasedAt, null); assert.equal(providerCalls, 0);
});

test('two real host processes race one reservation without creating another epoch', async t => {
  const f = fixture(t); const children = [];
  const program = `import { openPolicyStore } from ${JSON.stringify(new URL('./policy.mjs', import.meta.url).href)};
    import { inspectWorkspace } from ${JSON.stringify(new URL('./identity.mjs', import.meta.url).href)};
    const store = openPolicyStore(process.argv[1], {catalog: () => JSON.parse(process.argv[3]), clock: () => 1000,
      inspectors: {repository: async ({repository,issue}) => ({repository,issue,status:'In Progress',state:'OPEN',active:[{issue:1,status:'In Progress'}],observedAt:1000})}});
    const identity = inspectWorkspace(process.argv[2], JSON.parse(process.argv[4])); process.stdout.write('READY\\n');
    process.stdin.once('data', async () => { try { const result=await store.runtime.reserve(identity,{commandId:process.argv[5],issue:1,pipeline:'development'}); process.stdout.write(JSON.stringify(result)+'\\n'); } catch { process.exitCode=1; } finally {store.close();process.stdin.destroy();} });`;
  const clients = ['process-one', 'process-two'].map(command => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.directory, f.checkout, JSON.stringify(catalog()), JSON.stringify(remote), command], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let text = '', errors = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const ready = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Fixture startup timeout')), 10000); child.stdout.on('data', () => { if (text.includes('READY\n')) { clearTimeout(timer); resolve(); } }); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', () => { clearTimeout(timer); if (!text.includes('READY\n')) reject(new Error('Fixture exited before ready')); }); });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { try { assert.equal(code, 0, errors); resolve(JSON.parse(text.split('\n').find(line => line.startsWith('{')))); } catch (error) { reject(error); } }); });
    done.catch(() => {});
    return { child, ready, done };
  });
  try {
    await Promise.all(clients.map(c => c.ready)); for (const c of clients) c.child.stdin.end('claim');
    const results = await Promise.all(clients.map(c => c.done)); assert.equal(results.filter(r => r.created).length, 1); assert.equal(results[0].run.id, results[1].run.id); assert.equal(results[0].run.epoch, 1); assert.equal(results[1].run.epoch, 1);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000); await closed; clearTimeout(force);
    }
    await Promise.allSettled(clients.map(c => c.done));
  }
});

function legacy(f) {
  f.store.close(); const db = new DatabaseSync(join(f.directory, 'policy.sqlite'));
  db.exec('DROP TABLE runtime_assignments; DROP TABLE runtime_actions; DROP TABLE runtime_commands; DROP TABLE runtime_runs; DROP TABLE runtime_workspaces; DROP TABLE runtime_repositories; DROP TABLE runtime_clock; PRAGMA user_version=1;'); db.close();
}

test('schema-1 migration keeps an independently readable private compatible backup', t => {
  const f = fixture(t); f.configure({ 'scheduling.intervalMinutes': 45 }); legacy(f); const reopened = f.open();
  assert.equal(reopened.worker.read(repository).revision, 2); assert.equal(reopened.worker.read(repository, 1).values['scheduling.intervalMinutes'].value, 30);
  const backups = readdirSync(f.directory).filter(name => /^policy-v1-.*\.sqlite$/.test(name)); assert.equal(backups.length, 1);
  const path = join(f.directory, backups[0]), backup = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(backup.prepare('SELECT MAX(revision) AS n FROM policy_versions').get().n, 2); assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.equal(lstatSync(path).mode & 0o777, 0o600); }
  finally { backup.close(); }
  const restored = join(f.root, 'restored'); mkdirSync(restored, { mode: 0o700 }); copyFileSync(path, join(restored, 'policy.sqlite'));
  const recovery = openPolicyStore(restored, { catalog }); try { assert.equal(recovery.worker.read(repository).revision, 2); assert.equal(recovery.worker.read(repository, 1).values['scheduling.intervalMinutes'].value, 30); } finally { recovery.close(); }
  f.open(); assert.equal(readdirSync(f.directory).filter(name => /^policy-v1-.*\.sqlite$/.test(name)).length, 1);
});

test('schema-2 upgrade preserves its claim and an independently readable private backup', async t => {
  const f = fixture(t), run = (await f.reserve()).run;
  f.store.close(); const db = new DatabaseSync(join(f.directory, 'policy.sqlite'));
  db.exec('DROP TABLE runtime_assignments; PRAGMA user_version=2;'); db.close();
  const reopened = f.open(), current = reopened.runtime.status(repository);
  assert.equal(current.id, run.id); assert.equal(current.policyHash, run.policyHash); assert.equal(current.epoch, run.epoch);
  assert.deepEqual(current.limits, run.limits); assert.equal(current.control, 'recovery-required');
  const backups = readdirSync(f.directory).filter(name => /^policy-v2-.*\.sqlite$/.test(name)); assert.equal(backups.length, 1);
  const path = join(f.directory, backups[0]), backup = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(backup.prepare('SELECT id FROM runtime_runs').get().id, run.id);
    assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.equal(lstatSync(path).mode & 0o777, 0o600); }
  finally { backup.close(); }
});

test('interrupted migration rolls back DDL; writer contention and actual SQLite FULL preserve claims', async t => {
  const f = fixture(t); legacy(f); const path = join(f.directory, 'policy.sqlite'), db = new DatabaseSync(path), original = db.exec.bind(db);
  db.exec = sql => { original(sql); if (sql.includes('CREATE TABLE runtime_repositories')) throw new Error('Injected failure after migration DDL'); };
  assert.throws(() => migrateRuntime(db, f.directory, fn => transact(db, fn), false), /after migration/i);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='runtime_runs'").get().n, 0); assert.equal(db.prepare('SELECT MAX(revision) AS n FROM policy_versions').get().n, 1);
  db.exec = original; db.close(); const reopened = f.open(), run = (await f.reserve(reopened)).run;
  const writer = new DatabaseSync(path); writer.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => reopened.runtime.intent(binding(run), { commandId: 'contended', step: 'implement', operation: 'workspace.write', candidate, requestHash: hash, preconditionsHash: hash, expectedHash: hash }), /locked|busy/i); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
  const limited = new DatabaseSync(path); limited.exec('CREATE TABLE full_fixture(data BLOB); CREATE TRIGGER full_action BEFORE INSERT ON runtime_actions BEGIN INSERT INTO full_fixture VALUES(zeroblob(1048576)); END;');
  const pages = limited.prepare('PRAGMA page_count').get().page_count; limited.exec(`PRAGMA max_page_count=${pages + 1}`);
  const runtime = createRuntime(limited, { transaction: fn => transact(limited, fn), policy: reopened.worker, clock: () => 1000, inspectors: f.inspectors });
  try {
    const recovering = runtime.status(repository); const resumed = await runtime.resume(binding(recovering));
    assert.throws(() => runtime.intent(binding(resumed), { commandId: 'disk-full', step: 'implement', operation: 'workspace.write', candidate, requestHash: hash, preconditionsHash: hash, expectedHash: hash }), /full/i);
    assert.equal(limited.isTransaction, false); assert.equal(limited.prepare('SELECT COUNT(*) AS n FROM runtime_actions').get().n, 0); assert.equal(runtime.status(repository).id, run.id); assert.equal(reopened.worker.read(repository).revision, 1);
    limited.exec(`PRAGMA max_page_count=${pages + 100}; DROP TRIGGER full_action;`);
    const action = runtime.intent(binding(resumed), { commandId: 'dispatch-full', step: 'implement', operation: 'workspace.write', candidate, requestHash: hash, preconditionsHash: hash, expectedHash: hash });
    limited.exec('CREATE TRIGGER full_dispatch BEFORE UPDATE OF state ON runtime_actions BEGIN INSERT INTO full_fixture VALUES(zeroblob(1048576)); END;');
    limited.exec(`PRAGMA max_page_count=${limited.prepare('PRAGMA page_count').get().page_count + 1}`);
    assert.throws(() => runtime.dispatch(binding(resumed), action.id), /full/i); assert.equal(limited.isTransaction, false);
    assert.equal(runtime.status(repository).pendingAction.state, 'prepared'); assert.equal(runtime.status(repository).pendingAction.attempts, 0);
  } finally { limited.close(); }
});

test('abrupt exits around an actual owned file effect preserve one effect or verified absence', async t => {
  for (const phase of ['before-intent', 'after-intent', 'after-dispatch', 'after-effect', 'after-readback']) await t.test(phase, async sub => {
    const f = fixture(sub), output = join(f.root, 'owned-effect.txt'), content = 'Synthetic D08 effect\n', expectedHash = createHash('sha256').update(content).digest('hex');
    const program = `import { openPolicyStore } from ${JSON.stringify(new URL('./policy.mjs', import.meta.url).href)};
      import { inspectWorkspace } from ${JSON.stringify(new URL('./identity.mjs', import.meta.url).href)};
      import { writeFileSync,readFileSync,existsSync } from 'node:fs'; import {createHash} from 'node:crypto';
      const store = openPolicyStore(process.argv[1],{catalog:()=>JSON.parse(process.argv[3]),clock:()=>1000,inspectors:{repository:async({repository,issue})=>({repository,issue,status:'In Progress',state:'OPEN',active:[{issue:1,status:'In Progress'}],observedAt:1000}),
        effect:async action=>{const keys=['runId','repository','issue','step','epoch','operation','candidate','commandId','requestHash','preconditionsHash','expectedHash','fingerprint','attempts','dispatchEpoch'];const resultHash=existsSync(process.argv[6])?createHash('sha256').update(readFileSync(process.argv[6])).digest('hex'):null;return {...Object.fromEntries(keys.map(k=>[k,action[k]])),result:resultHash===process.argv[7]?'present':'unknown',resultHash:resultHash===process.argv[7]?resultHash:null,observationHash:process.argv[7],observedAt:1000};}}});
      const run=(await store.runtime.reserve(inspectWorkspace(process.argv[2],JSON.parse(process.argv[4])),{commandId:'crash-claim',issue:1,pipeline:'development'})).run,binding={runId:run.id,epoch:run.epoch};
      if(process.argv[5]==='before-intent')process.exit(73);
      const action=store.runtime.intent(binding,{commandId:'crash-write',step:'implement',operation:'workspace.write',candidate:JSON.parse(process.argv[8]),requestHash:process.argv[7],preconditionsHash:process.argv[7],expectedHash:process.argv[7]});
      if(process.argv[5]==='after-intent')process.exit(73);
      store.runtime.dispatch(binding,action.id);if(process.argv[5]==='after-dispatch')process.exit(73);
      writeFileSync(process.argv[6],'Synthetic D08 effect\\n',{flag:'wx'});if(process.argv[5]==='after-effect')process.exit(73);
      await store.runtime.reconcile(binding,action.id);process.exit(73);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.directory, f.checkout, JSON.stringify(catalog()), JSON.stringify(remote), phase, output, expectedHash, JSON.stringify(candidate)], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 73, child.stderr); assert.equal(child.signal, null);
    const reopened = f.open(), run = reopened.runtime.status(repository); assert.equal(run.control, 'recovery-required'); assert.equal(run.policyRevision, 1);
    if (['after-dispatch', 'after-effect'].includes(phase)) {
      const action = run.pendingAction; assert.equal(action.state, 'dispatched');
      assert.throws(() => f.intent(binding(run), { commandId: 'blind-replay' }, reopened), /session|recovery/i);
      const present = existsSync(output); if (present) assert.equal(readFileSync(output, 'utf8'), content);
      f.observe(action.id, { result: present ? 'present' : 'absent', resultHash: present ? createHash('sha256').update(readFileSync(output)).digest('hex') : null });
      assert.equal((await reopened.runtime.reconcile(binding(run), action.id)).state, present ? 'verified' : 'absent');
    }
    await reopened.runtime.resume(binding(run));
    assert.equal(existsSync(output), ['after-effect', 'after-readback'].includes(phase));
    if (existsSync(output)) assert.equal(readFileSync(output, 'utf8'), content);
  });
});

test('completion requires verified integration at its captured step and no pending effect', async t => {
  const f = fixture(t); f.configure({ 'permissions.ceiling': ['workspace.read', 'workspace.write', 'worker.exec', 'github.pr.write'] }, 'host', null);
  f.configure({ 'permissions.grants': ['workspace.read', 'workspace.write', 'worker.exec', 'github.pr.write'] });
  const run = (await f.reserve()).run, b = binding(run);
  assert.throws(() => f.intent(b, { commandId: 'pr-grant-is-not-push', operation: 'git.push' }), /authority/i);
  assert.throws(() => f.intent(b, { commandId: 'wrong-merge', operation: 'github.pr.merge' }), /step/i);
  const merge = f.intent(b, { commandId: 'merge-once', step: 'integrate', operation: 'github.pr.merge' }); f.store.runtime.dispatch(b, merge.id);
  f.observe(merge.id, { result: 'present', resultHash: hash }); await f.store.runtime.reconcile(b, merge.id);
  f.store.runtime.requestControl(b, 'stop'); await f.store.runtime.verifyControl(b); f.setStatus('Done', [], 'CLOSED');
  f.setIntegration({ candidate: { ...candidate, gitTree: 'e'.repeat(40) }, resultHash: hash }); await assert.rejects(f.store.runtime.release(b), /integration/i);
  f.setIntegration({ candidate, resultHash: hash });
  const done = await f.store.runtime.release(b); assert.equal(done.control, 'complete'); assert.equal(done.status, 'Done'); assert.equal(f.store.runtime.status(repository), null);
});

test('recovery retries the original absent effect with a new dispatch epoch and retained attempts', async t => {
  const f = fixture(t), run = (await f.reserve()).run, b = binding(run), action = f.intent(b); f.store.runtime.dispatch(b, action.id);
  f.store.close(); const reopened = f.open(); f.observe(action.id, { result: 'absent', resultHash: null }); await reopened.runtime.reconcile(b, action.id);
  const resumed = await reopened.runtime.resume(b), current = binding(resumed); await reopened.runtime.retry(current, action.id);
  const next = reopened.runtime.dispatch(current, action.id); assert.equal(next.dispatched, true); assert.equal(next.action.attempts, 2); assert.equal(next.action.epoch, 1); assert.equal(next.action.dispatchEpoch, 2);
  f.observe(action.id, { result: 'absent', resultHash: null, attempts: 1, dispatchEpoch: 1 }); await assert.rejects(reopened.runtime.reconcile(current, action.id), /bound effect/i);
  f.observe(action.id, { result: 'present', resultHash: hash }); assert.equal((await reopened.runtime.reconcile(current, action.id)).state, 'verified');
});

test('untrusted fields, stale or wrong-target readback and clock regression cannot authorize an effect', async t => {
  const f = fixture(t), run = (await f.reserve()).run, b = binding(run);
  for (const extra of [{ role: 'pm' }, { verified: true }, { token: 'synthetic' }, { requestHash: null }]) assert.throws(() => f.intent(b, extra));
  const action = f.intent(b); f.advance(1000); f.store.runtime.dispatch(b, action.id);
  f.observe(action.id, { result: 'present', resultHash: hash, issue: 2 }); await assert.rejects(f.store.runtime.reconcile(b, action.id), /bound effect/i);
  f.observe(action.id, { result: 'unknown', resultHash: null }); assert.equal((await f.store.runtime.reconcile(b, action.id)).state, 'uncertain');
  const inspect = f.inspectors.effect; f.advance(30001); f.inspectors.effect = async action => ({ ...await inspect(action), observedAt: 1000 });
  await assert.rejects(f.store.runtime.reconcile(b, action.id), /stale/i); assert.equal(f.store.runtime.status(repository).pendingAction.state, 'uncertain');
  f.inspectors.effect = inspect; f.observe(action.id, { result: 'present', resultHash: hash }); await f.store.runtime.reconcile(b, action.id);
  const prepared = f.intent(b, { commandId: 'regression' }); f.advance(-1000); assert.throws(() => f.store.runtime.dispatch(b, prepared.id), /clock moved backwards/i);
  assert.equal(f.store.runtime.status(repository).pendingAction.attempts, 0);
});

test('a source change after verified integration cannot use the old merge as completion evidence', async t => {
  const f = fixture(t); f.configure({ 'permissions.ceiling': ['workspace.read', 'workspace.write', 'worker.exec', 'github.pr.write'] }, 'host', null); f.configure({ 'permissions.grants': ['workspace.read', 'workspace.write', 'worker.exec', 'github.pr.write'] });
  const run = (await f.reserve()).run, b = binding(run), merge = f.intent(b, { commandId: 'old-merge', step: 'integrate', operation: 'github.pr.merge' });
  f.store.runtime.dispatch(b, merge.id); f.observe(merge.id, { result: 'present', resultHash: hash }); await f.store.runtime.reconcile(b, merge.id);
  const change = f.intent(b, { commandId: 'new-change', candidate: { ...candidate, sourceCommit: 'e'.repeat(40) } }); f.store.runtime.dispatch(b, change.id); f.observe(change.id, { result: 'present', resultHash: hash }); await f.store.runtime.reconcile(b, change.id);
  f.store.runtime.requestControl(b, 'stop'); await f.store.runtime.verifyControl(b); f.setStatus('Done', [], 'CLOSED'); await assert.rejects(f.store.runtime.release(b), /integration/i);
  assert.equal(f.store.runtime.status(repository).id, run.id);
});
