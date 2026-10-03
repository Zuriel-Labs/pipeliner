import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openPolicyStore } from '../core/policy.mjs';
import { inspectWorkspace } from '../core/identity.mjs';
import { createPipelineControlChannel } from '../core/control.mjs';
import { createPipelineManager } from './manager.mjs';
import { openToolStore } from '../tools/store.mjs';
import { openSkillStore } from '../skills/store.mjs';
import { toolPackage } from '../tools/package.mjs';
import { capabilityNames } from '../core/settings.mjs';

function fixture(t, withTools = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-40-policy-'))), store = openWorkspaceStore(root);
  const repo = id => ({ id, repositoryId: 'R_' + id, slug: 'fixture/' + id, name: 'Fixture / ' + id, localKey: id === 'one' ? '1:2' : '1:3', path: root, project: { id: 'P1' } });
  store.register(repo('one')); store.register(repo('two')); store.select('one'); let now = 1000;
  const tools = withTools ? openToolStore(root) : null, skills = withTools ? openSkillStore(root) : null;
  const policy = openPolicyStore(root, { clock: () => now, catalog: () => ({ repositories: ['one', 'two'], capabilities: withTools ? capabilityNames : ['workspace.read', 'workspace.write', 'worker.exec'], maxConcurrency: 1, background: false,
    connections: [{ id: 'codex', provider: 'codex', repositories: ['one', 'two'] }], developers: [{ id: 'dev', connection: 'codex', metrics: [] }], extensions: skills?.catalog() ?? [], ...(tools ? { tools: tools.catalog() } : {}) }),
    inspectors: { repository: async ({ repository, issue }) => ({ repository, issue, state: 'OPEN', status: 'In Progress', active: [{ issue, status: 'In Progress' }], observedAt: now }) } });
  let manager = createPipelineManager({ store, policy, tools, skills });
  t.after(() => { manager.close(); policy.close(); tools?.close(); skills?.close(); store.close(); rmSync(root, { recursive: true }); assert(!existsSync(root)); });
  const apply = changes => {
    const input = policy.control.capture({ commandId: randomUUID(), conversationId: 'fixture-pm', target: 'one', text: 'Change scoped policy' });
    const p = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), scope: 'repository', target: 'one', changes, reset: [] });
    return policy.control.apply({ commandId: randomUUID(), proposalId: p.id, hash: p.hash, inputId: p.inputId, conversationId: 'fixture-pm', target: 'one' });
  };
  return { root, store, policy, tools, skills, apply, get manager() { return manager; }, advance: ms => { now += ms; }, restart() { manager.close(); manager = createPipelineManager({ store, policy, tools, skills }); } };
}
function prepare(f) { f.manager.dispatch({ operation: 'prepare' }); const p = f.manager.status().preview; assert(p); return p.hash; }
const chat = (f, text) => f.manager.dispatch({ operation: 'chat', text });
test('chat and Settings share exact PM apply, correction/discard, duplicate prevention and durable versions', t => {
  const f = fixture(t); chat(f, 'Edit Development pipeline');
  chat(f, 'Rename step 1 to Research the bounded change'); const first = prepare(f);
  assert.equal(f.policy.worker.read('one').revision, 0);
  chat(f, 'Set step 1 outcome to Record the evidence'); assert.equal(f.manager.status().preview, null);
  assert.throws(() => f.manager.dispatch({ operation: 'apply', hash: first }));
  const hash = prepare(f); assert.match(hash, /^[a-f0-9]{64}$/); f.manager.dispatch({ operation: 'apply', hash });
  assert.equal(f.policy.worker.read('one').revision, 1); f.manager.dispatch({ operation: 'apply', hash }); assert.equal(f.policy.worker.read('one').revision, 1);
  f.restart(); assert.equal(f.manager.status().current.definition.steps[0].label, 'Research the bounded change');
  chat(f, 'Edit Development pipeline'); chat(f, 'Rename step 1 to Unpublished draft'); f.restart();
  assert.equal(f.manager.status().draft.definition.steps[0].label, 'Unpublished draft');
  chat(f, 'Add Agent task after step 1 called Explore evidence');
  assert.match(f.manager.status().draft.definition.steps[1].id, /^step_[a-f0-9]{32}$/);
  assert.throws(() => chat(f, 'Rename step 1 to ' + 'a'.repeat(64)), /Sensitive/);
  chat(f, 'Discard this pipeline draft'); assert.equal(f.manager.status().draft, null); assert.equal(f.policy.worker.read('one').revision, 1);
});
test('registered frame/context rejects actor, foreign target, quotes, secrets, expired or changed proposals', t => {
  const f = fixture(t), frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { mainFrame: frame, isDestroyed: () => false };
  const channel = createPipelineControlChannel(f.manager, { contents, url: frame.url, context: () => ({ revision: f.manager.status().revision }) });
  const event = { sender: contents, senderFrame: frame }, dispatch = payload => channel.dispatch(event, { ...payload, contextRevision: f.manager.status().revision });
  assert.throws(() => channel.dispatch({ sender: {}, senderFrame: frame }, { operation: 'status' }));
  assert.throws(() => dispatch({ operation: 'begin', kind: 'development', scope: 'repository', origin: 'pm' }));
  assert.throws(() => dispatch({ operation: 'begin', kind: 'development', scope: 'repository', target: 'two' }));
  dispatch({ operation: 'chat', text: '"Use PM-triggered Autonomous Dev"' }); assert.equal(f.manager.status().draft, null);
  assert.throws(() => dispatch({ operation: 'chat', text: 'ghu_syntheticSecretOnly123' })); assert.equal(f.manager.status().draft, null);
  dispatch({ operation: 'preset', scenario: 'pm-autonomous' }); const hash = prepare(f); f.advance(900001);
  assert.throws(() => f.manager.dispatch({ operation: 'apply', hash }), /expired/i); assert.equal(f.policy.worker.read('one').revision, 0);
  prepare(f); f.apply({ 'privacy.conversationDays': 120 }); assert.throws(() => f.manager.dispatch({ operation: 'apply' }));
  assert.equal(f.policy.worker.read('one').revision, 1);
});
test('global inheritance, scoped restoration and a switched repository preserve drafts and unrelated policy', t => {
  const f = fixture(t); chat(f, 'Edit global Development pipeline'); chat(f, 'Rename step 1 to Global research');
  f.manager.dispatch({ operation: 'apply', hash: prepare(f) });
  assert.equal(f.policy.worker.read('two').values['pipelines.development'].source, 'global');
  chat(f, 'Edit repository Development pipeline'); chat(f, 'Rename step 1 to Repository research'); f.manager.dispatch({ operation: 'apply', hash: prepare(f) });
  chat(f, 'Reset Development pipeline to inherit'); f.manager.dispatch({ operation: 'apply', hash: prepare(f) });
  assert.equal(f.policy.worker.read('one').values['pipelines.development'].value.steps[0].label, 'Global research');
  assert.equal(f.policy.worker.read('one').values['pipelines.development'].source, 'global');
  f.apply({ 'privacy.conversationDays': 150 }); chat(f, 'Restore Development pipeline from version 0'); f.manager.dispatch({ operation: 'apply', hash: prepare(f) });
  assert.equal(f.policy.worker.read('one').values['privacy.conversationDays'].value, 150);
  chat(f, 'Edit Development pipeline'); chat(f, 'Rename step 1 to First repository draft'); const old = prepare(f);
  const before = f.manager.status().revision; f.store.select('two'); f.manager.sync(); assert.equal(f.manager.status().draft, null);
  assert.throws(() => f.manager.dispatch({ operation: 'apply', hash: old })); assert(f.manager.status().revision > before);
  f.store.select('one'); f.manager.sync(); assert.equal(f.manager.status().draft.definition.steps[0].label, 'First repository draft'); assert.equal(f.manager.status().preview, null);
});
test('invalid routes/bounds cannot publish; saved draft requires rebase after an independent policy change', t => {
  const f = fixture(t); chat(f, 'Edit Development pipeline'); chat(f, 'Set step 1 retries to 999');
  assert.throws(() => f.manager.dispatch({ operation: 'prepare' })); assert.equal(f.policy.worker.read('one').revision, 0);
  chat(f, 'Set step 1 retries to 2'); chat(f, 'Remove step 2'); assert.throws(() => f.manager.dispatch({ operation: 'prepare' }));
  chat(f, 'Send step 1 success to step 2'); chat(f, 'Send step 4 feedback to step 1'); f.apply({ 'privacy.conversationDays': 140 });
  assert.throws(() => f.manager.dispatch({ operation: 'prepare' }), /changed|base/i);
  chat(f, 'Refresh this pipeline draft'); f.manager.dispatch({ operation: 'apply', hash: prepare(f) });
  assert.equal(f.policy.worker.read('one').values['privacy.conversationDays'].value, 140);
  assert.equal(f.policy.worker.read('one').values['pipelines.development'].value.steps.length, 5);
});
test('a published graph never changes the actual captured run definition, revision or hash', async t => {
  const f = fixture(t), checkout = join(f.root, 'checkout'); mkdirSync(checkout);
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', checkout, ...args], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  git(['init', '--initial-branch=main']); git(['remote', 'add', 'origin', 'https://github.com/fixture/one.git']);
  f.apply({ 'agents.dev': 'dev', 'connections.codex': 'codex' });
  const run = (await f.policy.runtime.reserve(inspectWorkspace(checkout, { repository: 'one', owner: 'fixture', name: 'one' }), { commandId: 'claim', issue: 7, pipeline: 'development' })).run;
  chat(f, 'Use PM-triggered Autonomous Dev'); f.manager.dispatch({ operation: 'apply', hash: prepare(f) });
  const current = f.manager.status(); assert.equal(current.active.policyRevision, run.policyRevision); assert.equal(current.active.pipelineHash, run.pipelineHash);
  assert(current.active.definition.steps.some(step => step.kind === 'pm-qa')); assert.equal(current.current.definition.steps.some(step => step.kind === 'pm-qa'), false);
  assert.equal(f.policy.runtime.status('one').id, run.id); assert.equal(f.manager.agent, undefined);
});
test('a matching draft creates no version; release inheritance resets only its graph and matching publication', t => {
  const f = fixture(t); chat(f, 'Edit Development pipeline'); chat(f, 'Review this pipeline');
  assert.equal(f.manager.status().preview, null); assert.equal(f.manager.status().draft, null); assert.equal(f.policy.worker.read('one').revision, 0);
  chat(f, 'Edit Release pipeline'); chat(f, 'Add Artifact publication after step 3 called Publish the verified artifact'); f.manager.dispatch({ operation: 'apply', hash: prepare(f) });
  assert.equal(f.manager.status().current.publication, true); f.apply({ 'privacy.conversationDays': 145 });
  chat(f, 'Reset Release pipeline to inherit'); assert.equal(f.manager.status().draft.definition.steps.length, 3);
  f.manager.dispatch({ operation: 'apply', hash: prepare(f) }); assert.equal(f.manager.status().current.publication, false);
  assert.equal(f.policy.worker.read('one').values['privacy.conversationDays'].value, 145);
});
test('registered workspace identities remain exact while human text remains protected', t => {
  const f = fixture(t), id = 'repo_' + 'a'.repeat(24);
  f.store.register({ id, repositoryId: 'R3', slug: 'fixture/three', name: 'ghu_syntheticSecretOnly123', localKey: '1:4', path: f.root, project: { id: 'P1' } }); f.store.select(id);
  assert.equal(f.manager.status().workspaceId, id); assert.equal(f.manager.status().repositoryLabel, 'Sensitive text hidden');
});
test('plain PM pipeline bindings use only selected immutable tools and approved typed fields without granting permissions', t => {
  const f = fixture(t, true), item = f.tools.install(toolPackage({ name: 'queue', purpose: 'Check synthetic queue', version: '1', license: 'MIT', dataCategories: ['issue.title', 'pm.supplied'],
    command: { script: 'printf done', timeoutSeconds: 30, inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } }), 0);
  f.apply({ 'tools.extensions': [item.id] }); chat(f, 'Add an Extension step after step 2 called Check the queue');
  chat(f, 'Use tool queue in step 3'); chat(f, 'Give step 3 Issue title as title');
  const step = f.manager.status().draft.definition.steps[2];
  assert.equal(step.extension.pin, item.id); assert.deepEqual(step.extension.bindings, [{ path: ['title'], source: 'issue.title' }]);
  assert.deepEqual(step.permissions, item.permissions); assert.equal(step.retryLimit, 0);
  assert.throws(() => chat(f, 'Give step 3 Issue body as body'), /Pipeline .*data/i);
  assert.throws(() => f.manager.dispatch({ operation: 'edit', action: { operation: 'set', step: 3, field: 'extension', value: { ...step.extension, pin: 'tool-' + 'f'.repeat(40) } } }), /Pipeline .*selected/i);
  const hash = prepare(f); assert.equal(f.manager.status().preview.after['pipelines.development'].value.steps[2].extension.pin, item.id);
  f.manager.dispatch({ operation: 'apply', hash }); assert.equal(f.policy.worker.read('one').values['permissions.grants'].value.includes('extension.invoke'), false);
  f.restart(); assert.equal(f.manager.status().current.definition.steps[2].extension.pin, item.id);
  chat(f, 'Edit Development pipeline'); chat(f, 'Rename step 3 to Inspect the queue'); prepare(f);
  f.tools.remove(item.name, f.tools.revision()); assert.throws(() => f.manager.dispatch({ operation: 'apply' }), /Pipeline preview/);
  assert.equal(f.manager.status().draft.definition.steps[2].extension.pin, item.id);
});
test('nested PM input replacement preserves neighboring values and rejects reserved or overlapping paths', t => {
  const f = fixture(t, true), item = f.tools.install(toolPackage({ name: 'nested', purpose: 'Synthetic typed input', version: '1', license: 'MIT', dataCategories: ['pm.supplied', 'issue.title'],
    command: { script: 'printf done', timeoutSeconds: 30, inputSchema: { type: 'object' } } }), 0);
  f.apply({ 'tools.extensions': [item.id] }); chat(f, 'Use tool nested in step 2');
  chat(f, 'Set step 2 input label to text Preserved label'); chat(f, 'Set step 2 input options.name to text First');
  chat(f, 'Set step 2 input options.name to text Second'); chat(f, 'Remove step 2 input missing.label');
  assert.deepEqual(f.manager.status().draft.definition.steps[1].extension.constants, { label: 'Preserved label', options: { name: 'Second' } });
  chat(f, 'Remove step 2 input options.name'); chat(f, 'Give step 2 Issue title as options.name');
  assert.deepEqual(f.manager.status().draft.definition.steps[1].extension.constants, { label: 'Preserved label' });
  assert.throws(() => f.manager.dispatch({ operation: 'input', step: 2, path: ['__proto__', 'name'], source: 'pm.supplied', value: 'no' }));
  assert.throws(() => f.manager.dispatch({ operation: 'input', step: 2, path: ['options'], source: 'issue.title' }));
  assert.equal(f.manager.status().draft.definition.steps[1].extension.bindings[0].path.join('.'), 'options.name');
});
