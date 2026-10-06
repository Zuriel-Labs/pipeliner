import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { appearanceKeys, notificationKey, appearanceShapes, appearanceCommand } from './commands.mjs';

export function createAppearanceManager({ policy, workspace = () => null, initialRevision = 1, onChange = () => {}, onApplied = () => {} }) {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 1 || [workspace, onChange, onApplied].some(fn => typeof fn !== 'function')) throw new Error('Appearance controls unavailable');
  const conversation = randomUUID(); let revision = initialRevision, observed, preview = null, applied = null, closed = false, message = null, notificationScope = 'global', explicitScope = false;
  function invalidate() { if (preview) policy.control.invalidate(preview.inputId); preview = null; applied = null; }
  function sync() {
    if (closed) return;
    const current = context();
    if (observed && canonicalJSON(current) !== canonicalJSON(observed)) { invalidate(); revision++; }
    observed = current;
    if (!explicitScope) notificationScope = current.target ? 'repository' : 'global';
    if (notificationScope === 'repository' && !current.target) { notificationScope = 'global'; explicitScope = false; }
  }
  function context() { return { policy: policy?.worker.read(null).revision ?? null, target: workspace()?.id ?? null }; }
  function select(scope) {
    if (!['host', 'global', 'repository'].includes(scope) || scope === 'repository' && !workspace()?.id) throw new Error('Choose a repository for its notification settings');
    if (scope !== 'host') { if (notificationScope !== scope) { invalidate(); notificationScope = scope; revision++; } explicitScope = true; }
    return { scope, target: scope === 'repository' ? workspace().id : null };
  }
  function status() {
    sync(); const view = !closed && policy ? policy.worker.read(null) : null;
    const repository = workspace(), effective = view && policy.worker.read(repository?.id ?? null), notification = view && policy.worker.read(notificationScope === 'repository' ? repository.id : null).values[notificationKey];
    return { revision, storageAvailable: Boolean(view), policyRevision: view?.revision ?? null,
      repository: repository ? { id: repository.id, name: repository.name } : null,
      notificationsEnabled: effective?.values[notificationKey].value ?? false,
      notification: notification ? { scope: notificationScope, target: notificationScope === 'repository' ? repository.id : null, field: notification } : null,
      values: view ? Object.fromEntries(appearanceKeys.map(key => [key, view.values[key]])) : null,
      preview: preview ? { hash: preview.hash, scope: preview.scope, target: preview.target, targetName: preview.targetName, baseRevision: preview.baseRevision, expiresAt: preview.expiresAt,
        before: Object.fromEntries(preview.keys.map(key => [key, preview.before[key]])), after: Object.fromEntries(preview.keys.map(key => [key, preview.after[key]])) } : null, message };
  }
  function publish() {
    try { onChange(status()); } catch { message = 'Appearance settings are saved or staged; the view needs refresh. Reopen Settings to check the result.'; }
  }
  function prepare(changes, reset, selected) {
    const keys = selected.scope === 'host' ? appearanceKeys : [notificationKey];
    record(changes, [], keys);
    invalidate(); const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: selected.target, text: 'Review appearance and in-app notification preferences.' });
    try {
      const p = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, ...selected, changes, reset });
      preview = { ...p, keys: [...Object.keys(changes), ...reset], targetName: selected.target ? workspace().name : null };
      message = selected.scope === 'host' ? 'Review the appearance change for this Mac. Applying changes the display immediately; active work keeps its configuration.' : 'Review in-app notifications for ' + (selected.target ? workspace().name : 'Global defaults') + '. Ordinary replies, controls and error guidance remain available. OS notifications are unchanged.';
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
    if (payload.operation === 'view') { if (payload.scope) select(payload.scope); publish(); return { snapshot: status() }; }
    if (payload.operation === 'cancel') { invalidate(); message = 'Appearance change cancelled. Display and work are preserved.'; revision++; publish(); return { snapshot: status() }; }
    if (['reset', 'prepare'].includes(payload.operation)) {
      const selected = select(payload.scope ?? 'host'), keys = selected.scope === 'host' ? appearanceKeys : [notificationKey];
      return prepare(payload.operation === 'reset' ? {} : payload.changes, payload.operation === 'reset' ? keys : [], selected);
    }
    if (payload.operation === 'apply') {
      if (!preview) {
        if (applied && (!payload.hash || applied === payload.hash)) return { snapshot: status(), applied: false };
        throw new Error('Appearance preview unavailable');
      }
      const p = preview;
      if (payload.hash && payload.hash !== p.hash) throw new Error('Appearance preview changed');
      const result = policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId: conversation, target: p.target });
      preview = null; applied = p.hash; observed = context(); revision++; message = p.scope === 'host' ? 'Appearance settings saved for this Mac. Active work is preserved.' : 'In-app notification preferences saved for ' + (p.targetName ?? 'Global defaults') + '. Ordinary replies, controls and error guidance remain available.';
      try { onApplied(); } catch { message = 'Appearance settings saved. Display refresh could not finish; reopen Pipeliner to apply the saved preferences.'; }
      publish(); return { snapshot: status(), applied: result.applied };
    }
    throw new Error('Appearance operation unavailable');
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); }, close() { if (!closed) { invalidate(); closed = true; } } });
}
