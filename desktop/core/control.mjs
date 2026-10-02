import { canonicalJSON, record } from './settings.mjs';

function trustedContext(event, { contents, url, context }) {
  if (contents.isDestroyed() || event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame
    || event.senderFrame.parent !== null || event.senderFrame.url !== url) throw new Error('Untrusted control sender');
  return context();
}

// Keep this handle in the host. Workers never receive it or a channel to this renderer.
export function createControlChannel(control, { contents, url, context }) {
  if (!contents || !url || typeof context !== 'function') throw new Error('Invalid trusted control binding');
  return Object.freeze({
    dispatch(event, payload) {
      const current = trustedContext(event, { contents, url, context });
      canonicalJSON(payload);
      if (!payload || !Number.isSafeInteger(payload.contextRevision) || payload.contextRevision !== current.revision) throw new Error('Control context changed');
      const common = ['operation', 'contextRevision'];
      if (payload.operation === 'input') {
        record(payload, [...common, 'commandId', 'text']);
        return control.capture({ commandId: payload.commandId, text: payload.text, conversationId: current.conversationId, target: current.target });
      }
      if (payload.operation === 'prepare') {
        record(payload, [...common, 'inputId', 'requestId', 'scope', 'changes', 'reset'], ['restoreRevision']);
        const { operation: _operation, contextRevision: _revision, ...request } = payload;
        return control.prepare({ ...request, conversationId: current.conversationId, target: current.target });
      }
      if (payload.operation === 'apply') {
        record(payload, [...common, 'commandId', 'proposalId', 'hash', 'inputId']);
        const { operation: _operation, contextRevision: _revision, ...request } = payload;
        return control.apply({ ...request, conversationId: current.conversationId, target: current.target });
      }
      if (payload.operation === 'invalidate-input') {
        record(payload, [...common, 'inputId']); control.invalidate(payload.inputId, { conversationId: current.conversationId, target: current.target }); return { invalidated: true };
      }
      throw new Error('Unknown control operation');
    },
  });
}

export function createExecutionControlChannel(supervisor, binding) {
  if (!binding.contents || !binding.url || typeof binding.context !== 'function') throw new Error('Invalid trusted control binding');
  return Object.freeze({
    dispatch(event, payload) {
      const current = trustedContext(event, binding); canonicalJSON(payload);
      if (payload?.operation === 'status') {
        record(payload, ['operation']); return { ...(current.target === null ? { run: null, worker: null, pending: null, error: null } : supervisor.status(current.target)), contextRevision: current.revision, ...(current.label ? { repositoryLabel: current.label } : {}) };
      }
      record(payload, ['operation', 'contextRevision']);
      if (!Number.isSafeInteger(payload.contextRevision) || payload.contextRevision !== current.revision) throw new Error('Control context changed');
      if (!['pause', 'resume', 'stop'].includes(payload.operation) || !current.binding) throw new Error('Execution control unavailable');
      return supervisor.control(current.binding, payload.operation);
    },
  });
}

export function guardForegroundClose(window, { supervisor, isLastWindow, backgroundEnabled }) {
  let verified = false, pending = false;
  window.on('close', async event => {
    if (verified || !isLastWindow() || backgroundEnabled()) return;
    event.preventDefault(); if (pending) return; pending = true;
    try { await supervisor.pauseForeground(); verified = true; window.close(); }
    catch { if (!window.isDestroyed()) window.webContents.send('execution:blocked', 'Window kept open: worker termination or effect recovery could not be verified.'); }
    finally { pending = false; }
  });
}
