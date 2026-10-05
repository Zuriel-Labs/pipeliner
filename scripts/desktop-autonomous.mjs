// Explicit development qualification only: installed Cloud relay and administrative gh transport.
// Project fields are synthetic. No product App authorization or Human QA is claimed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, lstatSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openPolicyStore } from '../desktop/core/policy.mjs';
import { inspectWorkspace, workspaceData } from '../desktop/core/identity.mjs';
import { openExecutionSupervisor } from '../desktop/core/execution.mjs';
import { openWorkerEnvironment } from '../desktop/core/worker.mjs';
import { openDevelopmentStore, documentHTML, validateDevelopmentOutput } from '../desktop/development/state.mjs';
import { createDevelopmentManager, developmentPermissions } from '../desktop/development/manager.mjs';
import { snapshotWorkspace, sourceTree } from '../desktop/development/source.mjs';
import { openWorkspaceStore } from '../desktop/repositories/store.mjs';
import { openTestVault } from '../desktop/connections/test-vault.mjs';
import { issueFixture } from '../desktop/issues/fixture.mjs';
import { presetChanges } from '../desktop/pipelines/model.mjs';
import { catalog as providerCatalog, selectedModel, chat } from '../desktop/ollama/qualify.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 3) throw Error('Requires qualified Mac and one exact owned fixture marker');
const ownerPath = realpathSync(process.argv[2]), info = lstatSync(ownerPath);
assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o777) === 0o600);
const prior = JSON.parse(readFileSync(ownerPath, 'utf8')); assert.match(prior.slug, /^Zuriel-Labs\/pipeliner-42-qualification-[a-f0-9]{8}$/);
function gh(path, method = 'GET', body) {
  const output = execFileSync('gh', ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])],
    { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return output.trim() ? JSON.parse(output) : null;
}
const repo = gh('/repos/' + prior.slug), account = gh('/user'), prefix = '/repos/' + repo.full_name;
assert.equal(repo.id, prior.id); assert.equal(repo.node_id, prior.node); assert.equal(repo.description, prior.description);
assert.equal(repo.private, true); assert.equal(repo.permissions.push, true); assert.equal(account.login, 'brimdor');
assert.deepEqual(gh(prefix + '/issues?state=open&per_page=100'), []); assert.deepEqual(gh(prefix + '/pulls?state=open&per_page=100'), []);
const model = selectedModel(await providerCatalog(undefined, 'local-cloud'), 'local-cloud');
const directory = realpathSync(mkdtempSync('/private/tmp/pipeliner-autonomous-')), owner = { issue: 46, run: randomUUID(), directory, repository: { id: repo.id, node: repo.node_id, slug: repo.full_name } };
const marker = '/tmp/pipeliner-46-autonomous-' + owner.run + '.json', localMarker = join(directory, 'qualification-owner.json');
const saveOwner = () => { writeFileSync(marker, JSON.stringify(owner), { mode: 0o600 }); writeFileSync(localMarker, JSON.stringify(owner), { mode: 0o600 }); };
writeFileSync(marker, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); writeFileSync(localMarker, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
let policy, supervisor, ledger, store, vault, manager, fixtureIssue, pull, failed = null, cleanup = null, providerTurns = 0, mergeWrites = 0, lastStep, lastPull, ownedRunId, verification = 'setup';
function measureWorker(run) {
  const environment = JSON.parse(readFileSync(join(directory, 'environment.json'), 'utf8'));
  const db = new DatabaseSync(join(directory, 'execution.sqlite'), { readOnly: true }); let row;
  try { row = db.prepare('SELECT document,cid FROM workers WHERE run_id=? AND epoch=? AND state=?').get(run.id, run.epoch, 'running'); } finally { db.close(); }
  assert.ok(row); assert.match(row.cid, /^[a-f0-9]{64}$/); assert.equal(JSON.parse(row.document).manifest.image, environment.image);
  const version = program => execFileSync('/opt/homebrew/bin/limactl', ['shell', 'engine', 'nerdctl', 'exec', row.cid, program, '--version'],
    { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: join(directory, 'home'), LIMA_HOME: join(directory, 'lima'), LC_ALL: 'C' } }).trim();
  return { image: environment.image, configuration: environment.configuration, node: version('node'), git: version('git') };
}
const started = performance.now();
try {
  const checkout = join(directory, 'repository'), state = join(directory, 'state'); mkdirSync(checkout); mkdirSync(state, { mode: 0o700 });
  vault = await openTestVault(state);
  const git = (args, input) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', checkout, ...args],
    { input, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  git(['init', '-b', repo.default_branch]); git(['remote', 'add', 'origin', 'https://github.com/' + repo.full_name + '.git']);
  const base = gh(prefix + '/git/ref/heads/' + encodeURIComponent(repo.default_branch)).object.sha, original = gh(prefix + '/git/commits/' + base), tree = gh(prefix + '/git/trees/' + original.tree.sha + '?recursive=1');
  assert.equal(tree.truncated, false); assert.ok(tree.tree.length < 100);
  for (const entry of tree.tree.filter(entry => entry.type === 'blob')) {
    assert.match(entry.path, /^[A-Za-z0-9][A-Za-z0-9_./-]*$/); assert.ok(!entry.path.split('/').some(part => ['.', '..', '.git'].includes(part))); assert.equal(entry.mode, '100644');
    const blob = gh(prefix + '/git/blobs/' + entry.sha); assert.equal(blob.encoding, 'base64'); const bytes = Buffer.from(blob.content.replaceAll('\n', ''), 'base64'); assert.ok(bytes.length < 1048576);
    const path = join(checkout, entry.path); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes);
  }
  mkdirSync(join(checkout, 'qualification-d16'), { recursive: true });
  const profile = JSON.parse(readFileSync(new URL('../pipeliner.config.json', import.meta.url), 'utf8'));
  profile.repository.owner = repo.owner.login; profile.repository.name = repo.name; profile.repository.defaultBranch = repo.default_branch;
  profile.project.owner = repo.owner.login; profile.project.number = 1;
  profile.quality.commands = ['node --test qualification-d16/value.test.mjs']; profile.quality.requiredChecks = [];
  writeFileSync(join(checkout, 'pipeliner.config.json'), JSON.stringify(profile));
  writeFileSync(join(checkout, 'qualification-d16/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(checkout, 'qualification-d16/value.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import {value} from './value.mjs';test('actual expected value',()=>assert.equal(value,2));\n");
  git(['add', '--', '.']); const localTree = git(['write-tree']).trim();
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean).map(path => ({ path, mode: '100644', content: readFileSync(join(checkout, path)).toString('base64') }));
  assert.equal(sourceTree(files), localTree);
  const entries = files.map(file => ({ path: file.path, mode: file.mode, type: 'blob', sha: gh(prefix + '/git/blobs', 'POST', { encoding: 'base64', content: file.content }).sha }));
  const remoteTree = gh(prefix + '/git/trees', 'POST', { tree: entries }); assert.equal(remoteTree.sha, localTree);
  const seconds = Math.floor(Date.now() / 1000), author = { name: account.login, email: account.id + '+' + account.login + '@users.noreply.github.com', date: new Date(seconds * 1000).toISOString().replace('.000Z', 'Z') }, message = 'Owned synthetic D-16 qualification source\n';
  const commit = gh(prefix + '/git/commits', 'POST', { tree: localTree, parents: [base], message, author, committer: author });
  const rawCommit = `tree ${localTree}\nparent ${base}\nauthor ${author.name} <${author.email}> ${seconds} +0000\ncommitter ${author.name} <${author.email}> ${seconds} +0000\n\n${message}`;
  assert.equal(git(['hash-object', '-t', 'commit', '-w', '--stdin'], rawCommit).trim(), commit.sha); git(['update-ref', 'HEAD', commit.sha]);
  gh(prefix + '/git/refs/heads/' + encodeURIComponent(repo.default_branch), 'PATCH', { sha: commit.sha, force: false });
  assert.equal(gh(prefix + '/git/ref/heads/' + encodeURIComponent(repo.default_branch)).object.sha, commit.sha); owner.source = { sourceCommit: commit.sha, gitTree: localTree }; saveOwner();
  const labels = gh(prefix + '/labels?per_page=100'); assert.ok(Array.isArray(labels) && labels.length < 100);
  if (!labels.some(label => label.name === 'Ready for Development')) gh(prefix + '/labels', 'POST', { name: 'Ready for Development', color: '3366aa', description: 'PM-owned qualification readiness' });
  const instructions = 'Change only qualification-d16/value.mjs so exported value is 2. Keep its existing test unchanged. During research inspect source, call read path /host-canary once to prove the host denies protected paths, then finish with research, specification and non-UI design documents using verified source evidence only. Denied IDs are audit history, not success evidence. During implementation run node --test qualification-d16/value.test.mjs first and retain its actual failure, read the value file for its exact hash, change only value to 2 and run that check again. Checks must use the changed tree. Review both files and passing actual check results, with a review document and explicit findings. Host integration uses captured zero-gate authority; never invent or request Human approval. All source is synthetic.';
  fixtureIssue = gh(prefix + '/issues', 'POST', { title: 'Correct the owned D-16 synthetic value', body: documentHTML({ title: 'D-16 zero-gate execution fixture', paragraphs: [instructions, 'Owned development qualification for Pipeliner Issue #46. Project fields and PM configuration are synthetic; no Human QA or product App authorization is claimed.'] }), labels: ['Ready for Development'] });
  owner.fixtureIssue = fixtureIssue.number; saveOwner();
  const identity = inspectWorkspace(checkout, { repository: 'R_autonomous', owner: repo.owner.login, name: repo.name }), snapshot = snapshotWorkspace(identity);
  assert.deepEqual(snapshot.candidate, owner.source);
  const workspace = { id: 'R_autonomous', repositoryId: repo.node_id, numericId: repo.id, slug: repo.full_name.toLowerCase(), name: 'Owned autonomous qualification', private: true,
    path: checkout, localKey: workspaceData(identity).localKey, connections: { setup: null }, project: { id: 'P_qualification', number: 1, owner: { login: repo.owner.login } } };
  store = openWorkspaceStore(state, { vault }); store.register(workspace); store.select(workspace.id);
  const fixture = issueFixture(workspace), issue = fixture.issues[0]; Object.assign(issue, { id: fixtureIssue.node_id, number: fixtureIssue.number, numericId: fixtureIssue.id, ready: true, title: fixtureIssue.title, body: fixtureIssue.body, labels: ['Ready for Development'] });
  const readIssue = async () => { const actual = gh(prefix + '/issues/' + fixtureIssue.number); assert.equal(actual.id, fixtureIssue.id); assert.equal(actual.node_id, fixtureIssue.node_id);
    return { ...structuredClone(issue), state: actual.state.toUpperCase(), title: actual.title, body: actual.body, labels: actual.labels.map(label => label.name), ready: actual.labels.some(label => label.name === 'Ready for Development'), assignees: actual.assignees.map(person => person.login) }; };
  const api = { ...fixture.api, readIssue, async readDetail() { return { ...await readIssue(), dependencies: [], pullRequests: [] }; }, async readCatalog(...args) {
    const catalog = await fixture.api.readCatalog(...args), actual = await readIssue(); return { ...catalog, issues: [actual], active: ['In Progress', 'In Review', 'Pending Review'].includes(actual.status) ? [{ id: actual.id, number: actual.number, status: actual.status }] : [] }; } };
  const dev = { id: 'fixture-dev', connection: 'ollama', model: model.name, metrics: [], noPrompts: true };
  const lease = () => ({ id: 'github', signal: new AbortController().signal, check() {}, close() {}, value: { credential: { accessToken: 'synthetic-host-gh-transport-only' }, account: { id: account.id, login: account.login },
    view: { repositories: [{ id: repo.node_id, numericId: repo.id, name: repo.full_name, private: true, permissions: ['pull', 'push'] }] } }, send: async (url, request) => {
      const parsed = new URL(url); assert.equal(parsed.origin, 'https://api.github.com'); assert.ok(parsed.pathname.toLowerCase() === prefix.toLowerCase() || parsed.pathname.toLowerCase().startsWith(prefix.toLowerCase() + '/'));
      let value; try { value = gh(parsed.pathname + parsed.search, request.method, request.body ? JSON.parse(request.body) : undefined); }
      catch (error) { const status = /HTTP (\d{3})/.exec(String(error.stderr)); if (status) return Response.json({}, { status: Number(status[1]) }); throw Error('Qualification transport unavailable'); }
      if (request.method === 'PUT') { mergeWrites++; assert.equal(value.merged, true); throw Error('Deliberately lost already-applied merge reply'); }
      return value === null ? new Response(null, { status: 204 }) : Response.json(value);
    } });
  const connections = { developers: () => [dev], acquire: async () => lease(), async acquireProvider(id, selected, signal) {
    assert.equal(id, 'ollama'); assert.equal(selected, model.name); let closed = false;
    const check = () => { signal?.throwIfAborted(); if (closed) throw Error('Qualification provider lease closed'); };
    return { check, close() { closed = true; }, async turn({ messages, tools, maxOutput }) { check(); providerTurns++;
      const response = await chat(undefined, selected, messages, tools, 'local-cloud', { signal, numPredict: maxOutput, timeoutMs: 120000 }); check(); return response; } };
  } };
  policy = openPolicyStore(state, { catalog: () => ({ repositories: [workspace.id], capabilities: developmentPermissions, maxConcurrency: 1, background: false,
    developers: [dev], connections: ['github', 'ollama'].map(id => ({ id, provider: id, repositories: [workspace.id], healthy: true })), extensions: [] }), inspectors: {
      repository: value => manager.observe(value), worker: binding => supervisor.inspectWorker(binding), effect: action => action.operation === 'github.pr.merge' ? manager.inspectIntegration(action) : supervisor.inspectEffect(action) } });
  supervisor = openExecutionSupervisor(directory, { store: policy }); ledger = openDevelopmentStore(state, { vault });
  manager = createDevelopmentManager({ store, policy, ledger, connections, supervisor, api, onChange: view => {
    if (view.run?.id) ownedRunId = view.run.id;
    if (view.development?.step === 'research' && view.execution?.worker === 'running' && !owner.worker) { owner.worker = measureWorker(view.run); saveOwner(); }
    if (view.development?.step !== lastStep) { lastStep = view.development?.step; console.log(JSON.stringify({ progress: lastStep ?? 'preflight', providerTurns })); }
    if (view.publication?.number && view.publication.number !== lastPull) { pull = view.publication; lastPull = pull.number; owner.pullRequest = pull; saveOwner(); console.log(JSON.stringify({ createdPullRequest: pull.url })); }
  } });
  for (const [scope, target, changes] of [['host', null, { 'permissions.ceiling': developmentPermissions }], ['repository', workspace.id, {
    ...presetChanges('pm-autonomous'), 'permissions.grants': developmentPermissions, 'agents.dev': dev.id, 'connections.github': 'github', 'connections.ollama': 'ollama', 'limits.agentSeconds': 3600 }]]) {
    const input = policy.control.capture({ commandId: scope, conversationId: 'qualification', target, text: 'Authorized synthetic development qualification; zero-gate Desktop preset. Not Human QA.' });
    const preview = policy.control.prepare({ inputId: input.id, requestId: scope, conversationId: 'qualification', scope, target, changes, reset: [] });
    policy.control.apply({ commandId: scope + '-apply', inputId: input.id, proposalId: preview.id, hash: preview.hash, conversationId: 'qualification', target });
  }
  console.log(JSON.stringify({ inventory: { issue: 46, directory, provider: model.name, digest: model.digest, nativeResources: 'One task-owned VM/image/container/workspace; no host source mounts', remote: 'Exact previously owned private fixture; actual Issue/PR/merge; Project fields synthetic' } }));
  verification = 'execution'; manager.dispatch({ operation: 'start', number: fixtureIssue.number }); await manager.idle();
  owner.verification = { managerError: manager.status().error, reservationHeld: Boolean(policy.runtime.status(workspace.id)), providerTurns, mergeWrites }; saveOwner();
  if (manager.status().error && ownedRunId) {
    const status = ledger.status(ownedRunId), evidence = ledger.evidence({ runId: ownedRunId, epoch: status.epoch });
    owner.verification.denials = evidence.filter(row => row.state === 'denied').map(row => ({ kind: row.kind, operation: row.payload.operation, reason: row.result?.result?.error }));
    owner.verification.calls = evidence.filter(row => row.kind === 'provider' && row.state === 'verified').slice(-3).flatMap(row => row.result.result.tool_calls.map(call => {
      let args, outputError = null; try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
        if (args?.operation === 'finish') validateDevelopmentOutput(args.payload); } catch (error) { outputError = error.message; }
      return { callKeys: Object.keys(call), functionKeys: Object.keys(call.function), argumentKeys: args ? Object.keys(args) : [], operation: args?.operation,
        runMatches: args?.runId === ownedRunId, epochMatches: args?.epoch === status.epoch, payloadKeys: args?.payload ? Object.keys(args.payload) : [], outputError };
    })); saveOwner();
  }
  assert.equal(manager.status().error, null, manager.status().error); assert.equal(policy.runtime.status(workspace.id), null);
  verification = 'completion';
  const job = store.effects(ownedRunId).find(effect => effect.binding.kind === 'development' && effect.step === 'pull-request'); assert.ok(job);
  const runId = job.binding.runId, result = ledger.status(runId), captured = ledger.captured(runId), evidence = ledger.evidence({ runId, epoch: result.epoch });
  owner.verification = { ...owner.verification, state: result.state, qa: Boolean(result.qa), qaHistory: result.qaHistory?.length ?? 0,
    outputs: ledger.outputs(runId).map(output => output.step), denied: evidence.filter(row => row.state === 'denied').length,
    failedTests: evidence.filter(row => row.kind === 'tests' && row.result?.result?.exitCode !== 0).length,
    passedTests: evidence.filter(row => row.kind === 'tests' && row.result?.result?.exitCode === 0).length }; saveOwner();
  assert.equal(result.state, 'complete'); assert.equal(result.qa ?? null, null); assert.equal(result.qaHistory, undefined); assert.ok(providerTurns > 0); assert.equal(mergeWrites, 1);
  assert.deepEqual(ledger.outputs(runId).map(output => output.step), ['research', 'implement', 'checks', 'review']);
  verification = 'source-denial-and-red-green';
  assert.ok(evidence.some(row => row.state === 'denied')); assert.ok(evidence.some(row => row.kind === 'tests' && row.result.result.exitCode !== 0)); assert.ok(evidence.some(row => row.kind === 'tests' && row.result.result.exitCode === 0));
  verification = 'closeout';
  assert.equal(issue.status, 'Done'); assert.equal((await readIssue()).state, 'CLOSED'); assert.equal(store.pending('development').length, 0);
  assert.equal(readFileSync(join(checkout, 'qualification-d16/value.mjs'), 'utf8'), 'export const value = 1;\n');
  const actual = gh(prefix + '/pulls/' + pull.number); assert.equal(actual.merged, true); assert.equal(actual.merge_commit_sha, result.integration.candidate.sourceCommit);
  const finalTree = gh(prefix + '/git/commits/' + actual.merge_commit_sha).tree.sha; assert.equal(finalTree, result.integration.source.gitTree);
  assert.deepEqual(gh(prefix + '/git/matching-refs/heads/' + encodeURIComponent(pull.branch)), []);
  owner.completed = true; owner.integrated = result.integration; owner.providerTurns = providerTurns; saveOwner();
  console.log(JSON.stringify({ passed: true, qualification: 'Actual model/worker/PR/merge with zero approval input and deliberately lost merge reply', source: captured.source, candidate: result.integration.source, integrated: result.integration.candidate,
    providerTurns, usage: result.usage, mergeWrites, approvalCalls: 0, qaHistory: 0, issueClosed: true, syntheticProjectStatus: issue.status, hostSourcePreserved: true,
    host: { os: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), architecture: process.arch, node: process.version }, worker: owner.worker, provider: { model: model.name, remoteModel: model.remote_model, digest: model.digest }, milliseconds: performance.now() - started,
    notRun: ['Product scoped App authorization', 'Actual Project mutation', 'Direct Cloud API key authentication', 'Human PM QA', 'Application/installer delivery', 'Windows/Linux'] }));
} catch (error) { const first = error.message.split('\n')[0]; failed = first.length <= 240 && /^(Development |Captured Development |Hard provider metric |http-\d{3}|capability-unverified)/.test(first) ? first : 'Qualification assertion failed at ' + verification;
  owner.failed = failed; saveOwner(); console.log(JSON.stringify({ passed: false, error: failed, verification: owner.verification ?? null })); }
