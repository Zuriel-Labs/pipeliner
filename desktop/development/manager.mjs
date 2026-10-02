import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { inspectWorkspace, workspaceData } from '../core/identity.mjs';
import { validateProfile } from '../../scripts/lib/config.mjs';
import { githubRequest } from '../repositories/github.mjs';
import * as github from '../issues/github.mjs';
import { snapshotWorkspace } from './source.mjs';
import { developmentWorkerProgram } from './worker-tools.mjs';
import { starterSkills, starterHash } from './starter.mjs';
import { createDevelopmentEngine } from './engine.mjs';
import { publishDevelopmentCandidate } from './github.mjs';
import { developmentShapes, developmentCommand } from './commands.mjs';
import { developmentIssueHash } from './state.mjs';
export { developmentShapes, developmentCommand } from './commands.mjs';

export const developmentPermissions = Object.freeze(['workspace.read', 'workspace.write', 'worker.exec', 'provider.turn', 'github.read', 'github.issue.write', 'github.project.write', 'git.push', 'github.pr.write']);
const safeError = error => typeof error?.message === 'string' && error.message.length < 240 && /^(Development |Captured Development |Current candidate |Research specification |Hard provider metric |Repository checks |http-\d{3}$|connection-(changed|unavailable)$|capability-unverified$)/.test(error.message)
  ? error.message : 'Development could not continue safely. Work and recorded results remain preserved.';

export function executionProfile(source, workspace) {
  const file = source.find(file => file.path === 'pipeliner.config.json');
  if (!file) throw new Error('Development needs a repository check profile; guided setup must supply it before execution.');
  let profile;
  try { profile = validateProfile(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(file.content, 'base64')))); }
  catch { throw new Error('Development repository profile could not be validated.'); }
  if ((profile.repository.owner + '/' + profile.repository.name).toLowerCase() !== workspace.slug || profile.project.number !== workspace.project.number
    || profile.project.owner.toLowerCase() !== workspace.project.owner.login.toLowerCase() || profile.quality.commands.length > 32) throw new Error('Development repository profile does not match its registered workspace.');
  return profile;
}

