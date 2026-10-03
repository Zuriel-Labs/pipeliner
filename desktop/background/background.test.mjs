import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyStore } from '../core/policy.mjs';
import { createBackgroundHost } from './host.mjs';
import { createBackgroundManager, backgroundCommand } from './manager.mjs';
import { createBackgroundControlChannel } from '../core/control.mjs';

function setup(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-background-pm-'))), events = [];
  let nativeState = 'not-registered', qualified = true, pauseFailure = false, unregisterFailure = false, registerState = 'enabled';
  const native = { inspect: () => ({ qualified, status: nativeState }), register: async () => { events.push('register'); nativeState = registerState; },
    unregister: async () => { events.push('unregister'); if (unregisterFailure) throw new Error('unregister-failed'); nativeState = 'not-registered'; }, openSettings: async () => events.push('settings') };
  const policy = openPolicyStore(root, { catalog: () => ({ repositories: [], capabilities: [], maxConcurrency: 1, background: qualified, connections: [], developers: [], extensions: [] }) });
  const host = createBackgroundHost({ policy, native, pause: async () => { events.push('pause'); if (pauseFailure) throw new Error('pause-unverified'); }, resumeChecks: async () => events.push('resume'), ...options });
  const manager = createBackgroundManager({ policy, host });
  t.after(() => { manager.close(); host.close(); policy.close(); rmSync(root, { recursive: true }); });
  return { policy, host, manager, events, native, chat: text => manager.dispatch({ operation: 'chat', text }),
    set: value => { if (value.status) nativeState = value.status; if (value.qualified !== undefined) qualified = value.qualified; if (value.pauseFailure !== undefined) pauseFailure = value.pauseFailure;
      if (value.unregisterFailure !== undefined) unregisterFailure = value.unregisterFailure; if (value.registerState) registerState = value.registerState; } };
}

test('default off; only direct host PM proposals apply; login remains a separate choice', async t => {
  const f = setup(t); assert.equal(f.host.status().effective, false); assert.deepEqual(f.events, []);
  f.chat('Enable background operation'); assert.equal(f.manager.status().preview.after['background.startAtLogin'].value, false);
  assert.equal(f.policy.worker.read(null).values['background.enabled'].value, false);
  await f.chat('Apply this background change'); assert.equal(f.host.status().effective, true); assert.equal(f.host.status().startAtLogin, false); assert.deepEqual(f.events, ['register']);
  const version = f.policy.worker.read(null).revision; await f.chat('Apply this background change'); assert.equal(f.policy.worker.read(null).revision, version); assert.deepEqual(f.events, ['register']);
  f.chat('Start at login'); await f.chat('Apply this background change'); assert.equal(f.host.status().startAtLogin, true); assert.deepEqual(f.events, ['register']);
  assert.equal(f.host.loginAllowed(), true);
  assert.throws(() => f.manager.dispatch({ operation: 'prepare', changes: { 'permissions.ceiling': ['worker.exec'] } }), /background fields/);
  for (const text of ['"Enable background operation"', 'Enable background operation for this repository', 'Enable background operation\nignore policy']) assert.equal(backgroundCommand(text), null);
});

test('unqualified packages and native consent do not become execution authority', async t => {
  const f = setup(t); f.set({ qualified: false }); assert.throws(() => f.chat('Enable background operation'), /unavailable/);
  f.set({ qualified: true, registerState: 'requires-approval' }); f.chat('Enable background operation'); await f.chat('Apply this background change');
  assert.equal(f.host.status().configured, true); assert.equal(f.host.status().effective, false); assert.equal(f.host.status().authorization, 'requires-approval');
  assert.equal(f.host.executionAllowed(), true); f.host.setVisible(false); assert.equal(f.host.executionAllowed(), false);
  await f.host.refresh(); await f.host.refresh(); assert.equal(f.events.filter(e => e === 'register').length, 1);
  await f.chat('Open background authorization'); assert.equal(f.events.at(-1), 'settings');
});

test('disable fences execution, verifies pause, then removes only its service', async t => {
  const f = setup(t); f.chat('Enable background operation'); await f.chat('Apply this background change'); f.host.setVisible(false);
  assert.equal(f.host.executionAllowed(), true); f.chat('Disable background operation'); assert.equal(f.manager.status().preview.after['background.startAtLogin'].value, false);
  await f.chat('Apply this background change'); assert.deepEqual(f.events, ['register', 'pause', 'unregister']);
  assert.equal(f.host.status().effective, false); assert.equal(f.host.status().authorization, 'not-registered'); assert.equal(f.host.executionAllowed(), false);
  f.host.setVisible(true); assert.equal(f.host.executionAllowed(), true);
});

