import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openTestVault } from '../connections/test-vault.mjs';
import * as workspace from '../repositories/store.mjs';
import * as development from '../development/state.mjs';
import { canonicalJSON, developmentTemplate } from './settings.mjs';
import { captureRecoveryDatabase, protectedFile } from './storage.mjs';
import * as policy from './policy.mjs';
import * as execution from './execution.mjs';

test('cold record inspection authenticates pending work on private copies without opening writable stores', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-cold-records-'))), scratch = join(root, 'scratch');
  mkdirSync(scratch, { mode: 0o700 }); const vault = await openTestVault(root);
  let store, db, capture;
  const snapshot = name => {
    const path = join(root, name), stat = lstatSync(path, { bigint: true });
    return { bytes: readFileSync(path), identity: ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => stat[key].toString()) };
  };
  const inspect = (name, read) => {
    const before = snapshot(name);
    try {
      capture = captureRecoveryDatabase(root, name, { scratch, checkpoint() {}, read: db => read(db, { vault }) });
      return capture.value;
    } finally { capture?.close(); capture = undefined; assert.deepEqual(snapshot(name), before); assert.deepEqual(readdirSync(scratch), []); }
  };
  try {
    assert.equal(typeof workspace.inspectWorkspaceRecovery, 'function'); assert.equal(typeof development.inspectDevelopmentRecovery, 'function');
    store = workspace.openWorkspaceStore(root, { vault }); store.close(); store = undefined;
    assert.deepEqual(inspect('workspaces.sqlite', workspace.inspectWorkspaceRecovery), { uncertainEffects: 0, pendingSchedules: 0 });
    store = workspace.openWorkspaceStore(root, { vault });
    store.register({ id: 'repo', repositoryId: 'remote', slug: 'fixture/repo', localKey: '1:2', path: '/synthetic-repository', project: { id: 'project' } });
    store.saveSchedule('repo', { pending: { id: 'scheduled' } });
    const effect = store.prepare('job', 'step', { repository: 'repo', kind: 'setup' }); store.dispatch(effect.id); store.close(); store = undefined;
    assert.deepEqual(inspect('workspaces.sqlite', workspace.inspectWorkspaceRecovery), { uncertainEffects: 1, pendingSchedules: 1 });
    db = new DatabaseSync(join(root, 'workspaces.sqlite')); db.exec("UPDATE setup_effects SET state='verified'"); db.close(); db = undefined;
    assert.throws(() => inspect('workspaces.sqlite', workspace.inspectWorkspaceRecovery), /protected-record/);

    store = development.openDevelopmentStore(root, { vault }); store.close(); store = undefined;
    assert.deepEqual(inspect('development.sqlite', development.inspectDevelopmentRecovery), { uncertainEffects: 0 });
    store = development.openDevelopmentStore(root, { vault });
    const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
    const run = { id: 'run', repository: 'repo', issue: 1, dev: 'dev', epoch: 1, policyRevision: 1,
      policyHash: 'a'.repeat(64), pipelineHash: hash(developmentTemplate), limits: { 'limits.stepTurns': 3, 'limits.issueTurns': 5, 'limits.agentSeconds': 1800 } };
    const binding = { runId: run.id, epoch: 1 };
    store.create(run, { pipeline: developmentTemplate, source: { sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40) }, executionProfile: { kind: 'pipeliner-desktop', version: 1 },
      developer: { id: 'dev', connection: 'ollama', model: 'synthetic' }, skillsHash: 'c'.repeat(64), issueHash: 'd'.repeat(64), checks: [{ name: 'Repository checks', command: 'node --test' }], logBytes: 1048576 });
    store.begin(binding); const request = store.prepare(binding, 'source', 'source', {}); store.dispatch(binding, request.id); store.close(); store = undefined;
    assert.deepEqual(inspect('development.sqlite', development.inspectDevelopmentRecovery), { uncertainEffects: 1 });
    db = new DatabaseSync(join(root, 'development.sqlite')); db.exec("UPDATE development_requests SET state='verified'"); db.close(); db = undefined;
    assert.throws(() => inspect('development.sqlite', development.inspectDevelopmentRecovery), /Development request integrity failed/);
    for (const [name, read] of [['workspaces.sqlite', workspace.inspectWorkspaceRecovery], ['development.sqlite', development.inspectDevelopmentRecovery]]) {
      db = new DatabaseSync(join(root, name)); db.exec('PRAGMA user_version=999'); db.close(); db = undefined;
      assert.throws(() => inspect(name, read), /schema|store/);
    }
  } finally {
    try { db?.close(); } finally { try { store?.close(); } finally { try { capture?.close(); } finally { vault.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } } }
  }
});

