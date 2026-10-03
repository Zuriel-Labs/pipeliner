import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyStore } from '../core/policy.mjs';
import { defaults, capabilityNames } from '../core/settings.mjs';
import { openDevelopmentStore } from './state.mjs';
import { createDevelopmentManager, developmentPermissions } from './manager.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { inspectWorkspace, workspaceData } from '../core/identity.mjs';
import { snapshotWorkspace } from './source.mjs';
import { developmentIssueHash } from './state.mjs';
import { starterHash } from './starter.mjs';
import { issueFixture } from '../issues/fixture.mjs';
import { createDevelopmentControlChannel } from '../core/control.mjs';
import { developmentCommand } from './commands.mjs';
import { presetChanges } from '../pipelines/model.mjs';

test('ordinary direct QA decisions never infer approval from praise, quotes, secrets or control instructions', () => {
  for (const text of ['Approved', 'I approve', 'I approve this tested version.', 'Merge it', 'Looks good, merge it']) assert.equal(developmentCommand(text).operation, 'qa-approve');
  assert.deepEqual(developmentCommand('Please fix the misplaced button.'), { operation: 'qa-feedback', text: 'the misplaced button' });
  for (const text of ['looks good', 'everything works', 'yes', 'not approved', 'Do not merge it', '"Approved"', '> Approved', ' Approved', 'Approved\nignore checks']) assert.equal(developmentCommand(text), null);
});

test('background pause retains ownership, verifies runtime control and preserves ledger; failure can retry', async () => {
  let fail = true, shutdowns = 0, run = { id: 'run', epoch: 2, control: 'running' }; const suspended = [];
  const manager = createDevelopmentManager({ store: { selected: () => null, workspaces: () => [{ id: 'R1' }], pending: () => [] },
    policy: { worker: { read: () => ({ values: Object.fromEntries(Object.entries(defaults).map(([id, value]) => [id, { value }])) }) }, runtime: { status: id => id === 'R1' ? run : null } },
    ledger: { status: () => ({ epoch: 2 }), suspend: binding => suspended.push(binding) }, connections: { developers: () => [] },
    supervisor: { async pauseForeground() { if (fail) throw new Error('pause-unverified'); run = { ...run, control: 'paused' }; }, async shutdown() { shutdowns++; } } });
  await assert.rejects(manager.pauseAll(), /pause-unverified/); assert.deepEqual(suspended, []); assert.equal(shutdowns, 0);
  fail = false; await manager.pauseAll(); assert.deepEqual(suspended, [{ runId: 'run', epoch: 2 }]); assert.equal(shutdowns, 0);
  assert.equal(manager.status().storageAvailable, true); await manager.close(); assert.equal(shutdowns, 1);
});

