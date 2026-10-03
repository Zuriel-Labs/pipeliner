import { createHash } from 'node:crypto';
import { canonicalJSON } from '../core/settings.mjs';
import { githubRequest, readRepository } from '../repositories/github.mjs';
import { checkedFiles, changedFiles, sourceTree } from './source.mjs';
import { documentHTML } from './state.mjs';

const objectHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const blob = file => objectHash('blob', Buffer.from(file.content, 'base64'));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const ref = value => typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_-][A-Za-z0-9_./-]*[A-Za-z0-9_-]$/.test(value)
  && !value.includes('..') && !value.includes('//') && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));

export function candidateJob(ledger, run, previous = false) {
  const round = (ledger.status(run.id).qaHistory ?? []).filter(row => row.decision === 'feedback').length - Number(previous);
  return round > 0 ? run.id + '-candidate-' + round : run.id;
}
export function developmentPublication(store, ledger, run, previous = false) {
  const effect = store.effects(candidateJob(ledger, run, previous)).find(effect => effect.step === 'pull-request' && effect.state === 'verified');
  return effect ? { ...effect.result, baseBranch: effect.result.baseBranch ?? effect.binding.payload?.base, candidate: { sourceCommit: effect.result.head, gitTree: effect.binding.candidate.gitTree } } : null;
}

export function candidateEvidence(ledger, run, source, files) {
  const captured = ledger.captured(run.id), state = ledger.status(run.id), records = ledger.evidence({ runId: run.id, epoch: run.epoch }), outputs = ledger.outputs(run.id);
  checkedFiles(source); checkedFiles(files);
  if (!['candidate', 'integration-required'].includes(state.state) || run.repository !== captured.run.repository || run.issue !== captured.run.issue
    || sourceTree(source) !== captured.source.gitTree || sourceTree(files) !== state.candidate.gitTree || state.candidate.sourceCommit !== captured.source.sourceCommit
    || records.some(record => ['prepared', 'dispatched', 'uncertain'].includes(record.state))) throw new Error('Development candidate is not ready');
  changedFiles(source, files);
  const matches = row => canonicalJSON(row.candidate) === canonicalJSON(state.candidate);
  if (!['research', 'specification', 'design'].every(kind => outputs.some(row => row.output.outcome === 'success' && row.output.documents.some(document => document.kind === kind)))) throw new Error('Development plan evidence unavailable');
  if (!outputs.some(row => matches(row) && row.output.outcome === 'success' && row.output.documents.some(document => document.kind === 'review')
    && !row.output.findings.some(finding => ['high', 'critical'].includes(finding.severity)))
    || !records.some(row => row.kind === 'review' && row.state === 'verified' && matches(row.result))) throw new Error('Current candidate review unavailable');
  for (const check of captured.checks) if (!records.some(row => row.kind === 'tests' && row.state === 'verified' && matches(row.result)
    && row.result.result.name === check.name && row.result.result.command === check.command && row.result.result.exitCode === 0
    && row.result.result.truncated !== true && row.result.result.timedOut !== true)) throw new Error('Current candidate checks unavailable');
  return { candidate: state.candidate, checks: captured.checks.map(check => check.name), summaries: outputs.map(row => row.output.summary).filter(value => typeof value === 'string') };
}

