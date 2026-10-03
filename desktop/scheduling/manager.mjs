import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';
import { scheduleKeys } from './model.mjs';
import { schedulingCommand, schedulingShapes } from './commands.mjs';

export function createSchedulingManager({ store, policy, scheduler, initialRevision = 1, onChange = () => {} }) {
  let selected = store?.selected() ?? null, scope = selected ? 'repository' : 'global', revision = initialRevision, conversation = randomUUID(), preview = null, closed = false, message = null, applied = null;
  let observed = policy?.worker.read(null).revision;
  const target = () => scope === 'repository' ? selected : null;
  const invalidate = () => { if (preview) policy.control.invalidate(preview.inputId); preview = null; };
  function sync() {
    const next = store?.selected() ?? null, version = policy?.worker.read(null).revision;
    if (next !== selected || version !== observed) { invalidate(); if (next !== selected) scope = next ? 'repository' : 'global'; selected = next; observed = version; conversation = randomUUID(); revision++; }
  }
  function status() {
    if (!closed) sync(); const view = policy?.worker.read(target());
    return { revision, workspaceId: selected, repositoryLabel: store?.workspaces().find(value => value.id === selected)?.name ?? null, scope,
      storageAvailable: Boolean(!closed && store && policy && scheduler), values: view ? Object.fromEntries(scheduleKeys.map(key => [key, view.values[key]])) : null,
      trigger: view?.values['intake.trigger'].value ?? 'pm', preview, message, busy: scheduler?.busy() ?? false,
      suggestedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      checks: store && scheduler ? store.workspaces().filter(workspace => scope === 'global' || workspace.id === selected).map(workspace => ({ repository: workspace.name, ...scheduler.status(workspace.id) })) : [] };
  }
  const publish = () => { revision++; if (!closed) onChange(status()); };
  function prepare(changes, reset = []) {
    canonicalJSON(changes);
    if (containsSecret(canonicalJSON(changes)) || Object.keys(changes).some(key => !scheduleKeys.includes(key))) throw new Error('Schedule changes must use scheduling fields only.');
    if (changes['scheduling.mode'] === 'calendar' && !Object.hasOwn(changes, 'scheduling.timezone') && !policy.worker.read(target()).values['scheduling.timezone'].value) changes = { ...changes, 'scheduling.timezone': Intl.DateTimeFormat().resolvedOptions().timeZone };
    invalidate(); applied = null;
    const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: target(), text: 'Review ' + scope + ' scheduling changes ' + canonicalJSON(changes) });
    try {
      const p = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope, target: target(), changes, reset });
      preview = { ...p, before: Object.fromEntries(scheduleKeys.map(key => [key, p.before[key]])), after: Object.fromEntries(scheduleKeys.map(key => [key, p.after[key]])), affectedRepositories: p.affectedRepositories.map(id => store.workspaces().find(value => value.id === id)?.name ?? id) };
      message = 'Review this scope and schedule. Apply changes future checks; automatic starts still require the configured schedule trigger.';
    } catch (error) { policy.control.invalidate(input.id); if (error.message !== 'Policy proposal has no change') throw error; message = 'The current schedule already matches. No configuration version was created.'; }
    publish(); return { snapshot: status() };
  }
  function dispatch(payload) {
    sync(); if (closed || !store || !policy || !scheduler) throw new Error('Schedule storage unavailable.');
    canonicalJSON(payload); const shape = schedulingShapes[payload.operation]; if (!shape) throw new Error('Schedule operation unavailable.');
    record(payload, ['operation', ...shape[0]], shape[1]);
    if (payload.operation === 'chat') {
      const action = schedulingCommand(payload.text); if (!action) return { snapshot: status(), message: 'Ask to show scheduling, enable scheduled checks, check every 30 minutes, schedule weekdays at 09:00 in America/Chicago, apply this schedule or Run Now.' };
      if (action.scope) { dispatch({ operation: 'view', scope: action.scope }); delete action.scope; }
      return dispatch(action);
    }
    if (payload.operation === 'view') {
      const next = payload.scope ?? scope; if (!['global', 'repository'].includes(next) || next === 'repository' && !selected) throw new Error('Select a repository for its schedule.');
      if (next !== scope) { invalidate(); scope = next; conversation = randomUUID(); applied = null; }
      const values = policy.worker.read(target()).values, check = selected && scheduler.status(selected);
      message = 'Schedule for ' + (scope === 'global' ? 'all repositories' : store.workspaces().find(value => value.id === selected).name) + ': ' + (values['scheduling.enabled'].value ? 'on' : 'off') + '. '
        + (values['scheduling.mode'].value === 'interval' ? 'Check every ' + values['scheduling.intervalMinutes'].value + ' minutes.' : 'Calendar time ' + values['scheduling.calendar'].value?.time + ' in ' + values['scheduling.timezone'].value + '.')
        + ' After completion: ' + (values['scheduling.afterCompletion'].value === 'immediate' ? 'check immediately.' : 'wait for the next check.')
        + (check?.nextAt ? ' Next check: ' + new Date(check.nextAt).toLocaleString() + '.' : ' No next check is scheduled.'); publish();
    } else if (payload.operation === 'prepare') return prepare(payload.changes);
    else if (payload.operation === 'inherit') { if (!selected || scope !== 'repository') throw new Error('Select a repository override.'); return prepare({}, scheduleKeys); }
    else if (payload.operation === 'cancel') { invalidate(); message = 'Schedule change cancelled.'; publish(); }
    else if (payload.operation === 'apply') {
      if (!preview) { if (applied && (!payload.hash || payload.hash === applied)) return { snapshot: status(), message: 'This exact schedule is already applied.' }; throw new Error('Review the schedule before applying.'); }
      const p = preview; if (payload.hash && payload.hash !== p.hash) throw new Error('Schedule preview changed.');
      policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId: conversation, target: target() });
      preview = null; applied = p.hash; observed = policy.worker.read(null).revision; message = 'Schedule applied. Future checks use this version. Background operation remains separately controlled.'; publish();
      void scheduler.sync().catch(() => { message = 'Schedule timing unavailable. Existing work remains preserved.'; publish(); });
    } else if (payload.operation === 'run-now') {
      if (!selected || scope !== 'repository') throw new Error('Select this repository before Run Now.');
      message = 'Checking Ready work and live authority. Only eligible work can start.'; publish();
      const repository = selected;
      void scheduler.check('manual', repository).then(() => { const result = scheduler.status(repository); if (selected !== repository) return;
        const outcomes = { 'no-ready-work': 'No Ready work. No model turn requested.', 'dependencies-or-pr': 'Ready work has open dependencies or an open PR. No model turn requested.', 'active-issue': 'An Issue is active. No new work started.', 'repository-reserved': 'Development holds this repository. Use its local controls.', 'host-capacity': 'Ready work is waiting for host worker capacity.',
          'development-unqualified': 'Choose a qualified Dev and permissions in Agents and Models.', 'readback-unavailable': 'Live access or complete readback unavailable. No work started.', 'preflight-blocked': 'Development preflight blocked the start. Inspect Development status.', 'recovery-required': 'A previous start needs verified recovery. No start repeated.', started: 'Development accepted the verified Ready Issue.' };
        message = outcomes[result?.reason] ?? 'Eligibility check finished. Inspect Scheduling for its current result.'; publish();
      }, () => { message = 'Schedule check unavailable. No uncertain start is repeated.'; publish(); });
      return { accepted: true, snapshot: status() };
    }
    return { snapshot: status() };
  }
  // Check progress changes the display, not the PM context identity. Scope/policy/preview edits advance revision.
  return Object.freeze({ status, dispatch, sync() { sync(); if (!closed) onChange(status()); }, close() { invalidate(); closed = true; } });
}
