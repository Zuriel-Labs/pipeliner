import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';
import { backgroundCommand, backgroundShapes } from './commands.mjs';
export { backgroundCommand, backgroundShapes } from './commands.mjs';

export const backgroundKeys = ['background.enabled', 'background.startAtLogin'];

export function createBackgroundManager({ policy, host, scheduler, initialRevision = 1, onChange = () => {} }) {
  let revision = initialRevision, conversation = randomUUID(), preview = null, applied = null, closed = false, busy = false, message = null;
  let observed = policy?.worker.read(null).revision;
  const invalidate = () => { if (preview) policy.control.invalidate(preview.inputId); preview = null; };
  function sync() { const next = policy?.worker.read(null).revision; if (next !== observed) { invalidate(); observed = next; conversation = randomUUID(); revision++; } }
  function status() { if (!closed) sync(); const view = policy?.worker.read(null); return { revision, scope: 'host', storageAvailable: Boolean(!closed && policy && host), busy,
    values: view ? Object.fromEntries(backgroundKeys.map(key => [key, view.values[key]])) : null, preview, message, service: host?.status() ?? null,
    checks: scheduler?.() ?? [] }; }
  const publish = (context = false) => { if (context) revision++; if (!closed) onChange(status()); };
  function prepare(changes) {
    canonicalJSON(changes); if (containsSecret(canonicalJSON(changes)) || Object.keys(changes).some(key => !backgroundKeys.includes(key))) throw new Error('Changes must use background fields only.');
    invalidate(); applied = null; const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: null, text: 'Review host background changes ' + canonicalJSON(changes) });
    try { const p = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope: 'host', target: null, changes, reset: [] });
      preview = { ...p, before: Object.fromEntries(backgroundKeys.map(key => [key, p.before[key]])), after: Object.fromEntries(backgroundKeys.map(key => [key, p.after[key]])) };
      message = 'Host setting. Review background and login separately. macOS authorization is required; disable pauses work before removing auto-start.';
    } catch (error) { policy.control.invalidate(input.id); if (error.message !== 'Policy proposal has no change') throw error; message = 'These background settings already match. No policy version created.'; }
    publish(true); return { snapshot: status() };
  }
  async function operation(work) { busy = true; publish(); try { await work(); message = host.status().effective ? 'Background is authorized. Closing the window keeps work running; login follows its separate setting.'
    : host.status().authorization === 'requires-approval' ? 'Background requested. macOS authorization is still required; no background execution is permitted.' : 'Background is off or unavailable. Work remains preserved.'; }
    catch (error) { message = error.message; throw error; } finally { busy = false; publish(); } return { snapshot: status() }; }
  function dispatch(payload) {
    sync(); if (closed || !policy || !host) throw new Error('Background storage unavailable.'); canonicalJSON(payload);
    const shape = backgroundShapes[payload.operation]; if (!shape) throw new Error('Background operation unavailable.'); record(payload, ['operation', ...shape[0]], shape[1]);
    if (payload.operation === 'chat') { const action = backgroundCommand(payload.text); return action ? dispatch(action) : { snapshot: status(), message: 'Ask to show background operation, enable or disable it, start at login, apply this background change or open background authorization.' }; }
    if (busy) throw new Error('Background operation already pending.');
    if (payload.operation === 'prepare') return prepare(payload.changes);
    if (payload.operation === 'apply') {
      if (!preview) { if (applied && (!payload.hash || payload.hash === applied)) return { snapshot: status() }; return Promise.reject(new Error('Review background settings before applying.')); }
      const p = preview; if (payload.hash && p.hash !== payload.hash) throw new Error('Background preview changed.');
      policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId: conversation, target: null });
      preview = null; applied = p.hash; observed = policy.worker.read(null).revision; publish(true); return operation(() => host.reconcile());
    }
    if (payload.operation === 'cancel') { invalidate(); message = 'Background change cancelled.'; publish(true); }
    if (payload.operation === 'cleanup') { if (host.status().configured) throw new Error('Disable background operation before removing its service.'); return operation(() => host.reconcile()); }
    if (payload.operation === 'authorize') return operation(() => host.openSettings());
    if (payload.operation === 'view') return operation(() => host.refresh());
    return { snapshot: status() };
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); }, close() { invalidate(); closed = true; } });
}
