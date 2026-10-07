import { updateCommand } from './update-commands.mjs';

export async function initUpdates({ el, message, show }) {
  const $ = id => document.getElementById(id), channelName = value => ({ stable: 'Stable', beta: 'Beta', alpha: 'Alpha' })[value];
  let state, requests = 0, lastMessage;
  const category = el('button', 'Desktop Updates', 'category-button'); category.id = 'settings-updates'; category.setAttribute('aria-pressed', 'false'); document.querySelector('.settings-categories').append(category);
  const section = el('section'); section.id = 'update-settings'; section.hidden = true; section.setAttribute('aria-label', 'Desktop update settings'); $('settings-view').append(section);
  const chatPreview = el('section'); chatPreview.id = 'update-chat-preview'; chatPreview.setAttribute('aria-label', 'Current Desktop update preview'); $('composer').before(chatPreview);
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); node.type = 'button'; if (id) node.id = id;
    node.disabled = operation === 'status' ? requests > 0 : !state.storageAvailable || operation !== 'stop' && (requests > 0 || state.busy || state.recoveryRequired); node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function preview(p, suffix = '') {
    const card = el('article', undefined, 'setup-preview'); card.id = 'update-preview' + suffix;
    card.append(el('h3', 'Review Desktop update settings'), el('p', 'This Mac · configuration version ' + p.baseRevision + '.', 'small'));
    for (const key of Object.keys(p.after)) {
      const text = value => key === 'updates.channel' ? channelName(value) : value ?? 'Checks disabled';
      card.append(el('p', (key === 'updates.channel' ? 'Channel: ' : 'Source: ') + text(p.before[key].value) + ' becomes ' + text(p.after[key].value) + '. Source: ' + p.after[key].source + '.'));
    }
    card.append(el('p', 'Saves settings for a future check. No download, installation, restart or background service change.', 'small'),
      button('Apply update change', 'apply', { hash: p.hash }, 'update-apply' + suffix), button('Cancel change', 'cancel', {}, 'update-cancel' + suffix)); return card;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, prior = $('update-channel'), sourcePrior = $('update-source'),
      draft = state && JSON.stringify(state.values) === JSON.stringify(snapshot.values) && prior ? prior.value : null,
      sourceDraft = state && state.sourceName === snapshot.sourceName && state.sourceConfigured === snapshot.sourceConfigured && sourcePrior ? sourcePrior.value : null;
    state = snapshot;
    const head = el('article', undefined, 'connection-card'); head.append(el('p', 'A deliberate update, with a way back', 'kicker'), el('h2', 'Desktop Updates'),
      el('p', 'This Mac only. Repository selection does not change the Desktop update channel.', 'small'));
    const nodes = [head];
    if (state.recoveryRequired) {
      const card = el('article', undefined, 'connection-card'); card.id = 'update-recovery'; card.append(el('h3', 'Desktop maintenance needs recovery'));
      const saved = state.maintenance;
      if (saved) {
        const phase = { preparing: 'Preparation recorded', staged: 'Installer preparation recorded', verified: 'App verification recorded',
          replacing: 'Replacement outcome needs inspection', relaunching: 'Updated startup needs verification', 'repair-required': 'Repair required' }[saved.phase];
        const data = el('dl', undefined, 'connection-data');
        for (const [name, value] of [['Recorded state', phase], ['Previous version', saved.fromVersion], ['Target version', saved.toVersion],
          ['Installer record', saved.installerRecorded ? 'Recorded' : 'Not recorded'], ['Backup records', saved.backupsRecorded + ' records'],
          ['Prepared app record', saved.candidateRecorded ? 'Recorded' : 'Not recorded'], ['Replacement record', saved.replacementRecorded ? 'Recorded' : 'Not recorded']]) data.append(el('dt', name), el('dd', value));
        card.append(data, el('p', 'These protected records do not freshly verify the files or a successful recovery.', 'small'));
      } else card.append(el('p', 'Protected maintenance details could not be read. Existing app files and data stay preserved.', 'availability'));
      card.append(el('p', 'Keep the installed app and saved data. Work and changing settings stay blocked until recovery is verified. Restart does not replay the interrupted update.', 'availability'),
        el('p', 'Repair, rollback and removal are unavailable in this installation. This view only reads saved records.', 'small'), button('Refresh recovery', 'status', {}, 'update-recovery-refresh'));
      nodes.push(card);
    }
    if (!state.storageAvailable) nodes.push(el('p', state.recoveryRequired ? 'Saved settings are preserved. They reopen after maintenance recovery is verified.'
      : 'Protected configuration is loading or unavailable. Reopen after unlocking macOS Keychain; saved settings are preserved.', 'availability'));
    else {
      const form = el('form', undefined, 'connection-card'); form.id = 'update-form'; form.append(el('h3', 'Update channel'));
      const row = el('div', undefined, 'setup-field'), label = el('label', 'Desktop update channel'), select = el('select');
      select.id = label.htmlFor = 'update-channel';
      for (const value of ['stable', 'beta', 'alpha']) { const option = el('option', channelName(value)); option.value = value; select.append(option); }
      select.value = draft ?? state.values['updates.channel'].value;
      row.append(label, select, el('p', 'Saved: ' + channelName(state.values['updates.channel'].value) + '. Source: ' + state.values['updates.channel'].source + '. Stable is the default.', 'small'));
      select.disabled = Boolean(state.recoveryRequired);
      const review = el('button', 'Review update channel', 'primary'); review.type = 'submit'; review.id = 'update-review'; review.disabled = requests > 0 || state.busy || state.recoveryRequired;
      form.append(row, review, button('Review Stable default', 'reset', {}, 'update-reset'));
      form.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'prepare', changes: { 'updates.channel': select.value } }); }); nodes.push(form);
      const sourceForm = el('form', undefined, 'connection-card'), sourceRow = el('div', undefined, 'setup-field'), sourceLabel = el('label', 'Trusted update source'), sourceSelect = el('select');
      sourceForm.id = 'update-source-form'; sourceSelect.id = sourceLabel.htmlFor = 'update-source';
      const none = el('option', 'Checks disabled'); none.value = ''; sourceSelect.append(none);
      for (const source of state.sources) { const option = el('option', source.name); option.value = source.name; sourceSelect.append(option); }
      if (state.sourceConfigured && !state.sourceName) { const unavailable = el('option', 'Unavailable saved source'); unavailable.value = '__unavailable__'; unavailable.disabled = true; sourceSelect.append(unavailable); }
      const sourceValue = sourceDraft ?? state.sourceName ?? (state.sourceConfigured ? '__unavailable__' : '');
      if (sourceValue && !Array.from(sourceSelect.options).some(option => option.value === sourceValue)) {
        const stale = el('option', 'Source choice no longer available'); stale.value = sourceValue; stale.disabled = true; sourceSelect.append(stale);
      }
      sourceSelect.value = sourceValue;
      const sourceReview = el('button', 'Review update source', 'primary'); sourceReview.type = 'submit'; sourceReview.id = 'update-source-review';
      sourceSelect.disabled = Boolean(state.recoveryRequired);
      sourceReview.disabled = requests > 0 || state.busy || state.recoveryRequired || sourceSelect.selectedOptions[0]?.disabled;
      sourceSelect.addEventListener('change', () => { sourceReview.disabled = requests > 0 || state.busy || state.recoveryRequired || sourceSelect.selectedOptions[0]?.disabled; });
      sourceRow.append(sourceLabel, sourceSelect, el('p', state.sources.length ? 'Choose a host-approved publisher. A check reads signed availability only.' : 'No qualified publisher is available in this installation. Saved settings remain preserved.', 'small'));
      sourceForm.append(sourceRow, sourceReview); sourceForm.addEventListener('submit', event => { event.preventDefault(); if (!sourceSelect.selectedOptions[0]?.disabled) request({ operation: 'source', name: sourceSelect.value || null }); }); nodes.push(sourceForm);
      const availability = el('article', undefined, 'connection-card'); availability.id = 'update-availability'; availability.append(el('h3', 'Availability and installation'));
      const data = el('dl', undefined, 'connection-data');
      for (const [name, value] of [['Installed version', state.installedVersion ?? 'Not verified'], ['Trusted source', state.sourceQualified ? state.sourceName : state.sourceConfigured ? 'Saved source needs qualification or repair' : 'No trusted source configured'],
        ['Last check', state.lastCheck === null ? 'Not checked' : new Date(state.lastCheck).toLocaleString()], ['Available release', state.release ? state.release.version + ' · ' + channelName(state.release.channel) : state.upToDate ? 'No newer signed release provided' : 'No verified release'],
        ['Migration and recovery', state.recoveryRequired ? 'Unresolved Desktop maintenance; work stays blocked' : 'No installation preview or verified rollback target']]) data.append(el('dt', name), el('dd', value));
      if (state.release) data.append(el('dt', 'Release checksum'), el('dd', state.release.sha256), el('dt', 'Release source'), el('dd', state.release.sourceCommit));
      availability.append(data, el('p', state.busy ? 'Checking signed availability. Cancel safely before any installer download.' : 'Availability checks read signed metadata. Installation requires a verified installer, idle work and a recovery plan.', 'availability'),
        el('p', 'No automatic download, installation or restart. Updates cannot enable background operation or change permissions.', 'small'));
      const check = button('Check Now', 'check', {}, 'update-check'), install = button('Install when idle', 'install', {}, 'update-install'); check.disabled ||= !state.sourceQualified; install.disabled = true;
      availability.append(check, install); if (state.busy) availability.append(button('Cancel check', 'stop', {}, 'update-stop')); nodes.push(availability);
    }
    if (state.preview) nodes.push(preview(state.preview)); chatPreview.replaceChildren(...(state.preview ? [preview(state.preview, '-chat')] : []));
    if (state.message) nodes.push(el('p', state.message, 'protected-state')); section.replaceChildren(...nodes);
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus({ preventScroll: true });
    else if (!section.hidden && focused?.startsWith('update-')) {
      const channel = $('update-channel'); (channel && !channel.disabled ? channel : $('update-recovery-refresh'))?.focus({ preventScroll: true });
    }
    if (state.message && state.message !== lastMessage) { message(state.message); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || requests && payload.operation !== 'stop') return; requests++;
    if (text) message(text, true); if (text && updateCommand(text)?.operation === 'view') show();
    try {
      const result = await window.pipeliner.updateRequest(payload.operation === 'status' ? payload : { ...payload, contextRevision: state.revision }); requests--; render(result.snapshot ?? result);
      if (payload.operation === 'status' && state.recoveryRequired) $('announcement').textContent = 'Maintenance recovery refreshed. ' + (state.maintenance ? 'Recorded state: ' + state.maintenance.phase.replaceAll('-', ' ') + '.' : 'Protected maintenance details are unavailable.');
    }
    catch { requests--; render(await window.pipeliner.updateRequest({ operation: 'status' })); message('Update action could not finish. Inspect saved settings and create a fresh preview.'); }
    if (!$('chat-view').hidden) $('prompt').focus({ preventScroll: true });
  }
  window.pipeliner.onUpdates(render); render(await window.pipeliner.updateRequest({ operation: 'status' }));
  return { handles: text => Boolean(updateCommand(text)), chat: text => request({ operation: 'chat', text }, text) };
}
