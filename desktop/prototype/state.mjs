export const repositories = Object.freeze([
  { id: 'example-studio', name: 'Example Studio', issue: 'Issue #42', stage: 'Waiting for PM testing' },
  { id: 'field-notes', name: 'Field Notes', issue: 'No active Issue', stage: 'Ready for an Issue' },
]);

export const journeys = Object.freeze([
  { id: 'setup', label: 'Connect a project', prompt: 'Help me connect my project.', title: 'Connection path',
    detail: 'Choose a provider and GitHub connection in a protected surface. Then select a folder and verify repository and Project access.', next: 'Open Connections', setting: 'connections' },
  { id: 'issue', label: 'Draft an Issue', prompt: "Let's add a clearer onboarding flow.", title: 'Issue proposal',
    detail: 'Review the outcome, duplicate check, acceptance and repository before creation. Only you can mark the Issue Ready.', next: 'Review Issue draft', setting: 'intake' },
  { id: 'supervised', label: 'Test before merge', prompt: 'Start this Issue. Let me test before merge.', title: 'PM testing handoff',
    detail: 'A Showcase would include the exact candidate, findings, checks and numbered app tests. Your feedback would return to the same Issue.', next: 'Inspect testing settings', setting: 'testing' },
  { id: 'autonomous', label: 'Work automatically', prompt: 'Work on the ready Issue automatically, without asking me at each step.', title: 'Zero-gate preview',
    detail: 'Fully Autonomous has zero Pipeliner approval gates. A mandatory provider or OS control can still block the required path before work starts.', next: 'Inspect autonomy', setting: 'intake' },
  { id: 'schedule', label: 'Check ready work', prompt: 'Check ready work every half hour in this repository.', title: 'Schedule preview',
    detail: 'A repository schedule would check eligibility at the selected interval. Background operation stays off until you enable it separately.', next: 'Inspect scheduling', setting: 'scheduling' },
  { id: 'pipeline', label: 'Change a pipeline', prompt: 'Add accessibility review after design, and use this skill.', title: 'Pipeline proposal',
    detail: 'Review the step order, skill source, scope and version before applying. Running Issues keep their current pipeline.', next: 'Inspect pipelines', setting: 'pipelines' },
  { id: 'stop', label: 'Stop work', prompt: 'Stop work on this project.', title: 'Stop and recovery',
    detail: 'Stop prevents new dispatch and reconciles current effects. Files and the active Issue remain. Resume uses verified state.', next: 'Inspect diagnostics', setting: 'diagnostics' },
  { id: 'delivery', label: 'Find an installer', prompt: 'Where is the installer?', title: 'Delivery evidence',
    detail: 'Show only a verified package for this host. Windows and Linux packages remain pending until matching-host evidence exists.', next: 'Inspect delivery', setting: 'delivery' },
]);

