import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVault } from './vault.mjs';
import { createConnectionManager } from './manager.mjs';
import { connectionCommand, containsSecret } from './commands.mjs';
import { createConnectionControlChannel } from '../core/control.mjs';

const wrap = { available: async () => true, encrypt: async x => Buffer.from(x), decrypt: async x => ({ result: x.toString() }) };
const connected = { credential: { accessToken: 'ghu_syntheticFixtureOnly123' }, view: { account: 'fixture', models: [{ id: 'synthetic-model', name: 'Synthetic model' }], health: 'connected', lastVerified: 1, capability: null } };
test('disconnect fences late sign-in and refresh; revocation blocks further tests', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-connections-test-'))); chmodSync(root, 0o700);
  const vault = await openVault(root, wrap); let finish, requests = 0;
  const waiting = () => new Promise(resolve => { finish = resolve; });
  const adapter = { connect: waiting, refresh: waiting, test: async () => { requests++; return {}; }, disconnect: async () => {} };
  const manager = createConnectionManager({ vault, adapters: { github: adapter } });
  try {
    manager.start('github', 'connect'); await Promise.resolve();
    manager.disconnect('github'); finish(connected); await manager.idle('github');
    assert.equal(vault.get('github').value, null);
    assert.equal(manager.status().connections.find(c => c.id === 'github').health, 'disconnected');
    const epoch = vault.begin('github'); vault.save('github', epoch, connected);
    manager.start('github', 'refresh'); await Promise.resolve();
    manager.disconnect('github'); finish(connected); await manager.idle('github');
    assert.equal(vault.get('github').value, null); assert.equal(requests, 0);
    adapter.connect = async () => connected; adapter.refresh = async () => { throw new Error('http-401'); };
    manager.start('github', 'connect'); await manager.idle('github');
    manager.start('github', 'refresh'); await manager.idle('github');
    assert.equal(manager.status().connections[0].health, 'reauthentication');
    assert.throws(() => manager.start('github', 'test'), /connection-unavailable/); assert.equal(requests, 0);
    assert.equal(JSON.stringify(manager.status()).includes(connected.credential.accessToken), false);
  } finally { await manager.close(); vault.close(); rmSync(root, { recursive: true, force: true }); }
});

test('only registered PM frame/current context can start connection work', () => {
  const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { isDestroyed: () => false, mainFrame: frame };
  const calls = [], manager = { status: () => ({ revision: 4 }), start: (...args) => calls.push(args) };
  const channel = createConnectionControlChannel(manager, { contents, url: frame.url, context: () => ({ revision: 4 }) });
  const event = { sender: contents, senderFrame: frame }, action = { operation: 'connect', connection: 'codex', contextRevision: 4 };
  channel.dispatch(event, action); assert.equal(calls.length, 1);
  for (const [sender, payload] of [[{ ...event, sender: {} }, action], [{ ...event, senderFrame: { ...frame } }, action],
    [event, { ...action, contextRevision: 3 }], [event, { ...action, token: 'forged' }], [event, { ...action, operation: 'request' }]]) {
    assert.throws(() => channel.dispatch(sender, payload));
  }
  const rejected = channel.dispatch(event, { operation: 'chat', text: 'Bearer syntheticKeyValue', contextRevision: 4 });
  assert.equal(calls.length, 1); assert.match(rejected.message, /protected/);
  assert.equal(containsSecret('ghu_syntheticFixtureOnly123'), true);
  assert.equal(connectionCommand('Please connect GitHub.').connection, 'github');
  assert.equal(connectionCommand('"connect github"').connection, undefined);
  assert.equal(connectionCommand('connect github and codex').connection, undefined);
  assert.equal(connectionCommand('Test Codex with TestModel').model, 'TestModel');
});

