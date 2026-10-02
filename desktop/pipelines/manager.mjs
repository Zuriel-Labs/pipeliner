import { createHash, randomUUID } from 'node:crypto';
import { canonicalJSON, capabilityNames, record } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';
import { pipelineCommand, pipelineShapes, stepTypes, inputNames, evidenceNames } from './commands.mjs';
import { presetChanges, editDefinition, editTesting } from './model.mjs';

const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
// Preserve generated binding identities; the secret heuristic also matches long hashes and step IDs.
const safe = (value, key) => typeof value === 'string' ?
  (key === 'workspaceId' && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value)
    || ['hash', 'pipelineHash'].includes(key) && /^[a-f0-9]{64}$/.test(value)
    || ['id', 'inputId', 'entry', 'success', 'failure', 'feedback'].includes(key) && /^(?:step_[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value)) ? value
    : containsSecret(value) ? 'Sensitive text hidden' : value
  : Array.isArray(value) ? value.map(item => safe(item)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, safe(value, key)])) : value;
const publicInput = value => { if (canonicalJSON(safe(value)) !== canonicalJSON(value)) throw new Error('Sensitive pipeline input'); };
const failure = error => /^(Pipeline |Development |Supervised |Fully Autonomous|Invalid pipeline|Modified preset|Choose |Unknown pipeline|Invalid new pipeline|Invalid step declarations|Sensitive pipeline|Invalid PM test|Unknown policy|Stale policy proposal|Proposal (expired|binding changed|context changed)|Capability context changed|Policy proposal has no change|Original PM input)/.test(error.message)
  ? error.message : 'Pipeline change blocked. Current configuration and saved drafts remain preserved.';

