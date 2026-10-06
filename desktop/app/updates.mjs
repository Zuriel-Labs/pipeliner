import { updateCommand } from './update-commands.mjs';

export async function initUpdates({ el, message, show }) {
  const $ = id => document.getElementById(id), channelName = value => ({ stable: 'Stable', beta: 'Beta', alpha: 'Alpha' })[value];
  let state, requests = 0, lastMessage;
  const category = el('button', 'Desktop Updates', 'category-button'); category.id = 'settings-updates'; category.setAttribute('aria-pressed', 'false'); document.querySelector('.settings-categories').append(category);
  const section = el('section'); section.id = 'update-settings'; section.hidden = true; section.setAttribute('aria-label', 'Desktop update settings'); $('settings-view').append(section);
  const chatPreview = el('section'); chatPreview.id = 'update-chat-preview'; chatPreview.setAttribute('aria-label', 'Current Desktop update preview'); $('composer').before(chatPreview);
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); node.type = 'button'; if (id) node.id = id;
    node.disabled = !state.storageAvailable || requests > 0; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function preview(p, suffix = '') {
    const card = el('article', undefined, 'setup-preview'); card.id = 'update-preview' + suffix;
    card.append(el('h3', 'Review Desktop update channel'), el('p', 'This Mac · configuration version ' + p.baseRevision + '.', 'small'),
      el('p', channelName(p.before['updates.channel'].value) + ' becomes ' + channelName(p.after['updates.channel'].value) + '. Source: ' + p.after['updates.channel'].source + '.'),
      el('p', 'Saves the channel for a future qualified check. No download, installation, restart or background service change.', 'small'),
      button('Apply update change', 'apply', { hash: p.hash }, 'update-apply' + suffix), button('Cancel change', 'cancel', {}, 'update-cancel' + suffix)); return card;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, prior = $('update-channel'),
      draft = state && JSON.stringify(state.values) === JSON.stringify(snapshot.values) && prior ? prior.value : null;
    state = snapshot;
    const head = el('article', undefined, 'connection-card'); head.append(el('p', 'A deliberate update, with a way back', 'kicker'), el('h2', 'Desktop Updates'),
      el('p', 'This Mac only. Repository selection does not change the Desktop update channel.', 'small'));
    const nodes = [head];
    if (!state.storageAvailable) nodes.push(el('p', 'Protected configuration is loading or unavailable. Reopen after unlocking macOS Keychain; saved settings are preserved.', 'availability'));
    else {
      const form = el('form', undefined, 'connection-card'); form.id = 'update-form'; form.append(el('h3', 'Update channel'));
      const row = el('div', undefined, 'setup-field'), label = el('label', 'Desktop update channel'), select = el('select');
      select.id = label.htmlFor = 'update-channel';
      for (const value of ['stable', 'beta', 'alpha']) { const option = el('option', channelName(value)); option.value = value; select.append(option); }
      select.value = draft ?? state.values['updates.channel'].value;
      row.append(label, select, el('p', 'Saved: ' + channelName(state.values['updates.channel'].value) + '. Source: ' + state.values['updates.channel'].source + '. Stable is the default.', 'small'));
      const review = el('button', 'Review update channel', 'primary'); review.type = 'submit'; review.id = 'update-review'; review.disabled = requests > 0;
      form.append(row, review, button('Review Stable default', 'reset', {}, 'update-reset'));
      form.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'prepare', changes: { 'updates.channel': select.value } }); }); nodes.push(form);
      const availability = el('article', undefined, 'connection-card'); availability.id = 'update-availability'; availability.append(el('h3', 'Availability and installation'));
      const data = el('dl', undefined, 'connection-data');
      for (const [name, value] of [['Installed version', state.installedVersion ?? 'Not verified'], ['Trusted source', state.sourceConfigured ? 'Configured reference · reader not qualified' : 'No trusted source configured'],
        ['Last check', 'Not checked'], ['Available release', 'No verified release'], ['Migration and recovery', 'No installation preview or verified rollback target']]) data.append(el('dt', name), el('dd', value));
      availability.append(data, el('p', 'Checking requires a qualified trusted source. Installation requires verified release bytes, an idle host and a reviewed migration/backup plan.', 'availability'),
        el('p', 'No automatic download, installation or restart. Updates cannot enable background operation or change permissions.', 'small'));
      const check = button('Check Now', 'check', {}, 'update-check'), install = button('Install when idle', 'install', {}, 'update-install'); check.disabled = true; install.disabled = true;
      availability.append(check, install); nodes.push(availability);
    }
    if (state.preview) nodes.push(preview(state.preview)); chatPreview.replaceChildren(...(state.preview ? [preview(state.preview, '-chat')] : []));
    if (state.message) nodes.push(el('p', state.message, 'protected-state')); section.replaceChildren(...nodes);
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus({ preventScroll: true });
    else if (!section.hidden && focused?.startsWith('update-')) $('update-channel')?.focus({ preventScroll: true });
    if (state.message && state.message !== lastMessage) { message(state.message); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || requests) return; requests++;
    if (text) message(text, true); if (text && updateCommand(text)?.operation === 'view') show();
    try { const result = await window.pipeliner.updateRequest({ ...payload, contextRevision: state.revision }); requests--; render(result.snapshot ?? state); }
    catch { requests--; render(await window.pipeliner.updateRequest({ operation: 'status' })); message('Update action could not finish. Inspect the saved channel and create a fresh preview.'); }
    if (!$('chat-view').hidden) $('prompt').focus({ preventScroll: true });
  }
  window.pipeliner.onUpdates(render); render(await window.pipeliner.updateRequest({ operation: 'status' }));
  return { handles: text => Boolean(updateCommand(text)), chat: text => request({ operation: 'chat', text }, text) };
}
