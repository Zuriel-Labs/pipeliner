export const capabilityNames = Object.freeze(['workspace.read', 'workspace.write', 'worker.exec', 'github.read', 'github.issue.write',
  'github.pr.write', 'github.project.write', 'provider.turn', 'artifact.build', 'artifact.publish', 'extension.install', 'host.launch', 'host.install', 'host.automation']);
export function immutable(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) immutable(item); Object.freeze(value); }
  return value;
}
export function canonicalJSON(value) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 50000 || depth > 32) throw new Error('Policy payload too large');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (item && typeof item === 'object' && (Object.getOwnPropertySymbols(item).length
      || Object.values(Object.getOwnPropertyDescriptors(item)).some(d => d.get || d.set))) throw new Error('Policy payload must contain only JSON data');
    if (Array.isArray(item) && Object.keys(item).length === item.length) return item.map(v => visit(v, depth + 1));
    if (item && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key], depth + 1)]));
    }
    throw new Error('Policy payload must contain only JSON data');
  }
  const text = JSON.stringify(visit(value, 0));
  if (text.length > 524288) throw new Error('Policy payload too large');
  return text;
}
export function record(value, required, optional = []) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) throw new Error('Invalid policy request');
}
const identifier = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(v);
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 240 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const list = (v, valid = identifier) => Array.isArray(v) && v.length <= 64 && new Set(v).size === v.length && v.every(valid);
const number = (min, max) => v => Number.isSafeInteger(v) && v >= min && v <= max;
const choice = values => v => values.includes(v);
const boolean = v => typeof v === 'boolean';
const reference = v => v === null || identifier(v);
const capabilities = v => list(v, choice(capabilityNames));
const step = (id, label, kind, next, feedback = 'blocked') => ({ id, label, kind, permissions: [], inputs: ['issue'],
  expectedResult: label, evidence: ['verified-result'], routes: { success: next, failure: 'blocked', feedback }, retryLimit: 0, visitLimit: 4 });
export const developmentTemplate = immutable({ entry: 'research', steps: [
  step('research', 'Research and specify the Issue', 'agent', 'implement'),
  step('implement', 'Implement the agreed change', 'agent', 'checks'),
  step('checks', 'Pass repository checks', 'check', 'review'),
  step('review', 'Review the exact candidate', 'agent', 'pm-testing'),
  step('pm-testing', 'PM testing before merge', 'pm-qa', 'integrate', 'implement'),
  step('integrate', 'Integrate the verified pull request', 'pr-integration', 'complete'),
] });
export const releaseTemplate = immutable({ entry: 'build', steps: [
  step('build', 'Build locally for this host', 'build', 'verify'),
  step('verify', 'Verify the exact artifact', 'artifact-verify', 'retain'),
  step('retain', 'Retain the verified local artifact', 'retain', 'complete'),
] });
export function validatePipeline(value, development = false) {
  try {
    record(value, ['entry', 'steps']);
    if (!identifier(value.entry) || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 64) throw new Error();
    const steps = new Map();
    for (const s of value.steps) {
      record(s, ['id', 'label', 'kind', 'permissions', 'inputs', 'expectedResult', 'evidence', 'routes', 'retryLimit', 'visitLimit']);
      record(s.routes, ['success', 'failure', 'feedback']);
      if (!identifier(s.id) || ['complete', 'blocked'].includes(s.id) || steps.has(s.id) || !text(s.label) || !text(s.expectedResult)
        || !['agent', 'check', 'pm-qa', 'pr-integration', 'build', 'artifact-verify', 'retain', 'publish', 'extension'].includes(s.kind)
        || !capabilities(s.permissions) || !list(s.inputs) || !list(s.evidence) || !s.evidence.length
        || !number(0, 10)(s.retryLimit) || !number(1, 100)(s.visitLimit) || !Object.values(s.routes).every(identifier)) throw new Error();
      steps.set(s.id, s);
    }
    if (!steps.has(value.entry) || [...steps.values()].some(s => Object.values(s.routes).some(r => !steps.has(r) && !['complete', 'blocked'].includes(r)))) throw new Error();
    const reached = new Set(), visited = new Set(); let completion = false;
    function walk(id, integrated) {
      if (id === 'blocked') return;
      if (id === 'complete') {
        if (development && !integrated) throw new Error('Development completion requires PR integration');
        completion = true; return;
      }
      const key = `${id}:${integrated}`; if (visited.has(key)) return;
      visited.add(key); reached.add(id); const s = steps.get(id);
      for (const route of Object.values(s.routes)) walk(route, integrated || s.kind === 'pr-integration');
    }
    walk(value.entry, false);
    if (reached.size !== steps.size) throw new Error('Pipeline contains an unreachable step');
    if (!completion) throw new Error('Pipeline has no completion route');
    return true;
  } catch (error) { throw new Error(error.message || 'Invalid pipeline'); }
}

