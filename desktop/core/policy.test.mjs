import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openPolicyStore } from './policy.mjs';
import { settingsSchema, developmentTemplate, releaseTemplate, legacyDefaults, canonicalJSON } from './settings.mjs';
import { createControlChannel } from './control.mjs';
import { createConfigurationExport, configurationChanges } from '../privacy/model.mjs';

const repository = 'R_example_one';
const other = 'R_example_two';

test('configuration snapshot preserves explicit scope and restore uses current PM validation without weakening ceilings', t => {
  const f = fixture(t); f.apply(f.proposal({ 'privacy.logDays': 12 }, 'global', null));
  f.apply(f.proposal({ 'privacy.auditDays': 400 }));
  const snapshot = f.store.control.configuration('repository', repository);
  assert.deepEqual(snapshot.settings, { 'privacy.auditDays': 400 }); assert.equal(snapshot.revision, 2);
  const exported = createConfigurationExport(snapshot, 1000); assert.equal(f.store.worker.configuration, undefined);
  f.apply(f.proposal({ 'privacy.auditDays': 500, 'privacy.conversationDays': 100 }));
  const before = f.store.worker.read(repository), edit = configurationChanges(exported, {
    scope: 'repository', target: repository, currentSettings: f.store.control.configuration('repository', repository).settings });
  const preview = f.proposal(edit.changes, 'repository', repository, edit.reset);
  assert.equal(f.store.worker.read(repository).revision, before.revision);
  f.apply(preview); assert.equal(f.store.worker.read(repository).values['privacy.auditDays'].value, 400);
  assert.equal(f.store.worker.read(repository).values['privacy.conversationDays'].source, 'shipped');
  assert.equal(f.store.worker.read(other).values['privacy.logDays'].value, 12);
  assert.deepEqual(f.store.worker.read(repository, before.revision).values, before.values);
  const escalating = createConfigurationExport({ ...snapshot, settings: { 'permissions.grants': ['github.read'] } }, 1000);
  const unsafe = configurationChanges(escalating, { scope: 'repository', target: repository, currentSettings: snapshot.settings });
  assert.throws(() => f.proposal(unsafe.changes, 'repository', repository, unsafe.reset), /ceiling/);
  assert.throws(() => f.store.control.configuration('host', repository), /scope/);
});

test('additive scheduling schema reads immutable legacy policy hashes and upgrades only on a reviewed edit', t => {
  const f = fixture(t); f.store.close();
  const database = new DatabaseSync(join(f.directory, 'policy.sqlite'));
  const document = { schemaVersion: 1, defaults: legacyDefaults, host: {}, global: {}, repositories: {} }, hash = createHash('sha256').update(canonicalJSON({ document, catalog: facts() })).digest('hex');
  database.exec('DROP TRIGGER immutable_policy_update'); database.prepare('UPDATE policy_versions SET document=?,hash=? WHERE revision=0').run(canonicalJSON(document), hash); database.close();
  const old = f.open(); assert.equal(old.worker.read(repository).hash, hash); assert.equal(old.worker.read(repository).values['scheduling.mode'].value, 'interval');
  const input = old.control.capture({ commandId: 'legacy-edit', conversationId: 'legacy-chat', target: repository, text: 'Use a 45 minute interval.' });
  const p = old.control.prepare({ inputId: input.id, requestId: 'legacy-preview', target: repository, scope: 'repository', changes: { 'scheduling.intervalMinutes': 45 }, reset: [] });
  old.control.apply({ commandId: 'legacy-apply', proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId: 'legacy-chat', target: repository });
  assert.equal(old.worker.read(repository).schemaVersion, 3); assert.equal(old.worker.read(repository, 0).hash, hash); assert.equal(old.worker.read(repository, 0).values['scheduling.enabled'].value, false);
  assert.equal(old.worker.read(repository).values['scheduling.intervalMinutes'].value, 45);
});

test('calendar policy requires explicit complete named-zone configuration before enabling', t => {
  const f = fixture(t);
  assert.throws(() => f.proposal({ 'scheduling.enabled': true, 'scheduling.mode': 'calendar' }), /Calendar/);
  assert.throws(() => f.proposal({ 'scheduling.calendar': { days: [0, 0], time: '09:00' } }));
  f.apply(f.proposal({ 'scheduling.enabled': true, 'scheduling.mode': 'calendar', 'scheduling.calendar': { days: [1, 2, 3, 4, 5], time: '09:00' }, 'scheduling.timezone': 'America/Chicago' }));
  assert.equal(f.store.worker.read(repository).values['background.enabled'].value, false);
  assert.equal(f.store.worker.read(repository).values['intake.trigger'].value, 'pm');
});

