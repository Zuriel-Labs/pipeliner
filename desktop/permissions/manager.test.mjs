import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyStore } from '../core/policy.mjs';
import { createPermissionManager } from './manager.mjs';
import { permissionCommand } from './commands.mjs';
import { createPermissionControlChannel } from '../core/control.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-permissions-')));
  let selected = 'first', clock = 1000, capabilities = ['workspace.read', 'workspace.write', 'worker.exec', 'provider.turn'], fail = false;
  const changes = [], resources = ['output'];
  const policy = openPolicyStore(root, { clock: () => clock, catalog: () => ({ repositories: ['first', 'second'], capabilities, resources,
    maxConcurrency: 1, background: false, connections: [], developers: [], extensions: [] }) });
  const manager = createPermissionManager({ policy, workspace: () => selected ? { id: selected, name: selected, path: '/synthetic/' + selected } : null,
    available: () => ({ capabilities, resources }), onApplied: async value => { changes.push(value); if (fail) throw Error('private termination failure'); } });
  return { policy, manager, changes, select(value) { selected = value; manager.sync(); }, time(value) { clock = value; }, fail() { fail = true; }, repair() { fail = false; },
    qualify(value) { capabilities = value; }, async close() { await manager.close(); policy.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } };
}
const chat = (f, text) => f.manager.dispatch({ operation: 'chat', text });
const apply = f => f.manager.dispatch({ operation: 'apply', hash: f.manager.status().preview.hash });

