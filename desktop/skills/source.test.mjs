import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { discoverSkill, discoverSkillLink } from './source.mjs';

const hash = content => createHash('sha1').update('blob ' + Buffer.byteLength(content) + '\0').update(content).digest('hex');
function fixture(change = () => {}) {
  const commit = 'a'.repeat(40), root = 'b'.repeat(40), folder = 'c'.repeat(40);
  const contents = ['---\nname: motif\ndescription: Design original accessible UI\nlicense: MIT\n---\nCheck the actual controls.', 'MIT License\nSynthetic fixture.'];
  const data = {
    ['/git/commits/' + commit]: { sha: commit, tree: { sha: root } },
    ['/git/trees/' + root]: { sha: root, truncated: false, tree: [{ path: 'motif', mode: '040000', type: 'tree', sha: folder }] },
    ['/git/trees/' + folder]: { sha: folder, truncated: false, tree: contents.map((body, i) => ({ path: i ? 'LICENSE' : 'SKILL.md', mode: '100644', type: 'blob', sha: hash(body), size: Buffer.byteLength(body) })) },
    ...Object.fromEntries(contents.map(body => ['/git/blobs/' + hash(body), { sha: hash(body), encoding: 'base64', size: Buffer.byteLength(body), content: Buffer.from(body).toString('base64') }])),
  }; change(data, { commit, root, folder }); const calls = [];
  return { source: { repository: 'fixture/skills', commit, path: 'motif' }, calls, send: async (url, options) => {
    calls.push({ url, options }); const path = new URL(url).pathname.replace('/repos/fixture/skills', '');
    assert.ok(data[path], 'fixed Git object endpoint'); return new Response(JSON.stringify(data[path]));
  } };
}

test('public discovery validates immutable source and blobs without account credentials or installation', async () => {
  const f = fixture(), pack = await discoverSkill(f.source, { send: f.send });
  assert.equal(pack.source.commit, f.source.commit); assert.equal(pack.name, 'motif');
  assert.equal(f.calls.length, 5); assert.equal(f.calls.every(call => !Object.keys(call.options.headers).some(key => key.toLowerCase() === 'authorization')), true);
  assert.equal(f.calls.every(call => call.options.method === 'GET' && call.options.redirect === 'error' && call.options.signal), true);
});

test('truncated trees, foreign identities, links, executables, dependency hooks and changed blob bytes fail', async () => {
  for (const mutate of [
    (data, { root }) => { data['/git/trees/' + root].truncated = true; },
    (data, { commit }) => { data['/git/commits/' + commit].sha = 'd'.repeat(40); },
    (data, { folder }) => { data['/git/trees/' + folder].tree[0].mode = '120000'; },
    (data, { folder }) => { data['/git/trees/' + folder].tree[0].mode = '100755'; },
    (data, { folder }) => { data['/git/trees/' + folder].tree[0].path = 'package.json'; },
    data => { const blob = Object.values(data).find(item => item.encoding === 'base64'); blob.content = Buffer.from('substituted').toString('base64'); },
  ]) { const f = fixture(mutate); await assert.rejects(discoverSkill(f.source, { send: f.send }), /Skill/); }
});

test('source bounds, cancel, HTTP failure and unsupported redirect do not become partial packages', async () => {
  const f = fixture(); await assert.rejects(discoverSkill({ ...f.source, commit: 'main' }, { send: f.send }), /Skill/); assert.equal(f.calls.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverSkill(f.source, { send: f.send, signal: controller.signal }), /cancelled/); assert.equal(f.calls.length, 0);
  await assert.rejects(discoverSkill(f.source, { send: async () => new Response('', { status: 403 }) }), /http-403/);
  await assert.rejects(discoverSkill(f.source, { send: async () => { throw new TypeError('foreign redirect'); } }), /Skill/);
});

test('ordinary folder links resolve once, then every content read uses the exact immutable commit', async () => {
  const f = fixture(), calls = [], send = async (url, options) => {
    calls.push(url); if (new URL(url).pathname === '/repos/fixture/skills/commits/main') { assert.equal(Object.hasOwn(options.headers, 'Authorization'), false); return new Response(JSON.stringify({ sha: f.source.commit })); }
    return f.send(url, options);
  };
  const pack = await discoverSkillLink('https://github.com/fixture/skills/tree/main/motif', { send });
  assert.equal(pack.source.commit, f.source.commit); assert.equal(calls.filter(url => url.endsWith('/main')).length, 1);
  for (const link of ['http://github.com/fixture/skills/tree/main/motif', 'https://evil.test/fixture/skills/tree/main/motif',
    'https://github.com/fixture/skills/tree/main/../motif', 'https://github.com/fixture/skills/tree/main/motif?token=secret',
    'https://github.com/fixture/skills/tree/main/motif#instructions']) await assert.rejects(discoverSkillLink(link, { send }), /Skill link/);
  assert.equal(calls.length, 6);
});
