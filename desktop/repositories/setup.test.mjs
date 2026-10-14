import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, chmodSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planFields, verifyFields, readOwner, createRepository, readRepository, applyField } from './github.mjs';
import { openWorkspaceStore } from './store.mjs';
import { inspectLocal } from './local.mjs';
import { setupCommand } from './commands.mjs';
import { createWorkspaceControlChannel } from '../core/control.mjs';
import { openTestVault } from '../connections/test-vault.mjs';

test('setup field additions preserve existing option IDs and detect post-preview drift', () => {
  const existing = [{ id: 'F1', name: 'Status', options: [
    { id: 'S1', name: 'Backlog', color: 'GRAY', description: 'Existing description' },
    { id: 'S2', name: 'Custom', color: 'RED', description: 'Keep me' },
  ] }, { id: 'F2', name: 'Stage', options: [{ id: 'X1', name: 'Done', color: 'GREEN', description: '' }] }];
  const plan = planFields(existing);
  assert.deepEqual(plan[0].options.slice(0, 2), existing[0].options);
  assert.equal(plan[0].options.find(x => x.name === 'Pending Review').id, undefined);
  assert.equal(plan[1].id, null);
  assert.throws(() => planFields([...existing, { ...existing[0], id: 'duplicate' }]), /field-conflict/);
  assert.equal(planFields(existing, { Status: 'F2' })[0].id, 'F2');
  const actual = plan.map((field, i) => ({ ...field, id: field.id ?? 'new' + i,
    options: field.options.map((option, n) => ({ ...option, id: option.id ?? 'added' + i + n })) }));
  assert.equal(verifyFields(actual, plan), true);
  actual[0].options[0].id = 'changed'; assert.throws(() => verifyFields(actual, plan), /readback-mismatch/);
});

test('workspace journal blocks duplicate or uncertain effects across restart and canonical aliases', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-setup-store-'))); chmodSync(root, 0o700);
  const vault = await openTestVault(root); let store = openWorkspaceStore(root, { vault });
  try {
    store.saveDraft({ id: 'draft-1', state: 'preview', target: 'fixture/repo' });
    const effect = store.prepare('draft-1', 'create-project', { owner: 'O1', title: 'Fixture' });
    assert.equal(store.dispatch(effect.id), true); assert.equal(store.dispatch(effect.id), false);
    store.finish(effect.id, 'uncertain'); store.close(); store = openWorkspaceStore(root, { vault });
    assert.equal(store.effects('draft-1')[0].state, 'uncertain');
    assert.throws(() => store.prepare('draft-1', 'create-project', { owner: 'O1', title: 'Changed' }), /effect-conflict/);
    assert.equal(store.prepare('draft-1', 'create-project', { owner: 'O1', title: 'Fixture' }).state, 'uncertain');
    const workspace = { id: 'repo-one', repositoryId: 'MDEwOlJlcG9zaXRvcnkx=', slug: 'fixture/repo', localKey: '1:2', path: '/synthetic/repo', project: { id: 'P1' } };
    store.register(workspace); assert.equal(store.register(workspace).created, false);
    assert.throws(() => store.register({ ...workspace, id: 'repo-two', repositoryId: 'R2', slug: 'other/repo' }), /workspace-conflict/);
    assert.throws(() => store.register({ ...workspace, localKey: '3:4' }), /workspace-conflict/);
    assert.equal(store.workspaces().length, 1);
  } finally { store.close(); vault.close(); rmSync(root, { recursive: true, force: true }); }
});

