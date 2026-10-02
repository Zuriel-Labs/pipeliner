import { connectionIds } from './vault.mjs';

const catalog = Object.freeze({
  github: { name: 'GitHub', destination: 'api.github.com · github.com', explanation: 'Scoped App access to authorized repositories and organization Projects. Account, installation and resource metadata go to GitHub.' },
  'github-setup': { name: 'GitHub setup and Projects', destination: 'api.github.com · github.com', explanation: 'Optional separate OAuth grant for repository setup and personal Projects (repo/project). Host setup operations only; execution keeps scoped App access.' },
  codex: { name: 'Codex', destination: 'ChatGPT managed OAuth · Codex service', explanation: 'Codex manages ChatGPT login and refresh in its own protected provider home. Account and model discovery go to Codex.' },
  ollama: { name: 'Ollama Cloud', destination: 'https://ollama.com/api', explanation: 'A protected API key goes directly to Ollama Cloud. Model discovery sends authentication only. No local model or automatic provider fallback.' },
});
export const safeConnectionError = error => /^(http-\d{3}|graphql-(forbidden|rejected|insufficient-scopes|validation|not-found)|cancelled|timeout|reauthentication-required|authorization-(expired|denied)|device-flow-disabled|secure-storage-unavailable|protected-record-invalid|connection-changed|provider-unavailable|provider-storage-blocked|capability-unverified|catalog-invalid|model-unavailable|partial-access|account-changed|app-changed|response-too-large|response-invalid|read-failed|transport-failed|native-entry-failed|native-entry-cancelled)$/.test(error?.message) ? error.message : 'connection-check-failed';

// Host-only handle. Workers and renderer receive status, never this object or records.
export function createConnectionManager({ vault, adapters, onChange = () => {}, initialRevision = 1 }) {
  const tasks = new Map(), errors = new Map(); let revision = initialRevision, closed = false;
  const changed = () => { revision++; onChange(status()); };
  const requireReady = id => { if (closed || !vault || !connectionIds.includes(id) || !adapters[id]) throw new Error('connection-unavailable'); };
  function status() {
    return { revision, storageAvailable: Boolean(vault), telemetry: false, connections: connectionIds.map(id => {
      let value = null, error = errors.get(id) ?? null;
      try { value = vault?.get(id).value; } catch (failure) { error = safeConnectionError(failure); }
      const view = value?.view ?? {}, task = tasks.get(id);
      return { id, ...catalog[id], health: task ? task.operation === 'disconnect' ? 'disconnecting' : `${task.operation}ing` : value?.cleanupPending ? 'cleanup-required' : view.health ?? 'disconnected',
        account: view.account ?? null, lastVerified: view.lastVerified ?? null, expiresAt: view.expiresAt ?? null,
        repositories: view.repositories ?? [], projects: view.projects ?? [], installations: view.installations ?? [],
        resourceCompleteness: view.resourceCompleteness ?? null, permissions: view.permissions ?? [],
        models: view.models ?? [], selectedModel: view.selectedModel ?? null, capability: view.capability ?? null,
        credentialStatus: view.credentialStatus ?? (value ? 'Protected locally; rechecked before use' : 'No local credential'),
        error, busy: Boolean(task), cleanupPending: Boolean(value?.cleanupPending),
      };
    }) };
  }
  function start(id, operation, model) {
    requireReady(id);
    if (!['connect', 'refresh', 'test'].includes(operation) || tasks.has(id)) throw new Error('connection-busy');
    const before = vault.get(id).value;
    if (before?.cleanupPending) throw new Error('connection-unavailable');
    if (operation !== 'connect' && (!before || before.cleanupPending || !before.credential && id !== 'codex')) throw new Error('connection-unavailable');
    if (operation === 'test' && (!['connected', 'limited'].includes(before.view?.health) ||
      !before.view.models?.some(entry => entry.id === model))) throw new Error('connection-unavailable');
    const epoch = vault.begin(id), controller = new AbortController(), task = { operation, controller };
    tasks.set(id, task); errors.delete(id); changed();
    task.done = Promise.resolve().then(async () => {
      const result = await adapters[id][operation]({ value: before, model, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!vault.current(id, epoch)) return;
      if (!result?.view || !vault.save(id, epoch, result)) throw new Error('connection-changed');
    }).catch(error => {
      if (!vault.current(id, epoch)) return;
      const code = controller.signal.aborted ? 'cancelled' : safeConnectionError(error); errors.set(id, code);
      const value = vault.get(id).value;
      if (id === 'codex' && operation === 'connect') vault.save(id, epoch, { credential: null, cleanupPending: true, view: { health: 'disconnected' } });
      else if (value?.view) vault.save(id, epoch, { ...value, view: { ...value.view, health: ['http-401', 'reauthentication-required', 'account-changed'].includes(code) ? 'reauthentication' : 'offline', capability: null } });
    }).finally(() => { if (tasks.get(id) === task) { tasks.delete(id); changed(); } });
    return { accepted: true, snapshot: status() };
  }
  function cancel(id) {
    requireReady(id); const task = tasks.get(id); if (!task || task.operation === 'disconnect') throw new Error('connection-unavailable');
    if (id === 'codex' && task.operation === 'connect') return disconnect(id);
    const epoch = vault.begin(id), value = vault.get(id).value;
    if (value?.view) vault.save(id, epoch, { ...value, view: { ...value.view, health: 'offline', capability: null } });
    task.controller.abort(); errors.set(id, 'cancelled'); changed();
    return { accepted: true, snapshot: status() };
  }
  function disconnect(id) {
    requireReady(id); const previous = tasks.get(id), value = vault.get(id).value, epoch = vault.erase(id);
    previous?.controller.abort(); errors.delete(id);
    // Managed provider credentials require verified logout even after an interrupted login.
    if (id === 'codex') vault.save(id, epoch, { cleanupPending: true, credential: null, view: { health: 'disconnected' } });
    const controller = new AbortController(), task = { operation: 'disconnect', controller }; tasks.set(id, task); changed();
    task.done = (async () => {
      await previous?.done;
      await adapters[id].disconnect({ value, signal: controller.signal });
      if (vault.current(id, epoch)) vault.save(id, epoch, null);
    })().catch(error => { if (vault.current(id, epoch)) errors.set(id, safeConnectionError(error)); })
      .finally(() => { if (tasks.get(id) === task) { tasks.delete(id); changed(); } });
    return { accepted: true, snapshot: status(), message: 'Disconnected locally. Provider authorization may remain; remove it in provider settings if needed.' };
  }
  return Object.freeze({ status, start, cancel, disconnect,
    async idle(id) { while (tasks.has(id)) await tasks.get(id).done; },
    async close() { if (tasks.get('codex')?.operation === 'connect') disconnect('codex'); closed = true; for (const task of tasks.values()) task.controller.abort(); await Promise.allSettled([...tasks.values()].map(task => task.done)); },
  });
}
