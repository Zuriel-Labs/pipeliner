import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { appearanceKeys, appearanceShapes, appearanceCommand } from './commands.mjs';

export function createAppearanceManager({ policy, initialRevision = 1, onChange = () => {}, onApplied = () => {} }) {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 1 || typeof onChange !== 'function' || typeof onApplied !== 'function') throw new Error('Appearance controls unavailable');
  const conversation = randomUUID(); let revision = initialRevision, observed, preview = null, applied = null, closed = false, message = null;
  function invalidate() { if (preview) policy.control.invalidate(preview.inputId); preview = null; applied = null; }
  function sync() {
    if (closed) return;
    const current = policy?.worker.read(null).revision ?? null;
    if (observed !== undefined && current !== observed) { invalidate(); revision++; }
    observed = current;
  }
  function status() {
    sync(); const view = !closed && policy ? policy.worker.read(null) : null;
    return { revision, storageAvailable: Boolean(view), policyRevision: view?.revision ?? null,
      values: view ? Object.fromEntries(appearanceKeys.map(key => [key, view.values[key]])) : null,
      preview: preview ? { hash: preview.hash, scope: 'host', target: null, baseRevision: preview.baseRevision, expiresAt: preview.expiresAt,
        before: Object.fromEntries(preview.keys.map(key => [key, preview.before[key]])), after: Object.fromEntries(preview.keys.map(key => [key, preview.after[key]])) } : null, message };
  }
  function publish() {
    try { onChange(status()); } catch { message = 'Appearance settings are saved or staged; the view needs refresh. Reopen Settings to check the result.'; }
  }
  function prepare(changes, reset, text) {
    if (Object.keys(changes).some(key => !appearanceKeys.includes(key))) throw new Error('Appearance field unavailable');
    invalidate(); const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: null, text });
    try {
      const p = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope: 'host', target: null, changes, reset });
      preview = { ...p, keys: [...Object.keys(changes), ...reset] };
      message = 'Review the appearance change for this Mac. Applying changes the display immediately; active work keeps its configuration.';
    } catch (error) {
      policy.control.invalidate(input.id);
      if (error.message !== 'Policy proposal has no change') throw error;
      message = 'These appearance settings already match. No policy version was created.';
    }
    revision++; publish(); return { snapshot: status() };
  }
  function dispatch(payload) {
    sync(); if (closed || !policy) throw new Error('Appearance protected configuration unavailable');
    canonicalJSON(payload); const shape = appearanceShapes[payload?.operation];
    if (!shape) throw new Error('Appearance operation unavailable'); record(payload, ['operation', ...shape[0]], shape[1]);
    if (payload.operation === 'chat') {
      const action = appearanceCommand(payload.text);
      return action ? dispatch(action) : { snapshot: status(), message: 'Ask to use dark or light mode, follow system theme, change text size, use compact spacing or reduce motion.' };
    }
    if (payload.operation === 'view') { publish(); return { snapshot: status() }; }
    if (payload.operation === 'cancel') { invalidate(); message = 'Appearance change cancelled. Display and work are preserved.'; revision++; publish(); return { snapshot: status() }; }
    if (payload.operation === 'reset') return prepare({}, appearanceKeys, 'Review resetting this Mac appearance preferences to shipped defaults.');
    if (payload.operation === 'prepare') { record(payload.changes, [], appearanceKeys); return prepare(payload.changes, [], 'Review this Mac appearance preferences.'); }
    if (payload.operation === 'apply') {
      if (!preview) {
        if (applied && (!payload.hash || applied === payload.hash)) return { snapshot: status(), applied: false };
        throw new Error('Appearance preview unavailable');
      }
      const p = preview;
      if (payload.hash && payload.hash !== p.hash) throw new Error('Appearance preview changed');
      const result = policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId: conversation, target: null });
      preview = null; applied = p.hash; observed = result.revision; revision++; message = 'Appearance settings saved for this Mac. Active work is preserved.';
      try { onApplied(); } catch { message = 'Appearance settings saved. Display refresh could not finish; reopen Pipeliner to apply the saved preferences.'; }
      publish(); return { snapshot: status(), applied: result.applied };
    }
    throw new Error('Appearance operation unavailable');
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); }, close() { if (!closed) { invalidate(); closed = true; } } });
}