test('actual local inspection preserves dirty work, validates both origins, and canonicalizes worktrees', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-setup-git-')));
  const checkout = join(root, 'repo'), alias = join(root, 'worktree'); mkdirSync(checkout);
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], { stdio: 'pipe' });
  try {
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Synthetic']); git(['config', 'user.email', 'synthetic@example.invalid']);
    writeFileSync(join(checkout, 'tracked'), 'initial'); git(['add', 'tracked']); git(['commit', '-m', 'fixture']);
    git(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
    writeFileSync(join(checkout, 'tracked'), 'modified'); writeFileSync(join(checkout, 'untracked'), 'preserve');
    const selected = { repository: 'repo-one', owner: 'fixture', name: 'repo' };
    const before = git(['status', '--porcelain=v1']).toString();
    const inspected = await inspectLocal(checkout, selected);
    assert.equal(inspected.identity.slug, 'fixture/repo'); assert.equal(inspected.changes.tracked, 1); assert.equal(inspected.changes.untracked, 1);
    assert.equal(git(['status', '--porcelain=v1']).toString(), before); assert.equal(readFileSync(join(checkout, 'tracked'), 'utf8'), 'modified');
    git(['worktree', 'add', '-b', 'fixture-alias', alias]);
    assert.equal((await inspectLocal(alias, selected)).identity.localKey, inspected.identity.localKey);
    git(['config', 'remote.origin.pushurl', 'https://github.com/other/repo.git']);
    await assert.rejects(inspectLocal(checkout, selected), /local-identity-invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('setup commands require explicit visibility and registered current PM origin', () => {
  assert.equal(setupCommand('Create a private project').values.visibility, 'private');
  assert.equal(setupCommand('Create a project').values.visibility, undefined);
  assert.equal(setupCommand('Import fixture/repo').values.repository, 'fixture/repo');
  assert.equal(setupCommand('"Create a private project"'), null);
  assert.equal(setupCommand('Apply this setup').operation, 'apply');
  const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { isDestroyed: () => false, mainFrame: frame };
  const calls = [], manager = { status: () => ({ revision: 7 }), dispatch: payload => calls.push(payload) };
  const channel = createWorkspaceControlChannel(manager, { contents, url: frame.url, context: () => ({ revision: 7 }) });
  const event = { sender: contents, senderFrame: frame }, payload = { operation: 'begin', mode: 'create', contextRevision: 7 };
  channel.dispatch(event, payload); assert.equal(calls.length, 1);
  for (const [e, p] of [[{ ...event, senderFrame: { ...frame } }, payload], [event, { ...payload, contextRevision: 6 }], [event, { ...payload, path: '/forged' }], [event, { ...payload, token: 'secret' }]]) assert.throws(() => channel.dispatch(e, p));
});

test('typed setup transport binds creation, scoped access and preserved option IDs to exact requests/readback', async () => {
  const owner = { id: 'ORG1', numericId: 2, login: 'fixture', type: 'Organization' }, calls = [];
  const repository = { id: 3, node_id: 'R1', owner: { id: 2, node_id: 'ORG1', login: 'fixture', type: 'Organization' },
    name: 'repo', full_name: 'fixture/repo', private: true, archived: false, disabled: false, has_issues: true, default_branch: 'main', permissions: { pull: true } };
  const controller = new AbortController(); let alterIdentity = false;
  const lease = { id: 'github-setup', signal: controller.signal, check: () => controller.signal.throwIfAborted(),
    value: { credential: { accessToken: 'synthetic-host-only' }, account: { id: 1 }, view: { owners: [{ id: 2, node: 'ORG1', login: 'fixture', type: 'Organization' }], repositories: [] } },
    send: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.github.com'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-host-only');
      const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
      calls.push({ route, method: options.method, body });
      if (route === '/users/fixture') return Response.json(repository.owner);
      if (route === '/user/memberships/orgs/fixture') return Response.json({ state: 'active', role: 'member', organization: { id: 2 } });
      if (route === '/orgs/fixture/repos' || route === '/repos/fixture/repo') return Response.json(repository);
      assert.equal(route, '/graphql'); assert.match(body.query, /updateProjectV2Field/);
      return Response.json({ data: { updateProjectV2Field: { projectV2Field: { id: body.variables.id, name: 'Status',
        options: body.variables.options.map((option, i) => ({ ...option, id: alterIdentity ? 'changed-' + i : option.id ?? 'added-' + i })) } } } });
    } };
  assert.deepEqual(await readOwner(lease, 'fixture'), owner);
  const repo = await createRepository(lease, owner, { name: 'repo', purpose: 'Synthetic transport test', visibility: 'private' });
  assert.equal(repo.id, 'R1');
  assert.deepEqual(calls.find(call => call.method === 'POST' && call.route === '/orgs/fixture/repos').body,
    { name: 'repo', description: 'Synthetic transport test', private: true, auto_init: true, has_issues: true });
  await assert.rejects(readRepository({ ...lease, id: 'github' }, 'fixture/repo'), /installation-access-required/);
  const field = planFields([{ id: 'F1', name: 'Status', options: [{ id: 'S1', name: 'Backlog', color: 'GRAY', description: 'Keep' }] }])[0];
  await applyField(lease, 'P1', field);
  assert.deepEqual(calls.at(-1).body.variables.options[0], { id: 'S1', name: 'Backlog', color: 'GRAY', description: 'Keep' });
  alterIdentity = true; await assert.rejects(applyField(lease, 'P1', field), /readback-mismatch/);
  controller.abort(); const count = calls.length; await assert.rejects(readRepository(lease, 'fixture/repo')); assert.equal(calls.length, count);
});
