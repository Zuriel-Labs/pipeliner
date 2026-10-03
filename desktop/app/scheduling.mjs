import { schedulingCommand } from './scheduling-commands.mjs';
export async function initScheduling({ el, message }) {
  let state, pending = false, lastMessage; const $ = id => document.getElementById(id);
  const reasonNames = { disabled: 'Scheduled checks are off.', waiting: 'Waiting for the next scheduled check.', checking: 'Checking live eligibility.', 'no-ready-work': 'No Ready work. No model turn requested.', 'dependencies-or-pr': 'Ready work has open dependencies or an open PR. No model turn requested.',
    'active-issue': 'An Issue is active. No new work starts.', 'repository-reserved': 'Development holds this repository. Use its local controls.', 'host-capacity': 'Waiting for host worker capacity.', 'pm-trigger': 'Ready work found. Current policy requires a PM start.', 'development-unqualified': 'Choose a qualified Dev and permissions in Agents and Models.',
    'readback-unavailable': 'Live access or complete readback unavailable. No work started.', 'preflight-blocked': 'Development preflight blocked the start. Inspect Development status and configuration.', 'policy-changed': 'Configuration changed during the check. Check again.', 'recovery-required': 'A previous start needs verified recovery. No start is repeated.', eligible: 'Ready work is eligible.', started: 'Development accepted the verified Issue.' };
  const date = value => value === null || value === undefined ? 'None' : new Date(value).toLocaleString();
  const valueLabel = value => value && typeof value === 'object' ? value.days.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ') + ' at ' + value.time
    : value === null ? 'Not set' : typeof value === 'boolean' ? value ? 'On' : 'Off' : ({ interval: 'Interval', calendar: 'Calendar', 'next-check': 'Wait for next check', immediate: 'Check immediately' }[value] ?? String(value));
  function button(text, operation, extra = {}, id) { const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); if (id) node.id = id; node.disabled = pending || !state.storageAvailable; node.addEventListener('click', () => request({ operation, ...extra })); return node; }
  function field(label, id, value, options, type = 'text') {
    const row = el('div', undefined, 'setup-field'), name = el('label', label), input = el(options ? 'select' : 'input'); name.htmlFor = id; input.id = id;
    if (options) for (const [value, text] of options) { const option = el('option', text); option.value = value; input.append(option); }
    else { input.type = type; input.maxLength = 80; if (type === 'number') { input.min = 1; input.max = 525600; input.step = 1; } }
    input.value = value; input.disabled = pending || !state.storageAvailable; row.append(name, input); return row;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const draft = state?.workspaceId === snapshot.workspaceId && state?.scope === snapshot.scope && JSON.stringify(state.values) === JSON.stringify(snapshot.values) && $('schedule-form') ? {
      'scheduling.enabled': $('schedule-enabled').value === 'true', 'scheduling.mode': $('schedule-mode').value, 'scheduling.intervalMinutes': $('schedule-interval').value,
      'scheduling.calendar': { time: $('schedule-time').value, days: Array.from({ length: 7 }, (_, day) => day).filter(day => $('schedule-day-' + day).checked) },
      'scheduling.timezone': $('schedule-timezone').value, 'scheduling.afterCompletion': $('schedule-completion').value } : null;
    state = snapshot; const focused = document.activeElement?.id, nodes = [];
    const scope = el('article', undefined, 'connection-card'); scope.append(el('h2', 'Scheduling'), el('p', 'Checks use deterministic eligibility. Idle checks do not ask a model.', 'small'));
    const scopeField = field('Schedule scope', 'schedule-scope', state.scope, [['global', 'All repositories · global defaults'], ...(state.workspaceId ? [['repository', state.repositoryLabel]] : [])]);
    scopeField.querySelector('select').addEventListener('change', event => request({ operation: 'view', scope: event.target.value })); scope.append(scopeField); nodes.push(scope);
    if (state.values) {
      const values = draft ?? Object.fromEntries(Object.entries(state.values).map(([key, field]) => [key, field.value])), editor = el('form', undefined, 'connection-card'); editor.id = 'schedule-form';
      editor.append(el('h3', 'Edit schedule'), el('p', 'Current value sources: ' + [...new Set(Object.values(state.values).map(field => field.source))].join(', ') + '. Draft inputs stay local until you review and apply them.', 'small'));
      editor.append(field('Scheduled checks', 'schedule-enabled', String(values['scheduling.enabled']), [['false', 'Off'], ['true', 'On']]), field('Mode', 'schedule-mode', values['scheduling.mode'], [['interval', 'Interval'], ['calendar', 'Calendar']]),
        field('Interval in minutes', 'schedule-interval', values['scheduling.intervalMinutes'], null, 'number'));
      const calendar = values['scheduling.calendar'];
      const days = el('fieldset', undefined, 'issue-selections'); days.append(el('legend', 'Calendar days'));
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].forEach((name, day) => { const row = el('label'), input = el('input'); input.type = 'checkbox'; input.id = 'schedule-day-' + day; input.checked = calendar?.days.includes(day) ?? false; input.disabled = pending; row.append(input, document.createTextNode(name)); days.append(row); });
      editor.append(days, field('Calendar time', 'schedule-time', calendar?.time ?? '', null, 'time'), field('Calendar timezone · saved when applied', 'schedule-timezone', values['scheduling.timezone'] ?? state.suggestedTimezone));
      editor.append(el('p', 'For example, America/Chicago. Choose days, time and timezone for Calendar mode. Skipped times use the first valid time that day; repeated times run once.', 'small'),
        field('After completion', 'schedule-completion', values['scheduling.afterCompletion'], [['next-check', 'Wait for the next check'], ['immediate', 'Check immediately']]),
        el('p', state.trigger === 'schedule' ? 'Current pipeline allows scheduled starts after full Development preflight.' : 'Current pipeline requires PM starts. Enabling checks does not change this authority.', 'availability'));
      const review = el('button', 'Review schedule', 'primary'); review.type = 'submit'; review.id = 'schedule-review'; review.disabled = pending || !state.storageAvailable; editor.append(review);
      editor.addEventListener('submit', event => { event.preventDefault(); const changes = { 'scheduling.enabled': $('schedule-enabled').value === 'true', 'scheduling.mode': $('schedule-mode').value,
        'scheduling.intervalMinutes': Number($('schedule-interval').value), 'scheduling.afterCompletion': $('schedule-completion').value };
        const time = $('schedule-time').value, selectedDays = Array.from({ length: 7 }, (_, day) => day).filter(day => $('schedule-day-' + day).checked);
        changes['scheduling.calendar'] = time || selectedDays.length ? { days: selectedDays, time } : null; changes['scheduling.timezone'] = $('schedule-timezone').value.trim() || null;
        request({ operation: 'prepare', changes }); });
      nodes.push(editor);
      if (state.scope === 'repository') { const actions = el('div', undefined, 'connection-actions'); actions.append(button('Run Now', 'run-now', {}, 'schedule-run-now'), button('Inherit global schedule', 'inherit', {}, 'schedule-inherit')); scope.append(actions); }
    }
    if (state.preview) {
      const card = el('article', undefined, 'setup-preview'); card.id = 'schedule-preview'; card.append(el('h3', 'Review ' + state.scope + ' schedule'), el('p', 'Affected repositories: ' + (state.preview.affectedRepositories.join(', ') || 'Global defaults for future repositories')));
      for (const [key, field] of Object.entries(state.preview.after)) card.append(el('p', field.label + ': ' + valueLabel(state.preview.before[key].value) + ' becomes ' + valueLabel(field.value) + ' · ' + field.source));
      card.append(el('p', 'Applies to future checks. Active runs retain captured policy. Scheduling does not enable background operation.'), button('Apply this schedule', 'apply', { hash: state.preview.hash }, 'schedule-apply'), button('Cancel change', 'cancel', {}, 'schedule-cancel')); nodes.push(card);
    }
    for (const check of state.checks) { const card = el('article', undefined, 'connection-card'); card.append(el('h3', check.repository), el('p', reasonNames[check.reason] ?? 'No check recorded yet.', 'availability'),
      el('p', 'Last check: ' + date(check.lastAt) + (check.catchUp ? ' · Catch-up' : '')), el('p', 'Next check: ' + date(check.nextAt)), el('p', check.eligible ? 'Eligible Issue #' + check.eligible.number + ' since ' + date(check.eligible.at) : 'No pending eligible Issue.')); nodes.push(card); }
    $('schedule-settings').replaceChildren(...nodes); if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
    if (state.message && state.message !== lastMessage) { message(state.message); lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || pending) return; pending = true;
    try { const result = await window.pipeliner.schedulingRequest({ ...payload, contextRevision: state.revision }); if (text) { message(text, true); $('prompt').value = ''; } pending = false; if (result.snapshot && result.snapshot.revision >= state.revision) render(result.snapshot); else render(state); if (result.message) message(result.message); }
    catch { pending = false; message('Schedule change blocked. Check selected scope, calendar inputs and current preview.'); render(await window.pipeliner.schedulingRequest({ operation: 'status' })); }
  }
  window.pipeliner.onScheduling(render); render(await window.pipeliner.schedulingRequest({ operation: 'status' }));
  return { handles: text => Boolean(schedulingCommand(text)), chat: text => request({ operation: 'chat', text }, text) };
}