finally {
  const failures = [];
  for (const close of [async () => manager ? manager.close() : supervisor?.shutdown(), () => ledger?.close(), () => policy?.close(), () => store?.close(), () => vault?.close(), async () => { cleanup = await openWorkerEnvironment(directory).destroy(); }]) {
    try { await close(); } catch { failures.push('owned-native-teardown'); }
  }
  try {
    const actual = gh('/repos/' + prior.slug); assert.equal(actual.id, prior.id); assert.equal(actual.node_id, prior.node); assert.equal(actual.description, prior.description);
    if (pull && !owner.completed) { const actualPull = gh(prefix + '/pulls/' + pull.number); if (!actualPull.merged) gh(prefix + '/pulls/' + pull.number, 'PATCH', { state: 'closed' }); }
    if (fixtureIssue) gh(prefix + '/issues/' + fixtureIssue.number, 'PATCH', { state: 'closed' });
    if (pull) { const refs = gh(prefix + '/git/matching-refs/heads/' + encodeURIComponent(pull.branch)); assert.ok(Array.isArray(refs)); const owned = refs.filter(ref => ref.ref === 'refs/heads/' + pull.branch);
      assert.ok(owned.length <= 1); if (owned.length) { assert.equal(owned[0].object.sha, pull.head); gh(prefix + '/git/refs/heads/' + encodeURIComponent(pull.branch), 'DELETE'); }
      assert.deepEqual(gh(prefix + '/git/matching-refs/heads/' + encodeURIComponent(pull.branch)), []); }
    assert.equal(readFileSync(localMarker, 'utf8'), JSON.stringify(owner)); assert.equal(realpathSync(directory), directory);
    if (failures.length) throw Error('Owned native cleanup unverified'); rmSync(directory, { recursive: true }); assert.equal(existsSync(directory), false);
    owner.localRemoved = true; owner.fixtureClosed = Boolean(fixtureIssue); owner.branchRemoved = Boolean(pull); writeFileSync(marker, JSON.stringify(owner), { mode: 0o600 });
    console.log(JSON.stringify({ cleanup: { ...cleanup, directoryRemoved: true, remoteIssueClosed: Boolean(fixtureIssue), ownedBranchRemoved: Boolean(pull), retainedPrivateRepository: repo.full_name,
      retainedOwner: 'brimdor', deletionTrigger: 'Administrative deletion becomes available; prior exact-owned delete HTTP 403 is unchanged' } }));
  } catch { failures.push('owned-resource-cleanup'); console.log(JSON.stringify({ cleanupFailed: true, directory, ownershipMarker: marker })); }
  if (failures.length) failed ??= 'Owned cleanup failed';
}
process.exitCode = failed ? 1 : 0;
