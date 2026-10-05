import { privacyCommand } from './privacy-commands.mjs';
import { containsSecret } from './commands.mjs';
import { skillChatSafe } from './skill-commands.mjs';
import { toolChatSafe } from './tool-commands.mjs';

export async function initPrivacy({ el, message, context, composer, history, show }) {
  const $ = id => document.getElementById(id), tokens = new Map(), pages = new Map(), loading = new Set();
  let state, pending = false, lastMessage, queue = Promise.resolve(), saveWarning = false;
  const category = el('button', 'Privacy and Recovery', 'category-button'); category.id = 'settings-privacy'; category.setAttribute('aria-pressed', 'false');
  document.querySelector('.settings-categories').append(category);
  const section = el('section'); section.id = 'privacy-settings'; section.hidden = true; section.setAttribute('aria-label', 'Privacy and recovery settings'); $('settings-view').append(section);
  const chatPreview = el('section'); chatPreview.id = 'privacy-chat-preview'; chatPreview.setAttribute('aria-label', 'Current privacy preview'); $('composer').before(chatPreview);
  const earlier = el('button', 'Load earlier messages', 'secondary'); earlier.id = 'history-earlier'; earlier.hidden = true;
  earlier.addEventListener('click', () => load(true)); $('transcript').before(earlier);
  function warn() {
    if (saveWarning) return; saveWarning = true;
    message('Conversation could not be saved. Existing records remain protected. Check Privacy and Recovery before closing.', false, context(), false);
    $('announcement').textContent = 'Conversation could not be saved.';
  }
  const invoke = payload => window.pipeliner.privacyRequest({ ...payload, contextRevision: state.revision });
  function enqueue(payload) {
    const work = queue.then(() => invoke(payload)); queue = work.catch(warn); return work;
  }
  function record(text, pm, target, commandId, content) {
    const token = tokens.get(target); if (!token || !state?.storageAvailable) return;
    void enqueue({ operation: 'append', token, commandId, role: pm ? 'pm' : 'app', text }).then(result => { content.textContent = result.text; }, () => {});
  }
  function draft(text, target = context()) {
    const token = tokens.get(target); if (!token || !state?.storageAvailable) return Promise.resolve();
    const action = privacyCommand(text);
    // Confirmation is transient control text; it must not mutate the exact records currently being reviewed.
    if (state.preview?.kind === 'delete' && ['apply', 'cancel'].includes(action?.operation)) return Promise.resolve();
    return enqueue({ operation: 'draft', token, text: containsSecret(text) && !(skillChatSafe(text) || toolChatSafe(text)) ? '' : text });
  }
  async function load(older = false, replace = false, edit = composer().revision) {
    const target = context(), token = tokens.get(target), page = pages.get(target);
    if (!state?.storageAvailable || state.repository !== target || !token || loading.has(target) || older && !page?.more) return;
    const revision = state.revision; loading.add(target); earlier.disabled = true;
    try {
      await queue; const result = await window.pipeliner.privacyRequest({ operation: 'history', contextRevision: revision, ...(older ? { before: page.before } : {}) });
      if (result.repository !== target || context() !== target || tokens.get(target) !== token) return;
      tokens.set(target, result.token); pages.set(target, { before: result.before, more: result.more });
      history({ ...result, older, replace, edit }); earlier.hidden = !result.more;
    } catch { if (context() === target && tokens.get(target) === token) warn(); }
    finally { loading.delete(target); earlier.disabled = false; }
  }
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); node.type = 'button'; node.id = id;
    node.disabled = !state.storageAvailable || (pending || state.busy) && operation !== 'cancel';
    node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function preview(p, suffix = '') {
    const card = el('article', undefined, 'setup-preview'); card.id = 'privacy-preview' + suffix; card.append(el('h3', p.kind === 'delete' ? 'Review local deletion' : p.kind === 'export' ? 'Review local export' : p.kind === 'restore' ? 'Review restored settings' : 'Review retention change'));
    card.append(el('p', 'Scope: ' + p.scope + (p.target ? ' · ' + state.repositoryLabel : '') + '. This preview expires at ' + new Date(p.expiresAt).toLocaleTimeString() + '.'));
    if (p.kind === 'delete') card.append(el('p', p.count + ' eligible records · ' + p.retainedRecovery + ' recovery records retained. Categories: ' + p.categories.join(', ') + '.'),
      el('p', 'A minimal installation audit receipt remains. This does not remove provider/GitHub copies, prior exports or operating-system snapshots.', 'small'),
      ...(p.more ? [el('p', 'This bounded batch has more records. Review another deletion after this batch completes.', 'small')] : []));
    else if (p.kind === 'export') card.append(el('p', 'Destination: ' + p.destination), el('p', 'A new local file is created only after you apply. A sync service for the chosen folder may upload this copy. Review all included text; credentials and raw logs are excluded.', 'small'), el('pre', JSON.stringify(p.document, null, 2), 'tool-schema'));
    else {
      for (const [key, value] of Object.entries(p.after)) card.append(el('p', value.label + ': ' + JSON.stringify(p.before[key].value) + ' becomes ' + JSON.stringify(value.value) + '.'));
      if (p.repair.length) card.append(el('p', 'Needs secure repair: ' + p.repair.join(', ') + '. Work will not start or resume from this restore.', 'small'));
    }
    card.append(button(p.kind === 'delete' ? 'Delete this local batch' : p.kind === 'export' ? 'Save this export' : 'Apply this change', 'apply', { hash: p.hash }, 'privacy-apply' + suffix), button('Cancel change', 'cancel', {}, 'privacy-cancel' + suffix)); return card;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, previous = state, saved = state && JSON.stringify(state.values) === JSON.stringify(snapshot.values) && $('privacy-form')
      ? Object.fromEntries([...$('privacy-form').querySelectorAll('input')].map(node => [node.dataset.key, node.value])) : null;
    state = snapshot;
    if (state.conversationToken) tokens.set(state.repository, state.conversationToken);
    const nodes = [], head = el('article', undefined, 'connection-card'); head.append(el('p', 'Local data, deliberate destinations', 'kicker'), el('h2', 'Privacy and recovery'),
      el('p', 'Conversation records stay on this Mac, protected by the installation key. Repository work may be sent to its selected provider, GitHub or explicitly configured tools.', 'small'),
      el('p', 'Telemetry, automatic diagnostic upload and cross-repository reuse are unavailable and off. Export is a deliberate local copy.', 'small'));
    const scopeRow = el('div', undefined, 'setup-field'), label = el('label', 'Settings scope'), select = el('select'); select.id = 'privacy-scope'; label.htmlFor = select.id;
    for (const [value, text] of [['repository', state.repositoryLabel ?? 'Select a repository first'], ['global', 'Global defaults'], ['host', 'This Mac']]) {
      const option = el('option', text); option.value = value; option.disabled = value === 'repository' && !state.repository; select.append(option);
    }
    select.value = state.scope; select.disabled = !state.storageAvailable || pending || state.busy; select.addEventListener('change', () => request({ operation: 'view', scope: select.value })); scopeRow.append(label, select); head.append(scopeRow);
    if (!state.storageAvailable) head.append(el('p', 'Protected conversation storage is loading or unavailable. Messages are not saved until storage is ready. Unlock macOS Keychain and reopen if needed.', 'availability'));
    else {
      const data = el('dl', undefined, 'connection-data');
      for (const key of ['conversation', 'log', 'audit']) { const row = state.inventory.find(item => item.category === key); data.append(el('dt', key === 'log' ? 'Verbose logs' : key === 'audit' ? 'Minimal audit' : 'Conversations'), el('dd', (row?.count ?? 0) + ' records · ' + (row?.bytes ?? 0).toLocaleString() + ' encrypted payload bytes')); }
      head.append(data, el('p', 'This inventory covers the selected conversation store. Credentials, configuration, ownership and execution evidence have separate protected records. Purging here preserves those records, repository folders and external copies.', 'small'));
    }
    nodes.push(head);
    if (state.values) {
      const form = el('form', undefined, 'connection-card'); form.id = 'privacy-form'; form.append(el('h3', 'Keep the records you need'));
      for (const key of state.scope === 'host' ? ['privacy.totalLogMiB'] : ['privacy.conversationDays', 'privacy.logDays', 'privacy.auditDays', 'privacy.runLogMiB']) {
        const value = state.values[key], row = el('div', undefined, 'setup-field'), label = el('label', value.label + (key.endsWith('MiB') ? ' (MiB)' : ' (days)')), input = el('input');
        input.id = key.replaceAll('.', '-'); label.htmlFor = input.id; input.type = 'number'; input.min = 1; input.max = key === 'privacy.totalLogMiB' ? 100000 : key.endsWith('MiB') ? 10000 : 36500;
        input.step = 1; input.required = true; input.dataset.key = key; input.value = saved?.[key] ?? value.value; input.disabled = !state.storageAvailable || pending || state.busy;
        row.append(label, input, el('p', 'Source: ' + value.source + '. Applies to future cleanup; recovery evidence remains protected.', 'small')); form.append(row);
      }
      const submit = el('button', 'Review retention change', 'primary'); submit.type = 'submit'; submit.disabled = !state.storageAvailable || pending || state.busy; form.append(submit);
      form.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'prepare', changes: Object.fromEntries([...form.querySelectorAll('input')].map(input => [input.dataset.key, Number(input.value)])) }); });
      if (state.scope !== 'host') form.append(button('Use inherited retention', 'prepare', { changes: {}, reset: ['privacy.conversationDays', 'privacy.logDays', 'privacy.auditDays', 'privacy.runLogMiB'] }, 'privacy-reset'));
      nodes.push(form);
    }
    const actions = el('article', undefined, 'connection-card'); actions.append(el('h3', 'Review before copying or removing data'));
    const row = el('div', undefined, 'connection-actions'); row.append(button('Export these settings', 'export', { kind: 'configuration' }, 'privacy-export'), button('Restore settings', 'import', {}, 'privacy-import'),
      button('Inspect diagnostics', 'diagnostics', {}, 'privacy-diagnostics'), button('Export diagnostics', 'export', { kind: 'diagnostics' }, 'privacy-diagnostic-export'));
    if (state.repository) for (const [key, text] of [['conversation', 'Delete local conversations'], ['log', 'Delete verbose logs'], ['audit', 'Delete minimal audit']]) row.append(button(text, 'delete', { categories: [key] }, 'privacy-delete-' + key));
    actions.append(row); nodes.push(actions);
    if (state.preview) nodes.push(preview(state.preview));
    chatPreview.replaceChildren(...(state.preview && state.repository === context() ? [preview(state.preview, '-chat')] : []));
    if (state.diagnostics) { const details = el('details', undefined, 'connection-card'); details.append(el('summary', 'Captured local diagnostics'), el('pre', JSON.stringify(state.diagnostics, null, 2), 'tool-schema')); nodes.push(details); }
    if (state.busy) nodes.push(el('p', 'Finish or cancel the native file panel. Cancel invalidates its result; close the panel with Cancel or Escape.', 'availability'), button('Cancel pending operation', 'cancel', {}, 'privacy-native-cancel'));
    if (state.message) nodes.push(el('p', state.message, 'protected-state'));
    section.replaceChildren(...nodes); if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
    if (state.message && state.message !== lastMessage) { message(state.message, false, state.repository, false); $('announcement').textContent = state.message; lastMessage = state.message; }
    if (state.storageAvailable && context() === state.repository && (!pages.has(state.repository) || !previous?.storageAvailable)) void load();
  }
  async function request(payload, text) {
    if (!state || pending && payload.operation !== 'cancel') return; const target = context(), revision = state.revision, edit = composer().revision; pending = true;
    if (text) message(text, true, target, false);
    if (text && ['view', 'diagnostics'].includes(privacyCommand(text)?.operation)) show();
    try {
      await queue; const result = await window.pipeliner.privacyRequest({ ...payload, contextRevision: revision }); pending = false; render(result.snapshot ?? state);
      if (result.historyChanged) { pages.delete(target); await load(false, true, edit); }
    } catch { pending = false; const current = await window.pipeliner.privacyRequest({ operation: 'status' }); render(current);
      if (!/^Privacy (?:import|restore) failed;/.test(current.message)) message('Privacy action could not finish. Review current scope and create a fresh preview. Existing data is preserved unless a verified result says otherwise.', false, target, false); }
  }
  window.pipeliner.onPrivacy(render); render(await window.pipeliner.privacyRequest({ operation: 'status' }));
  return { handles: text => Boolean(privacyCommand(text)), chat: text => request({ operation: 'chat', text }, text), record, draft,
    flush: () => queue, binding: () => tokens.get(context()), context() { earlier.hidden = !pages.get(context())?.more; chatPreview.replaceChildren(); if (state?.repository === context()) void load(); } };
}
