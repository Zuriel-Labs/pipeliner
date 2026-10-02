import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJSON, record } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';
import { validateDraft, draftBody, checkReadyAction } from './model.mjs';
import { protectedLabel } from '../github/operations.mjs';
import * as github from './github.mjs';

const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const safeError = error => /^(http-\d{3}|graphql-(forbidden|insufficient-scopes|not-found|rejected|validation)|partial-access|connection-(unavailable|changed|denied)|account-changed|repository-unavailable|installation-access-required|field-conflict|readback-mismatch|metadata-invalid|protected-or-invalid-label|dependency-unavailable|draft-incomplete|ready-active|issue-(unavailable|state-incomplete|state-conflict|context-changed|busy|changed|uncertain|expired|authority-denied|policy-unavailable))$/.test(error?.message) ? error.message : 'issue-check-failed';
const frozen = draft => ['creating', 'uncertain', 'recovery-required'].includes(draft?.state);
const empty = () => ({ selected: null, draft: null });

// The host owns both entries. Only the registered PM frame receives dispatch; workers receive the run-bound agent entry.
export function createIssueManager({ store, policy, connections, api = github, now = Date.now, onChange = () => {}, initialRevision = 1 }) {
  let revision = initialRevision, selected = store?.selected() ?? null, conversation = randomUUID(), closed = false, finalStatus = null;
  const tasks = new Map(), catalogs = new Map(), details = new Map(), messages = new Map(), errors = new Map(), policyPreviews = new Map();
  for (const workspace of store?.workspaces() ?? []) {
    const context = store.issueContext(workspace.id);
    if (context?.draft?.state === 'creating') { context.draft.state = 'recovery-required'; store.saveIssueContext(workspace.id, context); }
  }
  const workspace = id => { const value = store?.workspaces().find(workspace => workspace.id === id); if (!value) throw new Error('issue-unavailable'); return value; };
  const context = id => store.issueContext(id) ?? empty();
  function sync() {
    const next = store?.selected() ?? null;
    if (next === selected) return;
    tasks.get(selected)?.controller.abort();
    const preview = policyPreviews.get(selected); if (preview) policy.control.invalidate(preview.inputId);
    policyPreviews.delete(selected); selected = next; conversation = randomUUID(); revision++;
  }
  function status() {
    if (finalStatus) return finalStatus;
    sync(); const current = selected ? context(selected) : empty(), target = selected ? workspace(selected) : null;
    let intake = null;
    if (target && policy) {
      const view = policy.worker.read(target.id);
      intake = { revision: view.revision, mode: view.values['intake.mode'], agentCreation: view.values['intake.agentCreation'] };
    }
    return { revision, workspaceId: selected, repositoryLabel: target?.name ?? null, storageAvailable: Boolean(store && policy), busy: tasks.has(selected),
      catalog: catalogs.get(selected) ?? null, detail: details.get(selected) ?? null, ...current, policy: intake, policyPreview: policyPreviews.get(selected) ?? null,
      message: messages.get(selected) ?? null, error: errors.get(selected) ?? null, options: target ? Object.fromEntries(Object.entries(target.project.fields).map(([role, field]) => [role, field.options])) : {}, question: target ? question(current, target) : null,
      pending: store?.pending('issue').filter(effect => effect.binding.repository === selected).map(({ job, step, state }) => ({ job, step, state })) ?? [] };
  }
  const publish = () => { revision++; if (!closed) onChange(status()); };
  const save = (id, value, message) => { store.saveIssueContext(id, value); if (message) messages.set(id, message); publish(); };
  function question(current, target) {
    const draft = current.draft;
    if (!draft || tasks.has(target.id) || ['complete', 'cancelled'].includes(draft.state) || frozen(draft)) return null;
    for (const [field, text] of [['title', 'What should this Issue be called?'], ['summary', 'What outcome do you want?'], ['acceptance', 'What must work when this Issue is done? Enter one acceptance criterion per line.'], ['priority', 'Choose the priority.'], ['impact', 'Choose the impact.'], ['effort', 'Choose the effort.']]) {
      if (!draft.values[field] || Array.isArray(draft.values[field]) && !draft.values[field].length) return { field, text,
        choices: target.project.fields[field[0].toUpperCase() + field.slice(1)]?.options.map(option => ({ label: option.name, operation: 'choose', field, value: option.name })) ?? [] };
    }
    return draft.state === 'preview' ? { text: 'Review the exact Issue and metadata below, then say “Create this Issue” or cancel.', choices: [{ label: 'Review Issue', operation: 'show' }, { label: 'Create this Issue', operation: 'create', hash: draft.preview.hash }] }
      : { text: 'Your Issue choices are saved. Review the exact draft before creation.', choices: [{ label: 'Review Issue', operation: 'prepare' }] };
  }
  function ready() { sync(); if (closed || !store || !policy || !selected) throw new Error('issue-policy-unavailable'); return workspace(selected); }
  function agentAuthority(binding, target, creating = true) {
    canonicalJSON(binding); record(binding, ['runId', 'epoch']);
    const run = policy.runtime.status(target.id);
    if (!run || run.id !== binding.runId || run.epoch !== binding.epoch || run.control !== 'running' || run.releasedAt !== null) throw new Error('issue-authority-denied');
    const authority = policy.worker.authority(target.id, run.policyRevision);
    if (authority.dev !== run.dev || creating && (authority.intake.mode !== 'agent' || !authority.intake.agentCreation
      || !['github.issue.write', 'github.project.write'].every(capability => authority.capabilities.includes(capability)) || !authority.connections.includes('github'))
      || !creating && !['coauthored', 'agent'].includes(authority.intake.mode)) throw new Error('issue-authority-denied');
    return run;
  }
  function operate(target, fn, affectsDraft = false) {
    if (tasks.has(target.id)) throw new Error('issue-busy');
    const active = { controller: new AbortController() }; tasks.set(target.id, active); errors.delete(target.id); publish();
    active.done = Promise.resolve().then(() => fn(active.controller.signal)).catch(error => {
      const current = context(target.id), draft = current.draft;
      if (affectsDraft && draft && !['complete', 'cancelled'].includes(draft.state)) {
        const effects = store.effects(draft.id), uncertain = effects.some(effect => ['dispatched', 'uncertain'].includes(effect.state));
        save(target.id, { ...current, draft: { ...draft, state: uncertain ? 'uncertain' : effects.some(effect => effect.state === 'verified') ? 'recovery-required' : 'failed', error: safeError(error) } });
      }
      messages.set(target.id, active.controller.signal.aborted ? 'This operation stopped because its repository or app context changed. Any sent result needs readback before continuation.' : 'The Issue check could not finish. Existing Issues and any recorded results are preserved.');
      errors.set(target.id, safeError(error));
      if (error.message === 'ready-active') messages.set(target.id, 'Ready cannot be removed while this Issue is In Progress, In Review or Pending Review.');
    }).finally(() => { if (tasks.get(target.id) === active) { tasks.delete(target.id); publish(); } });
    return { accepted: true, snapshot: status() };
  }
  async function leases(target, signal) {
    const app = await connections.acquire('github', signal); let project = app;
    try { if (target.connections.setup) project = await connections.acquire(target.connections.setup, signal); return { app, project }; }
    catch (error) { app.close(); throw error; }
  }
  const closeLeases = held => { held.app.close(); if (held.project !== held.app) held.project.close(); };
  function check(held, signal, target, binding) {
    signal.throwIfAborted(); held.app.check(); held.project.check();
    if (closed) throw new Error('issue-context-changed');
    if (binding) agentAuthority(binding, target);
  }
  async function catalog(target, held, signal, own = null, creating = null) {
    const value = await api.readCatalog(held.app, held.project, target); check(held, signal, target);
    if (value.complete !== true || value.repositoryId !== target.repositoryId || value.projectId !== target.project.id || !Array.isArray(value.issues) || !Array.isArray(value.active) || value.active.length > 1) throw new Error('issue-state-incomplete');
    if (value.issues.some(issue => issue.itemId && !issue.status && issue.id !== creating)) throw new Error('issue-state-incomplete');
    const run = policy.runtime.status(target.id);
    if (run && (value.active.length !== 1 || value.active[0].number !== run.issue)) throw new Error('issue-state-conflict');
    const drift = [];
    for (const issue of value.issues) if (store.observeReady(target.id, issue.id, issue.ready, now(), issue.id === own).drift) drift.push(issue.number);
    value.drift = drift; value.observedAt = now(); catalogs.set(target.id, value);
    if (drift.length) messages.set(target.id, 'Ready changed outside Pipeliner for ' + drift.map(number => '#' + number).join(', ') + '. Current labels are shown; active work keeps its claim.');
    return { ...value, localRun: run };
  }
  async function refresh(target, signal, number) {
    const held = await leases(target, signal);
    try {
      const value = await catalog(target, held, signal), current = context(target.id);
      const chosen = number ?? current.selected;
      if (chosen !== null && chosen !== undefined) {
        if (!value.issues.some(issue => issue.number === chosen)) throw new Error('issue-unavailable');
        const detail = await api.readDetail(held.app, target, chosen); check(held, signal, target); details.set(target.id, detail);
        save(target.id, { ...current, selected: chosen });
      }
      if (!value.drift.length) messages.set(target.id, 'Issue state and the selected Project were read back from GitHub.'); publish();
    } finally { closeLeases(held); }
  }
  function choose(target, field, value) {
    const current = context(target.id), draft = current.draft;
    if (!draft || tasks.has(target.id) || frozen(draft) || ['complete', 'cancelled'].includes(draft.state)) throw new Error('issue-busy');
    if (!['title', 'summary', 'acceptance', 'priority', 'impact', 'effort', 'labels', 'dependencies'].includes(field)) throw new Error('draft-incomplete');
    canonicalJSON(value);
    if (['acceptance', 'labels', 'dependencies'].includes(field) ? !Array.isArray(value) : typeof value !== 'string' || !value.trim()
      || value.length > (field === 'summary' ? 4000 : field === 'title' ? 256 : 10) || containsSecret(value) || /[\p{Cc}\p{Cf}]/u.test(value.replaceAll('\n', ''))) throw new Error('draft-incomplete');
    if (Array.isArray(value) && (value.length > 50 || value.some(item => typeof item === 'string' ? item.length > 1000 || containsSecret(item) : !Number.isSafeInteger(item) || item < 1))) throw new Error('draft-incomplete');
    save(target.id, { ...current, draft: { ...draft, values: { ...draft.values, [field]: value }, state: 'choosing', preview: null, error: null } }, 'Issue choices saved. Review the draft before creation.');
    return { snapshot: status() };
  }
  async function prepare(target, signal, binding) {
    const current = context(target.id), draft = current.draft;
    const effects = draft ? store.effects(draft.id) : [];
    const resumable = draft?.state === 'recovery-required' && effects.some(effect => effect.step === 'create' && effect.state === 'verified') && effects.every(effect => effect.state === 'verified');
    if (!draft || frozen(draft) && !resumable) throw new Error('issue-busy');
    const held = await leases(target, signal);
    try {
      const live = await catalog(target, held, signal, null, resumable ? effects.find(effect => effect.step === 'create').result.id : null), values = validateDraft(draft.values, target, live);
      if (binding) agentAuthority(binding, target);
      const preview = { repository: target.id, repositoryId: target.repositoryId, projectId: target.project.id, values, body: draftBody(values, target),
        policyRevision: policy.worker.read(target.id).revision, appEpoch: held.app.epoch, projectEpoch: held.project.epoch,
        appAccount: held.app.value.account, projectAccount: held.project.value.account, expiresAt: now() + 900000 };
      preview.hash = hash(preview); check(held, signal, target, binding);
      save(target.id, { ...current, draft: { ...draft, values, state: 'preview', preview, error: null } }, 'Exact Issue preview prepared for ' + target.name + '. Creation leaves it in Backlog, unassigned and not Ready.');
    } finally { closeLeases(held); }
  }
  async function effect(target, draft, step, binding, held, signal, agent, fn) {
    check(held, signal, target, agent);
    if (!agent && draft.preview.policyRevision !== undefined && policy.worker.read(target.id).revision !== draft.preview.policyRevision) throw new Error('issue-changed');
    const action = store.prepare(draft.id, step, { kind: 'issue', repository: target.id, target: target.slug, previewHash: draft.preview.hash, ...binding });
    if (action.state === 'verified') return action.result;
    if (action.state !== 'prepared' || !store.dispatch(action.id)) throw new Error('issue-uncertain');
    try { const result = await fn(value => store.checkpoint(action.id, value)); check(held, signal, target, agent); store.finish(action.id, 'verified', result); return result; }
    catch (error) { const known = store.effects(draft.id).find(effect => effect.id === action.id)?.result ?? null;
      store.finish(action.id, /^(http-(401|403|404|422)|graphql-(forbidden|insufficient-scopes|validation))$/.test(error.message) ? 'denied' : 'uncertain', known); throw error; }
  }
  function verifyCreated(issue, draft) {
    if (issue.title !== draft.values.title || issue.body !== draft.preview.body || issue.state !== 'OPEN' || issue.ready || issue.assignees.length
      || !isDeepStrictEqual([...issue.labels].sort(), [...draft.values.labels].sort())) throw new Error('readback-mismatch');
  }
  async function create(target, signal, repairing = false, agent = null) {
    const current = context(target.id), draft = current.draft, preview = draft?.preview;
    if (!preview || preview.repository !== target.id || hash(Object.fromEntries(Object.entries(preview).filter(([key]) => key !== 'hash'))) !== preview.hash) throw new Error('issue-changed');
    if (!repairing && preview.expiresAt < now()) throw new Error('issue-expired');
    if (policy.worker.read(target.id).revision !== preview.policyRevision) throw new Error('issue-changed');
    if (agent) agentAuthority(agent, target);
    if (!repairing && (connections.epoch('github') !== preview.appEpoch || connections.epoch(target.connections.setup ?? 'github') !== preview.projectEpoch)) throw new Error('issue-changed');
    if (store.effects(draft.id).some(effect => ['dispatched', 'uncertain', 'denied'].includes(effect.state))) throw new Error('issue-uncertain');
    const held = await leases(target, signal);
    try {
      if (!isDeepStrictEqual(held.app.value.account, preview.appAccount) || !isDeepStrictEqual(held.project.value.account, preview.projectAccount)) throw new Error('account-changed');
      save(target.id, { ...current, draft: { ...draft, state: 'creating', error: null } }, 'Creating only this Issue and its selected Project metadata.');
      const known = store.effects(draft.id).find(effect => effect.step === 'create');
      let live = await catalog(target, held, signal, null, known?.state === 'verified' ? known.result.id : null); validateDraft(draft.values, target, live);
      const created = known?.state === 'verified' ? await api.readIssue(held.app, target, known.result.number)
        : await effect(target, draft, 'create', { origin: agent ? 'agent' : 'pm', run: agent, values: draft.values, bodyHash: hash(preview.body) }, held, signal, agent,
          checkpoint => api.createIssue(held.app, target, draft.values, preview.body, checkpoint));
      verifyCreated(created, draft); check(held, signal, target, agent);
      live = await catalog(target, held, signal, null, created.id);
      let item = live.issues.find(issue => issue.id === created.id)?.itemId;
      if (!item) item = (await effect(target, draft, 'project', { issue: created.id, project: target.project.id }, held, signal, agent, () => api.addItem(held.project, target, created))).id;
      for (const [role, name] of [['Status', 'Backlog'], ['Priority', draft.values.priority], ['Impact', draft.values.impact], ['Effort', draft.values.effort]]) {
        live = await catalog(target, held, signal, null, created.id); const actual = live.issues.find(issue => issue.id === created.id);
        verifyCreated(actual, draft);
        if (actual.itemId !== item || actual.status && actual.status !== 'Backlog') throw new Error('issue-changed');
        if (actual.metadata[role] !== name) await effect(target, draft, 'field-' + role, { issue: created.id, item, role, name }, held, signal, agent, () => api.setField(held.project, target, item, role, name));
      }
      for (const number of draft.values.dependencies) {
        live = await catalog(target, held, signal); const actual = live.issues.find(issue => issue.id === created.id); verifyCreated(actual, draft);
        if (actual.status !== 'Backlog') throw new Error('issue-changed');
        const dependency = live.issues.find(issue => issue.number === number); if (!dependency || dependency.id === created.id) throw new Error('dependency-unavailable');
        const knownDependencies = await api.readDependencies(held.app, target, created.number); check(held, signal, target, agent);
        if (!knownDependencies.some(issue => issue.id === dependency.id)) await effect(target, draft, 'dependency-' + number, { issue: created.id, dependency: dependency.id }, held, signal, agent, () => api.addDependency(held.app, target, created, dependency));
      }
      live = await catalog(target, held, signal); const actual = live.issues.find(issue => issue.id === created.id); verifyCreated(actual, draft);
      if (actual.itemId !== item || ['Status', 'Priority', 'Impact', 'Effort'].some(role => actual.metadata[role] !== ({ Status: 'Backlog', Priority: draft.values.priority, Impact: draft.values.impact, Effort: draft.values.effort })[role])) throw new Error('readback-mismatch');
      const detail = await api.readDetail(held.app, target, created.number); check(held, signal, target, agent);
      if (!isDeepStrictEqual(detail.dependencies.map(issue => issue.number).sort((a, b) => a - b), [...draft.values.dependencies].sort((a, b) => a - b))) throw new Error('readback-mismatch');
      details.set(target.id, detail); save(target.id, { ...context(target.id), selected: created.number, draft: { ...draft, state: 'complete', result: { id: created.id, number: created.number }, error: null } }, 'Issue #' + created.number + ' created and read back: Backlog, unassigned, not Ready. No Dev was started.');
    } finally { closeLeases(held); }
  }
  async function changeReady(target, signal, number, enabled) {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(number) || number < 1 || store.pending('issue').some(effect => effect.binding.repository === target.id)) throw new Error('issue-uncertain');
    const held = await leases(target, signal), job = randomUUID();
    try {
      let live = await catalog(target, held, signal), issue = live.issues.find(issue => issue.number === number); if (!issue) throw new Error('issue-unavailable');
      checkReadyAction({ ...live, issue }, target, enabled);
      const draft = { id: job, preview: { hash: hash({ target: target.id, issue: issue.id, enabled }) } };
      if (enabled && !live.labels.includes(protectedLabel)) await effect(target, draft, 'ready-label', { issue: issue.id, enabled }, held, signal, null, () => api.ensureReadyLabel(held.app, target));
      live = await catalog(target, held, signal); issue = live.issues.find(value => value.id === issue.id); checkReadyAction({ ...live, issue }, target, enabled);
      if (issue.ready !== enabled) await effect(target, draft, 'ready', { issue: issue.id, number, enabled }, held, signal, null, () => api.setReady(held.app, target, issue, enabled));
      const final = await catalog(target, held, signal, issue.id), actual = final.issues.find(value => value.id === issue.id); checkReadyAction({ ...final, issue: actual }, target, enabled);
      if (actual.ready !== enabled) throw new Error('readback-mismatch');
      if (context(target.id).selected === number) { const detail = await api.readDetail(held.app, target, number); check(held, signal, target); details.set(target.id, detail); }
      messages.set(target.id, 'Issue #' + number + ': Ready ' + (enabled ? 'added' : 'removed') + ' and read back from GitHub.'); publish();
    } finally { closeLeases(held); }
  }
  async function repair(target, signal) {
    const held = await leases(target, signal);
    try {
      const draft = context(target.id).draft;
      const created = draft && store.effects(draft.id).find(action => action.step === 'create' && action.state === 'verified');
      const live = await catalog(target, held, signal, null, created?.result.id);
      for (const action of store.pending('issue').filter(effect => effect.binding.repository === target.id)) {
        const binding = action.binding; let result;
        if (action.step === 'create') {
          if (!action.result?.number || action.job !== draft?.id) throw new Error('issue-uncertain');
          const actual = await api.readIssue(held.app, target, action.result.number); verifyCreated(actual, draft);
          if (actual.id !== action.result.id) throw new Error('readback-mismatch'); result = actual;
        } else {
          const issue = live.issues.find(issue => issue.id === binding.issue);
          if (action.step === 'ready-label') { if (!live.labels.includes(protectedLabel)) throw new Error('issue-uncertain'); result = { name: protectedLabel }; }
          else if (!issue) throw new Error('issue-uncertain');
          else if (action.step === 'project' && issue.itemId) result = { id: issue.itemId };
          else if (action.step.startsWith('field-') && issue.itemId === binding.item && issue.metadata[binding.role] === binding.name) result = { itemId: binding.item, role: binding.role, name: binding.name };
          else if (action.step.startsWith('dependency-')) {
            const dependency = (await api.readDependencies(held.app, target, issue.number)).find(value => value.id === binding.dependency);
            if (dependency) result = { id: dependency.id, number: dependency.number };
          } else if (action.step === 'ready' && issue.ready === binding.enabled) { checkReadyAction({ ...live, issue }, target, binding.enabled); result = { number: issue.number, ready: binding.enabled }; }
          if (!result) throw new Error('issue-uncertain');
        }
        check(held, signal, target); store.finish(action.id, 'verified', result);
      }
    } finally { closeLeases(held); }
    const draft = context(target.id).draft;
    if (draft && ['uncertain', 'recovery-required'].includes(draft.state) && draft.preview) await create(target, signal, true);
    else { messages.set(target.id, 'Recorded Issue effects were checked against GitHub. Nothing was replayed.'); publish(); }
  }
  function dispatch(payload) {
    const target = ready(), current = context(target.id); canonicalJSON(payload);
    if (payload.operation === 'refresh' || payload.operation === 'select') return operate(target, signal => refresh(target, signal, payload.number));
    if (payload.operation === 'begin') {
      if (tasks.has(target.id) || frozen(current.draft) || store.pending('issue').some(effect => effect.binding.repository === target.id)) throw new Error('issue-busy');
      save(target.id, { ...current, draft: { id: randomUUID(), state: 'choosing', values: { labels: [], dependencies: [] } } }, 'Drafting an Issue for ' + target.name + '. Resolve the remaining choices in chat or Issues.');
      for (const [field, value] of Object.entries(payload.values ?? {})) choose(target, field, value); return { snapshot: status() };
    }
    if (payload.operation === 'choose') return choose(target, payload.field, payload.value);
    if (payload.operation === 'answer') {
      if (typeof payload.text !== 'string' || containsSecret(payload.text)) throw new Error('draft-incomplete');
      const field = question(current, target)?.field; if (!field) return { message: 'Review the exact Issue preview, create it, or cancel.' };
      return choose(target, field, field === 'acceptance' ? payload.text.split('\n').map(value => value.trim()).filter(Boolean) : payload.text.trim());
    }
    if (payload.operation === 'prepare') return operate(target, signal => prepare(target, signal), true);
    if (payload.operation === 'create') {
      if (current.draft?.state === 'complete') return { snapshot: status() };
      if (current.draft?.state !== 'preview' || payload.hash && payload.hash !== current.draft.preview.hash) throw new Error('issue-changed');
      return operate(target, signal => create(target, signal), true);
    }
    if (payload.operation === 'repair') return operate(target, signal => repair(target, signal), true);
    if (payload.operation === 'ready') return operate(target, signal => changeReady(target, signal, payload.number, payload.enabled));
    if (payload.operation === 'cancel') {
      tasks.get(target.id)?.controller.abort(); const effects = current.draft ? store.effects(current.draft.id) : [];
      if (current.draft) save(target.id, { ...current, draft: { ...current.draft, state: effects.some(effect => ['dispatched', 'uncertain'].includes(effect.state)) ? 'uncertain' : effects.some(effect => effect.state === 'verified') ? 'recovery-required' : 'cancelled' } }, 'Issue drafting stopped. Existing and sent results remain preserved.');
      return { snapshot: status() };
    }
    if (payload.operation === 'policy-prepare') {
      if (tasks.has(target.id)) throw new Error('issue-busy');
      const old = policyPreviews.get(target.id); if (old) policy.control.invalidate(old.inputId);
      const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: target.id, text: 'Set Issue authoring to ' + payload.mode + '; agent creation ' + payload.agentCreation });
      const preview = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope: 'repository', target: target.id, changes: { 'intake.mode': payload.mode, 'intake.agentCreation': payload.agentCreation }, reset: [] });
      policyPreviews.set(target.id, preview); publish(); return { snapshot: status() };
    }
    if (payload.operation === 'policy-apply') {
      const preview = policyPreviews.get(target.id); if (!preview || payload.hash !== preview.hash) throw new Error('issue-changed');
      policy.control.apply({ commandId: randomUUID(), proposalId: preview.id, hash: preview.hash, inputId: preview.inputId, conversationId: conversation, target: target.id });
      policyPreviews.delete(target.id); messages.set(target.id, 'Issue authoring policy applied for this repository. New runs capture the choice; revoked creation authority stays revoked for older runs.'); publish(); return { snapshot: status() };
    }
    if (payload.operation === 'policy-cancel') {
      const preview = policyPreviews.get(target.id); if (preview) policy.control.invalidate(preview.inputId);
      policyPreviews.delete(target.id); publish(); return { snapshot: status(), message: 'Issue authoring change cancelled.' };
    }
    throw new Error('issue-unavailable');
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); }, async idle() { await Promise.allSettled([...tasks.values()].map(task => task.done)); },
    agent: Object.freeze({
      propose(binding, targetId, values) {
        const target = workspace(targetId); agentAuthority(binding, target, false);
        if (tasks.has(target.id) || frozen(context(target.id).draft)) throw new Error('issue-busy');
        validateDraft(values, target, catalogs.get(target.id) ?? { labels: [], issues: [] });
        save(target.id, { ...context(target.id), draft: { id: randomUUID(), state: 'choosing', values } }, 'Agent-authored draft proposed. It cannot change policy or Ready.'); return { proposed: true };
      },
      create(binding, targetId, values) {
        const target = workspace(targetId); agentAuthority(binding, target);
        if (tasks.has(target.id) || frozen(context(target.id).draft) || store.pending('issue').some(effect => effect.binding.repository === target.id)) throw new Error('issue-busy');
        record(values, ['title', 'summary', 'acceptance', 'priority', 'impact', 'effort'], ['labels', 'dependencies']);
        if (containsSecret(canonicalJSON(values))) throw new Error('draft-incomplete');
        save(target.id, { ...context(target.id), draft: { id: randomUUID(), state: 'choosing', values } });
        return operate(target, async signal => { await prepare(target, signal, binding); await create(target, signal, false, binding); }, true);
      },
    }),
    async close() { closed = true; for (const task of tasks.values()) task.controller.abort(); await Promise.allSettled([...tasks.values()].map(task => task.done)); finalStatus = status(); },
  });
}
