import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compareProjectSnapshot } from '../scripts/lib/validation.mjs';
import { collectConnection, fetchProjectSnapshot } from '../scripts/lib/project.mjs';

const blueprint = JSON.parse(await readFile(new URL('../blueprints/github-project.json', import.meta.url)));
const profile = JSON.parse(await readFile(new URL('../pipeliner.config.json', import.meta.url)));
const page = (nodes, more = false, cursor = null, totalCount = nodes.length) => ({ nodes, totalCount, pageInfo: { hasNextPage: more, endCursor: cursor } });

test('audit uses private adopter identity and configured field mappings, not working example', () => {
  const p = structuredClone(profile);
  p.repository = { ...p.repository, owner: 'someone', name: 'tool' };
  p.project = { ...p.project, owner: 'someone', title: 'My Tool', visibility: 'PRIVATE', statusField: 'Lane', statuses: { backlog: 'Queue', onHold: 'Paused', inProgress: 'Building', inReview: 'Testing', done: 'Shipped' } };
  const snapshot = { title: p.project.title, public: false, repositories: ['someone/tool'], fields: [{ name: 'Lane', options: Object.values(p.project.statuses) }, ...Object.values(p.project.metadataFields)], views: blueprint.views, workflows: blueprint.workflows };
  assert.deepEqual(compareProjectSnapshot(blueprint, snapshot, p), []);
  snapshot.public = true;
  assert.match(compareProjectSnapshot(blueprint, snapshot, p).join(), /visibility/);
  delete p.project.visibility;
  assert.deepEqual(compareProjectSnapshot(blueprint, snapshot, p), []);
  snapshot.repositories = [];
  assert.match(compareProjectSnapshot(blueprint, snapshot, p).join(), /repository/);
});

test('pagination collects every page and rejects incomplete, repeated or duplicate data', async () => {
  const pages = [page([{ id: 'a' }], true, 'next', 2), page([{ id: 'b' }], false, 'end', 2)];
  const cursors = [];
  assert.deepEqual(await collectConnection(async cursor => { cursors.push(cursor); return pages.shift(); }), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(cursors, [null, 'next']);
  await assert.rejects(collectConnection(async () => page([{ id: 'a' }], true, 'same', 3)), /duplicate|cursor/);
  await assert.rejects(collectConnection(async () => page([], false, null, 2)), /incomplete/);
  await assert.rejects(collectConnection(async () => null), /connection/);
  await assert.rejects(collectConnection(async () => page([null])), /node/);
});

test('user and organization Projects use verified node identity, with complete connections and readback', async () => {
  for (const type of ['User', 'Organization']) {
    const calls = [];
    const info = { id: 'project-id', number: profile.project.number, owner: { login: profile.project.owner, type }, title: profile.project.title, public: true, url: 'https://example.invalid/project' };
    const gh = async args => {
      calls.push(args);
      if (args[0] === 'project') return info;
      const query = args.find(x => x.startsWith('query='));
      assert.match(query, /node\(id:/);
      assert.doesNotMatch(query, /organization\(login:/);
      const key = ['fields', 'views', 'workflows', 'repositories'].find(k => query.includes(`${k}(first:`));
      return { data: { node: { [key]: page([]) } } };
    };
    const result = await fetchProjectSnapshot(profile, gh);
    assert.equal(result.snapshot.public, true);
    assert.equal(calls.filter(x => x[0] === 'project').length, 2);
    assert.deepEqual(result.snapshot.repositories, []);
  }
  await assert.rejects(fetchProjectSnapshot(profile, async () => { throw new Error('access denied'); }), /access denied/);
  await assert.rejects(fetchProjectSnapshot(profile, async () => ({ id: 'wrong', owner: { login: 'other' } })), /identity/);
});

test('Project retrieval rejects GraphQL partial responses and identity drift', async () => {
  const info = { id: 'project-id', number: profile.project.number, owner: { login: profile.project.owner, type: 'User' }, title: profile.project.title, public: false, url: 'https://example.invalid/project' };
  await assert.rejects(fetchProjectSnapshot(profile, async args => args[0] === 'project' ? info : { data: { node: {} }, errors: [{ message: 'denied' }] }), /partial/);
  let reads = 0;
  await assert.rejects(fetchProjectSnapshot(profile, async args => {
    if (args[0] === 'project') return ++reads === 1 ? info : { ...info, public: true };
    const query = args.find(x => x.startsWith('query='));
    const key = ['fields', 'views', 'workflows', 'repositories'].find(k => query.includes(`${k}(first:`));
    return { data: { node: { [key]: page([]) } } };
  }), /changed during audit/);
});