test('tools have empty safe defaults; exact legacy version two survives reopen until PM apply', t => {
  const f = fixture(t); f.store.close();
  const settings = settingsSchema(), oldDefaults = Object.fromEntries(settings.filter(field => !field.id.startsWith('tools.')).map(field => [field.id, field.defaultValue]));
  assert.equal(createHash('sha256').update(canonicalJSON(oldDefaults)).digest('hex'), 'df27c746de7ab30bd9ec014966e681844eb1f4d29dc5bbc57e6a2d4c4a646883', 'defaults match the actual committed schema-two candidate');
  const document = { schemaVersion: 2, defaults: oldDefaults, host: {}, global: {}, repositories: {} }, hash = createHash('sha256').update(canonicalJSON({ document, catalog: facts() })).digest('hex');
  const db = new DatabaseSync(join(f.directory, 'policy.sqlite')); db.exec('DROP TRIGGER immutable_policy_update'); db.prepare('UPDATE policy_versions SET document=?,hash=? WHERE revision=0').run(canonicalJSON(document), hash); db.close();
  const reopened = f.open(); assert.equal(reopened.worker.read(repository).hash, hash); assert.deepEqual(reopened.worker.read(repository).values['tools.extensions'].value, []);
  assert.deepEqual(reopened.worker.authority(repository, 0).tools, []); assert.equal(reopened.worker.authority(repository, 0).capabilities.includes('extension.invoke'), false);
  const input = reopened.control.capture({ commandId: 'v2-edit', conversationId: 'v2-chat', target: repository, text: 'Change interval to 35 minutes.' });
  const preview = reopened.control.prepare({ inputId: input.id, requestId: 'v2-preview', scope: 'repository', target: repository, changes: { 'scheduling.intervalMinutes': 35 }, reset: [] });
  reopened.control.apply({ commandId: 'v2-apply', proposalId: preview.id, hash: preview.hash, inputId: input.id, conversationId: 'v2-chat', target: repository });
  assert.equal(reopened.worker.read(repository).schemaVersion, 3); assert.equal(reopened.worker.read(repository, 0).hash, hash);
});

test('tool invocation needs captured pins and both permission scopes; disabling is durable across re-enable/restart', t => {
  const f = fixture(t), catalog = facts(), pin = 'tool-' + 'a'.repeat(40);
  catalog.capabilities.push('extension.invoke'); catalog.tools = [{ id: pin, digest: 'b'.repeat(64) }]; f.setCatalog(catalog);
  assert.throws(() => f.proposal({ 'tools.extensions': ['unknown-tool'] }), /Referenced capability/);
  assert.throws(() => f.proposal({ 'permissions.grants': ['extension.invoke'] }), /ceiling/);
  f.apply(f.proposal({ 'permissions.ceiling': ['workspace.read', 'workspace.write', 'worker.exec', 'extension.invoke'] }, 'host', null));
  f.apply(f.proposal({ 'permissions.grants': ['workspace.read', 'workspace.write', 'worker.exec', 'extension.invoke'], 'tools.extensions': [pin] }));
  const captured = f.store.worker.read(repository).revision;
  assert.deepEqual(f.store.worker.authority(repository, captured).tools, [pin]); assert.deepEqual(f.store.worker.authority(repository, 0).tools, []);
  f.apply(f.proposal({ 'tools.disabled': [pin] })); f.apply(f.proposal({ 'tools.disabled': [] }));
  const reopened = f.open(); assert.deepEqual(reopened.worker.authority(repository, captured).tools, []); assert.deepEqual(reopened.worker.authority(repository, captured).deniedTools, [pin]);
  const current = reopened.worker.read(repository).revision; assert.deepEqual(reopened.worker.authority(repository, current).tools, [pin]);
  catalog.tools[0].digest = 'c'.repeat(64); f.setCatalog(catalog); assert.deepEqual(reopened.worker.authority(repository, current).tools, []);
});
const facts = () => ({ repositories: [repository, other], capabilities: ['workspace.read', 'workspace.write', 'worker.exec', 'github.read'],
  maxConcurrency: 1, background: false, connections: [{ id: 'github-one', provider: 'github', repositories: [repository, other] }, { id: 'codex-one', provider: 'codex', repositories: [repository, other] }],
  developers: [{ id: 'dev-one', connection: 'codex-one', metrics: ['tokens'] }, { id: 'dev-two', connection: 'codex-one', metrics: [] }], extensions: [] });
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-d07-')));
  let catalog = facts(); let now = 1000;
  const stores = [];
  const open = () => { const s = openPolicyStore(directory, { catalog: () => catalog, clock: () => now }); stores.push(s); return s; };
  const store = open();
  t.after(() => { for (const s of stores) s.close(); rmSync(directory, { recursive: true }); assert.equal(existsSync(directory), false); });
  let command = 0;
  const proposal = (changes, scope = 'repository', target = repository, reset = []) => {
    const input = store.control.capture({ commandId: `input-${++command}`, conversationId: 'conversation-one', target, text: 'Change these settings.' });
    return store.control.prepare({ inputId: input.id, requestId: `proposal-${command}`, scope, target, changes, reset });
  };
  const apply = p => store.control.apply({ commandId: `apply-${++command}`, proposalId: p.id, hash: p.hash, inputId: p.inputId, conversationId: p.conversationId, target: p.target });
  return { store, open, proposal, apply, directory, setCatalog: value => { catalog = value; }, advance: value => { now += value; } };
}

