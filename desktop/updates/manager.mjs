import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { updateShapes, updateCommand } from './commands.mjs';

export function createUpdateManager({ policy, version = null, initialRevision = 1, onChange = () => {}, onApplied = () => {} }) {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 1 || [onChange, onApplied].some(fn => typeof fn !== 'function')
    || version !== null && (typeof version !== 'string' || version.length > 128 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version))) throw Error('Desktop update controls unavailable');
  const conversationId = randomUUID(); let revision = initialRevision, observed, preview = null, applied = null, message = null, closed = false;
  function invalidate() { if (preview) policy.control.invalidate(preview.inputId); preview = null; applied = null; }
  function sync() {
    if (closed) return;
    const current = policy?.worker.read(null).revision ?? null;
    if (observed !== undefined && current !== observed) { invalidate(); revision++; }
    observed = current;
  }
  function status() {
    sync(); const view = !closed && policy ? policy.worker.read(null) : null;
    return { revision, storageAvailable: Boolean(view), scope: 'host', policyRevision: view?.revision ?? null, installedVersion: version,
      values: view ? { 'updates.channel': view.values['updates.channel'] } : null,
      sourceConfigured: Boolean(view?.values['updates.source'].value), sourceQualified: false, installQualified: false, lastCheck: null, release: null,
      preview: preview ? { hash: preview.hash, scope: preview.scope, target: preview.target, baseRevision: preview.baseRevision, expiresAt: preview.expiresAt,
        before: { 'updates.channel': preview.before['updates.channel'] }, after: { 'updates.channel': preview.after['updates.channel'] } } : null, message };
  }
  function publish() { try { onChange(status()); } catch { message = 'Update view needs refresh. Reopen Settings to inspect the saved channel.'; } }
  function prepare(changes, reset = []) {
    record(changes, [], ['updates.channel']); invalidate();
    const input = policy.control.capture({ commandId: randomUUID(), conversationId, target: null, text: 'Review this Mac’s Desktop update channel.' });
    try {
      preview = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId, scope: 'host', target: null, changes, reset });
      message = 'Review this Mac’s update channel. Applying saves the channel only; no update is checked, downloaded or installed.';
    } catch (error) {
      policy.control.invalidate(input.id);
      if (error.message !== 'Policy proposal has no change') throw error;
      message = 'The update channel already matches. No configuration version was created.';
    }
    revision++; publish(); return { snapshot: status() };
  }
  async function dispatch(payload) {
    sync(); if (closed || !policy) throw Error('Desktop update protected configuration unavailable'); canonicalJSON(payload);
    const shape = updateShapes[payload?.operation]; if (!shape) throw Error('Desktop update operation unavailable'); record(payload, ['operation', ...shape[0]], shape[1]);
    if (payload.operation === 'chat') {
      const action = updateCommand(payload.text); if (!action) throw Error('Desktop update command unavailable'); return dispatch(action);
    }
    if (payload.operation === 'prepare') return prepare(payload.changes);
    if (payload.operation === 'reset') return prepare({}, ['updates.channel']);
    if (payload.operation === 'cancel') { invalidate(); revision++; message = 'Update channel change cancelled. Saved settings and app files are preserved.'; }
    else if (payload.operation === 'apply') {
      if (payload.hash !== undefined && (typeof payload.hash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.hash))) throw Error('Desktop update preview changed');
      if (!preview) { if (applied && (payload.hash === undefined || applied === payload.hash)) return { snapshot: status(), applied: false }; throw Error('Desktop update preview unavailable'); }
      const p = preview; if (payload.hash !== undefined && payload.hash !== p.hash) throw Error('Desktop update preview changed');
      const result = policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId, target: null });
      preview = null; applied = p.hash; observed = policy.worker.read(null).revision; revision++; message = 'Update channel saved for this Mac. No check, download, installation or restart ran.';
      try { onApplied(); } catch { message = 'Update channel saved. Refresh did not finish; reopen Settings to inspect it.'; }
      publish(); return { snapshot: status(), applied: result.applied };
    } else if (['check', 'install'].includes(payload.operation)) {
      revision++; message = payload.operation === 'check' ? 'Updates cannot be checked yet. A trusted source reader needs qualification. No check or download ran.'
        : 'Update installation is unavailable. A verified release, qualified installer and migration/recovery preview are required. No app files changed.';
    } else if (payload.operation !== 'view') throw Error('Desktop update operation unavailable');
    publish(); return { snapshot: status() };
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); }, close() { if (!closed) { invalidate(); closed = true; } } });
}
