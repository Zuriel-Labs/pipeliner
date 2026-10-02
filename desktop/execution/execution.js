'use strict';
let revision = null, refreshing = false;
const controls = [...document.querySelectorAll('[data-operation]')];
const labels = { running: 'Running', 'pause-requested': 'Pause received', 'stop-requested': 'Stop received', paused: 'Paused', stopped: 'Stopped', 'recovery-required': 'Recovery required' };
function render(value) {
  revision = value.contextRevision;
  const { run, pending, error } = value;
  const state = error ? 'Blocked' : pending ? { pause: 'Pause received', resume: 'Resume received', stop: 'Stop received' }[pending] : labels[run?.control] ?? 'No active run';
  document.getElementById('target').textContent = run ? `${value.repositoryLabel ?? run.repository} · Issue #${run.issue}` : 'Choose a repository with active work.';
  document.getElementById('state').textContent = state;
  document.querySelector('.state').dataset.pending = String(Boolean(pending || run?.control.endsWith('-requested')));
  const detail = error ?? (pending ? 'Request received. Verifying execution before confirming the result.' : run?.control === 'recovery-required' ? 'Previous execution needs recovery. Resume verifies the worker and saved work.' : run?.control === 'running' ? 'Work may continue within your configured permissions.' : run ? 'Worker stopped. Your Issue, files and reservation are preserved.' : 'No worker is running for this repository.');
  if (document.getElementById('detail').textContent !== detail) document.getElementById('detail').textContent = detail;
  for (const button of controls) { button.disabled = false; button.setAttribute('aria-disabled', String(button.dataset.operation !== 'status' && (!run || button.dataset.operation !== 'stop' && (Boolean(pending) || run.control.endsWith('-requested'))))); }
  const alert = document.getElementById('error'); alert.hidden = !error; alert.textContent = error ?? '';
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try { const result = await window.executionControl.dispatch({ operation: 'status' }); if (!result.ok) throw new Error(result.error); render(result.value); }
  catch { document.getElementById('state').textContent = 'Unavailable'; const error = document.getElementById('error'); error.textContent = 'Local controls are unavailable. Reopen this repository to reconnect.'; error.hidden = false; for (const button of controls) button.disabled = button.dataset.operation !== 'status'; }
  finally { refreshing = false; }
}
for (const button of controls) button.addEventListener('click', async () => {
  if (button.getAttribute('aria-disabled') === 'true') return;
  if (button.dataset.operation === 'status') return refresh();
  try { const result = await window.executionControl.dispatch({ operation: button.dataset.operation, contextRevision: revision }); if (!result.ok) throw new Error(result.error); await refresh(); }
  catch { const error = document.getElementById('error'); error.textContent = 'Control request could not be applied. Refresh Status and try again.'; error.hidden = false; }
});
refresh(); const timer = setInterval(refresh, 500); window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
window.executionControl.onBlocked(message => { const error = document.getElementById('error'); error.textContent = message; error.hidden = false; });