test('one durable PM apply is consumed once, keeps history and survives reopening', t => {
  const f = fixture(t); const p = f.proposal({ 'scheduling.enabled': true });
  assert.equal(p.before['scheduling.enabled'].value, false);
  assert.equal(p.after['scheduling.enabled'].value, true);
  assert.equal(p.after['scheduling.enabled'].source, 'repository');
  const result = f.apply(p); assert.equal(result.applied, true); assert.equal(result.revision, 1);
  assert.equal(f.apply(p).applied, false); assert.equal(f.store.worker.read(repository).revision, 1);
  f.store.close(); const reopened = f.open();
  assert.equal(reopened.worker.read(repository).values['scheduling.enabled'].value, true);
  assert.equal(reopened.worker.read(repository, 0).values['scheduling.enabled'].value, false);
  assert.equal(reopened.control.apply({ commandId: 'repeated-after-restart', proposalId: p.id, hash: p.hash, inputId: p.inputId, conversationId: p.conversationId, target: p.target }).applied, false);
});

test('global inheritance, complete list replacement and reset remove the override', t => {
  const f = fixture(t);
  f.apply(f.proposal({ 'agents.fallbacks': ['dev-one', 'dev-two'] }, 'global', null));
  f.apply(f.proposal({ 'agents.fallbacks': ['dev-two'] }));
  assert.deepEqual(f.store.worker.read(repository).values['agents.fallbacks'].value, ['dev-two']);
  assert.deepEqual(f.store.worker.read(other).values['agents.fallbacks'].value, ['dev-one', 'dev-two']);
  f.apply(f.proposal({}, 'repository', repository, ['agents.fallbacks']));
  f.apply(f.proposal({ 'agents.fallbacks': ['dev-one'] }, 'global', null));
  const value = f.open().worker.read(repository).values['agents.fallbacks'];
  assert.deepEqual(value.value, ['dev-one']); assert.equal(value.source, 'global');
});

test('stale, altered, wrong-target, expired and edited-input proposals have no policy effect', t => {
  const f = fixture(t); const p = f.proposal({ 'scheduling.intervalMinutes': 45 });
  const request = { commandId: 'bad-apply', proposalId: p.id, hash: p.hash, inputId: p.inputId, conversationId: p.conversationId, target: p.target };
  assert.throws(() => f.store.control.apply({ ...request, target: other }), /context/i);
  assert.throws(() => f.store.control.apply({ ...request, conversationId: 'other-chat' }), /context/i);
  assert.throws(() => f.store.control.apply({ ...request, hash: '0'.repeat(64) }), /proposal/i);
  f.store.control.invalidate(p.inputId); assert.throws(() => f.store.control.apply(request), /input/i);
  const expiring = f.proposal({ 'scheduling.intervalMinutes': 50 }); f.advance(900001);
  assert.throws(() => f.apply(expiring), /expired/i);
  const stale = f.proposal({ 'scheduling.intervalMinutes': 55 });
  f.apply(f.proposal({ 'privacy.conversationDays': 120 }, 'global', null));
  assert.throws(() => f.apply(stale), /stale/i);
  assert.equal(f.store.worker.read(repository).revision, 1);
  assert.equal(f.store.worker.read(repository).values['scheduling.intervalMinutes'].value, 30);
});

