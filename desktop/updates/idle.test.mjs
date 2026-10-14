import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createMaintenanceGate } from './idle.mjs';
import { createUpdateControlChannel } from '../core/control.mjs';
import { openVault } from '../connections/vault.mjs';
import { openUninstallJournal } from './uninstall.mjs';
import { canonicalJSON } from '../core/settings.mjs';

test('host maintenance fences competing controls, stale continuations, late work and cancellation without stopping work', async () => {
  let idle = true, inspecting = false, finishInspection, consumed = 0, detached, inspectionCalls = 0;
  const gate = createMaintenanceGate({ ready: () => idle, verify: async () => {
    inspectionCalls++; assert.equal(gate.active(), true); inspecting = true;
    await new Promise(resolve => { finishInspection = resolve; }); inspecting = false; return true;
  } });
  const frame = { parent: null, url: 'pipeliner://app/index.html' }, contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
  const channel = createUpdateControlChannel({ status: () => ({ revision: 1 }), dispatch: () => gate.exclusive(async checkpoint => {
    checkpoint(); consumed++; return { snapshot: { revision: 1 } };
  }) }, { contents, url: frame.url, context: () => ({ revision: 1 }) });
  const request = (event, payload) => gate.control(() => channel.dispatch(event, payload), { passive: payload?.operation === 'status' });
  const payload = { operation: 'install', contextRevision: 1 };
  idle = false;
  await assert.rejects(request(event, payload), /maintenance-deferred/); assert.equal(inspectionCalls, 0); assert.equal(gate.active(), false);
  idle = true;
  let finishControl;
  const competing = gate.control(() => new Promise(resolve => { finishControl = resolve; }));
  await assert.rejects(request(event, payload), /maintenance-deferred/); assert.equal(inspectionCalls, 0);
  finishControl(); await competing;
  const install = request(event, payload); assert.equal(inspecting, true);
  await assert.rejects(gate.control(() => { throw Error('Must not dispatch'); }), /maintenance-active/);
  assert.deepEqual(await request(event, { operation: 'status' }), { revision: 1 });
  await assert.rejects(request({ ...event, sender: {} }, { operation: 'status' }), /Untrusted/);
  await assert.rejects(request(event, { operation: 'status', approved: true }));
  await assert.rejects(request(event, { operation: 'install', contextRevision: 1, approved: true }), /maintenance-active/);
  idle = false; finishInspection(); await assert.rejects(install, /maintenance-deferred/);
  assert.equal(consumed, 0); assert.equal(gate.active(), false); assert.equal(inspecting, false);
  idle = true;
  const cancelled = new AbortController();
  const operation = gate.control(() => gate.exclusive(() => { consumed++; }, { signal: cancelled.signal }));
  await gate.control(() => cancelled.abort(), { passive: true });
  assert.equal(gate.active(), true); finishInspection(); await assert.rejects(operation, /abort/i); assert.equal(consumed, 0); assert.equal(gate.active(), false);
  let checkpoint;
  const success = gate.control(() => gate.exclusive(check => { checkpoint = check; check(); consumed++; return 'prepared'; }));
  finishInspection(); assert.equal(await success, 'prepared'); assert.equal(consumed, 1); assert.equal(gate.active(), false);
  assert.throws(checkpoint, /maintenance-inactive/);
  let releaseDetached;
  const detachedReady = new Promise(resolve => { releaseDetached = resolve; });
  await gate.control(() => { detached = detachedReady.then(() => gate.exclusive(() => { consumed++; })); });
  const other = gate.control(() => new Promise(resolve => { finishControl = resolve; }));
  releaseDetached(); await assert.rejects(detached, /maintenance-deferred/); finishControl(); await other;
  assert.equal(consumed, 1); assert.equal(gate.active(), false);
  await assert.rejects(gate.exclusive(() => {}, { signal: cancelled.signal }), /abort/i);
  const refusal = createMaintenanceGate({ ready: () => true, verify: async () => false });
  await assert.rejects(refusal.exclusive(() => { consumed++; }), /maintenance-unverified/); assert.equal(refusal.active(), false);
  const failed = createMaintenanceGate({ ready: () => { throw Error('private storage detail'); }, verify: async () => true });
  await assert.rejects(failed.exclusive(() => {}), /maintenance-deferred/); assert.equal(failed.active(), false);
});

