import test from 'node:test';
import { openTestVault } from '../connections/test-vault.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStore } from './store.mjs';
import { createWorkspaceManager } from './manager.mjs';
import { definitions, planFields, verifyFields } from './github.mjs';

const completeFields = () => definitions.map((definition, i) => ({ id: 'F' + i, name: definition.role,
  options: definition.choices.map((name, n) => ({ id: 'O' + i + n, name, color: 'BLUE', description: '' })) }));
async function fixture() {
  const base = existsSync(join(homedir(), 'Documents')) ? join(homedir(), 'Documents') : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'pipeliner-36-test-'))), vault = await openTestVault(root), store = openWorkspaceStore(root, { vault });
  const owner = { id: 'ORG1', numericId: 2, login: 'fixture', type: 'Organization' };
  const repo = { id: 'R1', numericId: 3, owner, name: 'repo', slug: 'fixture/repo', displayName: 'fixture/repo', private: true, permissions: { pull: true } };
  let project = { id: 'P1', number: 1, title: 'Fixture', owner: { id: owner.id, login: owner.login }, public: false,
    repositories: [{ id: repo.id, nameWithOwner: repo.displayName }], fields: completeFields() };
  let epoch = 1, lost = false, writes = 0, clones = 0, connected = true;
  const connections = {
    status: () => ({ connections: [{ id: 'github', repositories: [{ id: repo.id, numericId: repo.numericId, name: repo.displayName, private: true, permissions: ['pull'] }] },
      { id: 'github-setup', owners: [{ id: owner.numericId, node: owner.id, login: owner.login, type: owner.type }] }] }),
    epoch: () => epoch,
    acquire: async id => { if (id === 'github' && !connected) throw new Error('connection-unavailable'); const controller = new AbortController();
      return { id, epoch, value: { account: { id: 1, node: 'U1' } }, signal: controller.signal, check() { if (controller.signal.aborted) throw new Error('connection-changed'); }, close: () => controller.abort() }; },
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  const api = {
    planFields, verifyFields, readRepository: async () => copy(repo), readOwner: async () => copy(owner), ownerRepositories: async () => [],
    listProjects: async () => [{ id: project.id, title: project.title }], readProject: async () => copy(project),
    applyField: async (_lease, _id, field) => { writes++; if (lost) throw new Error('write-result-uncertain');
      const result = { id: field.id ?? 'new-' + field.role, name: field.name, options: field.options.map((option, i) => ({ ...option, id: option.id ?? 'new-' + field.role + i })) };
      project.fields = [...project.fields.filter(existing => existing.id !== field.id), result]; return copy(result); },
    createRepository: async () => { writes++; return copy(repo); },
    createProject: async () => { writes++; project = { ...project, title: 'Pipeliner · repo' }; return copy(project); },
  };
  const inspect = async (_path, remote) => ({ identity: { repository: remote?.repository ?? 'unresolved', slug: repo.slug, checkoutRoot: root, localKey: '1:2', commonPath: join(root, '.git') }, changes: { tracked: 1, untracked: 1 }, slug: repo.slug });
  const manager = createWorkspaceManager({ store, connections, folder: async () => root, api, inspect, checkout: async () => { clones++; return inspect(root, { repository: 'repo-fixture' }); } });
  return { root, store, manager, repo, api, connections, get project() { return project; }, get writes() { return writes; },
    get clones() { return clones; }, connect: value => { connected = value; },
    drift: () => { project.title = 'Changed'; }, missing: () => { project.fields = project.fields.filter(field => field.name !== 'Effort'); },
    lose: () => { lost = true; }, disconnect: () => { epoch++; }, async close() { await manager.close(); store.close(); vault.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function preview(fixture) {
  const manager = fixture.manager;
  manager.dispatch({ operation: 'begin', mode: 'local' });
  manager.dispatch({ operation: 'folder' }); await manager.idle();
  manager.dispatch({ operation: 'prepare' }); await manager.idle();
  manager.dispatch({ operation: 'choose', field: 'project', value: 'P1' });
  manager.dispatch({ operation: 'prepare' }); await manager.idle();
  assert.equal(manager.status().draft.state, 'preview');
  return manager.status().draft.preview.hash;
}
test('exact PM setup imports once, preserves work and rejects remote drift or disconnected context', async () => {
  const f = await fixture();
  try {
    const hash = await preview(f);
    assert.throws(() => f.manager.dispatch({ operation: 'apply', hash: 'wrong' }), /setup-changed/);
    f.drift(); f.manager.dispatch({ operation: 'apply', hash }); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'failed'); assert.equal(f.writes, 0);
    f.manager.dispatch({ operation: 'prepare' }); await f.manager.idle();
    const fresh = f.manager.status().draft.preview.hash; f.disconnect();
    f.manager.dispatch({ operation: 'apply', hash: fresh }); await f.manager.idle(); assert.equal(f.writes, 0);
    f.manager.dispatch({ operation: 'prepare' }); await f.manager.idle();
    const current = f.manager.status().draft.preview.hash;
    f.manager.dispatch({ operation: 'apply', hash: current }); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'complete'); assert.equal(f.store.workspaces().length, 1);
    assert.deepEqual(f.store.workspaces()[0].changes, { tracked: 1, untracked: 1 }); assert.equal(f.writes, 0);
    f.manager.dispatch({ operation: 'apply', hash: current }); assert.equal(f.store.workspaces().length, 1);
  } finally { await f.close(); }
});
test('lost Project write blocks replay and remains uncertain after restart', async () => {
  const f = await fixture();
  try {
    f.missing(); const hash = await preview(f); f.lose();
    f.manager.dispatch({ operation: 'apply', hash }); await f.manager.idle();
    assert.equal(f.writes, 1); assert.equal(f.manager.status().draft.state, 'uncertain');
    f.manager.dispatch({ operation: 'repair' }); await f.manager.idle();
    assert.equal(f.writes, 1); assert.equal(f.store.pending().length, 1);
    await f.manager.close();
    const next = createWorkspaceManager({ store: f.store, connections: f.connections, folder: async () => f.root, api: f.api });
    try { assert.equal(next.status().draft.state, 'uncertain'); assert.equal(f.writes, 1); } finally { await next.close(); }
  } finally { await f.close(); }
});
test('explicit creation preserves its result through an installation block and continues without re-creation', async () => {
  const f = await fixture();
  try {
    f.connect(false);
    f.manager.dispatch({ operation: 'begin', mode: 'create', values: { owner: 'fixture', name: 'repo', purpose: 'Synthetic creation test' } });
    assert.match(f.manager.status().question.text, /Private or Public/);
    f.manager.dispatch({ operation: 'choose', field: 'visibility', value: 'private' });
    f.manager.dispatch({ operation: 'folder' }); await f.manager.idle();
    f.manager.dispatch({ operation: 'choose', field: 'project', value: 'new' });
    f.manager.dispatch({ operation: 'prepare' }); await f.manager.idle();
    const hash = f.manager.status().draft.preview.hash;
    f.manager.dispatch({ operation: 'apply', hash }); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'waiting-access'); assert.equal(f.writes, 2); assert.equal(f.clones, 0);
    assert.equal(f.store.effects(f.manager.status().draft.id).filter(effect => effect.state === 'verified').length, 2);
    f.connect(true); f.manager.dispatch({ operation: 'repair' }); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'complete'); assert.equal(f.writes, 2); assert.equal(f.clones, 1);
    f.manager.dispatch({ operation: 'apply', hash }); assert.equal(f.writes, 2); assert.equal(f.clones, 1);
  } finally { await f.close(); }
});