test('worker proposals cannot publish, forged roles and malformed payloads fail closed', t => {
  const f = fixture(t); assert.equal(f.store.worker.apply, undefined); assert.equal(f.store.worker.capture, undefined);
  const suggestion = f.store.worker.propose({ scope: 'repository', target: repository, changes: { 'scheduling.enabled': true }, reset: [] });
  assert.equal(suggestion.origin, 'agent'); assert.equal(suggestion.id, undefined);
  assert.throws(() => f.apply(suggestion));
  for (const changes of [{ role: 'pm' }, { 'permissions.disableEnforcement': true }, { roadmap: 'D-07' }, { 'connections.apiKey': 'synthetic-secret' }, { 'scheduling.intervalMinutes': Infinity }]) assert.throws(() => f.proposal(changes));
  assert.throws(() => f.proposal({ 'background.enabled': true }, 'repository'), /host/i);
  assert.throws(() => f.proposal({ 'background.enabled': true }, 'host', null), /capability/i);
  assert.equal(f.store.worker.read(repository).revision, 0);
});

test('capability ceilings, measurable budgets and current revocations constrain captured authority', t => {
  const f = fixture(t);
  assert.throws(() => f.proposal({ 'permissions.grants': ['host.admin'] }));
  assert.throws(() => f.proposal({ 'permissions.grants': ['github.read'] }), /ceiling/i);
  assert.throws(() => f.proposal({ 'limits.tokens': 100 }), /metric/i);
  f.apply(f.proposal({ 'agents.dev': 'dev-one', 'limits.tokens': 100 }));
  f.apply(f.proposal({ 'permissions.ceiling': ['workspace.read', 'workspace.write', 'worker.exec', 'github.read'] }, 'host', null));
  f.apply(f.proposal({ 'permissions.grants': ['workspace.read', 'workspace.write', 'worker.exec', 'github.read'] }));
  const captured = f.store.worker.read(repository).revision;
  f.apply(f.proposal({ 'permissions.ceiling': ['workspace.read'] }, 'host', null));
  assert.deepEqual(f.store.worker.authority(repository, captured).capabilities, ['workspace.read']);
  f.apply(f.proposal({ 'permissions.ceiling': ['workspace.read', 'github.read'] }, 'host', null));
  assert.deepEqual(f.store.worker.authority(repository, 0).capabilities, ['workspace.read']);
  assert.deepEqual(f.store.worker.authority(repository, captured).capabilities, ['workspace.read']);
  assert.deepEqual(f.store.worker.authority(repository, f.store.worker.read(repository).revision).capabilities, ['workspace.read', 'github.read']);
  f.apply(f.proposal({ 'agents.dev': 'dev-two', 'limits.tokens': null }));
  assert.equal(f.store.worker.authority(repository, captured).dev, 'dev-one');
  const current = facts(); current.developers = []; current.capabilities = []; f.setCatalog(current);
  assert.deepEqual(f.store.worker.authority(repository, captured).capabilities, []);
  assert.equal(f.store.worker.authority(repository, captured).dev, null);
});

test('duplicate input/proposal identities reconcile and changed payloads cannot reuse them', t => {
  const f = fixture(t);
  const input = { commandId: 'same-input', conversationId: 'conversation-one', target: repository, text: 'Change the interval.' };
  const first = f.store.control.capture(input); assert.deepEqual(f.store.control.capture(input), first);
  assert.throws(() => f.store.control.capture({ ...input, text: 'Changed text.' }), /conflict/i);
  const request = { inputId: first.id, requestId: 'same-proposal', scope: 'repository', target: repository, changes: { 'scheduling.intervalMinutes': 75 }, reset: [] };
  const p = f.store.control.prepare(request); assert.deepEqual(f.store.control.prepare(request), p);
  assert.throws(() => f.store.control.prepare({ ...request, changes: { 'scheduling.intervalMinutes': 80 } }), /conflict/i);
  assert.equal(f.apply(p).revision, 1);
  assert.throws(() => f.proposal({}, 'repository', repository, ['agents.fallbacks']), /no change/i);
  assert.throws(() => f.proposal({}, 'repository', other, ['agents.fallbacks']), /no change/i);
});