// Each tuple is the single schema consumed by policy, chat and Settings.
const entries = [
  ['connections.github', 'S-01', 'GitHub connection', 'repository', null, reference, 'next-action'],
  ['connections.codex', 'S-01', 'Managed Codex connection', 'repository', null, reference, 'next-action'],
  ['connections.ollama', 'S-01', 'Ollama Cloud connection', 'repository', null, reference, 'next-action'],
  ['agents.dev', 'S-02', 'Assigned Dev', 'repository', null, reference, 'new-run'],
  ['agents.fallbacks', 'S-02', 'Ordered fallback Devs', 'repository', [], list, 'new-run'],
  ['agents.takeover', 'S-02', 'Automatic takeover', 'repository', false, boolean, 'new-run'],
  ['autonomy.scenario', 'S-03', 'Autonomy scenario', 'repository', null, choice([null, 'supervised', 'pm-autonomous', 'scheduled-autonomous', 'custom']), 'new-run'],
  ['intake.mode', 'S-03', 'Issue authoring', 'repository', 'coauthored', choice(['pm', 'coauthored', 'agent']), 'new-run'],
  ['intake.agentCreation', 'S-03', 'Agent Issue creation', 'repository', false, boolean, 'new-run'],
  ['intake.trigger', 'S-03', 'Issue start trigger', 'repository', 'pm', choice(['pm', 'schedule']), 'new-run'],
  ['pipelines.development', 'S-04', 'Development pipeline', 'repository', developmentTemplate, v => validatePipeline(v, true), 'new-run'],
  ['pipelines.release', 'S-04', 'Release pipeline', 'repository', releaseTemplate, validatePipeline, 'new-run'],
  ['permissions.ceiling', 'S-05', 'Host permission ceiling', 'host', ['workspace.read', 'workspace.write', 'worker.exec'], capabilities, 'tightening-now-expansion-new-run'],
  ['permissions.grants', 'S-05', 'Repository permissions', 'repository', ['workspace.read', 'workspace.write', 'worker.exec'], capabilities, 'tightening-now-expansion-new-run'],
  ['permissions.resources', 'S-05', 'Additional resource scopes', 'repository', [], list, 'tightening-now-expansion-new-run'],
  ['scheduling.enabled', 'S-06', 'Scheduled checks', 'repository', false, boolean, 'next-check'],
  ['scheduling.intervalMinutes', 'S-06', 'Check interval in minutes', 'repository', 30, number(1, 525600), 'next-check'],
  ['scheduling.timezone', 'S-06', 'Calendar timezone', 'repository', null, v => v === null || (typeof v === 'string' && v.length <= 80 && (() => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } })()), 'next-check'],
  ['scheduling.afterCompletion', 'S-06', 'Next work after completion', 'repository', 'next-check', choice(['next-check', 'immediate']), 'next-check'],
  ['background.enabled', 'S-07', 'Background operation', 'host', false, boolean, 'verified-host-action'],
  ['background.startAtLogin', 'S-07', 'Start at login', 'host', false, boolean, 'verified-host-action'],
  ['limits.stepTurns', 'S-08', 'Model turns per step', 'repository', 20, number(1, 100000), 'new-run'],
  ['limits.issueTurns', 'S-08', 'Model turns per Issue', 'repository', 100, number(1, 1000000), 'new-run'],
  ['limits.tokens', 'S-08', 'Optional token cap', 'repository', null, v => v === null || number(1, 1000000000)(v), 'new-run'],
  ['limits.costUsd', 'S-08', 'Optional cost cap in USD', 'repository', null, v => v === null || (Number.isFinite(v) && v > 0 && v <= 1000000), 'new-run'],
  ['limits.concurrency', 'S-08', 'Host worker capacity', 'host', 1, number(1, 5), 'new-run'],
  ['limits.allocation', 'S-08', 'Repository worker allocation', 'repository', 1, number(1, 5), 'new-run'],
  ['limits.transientAttempts', 'S-08', 'Transient attempts', 'repository', 3, number(1, 10), 'new-run'],
  ['limits.remediationCycles', 'S-08', 'Remediation cycles', 'repository', 3, number(0, 10), 'new-run'],
  ['limits.controlSeconds', 'S-08', 'Control deadline', 'repository', 300, number(1, 86400), 'new-run'],
  ['limits.agentSeconds', 'S-08', 'Agent deadline', 'repository', 1800, number(1, 604800), 'new-run'],
  ['limits.buildSeconds', 'S-08', 'Build deadline', 'repository', 3600, number(1, 604800), 'new-run'],
  ['skills.bundledEnabled', 'S-09', 'Bundled skills', 'repository', true, boolean, 'tightening-now-expansion-new-run'],
  ['skills.extensions', 'S-09', 'Approved pinned extensions', 'repository', [], list, 'new-run'],
  ['skills.disabled', 'S-09', 'Disabled extension references', 'repository', [], list, 'tightening-now-expansion-new-run'],
  ['testing.requiredChecks', 'S-10', 'Required check references', 'repository', [], list, 'new-run'],
  ['testing.instructions', 'S-10', 'PM testing actions and expected results', 'repository', [], v => Array.isArray(v) && v.length <= 64 && v.every(s => { record(s, ['action', 'expected']); return text(s.action) && text(s.expected); }), 'new-run'],
  ['delivery.output', 'S-11', 'Local output folder reference', 'repository', null, reference, 'new-run'],
  ['delivery.publish', 'S-11', 'GitHub Releases publication', 'repository', false, boolean, 'new-run'],
  ['delivery.keepLatest', 'S-11', 'Latest verified artifacts retained', 'repository', 3, number(1, 100), 'future-cleanup'],
  ['delivery.warningGiB', 'S-11', 'Artifact storage warning', 'host', 8, number(1, 100000), 'next-allocation'],
  ['delivery.capacityGiB', 'S-11', 'Host artifact capacity', 'host', 10, number(1, 100000), 'next-allocation'],
  ['privacy.conversationDays', 'S-12', 'Completed conversation retention', 'repository', 90, number(1, 36500), 'future-cleanup'],
  ['privacy.logDays', 'S-12', 'Verbose log retention', 'repository', 30, number(1, 36500), 'future-cleanup'],
  ['privacy.auditDays', 'S-12', 'Minimal audit retention', 'repository', 365, number(1, 36500), 'future-cleanup'],
  ['privacy.runLogMiB', 'S-12', 'Per-run verbose log ceiling', 'repository', 50, number(1, 10000), 'future-cleanup'],
  ['privacy.totalLogMiB', 'S-12', 'Host verbose log ceiling', 'host', 500, number(1, 100000), 'future-cleanup'],
  ['privacy.telemetry', 'S-12', 'Telemetry unavailable', 'host', false, v => v === false, 'unavailable'],
  ['privacy.automaticUpload', 'S-12', 'Automatic diagnostic upload unavailable', 'host', false, v => v === false, 'unavailable'],
  ['privacy.crossRepositoryReuse', 'S-12', 'Cross-repository reuse unavailable', 'repository', false, v => v === false, 'unavailable'],
  ['appearance.theme', 'S-13', 'Theme', 'host', 'system', choice(['system', 'light', 'dark']), 'immediate'],
  ['appearance.density', 'S-13', 'Density', 'host', 'comfortable', choice(['comfortable', 'compact']), 'immediate'],
  ['appearance.textScale', 'S-13', 'Text scale', 'host', 1, v => Number.isFinite(v) && v >= 1 && v <= 2, 'immediate'],
  ['appearance.motion', 'S-13', 'Motion preference', 'host', 'system', choice(['system', 'reduced']), 'immediate'],
  ['appearance.technicalDetails', 'S-13', 'Technical details', 'host', false, boolean, 'immediate'],
  ['appearance.osNotifications', 'S-13', 'OS notifications', 'host', false, boolean, 'verified-host-action'],
  ['appearance.repositoryNotifications', 'S-13', 'Repository in-app notifications', 'repository', true, boolean, 'immediate'],
  ['updates.channel', 'S-14', 'Desktop update channel', 'host', 'stable', choice(['stable', 'beta', 'alpha']), 'next-check'],
  ['updates.source', 'S-14', 'Trusted update source reference', 'host', null, reference, 'next-check'],
  ['updates.automaticDownload', 'S-14', 'Automatic download unavailable', 'host', false, v => v === false, 'unavailable'],
  ['updates.automaticInstall', 'S-14', 'Automatic install unavailable', 'host', false, v => v === false, 'unavailable'],
  ['updates.automaticRestart', 'S-14', 'Automatic restart unavailable', 'host', false, v => v === false, 'unavailable'],
  ['diagnostics.health', 'S-15', 'Capability and recovery inspection', 'read-only', 'not-qualified', v => v === 'not-qualified', 'read-only'],
];
export const fields = new Map(entries.map(([id, category, label, scope, defaultValue, validate, timing]) => [id, immutable({ id, category, label, scope, defaultValue, validate, timing })]));
export const defaults = immutable(Object.fromEntries([...fields].map(([id, f]) => [id, f.defaultValue])));
export const settingsSchema = () => [...fields.values()].map(({ validate: _validate, ...f }) => structuredClone(f));
export function validateValue(id, value) {
  const f = fields.get(id); if (!f) throw new Error('Unknown policy field');
  if (!f.validate(value)) throw new Error(`Invalid ${f.label}`);
}
export function rawValues(state, target) { return { ...state.defaults, ...state.host, ...state.global, ...(target ? state.repositories[target] : {}) }; }
export function validateState(state) {
  canonicalJSON(state); record(state, ['schemaVersion', 'defaults', 'host', 'global', 'repositories']);
  if (state.schemaVersion !== 1 || canonicalJSON(state.defaults) !== canonicalJSON(defaults)) throw new Error('Unsupported policy schema or defaults');
  for (const [scope, values] of [['host', state.host], ['global', state.global], ...Object.entries(state.repositories).map(([id, v]) => {
    if (!identifier(id)) throw new Error('Invalid repository identity'); return ['repository', v];
  })]) {
    if (!values || ![Object.prototype, null].includes(Object.getPrototypeOf(values))) throw new Error('Invalid policy scope');
    for (const [id, value] of Object.entries(values)) {
      validateValue(id, value); const f = fields.get(id);
      if (f.scope === 'read-only' || (f.scope === 'host') !== (scope === 'host')) throw new Error('Invalid host or repository field scope');
    }
  }
  for (const target of [null, ...Object.keys(state.repositories)]) {
    const v = rawValues(state, target);
    if (['supervised', 'pm-autonomous'].includes(v['autonomy.scenario']) && v['intake.trigger'] !== 'pm'
      || v['autonomy.scenario'] === 'scheduled-autonomous' && v['intake.trigger'] !== 'schedule') throw new Error('Scenario and start trigger conflict');
    if (v['autonomy.scenario'] === 'supervised' && (v['pipelines.development'].steps.filter(s => s.kind === 'pm-qa').length !== 1
      || v['pipelines.release'].steps.some(s => s.kind === 'pm-qa'))) throw new Error('Modified preset must be identified as custom');
    if (['pm-autonomous', 'scheduled-autonomous'].includes(v['autonomy.scenario']) && [v['pipelines.development'], v['pipelines.release']].some(p => p.steps.some(s => s.kind === 'pm-qa'))) throw new Error('Fully Autonomous cannot contain an application gate');
    if (v['background.startAtLogin'] && !v['background.enabled']) throw new Error('Start at login requires background operation');
    if (v['limits.allocation'] > v['limits.concurrency']) throw new Error('Repository allocation exceeds host ceiling');
    if (v['delivery.warningGiB'] > v['delivery.capacityGiB']) throw new Error('Artifact warning exceeds capacity');
    if (v['privacy.runLogMiB'] > v['privacy.totalLogMiB']) throw new Error('Run logs exceed host ceiling');
    if (v['delivery.publish'] !== v['pipelines.release'].steps.some(s => s.kind === 'publish')) throw new Error('Publication requires its explicit pipeline step');
  }
}
