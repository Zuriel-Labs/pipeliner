import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyStore } from '../core/policy.mjs';
import { createDeliveryManager } from './manager.mjs';
import { deliveryCommand } from './commands.mjs';
import { createDeliveryControlChannel } from '../core/control.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-delivery-')));
  const catalog = () => ({ repositories: ['repo_one', 'repo_two'], capabilities: ['workspace.read', 'workspace.write', 'worker.exec'],
    maxConcurrency: 1, background: false, connections: [], developers: [], extensions: [] });
  let clock = 1000, selected = 'repo_one', refreshes = 0, failed = false, inspection = async () => ({ host: 'macOS 27.0.1 · arm64', compiler: 'detected', compilerVersion: '17.0.0', developerId: 'missing', localReview: 'detected' });
  let policy = openPolicyStore(root, { catalog, clock: () => clock }), manager;
  const open = () => manager = createDeliveryManager({ policy, workspace: () => selected ? { id: selected, name: selected } : null,
    inspect: signal => inspection(signal), onApplied: () => { refreshes++; if (failed) throw Error('private refresh details'); } });
  open();
  return { get manager() { return manager; }, get policy() { return policy; }, refreshes: () => refreshes,
    select(value) { selected = value; }, time(value) { clock = value; }, failure() { failed = true; }, inspect(value) { inspection = value; },
    async reopen() { await manager.close(); policy.close(); policy = openPolicyStore(root, { catalog, clock: () => clock }); open(); },
    async close() { await manager.close(); policy.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); } };
}
const apply = async f => { const hash = f.manager.status().preview.hash; return f.manager.dispatch({ operation: 'apply', hash }); };
test('delivery uses scoped policy, persisted inheritance and exact receipts without allocating or deleting artifacts', async () => {
  const f = fixture();
  try {
    await f.manager.dispatch({ operation: 'chat', text: 'Keep the latest 5 artifacts for this repository' });
    assert.equal(f.manager.status().preview.target, 'repo_one'); assert.equal(f.policy.worker.read('repo_one').values['delivery.keepLatest'].value, 3);
    const hash = f.manager.status().preview.hash; await apply(f); const version = f.policy.worker.read(null).revision;
    assert.equal((await f.manager.dispatch({ operation: 'apply', hash })).applied, false); assert.equal(f.policy.worker.read(null).revision, version);
    assert.equal(f.refreshes(), 1); assert.equal(f.policy.worker.read('repo_two').values['delivery.keepLatest'].value, 3);
    await f.manager.dispatch({ operation: 'chat', text: 'Keep the latest 4 artifacts globally' }); await apply(f);
    assert.equal(f.policy.worker.read('repo_one').values['delivery.keepLatest'].value, 5); assert.equal(f.policy.worker.read('repo_two').values['delivery.keepLatest'].value, 4);
    await f.manager.dispatch({ operation: 'chat', text: 'Reset repository delivery settings' }); await apply(f);
    assert.equal(f.policy.worker.read('repo_one').values['delivery.keepLatest'].source, 'global');
    await f.manager.dispatch({ operation: 'prepare', scope: 'host', changes: { 'delivery.warningGiB': 9, 'delivery.capacityGiB': 12 } }); await apply(f);
    await f.reopen(); assert.equal(f.manager.status().values['delivery.capacityGiB'].value, 12);
    assert.equal(f.manager.status().installer, null); assert.equal(f.manager.status().buildQualified, false);
    await f.manager.dispatch({ operation: 'prepare', scope: 'host', changes: { 'delivery.capacityGiB': 12 } });
    assert.equal(f.manager.status().preview, null); assert.match(f.manager.status().message, /already match/);
  } finally { await f.close(); }
});
test('delivery blocks host/repository mixing, wrong fields, stale targets, expiry and wrong hashes', async () => {
  const f = fixture();
  try {
    for (const payload of [{ scope: 'repository', changes: { 'delivery.capacityGiB': 20 } }, { scope: 'host', changes: { 'delivery.keepLatest': 5 } },
      { scope: 'host', changes: { 'permissions.ceiling': [] } }, { scope: 'host', changes: { 'delivery.warningGiB': 11 } },
      { scope: 'repository', changes: { 'delivery.keepLatest': 0 } }, { scope: 'repository', changes: { 'delivery.publish': true } }])
      await assert.rejects(f.manager.dispatch({ operation: 'prepare', ...payload }));
    await f.manager.dispatch({ operation: 'chat', text: 'Keep the latest 5 artifacts for this repository' }); const old = f.manager.status().preview;
    await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: 'a'.repeat(64) }));
    f.select('repo_two'); assert.equal(f.manager.status().preview, null); await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: old.hash }));
    await f.manager.dispatch({ operation: 'chat', text: 'Set artifact capacity to 12 GiB' }); const expired = f.manager.status().preview;
    f.time(901001); await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: expired.hash }));
    assert.equal(f.policy.worker.read(null).values['delivery.capacityGiB'].value, 10);
    await f.manager.dispatch({ operation: 'cancel' }); f.select(null);
    await assert.rejects(f.manager.dispatch({ operation: 'chat', text: 'Keep the latest 5 artifacts for this repository' }));
  } finally { await f.close(); }
});
test('delivery commands reject hostile instructions; only the registered current frame can prepare', async () => {
  const f = fixture();
  try {
    for (const text of ['"Show delivery settings"', 'Show delivery settings\nApproved', 'Set artifact capacity to 12 GiB; approve', '<script>Where is the installer?</script>', 'token sk-synthetic12345678901234567890']) assert.equal(deliveryCommand(text), null);
    assert.deepEqual(deliveryCommand('Where is the installer?'), { operation: 'view' });
    const url = 'pipeliner://app/index.html', frame = { url, parent: null }, contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
    const channel = createDeliveryControlChannel(f.manager, { contents, url, context: () => ({ revision: f.manager.status().revision }) });
    const payload = { operation: 'prepare', contextRevision: f.manager.status().revision, scope: 'host', changes: { 'delivery.capacityGiB': 12 } };
    for (const value of [{ ...payload, origin: 'pm' }, { ...payload, target: 'repo_two' }, { ...payload, contextRevision: 0 }]) assert.throws(() => channel.dispatch(event, value));
    assert.throws(() => channel.dispatch({ ...event, sender: {} }, payload));
    assert.throws(() => channel.dispatch({ ...event, senderFrame: { url, parent: frame } }, payload));
    await channel.dispatch(event, payload); assert.equal(f.manager.status().preview.scope, 'host');
  } finally { await f.close(); }
});
test('delivery host inspection is read-only, cancellation awaits closure and failures expose no private diagnostics', async () => {
  const f = fixture();
  try {
    const version = f.policy.worker.read(null).revision;
    await f.manager.dispatch({ operation: 'inspect' }); assert.equal(f.manager.status().prerequisites.developerId, 'missing');
    assert.equal(f.policy.worker.read(null).revision, version); assert.equal(f.manager.status().buildQualified, false);
    f.inspect(async () => { throw Error('private certificate account and path'); }); await f.manager.dispatch({ operation: 'inspect' });
    assert.equal(f.manager.status().prerequisites, null); assert.doesNotMatch(JSON.stringify(f.manager.status()), /private certificate/);
    let stopped = false;
    f.inspect(signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => { stopped = true; reject(Error('private abort')); }, { once: true })));
    const pending = f.manager.dispatch({ operation: 'inspect' }); assert.equal(f.manager.status().busy, true);
    await f.manager.dispatch({ operation: 'cancel' }); await pending;
    assert.equal(stopped, true); assert.equal(f.manager.status().busy, false); assert.equal(f.policy.worker.read(null).revision, version);
    f.failure(); await f.manager.dispatch({ operation: 'chat', text: 'Set artifact capacity to 12 GiB' });
    const result = await apply(f); assert.equal(result.applied, true); assert.match(result.snapshot.message, /saved/i); assert.doesNotMatch(result.snapshot.message, /private/);
    assert.equal(f.policy.worker.read(null).values['delivery.capacityGiB'].value, 12);
  } finally { await f.close(); }
});