// The registered PM frame gets dispatch. Execution agents never receive this manager.
export function createDevelopmentManager({ store, policy, ledger, connections, supervisor, onChange = () => {}, initialRevision = 1 }) {
  let selected = store?.selected() ?? null, revision = initialRevision, conversation = randomUUID(), preview = null, closed = false, closing = false, lastSnapshot;
  const tasks = new Map(), controls = new Map(), messages = new Map(), errors = new Map();
  const workspace = id => { const value = store?.workspaces().find(value => value.id === id); if (!value) throw new Error('Development repository unavailable.'); return value; };
  const invalidate = () => { if (preview) policy.control.invalidate(preview.inputId); preview = null; };
  function sync() { const next = store?.selected() ?? null; if (next !== selected) { invalidate(); selected = next; conversation = randomUUID(); revision++; } }
  function status() {
    if (closed) return { ...lastSnapshot, storageAvailable: false, preview: null };
    sync(); const target = selected ? workspace(selected) : null, available = Boolean(store && policy && ledger);
    let run = null, execution = null, view = null, development = null, runDeveloper = null, stepLabel = null;
    if (available) {
      view = policy.worker.read(selected); run = selected ? policy.runtime.status(selected) : null;
      if (run) {
        try { development = ledger.status(run.id); const captured = ledger.captured(run.id); runDeveloper = captured.developer;
          stepLabel = captured.pipeline.steps.find(step => step.id === development.step)?.label ?? development.state;
        } catch { /* Reservation may precede its first ledger record. */ }
        execution = supervisor?.status(selected) ?? null;
      }
    }
    const publication = run ? store.effects(run.id).find(effect => effect.step === 'pull-request' && effect.state === 'verified')?.result ?? null : null;
    return lastSnapshot = { revision, workspaceId: selected, repositoryLabel: target?.name ?? null, storageAvailable: available,
      configuredDev: view?.values['agents.dev'] ?? null, developers: connections.developers(),
      permissions: view ? { host: view.values['permissions.ceiling'], repository: view.values['permissions.grants'], required: developmentPermissions } : null,
      skills: starterSkills.map(({ instructions: _instructions, ...skill }) => ({ ...skill, scope: selected, enabled: view?.values['skills.bundledEnabled'].value ?? false })),
      busy: tasks.has(selected) || controls.has(selected), run, runDeveloper, stepLabel, development, execution: execution ? { worker: execution.worker, pending: execution.pending, error: execution.error } : null,
      preview, publication, message: messages.get(selected) ?? null, error: errors.get(selected) ?? null,
      pending: store?.pending('development').filter(effect => effect.binding.repository === selected).map(({ step, state }) => ({ step, state })) ?? [],
      limitations: 'Execution uses the qualified Node/Git restricted worker on this Mac. Other toolchains, host-native execution, installers and other OS evidence remain pending.',
    };
  }
  const publish = () => { revision++; if (!closed) onChange(status()); };
  const ready = () => { sync(); if (closed || closing || !store || !policy || !ledger || !selected) throw new Error('Development needs a selected repository and protected storage.'); return workspace(selected); };
  function prepare(scope, changes) {
    const target = ready(); invalidate();
    const policyTarget = scope === 'repository' ? target.id : null;
    const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: policyTarget, text: 'Review ' + scope + ' Development configuration for ' + target.name });
    try { preview = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope, target: policyTarget, changes, reset: [] }); }
    catch (error) { policy.control.invalidate(input.id); throw error; }
    messages.set(target.id, 'Review the exact scope, provider destination and permission changes before applying. Existing active runs keep their captured policy.'); publish(); return { snapshot: status() };
  }
  async function acquire(target, signal) {
    const app = await connections.acquire('github', signal); let project = app;
    try { if (target.connections.setup) project = await connections.acquire(target.connections.setup, signal); return { app, project }; }
    catch (error) { app.close(); throw error; }
  }
  const release = held => { held.app.close(); if (held.project !== held.app) held.project.close(); };
  async function observe({ repository, issue }) {
    const target = workspace(repository), held = await acquire(target);
    try {
      const catalog = await github.readCatalog(held.app, held.project, target), current = catalog.issues.find(value => value.number === issue);
      if (!current) throw new Error('Development Issue unavailable.');
      return { repository, issue, status: current.status, state: current.state, active: catalog.active.map(({ number, status }) => ({ issue: number, status })), observedAt: Date.now() };
    } finally { release(held); }
  }
  function operate(target, fn) {
    if (closed || closing || tasks.has(target.id) || controls.has(target.id)) throw new Error('Development operation already pending.');
    const task = { controller: new AbortController() }; tasks.set(target.id, task); errors.delete(target.id); publish();
    task.done = Promise.resolve().then(() => fn(task.controller.signal)).catch(async error => {
      errors.set(target.id, safeError(error)); messages.set(target.id, task.controller.signal.aborted ? 'Development was interrupted. Verify local controls and any pending outcomes before resuming.' : safeError(error));
      const run = policy.runtime.status(target.id);
      if (run?.control === 'running' && supervisor) {
        try { supervisor.control({ runId: run.id, epoch: run.epoch }, 'pause'); await supervisor.settle(target.id); }
        catch { errors.set(target.id, 'Development local termination still needs verification.'); }
      }
    }).finally(() => { tasks.delete(target.id); publish(); });
    return { accepted: true, snapshot: status() };
  }
  function authority(target, run, signal) {
    signal?.throwIfAborted(); if (closed || closing) throw new Error('Development app is closing.');
    const current = policy.runtime.status(target.id), grant = policy.worker.authority(target.id, run.policyRevision);
    if (!current || current.id !== run.id || current.epoch !== run.epoch || current.control !== 'running' || grant.dev !== run.dev
      || developmentPermissions.some(permission => !grant.capabilities.includes(permission)) || !grant.connections.includes('github')) throw new Error('Development run authority unavailable or revoked.');
  }
  async function fieldEffect(target, held, job, issue, name, signal) {
    const intent = store.prepare(job, 'status-' + name.replaceAll(' ', '-'), { kind: 'development', repository: target.id, issue: issue.number, item: issue.itemId, status: name });
    if (intent.state === 'denied') throw new Error('Development status recovery is required.');
    signal.throwIfAborted();
    if (intent.state === 'prepared') {
      if (!store.dispatch(intent.id)) throw new Error('Development status dispatch changed.');
      try { await github.setField(held.project, target, issue.itemId, 'Status', name); }
      catch (error) { if (error.message !== 'write-result-uncertain') { store.finish(intent.id, 'uncertain', { error: 'status-needs-readback' }); throw error; } }
    }
    const catalog = await github.readCatalog(held.app, held.project, target), actual = catalog.issues.find(value => value.id === issue.id);
    if (!actual || actual.status !== name || actual.state !== 'OPEN' || actual.itemId !== issue.itemId || actual.ready !== issue.ready
      || ['Priority', 'Impact', 'Effort'].some(role => actual.metadata[role] !== issue.metadata[role]) || catalog.active.length !== 1 || catalog.active[0].id !== issue.id) throw new Error('Development active Issue readback changed.');
    if (intent.state !== 'verified') store.finish(intent.id, 'verified', { issue: actual.number, status: name, activeCount: 1 }); return actual;
  }
  async function execute(target, run, snapshot, profile, issue, signal) {
    authority(target, run, signal);
    const binding = { runId: run.id, epoch: run.epoch }, identity = inspectWorkspace(target.path, { repository: target.id, owner: target.slug.split('/')[0], name: target.slug.split('/')[1] });
    if (workspaceData(identity).localKey !== target.localKey) throw new Error('Development local workspace changed.');
    await supervisor.start(identity, binding, { candidate: snapshot.candidate, program: developmentWorkerProgram, allowedPath: 'development-result' });
    const engine = createDevelopmentEngine({ ledger, policy, supervisor, connections, onChange: publish });
    const state = await engine.run(binding, { issue: { number: issue.number, title: issue.title, body: issue.body }, source: snapshot.files }, signal);
    if (state.state === 'blocked') throw new Error('Development step is blocked; inspect its verified evidence.');
    const response = await supervisor.tool(binding, { operation: 'export' }, { signal }); authority(target, run, signal);
    if (response.ok !== true || !response.result) throw new Error('Development candidate export denied or incomplete.');
    const exported = response.result;
    const held = await acquire(target, signal);
    try {
      const detail = await github.readDetail(held.app, target, run.issue);
      if (detail.state !== 'OPEN' || !detail.ready || detail.title !== issue.title || detail.body !== issue.body || detail.dependencies.some(dependency => dependency.state !== 'CLOSED')) throw new Error('Development Issue or dependency changed before publication.');
      await publishDevelopmentCandidate({ store, ledger, lease: held.app, workspace: target, run, source: snapshot.files, files: exported.files, profile, title: issue.title, authority: () => authority(target, run, signal) });
      const catalog = await github.readCatalog(held.app, held.project, target), current = catalog.issues.find(value => value.number === run.issue);
      await fieldEffect(target, held, run.id, current, 'Pending Review', signal);
    } finally { release(held); }
    await policy.runtime.reserve(identity, { commandId: 'candidate-' + run.id + '-' + run.epoch, issue: run.issue, pipeline: 'development' });
    supervisor.control(binding, 'pause'); await supervisor.settle(target.id);
    if (policy.runtime.status(target.id).control !== 'paused') throw new Error('Development worker pause could not be verified.');
    messages.set(target.id, 'Candidate PR prepared. Core Development checks and review are recorded. The configured PM Testing and integration boundary is pending.'); publish();
  }
  async function start(target, number, signal) {
    if (!supervisor) throw new Error('Development worker unavailable.');
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Development needs a specific selected Issue.');
    if (policy.runtime.status(target.id)) throw new Error('Development already holds this repository; use its local controls.');
    const view = policy.worker.read(target.id), grant = policy.worker.authority(target.id, view.revision), dev = connections.developers().find(dev => dev.id === grant.dev);
    if (!dev || developmentPermissions.some(permission => !grant.capabilities.includes(permission)) || !grant.connections.includes('github') || !grant.connections.includes(dev.connection) || !grant.bundledSkills) throw new Error('Development needs a qualified assigned Dev and both host and repository permissions.');
    const identity = inspectWorkspace(target.path, { repository: target.id, owner: target.slug.split('/')[0], name: target.slug.split('/')[1] });
    if (workspaceData(identity).localKey !== target.localKey) throw new Error('Development local workspace changed.');
    const snapshot = snapshotWorkspace(identity), profile = executionProfile(snapshot.files, target), held = await acquire(target, signal); let issue;
    const unchangedPolicy = () => { signal.throwIfAborted(); if (policy.worker.read(target.id).hash !== view.hash) throw new Error('Development configuration changed during preflight.'); };
    try {
      const catalog = await github.readCatalog(held.app, held.project, target); issue = catalog.issues.find(value => value.number === number);
      if (!issue || issue.state !== 'OPEN' || !issue.ready || !issue.itemId || ['Priority', 'Impact', 'Effort'].some(role => !issue.metadata[role])
        || catalog.active.some(active => active.number !== number) || !['Backlog', 'In Progress'].includes(issue.status)) throw new Error('Development needs a Ready Issue with complete metadata and no other active Issue.');
      const detail = await github.readDetail(held.app, target, number);
      const boundIssue = { number, title: detail.title, body: detail.body };
      if (detail.dependencies.some(dependency => dependency.state !== 'CLOSED') || detail.pullRequests.some(pr => pr.state === 'OPEN')) throw new Error('Development dependencies or an existing PR prevent a new run.');
      const login = held.app.value.account.login;
      if (!profile.qa?.developers?.some(dev => dev.github === login && dev.kind === 'agent') || issue.assignees.some(person => person !== login)) throw new Error('Development GitHub Dev assignment needs explicit repository configuration.');
      await supervisor.prepare(); unchangedPolicy();
      const context = store.issueContext(target.id) ?? { selected: number, draft: null }, activation = context.development?.number === number ? context.development.activation : randomUUID();
      store.saveIssueContext(target.id, { ...context, development: { activation, number } });
      issue = await fieldEffect(target, held, activation, issue, 'In Progress', signal);
      unchangedPolicy();
      const intent = store.prepare(activation, 'assign', { kind: 'development', repository: target.id, issue: number, login });
      if (intent.state === 'prepared') {
        signal.throwIfAborted(); store.dispatch(intent.id);
        try { await githubRequest(held.app, 'PATCH', '/repos/' + target.slug + '/issues/' + number, { assignees: [login] }); }
        catch (error) { if (error.message !== 'write-result-uncertain') { store.finish(intent.id, 'uncertain', { error: 'assignment-needs-readback' }); throw error; } }
      }
      const actual = await github.readIssue(held.app, target, number);
      if (actual.assignees.length !== 1 || actual.assignees[0] !== login || actual.state !== 'OPEN' || !actual.ready
        || actual.title !== boundIssue.title || actual.body !== boundIssue.body) throw new Error('Development assignment or Issue input readback changed.');
      if (intent.state !== 'verified') store.finish(intent.id, 'verified', { assignee: login, issue: number });
      issue = { ...issue, ...boundIssue }; unchangedPolicy();
    } finally { release(held); }
    unchangedPolicy();
    const reservation = await policy.runtime.reserve(identity, { commandId: randomUUID(), issue: number, pipeline: 'development', policyHash: view.hash }), run = reservation.run;
    ledger.create(run, { pipeline: view.values['pipelines.development'].value, source: snapshot.candidate, developer: { id: dev.id, connection: dev.connection, model: dev.model }, skillsHash: starterHash, issueHash: developmentIssueHash({ number: issue.number, title: issue.title, body: issue.body }),
      checks: profile.quality.commands.map((command, index) => ({ name: 'Repository check ' + (index + 1), command })), logBytes: Math.min(50, view.values['privacy.runLogMiB'].value) * 1024 * 1024 });
    await execute(target, run, snapshot, profile, issue, signal);
  }
  function control(target, operation) {
    const run = policy.runtime.status(target.id);
    if (!run || !supervisor || controls.has(target.id)) throw new Error('Development local control unavailable.');
    const old = tasks.get(target.id); old?.controller.abort();
    if (operation !== 'resume') policy.runtime.requestControl({ runId: run.id, epoch: run.epoch }, operation);
    const work = (async () => {
      await old?.done; const binding = { runId: run.id, epoch: run.epoch };
      if (operation === 'resume') {
        if (closed || closing) throw new Error('Development app is closing.');
        if (ledger.evidence(binding).some(value => ['prepared', 'dispatched', 'uncertain'].includes(value.state))) throw new Error('Development pending tool outcome needs recovery before resume.');
        supervisor.control(binding, 'resume'); await supervisor.settle(target.id);
        const next = policy.runtime.status(target.id); if (next.control !== 'running' || next.epoch <= run.epoch) throw new Error('Development resume could not be verified.');
        ledger.rebind(run.id, next.epoch); controls.delete(target.id);
        operate(target, async signal => {
          const identity = inspectWorkspace(target.path, { repository: target.id, owner: target.slug.split('/')[0], name: target.slug.split('/')[1] }), snapshot = snapshotWorkspace(identity);
          const captured = ledger.captured(run.id); if (canonicalJSON(snapshot.candidate) !== canonicalJSON(captured.source)) throw new Error('Development captured source changed before resume.');
          const held = await acquire(target, signal); let issue;
          try { issue = await github.readIssue(held.app, target, run.issue); } finally { release(held); }
          if (developmentIssueHash({ number: issue.number, title: issue.title, body: issue.body }) !== captured.issueHash) throw new Error('Development captured Issue changed before resume.');
          await execute(target, next, snapshot, executionProfile(snapshot.files, target), issue, signal);
        });
      } else { supervisor.control(binding, operation); await supervisor.settle(target.id); messages.set(target.id, 'Development ' + operation + ' verified. Work and the repository claim remain preserved.'); }
    })().catch(error => { errors.set(target.id, safeError(error)); messages.set(target.id, safeError(error)); }).finally(() => { controls.delete(target.id); publish(); });
    controls.set(target.id, work); publish(); return { accepted: true, snapshot: status() };
  }
  function dispatch(payload) {
    const target = ready(); canonicalJSON(payload);
    if (payload.operation === 'chat') {
      record(payload, ['operation', 'text']); const action = developmentCommand(payload.text);
      if (!action || action.operation === 'show') return { snapshot: status(), message: 'Choose a qualified Dev, review host and repository permissions, then ask to start a specific Ready Issue. Local Pause, Stop and Resume remain available.' };
      if (action.operation === 'choose-provider') { const dev = connections.developers().find(dev => dev.connection === action.provider); if (!dev) return { snapshot: status(), message: 'That provider has no qualified execution model. Connect and test it in Connections first.' }; return dispatch({ operation: 'dev-prepare', dev: dev.id }); }
      if (action.operation === 'apply') action.hash = preview?.hash; return dispatch(action);
    }
    const shape = developmentShapes[payload.operation]; if (!shape) throw new Error('Development operation unavailable.'); record(payload, ['operation', ...shape[0]], shape[1]);
    if (payload.operation === 'dev-prepare') {
      const dev = connections.developers().find(dev => dev.id === payload.dev); if (!dev) throw new Error('Development selected Dev is unavailable.');
      return prepare('repository', { 'agents.dev': dev.id, ['connections.' + dev.connection]: dev.connection, 'connections.github': 'github' });
    }
    if (payload.operation === 'permissions-prepare') {
      if (!['host', 'repository'].includes(payload.scope)) throw new Error('Development permission scope unavailable.');
      const key = payload.scope === 'host' ? 'permissions.ceiling' : 'permissions.grants', view = policy.worker.read(target.id);
      return prepare(payload.scope, { [key]: [...new Set([...view.values[key].value, ...developmentPermissions])] });
    }
    if (payload.operation === 'apply') {
      if (!preview || payload.hash !== preview.hash) throw new Error('Development preview changed.');
      policy.control.apply({ commandId: randomUUID(), proposalId: preview.id, hash: preview.hash, inputId: preview.inputId, conversationId: conversation, target: preview.target }); preview = null;
      messages.set(target.id, 'Development configuration applied for the reviewed scope. Active runs retain captured authority; revocation affects the next action.'); publish(); return { snapshot: status() };
    }
    if (payload.operation === 'cancel') { invalidate(); publish(); return { snapshot: status(), message: 'Development configuration change cancelled.' }; }
    if (payload.operation === 'start') return operate(target, signal => start(target, payload.number ?? store.issueContext(target.id)?.selected, signal));
    return control(target, payload.operation);
  }
  return Object.freeze({ status, dispatch, observe, sync() { sync(); publish(); }, async idle() { await Promise.allSettled([...tasks.values()].map(task => task.done)); await Promise.allSettled([...controls.values()]); },
    async close() { closing = true; invalidate(); for (const task of tasks.values()) task.controller.abort(); try { await this.idle(); const snapshot = status(); await supervisor?.shutdown();
      lastSnapshot = { ...snapshot, run: selected && policy ? policy.runtime.status(selected) : null, execution: snapshot.execution ? { worker: 'stopped', pending: null, error: null } : null }; closed = true;
    } catch (error) { closing = false; throw error; } } });
}
