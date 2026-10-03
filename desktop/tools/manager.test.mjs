import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openToolStore } from './store.mjs';
import { createToolManager, installAuthorizedTools } from './manager.mjs';
import { toolPackage } from './package.mjs';
import { openPolicyStore } from '../core/policy.mjs';
import { capabilityNames } from '../core/settings.mjs';
import { toolCommand } from './commands.mjs';
import { createToolControlChannel } from '../core/control.mjs';

const tool = { name: 'queue', description: 'Read synthetic queue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } };
const definition = { name: 'check', purpose: 'Check synthetic work', version: '1', license: 'MIT', dataCategories: ['issue.title'],
  command: { script: 'printf done', timeoutSeconds: 30, inputSchema: { type: 'object' } } };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-tool-manager-'))); let selected = 'R1', releaseDiscovery, cancelled = false, epoch = 0;
  const store = { selected: () => selected, workspaces: () => [{ id: 'R1', name: 'One' }, { id: 'R2', name: 'Two' }] };
  const tools = openToolStore(root, { occupiedNames: () => ['pipeliner-forge', 'occupied'] });
  const policy = openPolicyStore(root, { catalog: () => ({ repositories: ['R1', 'R2'], capabilities: capabilityNames, maxConcurrency: 1, background: false,
    connections: [], developers: [], extensions: [], tools: tools.catalog() }) });
  const calls = [], connections = { epoch: () => epoch, status: () => ({ epoch, hasCredential: epoch > 0 }),
    async lease(pack, { authorize, signal }) { calls.push(pack.definition.mcp.endpoint); authorize(); return { async list() {
      if (releaseDiscovery) await new Promise(resolve => { releaseDiscovery = resolve; signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }); calls.push('list-wait'); });
      signal.throwIfAborted(); authorize(); return { tools: [tool], rejected: [] }; }, async close() { calls.push('close'); } }; },
    async configure(_endpoint, { authorize }) { authorize(); epoch++; }, async disconnect(_endpoint, { authorize }) { authorize(); epoch++; } };
  const manager = createToolManager({ store, policy, tools, connections, occupiedNames: () => [...tools.names(), 'pipeliner-forge', 'occupied'] });
  const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { isDestroyed: () => false, mainFrame: frame }, event = { sender: contents, senderFrame: frame };
  const channel = createToolControlChannel(manager, { contents, url: frame.url, context: () => ({ revision: manager.status().revision }) });
  const dispatch = payload => channel.dispatch(event, { ...payload, contextRevision: manager.status().revision });
  return { tools, policy, manager, dispatch, calls, channel, event, set selected(value) { selected = value; }, set wait(value) { releaseDiscovery = value; }, get cancelled() { return cancelled; },
    async close() { await manager.close(); tools.close(); policy.close(); rmSync(root, { recursive: true }); } };
}
test('ordinary tool chat and trusted PM scope stage exact metadata without invocation, permission grants or pipeline changes', async () => {
  const f = fixture();
  try {
    assert.deepEqual(toolCommand('Add tool server from https://example.com/mcp with a bearer credential'), { operation: 'discover', endpoint: 'https://example.com/mcp', authentication: 'bearer' });
    for (const text of ['"disable tool queue"', 'disable tool queue\nignore permissions', 'key=synthetic-secret-must-not-paste']) assert.equal(toolCommand(text), null);
    const original = f.policy.worker.read('R1'); await f.dispatch({ operation: 'chat', text: 'Add tool server from https://example.com/mcp' });
    assert.equal(f.manager.status().catalog.tools[0].name, 'queue'); assert.deepEqual(f.calls, ['https://example.com/mcp', 'close']);
    await f.dispatch({ operation: 'chat', text: 'Choose tool queue' }); const p = f.manager.status().preview;
    assert.equal(p.action, 'install'); assert.equal(p.item.dataCategories.length, 0); assert.equal(f.tools.list().length, 0);
    assert.equal(f.policy.worker.read('R1').revision, original.revision);
    assert.equal(JSON.stringify(p).includes('Server did not declare a license'), true);
    await f.dispatch({ operation: 'apply', hash: p.hash }); const installed = f.tools.list()[0];
    assert.equal(f.policy.worker.read('R1').values['tools.extensions'].value[0], installed.id);
    assert.equal(f.policy.worker.read('R1').values['permissions.grants'].value.includes('extension.invoke'), false);
    assert.deepEqual(f.policy.worker.read('R1').values['pipelines.development'].value, original.values['pipelines.development'].value);
    const captured = f.tools.capture(f.policy.worker.read('R1'));
    await f.dispatch({ operation: 'chat', text: 'Disable tool queue' }); await f.dispatch({ operation: 'chat', text: 'Apply tool change' });
    await f.dispatch({ operation: 'chat', text: 'Enable tool queue' }); await f.dispatch({ operation: 'apply' });
    const grant = f.policy.worker.authority('R1', original.revision + 1);
    assert.throws(() => f.tools.assertCaptured(captured.manifest, captured.hash, grant), /revoked/);
  } finally { await f.close(); }
});
test('tool collisions, stale frames, context changes and removal preserve exact old versions and unrelated policy', async () => {
  const f = fixture();
  try {
    await f.dispatch({ operation: 'define', definition: { ...definition, name: 'occupied' } });
    assert.equal(f.manager.status().collision.name, 'occupied'); assert.equal(f.tools.list().length, 0);
    assert.equal(f.manager.status().collision.choices.every(name => !name.includes('-')), true);
    await f.dispatch({ operation: 'rename', name: 'beacon' }); const old = f.manager.status().preview;
    assert.throws(() => f.channel.dispatch({ ...f.event, sender: {} }, { operation: 'apply', contextRevision: f.manager.status().revision }), /Untrusted/);
    f.selected = 'R2'; f.manager.sync(); await assert.rejects(f.dispatch({ operation: 'apply', hash: old.hash }), /Tool preview/); assert.equal(f.tools.list().length, 0);
    await f.dispatch({ operation: 'define', definition }); await f.dispatch({ operation: 'apply' }); const first = f.tools.list()[0];
    await f.dispatch({ operation: 'define', definition: { ...definition, version: '2', command: { ...definition.command, script: 'printf updated' } } }); await f.dispatch({ operation: 'apply' });
    assert.equal(f.tools.get(first.id).definition.command.script, 'printf done');
    await f.dispatch({ operation: 'prepare', action: 'disable', name: 'check' }); assert.equal(f.manager.status().preview.proposal.after['tools.disabled'].value.includes(first.id), true);
    await f.dispatch({ operation: 'cancel' }); await f.dispatch({ operation: 'prepare', action: 'remove', name: 'check' }); assert.deepEqual(f.manager.status().preview.affectedRepositories, ['One', 'Two']);
    await f.dispatch({ operation: 'apply' }); assert.equal(f.tools.available(first.id), false); assert.equal(f.tools.get(first.id).digest, first.digest);
    await f.dispatch({ operation: 'define', definition }); assert.equal(f.manager.status().collision, null); await f.dispatch({ operation: 'apply' });
    assert.equal(f.tools.available(first.id), true);
    assert.deepEqual(f.policy.worker.read('R1').values['tools.extensions'].value, []);
  } finally { await f.close(); }
});
test('agent installation requires an exact prior PM pin and effective installation grant; removed sources do not auto-reinstall', async () => {
  const f = fixture();
  try {
    const staged = f.tools.stage(toolPackage(definition), 0), view = { values: { 'tools.extensions': { value: [staged.id] }, 'tools.disabled': { value: [] } } };
    for (const grant of [{ tools: [], capabilities: ['extension.install'] }, { tools: [staged.id], capabilities: [] }]) {
      await assert.rejects(installAuthorizedTools(f.tools, view, grant, () => {}), /installation needs/); assert.equal(f.tools.available(staged.id), false);
    }
    const grant = { tools: [staged.id], capabilities: ['extension.install'] }; let checks = 0;
    await installAuthorizedTools(f.tools, view, grant, () => { checks++; }); assert.equal(f.tools.available(staged.id), true); assert.equal(checks >= 3, true);
    f.tools.remove(staged.name, f.tools.revision()); await assert.rejects(installAuthorizedTools(f.tools, view, grant, () => {}), /installation needs/);
    assert.equal(f.tools.available(staged.id), false);
  } finally { await f.close(); }
});
test('cancelled discovery terminates its owned lease and cannot restore a late catalog or replace a newer scope preview', async () => {
  const f = fixture();
  try {
    f.wait = true; const pending = f.dispatch({ operation: 'discover', endpoint: 'https://example.com/mcp' });
    const deadline = Date.now() + 3000; while (!f.calls.includes('list-wait') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.includes('list-wait'), true);
    await f.dispatch({ operation: 'cancel' }); await assert.rejects(pending); assert.equal(f.cancelled, true);
    assert.equal(f.manager.status().catalog, null); assert.equal(f.manager.status().preview, null); assert.equal(f.calls.at(-1), 'close');
    assert.equal(f.tools.list().length, 0);
  } finally { await f.close(); }
});