export const settings = Object.freeze([
  { id: 'connections', code: 'S-01', name: 'Connections', value: 'Not connected', source: 'Host', scope: 'Host connection; repository selects authorized access', timing: 'Connection actions affect the next request.', detail: 'Connect GitHub or managed Codex. Enter an Ollama Cloud key only in a protected surface.', available: false },
  { id: 'agents', code: 'S-02', name: 'Agents and models', value: 'None selected', source: 'Global default', scope: 'Global or repository', timing: 'Changes affect new runs.', detail: 'Choose a named Dev and a model with verified capability.', available: false },
  { id: 'intake', code: 'S-03', name: 'Autonomy and intake', value: 'Supervised Dev suggested', source: 'Global template', scope: 'Global or repository', timing: 'Affects new Issues only.', detail: 'A scenario requires direct PM apply. Fully Autonomous has zero Pipeliner approval gates.', available: true },
  { id: 'pipelines', code: 'S-04', name: 'Pipelines', value: 'Development template', source: 'Global template', scope: 'Global or repository', timing: 'Affects new runs; active runs keep their version.', detail: 'Edit steps through chat or an accessible list. Publish only a valid version.', available: true },
  { id: 'permissions', code: 'S-05', name: 'Permissions and local testing', value: 'Workspace only', source: 'Fixed ceiling', scope: 'Host ceiling; repository subset', timing: 'Tightening is immediate; expansion needs a new run.', detail: 'Unqualified host abilities remain unavailable. No unrestricted host toggle.', available: false },
  { id: 'scheduling', code: 'S-06', name: 'Scheduling', value: 'Off', source: 'Global default', scope: 'Global or repository', timing: 'Affects the next check.', detail: 'A schedule cannot enable background operation or duplicate active work.', search: 'how often', available: true },
  { id: 'background', code: 'S-07', name: 'Background operation', value: 'Off', source: 'Host default', scope: 'Host only', timing: 'Host service needs separate PM and OS authorization.', detail: 'Start at login is also off. A schedule does not change either setting.', available: false },
  { id: 'limits', code: 'S-08', name: 'Usage and reliability limits', value: '20 turns per step', source: 'Global default', scope: 'Global or repository within host ceiling', timing: 'New runs use new limits.', detail: 'Hard caps require metrics the selected provider actually reports.', available: true },
  { id: 'skills', code: 'S-09', name: 'Skills and tools', value: 'Bundled only', source: 'Global default', scope: 'Global or repository', timing: 'New runs use approved versions.', detail: 'An external skill cannot expand permissions by installation.', available: false },
  { id: 'testing', code: 'S-10', name: 'Testing and PM QA', value: 'Before merge', source: 'Supervised template', scope: 'Global or repository pipeline', timing: 'New Issues use the selected gate.', detail: 'An approval binds to one exact candidate and disclosed outcome.', search: 'ask before merge', available: true },
  { id: 'delivery', code: 'S-11', name: 'Delivery and artifacts', value: 'Local only', source: 'Global default', scope: 'Global or repository within host ceiling', timing: 'New builds use this destination.', detail: 'Only compatible hosts build packages; publication starts off.', search: 'keep installers', available: false },
  { id: 'privacy', code: 'S-12', name: 'Privacy and data', value: 'Telemetry off', source: 'Global default', scope: 'Global or repository', timing: 'Retention changes affect future cleanup.', detail: 'Local deletion never claims provider or GitHub deletion.', available: false },
  { id: 'appearance', code: 'S-13', name: 'Appearance and accessibility', value: 'System theme', source: 'Host default', scope: 'Host preference', timing: 'Applies to this host.', detail: 'Keep focus, content and reading position when the view changes.', available: false },
  { id: 'updates', code: 'S-14', name: 'Desktop updates', value: 'Stable channel', source: 'Host default', scope: 'Host only', timing: 'Updates install only after a verified idle decision.', detail: 'Automatic download, install and restart are off.', available: false },
  { id: 'diagnostics', code: 'S-15', name: 'Diagnostics and recovery', value: 'Read-only', source: 'Host', scope: 'Host or selected repository', timing: 'Inspection has no runtime effect.', detail: 'See capability, current evidence, pending cleanup and safe repair.', available: false },
]);

export function makeProposal({ repositoryId, settingId, version }) {
  if (!repositories.some(item => item.id === repositoryId)) throw new Error('Unknown repository');
  if (!settings.some(item => item.id === settingId && item.available)) throw new Error('Setting unavailable');
  return Object.freeze({ repositoryId, settingId, version });
}

export function applyProposal(proposal, { repositoryId, settingId, version }) {
  if (!proposal || proposal.repositoryId !== repositoryId) return { applied: false, reason: 'Target changed. Review the proposal again.' };
  if (proposal.settingId !== settingId) return { applied: false, reason: 'Setting changed. Review the proposal again.' };
  if (proposal.version !== version) return { applied: false, reason: 'Setting changed. Refresh the proposal.' };
  return { applied: true, version: version + 1 };
}
