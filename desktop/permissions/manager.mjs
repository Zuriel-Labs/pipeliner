import { randomUUID } from 'node:crypto';
import { canonicalJSON, record, capabilityNames } from '../core/settings.mjs';
import { permissionLabels, permissionKeys, permissionShapes, permissionCommand } from './commands.mjs';

// Only the registered PM frame receives this host handle. Every effect still uses policy's captured authority.
export function createPermissionManager({ policy, workspace = () => null, available, initialRevision = 1, onChange = () => {}, onApplied = async () => {} }) {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 1 || ![workspace, available, onChange, onApplied].every(value => typeof value === 'function')) throw Error('Permission controls unavailable');
  const conversation = randomUUID(); let revision = initialRevision, scope = workspace()?.id ? 'repository' : 'global', automaticScope = true, observed, preview, applied, closed = false, busy = false, pending, message = null;
  function facts() {
    const value = available(); canonicalJSON(value); record(value, ['capabilities', 'resources']);
    if (!Array.isArray(value.capabilities) || value.capabilities.some(key => !capabilityNames.includes(key)) || new Set(value.capabilities).size !== value.capabilities.length
      || !Array.isArray(value.resources) || value.resources.length > 1000 || value.resources.some(id => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(id)) || new Set(value.resources).size !== value.resources.length) throw Error('Permission qualification unavailable');
    return value;
  }
  function invalidate() { if (preview) policy.control.invalidate(preview.inputId); preview = null; applied = null; }
  function context() { return canonicalJSON({ repository: workspace()?.id ?? null, policy: policy?.worker.read(null).revision ?? null, available: facts() }); }
  function sync() { if (closed) return; const next = context(); if (observed !== undefined && next !== observed) { invalidate(); revision++; } observed = next; if (automaticScope) scope = workspace()?.id ? 'repository' : 'global'; else if (scope === 'repository' && !workspace()?.id) scope = 'global'; }
  function status() {
    sync(); const selected = workspace(), view = !closed && policy ? policy.worker.read(scope === 'repository' ? selected?.id ?? null : null) : null;
    let active = null;
    if (view && selected) {
      const run = policy.runtime.status(selected.id);
      if (run) try { const captured = policy.worker.read(selected.id, run.policyRevision), grant = policy.worker.authority(selected.id, run.policyRevision);
        active = { issue: run.issue, control: run.control, policyRevision: run.policyRevision, captured: captured.values['permissions.grants'].configuredValue.filter(capability => captured.values['permissions.ceiling'].configuredValue.includes(capability) && captured.bindings.capabilities.includes(capability)),
          effective: grant.capabilities, resources: grant.resources }; } catch { active = { unavailable: true }; }
    }
    const known = facts();
    return { revision, scope, busy, storageAvailable: Boolean(view), repository: selected ? { id: selected.id, name: selected.name, path: selected.path ?? null } : null,
      policyRevision: view?.revision ?? null, values: view ? Object.fromEntries(permissionKeys.map(key => [key, view.values[key]])) : null,
      capabilities: capabilityNames.map(id => ({ id, label: permissionLabels[id], available: known.capabilities.includes(id) })), resources: [...known.resources], active,
      preview: preview ? { scope: preview.scope, target: preview.target, hash: preview.hash, baseRevision: preview.baseRevision, expiresAt: preview.expiresAt,
        before: Object.fromEntries(preview.keys.map(key => [key, preview.before[key]])), after: Object.fromEntries(preview.keys.map(key => [key, preview.after[key]])), repositories: [...preview.affectedRepositories] } : null,
      message };
  }
  const publish = () => { if (!closed) onChange(status()); };
  function selectedScope(value) {
    const explicit = value !== undefined; if (!explicit) value = scope;
    if (!['host', 'global', 'repository'].includes(value) || value === 'repository' && !workspace()?.id) throw Error('Permission scope unavailable');
    if (explicit) automaticScope = false;
    if (value !== scope) { invalidate(); scope = value; revision++; } return { scope, target: scope === 'repository' ? workspace().id : null };
  }
  const keys = () => scope === 'host' ? ['permissions.ceiling'] : ['permissions.grants', 'permissions.resources'];
  function prepare(changes, reset, selected) {
    record(changes, [], keys()); invalidate(); const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: selected.target, text: 'Review permissions for the selected ' + selected.scope + ' scope.' });
    try { const p = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, ...selected, changes, reset }); preview = { ...p, keys: [...Object.keys(changes), ...reset] };
      message = 'Review this exact permission change. Tightening denies the next affected action and safely pauses affected work. Expansion needs a new run or explicit restart; it never revives revoked captured authority.';
    } catch (error) { policy.control.invalidate(input.id); if (error.message === 'Repository permission exceeds host ceiling') { message = 'This repository or default grant exceeds this Mac’s ceiling. Review the host ceiling first. Existing authority is unchanged.'; revision++; publish(); throw error; } if (error.message !== 'Policy proposal has no change') throw error; message = 'These permissions already match. No policy version was created.'; }
    revision++; publish(); return { snapshot: status() };
  }
  async function settle(repositories) {
    busy = true; publish(); let settled = false;
    const event = { repositories, scope, target: scope === 'repository' ? workspace()?.id ?? null : null };
    pending = Promise.resolve().then(() => onApplied(event));
    try { await pending; settled = true; message = 'Permission changes saved; affected work and its safe pause are verified. No work was started or resumed.'; }
    catch { message = 'Permission changes are saved; affected work still needs termination verification. The next affected action stays denied. Retry permission recovery; do not resume uncertain work.'; }
    finally { pending = null; busy = false; revision++; publish(); } return settled;
  }
  async function dispatch(payload) {
    sync(); if (closed || !policy) throw Error('Permission protected configuration unavailable'); canonicalJSON(payload);
    const shape = permissionShapes[payload?.operation]; if (!shape) throw Error('Permission operation unavailable'); record(payload, ['operation', ...shape[0]], shape[1]);
    if (busy) throw Error('Permission settlement pending');
    if (payload.operation === 'chat') { const action = permissionCommand(payload.text); return action ? dispatch(action) : { snapshot: status(), message: 'Ask to show permissions, allow or revoke an action, or apply the reviewed permission change.' }; }
    if (payload.operation === 'view') { selectedScope(payload.scope); publish(); return { snapshot: status() }; }
    if (payload.operation === 'cancel') { invalidate(); message = 'Permission preview cancelled. Existing authority and work are preserved.'; revision++; publish(); return { snapshot: status() }; }
    if (payload.operation === 'repair') { await settle(scope === 'repository' ? [workspace().id] : null); return { snapshot: status() }; }
    if (['prepare', 'toggle', 'resource', 'reset', 'revoke'].includes(payload.operation)) {
      const selected = selectedScope(payload.scope);
      if (payload.operation === 'reset') return prepare({}, keys(), selected);
      if (payload.operation === 'revoke') return prepare(Object.fromEntries(keys().map(key => [key, []])), [], selected);
      if (payload.operation === 'prepare') return prepare(payload.changes, [], selected);
      if (payload.operation === 'resource') {
        if (scope === 'host' || typeof payload.reference !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(payload.reference) || typeof payload.enabled !== 'boolean') throw Error('Permission resource invalid');
        const current = status().values['permissions.resources'].configuredValue;
        if (payload.enabled && !facts().resources.includes(payload.reference)) throw Error('Permission resource unqualified');
        return prepare({ 'permissions.resources': payload.enabled ? [...new Set([...current, payload.reference])] : current.filter(ref => ref !== payload.reference) }, [], selected);
      }
      if (!capabilityNames.includes(payload.capability) || typeof payload.enabled !== 'boolean') throw Error('Permission action invalid');
      const key = scope === 'host' ? 'permissions.ceiling' : 'permissions.grants', current = status().values[key].configuredValue;
      return prepare({ [key]: current.includes(payload.capability) === payload.enabled ? current : capabilityNames.filter(id => id === payload.capability ? payload.enabled : current.includes(id)) }, [], selected);
    }
    if (payload.operation === 'apply') {
      if (!preview) { if (applied && (!payload.hash || applied === payload.hash)) return { snapshot: status(), applied: false }; throw Error('Permission preview unavailable'); }
      const p = preview; if (payload.hash && payload.hash !== p.hash) throw Error('Permission preview changed');
      const result = policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId: conversation, target: p.target });
      preview = null; applied = p.hash; observed = context(); revision++;
      const settled = await settle([...p.affectedRepositories]); return { snapshot: status(), applied: result.applied, settled };
    }
    throw Error('Permission operation unavailable');
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); }, async close() { if (!closed) { invalidate(); closed = true; await pending?.catch(() => {}); } } });
}