test('recorded recovery work holds the existing owner and every source until explicit close', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-cold-work-'))), scratch = join(root, 'scratch');
  mkdirSync(scratch, { mode: 0o700 }); const vault = await openTestVault(root);
  let store, db, capture, owner;
  const options = { scratch, vault, checkpoint() {} };
  try {
    assert.equal(typeof execution.captureRecoveryWork, 'function');
    store = workspace.openWorkspaceStore(root, { vault }); store.close(); store = undefined;
    store = development.openDevelopmentStore(root, { vault }); store.close(); store = undefined;
    store = policy.openPolicyStore(root, { catalog: () => ({ repositories: [], capabilities: [], maxConcurrency: 1, background: false, connections: [], developers: [], extensions: [] }) }); store.close(); store = undefined;
    owner = execution.acquireExecutionOwner(root); owner.close(); owner = undefined;
    assert.throws(() => { capture = execution.captureRecoveryWork(root, options); });
    assert.equal(existsSync(join(root, 'execution.sqlite')), false);
    owner = execution.acquireExecutionOwner(root, { existingOnly: true }); owner.close(); owner = undefined;
    const path = protectedFile(root, 'execution.sqlite');
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE workers(run_id TEXT,epoch INTEGER,repository TEXT,document TEXT,hash TEXT,state TEXT,cid TEXT,error TEXT); PRAGMA user_version=1;'); db.close(); db = undefined;
    capture = execution.captureRecoveryWork(root, options);
    assert.deepEqual(capture.workers, []); assert.equal(capture.verify(), true);
    assert.throws(() => { owner = execution.acquireExecutionOwner(root, { existingOnly: true }); }, /unavailable/);
    db = new DatabaseSync(path); db.exec('CREATE TABLE changed(value TEXT)'); db.close(); db = undefined;
    assert.throws(() => capture.verify()); capture.close(); capture.close(); capture = undefined;
    owner = execution.acquireExecutionOwner(root, { existingOnly: true }); owner.close(); owner = undefined;
    const manifest = { name: 'pipeliner-' + 'a'.repeat(32), nonce: 'a'.repeat(32), runId: 'run', repository: 'repo', epoch: 1,
      workspace: '/home/fixture/.local/share/pipeliner/workspaces/' + 'b'.repeat(32), image: 'sha256:' + 'c'.repeat(64) };
    const data = { manifest, program: 'true' }, hash = createHash('sha256').update(canonicalJSON(data)).digest('hex');
    db = new DatabaseSync(path); db.prepare("INSERT INTO workers VALUES('run',1,'repo',?,?,'running',?,NULL)").run(canonicalJSON(data), hash, 'd'.repeat(64)); db.close(); db = undefined;
    assert.throws(() => { capture = execution.captureRecoveryWork(root, options); }, /Recorded work/);
    db = new DatabaseSync(path); db.exec("UPDATE workers SET state='exited'"); db.close(); db = undefined;
    capture = execution.captureRecoveryWork(root, options);
    assert.deepEqual(capture.workers, [{ manifest, state: 'exited', cid: 'd'.repeat(64) }]); capture.close(); capture = undefined;
    store = workspace.openWorkspaceStore(root, { vault }); const effect = store.prepare('job', 'step', {}); store.dispatch(effect.id); store.close(); store = undefined;
    assert.throws(() => { capture = execution.captureRecoveryWork(root, options); }, /Recorded work/);
    owner = execution.acquireExecutionOwner(root, { existingOnly: true }); owner.close(); owner = undefined;
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    try { capture?.close(); } finally { try { owner?.close(); } finally { try { db?.close(); } finally { try { store?.close(); } finally { vault.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } } } }
  }
});