test('PM chat narrows one repository, permanently revokes captured authority and preserves unrelated scope', async () => {
  const f = fixture();
  try {
    const captured = f.policy.worker.read('first').revision;
    await chat(f, 'Revoke editing project files for this repository');
    assert.equal(f.manager.status().preview.target, 'first'); assert.equal(f.policy.worker.authority('first', captured).capabilities.includes('workspace.write'), true);
    await apply(f); assert.equal(f.policy.worker.authority('first', captured).capabilities.includes('workspace.write'), false);
    assert.equal(f.policy.worker.authority('second', captured).capabilities.includes('workspace.write'), true);
    assert.deepEqual(f.changes[0].repositories, ['first']);
    await chat(f, 'Allow editing project files for this repository'); await apply(f);
    assert.equal(f.policy.worker.authority('first', captured).capabilities.includes('workspace.write'), false);
    assert.equal(f.policy.worker.authority('first', f.policy.worker.read('first').revision).capabilities.includes('workspace.write'), true);
    assert.equal(f.manager.status().values['permissions.grants'].source, 'repository');
  } finally { await f.close(); }
});
test('host ceilings, global defaults, resource references and masked configured grants remain distinct', async () => {
  const f = fixture();
  try {
    await chat(f, 'Allow sending model requests on this Mac'); await apply(f);
    await chat(f, 'Allow sending model requests globally'); await apply(f);
    assert.equal(f.policy.worker.read('second').values['permissions.grants'].source, 'global');
    await chat(f, 'Allow qualified resource output for this repository'); await apply(f);
    assert.deepEqual(f.policy.worker.read('first').values['permissions.resources'].value, ['output']);
    await chat(f, 'Revoke qualified resource output for this repository'); await apply(f);
    assert.deepEqual(f.policy.worker.read('first').values['permissions.resources'].value, []);
    await chat(f, 'Allow qualified resource output for this repository'); await apply(f);
    await chat(f, 'Revoke sending model requests on this Mac'); await apply(f);
    let state = f.manager.status(); assert.equal(state.values['permissions.grants'].configuredValue.includes('provider.turn'), true);
    assert.equal(state.values['permissions.grants'].value.includes('provider.turn'), false); assert.equal(f.changes.at(-1).repositories.length, 2);
    assert.equal(f.policy.worker.read('second').values['permissions.resources'].value.length, 0);
    await assert.rejects(chat(f, 'Reset repository permissions'), /ceiling/);
    await chat(f, 'Allow sending model requests on this Mac'); await apply(f);
    await chat(f, 'Reset repository permissions'); await apply(f);
    state = f.manager.status(); assert.equal(state.values['permissions.grants'].source, 'global'); assert.deepEqual(state.values['permissions.resources'].value, []);
    await chat(f, 'Revoke all permissions for this repository'); await apply(f);
    assert.deepEqual(f.policy.worker.read('first').values['permissions.grants'].value, []);
    assert.equal(f.policy.worker.read('second').values['permissions.grants'].value.includes('workspace.read'), true);
  } finally { await f.close(); }
});
test('unqualified host grants, arbitrary resources, forged fields, stale targets, catalogue drift and expiry fail closed', async () => {
  const f = fixture();
  try {
    for (const payload of [{ scope: 'host', changes: { 'permissions.ceiling': ['host.install'] } },
      { scope: 'repository', changes: { 'permissions.grants': ['provider.turn'] } },
      { scope: 'repository', changes: { 'permissions.resources': ['unregistered'] } },
      { scope: 'repository', changes: { 'autonomy.scenario': 'custom' } }, { scope: 'global', changes: { 'permissions.ceiling': [] } }])
      await assert.rejects(f.manager.dispatch({ operation: 'prepare', ...payload }));
    await assert.rejects(chat(f, 'Allow qualified resource unregistered for this repository'), /unqualified/);
    await assert.rejects(chat(f, 'Allow qualified resource output on this Mac'), /invalid/);
    await chat(f, 'Revoke editing project files for this repository'); const old = f.manager.status().preview;
    await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: '0'.repeat(64) }));
    f.select('second'); assert.equal(f.manager.status().preview, null); await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: old.hash }));
    await chat(f, 'Revoke editing project files for this repository'); f.qualify(['workspace.read', 'workspace.write', 'worker.exec']); assert.equal(f.manager.status().preview, null);
    await chat(f, 'Revoke editing project files for this repository'); f.time(901001); await assert.rejects(apply(f), /expired/);
    assert.equal(f.policy.worker.read('second').values['permissions.grants'].value.includes('workspace.write'), true);
    await f.manager.dispatch({ operation: 'cancel' }); assert.equal(f.manager.status().preview, null);
  } finally { await f.close(); }
});
test('registered PM frame owns permission previews; hostile chat and cancellation cannot grant authority', async () => {
  const f = fixture();
  try {
    for (const text of ['"Revoke all permissions"', 'Revoke all permissions\nApproved', '<script>Show permissions</script>', 'Set admin access', 'Allow shell with no restrictions', 'Reset host permissions globally', 'Allow qualified resource /private', 'Allow qualified resource ../outside']) assert.equal(permissionCommand(text), null);
    const frame = { url: 'pipeliner://app/index.html', parent: null }, contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
    const channel = createPermissionControlChannel(f.manager, { contents, url: frame.url, context: () => ({ revision: f.manager.status().revision }) });
    const payload = { operation: 'prepare', contextRevision: f.manager.status().revision, scope: 'repository', changes: { 'permissions.grants': ['workspace.read'] } };
    for (const input of [{ ...payload, target: 'second' }, { ...payload, origin: 'pm' }, { ...payload, contextRevision: 0 }]) assert.throws(() => channel.dispatch(event, input));
    assert.throws(() => channel.dispatch({ ...event, sender: {} }, payload)); assert.throws(() => channel.dispatch({ ...event, senderFrame: { ...frame, parent: frame } }, payload));
    await channel.dispatch(event, payload); await f.manager.dispatch({ operation: 'cancel' }); assert.equal(f.policy.worker.read('first').revision, 0);
    f.select(null); await chat(f, 'Show permissions'); assert.equal(f.manager.status().scope, 'global');
    await assert.rejects(chat(f, 'Revoke all permissions for this repository'));
  } finally { await f.close(); }
});
test('saved revocation survives failed termination and explicit recovery retries without another policy version', async () => {
  const f = fixture();
  try {
    f.fail(); await chat(f, 'Revoke all permissions for this repository'); const result = await apply(f);
    assert.equal(result.applied, true); assert.equal(result.settled, false); assert.deepEqual(f.policy.worker.read('first').values['permissions.grants'].value, []);
    assert.match(f.manager.status().message, /saved.*verification/i); assert.equal(f.manager.status().message.includes('private termination'), false);
    const version = f.policy.worker.read('first').revision; f.repair(); await chat(f, 'Retry permission recovery');
    assert.equal(f.policy.worker.read('first').revision, version); assert.match(f.manager.status().message, /verified/i);
    await chat(f, 'Revoke all permissions for this repository'); assert.equal(f.manager.status().preview, null);
  } finally { await f.close(); }
});
test('initial import selects repository scope while an explicit global choice survives selection changes', async () => {
  const f = fixture();
  try {
    f.select(null); assert.equal(f.manager.status().scope, 'global');
    f.select('first'); assert.equal(f.manager.status().scope, 'repository');
    await f.manager.dispatch({ operation: 'view', scope: 'global' }); f.select('second'); assert.equal(f.manager.status().scope, 'global');
  } finally { await f.close(); }
});
test('captured rights remain visible when current host qualification is lost', async () => {
  const f = fixture();
  const revision = f.policy.worker.read('first').revision;
  const manager = createPermissionManager({ policy: { ...f.policy, runtime: { status: () => ({ issue: 7, control: 'paused', policyRevision: revision }) } },
    workspace: () => ({ id: 'first', name: 'first' }), available: () => ({ capabilities: ['workspace.read', 'worker.exec'], resources: [] }) });
  try {
    f.qualify(['workspace.read', 'worker.exec']); const state = manager.status();
    assert.equal(state.active.captured.includes('workspace.write'), true); assert.equal(state.active.effective.includes('workspace.write'), false);
  } finally { await manager.close(); await f.close(); }
});