test('managed login cancellation retains a cleanup fence until verified logout', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-codex-cancel-'))); chmodSync(root, 0o700);
  const vault = await openVault(root, wrap); let finish, blocked = true, logouts = 0;
  const adapter = { connect: () => new Promise(resolve => { finish = resolve; }), disconnect: async () => { logouts++; if (blocked) throw new Error('provider-storage-blocked'); } };
  const manager = createConnectionManager({ vault, adapters: { codex: adapter } });
  try {
    manager.start('codex', 'connect'); await Promise.resolve(); manager.cancel('codex'); finish({ credential: null, view: { account: 'owned-synthetic-account', health: 'connected' } });
    await manager.idle('codex'); assert.equal(logouts, 1);
    assert.equal(manager.status().connections.find(c => c.id === 'codex').health, 'cleanup-required');
    assert.throws(() => manager.start('codex', 'connect'), /connection-unavailable/);
    blocked = false; manager.disconnect('codex'); await manager.idle('codex');
    assert.equal(vault.get('codex').value, null); assert.equal(logouts, 2);
  } finally { await manager.close(); vault.close(); rmSync(root, { recursive: true, force: true }); }
});

test('host lease is fresh, stays private and is fenced on disconnect or caller cancellation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-lease-test-'))); chmodSync(root, 0o700);
  const vault = await openVault(root, wrap);
  const adapter = { connect: async () => connected, refresh: async ({ value }) => value, disconnect: async () => {} };
  const manager = createConnectionManager({ vault, adapters: { github: adapter } });
  try {
    manager.start('github', 'connect'); await manager.idle('github');
    const lease = await manager.acquire('github'); lease.check(); assert.equal(lease.value.credential.accessToken, connected.credential.accessToken);
    assert.equal(JSON.stringify(manager.status()).includes(connected.credential.accessToken), false);
    manager.disconnect('github'); assert.throws(() => lease.check()); await manager.idle('github'); lease.close();
    manager.start('github', 'connect'); await manager.idle('github');
    adapter.refresh = async ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); if (signal.aborted) reject(new Error('cancelled')); });
    const cancellation = new AbortController(), waiting = manager.acquire('github', cancellation.signal); cancellation.abort();
    await assert.rejects(waiting); assert.equal(manager.status().connections[0].busy, false);
  } finally { await manager.close(); vault.close(); rmSync(root, { recursive: true, force: true }); }
});

test('provider lease binds a tested model, hides credentials and discards late or concurrent turns', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-provider-lease-'))); chmodSync(root, 0o700);
  const vault = await openVault(root, wrap); let finish, calls = 0, observedSignal;
  const value = { credential: 'synthetic-private-provider-key', view: { health: 'connected', selectedModel: 'test-model', models: [{ id: 'test-model' }],
    capability: { model: 'test-model', testedAt: 1, stream: true, toolLoop: true, resumed: true } } };
  const adapter = { connect: async () => value, refresh: async ({ value }) => value, disconnect: async () => {},
    turn: ({ value: privateValue, model, signal }) => { assert.equal(privateValue.credential, value.credential); assert.equal(model, 'test-model');
      calls++; observedSignal = signal; return new Promise(resolve => { finish = resolve; }); } };
  const manager = createConnectionManager({ vault, adapters: { ollama: adapter } });
  try {
    manager.start('ollama', 'connect'); await manager.idle('ollama');
    await assert.rejects(manager.acquireProvider('ollama', 'other-model'), /capability-unverified/);
    await assert.rejects(manager.acquireProvider('codex', 'test-model'));
    assert.equal(calls, 0);
    const lease = await manager.acquireProvider('ollama', 'test-model'); assert.equal(lease.value, undefined);
    assert.equal(JSON.stringify(manager.status()).includes(value.credential), false);
    const input = { messages: [{ role: 'user', content: 'Synthetic fixture only.' }], tools: [], maxOutput: 2048 };
    const pending = lease.turn(input); await Promise.resolve();
    await assert.rejects(lease.turn(input), /provider-turn-pending/); assert.equal(calls, 1);
    manager.disconnect('ollama'); assert.equal(observedSignal.aborted, true);
    finish({ content: 'late result' }); await assert.rejects(pending); await manager.idle('ollama'); lease.close();
    manager.start('ollama', 'connect'); await manager.idle('ollama');
    adapter.turn = async () => { throw new Error('http-401'); };
    const next = await manager.acquireProvider('ollama', 'test-model'); await assert.rejects(next.turn(input), /http-401/);
    assert.equal(manager.status().connections.find(c => c.id === 'ollama').health, 'reauthentication');
    assert.throws(() => next.check()); await assert.rejects(manager.acquireProvider('ollama', 'test-model')); next.close();
  } finally { await manager.close(); vault.close(); rmSync(root, { recursive: true, force: true }); }
});
