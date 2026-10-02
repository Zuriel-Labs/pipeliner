import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inspectWorkspace } from '../core/identity.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openPolicyStore } from '../core/policy.mjs';
import { createIssueManager } from './manager.mjs';
import { issueFixture } from './fixture.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-38-intake-'))), store = openWorkspaceStore(root);
  const fields = Object.fromEntries([['Status', ['Backlog', 'In Progress', 'In Review', 'Pending Review', 'Done']], ['Priority', ['P0', 'P1']], ['Impact', ['High']], ['Effort', ['M']]].map(([role, names]) => [role, { id: 'F_' + role, name: role, options: names.map((name, i) => ({ id: 'O_' + role + i, name })) }]));
  const workspace = { id: 'repo_fixture', repositoryId: 'R1', numericId: 1, slug: 'fixture/repo', name: 'Fixture / Repo', localKey: '1:2', path: root, private: true, project: { id: 'P1', owner: { id: 'ORG1' }, fields }, connections: { github: 'github', setup: null } };
  store.register(workspace); store.register({ ...workspace, id: 'repo_second', repositoryId: 'R2', slug: 'fixture/second', localKey: '1:3' }); store.select(workspace.id);
  const values = { title: 'Preserve my work', summary: 'Keep existing files.', acceptance: ['Tracked and untracked changes remain intact.'], priority: 'P1', impact: 'High', effort: 'M', labels: ['type:feature'], dependencies: [7] };
  const catalog = { repositories: ['repo_fixture', 'repo_second'], capabilities: ['workspace.read', 'workspace.write', 'worker.exec', 'github.issue.write', 'github.project.write'], maxConcurrency: 1, background: false,
    connections: [{ id: 'github', provider: 'github', repositories: ['repo_fixture'] }, { id: 'codex', provider: 'codex', repositories: ['repo_fixture'] }], developers: [{ id: 'dev', connection: 'codex', metrics: [] }], extensions: [] };
  const policy = openPolicyStore(root, { catalog: () => catalog, inspectors: { repository: async ({ repository, issue }) => ({ repository, issue, state: 'OPEN', status: remote.issues[0].status,
    active: remote.issues.filter(issue => ['In Progress', 'In Review', 'Pending Review'].includes(issue.status)).map(({ number, status }) => ({ issue: number, status })), observedAt: Date.now() }) } }); let epoch = 1, disconnected = false;
  const connections = { epoch: () => epoch, acquire: async id => {
    if (disconnected) throw new Error('connection-unavailable'); const leaseEpoch = epoch;
    return { id, epoch: leaseEpoch, value: { account: { id: 1, node: 'U1' } }, check() { if (epoch !== leaseEpoch || disconnected) throw new Error('connection-changed'); }, close() {} };
  } };
  const remote = issueFixture(workspace), options = { store, policy, connections, api: remote.api };
  let manager = createIssueManager(options);
  function edit(changes, scope = 'repository', target = workspace.id) {
    const input = policy.control.capture({ commandId: randomUUID(), conversationId: 'pm', target, text: 'Change the configured policy' });
    const preview = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: 'pm', scope, target, changes, reset: [] });
    policy.control.apply({ commandId: randomUUID(), proposalId: preview.id, inputId: input.id, hash: preview.hash, conversationId: 'pm', target }); return policy.worker.read(workspace.id).revision;
  }
  return { root, store, policy, workspace, values, remote, edit, get manager() { return manager; },
    disconnect: () => { epoch++; disconnected = true; }, reconnect: () => { disconnected = false; },
    async restart() { await manager.close(); manager = createIssueManager(options); },
    async close() { await manager.close(); policy.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function preview(f) {
  f.manager.dispatch({ operation: 'begin', values: f.values }); f.manager.dispatch({ operation: 'prepare' }); await f.manager.idle();
  assert.equal(f.manager.status().draft.state, 'preview'); return f.manager.status().draft.preview.hash;
}
test('PM intake creates exactly once with complete metadata and dependencies, without assignment or Ready', async () => {
  const f = fixture();
  try {
    const hash = await preview(f); assert.throws(() => f.manager.dispatch({ operation: 'create', hash: 'wrong' }), /issue-changed/);
    f.manager.dispatch({ operation: 'create', hash }); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'complete'); assert.equal(f.remote.issues.length, 2);
    const created = f.remote.issues[1]; assert.equal(created.status, 'Backlog'); assert.equal(created.ready, false); assert.deepEqual(created.assignees, []); assert.deepEqual(created.dependencies, [7]);
    const writes = f.remote.writes.length; f.manager.dispatch({ operation: 'create', hash }); assert.equal(f.remote.writes.length, writes);
    assert.equal(f.store.pending('issue').length, 0); assert.equal(f.policy.runtime.status(f.workspace.id), null);
  } finally { await f.close(); }
});
test('all active statuses block PM Ready removal at the host; outside label changes remain visible drift', async () => {
  const f = fixture();
  try {
    f.manager.dispatch({ operation: 'ready', number: 7, enabled: true }); await f.manager.idle(); assert.equal(f.remote.issues[0].ready, true);
    for (const status of ['In Progress', 'In Review', 'Pending Review']) {
      f.remote.issues[0].status = status;
      f.manager.dispatch({ operation: 'ready', number: 7, enabled: false }); await f.manager.idle();
      assert.equal(f.remote.issues[0].ready, true); assert.equal(f.manager.status().error, 'ready-active');
    }
    assert.equal(f.remote.writes.filter(write => write === 'ready').length, 1);
    f.remote.issues[0].ready = false; f.remote.issues[0].labels = ['type:feature'];
    f.manager.dispatch({ operation: 'refresh' }); await f.manager.idle();
    assert.deepEqual(f.manager.status().catalog.drift, [7]); assert.equal(f.manager.status().catalog.active.length, 1);
  } finally { await f.close(); }
});
test('known lost replies reconcile without repeating creation, Project link or field write; unknown creation never replays after restart', async () => {
  for (const step of ['create-known', 'project', 'field-Priority', 'create-unknown']) {
    const f = fixture();
    try {
      await preview(f); f.remote.lose(step); f.manager.dispatch({ operation: 'create' }); await f.manager.idle();
      assert.equal(f.manager.status().draft.state, 'uncertain'); await f.restart();
      f.remote.lose(null); f.manager.dispatch({ operation: 'repair' }); await f.manager.idle();
      assert.equal(f.remote.writes.filter(write => write === 'create').length, 1);
      assert.equal(f.remote.writes.filter(write => write === 'project').length, step === 'create-unknown' ? 0 : 1);
      assert.equal(f.remote.writes.filter(write => write === 'field-Priority').length, step === 'create-unknown' ? 0 : 1);
      assert.equal(f.manager.status().draft.state, step === 'create-unknown' ? 'uncertain' : 'complete');
    } finally { await f.close(); }
  }
});
test('a switched repository aborts old work and preserves its draft without mutating either repository', async () => {
  const f = fixture();
  try {
    await preview(f); let release; f.remote.delay(() => new Promise(resolve => { release = resolve; }));
    f.manager.dispatch({ operation: 'create' }); await new Promise(resolve => setImmediate(resolve));
    f.store.select('repo_second'); f.manager.sync(); release(); await f.manager.idle();
    assert.equal(f.manager.status().workspaceId, 'repo_second'); assert.equal(f.manager.status().draft, null); assert.equal(f.remote.writes.length, 0);
    f.store.select(f.workspace.id); f.manager.sync(); assert.equal(f.manager.status().draft.state, 'failed');
    await preview(f); f.disconnect(); f.manager.dispatch({ operation: 'create' }); await f.manager.idle(); assert.equal(f.remote.writes.length, 0);
  } finally { await f.close(); }
});
test('unclassified tracked Issues block readiness; a changed PM policy stops the next write and requires a fresh remaining-change preview', async () => {
  const f = fixture();
  try {
    f.remote.issues[0].status = null; f.manager.dispatch({ operation: 'ready', number: 7, enabled: true }); await f.manager.idle();
    assert.equal(f.manager.status().error, 'issue-state-incomplete'); assert.equal(f.remote.writes.length, 0);
    f.remote.issues[0].status = 'Backlog'; await preview(f);
    const create = f.remote.api.createIssue; f.remote.api.createIssue = async (...args) => { const result = await create(...args); f.edit({ 'intake.mode': 'pm' }); return result; };
    f.manager.dispatch({ operation: 'create' }); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'recovery-required'); assert.deepEqual(f.remote.writes, ['create']);
    f.manager.dispatch({ operation: 'prepare' }); await f.manager.idle(); assert.equal(f.manager.status().draft.state, 'preview');
    f.manager.dispatch({ operation: 'create' }); await f.manager.idle(); assert.equal(f.manager.status().draft.state, 'complete');
    assert.equal(f.remote.writes.filter(write => write === 'create').length, 1);
  } finally { await f.close(); }
});
test('the real policy store binds direct PM authoring changes and retains creation revocations across re-enablement', async () => {
  const f = fixture();
  try {
    f.manager.dispatch({ operation: 'policy-prepare', mode: 'agent', agentCreation: true });
    assert.equal(f.manager.status().policy.mode.value, 'coauthored');
    const hash = f.manager.status().policyPreview.hash; f.manager.dispatch({ operation: 'policy-apply', hash });
    const captured = f.policy.worker.read(f.workspace.id).revision;
    assert.equal(f.policy.worker.authority(f.workspace.id, captured).intake.agentCreation, true);
    assert.throws(() => f.manager.agent.create({ runId: 'invented', epoch: 1 }, f.workspace.id, f.values), /issue-authority-denied/);
    assert.throws(() => f.manager.agent.propose({ runId: 'invented', epoch: 1 }, f.workspace.id, f.values), /issue-authority-denied/);
    f.edit({ 'intake.agentCreation': false }); f.edit({ 'intake.agentCreation': true });
    assert.equal(f.policy.worker.authority(f.workspace.id, captured).intake.agentCreation, false);
    f.edit({ 'intake.mode': 'pm' }); f.edit({ 'intake.mode': 'agent' });
    assert.equal(f.policy.worker.authority(f.workspace.id, captured).intake.mode, 'pm');
    assert.equal(f.policy.worker.read(f.workspace.id).values['permissions.grants'].value.includes('github.issue.write'), false);
  } finally { await f.close(); }
});
test('a captured authorized host run creates an agent Issue without a PM gate and cannot create after revocation', async () => {
  const f = fixture();
  try {
    const checkout = join(f.root, 'owned-checkout'); mkdirSync(checkout);
    const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', checkout, ...args], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
    git(['init', '--initial-branch=main']); git(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
    f.edit({ 'permissions.ceiling': ['workspace.read', 'workspace.write', 'worker.exec', 'github.issue.write', 'github.project.write'] }, 'host', null);
    f.edit({ 'agents.dev': 'dev', 'connections.github': 'github', 'intake.mode': 'agent', 'intake.agentCreation': true,
      'permissions.grants': ['workspace.read', 'workspace.write', 'worker.exec', 'github.issue.write', 'github.project.write'] });
    f.remote.issues[0].status = 'In Progress';
    const run = (await f.policy.runtime.reserve(inspectWorkspace(checkout, { repository: f.workspace.id, owner: 'fixture', name: 'repo' }), { commandId: 'claim', issue: 7, pipeline: 'development' })).run;
    const binding = { runId: run.id, epoch: run.epoch };
    assert.throws(() => f.manager.agent.create(binding, f.workspace.id, { ...f.values, summary: 'ghu_syntheticSecretOnly123' }), /draft-incomplete/);
    assert.equal(f.store.issueContext(f.workspace.id), null);
    assert.equal(f.manager.agent.create(binding, f.workspace.id, f.values).accepted, true); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'complete'); assert.equal(f.remote.writes.filter(write => write === 'create').length, 1);
    assert.equal(f.policy.runtime.status(f.workspace.id).issue, 7); assert.equal(f.remote.issues[1].ready, false);
    f.edit({ 'intake.agentCreation': false }); f.edit({ 'intake.agentCreation': true });
    assert.throws(() => f.manager.agent.create(binding, f.workspace.id, f.values), /issue-authority-denied/);
    assert.equal(f.remote.writes.filter(write => write === 'create').length, 1);
  } finally { await f.close(); }
});
