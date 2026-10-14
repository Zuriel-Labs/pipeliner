import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('host policy catalog uses one fresh protected workspace snapshot and preserves live scoped authority', () => {
  const source = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8');
  const start = source.indexOf('policy = openPolicyStore(directory, { catalog: '), end = source.indexOf('\n      inspectors:', start);
  assert(start >= 0 && end > start);
  const expression = source.slice(start + 'policy = openPolicyStore(directory, { catalog: '.length, end).trim().replace(/,$/, '');
  let reads = 0, denied = false, qualified = false;
  const workspaces = Array.from({ length: 25 }, (_, i) => ({ id: 'Repo' + i, repositoryId: 'Remote' + i }));
  const connections = [{ id: 'github', health: 'connected', repositories: [{ id: 'Remote0' }] },
    { id: 'github-setup', health: 'limited', repositories: [{ id: 'Remote1' }] },
    { id: 'codex', health: 'disconnected' }, { id: 'ollama', health: 'connected' }];
  const developers = [{ id: 'Dev', connection: 'ollama', metrics: [] }], extensions = [{ id: 'Skill', digest: 'a'.repeat(64) }],
    tools = [{ id: 'Tool', digest: 'b'.repeat(64) }];
  const catalog = runInNewContext('(' + expression + ')', {
    workspaceStore: { workspaces() { reads++; if (denied) throw Error('protected-record-invalid'); return structuredClone(workspaces); } },
    hostCapabilities: ['workspace.read'], backgroundNative: { inspect: () => ({ qualified }) },
    manager: { status: () => ({ connections: structuredClone(connections) }), developers: () => structuredClone(developers) },
    skillStore: { catalog: () => structuredClone(extensions) }, toolStore: { catalog: () => structuredClone(tools) },
    trustedUpdateSources: [{ id: 'OfficialSource' }],
  }, { timeout: 1000 });
  const read = () => { reads = 0; const value = structuredClone(catalog()); assert.equal(reads, 1); return value; };
  const first = read();
  assert.deepEqual(first.repositories, workspaces.map(item => item.id));
  assert.deepEqual(first.connections.map(item => [item.id, item.provider, item.healthy, item.repositories.length]),
    [['github', 'github', true, 1], ['github-setup', 'github', true, 1], ['codex', 'codex', false, 25], ['ollama', 'ollama', true, 25]]);
  assert.deepEqual(first.connections[0].repositories, ['Repo0']); assert.deepEqual(first.connections[1].repositories, ['Repo1']);
  assert.deepEqual(first.developers, developers); assert.deepEqual(first.extensions, extensions); assert.deepEqual(first.tools, tools);
  assert.deepEqual(first.updateSources, ['OfficialSource']); assert.equal(first.maxConcurrency, 1); assert.equal(first.background, false);
  workspaces.splice(0, 1); workspaces.push({ id: 'NewRepo', repositoryId: 'NewRemote' });
  connections[0].repositories = [{ id: 'NewRemote' }]; connections[3].health = 'blocked'; qualified = true;
  const next = read(); assert.deepEqual(next.connections[0].repositories, ['NewRepo']); assert.equal(next.repositories.includes('Repo0'), false);
  assert.equal(next.connections[3].healthy, false); assert.equal(next.background, true);
  first.repositories.splice(0); assert.equal(read().repositories.length, 25);
  denied = true; assert.throws(read, /protected-record-invalid/); assert.equal(reads, 1);
});