// Host-only PM control. Workers may read/propose policy; they never receive this handle or its IPC channel.
export function createPipelineManager({ store, policy, onChange = () => {}, onApplied = () => {}, initialRevision = 1 }) {
  let workspaceId = store?.selected() ?? null, scope = workspaceId ? 'repository' : 'global', kind = 'development', revision = initialRevision;
  let conversation = randomUUID(), preview = null, applied = null, observed = policy?.worker.read(null).revision, closed = false, message = null, error = null, lastSnapshot;
  const target = () => scope === 'global' ? null : workspaceId;
  function invalidate() { if (preview) policy.control.invalidate(preview.inputId); preview = null; }
  function sync() {
    if (closed) return false;
    const before = revision;
    const next = store?.selected() ?? null, version = policy?.worker.read(null).revision;
    if (next !== workspaceId) { invalidate(); workspaceId = next; scope = next ? 'repository' : 'global'; conversation = randomUUID(); applied = null; message = null; error = null; revision++; }
    if (version !== observed) { invalidate(); observed = version; revision++; }
    return revision !== before;
  }
  function status() {
    if (closed) return { ...lastSnapshot, storageAvailable: false, preview: null };
    let current = null, active = null, draft = null, history = [], workspaces = [], storageAvailable = Boolean(store && policy);
    try {
      sync(); workspaces = store?.workspaces() ?? [];
      if (storageAvailable) {
        const view = policy.worker.read(target()), field = view.values['pipelines.' + kind];
        current = { revision: view.revision, hash: view.hash, definition: field.value, source: field.source, scenario: view.values['autonomy.scenario'].value,
          trigger: view.values['intake.trigger'].value, instructions: view.values['testing.instructions'].value, requiredChecks: view.values['testing.requiredChecks'].value,
          grantedPermissions: view.values['permissions.grants'].value, publication: view.values['delivery.publish'].value };
        draft = store.pipelineDraft(target(), kind); history = policy.worker.history(target());
        const run = workspaceId ? policy.runtime.status(workspaceId) : null;
        if (run) active = { issue: run.issue, control: run.control, runPipeline: run.pipeline, kind, policyRevision: run.policyRevision, pipelineHash: run.pipelineHash,
          definition: policy.worker.read(workspaceId, run.policyRevision).values['pipelines.' + kind].value };
      }
    } catch { storageAvailable = false; }
    return lastSnapshot = safe({ revision, workspaceId, repositoryLabel: workspaces.find(value => value.id === workspaceId)?.name ?? null, scope, kind, storageAvailable,
      current, active, draft, staleDraft: Boolean(draft && draft.baseRevision !== current?.revision), preview, message, error, history,
      options: { types: stepTypes, inputs: inputNames, evidence: evidenceNames, permissions: Object.fromEntries(capabilityNames.map(name => [name, name.replaceAll('.', ' ')])) } });
  }
  function publish() { revision++; if (!closed) onChange(status()); }
  function ready() { sync(); if (closed || !store || !policy || scope === 'repository' && !workspaceId) throw new Error('Choose a repository or global template'); }
  function select(payload) {
    const nextKind = payload.kind ?? kind, nextScope = payload.scope ?? scope;
    if (!['development', 'release'].includes(nextKind) || !['repository', 'global'].includes(nextScope) || nextScope === 'repository' && !workspaceId) throw new Error('Choose a repository or global template');
    if (nextKind !== kind || nextScope !== scope) { invalidate(); conversation = randomUUID(); applied = null; kind = nextKind; scope = nextScope; }
  }
  function begin() {
    const existing = store.pipelineDraft(target(), kind); if (existing) return existing;
    const view = policy.worker.read(target());
    const draft = { baseRevision: view.revision, definition: structuredClone(view.values['pipelines.' + kind].value), instructions: structuredClone(view.values['testing.instructions'].value), changes: {}, reset: [] };
    publicInput(draft);
    store.savePipelineDraft(target(), kind, draft); return draft;
  }
  function save(draft) {
    publicInput(draft);
    invalidate(); applied = null; store.savePipelineDraft(target(), kind, draft); message = 'Draft saved for ' + (scope === 'global' ? 'global templates' : 'this repository') + '. Review before applying; running versions remain unchanged.'; publish();
  }
  function prepare() {
    const draft = store.pipelineDraft(target(), kind); if (!draft) throw new Error('Choose or edit a pipeline before review');
    if (draft.baseRevision !== policy.worker.read(target()).revision) throw new Error('Pipeline draft base changed. Refresh the draft, then review the full changes.');
    invalidate();
    const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: target(), text: 'Review ' + scope + ' ' + kind + ' pipeline draft ' + digest(draft) });
    try {
      const result = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope, target: target(), changes: draft.changes, reset: draft.reset });
      const keys = [...Object.keys(draft.changes), ...draft.reset];
      preview = { id: result.id, inputId: result.inputId, hash: result.hash, baseRevision: result.baseRevision, expiresAt: result.expiresAt,
        scope, kind, affectedRepositories: result.affectedRepositories.map(id => store.workspaces().find(value => value.id === id)?.name ?? id),
        before: Object.fromEntries(keys.map(key => [key, result.before[key]])), after: Object.fromEntries(keys.map(key => [key, result.after[key]])), timing: result.timing };
      message = 'Review the exact pipeline changes and affected scope. Apply publishes one configuration version for future runs.';
    } catch (error) {
      policy.control.invalidate(input.id);
      if (error.message !== 'Policy proposal has no change') throw error;
      store.clearPipelineDraft(target(), kind); message = 'Current configuration already matches this draft. No new version was created.';
    }
    publish();
  }
  function dispatch(payload) {
    try {
      ready(); canonicalJSON(payload); const shape = pipelineShapes[payload?.operation];
      if (!shape) throw new Error('Unknown pipeline operation'); record(payload, ['operation', ...shape[0]], shape[1]);
      publicInput(payload); error = null;
      if (payload.operation === 'chat') {
        const action = pipelineCommand(payload.text);
        return action ? dispatch(action) : { snapshot: status(), message: 'Ask to inspect or edit a Development or Release pipeline, review it, apply it or discard the draft.' };
      }
      if (['view', 'begin'].includes(payload.operation)) { select(payload); if (payload.operation === 'begin') begin(); message = 'Showing the saved ' + kind + ' pipeline. Applied and running versions are separate.'; publish(); }
      else if (payload.operation === 'preset') {
        const changes = presetChanges(payload.scenario), draft = begin();
        save({ ...draft, definition: changes['pipelines.' + kind], changes: { ...draft.changes, ...changes }, reset: [] });
      } else if (payload.operation === 'edit') {
        const draft = begin(), definition = editDefinition(draft.definition, payload.action);
        save({ ...draft, definition, changes: { ...draft.changes, ['pipelines.' + kind]: definition, 'autonomy.scenario': 'custom', ...(kind === 'release' ? { 'delivery.publish': definition.steps.some(step => step.kind === 'publish') } : {}) }, reset: draft.reset.filter(key => key !== 'pipelines.' + kind) });
      } else if (payload.operation === 'testing') {
        const draft = begin(), instructions = editTesting(draft.instructions, payload.action);
        save({ ...draft, instructions, changes: { ...draft.changes, 'testing.instructions': instructions }, reset: draft.reset.filter(key => key !== 'testing.instructions') });
      } else if (payload.operation === 'prepare') prepare();
      else if (payload.operation === 'apply') {
        if (!preview) {
          if (applied && applied.scope === scope && applied.kind === kind && applied.target === target() && (!payload.hash || payload.hash === applied.hash)) return { snapshot: status(), message: 'This exact proposal is already applied as version ' + applied.revision + '.' };
          throw new Error('Pipeline preview changed. Review again before applying.');
        }
        if (payload.hash && payload.hash !== preview.hash) throw new Error('Pipeline preview changed. Review again before applying.');
        const p = preview, result = policy.control.apply({ commandId: randomUUID(), proposalId: p.id, hash: p.hash, inputId: p.inputId, conversationId: conversation, target: target() });
        applied = { hash: p.hash, revision: result.revision, scope, kind, target: target() }; preview = null;
        message = 'Pipeline published as configuration version ' + result.revision + '. Future runs use this version; active work keeps its captured definition.';
        store.clearPipelineDraft(target(), kind); publish(); onApplied();
      } else if (payload.operation === 'discard') { invalidate(); applied = null; store.clearPipelineDraft(target(), kind); message = 'This pipeline draft was discarded. Published configuration and running work are unchanged.'; publish(); }
      else if (payload.operation === 'rebase') { const draft = store.pipelineDraft(target(), kind); if (!draft) throw new Error('Choose a saved draft'); save({ ...draft, baseRevision: policy.worker.read(target()).revision }); }
      else if (payload.operation === 'reset') {
        select(payload); if (scope !== 'repository') throw new Error('Choose a repository override to reset');
        const draft = begin(), changes = { ...draft.changes }; delete changes['pipelines.' + kind];
        const inherited = policy.worker.read(null).values['pipelines.' + kind].value;
        changes['autonomy.scenario'] = 'custom';
        if (kind === 'release') changes['delivery.publish'] = inherited.steps.some(step => step.kind === 'publish');
        save({ ...draft, definition: structuredClone(inherited), changes, reset: [...new Set([...draft.reset, 'pipelines.' + kind])] });
      } else if (payload.operation === 'restore') {
        select(payload); if (!Number.isSafeInteger(payload.version) || payload.version < 0) throw new Error('Choose an existing configuration version');
        const previous = policy.worker.read(target(), payload.version).values['pipelines.' + kind].value, draft = begin();
        save({ ...draft, definition: structuredClone(previous), changes: { ...draft.changes, ['pipelines.' + kind]: previous, 'autonomy.scenario': 'custom', ...(kind === 'release' ? { 'delivery.publish': previous.steps.some(step => step.kind === 'publish') } : {}) }, reset: draft.reset.filter(key => key !== 'pipelines.' + kind) });
      }
      return { snapshot: status() };
    } catch (reason) { error = failure(reason); publish(); throw new Error(error); }
  }
  return Object.freeze({ status, dispatch, sync() { if (sync()) onChange(status()); }, close() { invalidate(); closed = true; } });
}
