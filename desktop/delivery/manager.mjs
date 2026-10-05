import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { deliveryKeys, deliveryShapes, deliveryCommand } from './commands.mjs';

export function createDeliveryManager({ policy, artifacts = null, workspace = () => null, inspect, openHelp, initialRevision = 1, onChange = () => {}, onApplied = () => {} }) {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 1 || [workspace, onChange, onApplied].some(fn => typeof fn !== 'function')) throw Error('Delivery controls unavailable');
  const conversation = randomUUID(); let revision = initialRevision, observed, scope = 'repository', preview = null, artifactPreview = null, artifactAfter = null, applied = null, closed = false, message = null, checking = null, changing = null, prerequisites = null;
  function invalidate() { if (preview) policy.control.invalidate(preview.inputId); preview = null; artifactPreview = null; applied = null; }
  function artifactView(after = null) {
    if (!artifacts || !workspace()?.id) return null;
    try { return artifacts.inventory(workspace().id, { after }); } catch { return { unavailable: true, items: [], revision: 'unavailable' }; }
  }
  function context() { return { target: workspace()?.id ?? null, policy: policy?.worker.read(null).revision ?? null, artifacts: artifactView()?.revision ?? null }; }
  function sync() {
    if (closed) return; const current = context();
    if (observed && canonicalJSON(current) !== canonicalJSON(observed)) { invalidate(); artifactAfter = null; revision++; }
    observed = current; if (scope === 'repository' && !current.target) scope = 'global';
  }
  function select(value) {
    if (!['host', 'global', 'repository'].includes(value) || value === 'repository' && !workspace()?.id) throw Error('Choose a repository for its delivery settings');
    if (value !== scope) { invalidate(); scope = value; revision++; } return { scope, target: scope === 'repository' ? workspace().id : null };
  }
  function status() {
    sync(); const view = !closed && policy ? policy.worker.read(scope === 'repository' ? workspace().id : null) : null;
    return { revision, storageAvailable: Boolean(view), repository: workspace() ? { id: workspace().id, name: workspace().name } : null, scope,
      policyRevision: view?.revision ?? null, values: view ? Object.fromEntries([...deliveryKeys, 'delivery.output', 'delivery.publish'].map(key => [key, view.values[key]])) : null,
      preview: preview ? { hash: preview.hash, scope: preview.scope, target: preview.target, baseRevision: preview.baseRevision, expiresAt: preview.expiresAt,
        before: Object.fromEntries(preview.keys.map(key => [key, preview.before[key]])), after: Object.fromEntries(preview.keys.map(key => [key, preview.after[key]])) } : null,
      artifactPreview: artifactPreview ? structuredClone(artifactPreview) : null, artifacts: artifactView(artifactAfter),
      prerequisites, busy: Boolean(checking || changing), installer: null, buildQualified: false, message };
  }
  function publish() { try { onChange(status()); } catch { message = 'Delivery view needs refresh. Reopen Settings to inspect saved values.'; } }
  function prepare(changes, reset, selected) {
    record(changes, [], deliveryKeys); const allowed = deliveryKeys.filter(key => selected.scope === 'host' ? key !== 'delivery.keepLatest' : key === 'delivery.keepLatest');
    if ([...Object.keys(changes), ...reset].some(key => !allowed.includes(key))) throw Error('Delivery field and scope do not match');
    invalidate(); const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: selected.target, text: 'Review delivery retention and storage limits.' });
    try {
      const p = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, ...selected, changes, reset });
      preview = { ...p, keys: [...Object.keys(changes), ...reset] }; message = 'Review delivery limits and scope. Saving affects future allocation and cleanup; pinned, active and recovery artifacts remain protected.';
    } catch (error) { policy.control.invalidate(input.id); if (error.message !== 'Policy proposal has no change') throw error; message = 'These delivery settings already match. No policy version was created.'; }
    revision++; publish(); return { snapshot: status() };
  }
  async function cancelCheck() { const operation = checking; if (operation) { operation.controller.abort(); await operation.done; } }
  async function cancelArtifact() { const operation = changing; if (operation) { operation.controller.abort(); try { await operation.done; } catch {} } }
  async function check() {
    if (checking) return { snapshot: status() }; if (typeof inspect !== 'function') throw Error('Mac prerequisite inspection unavailable');
    const operation = { controller: new AbortController() }; checking = operation; prerequisites = null; message = 'Checking this Mac’s build tools and signing prerequisites.'; revision++; publish();
    operation.done = (async () => {
      try {
        const result = await inspect(operation.controller.signal); operation.controller.signal.throwIfAborted();
        record(result, ['host', 'compiler', 'compilerVersion', 'developerId', 'localReview']);
        if (typeof result.host !== 'string' || !/^macOS [0-9.]+ · (?:arm64|x64)$/.test(result.host)
          || ![result.compiler, result.developerId, result.localReview].every(value => ['detected', 'missing', 'unavailable'].includes(value))
          || result.compilerVersion !== null && (typeof result.compilerVersion !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(result.compilerVersion))) throw Error();
        prerequisites = structuredClone(result); message = 'Mac check finished. Detected prerequisites do not establish build readiness. No project build or signing action ran.';
      } catch { if (!closed) message = operation.controller.signal.aborted ? 'Mac check cancelled. Project files and configuration are preserved.' : 'Mac prerequisites could not be verified. Retry the check; no build or signing action ran.'; }
      finally { checking = null; revision++; if (!closed) publish(); }
    })();
    await operation.done; return { snapshot: status() };
  }
  async function dispatch(payload) {
    sync(); if (closed || !policy) throw Error('Delivery protected configuration unavailable'); canonicalJSON(payload);
    const shape = deliveryShapes[payload?.operation]; if (!shape) throw Error('Delivery operation unavailable'); record(payload, ['operation', ...shape[0]], shape[1]);
    if (payload.operation === 'chat') { const action = deliveryCommand(payload.text); return action ? dispatch(action) : { snapshot: status(), message: 'Ask to show delivery settings, find an installer, check this Mac or change artifact limits.' }; }
    if (payload.operation === 'cancel') { const inFlight = Boolean(changing); await cancelCheck(); await cancelArtifact(); invalidate(); revision++; message = inFlight ? 'Artifact action settled. Inspect retained artifacts for completed removal or recovery needs.' : 'Delivery change or check cancelled. Artifacts and configuration are preserved.'; publish(); return { snapshot: status() }; }
    if (checking || changing) throw Error('Wait for the delivery action or cancel it');
    if (payload.operation === 'inspect') return check();
    if (['view', 'scope'].includes(payload.operation)) { if (payload.scope) select(payload.scope); publish(); return { snapshot: status() }; }
    if (['artifacts', 'artifact', 'artifactApply'].includes(payload.operation)) {
      if (!artifacts || !workspace()?.id || artifactView()?.unavailable) throw Error('Choose a repository with available protected artifact storage');
      if (payload.operation === 'artifacts') { artifacts.inventory(workspace().id, { after: payload.after ?? null }); artifactAfter = payload.after ?? null; revision++; message = 'Retained artifacts belong to ' + workspace().name + '. Validation provenance is shown with each artifact.'; publish(); return { snapshot: status() }; }
      if (payload.operation === 'artifact') {
        invalidate(); const id = payload.id === 'latest' ? artifactView()?.items.find(item => item.state === 'verified')?.id : payload.id;
        artifactPreview = artifacts.prepare(workspace().id, { action: payload.action, ...(id !== undefined ? { id } : {}) });
        revision++; message = payload.action === 'retain' ? 'Review removal of ' + artifactPreview.remove.length + ' older artifacts. Latest, pinned, active and recovery artifacts remain protected.' : 'Review the artifact change for ' + workspace().name + '. No bytes or protection flags have changed.';
        publish(); return { snapshot: status() };
      }
      if (!artifactPreview) { if (applied && (!payload.hash || applied === payload.hash)) return { snapshot: status(), applied: false }; throw Error('Artifact preview unavailable'); }
      const p = artifactPreview; if (payload.hash && payload.hash !== p.hash) throw Error('Artifact preview changed');
      const operation = { controller: new AbortController() }; changing = operation; operation.done = artifacts.apply(p, { signal: operation.controller.signal }); revision++; publish();
      let result;
      try { result = await operation.done; }
      catch { artifactPreview = null; message = 'Artifact action interrupted. Inspect retained artifacts; completed removals stay recorded and uncertain bytes remain held for recovery.'; throw Error('Artifact action interrupted; inspect retained artifacts'); }
      finally { changing = null; revision++; if (!closed) publish(); }
      artifactPreview = null; applied = p.hash; observed = context(); revision++;
      message = p.action === 'retain' ? result.removed + ' older artifacts removed with ownership and checksum verification. Protected artifacts remain.' : 'Artifact protection saved for ' + workspace().name + '.';
      publish(); return { snapshot: status(), applied: true };
    }
    if (payload.operation === 'help') {
      if (!['tools', 'signing'].includes(payload.kind) || typeof openHelp !== 'function') throw Error('Build setup guide unavailable');
      await openHelp(payload.kind); return { snapshot: status() };
    }
    if (['prepare', 'reset'].includes(payload.operation)) {
      const selected = select(payload.scope); return prepare(payload.operation === 'prepare' ? payload.changes : {}, payload.operation === 'reset' ? deliveryKeys.filter(key => selected.scope === 'host' ? key !== 'delivery.keepLatest' : key === 'delivery.keepLatest') : [], selected);
    }
    if (payload.operation === 'apply') {
      if (!preview) { if (applied && (!payload.hash || applied === payload.hash)) return { snapshot: status(), applied: false }; throw Error('Delivery preview unavailable'); }
      const p = preview; if (payload.hash && payload.hash !== p.hash) throw Error('Delivery preview changed');
      const result = policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId: conversation, target: p.target });
      preview = null; applied = p.hash; observed = context(); revision++; message = 'Delivery limits saved. No artifacts were allocated or deleted.';
      try { onApplied(); } catch { message = 'Delivery limits saved. Refresh did not finish; reopen Settings to inspect the saved values.'; }
      publish(); return { snapshot: status(), applied: result.applied };
    }
    throw Error('Delivery operation unavailable');
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); }, async close() { if (!closed) { invalidate(); closed = true; await cancelCheck(); await cancelArtifact(); } } });
}
