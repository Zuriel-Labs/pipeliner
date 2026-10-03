import { canonicalJSON, record, validateValue } from '../core/settings.mjs';

export const scheduleKeys = ['scheduling.enabled', 'scheduling.mode', 'scheduling.intervalMinutes', 'scheduling.calendar', 'scheduling.timezone', 'scheduling.afterCompletion'];
export const scheduleConfig = view => Object.fromEntries(scheduleKeys.map(key => [key, view.values[key].value]));
export function validateCalendar(config, after) {
  record(config, ['days', 'time', 'timezone']); validateValue('scheduling.calendar', { days: config.days, time: config.time }); validateValue('scheduling.timezone', config.timezone);
  if (!config.timezone || !Number.isSafeInteger(after) || after < 0 || after > 253401523200000) throw new Error('Calendar input unavailable');
}
export function checkScheduleState(state) {
  canonicalJSON(state); record(state, ['schemaVersion', 'config', 'nextAt', 'lastAt', 'reason', 'catchUp', 'eligible', 'pending']);
  if (state.schemaVersion !== 1 || ![state.nextAt, state.lastAt].every(value => value === null || Number.isSafeInteger(value) && value >= 0)
    || typeof state.catchUp !== 'boolean' || typeof state.reason !== 'string' || state.reason.length > 100) throw new Error('Schedule state invalid');
  if (state.eligible) { record(state.eligible, ['number', 'at', 'priority']); if (!Number.isSafeInteger(state.eligible.number) || state.eligible.number < 1 || !Number.isSafeInteger(state.eligible.at) || state.eligible.at < 0 || !Number.isSafeInteger(state.eligible.priority) || state.eligible.priority < 0) throw new Error('Schedule eligibility invalid'); }
  if (state.pending) { record(state.pending, ['kind'], ['number', 'policyHash']); if (!['check', 'start'].includes(state.pending.kind) || state.pending.kind === 'start' && (!Number.isSafeInteger(state.pending.number) || state.pending.number < 1 || !/^[a-f0-9]{64}$/.test(state.pending.policyHash))) throw new Error('Schedule pending state invalid'); }
  return state;
}
export async function selectReadyWork(catalog, workspace, api, lease) {
  if (catalog?.complete !== true || !Array.isArray(catalog.active) || !Array.isArray(catalog.issues)) throw new Error('Schedule catalog incomplete');
  if (catalog.active.length) return { reason: 'active-issue' };
  const priorities = workspace.project.fields.Priority.options.map(option => option.name);
  const ready = catalog.issues.filter(issue => issue.state === 'OPEN' && issue.status === 'Backlog' && issue.ready && issue.itemId
    && ['Priority', 'Impact', 'Effort'].every(role => issue.metadata?.[role]) && priorities.includes(issue.metadata.Priority));
  ready.sort((a, b) => priorities.indexOf(a.metadata.Priority) - priorities.indexOf(b.metadata.Priority) || a.number - b.number);
  for (const issue of ready) {
    const detail = await api.readDetail(lease, workspace, issue.number);
    if (detail.id !== issue.id || detail.state !== 'OPEN' || !detail.ready || !Array.isArray(detail.dependencies) || !Array.isArray(detail.pullRequests)) throw new Error('Schedule detail changed or incomplete');
    if (detail.dependencies.some(value => value.state !== 'CLOSED') || detail.pullRequests.some(value => value.state === 'OPEN')) continue;
    return { issue, priority: priorities.indexOf(issue.metadata.Priority), reason: 'ready' };
  }
  return { reason: ready.length ? 'dependencies-or-pr' : 'no-ready-work' };
}