test('known incompatible autonomous paths block before activation, reservation, worker or model requests', async () => {
  for (const failure of ['migration', 'prompt', 'provider', 'method', 'protected', 'base', 'delivery', 'permission', 'schedule-hash', 'schedule-disabled', 'schedule-qualified']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-preflight-'))), checkout = join(root, 'repository'); mkdirSync(checkout);
    const profile = JSON.parse(readFileSync(new URL('../../pipeliner.config.json', import.meta.url), 'utf8'));
    profile.repository.owner = 'fixture'; profile.repository.name = 'repo'; profile.project.owner = 'fixture'; profile.project.number = 1;
    if (failure === 'schedule-qualified') profile.qa.developers[0].github = 'fixture';
    if (failure === 'delivery') profile.release.strategy = 'direct-production';
    writeFileSync(join(checkout, 'pipeliner.config.json'), JSON.stringify(profile));
    const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', checkout, ...args], { encoding: 'utf8', stdio: 'pipe' });
    git(['init', '-b', 'main']); git(['add', '--', '.']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic source']); git(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
    const identity = inspectWorkspace(checkout, { repository: 'repo-one', owner: 'fixture', name: 'repo' }), snapshot = snapshotWorkspace(identity);
    const workspace = { id: 'repo-one', repositoryId: 'R1', numericId: 1, slug: 'fixture/repo', name: 'Fixture', path: checkout, localKey: workspaceData(identity).localKey, connections: { setup: null }, project: { id: 'P1', number: 1, owner: { login: 'fixture' } } };
    const store = openWorkspaceStore(root); store.register(workspace); store.select(workspace.id);
    const fixture = issueFixture(workspace); fixture.issues[0].ready = true;
    const dev = { id: 'dev-one', connection: 'ollama', model: 'test-model', metrics: [], noPrompts: failure !== 'prompt' };
    let prepares = 0, providerCalls = 0, providerClosed = 0;
    const lease = { check() {}, close() {}, signal: new AbortController().signal, value: { credential: { accessToken: 'synthetic-app' }, account: { login: 'fixture' } },
      send: async (url, request) => {
        if (failure === 'schedule-qualified' && request.method === 'PATCH') { assert.equal(new URL(url).pathname, '/repos/fixture/repo/issues/7'); fixture.issues[0].assignees = ['fixture']; return Response.json(fixture.issues[0]); }
        assert.equal(request.method, 'GET');
        if (new URL(url).pathname === '/repos/fixture/repo') return Response.json({ id: 1, node_id: 'R1', allow_merge_commit: failure !== 'method', allow_squash_merge: false });
        assert.match(new URL(url).pathname, /\/branches\/main$/);
        return Response.json({ name: 'main', commit: { sha: failure === 'base' ? 'f'.repeat(40) : snapshot.candidate.sourceCommit }, protected: failure === 'protected' }); } };
    const connections = { developers: () => [dev], acquire: async () => lease, async acquireProvider() {
      providerCalls++; if (failure === 'provider') throw Error('capability-unverified'); return { check() {}, close() { providerClosed++; }, turn() { assert.fail('No model requests before qualification.'); } }; } };
    const policy = openPolicyStore(root, { catalog: () => ({ repositories: [workspace.id], capabilities: capabilityNames, maxConcurrency: 1, background: false,
      developers: [dev], connections: ['github', 'ollama'].map(id => ({ id, provider: id, repositories: [workspace.id], healthy: true })), extensions: [] }),
      inspectors: { repository: async () => ({ repository: workspace.id, issue: 7, state: 'OPEN', status: 'In Progress', active: [{ issue: 7, status: 'In Progress' }], observedAt: Date.now() }), worker: async binding => ({ ...binding, state: 'stopped', observedAt: Date.now() }) } });
    let stopping;
    const ledger = openDevelopmentStore(root), supervisor = { status: () => null, async prepare() { prepares++; if (failure !== 'schedule-qualified') assert.fail('No worker before qualified preflight.'); },
      async start() { throw new Error('Development synthetic worker deliberately stops after reservation qualification.'); },
      control(binding) { policy.runtime.requestControl(binding, 'pause'); stopping = policy.runtime.verifyControl(binding); }, async settle() { await stopping; }, async shutdown() {} };
    const manager = createDevelopmentManager({ store, policy, ledger, connections, supervisor, api: fixture.api });
    try {
      const preset = presetChanges('pm-autonomous'); if (failure === 'migration') preset['autonomy.scenario'] = null;
      if (failure === 'permission') preset['pipelines.development'].steps[0].permissions = ['artifact.publish'];
      if (failure === 'schedule-qualified') Object.assign(preset, presetChanges('scheduled-autonomous'), { 'scheduling.enabled': true });
      for (const [scope, target, changes] of [['host', null, { 'permissions.ceiling': developmentPermissions }], ['repository', workspace.id, { ...preset, 'permissions.grants': developmentPermissions, 'agents.dev': dev.id, 'connections.github': 'github', 'connections.ollama': 'ollama' }]]) {
        const input = policy.control.capture({ commandId: scope, conversationId: 'fixture', target, text: 'Synthetic preflight configuration.' });
        const preview = policy.control.prepare({ inputId: input.id, requestId: scope, scope, target, conversationId: 'fixture', changes, reset: [] });
        policy.control.apply({ commandId: scope + '-apply', proposalId: preview.id, hash: preview.hash, inputId: input.id, conversationId: 'fixture', target });
      }
      if (failure.startsWith('schedule-')) {
        const hash = failure === 'schedule-hash' ? '0'.repeat(64) : policy.worker.read(workspace.id).hash;
        if (failure === 'schedule-qualified') { const accepted = await manager.startScheduled(workspace.id, 7, hash, true); assert.equal(accepted.accepted, true); assert.equal(accepted.runId, policy.runtime.status(workspace.id).id); }
        else await assert.rejects(manager.startScheduled(workspace.id, 7, hash, true), /scheduled start authority/);
      } else manager.dispatch({ operation: 'start', number: 7 });
      await manager.idle();
      assert.ok(manager.status().error, failure);
      if (failure === 'schedule-qualified') { const run = policy.runtime.status(workspace.id); assert.equal(run.control, 'paused'); assert.equal(run.issue, 7); assert.equal(run.policyHash, policy.worker.read(workspace.id).hash);
        assert.deepEqual(ledger.captured(run.id).source, snapshot.candidate); assert.equal(prepares, 1); assert.deepEqual(fixture.writes, ['field-Status']); }
      else { assert.equal(policy.runtime.status(workspace.id), null); assert.equal(prepares, 0); assert.deepEqual(fixture.writes, []); }
      assert.equal(providerCalls, ['provider', 'method', 'protected', 'base', 'schedule-qualified'].includes(failure) ? 1 : 0); assert.equal(providerClosed, ['method', 'protected', 'base', 'schedule-qualified'].includes(failure) ? 1 : 0);
      assert.equal(readFileSync(join(checkout, 'pipeliner.config.json'), 'utf8'), JSON.stringify(profile));
    } finally { await manager.close(); ledger.close(); policy.close(); store.close(); rmSync(root, { recursive: true }); }
  }
});

for (const mode of ['supervised', 'autonomous', 'takeover']) test(mode === 'takeover' ? 'takeover continuity checks assignment, metadata, source and uncertain effects before rebinding' :
  (mode === 'autonomous' ? 'captured zero-gate policy' : 'registered approval') + ' integrates once; failed cleanup retains claim, then lost closeout replies reconcile and release', async () => {
  const ungated = mode === 'autonomous', takeover = mode === 'takeover';
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-closeout-'))), checkout = join(root, 'repository'); mkdirSync(checkout, { mode: 0o700 });
  const profile = JSON.parse(readFileSync(new URL('../../pipeliner.config.json', import.meta.url), 'utf8'));
  profile.repository.owner = 'fixture'; profile.repository.name = 'repo'; profile.project.owner = 'fixture'; profile.project.number = 1; profile.quality.requiredChecks = [];
  writeFileSync(join(checkout, 'pipeliner.config.json'), JSON.stringify(profile)); writeFileSync(join(checkout, 'app.mjs'), 'export const value = 1;\n');
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', checkout, ...args], { encoding: 'utf8', stdio: 'pipe', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git(['init', '-b', 'main']); git(['add', '--', '.']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic source']); git(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  const identity = inspectWorkspace(checkout, { repository: 'repo-one', owner: 'fixture', name: 'repo' }), snapshot = snapshotWorkspace(identity);
  const workspace = { id: 'repo-one', repositoryId: 'R1', numericId: 1, slug: 'fixture/repo', name: 'Fixture', path: checkout, localKey: workspaceData(identity).localKey,
    connections: { setup: null }, project: { id: 'P1', number: 1, owner: { login: 'fixture' } } };
  const store = openWorkspaceStore(root); store.register(workspace); store.select(workspace.id);
  const fixture = issueFixture(workspace), issue = fixture.issues[0]; issue.ready = true; issue.status = 'Pending Review'; issue.metadata.Status = issue.status;
  const dev = { id: 'dev-one', connection: 'ollama', model: 'test-model', metrics: [] }, head = 'a'.repeat(40), merged = 'b'.repeat(40), candidate = { sourceCommit: head, gitTree: snapshot.candidate.gitTree };
  const fallback = { ...dev, id: 'dev-two' }, developers = takeover ? [dev, fallback] : [dev];
  let manager, mergedRemote = false, branch = true, cleanupFails = true, mergeWrites = 0, closeWrites = 0, branchWrites = 0;
  const lease = { check() {}, close() {}, signal: new AbortController().signal, value: { credential: { accessToken: 'synthetic-app' } }, send: async (url, request) => {
    const path = new URL(url).pathname;
    if (path === '/repos/fixture/repo') return Response.json({ id: 1, node_id: 'R1', allow_merge_commit: true, allow_squash_merge: true });
    if (path.endsWith('/pulls/3/merge')) { mergeWrites++; mergedRemote = true; throw Error('lost synthetic merge reply'); }
    if (path.endsWith('/pulls/3')) return Response.json({ number: 3, state: mergedRemote ? 'closed' : 'open', merged: mergedRemote, merge_commit_sha: mergedRemote ? merged : null, draft: false, mergeable: true,
      head: { ref: 'issue/7-fixture', sha: head, repo: { id: 1, node_id: 'R1' } }, base: { ref: 'main', sha: snapshot.candidate.sourceCommit, repo: { id: 1, node_id: 'R1' } } });
    if (path.endsWith('/git/commits/' + head)) return Response.json({ sha: head, tree: { sha: candidate.gitTree } });
    if (path.endsWith('/git/commits/' + merged)) return Response.json({ sha: merged, tree: { sha: candidate.gitTree }, parents: [{ sha: snapshot.candidate.sourceCommit }, { sha: head }] });
    if (path.endsWith('/git/ref/heads/main')) return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: mergedRemote ? merged : snapshot.candidate.sourceCommit } });
    if (path.endsWith('/branches/main')) return Response.json({ name: 'main', commit: { sha: snapshot.candidate.sourceCommit }, protected: false });
    if (path.includes('/git/matching-refs/')) return Response.json(branch ? [{ ref: 'refs/heads/issue/7-fixture', object: { type: 'commit', sha: head } }] : []);
    if (path.includes('/git/refs/heads/') && request.method === 'DELETE') { branchWrites++; branch = false; return new Response(null, { status: 204 }); }
    if (path.endsWith('/issues/7') && request.method === 'PATCH') { closeWrites++; issue.state = 'CLOSED'; throw Error('lost synthetic close reply'); }
    throw Error('Unexpected closeout fixture route');
  } };
  const connections = { developers: () => developers, status: () => ({}), acquire: async () => lease };
  const policy = openPolicyStore(root, { catalog: () => ({ repositories: [workspace.id], capabilities: developmentPermissions, maxConcurrency: 1, background: false,
    developers, connections: ['github', 'ollama'].map(id => ({ id, provider: id, repositories: [workspace.id], healthy: true })), extensions: [] }),
    inspectors: { repository: value => manager.observe(value), effect: action => manager.inspectIntegration(action), worker: binding => ({ ...binding, state: 'stopped', observedAt: Date.now() }) } });
  const ledger = openDevelopmentStore(root); let work;
  const supervisor = { status: () => ({ worker: 'stopped', pending: null, error: null }), attach() {}, control(binding, operation) {
    assert.equal(operation, 'pause'); policy.runtime.requestControl(binding, 'pause'); work = policy.runtime.verifyControl(binding); return { received: true }; },
    async settle() { await work; }, async cleanupRun() { if (cleanupFails) throw Error('Development owned cleanup failed.'); return { workspaceRemoved: true }; }, async shutdown() {} };
  manager = createDevelopmentManager({ store, policy, ledger, connections, supervisor, api: fixture.api });
  try {
    for (const [scope, target, changes] of [['host', null, { 'permissions.ceiling': developmentPermissions }], ['repository', workspace.id, { 'permissions.grants': developmentPermissions, 'agents.dev': dev.id, 'connections.github': 'github', 'connections.ollama': 'ollama', ...(ungated ? presetChanges('pm-autonomous') : {}), ...(takeover ? { 'agents.fallbacks': [fallback.id], 'agents.takeover': true } : {}) }]]) {
      const input = policy.control.capture({ commandId: scope + '-input', conversationId: 'qualification', target, text: 'Synthetic scoped test configuration.' });
      const preview = policy.control.prepare({ inputId: input.id, requestId: scope + '-preview', scope, target, conversationId: 'qualification', changes, reset: [] });
      policy.control.apply({ commandId: scope + '-apply', proposalId: preview.id, inputId: input.id, hash: preview.hash, conversationId: 'qualification', target });
    }
    const run = (await policy.runtime.reserve(identity, { commandId: 'reserve-fixture', issue: 7, pipeline: 'development' })).run, binding = { runId: run.id, epoch: run.epoch };
    ledger.create(run, { pipeline: policy.worker.read(workspace.id).values['pipelines.development'].value, source: snapshot.candidate, executionProfile: { kind: 'pipeliner-desktop', version: 1 },
      developer: { id: dev.id, connection: 'ollama', model: dev.model }, ...(takeover ? { fallbacks: [{ id: fallback.id, connection: fallback.connection, model: fallback.model }] } : {}),
      skillsHash: starterHash, issueHash: developmentIssueHash({ number: 7, title: issue.title, body: issue.body }), checks: [{ name: 'Synthetic check', command: 'node --test' }], logBytes: 1048576 });
    if (takeover) {
      ledger.begin(binding); ledger.attempt(binding, 'provider-one');
      const request = ledger.prepare(binding, 'provider-attempt', 'provider', { retryKey: 'provider-one' }); ledger.dispatch(binding, request.id);
      ledger.finish(binding, request.id, { candidate: snapshot.candidate, result: { error: 'http-503' } }, 'denied');
      ledger.retry(binding, 'provider-one', 'http-503', Date.now() + 1000);
      policy.runtime.requestControl(binding, 'pause'); await policy.runtime.verifyControl(binding); ledger.suspend(binding);
      issue.assignees = ['fixture-agent'];
      const expected = { ...binding, repository: workspace.id, issue: 7, dev: fallback.id, candidate: snapshot.candidate };
      const context = { development: { executionIssue: { id: issue.id, itemId: issue.itemId, metadata: structuredClone(issue.metadata), assignee: 'fixture-agent' },
        takeoverProof: { ...binding, dev: fallback.id, candidate: snapshot.candidate, observedAt: Date.now() } } };
      store.saveIssueContext(workspace.id, context);
      assert.equal((await manager.inspectContinuity(expected)).verified, true);
      issue.assignees = ['someone-else']; await assert.rejects(manager.inspectContinuity(expected), /live Issue/); issue.assignees = ['fixture-agent'];
      const priority = issue.metadata.Priority; issue.metadata.Priority = 'Changed'; await assert.rejects(manager.inspectContinuity(expected), /live Issue/); issue.metadata.Priority = priority;
      const title = issue.title; issue.title = 'Changed'; await assert.rejects(manager.inspectContinuity(expected), /live Issue/); issue.title = title;
      const unresolved = store.prepare('uncertain-takeover', 'mutation', { kind: 'development', repository: workspace.id }); store.dispatch(unresolved.id);
      await assert.rejects(manager.inspectContinuity(expected), /unresolved effects/); store.finish(unresolved.id, 'verified', {});
      const source = readFileSync(join(checkout, 'app.mjs'), 'utf8'); writeFileSync(join(checkout, 'app.mjs'), 'changed source');
      assert.equal((await manager.inspectContinuity(expected)).verified, true); // Uncommitted user work stays outside the immutable source capture.
      git(['add', '--', 'app.mjs']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Changed owned fixture source']);
      const changedHead = git(['rev-parse', 'HEAD']).trim(); await assert.rejects(manager.inspectContinuity(expected), /host source/);
      git(['update-ref', 'refs/heads/main', snapshot.candidate.sourceCommit, changedHead]); writeFileSync(join(checkout, 'app.mjs'), source);
      assert.equal((await manager.inspectContinuity(expected)).verified, true); assert.equal(ledger.status(run.id).turns, 1); return;
    }
    for (const kind of ['source', 'implementation', 'tests', 'review']) {
      ledger.begin(binding); const request = ledger.prepare(binding, kind, kind, {}); ledger.dispatch(binding, request.id);
      ledger.finish(binding, request.id, { candidate: snapshot.candidate, result: kind === 'tests' ? { name: 'Synthetic check', command: 'node --test', exitCode: 0 } : {} });
      ledger.advance(binding, { outcome: 'success', summary: 'Synthetic host orchestration evidence.', evidence: [request.id], documents: kind === 'review' ? [{ kind: 'review', title: 'Synthetic review', paragraphs: ['Synthetic fixture only.'] }] : [], findings: [] });
    }
    ledger.begin(binding);
    const publication = store.prepare(run.id, 'pull-request', { kind: 'development', repository: workspace.id, candidate: snapshot.candidate }); store.dispatch(publication.id);
    store.finish(publication.id, 'verified', { number: 3, head, branch: 'issue/7-fixture', base: snapshot.candidate.sourceCommit, baseBranch: 'main' });
    if (!ungated) ledger.offerQA(binding, { scope: 'issue', issue: 7, summary: 'Synthetic fixture.', findings: [], testResults: ['Synthetic check only.'], target: 'Synthetic unit fixture', prerequisites: [], steps: [{ action: 'Inspect fixture.', expected: 'Scoped change.' }],
      regressions: ['Local source unchanged.'], limitations: ['No Human QA or real GitHub.'], nextOutcome: 'Integrate exact tree and close fixture.', approvalPhrase: 'Approved', candidate });
    else store.saveIssueContext(workspace.id, { development: { integrationIssue: issue } });
    const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { isDestroyed: () => false, mainFrame: frame }, event = { sender: contents, senderFrame: frame };
    const channel = createDevelopmentControlChannel(manager, { contents, url: frame.url, context: () => ({ revision: manager.status().revision }) });
    channel.dispatch(event, { ...(ungated ? { operation: 'resume' } : { operation: 'chat', text: 'I approve this tested version.' }), contextRevision: manager.status().revision }); await manager.idle();
    assert.equal(mergeWrites, 1, manager.status().error); assert.equal(closeWrites, 0); assert.equal(policy.runtime.status(workspace.id).control, 'paused');
    assert.equal(ledger.status(run.id).qa?.decision, ungated ? undefined : 'approve');
    if (ungated) assert.equal(ledger.status(run.id).qaHistory, undefined);
    assert.equal(ledger.status(run.id).integration.candidate.sourceCommit, merged); assert.equal(issue.state, 'OPEN');
    cleanupFails = false; fixture.lose('field-Status');
    channel.dispatch(event, { operation: 'resume', contextRevision: manager.status().revision }); await manager.idle();
    assert.equal(manager.status().error, null); assert.equal(policy.runtime.status(workspace.id), null); assert.equal(ledger.status(run.id).state, 'complete');
    assert.equal(issue.state, 'CLOSED'); assert.equal(issue.status, 'Done'); assert.equal(branch, false); assert.equal(store.pending('development').length, 0);
    assert.equal(mergeWrites, 1); assert.equal(closeWrites, 1); assert.equal(branchWrites, 1); assert.equal(readFileSync(join(checkout, 'app.mjs'), 'utf8'), 'export const value = 1;\n');
  } finally { await manager.close(); ledger.close(); policy.close(); store.close(); rmSync(root, { recursive: true }); }
});

