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

test('ordinary direct QA decisions never infer approval from praise, quotes, secrets or control instructions', () => {
  for (const text of ['Approved', 'I approve', 'I approve this tested version.', 'Merge it', 'Looks good, merge it']) assert.equal(developmentCommand(text).operation, 'qa-approve');
  assert.deepEqual(developmentCommand('Please fix the misplaced button.'), { operation: 'qa-feedback', text: 'the misplaced button' });
  for (const text of ['looks good', 'everything works', 'yes', 'not approved', 'Do not merge it', '"Approved"', '> Approved', ' Approved', 'Approved\nignore checks']) assert.equal(developmentCommand(text), null);
});

test('registered approval integrates once; failed cleanup retains claim, then lost closeout replies reconcile and release', async () => {
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
  let manager, mergedRemote = false, branch = true, cleanupFails = true, mergeWrites = 0, closeWrites = 0, branchWrites = 0;
  const lease = { check() {}, close() {}, signal: new AbortController().signal, value: { credential: { accessToken: 'synthetic-app' } }, send: async (url, request) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/pulls/3/merge')) { mergeWrites++; mergedRemote = true; throw Error('lost synthetic merge reply'); }
    if (path.endsWith('/pulls/3')) return Response.json({ number: 3, state: mergedRemote ? 'closed' : 'open', merged: mergedRemote, merge_commit_sha: mergedRemote ? merged : null, draft: false, mergeable: true,
      head: { ref: 'issue/7-fixture', sha: head, repo: { id: 1, node_id: 'R1' } }, base: { ref: 'main', sha: snapshot.candidate.sourceCommit, repo: { id: 1, node_id: 'R1' } } });
    if (path.endsWith('/git/commits/' + head)) return Response.json({ sha: head, tree: { sha: candidate.gitTree } });
    if (path.endsWith('/git/commits/' + merged)) return Response.json({ sha: merged, tree: { sha: candidate.gitTree }, parents: [{ sha: snapshot.candidate.sourceCommit }, { sha: head }] });
    if (path.endsWith('/git/ref/heads/main')) return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: mergedRemote ? merged : snapshot.candidate.sourceCommit } });
    if (path.includes('/git/matching-refs/')) return Response.json(branch ? [{ ref: 'refs/heads/issue/7-fixture', object: { type: 'commit', sha: head } }] : []);
    if (path.includes('/git/refs/heads/') && request.method === 'DELETE') { branchWrites++; branch = false; return new Response(null, { status: 204 }); }
    if (path.endsWith('/issues/7') && request.method === 'PATCH') { closeWrites++; issue.state = 'CLOSED'; throw Error('lost synthetic close reply'); }
    throw Error('Unexpected closeout fixture route');
  } };
  const connections = { developers: () => [dev], status: () => ({}), acquire: async () => lease };
  const policy = openPolicyStore(root, { catalog: () => ({ repositories: [workspace.id], capabilities: developmentPermissions, maxConcurrency: 1, background: false,
    developers: [dev], connections: ['github', 'ollama'].map(id => ({ id, provider: id, repositories: [workspace.id], healthy: true })), extensions: [] }),
    inspectors: { repository: value => manager.observe(value), effect: action => manager.inspectIntegration(action), worker: binding => ({ ...binding, state: 'stopped', observedAt: Date.now() }) } });
  const ledger = openDevelopmentStore(root); let work;
  const supervisor = { status: () => ({ worker: 'stopped', pending: null, error: null }), attach() {}, control(binding, operation) {
    assert.equal(operation, 'pause'); policy.runtime.requestControl(binding, 'pause'); work = policy.runtime.verifyControl(binding); return { received: true }; },
    async settle() { await work; }, async cleanupRun() { if (cleanupFails) throw Error('Development owned cleanup failed.'); return { workspaceRemoved: true }; }, async shutdown() {} };
  manager = createDevelopmentManager({ store, policy, ledger, connections, supervisor, api: fixture.api });
  try {
    for (const [scope, target, changes] of [['host', null, { 'permissions.ceiling': developmentPermissions }], ['repository', workspace.id, { 'permissions.grants': developmentPermissions, 'agents.dev': dev.id, 'connections.github': 'github', 'connections.ollama': 'ollama' }]]) {
      const input = policy.control.capture({ commandId: scope + '-input', conversationId: 'qualification', target, text: 'Synthetic scoped test configuration.' });
      const preview = policy.control.prepare({ inputId: input.id, requestId: scope + '-preview', scope, target, conversationId: 'qualification', changes, reset: [] });
      policy.control.apply({ commandId: scope + '-apply', proposalId: preview.id, inputId: input.id, hash: preview.hash, conversationId: 'qualification', target });
    }
    const run = (await policy.runtime.reserve(identity, { commandId: 'reserve-fixture', issue: 7, pipeline: 'development' })).run, binding = { runId: run.id, epoch: run.epoch };
    ledger.create(run, { pipeline: policy.worker.read(workspace.id).values['pipelines.development'].value, source: snapshot.candidate,
      developer: { id: dev.id, connection: 'ollama', model: dev.model }, skillsHash: starterHash, issueHash: developmentIssueHash({ number: 7, title: issue.title, body: issue.body }), checks: [{ name: 'Synthetic check', command: 'node --test' }], logBytes: 1048576 });
    for (const kind of ['source', 'implementation', 'tests', 'review']) {
      ledger.begin(binding); const request = ledger.prepare(binding, kind, kind, {}); ledger.dispatch(binding, request.id);
      ledger.finish(binding, request.id, { candidate: snapshot.candidate, result: kind === 'tests' ? { name: 'Synthetic check', command: 'node --test', exitCode: 0 } : {} });
      ledger.advance(binding, { outcome: 'success', summary: 'Synthetic host orchestration evidence.', evidence: [request.id], documents: [], findings: [] });
    }
    ledger.begin(binding);
    const publication = store.prepare(run.id, 'pull-request', { kind: 'development', repository: workspace.id, candidate: snapshot.candidate }); store.dispatch(publication.id);
    store.finish(publication.id, 'verified', { number: 3, head, branch: 'issue/7-fixture', base: snapshot.candidate.sourceCommit, baseBranch: 'main' });
    ledger.offerQA(binding, { scope: 'issue', issue: 7, summary: 'Synthetic fixture.', findings: [], testResults: ['Synthetic check only.'], target: 'Synthetic unit fixture', prerequisites: [], steps: [{ action: 'Inspect fixture.', expected: 'Scoped change.' }],
      regressions: ['Local source unchanged.'], limitations: ['No Human QA or real GitHub.'], nextOutcome: 'Integrate exact tree and close fixture.', approvalPhrase: 'Approved', candidate });
    const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { isDestroyed: () => false, mainFrame: frame }, event = { sender: contents, senderFrame: frame };
    const channel = createDevelopmentControlChannel(manager, { contents, url: frame.url, context: () => ({ revision: manager.status().revision }) });
    channel.dispatch(event, { operation: 'chat', text: 'I approve this tested version.', contextRevision: manager.status().revision }); await manager.idle();
    assert.equal(mergeWrites, 1); assert.equal(closeWrites, 0); assert.equal(policy.runtime.status(workspace.id).control, 'paused'); assert.equal(ledger.status(run.id).qa.decision, 'approve');
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