test('cold policy inspection validates captured runs and actions before reporting reservations', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-cold-policy-'))), scratch = join(root, 'scratch');
  mkdirSync(scratch, { mode: 0o700 }); let store, db, capture;
  const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
  const catalog = () => ({ repositories: ['repo'], capabilities: [], maxConcurrency: 1, background: false,
    connections: [{ id: 'ollama', provider: 'ollama', repositories: ['repo'] }], developers: [{ id: 'dev', connection: 'ollama', metrics: [] }], extensions: [] });
  const inspect = () => {
    const path = join(root, 'policy.sqlite'), before = readFileSync(path), identity = lstatSync(path, { bigint: true });
    try { capture = captureRecoveryDatabase(root, 'policy.sqlite', { scratch, checkpoint() {}, read: policy.inspectPolicyRecovery }); return capture.value; }
    finally {
      capture?.close(); capture = undefined;
      assert.deepEqual(readFileSync(path), before);
      const after = lstatSync(path, { bigint: true });
      for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], identity[key]);
      assert.deepEqual(readdirSync(scratch), []);
    }
  };
  try {
    assert.equal(typeof policy.inspectPolicyRecovery, 'function');
    store = policy.openPolicyStore(root, { catalog, clock: () => 1000 });
    const input = store.control.capture({ commandId: 'input', conversationId: 'chat', target: 'repo', text: 'Synthetic fixture configuration.' });
    const preview = store.control.prepare({ inputId: input.id, requestId: 'request', scope: 'repository', target: 'repo', changes: { 'agents.dev': 'dev' }, reset: [] });
    store.control.apply({ commandId: 'apply', proposalId: preview.id, hash: preview.hash, inputId: input.id, conversationId: 'chat', target: 'repo' });
    const captured = store.worker.read('repo'); store.close(); store = undefined;
    assert.deepEqual(inspect(), { reservations: 0, uncertainEffects: 0 });
    db = new DatabaseSync(join(root, 'policy.sqlite'));
    db.exec("INSERT INTO runtime_repositories VALUES('repo','github.com','fixture/repo',1)");
    const limits = Object.fromEntries(Object.entries(captured.values).filter(([key]) => key.startsWith('limits.')).map(([key, value]) => [key, value.value]));
    db.prepare("INSERT INTO runtime_runs VALUES('run','repo',1,'dev',?,?,'development',?,?,1,'previous-session','In Progress','stopped',1000,NULL)")
      .run(captured.revision, captured.hash, hash(captured.values['pipelines.development'].value), canonicalJSON(limits));
    db.close(); db = undefined;
    assert.deepEqual(inspect(), { reservations: 1, uncertainEffects: 0 });
    db = new DatabaseSync(join(root, 'policy.sqlite'));
    db.exec("UPDATE runtime_runs SET status='Done',control='complete',released_at=2000");
    const binding = { runId: 'run', repository: 'repo', issue: 1 };
    db.prepare("INSERT INTO runtime_actions VALUES('effect','run','effect-command',?,?,'uncertain',1,1,3000,NULL,NULL,2000)").run(hash(binding), canonicalJSON(binding));
    db.close(); db = undefined;
    assert.deepEqual(inspect(), { reservations: 0, uncertainEffects: 1 });
    db = new DatabaseSync(join(root, 'policy.sqlite')); db.exec('DROP TRIGGER immutable_action_binding');
    db.prepare('UPDATE runtime_actions SET fingerprint=?').run('0'.repeat(64)); db.close(); db = undefined;
    assert.throws(inspect, /integrity/);
    db = new DatabaseSync(join(root, 'policy.sqlite')); db.exec('PRAGMA user_version=999'); db.close(); db = undefined;
    assert.throws(inspect, /schema/);
  } finally {
    try { db?.close(); } finally { try { store?.close(); } finally { try { capture?.close(); } finally { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } } }
  }
});
