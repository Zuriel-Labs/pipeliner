import { AsyncLocalStorage } from 'node:async_hooks';

// Host-only, process-local admission. Durable replacement/recovery belongs to the installer.
export function createMaintenanceGate({ ready, verify, recovery = () => false }) {
  if ([ready, verify, recovery].some(value => typeof value !== 'function')) throw Error('maintenance-unavailable');
  const context = new AsyncLocalStorage(), controls = new Set(); let held;
  const recovering = () => { try { return recovery() !== false; } catch { return true; } };
  function idle(owner) {
    try { return controls.size === (controls.has(owner) ? 1 : 0) && ready() === true; }
    catch { return false; }
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
    async exclusive(work, { signal, ownsRecovery = () => false } = {}) {
      if (typeof work !== 'function' || typeof ownsRecovery !== 'function') throw Error('maintenance-unavailable');
      signal?.throwIfAborted(); const owner = context.getStore();
      if (recovering()) throw Error('maintenance-recovery-required');
      if (held !== undefined || !idle(owner)) throw Error('maintenance-deferred');
      const lease = Symbol(); held = lease; // Acquire before the first await; no competing control can dispatch.
      const checkpoint = () => {
        if (held !== lease) throw Error('maintenance-inactive');
        if (recovering()) {
          let owned = false; try { owned = ownsRecovery() === true; } catch { /* Unverified ownership keeps the recovery fence. */ }
          if (!owned) throw Error('maintenance-recovery-required');
        }
        signal?.throwIfAborted(); if (!idle(owner)) throw Error('maintenance-deferred');
      };
      try {
        if (await verify(signal) !== true) throw Error('maintenance-unverified');
        checkpoint(); const result = await work(checkpoint); checkpoint(); return result;
      } finally { if (held === lease) held = undefined; }
    }
  });
}