test('corrupt or incompatible durable state fails closed without resetting policy', t => {
  const f = fixture(t); f.apply(f.proposal({ 'scheduling.intervalMinutes': 70 })); f.store.close();
  const database = new DatabaseSync(join(f.directory, 'policy.sqlite'));
  assert.throws(() => database.exec('UPDATE policy_versions SET hash=\'forged\''), /immutable/i);
  database.exec('PRAGMA user_version=99'); database.close();
  assert.throws(() => f.open(), /schema/i);
  const inspect = new DatabaseSync(join(f.directory, 'policy.sqlite'));
  assert.equal(inspect.prepare('SELECT MAX(revision) AS revision FROM policy_versions').get().revision, 1);
  inspect.exec('PRAGMA user_version=1; DROP TRIGGER immutable_policy_update;');
  inspect.prepare('UPDATE policy_versions SET hash=? WHERE revision=1').run('0'.repeat(64)); inspect.close();
  assert.throws(() => f.open(), /integrity/i);
});

test('pipeline validation rejects missing integration, unreachable steps and autonomous gates', t => {
  const f = fixture(t); const missing = structuredClone(developmentTemplate);
  missing.steps.find(s => s.kind === 'pr-integration').kind = 'check';
  assert.throws(() => f.proposal({ 'pipelines.development': missing }), /integration/i);
  const unreachable = structuredClone(developmentTemplate); unreachable.steps.push({ ...unreachable.steps[0], id: 'unreachable', label: 'Unreachable step' });
  assert.throws(() => f.proposal({ 'pipelines.development': unreachable }), /reachable/i);
  const unbounded = structuredClone(developmentTemplate); unbounded.steps[0].visitLimit = 0;
  assert.throws(() => f.proposal({ 'pipelines.development': unbounded }), /pipeline/i);
  assert.throws(() => f.proposal({ 'autonomy.scenario': 'pm-autonomous' }), /gate/i);
  const autonomous = structuredClone(developmentTemplate);
  autonomous.steps = autonomous.steps.filter(s => s.kind !== 'pm-qa');
  autonomous.steps.find(s => s.routes.success === 'pm-testing').routes.success = 'integrate';
  f.apply(f.proposal({ 'autonomy.scenario': 'pm-autonomous', 'pipelines.development': autonomous }));
  assert.throws(() => f.proposal({ 'autonomy.scenario': 'scheduled-autonomous' }), /trigger/i);
  const captured = f.store.worker.read(repository).revision;
  f.apply(f.proposal({ 'scheduling.intervalMinutes': 60 }));
  assert.equal(f.store.worker.read(repository, captured).values['scheduling.intervalMinutes'].value, 30);
  assert.equal(releaseTemplate.steps.some(s => s.kind === 'pm-qa'), false);
});

test('restore requires fresh PM input and publishes a new revision', t => {
  const f = fixture(t); f.apply(f.proposal({ 'scheduling.intervalMinutes': 45 }));
  const input = f.store.control.capture({ commandId: 'restore-input', conversationId: 'conversation-one', target: repository, text: 'Restore earlier settings.' });
  const p = f.store.control.prepare({ inputId: input.id, requestId: 'restore-proposal', scope: 'repository', target: repository, changes: {}, reset: [], restoreRevision: 0 });
  assert.equal(f.apply(p).revision, 2);
  assert.equal(f.store.worker.read(repository).values['scheduling.intervalMinutes'].value, 30);
  assert.equal(f.store.worker.read(repository, 1).values['scheduling.intervalMinutes'].value, 45);
});

