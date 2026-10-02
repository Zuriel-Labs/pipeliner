import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyStore } from '../core/policy.mjs';
import { defaults, capabilityNames } from '../core/settings.mjs';
import { openDevelopmentStore } from './state.mjs';
import { createDevelopmentManager } from './manager.mjs';
import { createDevelopmentControlChannel } from '../core/control.mjs';

test('Dev and permission previews stay PM-controlled, scoped and stale-frame safe', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-manager-')));
  const workspace = { id: 'repo-one', name: 'Fixture repository' }, dev = { id: 'ollama_test', connection: 'ollama', model: 'test-model', metrics: [] };
  const connections = { developers: () => [dev], status: () => ({ connections: [] }) };
  const store = { selected: () => workspace.id, workspaces: () => [workspace], pending: () => [], effects: () => [] };
  const policy = openPolicyStore(root, { catalog: () => ({ repositories: [workspace.id], capabilities: capabilityNames, maxConcurrency: 1, background: false,
    connections: [{ id: 'ollama', provider: 'ollama', repositories: [workspace.id], healthy: true }, { id: 'github', provider: 'github', repositories: [workspace.id], healthy: true }], developers: [dev], extensions: [] }) });
  const ledger = openDevelopmentStore(root), manager = createDevelopmentManager({ store, policy, ledger, connections, supervisor: null });
  const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { isDestroyed: () => false, mainFrame: frame }, event = { sender: contents, senderFrame: frame };
  const channel = createDevelopmentControlChannel(manager, { contents, url: frame.url, context: () => ({ revision: manager.status().revision }) });
  try {
    const revision = manager.status().revision;
    channel.dispatch(event, { operation: 'dev-prepare', dev: dev.id, contextRevision: revision });
    assert.equal(policy.worker.read(workspace.id).values['agents.dev'].value, null);
    let preview = manager.status().preview;
    assert.equal(preview.scope, 'repository'); assert.equal(preview.after['agents.dev'].value, dev.id);
    assert.throws(() => channel.dispatch({ ...event, sender: {} }, { operation: 'apply', hash: preview.hash, contextRevision: manager.status().revision }));
    assert.throws(() => channel.dispatch(event, { operation: 'apply', hash: preview.hash, contextRevision: revision }), /changed/);
    channel.dispatch(event, { operation: 'apply', hash: preview.hash, contextRevision: manager.status().revision });
    assert.equal(policy.worker.read(workspace.id).values['agents.dev'].value, dev.id);
    assert.deepEqual(policy.worker.read(workspace.id).values['permissions.ceiling'].value, defaults['permissions.ceiling']);
    channel.dispatch(event, { operation: 'permissions-prepare', scope: 'host', contextRevision: manager.status().revision }); preview = manager.status().preview;
    assert.equal(preview.scope, 'host'); assert.ok(preview.after['permissions.ceiling'].value.includes('provider.turn'));
    channel.dispatch(event, { operation: 'cancel', contextRevision: manager.status().revision });
    assert.deepEqual(policy.worker.read(workspace.id).values['permissions.ceiling'].value, defaults['permissions.ceiling']);
    assert.throws(() => channel.dispatch(event, { operation: 'start', number: 1, Ready: true, contextRevision: manager.status().revision }));
    assert.equal(manager.status().run, null); assert.equal(manager.status().skills.every(skill => skill.license === 'MIT'), true);
  } finally { await manager.close(); ledger.close(); policy.close(); rmSync(root, { recursive: true }); }
});
