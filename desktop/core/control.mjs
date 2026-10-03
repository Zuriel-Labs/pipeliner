import { canonicalJSON, record } from './settings.mjs';
import { connectionCommand } from '../connections/commands.mjs';
import { setupCommand } from '../repositories/commands.mjs';
import { issueCommand } from '../issues/commands.mjs';
import { pipelineShapes } from '../pipelines/commands.mjs';
import { developmentShapes } from '../development/commands.mjs';
import { schedulingShapes } from '../scheduling/commands.mjs';

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

export function createConnectionControlChannel(manager, binding) {
  return Object.freeze({ dispatch(event, payload) {
    const current = trustedContext(event, binding); canonicalJSON(payload);
    if (payload?.operation === 'status') { record(payload, ['operation']); return manager.status(); }
    const chat = payload?.operation === 'chat';
    record(payload, chat ? ['operation', 'contextRevision', 'text'] : ['operation', 'contextRevision', 'connection'], !chat && payload.operation === 'test' ? ['model'] : []);
    if (payload.contextRevision !== current.revision) throw new Error('Control context changed');
    let action = payload;
    if (chat) {
      action = connectionCommand(payload.text);
      if (!action.connection) return action;
      if (action.operation === 'test') {
        const connection = manager.status().connections.find(item => item.id === action.connection);
        if (connection?.id.startsWith('github')) return manager.start(action.connection, 'refresh');
        if (!action.model) return { message: 'Choose a model to test. This sends a short synthetic prompt and tool result to that provider and may consume usage. No repository content is sent.',
          choices: (connection?.models ?? []).map(model => ({ connection: action.connection, model: model.id, name: model.name })) };
      }
    }
    if (action.operation === 'cancel') return manager.cancel(action.connection);
    if (action.operation === 'disconnect') return manager.disconnect(action.connection);
    if (!['connect', 'refresh', 'test'].includes(action.operation)) throw new Error('Unknown connection operation');
    return manager.start(action.connection, action.operation, action.model);
  } });
}

export function createWorkspaceControlChannel(manager, binding) {
  return Object.freeze({ dispatch(event, payload) {
    const current = trustedContext(event, binding); canonicalJSON(payload);
    if (payload?.operation === 'status') { record(payload, ['operation']); return manager.status(); }
    const shapes = {
      begin: [['mode'], ['values']], chat: [['text'], []], choose: [['field', 'value'], []], map: [['role', 'field'], []],
      folder: [[], []], prepare: [[], []], apply: [['hash'], []], cancel: [[], []], repair: [[], []], select: [['workspace'], []], install: [[], []],
    };
    const shape = shapes[payload?.operation]; if (!shape) throw new Error('Unknown setup operation');
    record(payload, ['operation', 'contextRevision', ...shape[0]], shape[1]);
    if (payload.contextRevision !== current.revision) throw new Error('Control context changed');
    if (payload.operation === 'chat') { const action = setupCommand(payload.text); return action ? manager.dispatch(action) : manager.status().draft ? manager.dispatch({ operation: 'answer', text: payload.text }) : { message: 'Ask to import or create a project, or choose one setup action below.' }; }
    return manager.dispatch(payload);
  } });
}

export function createIssueControlChannel(manager, binding) {
  return Object.freeze({ dispatch(event, payload) {
    const current = trustedContext(event, binding); canonicalJSON(payload);
    if (payload?.operation === 'status') { record(payload, ['operation']); return manager.status(); }
    const shapes = { chat: [['text'], []], refresh: [[], []], select: [['number'], []], begin: [[], ['values']], choose: [['field', 'value'], []], prepare: [[], []],
      create: [[], ['hash']], cancel: [[], []], repair: [[], []], ready: [['number', 'enabled'], []], 'policy-prepare': [['mode', 'agentCreation'], []], 'policy-apply': [['hash'], []], 'policy-cancel': [[], []] };
    const shape = shapes[payload?.operation]; if (!shape) throw new Error('Unknown Issue operation');
    record(payload, ['operation', 'contextRevision', ...shape[0]], shape[1]);
    if (payload.contextRevision !== current.revision) throw new Error('Control context changed');
    let action = payload;
    if (payload.operation === 'chat') {
      action = issueCommand(payload.text);
      if (!action) return manager.status().draft ? manager.dispatch({ operation: 'answer', text: payload.text }) : { message: 'Ask to show Issues, draft an Issue or mark a specific Issue Ready.' };
      if (action.operation === 'policy-prepare') { const policy = manager.status().policy; action = { ...action, mode: action.mode ?? policy?.mode.value, agentCreation: action.agentCreation ?? policy?.agentCreation.value }; }
      if (action.operation === 'policy-apply') action = { ...action, hash: manager.status().policyPreview?.hash };
    }
    return manager.dispatch(action);
  } });
}

export function createPipelineControlChannel(manager, binding) {
  return Object.freeze({ dispatch(event, payload) {
    const current = trustedContext(event, binding); canonicalJSON(payload);
    if (payload?.operation === 'status') { record(payload, ['operation']); return manager.status(); }
    const shape = pipelineShapes[payload?.operation]; if (!shape) throw new Error('Unknown pipeline operation');
    record(payload, ['operation', 'contextRevision', ...shape[0]], shape[1]);
    if (payload.contextRevision !== current.revision) throw new Error('Control context changed');
    const { contextRevision: _revision, ...action } = payload; return manager.dispatch(action);
  } });
}

export function createDevelopmentControlChannel(manager, binding) {
  return Object.freeze({ dispatch(event, payload) {
    const current = trustedContext(event, binding); canonicalJSON(payload);
    if (payload?.operation === 'status') { record(payload, ['operation']); return manager.status(); }
    const shape = developmentShapes[payload?.operation]; if (!shape) throw new Error('Unknown Development operation');
    record(payload, ['operation', 'contextRevision', ...shape[0]], shape[1]);
    if (payload.contextRevision !== current.revision) throw new Error('Control context changed');
    const { contextRevision: _revision, ...action } = payload; return manager.dispatch(action);
  } });
}

export function createSchedulingControlChannel(manager, binding) {
  return Object.freeze({ dispatch(event, payload) {
    const current = trustedContext(event, binding); canonicalJSON(payload);
    if (payload?.operation === 'status') { record(payload, ['operation']); return manager.status(); }
    const shape = schedulingShapes[payload?.operation]; if (!shape) throw new Error('Unknown scheduling operation');
    record(payload, ['operation', 'contextRevision', ...shape[0]], shape[1]);
    if (payload.contextRevision !== current.revision) throw new Error('Control context changed');
    const { contextRevision: _revision, ...action } = payload; return manager.dispatch(action);
  } });
}