test('Development completion requires successful integration and supervised QA before merge', t => {
  const blank = structuredClone(developmentTemplate); blank.steps[0].label = '   ';
  assert.throws(() => fixture(t).proposal({ 'pipelines.development': blank }), /name/i);
  const duplicate = structuredClone(developmentTemplate); duplicate.steps[1].label = '  RESEARCH AND SPECIFY THE ISSUE  ';
  assert.throws(() => fixture(t).proposal({ 'pipelines.development': duplicate }), /unique/i);
  const f = fixture(t), failed = structuredClone(developmentTemplate);
  failed.steps.find(step => step.kind === 'pr-integration').routes.failure = 'complete';
  assert.throws(() => f.proposal({ 'pipelines.development': failed }), /integration/i);
  const bypass = structuredClone(developmentTemplate);
  bypass.steps.find(step => step.id === 'review').routes.success = 'integrate';
  bypass.steps.find(step => step.id === 'review').routes.feedback = 'pm-testing';
  assert.throws(() => f.proposal({ 'autonomy.scenario': 'supervised', 'pipelines.development': bypass }), /QA.*before|pre-merge/i);
  const late = structuredClone(developmentTemplate);
  late.steps.find(step => step.id === 'review').routes.success = 'integrate';
  late.steps.find(step => step.id === 'integrate').routes.success = 'pm-testing';
  late.steps.find(step => step.id === 'pm-testing').routes.success = 'complete';
  assert.throws(() => f.proposal({ 'autonomy.scenario': 'supervised', 'pipelines.development': late }), /QA.*before|pre-merge/i);
});

test('canonical Settings exposes all categories and accepted safe defaults', t => {
  const f = fixture(t); const schema = settingsSchema();
  assert.equal(new Set(schema.map(s => s.category)).size, 15);
  const values = f.store.worker.read(repository).values;
  assert.equal(values['autonomy.scenario'].value, null);
  assert.equal(values['background.enabled'].value, false);
  assert.equal(values['background.startAtLogin'].value, false);
  assert.equal(values['limits.stepTurns'].value, 20);
  assert.equal(values['limits.issueTurns'].value, 100);
  assert.equal(values['privacy.telemetry'].value, false);
  assert.equal(values['delivery.publish'].value, false);
  assert.equal(values['appearance.theme'].value, 'system');
  assert.equal(values['updates.channel'].value, 'stable');
  assert.equal(schema.some(s => /roadmap|milestone|D-07/.test(s.id)), false);
});

test('control channel binds the registered live main frame and host-owned context', t => {
  const f = fixture(t);
  const frame = { url: 'pipeliner://app/index.html', parent: null };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  let context = { conversationId: 'conversation-one', target: repository, revision: 1 };
  const channel = createControlChannel(f.store.control, { contents, url: frame.url, context: () => context });
  const event = { sender: contents, senderFrame: frame };
  const input = channel.dispatch(event, { operation: 'input', contextRevision: 1, commandId: 'native-input', text: 'Change the interval.' });
  const p = channel.dispatch(event, { operation: 'prepare', contextRevision: 1, inputId: input.id, requestId: 'native-proposal', scope: 'repository', changes: { 'scheduling.intervalMinutes': 40 }, reset: [] });
  for (const sender of [{ sender: { ...contents }, senderFrame: frame }, { sender: contents, senderFrame: { ...frame } }, { sender: contents, senderFrame: null }]) assert.throws(() => channel.dispatch(sender, { operation: 'apply', contextRevision: 1, commandId: 'forged', proposalId: p.id, hash: p.hash, inputId: p.inputId }), /sender/i);
  context = { ...context, target: other, revision: 2 };
  assert.throws(() => channel.dispatch(event, { operation: 'apply', contextRevision: 1, commandId: 'stale-context', proposalId: p.id, hash: p.hash, inputId: p.inputId }), /context/i);
  assert.throws(() => channel.dispatch(event, { operation: 'invalidate-input', contextRevision: 2, inputId: input.id }), /context/i);
  assert.equal(f.store.worker.read(repository).revision, 0);
});

test('input provenance retains a hash rather than raw PM text', t => {
  const f = fixture(t); const synthetic = 'SYNTHETIC-PRIVATE-INPUT';
  f.store.control.capture({ commandId: 'private-input', conversationId: 'conversation-one', target: repository, text: synthetic });
  const database = new DatabaseSync(join(f.directory, 'policy.sqlite'), { readOnly: true });
  try { const row = database.prepare('SELECT text_hash FROM policy_inputs WHERE command_id=?').get('private-input'); assert.match(row.text_hash, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(row).includes(synthetic), false); }
  finally { database.close(); }
});
