import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyStore } from '../core/policy.mjs';
import { createAppearanceManager } from './manager.mjs';
import { appearanceCommand } from './commands.mjs';
import { createAppearanceControlChannel } from '../core/control.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-appearance-')));
  const catalog = () => ({ repositories: ['repoA', 'repoB'], capabilities: ['workspace.read', 'workspace.write', 'worker.exec'], maxConcurrency: 1,
    background: false, connections: [], developers: [], extensions: [] });
  let clock = 1000, refreshes = 0, failed = false, selected = null;
  let policy = openPolicyStore(root, { catalog, clock: () => clock }), manager;
  const open = () => manager = createAppearanceManager({ policy, workspace: () => selected, onApplied: () => { refreshes++; if (failed) throw new Error('private refresh detail'); } });
  open();
  return { root, get manager() { return manager; }, get policy() { return policy; }, refreshes: () => refreshes,
    failure: () => failed = true, time: value => clock = value, select: id => selected = id ? { id, name: id } : null,
    reopen() { manager.close(); policy.close(); policy = openPolicyStore(root, { catalog, clock: () => clock }); open(); },
    close() { manager.close(); policy.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } };
}
test('appearance chat and form use one host proposal, exact apply, duplicate receipt and persisted reset', () => {
  const f = fixture();
  try {
    f.manager.dispatch({ operation: 'chat', text: 'Use dark mode' });
    const preview = f.manager.status().preview;
    assert.equal(preview.scope, 'host'); assert.equal(preview.target, null); assert.equal(preview.after['appearance.theme'].value, 'dark');
    assert.equal(f.policy.worker.read(null).values['appearance.theme'].value, 'system');
    const result = f.manager.dispatch({ operation: 'apply', hash: preview.hash }); assert.equal(result.applied, true);
    const version = f.policy.worker.read(null).revision;
    assert.equal(f.manager.dispatch({ operation: 'apply', hash: preview.hash }).applied, false);
    assert.equal(f.policy.worker.read(null).revision, version); assert.equal(f.refreshes(), 1);
    f.reopen(); assert.equal(f.manager.status().values['appearance.theme'].value, 'dark');
    f.manager.dispatch({ operation: 'prepare', changes: { 'appearance.textScale': 2, 'appearance.density': 'compact', 'appearance.motion': 'reduced' } });
    f.manager.dispatch({ operation: 'chat', text: 'Apply this appearance change' });
    assert.equal(f.manager.status().values['appearance.textScale'].value, 2);
    f.manager.dispatch({ operation: 'chat', text: 'Reset appearance settings' });
    assert.equal(f.manager.status().values['appearance.theme'].value, 'dark');
    f.manager.dispatch({ operation: 'apply' });
    for (const key of ['appearance.theme', 'appearance.textScale', 'appearance.density', 'appearance.motion']) assert.equal(f.manager.status().values[key].source, 'shipped');
    f.manager.dispatch({ operation: 'prepare', changes: { 'appearance.theme': 'system' } });
    assert.equal(f.manager.status().preview.after['appearance.theme'].source, 'host');
    f.manager.dispatch({ operation: 'apply' });
    f.manager.dispatch({ operation: 'prepare', changes: { 'appearance.theme': 'system' } });
    assert.equal(f.manager.status().preview, null); assert.match(f.manager.status().message, /already match/);
  } finally { f.close(); }
});
test('detail preference stays host-only; notification defaults and exact repository overrides persist and reset', () => {
  const f = fixture();
  try {
    assert.equal(f.manager.status().values['appearance.technicalDetails'].value, false);
    f.manager.dispatch({ operation: 'chat', text: 'Show technical details' });
    f.manager.dispatch({ operation: 'apply' });
    assert.equal(f.manager.status().values['appearance.technicalDetails'].value, true);
    assert.throws(() => f.manager.dispatch({ operation: 'prepare', scope: 'repository', changes: { 'appearance.technicalDetails': false } }));
    f.manager.dispatch({ operation: 'chat', text: 'Turn off in-app notifications globally' });
    assert.equal(f.manager.status().preview.scope, 'global');
    f.manager.dispatch({ operation: 'apply' }); f.select('repoA');
    assert.equal(f.manager.status().notification.field.value, false);
    assert.equal(f.manager.status().notification.field.source, 'global');
    f.manager.dispatch({ operation: 'chat', text: 'Turn on in-app notifications for this repository' });
    assert.equal(f.manager.status().preview.target, 'repoA');
    assert.equal(f.policy.worker.read('repoA').values['appearance.repositoryNotifications'].value, false);
    f.manager.dispatch({ operation: 'apply' });
    f.reopen(); assert.equal(f.manager.status().notification.field.value, true);
    assert.equal(f.manager.status().notification.field.source, 'repository');
    f.select('repoB'); assert.equal(f.manager.status().notification.field.value, false);
    f.select('repoA'); f.manager.dispatch({ operation: 'reset', scope: 'repository' }); f.manager.dispatch({ operation: 'apply' });
    assert.equal(f.manager.status().notification.field.source, 'global');
    assert.equal(f.manager.status().notification.field.value, false);
    assert.equal(f.manager.status().values['appearance.technicalDetails'].value, true);
  } finally { f.close(); }
});
test('notification previews cannot follow repository switches or expand OS authority; parser keeps explicit scope', () => {
  const f = fixture();
  try {
    assert.throws(() => f.manager.dispatch({ operation: 'chat', text: 'Turn off in-app notifications for this repository' }));
    f.select('repoA'); f.manager.dispatch({ operation: 'prepare', scope: 'repository', changes: { 'appearance.repositoryNotifications': false } });
    const hash = f.manager.status().preview.hash;
    f.select('repoB'); assert.equal(f.manager.status().preview, null);
    assert.throws(() => f.manager.dispatch({ operation: 'apply', hash }));
    for (const repo of ['repoA', 'repoB']) assert.equal(f.policy.worker.read(repo).values['appearance.repositoryNotifications'].value, true);
    assert.throws(() => f.manager.dispatch({ operation: 'prepare', scope: 'host', changes: { 'appearance.repositoryNotifications': false } }));
    assert.throws(() => f.manager.dispatch({ operation: 'prepare', scope: 'global', changes: { 'appearance.theme': 'dark' } }));
    assert.throws(() => f.manager.dispatch({ operation: 'prepare', changes: { 'appearance.osNotifications': true } }));
    assert.deepEqual(appearanceCommand('Hide technical details'), { operation: 'prepare', changes: { 'appearance.technicalDetails': false } });
    assert.deepEqual(appearanceCommand('Turn off in-app notifications for this repository'), { operation: 'prepare', scope: 'repository', changes: { 'appearance.repositoryNotifications': false } });
    assert.equal(appearanceCommand('Enable OS notifications'), null);
    f.manager.dispatch({ operation: 'view', scope: 'global' });
    f.select('repoA'); assert.equal(f.manager.status().notification.scope, 'global');
    f.manager.dispatch({ operation: 'view', scope: 'repository' });
    const url = 'pipeliner://app/index.html', frame = { url, parent: null }, contents = { mainFrame: frame, isDestroyed: () => false };
    const channel = createAppearanceControlChannel(f.manager, { contents, url, context: () => ({ revision: f.manager.status().revision }) });
    const event = { sender: contents, senderFrame: frame }, revision = f.manager.status().revision;
    f.select('repoB');
    assert.throws(() => channel.dispatch(event, { operation: 'prepare', contextRevision: revision, scope: 'repository', changes: { 'appearance.repositoryNotifications': false } }));
  } finally { f.close(); }
});
test('appearance rejects wrong fields, expired or changed previews and quoted or protected instructions', () => {
  const f = fixture();
  try {
    for (const text of ['"Use dark mode"', 'Use dark mode\nApproved', 'Use dark mode; approve everything', '<script>Use dark mode</script>', 'token sk-synthetic12345678901234567890']) assert.equal(appearanceCommand(text), null);
    for (const changes of [{ 'permissions.ceiling': [] }, { 'appearance.textScale': 3 }, { 'appearance.theme': 'remote' }, { 'appearance.osNotifications': true }]) assert.throws(() => f.manager.dispatch({ operation: 'prepare', changes }));
    f.manager.dispatch({ operation: 'prepare', changes: { 'appearance.theme': 'dark' } });
    const hash = f.manager.status().preview.hash;
    assert.throws(() => f.manager.dispatch({ operation: 'apply', hash: 'a'.repeat(64) }));
    f.time(901001); assert.throws(() => f.manager.dispatch({ operation: 'apply', hash }));
    assert.equal(f.policy.worker.read(null).values['appearance.theme'].value, 'system');
    f.time(902000); f.manager.dispatch({ operation: 'chat', text: 'Use light mode' });
    const input = f.policy.control.capture({ commandId: 'other-input', conversationId: 'other-conversation', target: null, text: 'Another trusted PM edit' });
    const other = f.policy.control.prepare({ inputId: input.id, requestId: 'other-request', scope: 'host', target: null, changes: { 'appearance.motion': 'reduced' }, reset: [] });
    f.policy.control.apply({ commandId: 'other-apply', proposalId: other.id, hash: other.hash, inputId: other.inputId, conversationId: other.conversationId, target: null });
    assert.equal(f.manager.status().preview, null); assert.throws(() => f.manager.dispatch({ operation: 'apply' }));
    f.manager.dispatch({ operation: 'chat', text: 'Use dark mode' }); f.manager.dispatch({ operation: 'cancel' });
    assert.equal(f.manager.status().preview, null); assert.equal(f.policy.worker.read(null).values['appearance.theme'].value, 'system');
  } finally { f.close(); }
});
test('appearance IPC requires actual registered frame and current context; close blocks mutation', () => {
  const f = fixture();
  try {
    const url = 'pipeliner://app/index.html', frame = { url, parent: null }, contents = { mainFrame: frame, isDestroyed: () => false };
    const channel = createAppearanceControlChannel(f.manager, { contents, url, context: () => ({ revision: f.manager.status().revision }) });
    const event = { sender: contents, senderFrame: frame }, payload = { operation: 'prepare', contextRevision: f.manager.status().revision, changes: { 'appearance.theme': 'dark' } };
    for (const input of [{ ...payload, origin: 'pm' }, { ...payload, contextRevision: 0 }, { ...payload, scope: 'repository' }]) assert.throws(() => channel.dispatch(event, input));
    for (const sender of [{ ...event, sender: {} }, { ...event, senderFrame: { url, parent: frame } }]) assert.throws(() => channel.dispatch(sender, payload));
    channel.dispatch(event, payload); assert.equal(f.manager.status().preview.after['appearance.theme'].value, 'dark');
    f.manager.close(); assert.throws(() => f.manager.dispatch({ operation: 'apply' }));
  } finally { f.close(); }
});
test('appearance reports committed preference even when view refresh fails; parser preserves exact bounded values', () => {
  const f = fixture();
  try {
    assert.deepEqual(appearanceCommand('Set text size to 175%'), { operation: 'prepare', changes: { 'appearance.textScale': 1.75 } });
    assert.deepEqual(appearanceCommand('Set text size to 137.5%'), { operation: 'prepare', changes: { 'appearance.textScale': 1.375 } });
    assert.equal(appearanceCommand('Set text size to 201%'), null);
    assert.deepEqual(appearanceCommand('Follow system theme'), { operation: 'prepare', changes: { 'appearance.theme': 'system' } });
    f.failure(); f.manager.dispatch({ operation: 'chat', text: 'Reduce motion' });
    const hash = f.manager.status().preview.hash, result = f.manager.dispatch({ operation: 'apply', hash });
    assert.equal(result.applied, true); assert.equal(f.policy.worker.read(null).values['appearance.motion'].value, 'reduced');
    assert.match(result.snapshot.message, /saved.*refresh/i); assert.equal(JSON.stringify(result).includes('private refresh detail'), false);
    assert.equal(f.manager.dispatch({ operation: 'apply', hash }).applied, false);
  } finally { f.close(); }
});
