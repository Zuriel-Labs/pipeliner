import { record, canonicalJSON } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';
import { activeIssueStatuses, protectedLabel, normalizeLabel } from '../github/operations.mjs';

const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(value.replaceAll('\n', '')) && !containsSecret(value);
const list = (values, limit, check) => Array.isArray(values) && values.length <= limit && values.every(check) && new Set(values).size === values.length;
export function validateDraft(value, workspace, catalog) {
  canonicalJSON(value); record(value, ['title', 'summary', 'acceptance', 'priority', 'impact', 'effort'], ['labels', 'dependencies']);
  if (!text(value.title, 256) || value.title.includes('\n') || !text(value.summary, 4000) || !list(value.acceptance, 32, item => text(item, 1000)) || !value.acceptance.length) throw new Error('draft-incomplete');
  for (const role of ['Priority', 'Impact', 'Effort']) if (!workspace.project.fields[role]?.options.some(option => option.name === value[role.toLowerCase()])) throw new Error('metadata-invalid');
  const labels = value.labels ?? [], dependencies = value.dependencies ?? [];
  if (!list(labels, 50, label => text(label, 50) && !label.includes('\n') && normalizeLabel(label) !== normalizeLabel(protectedLabel) && catalog.labels.includes(label))
    || new Set(labels.map(normalizeLabel)).size !== labels.length) throw new Error('protected-or-invalid-label');
  if (!list(dependencies, 32, number => Number.isSafeInteger(number) && number > 0 && catalog.issues.some(issue => issue.number === number && issue.repositoryId === workspace.repositoryId))) throw new Error('dependency-unavailable');
  return { ...value, labels: [...labels], dependencies: [...dependencies] };
}
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
export function draftBody(value, workspace) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>${escape(value.title)}</title><style>html{color-scheme:dark}body{max-width:900px;margin:3rem auto;padding:0 1.5rem;background:#101722;color:#edf3fa;font:16px/1.65 system-ui}h1,h2{color:#9de0c8}</style></head><body>
<h1>${escape(value.title)}</h1>
<h2>Summary and intended outcome</h2><p>${escape(value.summary).replaceAll('\n', '<br>')}</p>
<h2>Acceptance criteria</h2><ol>${value.acceptance.map(item => `<li>${escape(item)}</li>`).join('')}</ol>
<h2>Repository and metadata</h2><p>${escape(workspace.slug)}. Priority ${escape(value.priority)}; Impact ${escape(value.impact)}; Effort ${escape(value.effort)}. Labels: ${(value.labels ?? []).map(escape).join(', ') || 'none'}. Dependencies: ${(value.dependencies ?? []).map(number => '#' + number).join(', ') || 'none'}.</p>
<h2>Implementation and verification</h2><p>Research the affected behavior and repository instructions before implementation. Write a focused specification and plan where applicable, preserve existing work and controls, and verify the acceptance criteria and configured checks. Report actual results, failures and anything not run. PM Testing follows the configured pipeline.</p>
<h2>Security, privacy and scope</h2><p>Keep credentials and unrelated data out of source, logs and artifacts. Preserve PM-owned policy and readiness, accessibility and task resource ownership. Creation does not mark this Issue Ready, assign a Dev or start work. Work outside the intended outcome requires a separate scoped decision.</p>
</body></html>`;
}
export function checkReadyAction(snapshot, workspace, enabled) {
  if (typeof enabled !== 'boolean' || snapshot?.complete !== true || snapshot.repositoryId !== workspace.repositoryId || snapshot.issue?.repositoryId !== workspace.repositoryId
    || !Array.isArray(snapshot.active) || snapshot.active.length > 1 || typeof snapshot.issue.status !== 'string' || !snapshot.issue.status.length) throw new Error('issue-state-incomplete');
  if (snapshot.active.some(issue => !activeIssueStatuses.includes(issue.status)) || activeIssueStatuses.includes(snapshot.issue.status) && !snapshot.active.some(issue => issue.id === snapshot.issue.id)
    || snapshot.localRun && (snapshot.active.length !== 1 || snapshot.active[0].number !== snapshot.localRun.issue)) throw new Error('issue-state-conflict');
  if (!enabled && activeIssueStatuses.includes(snapshot.issue.status)) throw new Error('ready-active');
  return true;
}
