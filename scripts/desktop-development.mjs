import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openPolicyStore } from '../desktop/core/policy.mjs';
import { inspectWorkspace, workspaceCandidate } from '../desktop/core/identity.mjs';
import { openExecutionSupervisor } from '../desktop/core/execution.mjs';
import { openWorkerEnvironment } from '../desktop/core/worker.mjs';
import { snapshotWorkspace, sourceTree } from '../desktop/development/source.mjs';
import { developmentWorkerProgram } from '../desktop/development/worker-tools.mjs';
import { openDevelopmentStore, developmentIssueHash, documentHTML } from '../desktop/development/state.mjs';
import { createDevelopmentEngine } from '../desktop/development/engine.mjs';
import { starterHash } from '../desktop/development/starter.mjs';
import { catalog as providerCatalog, selectedModel, chat } from '../desktop/ollama/qualify.mjs';
import { openWorkspaceStore } from '../desktop/repositories/store.mjs';
import { openTestVault } from '../desktop/connections/test-vault.mjs';
import { publishDevelopmentCandidate } from '../desktop/development/github.mjs';
import { canonicalJSON } from '../desktop/core/settings.mjs';

const publishing = process.argv.length === 3 ? /^--publish-github=([a-f0-9-]{36}):([A-Za-z0-9]{6})$/.exec(process.argv[2]) : null;
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Development qualification requires this qualified Mac');
if (publishing) { await publishSaved(publishing[1], publishing[2]); process.exit(0); }
const reuse = process.argv.length === 3 ? /^--agent-github(?:=([a-f0-9-]{36}))?$/.exec(process.argv[2]) : null;
const githubFixture = Boolean(reuse);
const agent = githubFixture || process.argv.length === 3 && process.argv[2] === '--agent';
const budgets = process.argv.length === 3 && process.argv[2] === '--budgets';
if ((!agent && !budgets && process.argv.length !== 2) || process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Development qualification requires this qualified Mac and optional --agent, --agent-github or --budgets');
const directory = realpathSync(mkdtempSync('/private/tmp/pipeliner-development-'));
const ownership = { issue: budgets ? 48 : 42, run: randomUUID(), directory }, marker = join(directory, 'qualification-owner.json');
writeFileSync(marker, JSON.stringify(ownership), { flag: 'wx', mode: 0o600 });
const started = performance.now(), results = [];
let policy, supervisor, ledger, publicationStore, vault, image, workerVersions, fixtureRepository, fixtureAccount, fixtureIssue, publication, proofHash, continuityProof, failureLine = null, error = null, cleanup = null;
const check = (name, extra = {}) => { results.push({ name, passed: true, ...extra }); console.log(JSON.stringify({ progress: name })); };
const instructions = 'Change only app.mjs so exported value is 2. Keep the existing test unchanged. Research first: inspect source, invoke read path /host-canary once to verify the host denies protected paths, then record research, specification and non-UI design documents with verified source evidence only; do not list denial IDs in success evidence. During implementation run node --test first and retain the actual failing result; read app.mjs to get its exact hash, change value to 2, run node --test again and repair any failure before finishing success. Checks must run node --test on the changed tree. Review both files and actual check results, with a review document and explicit findings. Do not publish or merge. All source is synthetic.';
// Explicit host administrative test transport only. No token leaves gh or reaches the app/worker/model.
function gh(path, method = 'GET', body) {
  const args = ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])];
  const output = execFileSync('gh', args, { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return output.trim() ? JSON.parse(output) : null;
}
function fixtureLease(repository, account) {
  const slug = repository.full_name;
  return { id: 'github', signal: new AbortController().signal, check() {}, close() {},
    value: { credential: { accessToken: 'synthetic-qualification-transport-only' }, account: { id: account.id, login: account.login },
      view: { repositories: [{ id: repository.node_id, numericId: repository.id, name: slug, private: true, permissions: ['pull', 'push'] }] } },
    send: async (url, options) => { const parsed = new URL(url), pathname = parsed.pathname.toLowerCase(), prefix = '/repos/' + slug.toLowerCase();
      assert.equal(parsed.origin, 'https://api.github.com'); assert.ok(pathname === prefix || pathname.startsWith(prefix + '/'));
      return Response.json(gh(parsed.pathname + parsed.search, options.method, options.body ? JSON.parse(options.body) : undefined)); } };
}
async function publishSaved(id, suffix) {
  const directory = '/private/tmp/pipeliner-development-' + suffix, info = lstatSync(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && realpathSync(directory) === directory);
  const marker = readFileSync(join(directory, 'qualification-owner.json'), 'utf8'), identity = JSON.parse(marker);
  assert.equal(identity.run, id); assert.equal(identity.issue, 42); assert.equal(identity.directory, directory);
  const ownerFile = '/tmp/pipeliner-42-github-' + id + '.json', owned = JSON.parse(readFileSync(ownerFile, 'utf8'));
  const proofFile = '/tmp/pipeliner-42-github-' + id + '.proof.json', text = readFileSync(proofFile, 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), owned.proofHash); const proof = JSON.parse(text);
  const repository = gh('/repos/' + owned.slug), account = gh('/user');
  assert.equal(account.login, 'brimdor'); assert.equal(account.id, 1202831); assert.equal(repository.id, owned.id); assert.equal(repository.node_id, owned.node); assert.equal(repository.description, owned.description);
  const issue = gh('/repos/' + owned.slug + '/issues/' + proof.issue.number); assert.equal(issue.title, proof.issue.title); assert.equal(issue.body, proof.issue.body);
  assert.deepEqual(gh('/repos/' + owned.slug + '/issues?state=open'), []);
  gh('/repos/' + owned.slug + '/issues/' + proof.issue.number, 'PATCH', { state: 'open' });
  const vault = await openTestVault(join(directory, 'state')), store = openWorkspaceStore(join(directory, 'state'), { vault }), ledger = openDevelopmentStore(join(directory, 'state'), { vault });
  let result;
  try {
    assert.equal(canonicalJSON(ledger.status(proof.run.id)), canonicalJSON(proof.state));
    result = await publishDevelopmentCandidate({ store, ledger, lease: fixtureLease(repository, account), workspace: { id: proof.run.repository, repositoryId: repository.node_id, numericId: repository.id, slug: repository.full_name.toLowerCase(), private: true },
      run: proof.run, source: proof.source, files: proof.files, profile: { repository: { defaultBranch: repository.default_branch }, workflow: { branchPattern: 'issue/{number}-{slug}' }, quality: { requiredChecks: [] } }, title: proof.issue.title,
      authority: () => assert.equal(ledger.status(proof.run.id).state, 'candidate') });
    console.log(JSON.stringify({ passed: true, issue: 42, operation: 'actual-github-persisted-candidate-publication', ...result, transport: 'Host administrative gh; current App/Project path pending' }));
  } finally {
    ledger.close(); store.close(); vault.close();
    if (result) { gh('/repos/' + owned.slug + '/pulls/' + result.pullRequest.number, 'PATCH', { state: 'closed' }); gh('/repos/' + owned.slug + '/git/refs/heads/' + encodeURIComponent(result.pullRequest.branch), 'DELETE'); }
    gh('/repos/' + owned.slug + '/issues/' + proof.issue.number, 'PATCH', { state: 'closed' });
    if (result) {
      assert.equal(readFileSync(join(directory, 'qualification-owner.json'), 'utf8'), marker);
      rmSync(directory, { recursive: true }); assert.equal(existsSync(directory), false);
      writeFileSync(ownerFile, JSON.stringify({ ...owned, pullRequest: result.pullRequest, localWorkspaceRemoved: true }), { mode: 0o600 });
      console.log(JSON.stringify({ cleanup: 'owned-native-workspace-and-remote-branch', removed: true, retainedPrivateRepository: owned.slug, repositoryDeletion: 'Prior exact-owned deletion returned HTTP 403; no broader authority requested' }));
    }
  }
}
try {
  const checkout = join(directory, 'repository'), state = join(directory, 'state'); mkdirSync(checkout, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  vault = await openTestVault(state);
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-C', checkout, ...args], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-b', 'main']); git(['remote', 'add', 'origin', 'https://github.com/PipelinerFixtures/development.git']);
  writeFileSync(join(checkout, 'app.mjs'), 'export const value = 1;\n');
  writeFileSync(join(checkout, 'app.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import {value} from './app.mjs';test('actual expected value',()=>assert.equal(value,2));\n");
  let remoteSource = null;
  if (githubFixture) {
    fixtureAccount = gh('/user'); assert.equal(fixtureAccount.login, 'brimdor'); assert.equal(fixtureAccount.id, 1202831);
    if (reuse[1]) {
      const prior = JSON.parse(readFileSync('/tmp/pipeliner-42-github-' + reuse[1] + '.json', 'utf8'));
      assert.equal(prior.run, reuse[1]); assert.match(prior.slug, /^Zuriel-Labs\/pipeliner-42-qualification-[a-f0-9]{8}$/);
      fixtureRepository = gh('/repos/' + prior.slug); assert.equal(fixtureRepository.id, prior.id); assert.equal(fixtureRepository.node_id, prior.node); assert.equal(fixtureRepository.description, prior.description);
      assert.deepEqual(gh('/repos/' + prior.slug + '/issues?state=open'), []);
    } else {
      const name = 'pipeliner-42-qualification-' + ownership.run.slice(0, 8);
      fixtureRepository = gh('/orgs/Zuriel-Labs/repos', 'POST', { name, description: 'Task-owned synthetic D-14 qualification; Issue #42; ' + ownership.run, private: true, auto_init: true, has_issues: true });
      assert.equal(fixtureRepository.name, name);
    }
    assert.equal(fixtureRepository.owner.node_id, 'O_kgDOETTHSA'); assert.equal(fixtureRepository.private, true);
    ownership.github = { id: fixtureRepository.id, node: fixtureRepository.node_id, slug: fixtureRepository.full_name, run: ownership.run };
    writeFileSync(marker, JSON.stringify(ownership), { mode: 0o600 });
    const prefix = '/repos/' + fixtureRepository.full_name, branch = fixtureRepository.default_branch;
    git(['remote', 'set-url', 'origin', 'https://github.com/' + fixtureRepository.full_name + '.git']);
    const base = gh(prefix + '/git/ref/heads/' + encodeURIComponent(branch)), commit = gh(prefix + '/git/commits/' + base.object.sha);
    const readme = gh(prefix + '/contents/README.md'); writeFileSync(join(checkout, 'README.md'), Buffer.from(readme.content.replaceAll('\n', ''), 'base64'));
    const entries = ['app.mjs', 'app.test.mjs'].map(path => { const content = readFileSync(join(checkout, path)).toString('base64'), blob = gh(prefix + '/git/blobs', 'POST', { content, encoding: 'base64' }); return { path, mode: '100644', type: 'blob', sha: blob.sha }; });
    const tree = gh(prefix + '/git/trees', 'POST', { base_tree: commit.tree.sha, tree: entries });
    remoteSource = gh(prefix + '/git/commits', 'POST', { message: 'Owned synthetic qualification source', tree: tree.sha, parents: [base.object.sha] });
    gh(prefix + '/git/refs/heads/' + encodeURIComponent(branch), 'PATCH', { sha: remoteSource.sha, force: false });
    const body = documentHTML({ title: 'Correct the synthetic exported value', paragraphs: [instructions, 'Task-owned qualification for Pipeliner Issue #42. No Human approval or product access qualification is implied.'] });
    fixtureIssue = gh(prefix + '/issues', 'POST', { title: 'Correct the synthetic exported value', body, assignees: ['brimdor'] });
    const actual = gh(prefix + '/issues/' + fixtureIssue.number); assert.equal(actual.body, body); assert.equal(actual.state, 'open'); assert.equal(actual.assignees[0].login, 'brimdor');
    check('owned-private-real-github-issue-and-source', { repositoryId: fixtureRepository.id, source: remoteSource.sha, issue: fixtureIssue.number });
  }
  git(['add', '--', '.']); git(['-c', 'user.name=Qualification', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic source']);
  const identity = inspectWorkspace(checkout, { repository: 'R_development', owner: fixtureRepository?.owner.login ?? 'PipelinerFixtures', name: fixtureRepository?.name ?? 'development' });
  const snapshot = snapshotWorkspace(identity), protectedPath = join(directory, 'protected-canary'); writeFileSync(protectedPath, 'SYNTHETIC-PROTECTED\n', { mode: 0o600 });
  if (remoteSource) { assert.equal(snapshot.candidate.gitTree, remoteSource.tree.sha); snapshot.candidate = { sourceCommit: remoteSource.sha, gitTree: remoteSource.tree.sha }; }
  const metadata = agent ? selectedModel(await providerCatalog(undefined, 'local-cloud'), 'local-cloud') : null;
  if (agent) check('actual-installed-cloud-model-binding', { model: metadata.name, remoteModel: metadata.remote_model, digest: metadata.digest });
  const permissions = ['workspace.read', 'workspace.write', 'worker.exec', ...(agent ? ['provider.turn'] : [])];
  const catalog = { repositories: ['R_development'], capabilities: permissions, maxConcurrency: 1, background: false,
    connections: [{ id: 'ollama', provider: 'ollama', repositories: ['R_development'] }], developers: [{ id: 'fixture-dev', connection: 'ollama', ...(agent ? { model: metadata.name } : {}), metrics: [] },
      ...(budgets ? [{ id: 'fixture-fallback', connection: 'ollama', model: 'synthetic-fallback', metrics: [] }] : [])], extensions: [] };
  policy = openPolicyStore(state, { catalog: () => catalog, inspectors: {
    repository: async ({ repository, issue }) => ({ repository, issue, status: 'In Progress', state: 'OPEN', active: [{ issue, status: 'In Progress' }], observedAt: Date.now() }),
    worker: binding => supervisor.inspectWorker(binding), effect: action => supervisor.inspectEffect(action),
    continuity: async expected => {
      // Native worker/candidate proof; Issue and provider observations here are synthetic, not live GitHub or Cloud qualification.
      assert.deepEqual(expected.candidate, continuityProof); assert.equal(expected.dev, 'fixture-fallback');
      assert.equal(policy.runtime.status(expected.repository).control, 'paused');
      await supervisor.inspectWorker({ runId: expected.runId, epoch: expected.epoch });
      return { ...expected, verified: true, observedAt: Date.now() };
    },
  } });
  if (agent) {
    const input = policy.control.capture({ commandId: 'fixture-host-input', conversationId: 'qualification', target: null, text: 'Authorize only the synthetic qualification provider turn ceiling.' });
    const proposal = policy.control.prepare({ inputId: input.id, requestId: 'fixture-host-proposal', conversationId: 'qualification', scope: 'host', target: null, changes: { 'permissions.ceiling': permissions }, reset: [] });
    policy.control.apply({ commandId: 'fixture-host-apply', inputId: input.id, proposalId: proposal.id, hash: proposal.hash, conversationId: 'qualification', target: null });
  }
  const input = policy.control.capture({ commandId: 'fixture-input', conversationId: 'qualification', target: 'R_development', text: 'Synthetic configuration for authorized local worker qualification; not Human QA.' });
  const budgetPipeline = budgets ? structuredClone(policy.worker.read('R_development').values['pipelines.development'].value) : null;
  if (budgetPipeline) budgetPipeline.steps[0].timeoutSeconds = 30;
  const proposal = policy.control.prepare({ inputId: input.id, requestId: 'fixture-proposal', conversationId: 'qualification', scope: 'repository', target: 'R_development', changes: { 'agents.dev': 'fixture-dev',
    ...(budgets ? { 'agents.fallbacks': ['fixture-fallback'], 'agents.takeover': true, 'pipelines.development': budgetPipeline } : {}), ...(agent ? { 'connections.ollama': 'ollama', 'permissions.grants': permissions } : {}) }, reset: [] });
  policy.control.apply({ commandId: 'fixture-apply', inputId: input.id, proposalId: proposal.id, hash: proposal.hash, conversationId: 'qualification', target: 'R_development' });
  supervisor = openExecutionSupervisor(directory, { store: policy });
  const reservation = await policy.runtime.reserve(identity, { commandId: 'fixture-reserve', issue: fixtureIssue?.number ?? 1, pipeline: 'development' });
  let binding = { runId: reservation.run.id, epoch: reservation.run.epoch };
  console.log(JSON.stringify({ inventory: { issue: ownership.issue, directory, scope: 'One owned private VM/image/container and synthetic source. ' + (agent ? 'Authorized temporary installed Cloud relay qualification; product direct Cloud path unchanged. ' + (githubFixture ? 'Real GitHub objects through host administrative gh; product App/Project path and Human QA not exercised.' : 'GitHub/Human QA not exercised.') : 'Actual provider/GitHub/Human QA not exercised.') } }));
  await supervisor.start(identity, binding, { candidate: workspaceCandidate(identity), program: developmentWorkerProgram, allowedPath: 'development-tools' });
  const inventory = new DatabaseSync(join(directory, 'execution.sqlite'), { readOnly: true });
  try { image = JSON.parse(inventory.prepare('SELECT document FROM workers WHERE run_id=? AND epoch=?').get(binding.runId, binding.epoch).document).manifest.image; } finally { inventory.close(); }
  const tool = async (request, options) => { const value = await supervisor.tool(binding, request, options); assert.equal(value.ok, true); return value.result; };
  if (agent) {
    await Promise.all([supervisor.refresh('R_development'), tool({ operation: 'list' })]);
    const issue = { number: fixtureIssue?.number ?? 1, title: fixtureIssue?.title ?? 'Correct the synthetic exported value', body: fixtureIssue?.body ?? instructions };
    ledger = openDevelopmentStore(state, { vault });
    ledger.create(reservation.run, { pipeline: policy.worker.read('R_development').values['pipelines.development'].value, source: snapshot.candidate,
      developer: { id: 'fixture-dev', connection: 'ollama', model: metadata.name }, skillsHash: starterHash, issueHash: developmentIssueHash(issue), checks: [{ name: 'Fixture tests', command: 'node --test' }], logBytes: 50 * 1024 * 1024 });
    const connections = { acquireProvider: async (id, model, signal) => {
      assert.equal(id, 'ollama'); assert.equal(model, metadata.name); let closed = false;
      const check = () => { signal.throwIfAborted(); if (closed) throw new Error('Qualification provider closed'); };
      return { check, close: () => { closed = true; }, turn: async ({ messages, tools, maxOutput }) => {
        check(); const response = await chat(undefined, model, messages, tools, 'local-cloud', { signal, numPredict: maxOutput, timeoutMs: 120000 }); check(); return response;
      } };
    } };
    const engine = createDevelopmentEngine({ ledger, policy, supervisor, connections, onChange: state => console.log(JSON.stringify({ step: state.step, state: state.state, turns: state.turns })) });
    const candidate = await engine.run(binding, { source: snapshot.files, issue });
    assert.equal(candidate.state, 'candidate'); assert.equal(candidate.step, 'pm-testing');
    assert.deepEqual(ledger.outputs(binding.runId).map(row => row.step), ['research', 'implement', 'checks', 'review']);
    const evidence = ledger.evidence(binding);
    assert.ok(evidence.some(row => row.payload.operation === 'denied' && row.state === 'denied'));
    assert.ok(evidence.some(row => row.kind === 'tests' && row.state === 'verified' && row.result.result.exitCode !== 0));
    assert.ok(evidence.some(row => row.kind === 'tests' && row.state === 'verified' && row.result.result.exitCode === 0));
    const exported = (await tool({ operation: 'export' })).files;
    assert.notEqual(exported.find(file => file.path === 'app.mjs').content, snapshot.files.find(file => file.path === 'app.mjs').content);
    assert.equal(exported.find(file => file.path === 'app.test.mjs').content, snapshot.files.find(file => file.path === 'app.test.mjs').content);
    check('real-cloud-agent-research-code-check-review-and-denied-request', { turns: candidate.turns, usage: candidate.usage, requests: evidence.length, candidate: candidate.candidate });
    if (githubFixture) {
      const proof = JSON.stringify({ captured: ledger.captured(binding.runId), state: candidate, evidence, outputs: ledger.outputs(binding.runId), run: reservation.run,
        source: snapshot.files, files: exported, issue, repository: { id: fixtureRepository.id, node_id: fixtureRepository.node_id, full_name: fixtureRepository.full_name, default_branch: fixtureRepository.default_branch } });
      assert.ok(Buffer.byteLength(proof) <= 10 * 1024 * 1024);
      writeFileSync('/tmp/pipeliner-42-github-' + ownership.run + '.proof.json', proof, { flag: 'wx', mode: 0o600 });
      proofHash = createHash('sha256').update(proof).digest('hex');
      const slug = fixtureRepository.full_name, lease = fixtureLease(fixtureRepository, fixtureAccount);
      publicationStore = openWorkspaceStore(state, { vault });
      publication = await publishDevelopmentCandidate({ store: publicationStore, ledger, lease, workspace: { id: 'R_development', repositoryId: fixtureRepository.node_id, numericId: fixtureRepository.id, slug: slug.toLowerCase(), private: true },
        run: reservation.run, source: snapshot.files, files: exported, profile: { repository: { defaultBranch: fixtureRepository.default_branch }, workflow: { branchPattern: 'issue/{number}-{slug}' }, quality: { requiredChecks: [] } }, title: issue.title, authority: () => assert.equal(policy.runtime.status('R_development').control, 'running') });
      check('actual-github-candidate-object-and-pr-readback', { candidate: publication.candidate, pullRequest: publication.pullRequest, transport: 'Host administrative gh; current App access and Project journey pending' });
    }
    const former = binding; supervisor.control(binding, 'pause'); await supervisor.settle('R_development'); await supervisor.inspectWorker(binding);
    supervisor.control(binding, 'resume'); await supervisor.settle('R_development');
    const resumed = policy.runtime.status('R_development'); binding = { runId: resumed.id, epoch: resumed.epoch }; ledger.rebind(binding.runId, binding.epoch);
    assert.equal(binding.epoch, former.epoch + 1); await assert.rejects(supervisor.tool(former, { operation: 'list' }), /epoch/);
    assert.equal(sourceTree((await tool({ operation: 'export' })).files), candidate.candidate.gitTree);
    assert.equal(ledger.status(binding.runId).turns, candidate.turns); assert.equal(readFileSync(join(checkout, 'app.mjs'), 'utf8'), 'export const value = 1;\n');
    check('real-candidate-pause-resume-preserves-ledger-and-local-source');
  } else {
  await tool({ operation: 'seed', files: snapshot.files }); assert.equal(sourceTree((await tool({ operation: 'export' })).files), snapshot.candidate.gitTree); check('actual-immutable-source-transfer');
  const red = await tool({ operation: 'run', command: 'node --test', timeoutMs: 10000 }); assert.notEqual(red.exitCode, 0); check('actual-failed-check-retained', { exitCode: red.exitCode });
  const before = await tool({ operation: 'read', path: 'app.mjs' });
  await tool({ operation: 'write', path: 'app.mjs', beforeHash: before.hash, mode: '100644', content: Buffer.from('export const value = 2;\n').toString('base64') });
  const green = await tool({ operation: 'run', command: 'node --test', timeoutMs: 10000 }); assert.equal(green.exitCode, 0); assert.equal(green.truncated, false); check('actual-isolated-code-and-passing-check');
  if (budgets) {
    continuityProof = { sourceCommit: snapshot.candidate.sourceCommit, gitTree: sourceTree((await tool({ operation: 'export' })).files) };
    ledger = openDevelopmentStore(state, { vault });
    ledger.create(reservation.run, { pipeline: policy.worker.read('R_development').values['pipelines.development'].value, source: snapshot.candidate,
      developer: { id: 'fixture-dev', connection: 'ollama', model: 'synthetic-initial' }, fallbacks: [{ id: 'fixture-fallback', connection: 'ollama', model: 'synthetic-fallback' }],
      skillsHash: starterHash, issueHash: developmentIssueHash({ number: 1, title: 'Synthetic budget qualification', body: instructions }), checks: [{ name: 'Fixture tests', command: 'node --test' }], logBytes: 1048576 });
  }
  assert.equal((await supervisor.tool(binding, { operation: 'read', path: protectedPath })).ok, false);
  assert.equal((await supervisor.tool(binding, { operation: 'write', path: 'pipeliner.config.json', beforeHash: null, mode: '100644', content: Buffer.from('{}').toString('base64') })).ok, false);
  await assert.rejects(supervisor.tool(binding, { operation: 'pm-apply', permissions: ['host.automation'] }));
  assert.equal(readFileSync(protectedPath, 'utf8'), 'SYNTHETIC-PROTECTED\n'); check('protected-host-and-control-requests-denied');
  const descendant = await tool({ operation: 'run', command: 'sleep 120 >/dev/null 2>&1 & printf owned >/tmp/descendant-marker', timeoutMs: 1000 }); assert.equal(descendant.exitCode, 0);
  const cleared = await tool({ operation: 'run', command: 'test ! -e /tmp/descendant-marker && test -e /workspace/app.mjs', timeoutMs: 1000 }); assert.equal(cleared.exitCode, 0); check('owned-container-restart-clears-descendants-and-retains-source');
  workerVersions = (await tool({ operation: 'run', command: 'node --version && git --version', timeoutMs: 1000 })).output.trim();
  const controller = new AbortController(), pending = supervisor.tool(binding, { operation: 'run', command: 'sleep 120', timeoutMs: 30000 }, { signal: controller.signal });
  pending.catch(() => {}); await new Promise(resolve => setTimeout(resolve, 250));
  const received = performance.now(); controller.abort(); const receipt = supervisor.control(binding, 'pause'); const receiptMs = performance.now() - received;
  assert.equal(receipt.received, true); await assert.rejects(pending); await supervisor.settle('R_development');
  assert.equal(supervisor.status('R_development').run.control, 'paused'); await supervisor.inspectWorker(binding);
  check('local-pause-cancels-tool-and-verifies-termination', { receivedMilliseconds: receiptMs });
  const former = binding;
  if (budgets) {
    // The earlier native setup is outside this synthetic accounting fixture. Start its deadline only after actual termination.
    ledger.begin(binding); ledger.setCandidate(binding, continuityProof); ledger.attempt(binding, 'synthetic-provider'); ledger.usage(binding, { input: null, output: null });
    ledger.retry(binding, 'synthetic-provider', 'http-503', Date.now() + 1000);
    check('durable-synthetic-attempt-and-unavailable-usage', { modelCalls: 0, chargedTurns: ledger.status(binding.runId).turns, providerEvidence: 'Synthetic accounting fixture, not a Cloud request.' });
    ledger.suspend(binding); const before = ledger.status(binding.runId), assigned = await policy.runtime.takeover(binding, { dev: 'fixture-fallback', candidate: continuityProof });
    console.log(JSON.stringify({ checkpoint: 'takeover-assigned', dev: assigned.dev, epoch: assigned.epoch }));
    ledger.rebind(binding.runId, assigned.epoch, { developer: assigned.dev, candidate: continuityProof });
    const next = await policy.runtime.resume({ runId: assigned.id, epoch: assigned.epoch }); binding = { runId: next.id, epoch: next.epoch }; ledger.rebind(binding.runId, binding.epoch);
    await supervisor.start(identity, binding, { candidate: workspaceCandidate(identity), program: developmentWorkerProgram, allowedPath: 'development-tools' });
    console.log(JSON.stringify({ checkpoint: 'takeover-worker-started', epoch: binding.epoch }));
    const after = ledger.status(binding.runId);
    assert.equal(next.id, reservation.run.id); assert.equal(next.dev, 'fixture-fallback'); assert.equal(next.policyHash, reservation.run.policyHash); assert.deepEqual(next.limits, reservation.run.limits);
    assert.equal(after.turns, before.turns); assert.deepEqual(after.attempts, before.attempts); assert.deepEqual(after.budgets, before.budgets);
    assert.equal(after.takeovers.length, 1); assert.equal(after.usage.unavailable, true);
    assert.deepEqual(after.qa, before.qa); assert.deepEqual(after.qaHistory, before.qaHistory); assert.ok(!after.qa?.decision && !after.qaHistory?.length);
    assert.equal(sourceTree((await tool({ operation: 'export' })).files), continuityProof.gitTree); assert.equal(binding.epoch, former.epoch + 2);
    check('actual-stopped-worker-takeover-retains-candidate-claim-and-budgets', { oldEpoch: former.epoch, newEpoch: binding.epoch, providerAndIssueEvidence: 'Synthetic. Worker termination and candidate export are actual.' });
  } else { supervisor.control(binding, 'resume'); await supervisor.settle('R_development');
    const resumed = policy.runtime.status('R_development'); binding = { runId: resumed.id, epoch: resumed.epoch }; assert.equal(binding.epoch, former.epoch + 1); }
  await assert.rejects(supervisor.tool(former, { operation: 'list' }), /epoch/);
  const exported = await tool({ operation: 'export' }); assert.notEqual(sourceTree(exported.files), snapshot.candidate.gitTree); assert.equal(readFileSync(join(checkout, 'app.mjs'), 'utf8'), 'export const value = 1;\n');
  check('fresh-epoch-retains-candidate-and-preserves-local-source');
  if (budgets) {
    ledger.activate(binding); const remaining = ledger.budget(binding).remainingMs;
    await assert.rejects(supervisor.tool(binding, { operation: 'run', command: 'sleep 120', timeoutMs: 60000 }, { signal: AbortSignal.timeout(remaining) }));
    supervisor.control(binding, 'pause'); await supervisor.settle('R_development'); ledger.suspend(binding);
    assert.throws(() => ledger.budget(binding), /deadline/); await supervisor.inspectWorker(binding);
    check('actual-tool-deadline-cancels-and-stops-owned-worker', { capturedSeconds: 30, remainingMillisecondsAtDispatch: remaining });
  }
  supervisor.control(binding, 'stop'); await supervisor.settle('R_development');
  // Inject a crash boundary after directory removal but before its ownership marker is removed.
  const cleanupInventory = new DatabaseSync(join(directory, 'execution.sqlite'), { readOnly: true }); let ownedManifest;
  try { ownedManifest = JSON.parse(cleanupInventory.prepare('SELECT document FROM workers WHERE run_id=? ORDER BY epoch DESC LIMIT 1').get(binding.runId).document).manifest; } finally { cleanupInventory.close(); }
  await supervisor.prepare();
  execFileSync('/opt/homebrew/bin/limactl', ['shell', 'engine', '--', 'python3', '-c', 'import os,sys,shutil; p,r=sys.argv[1:]; assert open(p+".owner").read()==r and os.path.isdir(p); shutil.rmtree(p)', ownedManifest.workspace, ownedManifest.runId],
    { env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: join(directory, 'home'), LIMA_HOME: join(directory, 'lima'), LC_ALL: 'C' }, timeout: 15000, stdio: 'pipe' });
  const removed = await supervisor.cleanupRun(binding); assert.equal(removed.workspaceRemoved, true); assert.equal(removed.containersRemoved, true);
  assert.equal(readFileSync(join(checkout, 'app.mjs'), 'utf8'), 'export const value = 1;\n'); assert.equal(readFileSync(protectedPath, 'utf8'), 'SYNTHETIC-PROTECTED\n');
  assert.equal(policy.runtime.status('R_development').releasedAt, null); await supervisor.cleanupRun(binding);
  check('owned-run-workspace-cleanup-preserves-host-source-and-claim', removed);
  }
} catch (failure) { failureLine = Number(/desktop-development\.mjs:(\d+)/.exec(failure.stack)?.[1]) || null;
  error = 'Development worker qualification failed: ' + (/^[A-Za-z0-9 ,;:.\/-]{1,200}$/.test(failure.message) ? failure.message : 'inspect private local failure'); }
finally {
  const failures = [];
  for (const close of [async () => supervisor && await supervisor.shutdown(), () => ledger?.close(), () => publicationStore?.close(), () => vault?.close(), () => policy?.close(),
    async () => { cleanup = await openWorkerEnvironment(directory).destroy(); }]) {
    try { await close(); } catch { failures.push('owned-resource-teardown'); }
  }
  try {
    if (readFileSync(marker, 'utf8') !== JSON.stringify(ownership) || realpathSync(directory) !== directory) throw new Error('Qualification cleanup identity mismatch');
    if (failures.length) throw new Error('Owned process cleanup unverified');
    if (proofHash && !publication) {
      // Keep the exact candidate and effect journal for --publish-github readback; the VM is already removed.
      cleanup.workspaceRetainedForPublicationReadback = directory;
    } else { rmSync(directory, { recursive: true }); cleanup.workspaceRemoved = !existsSync(directory); }
  } catch { cleanup = { ...(cleanup ?? {}), failed: true, directory }; }
  if (fixtureRepository) {
    try {
      const actual = gh('/repos/' + fixtureRepository.full_name); assert.equal(actual.id, fixtureRepository.id); assert.equal(actual.node_id, fixtureRepository.node_id); assert.equal(actual.description, fixtureRepository.description);
      if (publication) { gh('/repos/' + fixtureRepository.full_name + '/pulls/' + publication.pullRequest.number, 'PATCH', { state: 'closed' }); gh('/repos/' + fixtureRepository.full_name + '/git/refs/heads/' + encodeURIComponent(publication.pullRequest.branch), 'DELETE'); }
      if (fixtureIssue) gh('/repos/' + fixtureRepository.full_name + '/issues/' + fixtureIssue.number, 'PATCH', { state: 'closed' });
      writeFileSync('/tmp/pipeliner-42-github-' + ownership.run + '.json', JSON.stringify({ ...ownership.github, description: fixtureRepository.description, proofHash: proofHash ?? null, pullRequest: publication?.pullRequest ?? null }), { flag: 'wx', mode: 0o600 });
      cleanup.github = { ownIssueAndPRClosed: true, candidateBranchRemoved: Boolean(publication), repositoryRetainedUntilArtifactReadback: fixtureRepository.full_name };
    } catch { cleanup.failed = true; cleanup.github = { failed: true, repository: fixtureRepository.full_name }; }
  }
}
const passed = !error && results.length === (githubFixture ? 5 : agent ? 3 : budgets ? 11 : 8) && cleanup?.workspaceRemoved && !cleanup.failed;
console.log(JSON.stringify({ passed, issue: ownership.issue, milliseconds: performance.now() - started, host: { os: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), architecture: process.arch, node: process.version },
  workerVersions, image, results, error, failureLine, cleanup, notRun: [githubFixture ? 'Current scoped App authentication and real Project integration; direct Cloud credential path' : agent ? 'Real GitHub Issue/PR journey and direct Cloud credential path' : 'Real provider/Issue/PR journey', 'Native Desktop UI/keyboard', 'Human PM QA', 'Windows/Linux', 'Host native app execution'] }));
process.exitCode = passed ? 0 : 1;
