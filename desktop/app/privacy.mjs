import { privacyCommand } from './privacy-commands.mjs';
import { containsSecret } from './commands.mjs';
import { skillChatSafe } from './skill-commands.mjs';
import { toolChatSafe } from './tool-commands.mjs';
import { permissionLabels } from './permission-commands.mjs';

export async function initPrivacy({ el, message, context, composer, history, show }) {
  const $ = id => document.getElementById(id), tokens = new Map(), pages = new Map(), loading = new Set();
  let state, pending = false, lastMessage, queue = Promise.resolve(), saveWarning = false;
  const category = el('button', 'Privacy and Data', 'category-button'); category.id = 'settings-privacy'; category.setAttribute('aria-pressed', 'false');
  document.querySelector('.settings-categories').append(category);
  const section = el('section'); section.id = 'privacy-settings'; section.hidden = true; section.setAttribute('aria-label', 'Privacy and data settings'); $('settings-view').append(section);
  const recoveryCategory = el('button', 'Diagnostics and Recovery', 'category-button'); recoveryCategory.id = 'settings-recovery'; recoveryCategory.setAttribute('aria-pressed', 'false');
  document.querySelector('.settings-categories').append(recoveryCategory);
  const recoverySection = el('section'); recoverySection.id = 'recovery-settings'; recoverySection.hidden = true; recoverySection.setAttribute('aria-label', 'Diagnostics and recovery settings'); $('settings-view').append(recoverySection);
  const recoveryHeader = el('article', undefined, 'connection-card'), recoveryStatus = el('p'), recoveryContent = el('div'); recoveryContent.id = 'recovery-content';
  const refresh = el('button', 'Refresh local status', 'secondary'); refresh.id = 'recovery-refresh'; refresh.type = 'button'; refresh.addEventListener('click', () => request({ operation: 'recovery' }));
  recoveryHeader.append(el('p', 'Inspect before recovery', 'kicker'), el('h2', 'Diagnostics and recovery'),
    el('p', 'This view reads local records. Recorded worker state does not verify a live process. Refresh does not reconnect, resume, remove data or upload anything.', 'small'), recoveryStatus, refresh);
  const recoveryActions = el('article', undefined, 'connection-card'); recoveryActions.append(el('h3', 'Choose the control you need'));
  const recoveryButtons = el('div', undefined, 'connection-actions');
  for (const [id, label, target, focus] of [['connections', 'Review secure connections', 'connections'], ['permissions', 'Review permissions', 'permissions'],
    ['work', 'Review work and recovery', 'agents'], ['background', 'Review background operation', 'background'], ['artifacts', 'Review retained artifacts', 'delivery'],
    ['restore', 'Review settings restore', 'privacy', 'privacy-import'], ['diagnostics', 'Review diagnostic export', 'privacy', 'privacy-diagnostic-export']]) {
    const button = el('button', label, 'secondary'); button.id = 'recovery-' + id; button.type = 'button';
    button.addEventListener('click', () => { show(target); if (focus) $(focus)?.focus({ preventScroll: true }); }); recoveryButtons.append(button);
  }
  recoveryActions.append(recoveryButtons, el('p', 'Restore validates a nonsecret settings export in the selected scope. Credentials and authority-bearing references need secure repair. Existing work never resumes from an import.', 'small'));
  recoverySection.append(recoveryHeader, recoveryContent, recoveryActions);
  const chatPreview = el('section'); chatPreview.id = 'privacy-chat-preview'; chatPreview.setAttribute('aria-label', 'Current privacy preview'); $('composer').before(chatPreview);
  const earlier = el('button', 'Load earlier messages', 'secondary'); earlier.id = 'history-earlier'; earlier.hidden = true;
  earlier.addEventListener('click', () => load(true)); $('transcript').before(earlier);
  function warn() {
    if (saveWarning) return; saveWarning = true;
    message('Conversation could not be saved. Existing records remain protected. Check Diagnostics and Recovery before closing.', false, context(), false);
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
  function renderRecovery() {
    refresh.disabled = state.busy; const view = state.recovery, nodes = [];
    recoveryStatus.textContent = view ? 'Local records captured at ' + new Date(view.createdAt).toLocaleTimeString() + '. Selected repository: ' + (state.repositoryLabel ?? 'none') + '.'
      : 'Local status has not been captured or changed since capture. Refresh to inspect the current records.';
    if (!view) nodes.push(el('p', 'Protected storage may be loading or unavailable. Existing data is preserved; secure connection controls remain available.', 'availability'));
    else {
      const connections = el('article', undefined, 'connection-card'); connections.id = 'recovery-connection-health'; connections.append(el('h3', 'Connections'));
      for (const [key, label] of [['github', 'GitHub'], ['codex', 'Codex'], ['ollama', 'Ollama']]) connections.append(el('p', label + ': ' + view.connections[key] + '.'));
      const work = el('article', undefined, 'connection-card'); work.id = 'recovery-work-inventory'; const execution = view.execution;
      work.append(el('h3', 'Recorded work and resources'), el('p', execution.activeRuns + ' reserved runs · ' + execution.retainedRuns + ' retained recovery records · ' + execution.uncertainEffects + ' uncertain effects across this installation.'),
        el('p', 'Execution supervisor: ' + (execution.supervisorAvailable ? 'available' : 'unavailable') + '. This does not qualify native app installation or automation.', 'small'));
      const selected = execution.selected;
      work.append(el('p', selected ? 'Selected Issue #' + selected.issue + ': ' + selected.control + '. Recorded worker: ' + (selected.worker ?? 'not recorded') + '. '
        + selected.uncertainEffects + ' uncertain effects.' + (selected.controlPending ? ' A control or effect is pending.' : '') : 'No reserved run in the selected repository.'));
      work.append(el('p', 'Uncertain effects need scoped readback before replay. Use the existing work controls; this inspection grants no recovery authority.', 'small'));
      const services = el('article', undefined, 'connection-card'); services.id = 'recovery-service-health'; const background = view.background;
      services.append(el('h3', 'Background operation'), el('p', 'Configured: ' + (background.configured ? 'on' : 'off') + '. Effective: ' + (background.effective ? 'on' : 'off') + '.'),
        el('p', 'Package qualification: ' + (background.qualified ? 'qualified' : 'unqualified') + '. OS authorization: ' + background.authorization + '.'),
        el('p', background.cleanupPending ? 'Owned background cleanup remains unverified. Existing records are retained; review Background operation.' : 'No background cleanup is reported pending. Other resource cleanup has not been inspected.'));
      const permissions = el('details', undefined, 'connection-card'); permissions.id = 'recovery-permission-health'; permissions.append(el('summary', 'Permission availability and current scope'));
      for (const [key, label] of [['available', 'Host capability catalog'], ['ceiling', 'Host ceiling'], ['grants', 'Selected repository grants'], ['effective', 'Current run authority']]) {
        const value = view.permissions[key]; permissions.append(el('p', label + ': ' + (value === null ? 'no current run' : value.length ? value.map(id => permissionLabels[id]).join(', ') : 'none') + '.'));
      }
      nodes.push(connections, work, services, permissions);
    }
    const backups = el('article', undefined, 'connection-card'); backups.id = 'recovery-backup-inventory'; const inventory = state.managedInventory?.find(item => item.id === 'migration');
    backups.append(el('h3', 'Compatible backups and restore'), el('p', inventory && inventory.state !== 'unavailable'
      ? inventory.count + ' compatible migration archive files · ' + inventory.bytes.toLocaleString() + ' bytes.' : 'Compatible archive inventory is not verified.'),
      el('p', 'File counts do not verify archive contents or a successful restore. Migration archives stay protected; they are never automatically restored or used to replay work.', 'small'));
    nodes.push(backups);
    if (state.diagnostics) { const details = el('details', undefined, 'connection-card'); details.append(el('summary', 'Captured redacted diagnostics'), el('pre', JSON.stringify(state.diagnostics, null, 2), 'tool-schema')); nodes.push(details); }
    const expanded = $('recovery-permission-health')?.open; recoveryContent.replaceChildren(...nodes); if ($('recovery-permission-health')) $('recovery-permission-health').open = Boolean(expanded);
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, previous = state, saved = state && JSON.stringify(state.values) === JSON.stringify(snapshot.values) && $('privacy-form')
      ? Object.fromEntries([...$('privacy-form').querySelectorAll('input')].map(node => [node.dataset.key, node.value])) : null;
    state = snapshot;
    if (state.conversationToken) tokens.set(state.repository, state.conversationToken);
    const nodes = [], head = el('article', undefined, 'connection-card'); head.append(el('p', 'Local data, deliberate destinations', 'kicker'), el('h2', 'Privacy and data'),
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
      if (state.artifacts && !state.artifacts.unavailable) data.append(el('dt', 'Repository artifacts'), el('dd', state.artifacts.count + ' allocations · ' + state.artifacts.bytes.toLocaleString() + ' reserved bytes · ' + state.artifacts.held + ' protected or interrupted'), el('dt', 'Artifact receipts'), el('dd', state.artifacts.receipts + ' minimal command identities retained after archive removal'));
      head.append(data, el('p', 'These counts belong to the selected repository. Conversation deletion preserves credentials, configuration, execution evidence, artifact receipts, repository folders and external copies. Artifact retention uses Delivery and Artifacts.', 'small'));
      if (state.artifacts?.unavailable) head.append(el('p', 'Artifact inventory needs protected repair. Its existing bytes remain preserved; other data controls remain available.', 'availability'));
      if (state.repository) { const manage = el('button', 'Manage artifact data', 'secondary'); manage.type = 'button'; manage.id = 'privacy-artifacts'; manage.addEventListener('click', () => { $('settings-nav').click(); $('settings-delivery').click(); }); head.append(manage); }
    }
    nodes.push(head);
    const installation = el('article', undefined, 'connection-card'); installation.id = 'privacy-installation-inventory'; installation.append(el('h3', 'Installation data on this Mac'),
      el('p', 'These stores are shared across repositories. This inventory reads bounded file metadata, not payload contents. Sizes include known database side files. External provider/GitHub copies and OS Keychain items are outside these local file counts.', 'small'));
    if (!state.managedInventory) installation.append(el('p', 'Installation inventory unavailable. Existing data remains preserved.', 'availability'));
    else for (const item of state.managedInventory) {
      const details = el('details'), size = item.state === 'unavailable' ? 'not verified' : item.state === 'empty' ? 'no files yet' : (item.bytes / 1024 ** 2).toFixed(2) + ' MiB · ' + item.count + ' files';
      details.dataset.category = item.id; details.append(el('summary', item.label + ' · ' + size), el('p', 'Destination: local installation. Scope: shared installation.', 'small'), el('p', 'Protection method: ' + item.protection + '.', 'small'), el('p', item.retention + '.', 'small'));
      if (item.state === 'unavailable') details.append(el('p', 'Ownership or inventory bounds could not be verified. No payload contents were read or copied; no files were removed.', 'availability'));
      installation.append(details);
    }
    nodes.push(installation);
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
    section.replaceChildren(...nodes); renderRecovery(); if (focused && $(focused) && !$(focused).disabled) $(focused).focus({ preventScroll: true });
    if (state.message && state.message !== lastMessage) { message(state.message, false, state.repository, false); $('announcement').textContent = state.message; lastMessage = state.message; }
    if (state.storageAvailable && context() === state.repository && (!pages.has(state.repository) || !previous?.storageAvailable)) void load();
  }
  async function request(payload, text) {
    if (!state || pending && payload.operation !== 'cancel') return; const target = context(), revision = state.revision, edit = composer().revision; pending = true;
    if (text) message(text, true, target, false);
    const operation = text ? privacyCommand(text)?.operation : payload.operation;
    if (text && ['view', 'diagnostics', 'recovery'].includes(operation)) show(operation === 'view' ? 'privacy' : 'recovery');
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