test('cold recovery shares the maintenance lease and preserves ordinary fences and protected journal ownership', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-cold-recovery-')));
  let vault, journal, token, releaseVerification, releaseWork;
  const operations = [], controllers = [];
  try {
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text),
      decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
    vault.save('ollama', vault.begin('ollama'), { credential: 'Synthetic only' });
    const binding = { purpose: 'workspace', repository: null, id: 'retained' }, plain = Buffer.from('Retained readable records'), protectedRecord = vault.sealPayload(binding, plain);
    // Real encrypted journal/vault; native idle verification and plan metadata are synthetic.
    const plan = { bundle: join(root, 'Pipeliner.app'), identity: { kind: 'pipeliner-desktop-build', schemaVersion: 1,
      sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' },
      team: 'ABCDEFGHIJ', custody: { device: '1', inode: '2' }, credentials: vault.previewCredentialRemoval(),
      service: { qualified: true, status: 'not-registered' }, recordInventorySha256: 'd'.repeat(64) };
    journal = openUninstallJournal(root, { vault }); const oldToken = journal.begin(plan);
    journal.close(); journal = openUninstallJournal(root, { vault }); assert.equal(journal.owned(oldToken), false);
    let expected = journal.read(), eligible = true, idle = true, verified = true, holdVerification = false, verifications = 0, effects = 0;
    const ownsRecovery = () => eligible && (token ? journal.recoveryOwned(token) : canonicalJSON(journal.read()) === canonicalJSON(expected));
    const gate = createMaintenanceGate({ ready: () => assert.fail('Normal stores must stay closed'), verify: () => assert.fail('Normal worker inspection must not stand in for cold recovery'),
      recovery: () => !journal.clear(), recoveryReady: () => idle, verifyRecovery: async () => {
        verifications++; assert.equal(gate.active(), true);
        if (holdVerification) await new Promise(resolve => { releaseVerification = resolve; });
        return verified;
      } });
    assert.equal(typeof gate.recover, 'function');
    await assert.rejects(gate.control(() => assert.fail('Ordinary work')), /maintenance-recovery-required/);
    await assert.rejects(gate.exclusive(() => assert.fail('Ordinary maintenance'), { ownsRecovery }), /maintenance-recovery-required/);
    await assert.rejects(gate.recover(() => effects++), /maintenance-recovery-required/);
    const unqualified = createMaintenanceGate({ ready: () => true, verify: async () => true, recovery: () => true });
    await assert.rejects(unqualified.recover(() => effects++, { ownsRecovery }), /maintenance-deferred/);
    eligible = false; await assert.rejects(gate.recover(() => effects++, { ownsRecovery }), /maintenance-recovery-required/); eligible = true;
    idle = false; await assert.rejects(gate.recover(() => effects++, { ownsRecovery }), /maintenance-deferred/); idle = true;
    assert.equal(verifications, 0);
    verified = false; await assert.rejects(gate.recover(() => effects++, { ownsRecovery }), /maintenance-unverified/); verified = true;
    const start = () => {
      const controller = new AbortController(); controllers.push(controller);
      const operation = gate.recover(() => { effects++; }, { ownsRecovery, signal: controller.signal });
      operation.catch(() => {}); operations.push(operation); return { controller, operation };
    };
    holdVerification = true;
    const cancelled = start();
    await assert.rejects(gate.recover(() => effects++, { ownsRecovery }), /maintenance-deferred/);
    assert.equal(await gate.control(() => 'status', { passive: true }), 'status');
    cancelled.controller.abort(); releaseVerification(); await assert.rejects(cancelled.operation, { name: 'AbortError' });
    const changed = start(); journal.claimRecovery(expected); releaseVerification();
    await assert.rejects(changed.operation, /maintenance-recovery-required/); expected = journal.read();
    const busy = start(); idle = false; releaseVerification(); await assert.rejects(busy.operation, /maintenance-deferred/); idle = true;
    holdVerification = false; assert.equal(effects, 0); assert.equal(gate.active(), false);
    const displaced = gate.recover(async check => {
      token = journal.claimRecovery(expected); check();
      await new Promise(resolve => { releaseWork = resolve; }); check(); effects++;
    }, { ownsRecovery });
    displaced.catch(() => {}); operations.push(displaced);
    await setImmediate(); journal.claimRecovery(journal.read()); releaseWork();
    await assert.rejects(displaced, /maintenance-recovery-required/); token = undefined; expected = journal.read();
    assert.equal(effects, 0); assert.equal(gate.active(), false);
    let checkpoint;
    assert.equal(await gate.recover(check => {
      checkpoint = check; check(); assert.equal(gate.active(), true);
      token = journal.claimRecovery(expected); check(); assert.equal(journal.recoveryOwned(token), true);
      effects++; journal.advance(token, 'service-pending'); check(); return 'prepared';
    }, { ownsRecovery }), 'prepared');
    assert.equal(effects, 1); assert.equal(gate.active(), false); assert.throws(checkpoint, /maintenance-inactive/);
    assert.equal(journal.read().phase, 'service-pending'); assert.equal(journal.clear(), false);
    assert.deepEqual(vault.openPayload(binding, protectedRecord), plain);
    for (const name of ['policy.sqlite', 'workspaces.sqlite', 'development.sqlite', 'execution.sqlite']) assert.equal(existsSync(join(root, name)), false);
    await assert.rejects(gate.control(() => assert.fail('Recovery remains pending')), /maintenance-recovery-required/);
  } finally {
    for (const controller of controllers) controller.abort(); releaseVerification?.(); releaseWork?.(); await Promise.allSettled(operations);
    journal?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false);
  }
});