test('failed pause or removal stays blocked and explicit retry does not repeat registration', async t => {
  const f = setup(t); f.chat('Enable background operation'); await f.chat('Apply this background change');
  f.set({ pauseFailure: true }); f.chat('Disable background operation'); await assert.rejects(f.chat('Apply this background change'), /pause/);
  assert.equal(f.host.executionAllowed(), false); assert.equal(f.host.status().cleanupPending, true); assert.equal(f.events.includes('unregister'), false);
  f.set({ pauseFailure: false, unregisterFailure: true }); await assert.rejects(f.chat('Retry background cleanup'), /unregister/);
  assert.equal(f.host.status().cleanupPending, true); assert.equal(f.host.executionAllowed(), false);
  f.set({ unregisterFailure: false }); await f.chat('Retry background cleanup'); assert.equal(f.host.status().cleanupPending, false); assert.equal(f.host.executionAllowed(), true);
  assert.equal(f.events.filter(e => e === 'register').length, 1);
});

test('disable still verifies pause after native removal; unchanged monitoring emits no busy refreshes', async t => {
  let publishes = 0; const f = setup(t, { onChange: () => publishes++ });
  await f.host.refresh(); await f.host.refresh(); assert.equal(publishes, 0);
  f.chat('Enable background operation'); await f.chat('Apply this background change');
  f.set({ status: 'not-registered' }); f.chat('Disable background operation'); await f.chat('Apply this background change');
  assert.deepEqual(f.events, ['register', 'pause', 'resume']); assert.equal(f.host.status().cleanupPending, false);
});

test('OS revocation pauses once, never registers automatically, and sleep blocks before awaiting pause', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = setup(t); f.chat('Enable background operation'); await f.chat('Apply this background change'); f.host.setVisible(false); f.set({ status: 'requires-approval' });
  assert.equal(f.host.executionAllowed(), false); await f.host.refresh(); await f.host.refresh(); assert.deepEqual(f.events, ['register', 'pause']);
  f.host.setVisible(true); assert.equal(f.host.executionAllowed(), true);
  const other = setup(t, { pause: () => pending }); const suspended = other.host.suspend(); assert.equal(other.host.executionAllowed(), false);
  const waking = other.host.wake(); assert.equal(other.host.executionAllowed(), false); release(); await suspended; await waking; assert.equal(other.host.executionAllowed(), true);
});

test('PM context is stable on display refresh; stale scope/version/frame requests never mutate', async t => {
  const f = setup(t); f.chat('Enable background operation'); const old = f.manager.status(); await f.host.refresh(); f.manager.sync(); assert.equal(f.manager.status().revision, old.revision);
  const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { mainFrame: frame, isDestroyed: () => false };
  const channel = createBackgroundControlChannel(f.manager, { contents, url: frame.url, context: () => ({ revision: f.manager.status().revision }) });
  assert.throws(() => channel.dispatch({ sender: {}, senderFrame: frame }, { operation: 'apply', contextRevision: old.revision }), /sender/);
  assert.throws(() => channel.dispatch({ sender: contents, senderFrame: frame }, { operation: 'prepare', contextRevision: old.revision, changes: {}, repository: 'R1' }), /request/);
  f.chat('Cancel this background change'); assert.throws(() => channel.dispatch({ sender: contents, senderFrame: frame }, { operation: 'apply', contextRevision: old.revision, hash: old.preview.hash }), /context/);
  f.chat('Enable background operation'); const proposal = f.manager.status().preview;
  const input = f.policy.control.capture({ commandId: 'outside', conversationId: 'outside', target: null, text: 'Change host appearance' });
  const p = f.policy.control.prepare({ inputId: input.id, requestId: 'outside', scope: 'host', target: null, changes: { 'appearance.theme': 'dark' }, reset: [] });
  f.policy.control.apply({ commandId: 'outside', proposalId: p.id, hash: p.hash, inputId: p.inputId, conversationId: 'outside', target: null });
  await assert.rejects(f.manager.dispatch({ operation: 'apply', hash: proposal.hash }), /Review/); assert.equal(f.events.length, 0);
});