// Git data and an owned ref only. No arbitrary host Git command, hooks or credential helper.
export async function publishDevelopmentCandidate({ store, ledger, lease, workspace, run, source, files, profile, title, authority }) {
  const evidence = candidateEvidence(ledger, run, source, files), captured = ledger.captured(run.id), prefix = '/repos/' + workspace.slug;
  const job = candidateJob(ledger, run), previous = job === run.id ? null : store.effects(candidateJob(ledger, run, true)).find(effect => effect.step === 'pull-request' && effect.state === 'verified');
  if (job !== run.id && !previous) throw new Error('Development prior candidate publication unavailable');
  if (lease.id !== 'github' || typeof authority !== 'function' || typeof title !== 'string' || !title.trim() || title.length > 240 || /[\u0000-\u001f]/.test(title)) throw new Error('Development publication denied');
  const current = () => { lease.check(); authority(); };
  current(); const repository = await readRepository(lease, workspace.slug);
  if (repository.id !== workspace.repositoryId || repository.numericId !== workspace.numericId || repository.private !== workspace.private || repository.permissions.push !== true
    || repository.defaultBranch !== profile.repository.defaultBranch || !ref(repository.defaultBranch)) throw new Error('Development publication repository changed');
  const request = async (method, path, body) => { current(); const result = await githubRequest(lease, method, prefix + path, body); current(); return result; };
  const base = async () => {
    const value = await request('GET', '/git/ref/heads/' + encodeURIComponent(repository.defaultBranch));
    if (value.ref !== 'refs/heads/' + repository.defaultBranch || value.object?.type !== 'commit' || value.object.sha !== captured.source.sourceCommit) throw new Error('Development base candidate changed');
    return value.object.sha;
  };
  await base(); const original = await request('GET', '/git/commits/' + captured.source.sourceCommit);
  if (original.sha !== captured.source.sourceCommit || original.tree?.sha !== captured.source.gitTree) throw new Error('Development source readback mismatch');
  const stem = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'change';
  const pattern = profile.workflow.branchPattern;
  if (typeof pattern !== 'string' || !pattern.includes('{number}') || !pattern.includes('{slug}')) throw new Error('Development branch pattern unavailable');
  const branch = pattern.replaceAll('{number}', String(run.issue)).replaceAll('{slug}', stem + '-' + run.id.replaceAll('-', '').slice(0, 12));
  if (!ref(branch) || branch === repository.defaultBranch) throw new Error('Development branch invalid');
  async function effect(step, payload, mutate, inspect) {
    current();
    const binding = { kind: 'development', repository: run.repository, repositoryId: workspace.repositoryId, runId: run.id, issue: run.issue,
      source: captured.source, candidate: evidence.candidate, branch, payload };
    const before = store.prepare(job, step, binding);
    if (before.state === 'verified') return inspect(before.result);
    if (before.state === 'denied') throw new Error('Development remote effect requires explicit recovery');
    if (store.pending('development').some(value => value.binding.repository === run.repository && value.id !== before.id)) throw new Error('Another Development remote effect needs recovery');
    if (before.state === 'prepared') {
      await base(); current();
      if (!store.dispatch(before.id)) throw new Error('Development effect dispatch changed');
      try { const result = await mutate(); store.checkpoint(before.id, result); }
      catch (error) { if (error.message !== 'write-result-uncertain') { store.finish(before.id, 'uncertain', { error: 'remote-effect-not-verified' }); throw error; } }
    }
    try {
      const known = store.effects(job).find(value => value.id === before.id).result, result = await inspect(known); current();
      store.finish(before.id, 'verified', result); return result;
    } catch (error) {
      store.finish(before.id, 'uncertain', { error: 'remote-effect-readback-required' }); throw error;
    }
  }
  for (const file of changedFiles(source, files).filter(file => file.content !== null)) {
    const expected = blob(file);
    await effect('blob-' + expected, { path: file.path, sha: expected }, async () => {
      const result = await request('POST', '/git/blobs', { content: file.content, encoding: 'base64' });
      if (result.sha !== expected) throw new Error('Development blob readback mismatch'); return { sha: expected };
    }, async () => {
      const result = await request('GET', '/git/blobs/' + expected), content = typeof result.content === 'string' ? result.content.replaceAll('\n', '') : '';
      if (result.sha !== expected || result.encoding !== 'base64' || content !== file.content || objectHash('blob', Buffer.from(content, 'base64')) !== expected) throw new Error('Development blob readback mismatch');
      return { sha: expected };
    });
  }
  const tree = files.map(file => ({ path: file.path, mode: file.mode, type: 'blob', sha: blob(file) }));
  await effect('tree', { tree }, async () => {
    const result = await request('POST', '/git/trees', { tree });
    if (result.sha !== evidence.candidate.gitTree) throw new Error('Development tree readback mismatch'); return { sha: result.sha };
  }, async () => {
    const result = await request('GET', '/git/trees/' + evidence.candidate.gitTree + '?recursive=1');
    if (result.sha !== evidence.candidate.gitTree || result.truncated !== false || !Array.isArray(result.tree)) throw new Error('Development tree readback incomplete');
    const blobs = result.tree.filter(entry => entry.type === 'blob');
    if (blobs.length !== tree.length || new Set(result.tree.map(entry => entry.path)).size !== result.tree.length
      || result.tree.some(entry => !['blob', 'tree'].includes(entry.type) || !sha(entry.sha))
      || tree.some(entry => !blobs.some(actual => actual.path === entry.path && actual.mode === entry.mode && actual.sha === entry.sha))) throw new Error('Development tree readback mismatch');
    return { sha: result.sha };
  });
  const account = lease.value.account;
  if (!Number.isSafeInteger(account?.id) || account.id < 1 || !/^[A-Za-z0-9-]{1,39}$/.test(account.login)) throw new Error('Development author unavailable');
  const date = new Date(Math.floor(run.createdAt / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const author = { name: account.login, email: account.id + '+' + account.login + '@users.noreply.github.com', date };
  const message = 'Issue #' + run.issue + ': ' + title + '\n', seconds = Date.parse(date) / 1000, parent = previous?.result.head ?? captured.source.sourceCommit;
  const expectedCommit = objectHash('commit', Buffer.from(`tree ${evidence.candidate.gitTree}\nparent ${parent}\nauthor ${author.name} <${author.email}> ${seconds} +0000\ncommitter ${author.name} <${author.email}> ${seconds} +0000\n\n${message}`));
  await effect('commit', { sha: expectedCommit, message, author }, async () => {
    const result = await request('POST', '/git/commits', { tree: evidence.candidate.gitTree, parents: [parent], message, author, committer: author });
    if (result.sha !== expectedCommit) throw new Error('Development commit readback mismatch'); return { sha: expectedCommit };
  }, async () => {
    const result = await request('GET', '/git/commits/' + expectedCommit);
    // GitHub's JSON message omits the terminal newline; the exact object SHA verifies raw bytes.
    if (result.sha !== expectedCommit || result.tree?.sha !== evidence.candidate.gitTree || ![message, message.slice(0, -1)].includes(result.message) || result.parents?.length !== 1 || result.parents[0].sha !== parent
      || canonicalJSON(result.author) !== canonicalJSON(author) || canonicalJSON(result.committer) !== canonicalJSON(author)) throw new Error('Development commit readback mismatch');
    return { sha: expectedCommit, gitTree: result.tree.sha };
  });
  await effect('branch', { ref: 'refs/heads/' + branch, sha: expectedCommit }, async () => {
    if (previous) {
      const before = await request('GET', '/git/ref/heads/' + encodeURIComponent(branch));
      if (previous.result.branch !== branch || before.ref !== 'refs/heads/' + branch || before.object?.sha !== parent) throw new Error('Development previous branch changed');
    }
    const result = previous ? await request('PATCH', '/git/refs/heads/' + encodeURIComponent(branch), { sha: expectedCommit, force: false })
      : await request('POST', '/git/refs', { ref: 'refs/heads/' + branch, sha: expectedCommit });
    return { ref: result.ref, sha: result.object?.sha ?? null };
  }, async () => {
    const result = await request('GET', '/git/ref/heads/' + encodeURIComponent(branch));
    if (result.ref !== 'refs/heads/' + branch || result.object?.type !== 'commit' || result.object.sha !== expectedCommit) throw new Error('Development branch readback mismatch');
    return { ref: result.ref, sha: expectedCommit };
  });
  const pullTitle = ('Issue #' + run.issue + ' · ' + title).slice(0, 240), body = documentHTML({ title: pullTitle, paragraphs: [
    'Refs #' + run.issue, 'Source: ' + captured.source.sourceCommit + '. Tree: ' + evidence.candidate.gitTree + '. Candidate: ' + expectedCommit + '.',
    'Passed local repository checks: ' + evidence.checks.join(', ') + '.', ...evidence.summaries.slice(-8),
    'This candidate is prepared for the configured PM Testing and integration steps. No Human approval, merge, Issue completion, native app or other-platform qualification is implied.',
  ] });
  const verifyPull = async number => {
    const result = await request('GET', '/pulls/' + number);
    if (result.number !== number || result.state !== 'open' || result.title !== pullTitle || result.body !== body || result.html_url?.toLowerCase() !== `https://github.com/${workspace.slug}/pull/${number}`
      || result.head?.ref !== branch || result.head.sha !== expectedCommit || result.head.repo?.id !== workspace.numericId || result.head.repo.node_id !== workspace.repositoryId
      || result.base?.ref !== repository.defaultBranch || result.base.sha !== captured.source.sourceCommit || result.base.repo?.id !== workspace.numericId || result.base.repo.node_id !== workspace.repositoryId) throw new Error('Development PR candidate readback mismatch');
    return { number, url: result.html_url, head: expectedCommit, branch, base: captured.source.sourceCommit, baseBranch: repository.defaultBranch };
  };
  const pullRequest = await effect('pull-request', { title: pullTitle, body, base: repository.defaultBranch, head: branch }, async () => {
    if (previous) {
      const before = await request('GET', '/pulls/' + previous.result.number);
      if (before.state !== 'open' || before.head?.sha !== expectedCommit || before.head.ref !== branch || before.base?.sha !== captured.source.sourceCommit
        || before.body !== previous.binding.payload.body || before.title !== previous.binding.payload.title) throw new Error('Development previous PR changed');
      await request('PATCH', '/pulls/' + previous.result.number, { title: pullTitle, body }); return { number: previous.result.number };
    }
    const existing = await request('GET', '/pulls?state=all&head=' + encodeURIComponent(repository.owner.login + ':' + branch) + '&base=' + encodeURIComponent(repository.defaultBranch) + '&per_page=100');
    if (!Array.isArray(existing) || existing.length) throw new Error('Development PR ownership conflict');
    const result = await request('POST', '/pulls', { title: pullTitle, body, base: repository.defaultBranch, head: branch, draft: false });
    if (!Number.isSafeInteger(result.number) || result.number < 1) throw new Error('Development PR readback incomplete'); return { number: result.number };
  }, async known => {
    if (known?.number) return verifyPull(known.number);
    const found = await request('GET', '/pulls?state=all&head=' + encodeURIComponent(repository.owner.login + ':' + branch) + '&base=' + encodeURIComponent(repository.defaultBranch) + '&per_page=100');
    if (!Array.isArray(found) || found.length !== 1 || !Number.isSafeInteger(found[0].number)) throw new Error('Development PR readback incomplete'); return verifyPull(found[0].number);
  });
  await base(); current();
  return { candidate: { sourceCommit: expectedCommit, gitTree: evidence.candidate.gitTree }, source: captured.source, pullRequest, requiredChecks: [...profile.quality.requiredChecks] };
}
