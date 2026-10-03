import { createHash } from 'node:crypto';
import { record } from '../core/settings.mjs';
import { endpointURL, createMCPClient } from './transport.mjs';

const keyValid = value => typeof value === 'string' && /^[A-Za-z0-9._~+\/-]{8,4096}={0,2}$/.test(value);
export const toolCredentialId = endpoint => 'mcp-' + createHash('sha256').update(endpointURL(endpoint).href).digest('hex');
function authority(authorize, signal) {
  signal?.throwIfAborted(); if (typeof authorize !== 'function') throw new Error('Tool connection authority unavailable.');
  const result = authorize(); if (result instanceof Promise) { result.catch(() => {}); throw new Error('Tool connection authority unavailable.'); }
  if (result === false) throw new Error('Tool connection authority unavailable.');
}

// Host-only credential boundary. Renderer/worker handles expose no vault or secret access.
export function createToolConnections({ vault, entry, client = createMCPClient, onChange = () => {} }) {
  let closed = false, pending = null; const leases = new Set();
  const ready = () => { if (closed || !vault) throw new Error('Tool secure connection storage unavailable.'); };
  function saved(endpoint) {
    ready(); const id = toolCredentialId(endpoint), value = vault.get(id);
    if (value.value !== null) {
      try { record(value.value, ['kind', 'endpoint', 'credential']); }
      catch { throw new Error('Tool credential destination could not be verified.'); }
      if (value.value.kind !== 'mcp-bearer' || value.value.endpoint !== endpoint || !keyValid(value.value.credential)) throw new Error('Tool credential destination could not be verified.');
    }
    return { id, ...value };
  }
  async function closeEndpoint(endpoint) {
    try { await Promise.all([...leases].filter(value => value.endpoint === endpoint).map(value => value.close())); }
    catch { throw new Error('Tool connection cleanup could not be verified.'); }
  }
  return Object.freeze({
    epoch(endpoint) { return saved(endpoint).epoch; },
    status(endpoint) { const value = saved(endpoint); return { hasCredential: value.value !== null, epoch: value.epoch }; },
    async configure(endpoint, { signal, authorize } = {}) {
      ready(); authority(authorize, signal); const before = saved(endpoint);
      if (pending || !entry) throw new Error('Tool native credential entry unavailable or already pending.');
      const controller = new AbortController(), active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let finish, stored = false; const done = new Promise(resolve => { finish = resolve; }); pending = { controller, done };
      try {
        const value = await entry(endpoint, active); authority(authorize, active); ready();
        if (!keyValid(value?.key)) throw new Error();
        if (!vault.current(before.id, before.epoch)) throw new Error('Tool connection changed.');
        await closeEndpoint(endpoint); authority(authorize, active); ready();
        if (!vault.current(before.id, before.epoch)) throw new Error('Tool connection changed.');
        const epoch = vault.begin(before.id);
        if (!vault.save(before.id, epoch, { kind: 'mcp-bearer', endpoint, credential: value.key })) throw new Error('Tool connection changed.');
        stored = true;
        onChange(); return { credentialStored: true, epoch };
      } catch (error) {
        throw new Error(stored ? 'Tool credential saved; refresh the connection display before continuing.' : error?.message === 'native-entry-cancelled' || active.aborted ? 'Tool credential entry cancelled; saved connection preserved.'
          : ['Tool connection changed.', 'Tool connection authority unavailable.'].includes(error?.message) ? error.message : 'Tool credential entry failed; inspect the secure connection.');
      } finally { pending = null; finish(); }
    },
    async disconnect(endpoint, { signal, authorize } = {}) {
      ready(); authority(authorize, signal); const before = saved(endpoint);
      if (pending) throw new Error('Tool credential entry already pending.');
      await closeEndpoint(endpoint); authority(authorize, signal); ready();
      if (!vault.current(before.id, before.epoch)) throw new Error('Tool connection changed.');
      const epoch = vault.erase(before.id); onChange(); return { credentialRemoved: true, epoch };
    },
    async lease(pack, { signal, authorize } = {}) {
      ready(); authority(authorize, signal); const endpoint = pack?.definition?.mcp?.endpoint, before = saved(endpoint);
      if (leases.size >= 5) throw new Error('Tool connection capacity occupied.');
      let stopped = false;
      const check = () => { authority(authorize, signal); if (closed || stopped || !vault.current(before.id, before.epoch)) throw new Error('Tool connection changed.'); };
      const transport = client({ endpoint, credential: before.value?.credential ?? null, authorize: check });
      const invoke = async (method, args) => {
        let started = false;
        try { check(); started = true; const result = await transport[method](...args); check(); return result; }
        catch (error) { throw Object.assign(new Error(error?.message === 'Tool connection changed.' ? error.message : 'Tool connection request denied or incomplete.'),
          { dispatched: started && error?.dispatched !== false }); }
      };
      const lease = Object.freeze({ endpoint, protocolVersion: transport.protocolVersion,
        list: options => invoke('list', [options]), call: (tool, input, options) => invoke('call', [tool, input, options]),
        async close() { stopped = true; try { await transport.close(); } catch { throw new Error('Tool connection cleanup could not be verified.'); } leases.delete(lease); } });
      leases.add(lease); return lease;
    },
    async close() { closed = true; pending?.controller.abort(); await pending?.done; await Promise.all([...leases].map(value => value.close())); },
  });
}
