import { canonicalJSON, record } from './settings.mjs';

// Keep this handle in the host. Workers never receive it or a channel to this renderer.
export function createControlChannel(control, { contents, url, context }) {
  if (!contents || !url || typeof context !== 'function') throw new Error('Invalid trusted control binding');
  return Object.freeze({
    dispatch(event, payload) {
      if (contents.isDestroyed() || event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame
        || event.senderFrame.parent !== null || event.senderFrame.url !== url) throw new Error('Untrusted control sender');
      canonicalJSON(payload);
      const current = context();
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