test('changing a source clears the old Project catalog and field mapping before any effect', async () => {
  const f = await fixture();
  try {
    await preview(f); f.manager.dispatch({ operation: 'map', role: 'Status', field: 'F0' });
    f.manager.dispatch({ operation: 'choose', field: 'source', value: 'local' });
    const draft = f.manager.status().draft;
    for (const key of ['projects', 'projectSnapshot', 'project', 'repo', 'owner', 'inspected', 'folder']) assert.equal(draft[key], undefined);
    assert.deepEqual(draft.mapping, {}); assert.equal(draft.preview, null); assert.equal(draft.values.project, undefined);
    assert.match(f.manager.status().question.text, /Choose the existing project folder/); assert.equal(f.writes, 0);
    assert.throws(() => f.manager.dispatch({ operation: 'choose', field: 'project', value: 'P1' }), /project-unavailable/);
  } finally { await f.close(); }
});

test('a failure after verified remote creation retains exact recovery and blocks target edits', async () => {
  const f = await fixture();
  try {
    f.api.readProject = async () => { throw new Error('http-503'); };
    f.manager.dispatch({ operation: 'begin', mode: 'create', values: { owner: 'fixture', name: 'repo', purpose: 'Synthetic recovery', visibility: 'private' } });
    f.manager.dispatch({ operation: 'folder' }); await f.manager.idle();
    f.manager.dispatch({ operation: 'choose', field: 'project', value: 'new' });
    f.manager.dispatch({ operation: 'prepare' }); await f.manager.idle();
    const hash = f.manager.status().draft.preview.hash;
    f.manager.dispatch({ operation: 'apply', hash }); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'recovery-required'); assert.equal(f.writes, 2);
    assert.equal(f.manager.status().draft.preview.hash, hash);
    assert.throws(() => f.manager.dispatch({ operation: 'choose', field: 'name', value: 'other' }), /setup-busy/);
    f.api.readProject = async () => JSON.parse(JSON.stringify(f.project));
    f.manager.dispatch({ operation: 'repair' }); await f.manager.idle();
    assert.equal(f.manager.status().draft.state, 'complete'); assert.equal(f.writes, 2); assert.equal(f.clones, 1);
  } finally { await f.close(); }
});

test('remote identity change during checkout blocks registration without repeating creation or clone', async () => {
  const f = await fixture();
  try {
    f.api.readRepository = async () => ({ ...f.repo, id: f.clones ? 'replacement-repository' : f.repo.id });
    f.manager.dispatch({ operation: 'begin', mode: 'create', values: { owner: 'fixture', name: 'repo', purpose: 'Synthetic drift', visibility: 'private' } });
    f.manager.dispatch({ operation: 'folder' }); await f.manager.idle();
    f.manager.dispatch({ operation: 'choose', field: 'project', value: 'new' });
    f.manager.dispatch({ operation: 'prepare' }); await f.manager.idle();
    f.manager.dispatch({ operation: 'apply', hash: f.manager.status().draft.preview.hash }); await f.manager.idle();
    assert.equal(f.manager.status().draft.error, 'setup-changed'); assert.equal(f.manager.status().draft.state, 'recovery-required');
    assert.equal(f.store.workspaces().length, 0); assert.equal(f.writes, 2); assert.equal(f.clones, 1);
    f.manager.dispatch({ operation: 'repair' }); await f.manager.idle();
    assert.equal(f.store.workspaces().length, 0); assert.equal(f.writes, 2); assert.equal(f.clones, 1);
  } finally { await f.close(); }
});
