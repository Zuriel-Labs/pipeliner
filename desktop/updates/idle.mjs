import { AsyncLocalStorage } from 'node:async_hooks';

// Host-only, process-local admission. Durable replacement/recovery belongs to the installer.
export function createMaintenanceGate({ ready, verify }) {
  if (typeof ready !== 'function' || typeof verify !== 'function') throw Error('maintenance-unavailable');
  const context = new AsyncLocalStorage(), controls = new Set(); let held;
  function idle(owner) {
    try { return controls.size === (controls.has(owner) ? 1 : 0) && ready() === true; }
    catch { return false; }
  }
  return Object.freeze({
    active: () => held !== undefined,
    async control(work, { passive = false } = {}) {
      if (typeof work !== 'function' || typeof passive !== 'boolean') throw Error('maintenance-unavailable');
      if (held !== undefined && !passive) throw Error('maintenance-active');
      if (passive) return work(); // Host-selected status/cancellation still uses the authenticated, exact-shape channel.
      const owner = Symbol(); controls.add(owner);
      try { return await context.run(owner, work); } finally { controls.delete(owner); }
    },
    async exclusive(work, { signal } = {}) {
      if (typeof work !== 'function') throw Error('maintenance-unavailable');
      signal?.throwIfAborted(); const owner = context.getStore();
      if (held !== undefined || !idle(owner)) throw Error('maintenance-deferred');
      const lease = Symbol(); held = lease; // Acquire before the first await; no competing control can dispatch.
      const checkpoint = () => {
        if (held !== lease) throw Error('maintenance-inactive');
        signal?.throwIfAborted(); if (!idle(owner)) throw Error('maintenance-deferred');
      };
      try {
        if (await verify(signal) !== true) throw Error('maintenance-unverified');
        checkpoint(); const result = await work(checkpoint); checkpoint(); return result;
      } finally { if (held === lease) held = undefined; }
    }
  });
}
