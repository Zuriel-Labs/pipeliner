import { canonicalJSON } from '../core/settings.mjs';
import * as github from '../issues/github.mjs';
import { scheduleConfig, checkScheduleState, selectReadyWork } from './model.mjs';
import { conditionalReads } from './read-cache.mjs';

// One host queue serializes eligibility and start dispatch; Development owns actual execution.
export function createScheduler({ store, policy, development, connections, nextCalendar, api = github, clock = Date.now,
  onChange = () => {}, timers = { set: setTimeout, clear: clearTimeout } }) {
  let pending = null, timer, closed = false, suspended = false, checking;
  const controller = new AbortController();
  const caches = new Map();
  const cached = lease => {
    const epoch = connections.epoch?.(lease.id), key = lease.id;
    if (key && epoch !== undefined) { let entry = caches.get(key); if (!entry || entry.epoch !== epoch) { entry = { epoch, send: conditionalReads(lease.send ?? fetch) }; caches.set(key, entry); } return { ...lease, send: entry.send }; }
    return lease;
  };
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new Error('Schedule clock invalid'); return value; };
  const state = repository => { const value = store.schedule(repository); return value && checkScheduleState(value); };
  const save = (repository, value) => { store.saveSchedule(repository, checkScheduleState(value)); onChange(); };
  async function next(config, after) {
    if (!config['scheduling.enabled']) return null;
    if (config['scheduling.mode'] === 'calendar') return nextCalendar({ ...config['scheduling.calendar'], timezone: config['scheduling.timezone'] }, after, controller.signal);
    return after + config['scheduling.intervalMinutes'] * 60000;
  }
  async function refresh() {
    for (const workspace of store.workspaces()) {
      controller.signal.throwIfAborted();
      const config = scheduleConfig(policy.worker.read(workspace.id)), old = state(workspace.id);
      if (!old || canonicalJSON(old.config) !== canonicalJSON(config)) save(workspace.id, { schemaVersion: 1, config, nextAt: await next(config, now()),
        lastAt: old?.lastAt ?? null, reason: old?.pending ? 'recovery-required' : config['scheduling.enabled'] ? 'waiting' : 'disabled', catchUp: false, eligible: null, pending: old?.pending ?? null });
    }
  }
  async function arm() {
    timers.clear(timer); timer = undefined; if (closed || suspended) return;
    const due = store.workspaces().map(workspace => state(workspace.id)?.nextAt).filter(value => value !== null && value !== undefined);
    if (!due.length) return;
    timer = timers.set(() => { void check('timer').catch(() => {}); }, Math.max(1, Math.min(2147483647, Math.min(...due) - now()))); timer?.unref?.();
  }
  async function inspect(workspace, view, old, reason) {
    const signal = AbortSignal.any([controller.signal, checking.signal]);
    const timestamp = Math.max(now(), old.lastAt ?? 0), config = scheduleConfig(view), incomplete = old.pending;
    const current = { ...old, config, lastAt: timestamp, nextAt: await next(config, timestamp), catchUp: ['startup', 'wake'].includes(reason), reason: 'checking', pending: incomplete ?? { kind: 'check' } };
    save(workspace.id, current);
    let app, project;
    try {
      const availability = development.availability(workspace.id);
      if (availability.run || availability.busy) { current.reason = 'repository-reserved'; current.eligible = null; current.pending = incomplete?.kind === 'start' && !(availability.run?.issue === incomplete.number && availability.run?.policyHash === incomplete.policyHash) ? incomplete : null; return null; }
      app = await connections.acquire('github', signal); project = workspace.connections.setup ? await connections.acquire(workspace.connections.setup, signal) : app;
      const retry = { attempts: view.values['limits.transientAttempts'].value, deadlineAt: now() + Math.min(300, view.values['limits.controlSeconds'].value) * 1000 };
      const boundedApp = { ...cached(app), retry }, boundedProject = project === app ? boundedApp : { ...cached(project), retry };
      const catalog = await api.readCatalog(boundedApp, boundedProject, workspace); signal.throwIfAborted();
      // A previously dispatched start is never repeated, even if its current remote outcome is ambiguous.
      if (incomplete?.kind === 'start') { current.reason = 'recovery-required'; return null; }
      const selected = await selectReadyWork(catalog, workspace, api, boundedApp); signal.throwIfAborted();
      if (!selected.issue) { current.reason = selected.reason; current.eligible = null; return null; }
      current.eligible = { number: selected.issue.number, priority: selected.priority, at: old.eligible?.number === selected.issue.number ? old.eligible.at : timestamp };
      if (reason !== 'manual' && view.values['intake.trigger'].value !== 'schedule') { current.reason = 'pm-trigger'; return null; }
      if (!availability.qualified) { current.reason = 'development-unqualified'; return null; }
      current.reason = 'eligible'; return { workspace, issue: selected.issue, view, current, automatic: reason !== 'manual' };
    } catch { current.reason = 'readback-unavailable'; current.eligible = null; return null; }
    finally { if (app) app.close(); if (project && project !== app) project.close(); if (current.pending?.kind !== 'start') current.pending = null; save(workspace.id, current); }
  }
  async function perform(reason, repository) {
    await refresh(); const candidates = [];
    for (const workspace of store.workspaces()) {
      checking.signal.throwIfAborted(); controller.signal.throwIfAborted(); const old = state(workspace.id), view = policy.worker.read(workspace.id);
      if (repository && workspace.id !== repository || reason !== 'manual' && !old.config['scheduling.enabled']
        || reason === 'timer' && (old.nextAt === null || old.nextAt > now())) continue;
      const candidate = await inspect(workspace, view, old, reason); if (candidate) candidates.push(candidate);
    }
    candidates.sort((a, b) => a.current.eligible.at - b.current.eligible.at || a.current.eligible.priority - b.current.eligible.priority || a.issue.number - b.issue.number || a.workspace.id.localeCompare(b.workspace.id));
    for (const candidate of candidates) {
      checking.signal.throwIfAborted(); controller.signal.throwIfAborted(); const { workspace, issue, view, current, automatic } = candidate;
      const occupied = store.workspaces().filter(value => { const state = development.availability(value.id); return state.run && !['paused', 'stopped'].includes(state.run.control) || state.busy; }).length;
      if (occupied >= policy.worker.read(workspace.id).values['limits.concurrency'].value) { current.reason = 'host-capacity'; save(workspace.id, current); continue; }
      if (policy.worker.read(workspace.id).hash !== view.hash) { current.reason = 'policy-changed'; save(workspace.id, current); continue; }
      current.pending = { kind: 'start', number: issue.number, policyHash: view.hash }; save(workspace.id, current);
      try {
        const result = await development.startScheduled(workspace.id, issue.number, view.hash, automatic, AbortSignal.any([controller.signal, checking.signal]));
        if (result?.accepted !== true) throw new Error('Schedule start unverified');
        current.reason = 'started'; current.pending = null; current.eligible = null;
      } catch (error) { current.reason = error.safeToRecheck === true ? 'preflight-blocked' : 'recovery-required'; if (error.safeToRecheck === true) current.pending = null; } // Uncertain dispatch keeps its durable intent.
      save(workspace.id, current);
    }
  }
  function check(reason, repository) {
    if (closed || suspended) return Promise.resolve();
    if (!['startup', 'wake', 'timer', 'manual', 'completion'].includes(reason) || repository && !store.workspaces().some(value => value.id === repository)) throw new Error('Schedule trigger unavailable');
    if (pending) return pending;
    checking = new AbortController();
    pending = perform(reason, repository).finally(async () => { pending = null; await arm(); }); return pending;
  }
  return Object.freeze({ check, busy: () => Boolean(pending), status: repository => state(repository),
    async sync() { if (closed) return; if (pending) await pending; if (closed) return; await refresh(); await arm(); },
    async completed(repository) { const config = scheduleConfig(policy.worker.read(repository)); if (config['scheduling.enabled'] && config['scheduling.afterCompletion'] === 'immediate' && policy.worker.read(repository).values['intake.trigger'].value === 'schedule') await check('completion', repository); },
    suspend() { suspended = true; timers.clear(timer); checking?.abort(); },
    async wake() { if (pending) await pending.catch(() => {}); suspended = false; await check('wake'); },
    async close() { closed = true; timers.clear(timer); controller.abort(); if (pending) await pending.catch(() => {}); caches.clear(); } });
}
