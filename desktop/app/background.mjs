import { backgroundCommand } from './background-commands.mjs';

export async function initBackground({ el, message }) {
  let state, pending = false, lastMessage;
  const $ = id => document.getElementById(id), date = value => value == null ? 'None' : new Date(value).toLocaleString();
  const names = { 'not-registered': 'Not registered', enabled: 'Authorized', 'requires-approval': 'macOS approval required', 'not-found': 'Unavailable' };
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); node.id = id;
    node.disabled = pending || state.busy || !state.storageAvailable; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function field(label, id, value) {
    const row = el('div', undefined, 'setup-field'), name = el('label', label), select = el('select'); name.htmlFor = id; select.id = id;
    for (const [value, label] of [['false', 'Off'], ['true', 'On']]) { const option = el('option', label); option.value = value; select.append(option); }
    select.value = String(value); select.disabled = pending || state.busy || !state.storageAvailable || !state.service?.qualified; row.append(name, select); return row;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const draft = state && JSON.stringify(state.values) === JSON.stringify(snapshot.values) && $('background-form') ? {
      enabled: $('background-enabled').value === 'true', login: $('background-login').value === 'true' } : null;
    state = snapshot; const focused = document.activeElement?.id, service = state.service, nodes = [];
    $('background-state').textContent = service?.cleanupPending ? 'Background recovery needed' : service?.effective ? 'Background on' : service?.configured ? 'Background unavailable' : 'Background off';
    $('schedule-host-state').textContent = service?.effective ? 'Authorized background operation keeps checks available after window close.' : 'Keep the app window open for checks. Background operation is off or unavailable.';
    const card = el('article', undefined, 'connection-card'); card.append(el('h2', 'Background operation'), el('p', 'This computer · host settings. Background operation and start at login are separate choices. Both default off.', 'small'));
    const data = el('dl', undefined, 'connection-data');
    for (const [label, value] of [['Requested', service?.configured ? 'On' : 'Off'], ['macOS status', names[service?.authorization] ?? 'Loading'], ['Start at login', service?.startAtLogin ? 'On' : 'Off'], ['Work after window close', service?.effective ? 'Authorized' : 'Unavailable']]) data.append(el('dt', label), el('dd', value));
    card.append(data, el('p', 'Closing the last window pauses work when background operation is off. With authorization on, the same host keeps work running. Quit always pauses and exits. Paused or stopped runs never resume automatically.', 'small'));
    if (!service?.qualified) card.append(el('p', 'Background operation needs the signed Mac application. This development launcher cannot register a background service.', 'availability'));
    if (service?.authorization === 'requires-approval') card.append(el('p', 'macOS authorization is required. Open Login Items, review Pipeliner and allow it there. Pipeliner never changes this permission for you.', 'availability'));
    if (service?.cleanupPending) card.append(el('p', 'Pause or removal could not be verified. Work stays blocked and preserved. Retry cleanup after checking the Mac authorization state.', 'connection-error'));
    const actions = el('div', undefined, 'connection-actions'); actions.append(button('Check status', 'view', {}, 'background-check'));
    if (service?.qualified) actions.append(button('Open macOS authorization', 'authorize', {}, 'background-authorize'));
    if (service?.cleanupPending && !service.configured) actions.append(button('Retry cleanup', 'cleanup', {}, 'background-cleanup'));
    card.append(actions); nodes.push(card);
    if (state.values) {
      const form = el('form', undefined, 'connection-card'); form.id = 'background-form';
      form.append(el('h3', 'Choose how this Mac runs'), field('Continue after window close', 'background-enabled', draft?.enabled ?? state.values['background.enabled'].value),
        field('Start at login', 'background-login', draft?.login ?? state.values['background.startAtLogin'].value),
        el('p', 'macOS may launch the registered bootstrap at login. It exits without connections, workers or model calls unless both settings and macOS authorization allow login execution.', 'small'));
      const review = el('button', 'Review background change', 'primary'); review.type = 'submit'; review.id = 'background-review'; review.disabled = pending || state.busy || !state.storageAvailable || !service?.qualified; form.append(review);
      form.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'prepare', changes: { 'background.enabled': $('background-enabled').value === 'true', 'background.startAtLogin': $('background-login').value === 'true' } }); }); nodes.push(form);
    }
    if (state.preview) {
      const card = el('article', undefined, 'setup-preview'); card.id = 'background-preview'; card.append(el('h3', 'Review changes for this computer'));
      for (const [key, field] of Object.entries(state.preview.after)) card.append(el('p', field.label + ': ' + (state.preview.before[key].value ? 'On' : 'Off') + ' becomes ' + (field.value ? 'On' : 'Off')));
      card.append(el('p', 'macOS controls remain mandatory. Disabling pauses work before removing this service.'), button('Apply this background change', 'apply', { hash: state.preview.hash }, 'background-apply'), button('Cancel change', 'cancel', {}, 'background-cancel')); nodes.push(card);
    }
    for (const check of state.checks) { const card = el('article', undefined, 'connection-card'); card.append(el('h3', check.repository), el('p', 'Last check: ' + date(check.lastAt)), el('p', 'Next check: ' + date(check.nextAt))); nodes.push(card); }
    $('background-settings').replaceChildren(...nodes); if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
    if (state.message && state.message !== lastMessage) { message(state.message); lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || pending) return; pending = true;
    try { const result = await window.pipeliner.backgroundRequest({ ...payload, contextRevision: state.revision }); if (text) message(text, true); pending = false; render(result.snapshot ?? state); }
    catch { pending = false; message('Background change could not finish. Check the current state and recovery controls. Work remains preserved.'); render(await window.pipeliner.backgroundRequest({ operation: 'status' })); }
  }
  window.pipeliner.onBackground(render); render(await window.pipeliner.backgroundRequest({ operation: 'status' }));
  return { handles: text => Boolean(backgroundCommand(text)), chat: text => request({ operation: 'chat', text }, text) };
}
