import { AsyncLocalStorage } from 'node:async_hooks';

// Host-only, process-local admission. Durable replacement/recovery belongs to the installer.
export function createMaintenanceGate({ ready, verify, recovery = () => false, recoveryReady = () => false, verifyRecovery = () => false }) {
  if ([ready, verify, recovery, recoveryReady, verifyRecovery].some(value => typeof value !== 'function')) throw Error('maintenance-unavailable');
  const context = new AsyncLocalStorage(), controls = new Set(); let held;
  const recovering = () => { try { return recovery() !== false; } catch { return true; } };
  function idle(owner, repair) {
    try { return controls.size === (controls.has(owner) ? 1 : 0) && (repair ? recoveryReady : ready)() === true; }
    catch { return false; }
  }
  async function exclusive(work, { signal, ownsRecovery = () => false } = {}, repair = false) {
    if (typeof work !== 'function' || typeof ownsRecovery !== 'function') throw Error('maintenance-unavailable');
    const owned = () => { try { return ownsRecovery() === true; } catch { return false; } };
    signal?.throwIfAborted(); const owner = context.getStore();
    if (recovering() !== repair || repair && !owned()) throw Error('maintenance-recovery-required');
    if (held !== undefined || !idle(owner, repair)) throw Error('maintenance-deferred');
    const lease = Symbol(); held = lease; // Acquire before the first await; both paths share one lease.
    const checkpoint = () => {
      if (held !== lease) throw Error('maintenance-inactive');
      if ((repair || recovering()) && !owned()) throw Error('maintenance-recovery-required');
      signal?.throwIfAborted(); if (!idle(owner, repair)) throw Error('maintenance-deferred');
    };
    try {
      if (await (repair ? verifyRecovery : verify)(signal) !== true) throw Error('maintenance-unverified');
      checkpoint(); const result = await work(checkpoint); checkpoint(); return result;
    } finally { if (held === lease) held = undefined; }
  }
  return Object.freeze({
    active: () => held !== undefined,
    async control(work, { passive = false } = {}) {
      if (typeof work !== 'function' || typeof passive !== 'boolean') throw Error('maintenance-unavailable');
      if (!passive && recovering()) throw Error('maintenance-recovery-required');
      if (held !== undefined && !passive) throw Error('maintenance-active');
      if (passive) return work(); // Host-selected status/cancellation still uses the authenticated, exact-shape channel.
      const owner = Symbol(); controls.add(owner);
      try { return await context.run(owner, work); } finally { controls.delete(owner); }
    },
    exclusive: (work, options) => exclusive(work, options),
    // Host-only cold recovery. No ordinary readiness or renderer flag supplies qualification.
    recover: (work, options) => exclusive(work, options, true)
  });
}