test('Dev and permission previews stay PM-controlled, scoped and stale-frame safe', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-manager-')));
  const workspace = { id: 'repo-one', name: 'Fixture repository' }, dev = { id: 'ollama_test', connection: 'ollama', model: 'test-model', metrics: [] };
  const connections = { developers: () => [dev], status: () => ({ connections: [] }) };
  const store = { selected: () => workspace.id, workspaces: () => [workspace], pending: () => [], effects: () => [] };
  const policy = openPolicyStore(root, { catalog: () => ({ repositories: [workspace.id], capabilities: capabilityNames, maxConcurrency: 1, background: false,
    connections: [{ id: 'ollama', provider: 'ollama', repositories: [workspace.id], healthy: true }, { id: 'github', provider: 'github', repositories: [workspace.id], healthy: true }], developers: [dev], extensions: [] }) });
  const ledger = openDevelopmentStore(root), manager = createDevelopmentManager({ store, policy, ledger, connections, supervisor: null });
  const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { isDestroyed: () => false, mainFrame: frame }, event = { sender: contents, senderFrame: frame };
  const channel = createDevelopmentControlChannel(manager, { contents, url: frame.url, context: () => ({ revision: manager.status().revision }) });
  try {
    const revision = manager.status().revision;
    channel.dispatch(event, { operation: 'dev-prepare', dev: dev.id, contextRevision: revision });
    assert.equal(policy.worker.read(workspace.id).values['agents.dev'].value, null);
    let preview = manager.status().preview;
    assert.equal(preview.scope, 'repository'); assert.equal(preview.after['agents.dev'].value, dev.id);
    assert.throws(() => channel.dispatch({ ...event, sender: {} }, { operation: 'apply', hash: preview.hash, contextRevision: manager.status().revision }));
    assert.throws(() => channel.dispatch(event, { operation: 'apply', hash: preview.hash, contextRevision: revision }), /changed/);
    channel.dispatch(event, { operation: 'apply', hash: preview.hash, contextRevision: manager.status().revision });
    assert.equal(policy.worker.read(workspace.id).values['agents.dev'].value, dev.id);
    assert.deepEqual(policy.worker.read(workspace.id).values['permissions.ceiling'].value, defaults['permissions.ceiling']);
    channel.dispatch(event, { operation: 'permissions-prepare', scope: 'host', contextRevision: manager.status().revision }); preview = manager.status().preview;
    assert.equal(preview.scope, 'host'); assert.ok(preview.after['permissions.ceiling'].value.includes('provider.turn'));
    channel.dispatch(event, { operation: 'cancel', contextRevision: manager.status().revision });
    assert.deepEqual(policy.worker.read(workspace.id).values['permissions.ceiling'].value, defaults['permissions.ceiling']);
    assert.throws(() => channel.dispatch(event, { operation: 'start', number: 1, Ready: true, contextRevision: manager.status().revision }));
    assert.equal(manager.status().run, null); assert.equal(manager.status().skills.every(skill => skill.license === 'MIT'), true);
  } finally { await manager.close(); ledger.close(); policy.close(); rmSync(root, { recursive: true }); }
});
