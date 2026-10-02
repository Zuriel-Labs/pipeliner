import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { sourceTree } from './source.mjs';
import { publishDevelopmentCandidate } from './github.mjs';

const objectHash = (kind, value) => { const bytes = Buffer.from(value); return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex'); };
test('scoped publication reconciles a lost branch and PR reply without replay; wrong candidate readback blocks', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-github-'))), store = openWorkspaceStore(root);
  const source = [{ path: 'app.mjs', mode: '100644', content: Buffer.from('export const value = 1;\n').toString('base64') }], files = [{ ...source[0], content: Buffer.from('export const value = 2;\n').toString('base64') }];
  const workspace = { id: 'repo-one', repositoryId: 'R1', numericId: 1, slug: 'fixture/repo', private: true };
  const run = { id: 'run-one', repository: workspace.id, issue: 7, epoch: 1, createdAt: 1700000000000 };
  const candidate = { sourceCommit: 'a'.repeat(40), gitTree: sourceTree(files) }, captured = { source: { sourceCommit: candidate.sourceCommit, gitTree: sourceTree(source) }, run,
    checks: [{ name: 'Fixture check', command: 'node --test' }] };
  const history = [];
  const ledger = { status: () => ({ state: 'candidate', candidate, qaHistory: history }), captured: () => captured,
    outputs: () => [{ candidate, output: { outcome: 'success', documents: ['research', 'specification', 'design', 'review'].map(kind => ({ kind, title: kind, paragraphs: ['Fixture evidence.'] })), findings: [] } }],
    evidence: () => [{ id: 'check', kind: 'tests', state: 'verified', result: { candidate, result: { name: 'Fixture check', command: 'node --test', exitCode: 0 } } },
      { id: 'review', kind: 'review', state: 'verified', result: { candidate, result: {} } }] };
  const profile = { repository: { defaultBranch: 'main' }, workflow: { branchPattern: 'issue/{number}-{slug}' }, quality: { requiredChecks: [] } };
  let branch, pull, commit, wrong = false, branchWrites = 0, pullWrites = 0; const objects = new Map();
  const send = async (url, request) => {
    const path = new URL(url).pathname, body = request.body ? JSON.parse(request.body) : null, post = request.method === 'POST';
    assert.equal(request.headers.Authorization, 'Bearer synthetic-scoped-app-credential');
    if (path === '/repos/fixture/repo') return Response.json({ id: 1, node_id: 'R1', full_name: 'fixture/repo', name: 'repo', private: true, archived: false, disabled: false, has_issues: true,
      owner: { id: 2, node_id: 'U2', type: 'User', login: 'fixture' }, default_branch: 'main', permissions: { pull: true, push: true } });
    if (path.endsWith('/git/ref/heads/main')) return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: candidate.sourceCommit } });
    if (path.endsWith('/git/commits/' + candidate.sourceCommit)) return Response.json({ sha: candidate.sourceCommit, tree: { sha: captured.source.gitTree } });
    if (path.endsWith('/git/blobs') && post) { const sha = objectHash('blob', Buffer.from(body.content, 'base64')); objects.set(sha, body); return Response.json({ sha }); }
    if (path.includes('/git/blobs/')) { const sha = path.split('/').at(-1), value = objects.get(sha); return value ? Response.json({ sha, content: value.content, encoding: 'base64' }) : Response.json({}, { status: 404 }); }
    if (path.endsWith('/git/trees') && post) { objects.set(candidate.gitTree, body); return Response.json({ sha: candidate.gitTree }); }
    if (path.includes('/git/trees/')) return Response.json({ sha: path.split('/').at(-1), truncated: false, tree: objects.get(candidate.gitTree).tree });
    if (path.endsWith('/git/commits') && post) {
      const seconds = Date.parse(body.author.date) / 1000;
      const text = `tree ${body.tree}\nparent ${body.parents[0]}\nauthor ${body.author.name} <${body.author.email}> ${seconds} +0000\ncommitter ${body.committer.name} <${body.committer.email}> ${seconds} +0000\n\n${body.message}`;
      commit = { ...body, sha: objectHash('commit', text), tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })) }; return Response.json(commit);
    }
    if (path.includes('/git/commits/')) return Response.json({ ...commit, message: commit.message.replace(/\n$/, '') });
    if (path.endsWith('/git/refs') && post) { branchWrites++; branch = { ref: body.ref, object: { type: 'commit', sha: body.sha } }; throw new Error('lost synthetic branch reply'); }
    if (path.includes('/git/refs/heads/') && request.method === 'PATCH') {
      assert.equal(body.force, false); branchWrites++; branch.object.sha = body.sha; pull.head.sha = body.sha; throw new Error('lost synthetic updated branch reply');
    }
    if (path.includes('/git/ref/heads/')) return branch ? Response.json(branch) : Response.json({}, { status: 404 });
    if (path.endsWith('/pulls') && !post) return Response.json(pull ? [pull] : []);
    if (path.endsWith('/pulls') && post) {
      pullWrites++; pull = { number: 3, state: 'open', title: body.title, body: body.body, html_url: 'https://github.com/fixture/repo/pull/3',
        head: { ref: body.head, sha: commit.sha, repo: { id: 1, node_id: 'R1' } }, base: { ref: body.base, sha: candidate.sourceCommit, repo: { id: 1, node_id: 'R1' } } }; throw new Error('lost synthetic PR reply');
    }
    if (path.endsWith('/pulls/3') && request.method === 'PATCH') { pullWrites++; Object.assign(pull, body); throw new Error('lost synthetic updated PR reply'); }
    if (path.endsWith('/pulls/3')) return Response.json({ ...pull, head: { ...pull.head, sha: wrong ? 'f'.repeat(40) : pull.head.sha } });
    throw new Error('unexpected synthetic request');
  };
  const lease = { id: 'github', check() {}, signal: new AbortController().signal, send, value: { credential: { accessToken: 'synthetic-scoped-app-credential' }, account: { id: 2, login: 'fixture' },
    view: { repositories: [{ id: 'R1', numericId: 1, name: 'fixture/repo', private: true, permissions: ['pull', 'push'] }] } } };
  try {
    const input = { store, ledger, lease, workspace, run, source, files, profile, title: 'Change fixture value', authority() {} };
    const result = await publishDevelopmentCandidate(input);
    assert.equal(result.pullRequest.number, 3); assert.equal(result.candidate.gitTree, candidate.gitTree); assert.equal(result.candidate.sourceCommit, commit.sha);
    assert.equal(branchWrites, 1); assert.equal(pullWrites, 1); assert.ok(pull.body.includes('Refs #7')); assert.ok(pull.body.includes('color-scheme'));
    await publishDevelopmentCandidate(input); assert.equal(branchWrites, 1); assert.equal(pullWrites, 1);
    const formerHead = commit.sha; history.push({ decision: 'feedback' }); files[0].content = Buffer.from('export const value = 3;\n').toString('base64'); candidate.gitTree = sourceTree(files);
    const updated = await publishDevelopmentCandidate(input);
    assert.equal(updated.pullRequest.number, result.pullRequest.number); assert.equal(updated.pullRequest.branch, result.pullRequest.branch);
    assert.equal(commit.parents[0].sha, formerHead); assert.equal(branchWrites, 2); assert.equal(pullWrites, 2);
    await publishDevelopmentCandidate(input); assert.equal(branchWrites, 2); assert.equal(pullWrites, 2);
    wrong = true; await assert.rejects(publishDevelopmentCandidate(input), /readback|candidate/);
    assert.equal(branchWrites, 2); assert.equal(pullWrites, 2); assert.equal(store.effects(run.id).every(effect => effect.state === 'verified'), true);
  } finally { store.close(); rmSync(root, { recursive: true }); }
});
