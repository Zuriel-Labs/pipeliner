import { containsSecret, connectionCommand } from './commands.mjs';
import { initWorkspaces } from './workspaces.mjs';
import { initIssues } from './issues.mjs';
import { initPipelines } from './pipelines.mjs';
import { initDevelopment } from './development.mjs';
import { initScheduling } from './scheduling.mjs';
import { initBackground } from './background.mjs';
import { initSkills } from './skills.mjs';
import { initTools } from './tools.mjs';
import { initPrivacy } from './privacy.mjs';
import { initAppearance } from './appearance.mjs';
import { initDelivery } from './delivery.mjs';
import { initPermissions } from './permissions.mjs';

let state = null, returnFocus = null; const drafts = new Map(), previousBusy = new Set();
const $ = id => document.getElementById(id);
let currentContext = null, privacy, promptRevision = 0; const conversations = new Map();
function setContext(target, label) {
  if (target === currentContext) return;
  conversations.set(currentContext, { nodes: [...$('transcript').childNodes], prompt: $('prompt').value }); currentContext = target;
  const saved = conversations.get(target); $('transcript').replaceChildren(...(saved?.nodes ?? [])); $('prompt').value = saved?.prompt ?? '';
  promptRevision++; privacy?.context();
  $('chat-title').textContent = label ? label : 'Start with a conversation.';
  $('chat-scope').textContent = label ? 'This conversation and Issue controls apply to this repository. Connections remain installation settings.' : 'Connect your accounts here. Keys and sign-in stay in protected surfaces.';
  if (!saved) message(label ? 'Repository selected. Ask to show Issues, draft an Issue or mark a specific Issue Ready.' : 'Connect your accounts or import a project.');
}
const labels = { disconnected: 'Not connected', connecting: 'Waiting for sign-in', refreshing: 'Checking access', testing: 'Testing model', disconnecting: 'Disconnecting', connected: 'Checked', limited: 'Limited / test needed', offline: 'Check needed', reauthentication: 'Sign in again', 'cleanup-required': 'Cleanup needs retry' };
const errors = { cancelled: 'Cancelled. Existing keys stay protected; check the connection before using it.', 'native-entry-cancelled': 'Key entry cancelled.', 'http-401': 'Access was denied. Reconnect or replace your key.', 'http-403': 'The account is missing required access. Check provider permissions.', 'authorization-expired': 'Sign-in expired. Start again.', 'authorization-denied': 'Sign-in was declined.', 'provider-storage-blocked': 'Codex could not verify protected login storage. Reconnect after checking macOS Keychain.', 'secure-storage-unavailable': 'Protected storage is unavailable. Unlock macOS Keychain and reopen Pipeliner.', 'partial-access': 'The resource list was incomplete. Check access again.', 'app-changed': 'The registered GitHub App changed. Its permissions need qualification.', 'capability-unverified': 'This model did not complete the required synthetic tool test.', 'account-changed': 'The signed-in account changed. Reconnect to choose it deliberately.' };

function showSettings(show = true) {
  $('chat-view').hidden = show; $('settings-view').hidden = !show; $('workspace-view').hidden = true; $('issues-view').hidden = true;
  for (const [id, active] of [['chat-nav', !show], ['settings-nav', show], ['repositories-nav', false], ['issues-nav', false]]) { $(id).classList.toggle('current', active); if (active) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current'); }
}
function message(text, pm = false, target = currentContext, persist = true, receipt = crypto.randomUUID()) {
  const article = document.createElement('article'); article.className = `message ${pm ? 'pm' : 'assistant'}`;
  article.dataset.receipt = receipt;
  const label = document.createElement('span'); label.className = 'message-label'; label.textContent = pm ? 'You' : 'Pipeliner';
  const content = document.createElement('p'); content.textContent = text; article.append(label, content);
  if (target === currentContext) { $('transcript').append(article); article.scrollIntoView({ block: 'nearest' }); }
  else { const saved = conversations.get(target) ?? { nodes: [], prompt: '' }; saved.nodes.push(article); conversations.set(target, saved); }
  if (persist) privacy?.record(text, pm, target, receipt, content);
  return article;
}
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function render(snapshot) {
  if (state && snapshot.revision < state.revision) return;
  state = snapshot; const focused = document.activeElement?.id;
  $('storage-state').textContent = state.storageAvailable ? 'Credentials use protected macOS storage. No keys are available to chat or repository workers.' : 'Protected storage is unavailable or still loading. Connections stay blocked. Unlock macOS Keychain and reopen if needed.';
  $('storage-state').className = state.storageAvailable ? 'protected-state' : 'availability';
  const cards = state.connections.map(connection => {
    const card = el('article', undefined, 'connection-card'); card.id = `card-${connection.id}`;
    const heading = el('div', undefined, 'connection-heading'); heading.append(el('h2', connection.name), el('span', labels[connection.health] ?? 'Check needed', 'connection-state')); card.append(heading, el('p', connection.explanation, 'small'));
    const data = el('dl', undefined, 'connection-data');
    for (const [name, value] of [['Destination', connection.destination], ['Account', connection.account ?? 'No verified account'], ['Credential', connection.credentialStatus], ['Last checked', connection.lastVerified ? new Date(connection.lastVerified).toLocaleString() : 'Not checked'], ...(connection.expiresAt ? [['Access expiry', new Date(connection.expiresAt).toLocaleString()]] : [])]) data.append(el('dt', name), el('dd', value));
    card.append(data);
    if (connection.error) card.append(el('p', errors[connection.error] ?? 'The check could not finish. Retry, reconnect, or disconnect; no fallback destination was used.', 'connection-error'));
    if (connection.capability) card.append(el('p', `Model test passed for ${connection.capability.model}. ${connection.capability.scope} ${connection.capability.usage ? 'Reported token usage is recorded.' : 'Token usage is unavailable for this test.'}`, 'availability'));
    if (connection.models.length) {
      const field = el('div', undefined, 'model-field'), label = el('label', 'Model for connection test'); label.htmlFor = `model-${connection.id}`;
      const select = el('select'); select.id = label.htmlFor;
      for (const model of connection.models) { const option = el('option', model.name); option.value = model.id; select.append(option); }
      const chosen = drafts.get(connection.id) ?? connection.selectedModel ?? connection.models.find(m => m.recommended)?.id;
      if (chosen && connection.models.some(m => m.id === chosen)) select.value = chosen;
      select.addEventListener('change', () => drafts.set(connection.id, select.value)); select.disabled = connection.busy;
      field.append(label, select, el('p', 'Test sends a short synthetic prompt and tool result to this provider. It may consume usage. No repository content is sent.', 'test-note')); card.append(field);
    }
    if (connection.repositories.length || connection.projects.length || connection.permissions.length) {
      const details = el('details', undefined, 'resources'); details.append(el('summary', `${connection.repositories.length} repositories · ${connection.projects.length} Projects · permissions`));
      const list = el('ul');
      for (const repo of connection.repositories) list.append(el('li', `${repo.name} · ${repo.private ? 'private' : 'public'} · verified access: ${repo.permissions.join(', ') || 'not reported'}`));
      for (const project of connection.projects) list.append(el('li', `${project.owner} / ${project.title}`));
      for (const permission of connection.permissions) list.append(el('li', permission)); details.append(list);
      if (connection.resourceCompleteness?.projects === false) details.append(el('p', 'Project discovery is limited. Personal Projects may need the separate setup and Projects connection.', 'small'));
      card.append(details);
    }
    const actions = el('div', undefined, 'connection-actions');
    for (const [operation, text] of [['connect', connection.id === 'ollama' ? connection.lastVerified ? 'Replace key' : 'Enter key securely' : connection.lastVerified ? 'Reconnect' : 'Connect'], ['refresh', 'Check access'], ...(connection.models.length ? [['test', 'Test this model']] : []), ...(connection.busy && connection.health !== 'disconnecting' ? [['cancel', 'Cancel']] : []), ['disconnect', connection.cleanupPending ? 'Retry cleanup' : 'Disconnect']]) {
      const button = el('button', text, operation === 'connect' ? 'primary' : 'secondary'); button.id = `${operation}-${connection.id}`;
      button.disabled = !state.storageAvailable || (['connect', 'refresh', 'test'].includes(operation) && (connection.busy || connection.cleanupPending)) || (['refresh', 'test'].includes(operation) && !connection.lastVerified) || (operation === 'test' && !['connected', 'limited'].includes(connection.health));
      button.addEventListener('click', () => request({ operation, connection: connection.id, ...(operation === 'test' ? { model: $(`model-${connection.id}`).value } : {}) })); actions.append(button);
    }
    card.append(actions); return card;
  });
  $('connection-list').replaceChildren(...cards);
  for (const connection of state.connections) {
    if (previousBusy.has(connection.id) && !connection.busy) { const result = `${connection.name}: ${labels[connection.health] ?? 'Check needed'}.${connection.error ? ` ${errors[connection.error] ?? 'The check did not finish. Try again or reconnect.'}` : ''}`; message(result); $('announcement').textContent = result; }
    if (connection.busy) previousBusy.add(connection.id); else previousBusy.delete(connection.id);
  }
  if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
  else if (returnFocus && $(returnFocus) && !$(returnFocus).disabled) { $(returnFocus).focus(); returnFocus = null; }
}
async function request(payload, text) {
  if (!state) return;
  const target = currentContext;
  returnFocus = document.activeElement?.id || 'prompt';
  try {
    const result = await window.pipeliner.request({ ...payload, contextRevision: state.revision });
    if (text && !containsSecret(text)) message(text, true, target);
    if (result.snapshot) render(result.snapshot);
    if (result.message) message(result.message, false, target);
    else if (result.accepted) message('Working on the selected connection. Continue in its protected surface, or use Cancel in Settings.', false, target);
    if (result.choices && target === currentContext) {
      const choices = el('div', undefined, 'suggestions');
      for (const choice of result.choices) { const button = el('button', `Test ${choice.name}`, 'secondary'); button.addEventListener('click', () => request({ operation: 'test', connection: choice.connection, model: choice.model })); choices.append(button); }
      $('transcript').lastElementChild.append(choices);
    }
  } catch { message('This connection or view changed. Check Settings and try again. No new destination was selected.'); render(await window.pipeliner.request({ operation: 'status' })); }
  if (!$('chat-view').hidden) $('prompt').focus();
  else if (returnFocus && $(returnFocus) && !$(returnFocus).disabled) { $(returnFocus).focus(); returnFocus = null; }
}
privacy = await initPrivacy({ el, message, context: () => currentContext, composer: () => ({ value: $('prompt').value, revision: promptRevision }),
  show: () => { showSettings(); $('settings-privacy').click(); }, history: page => {
    if (page.repository !== currentContext) return;
    const before = page.replace ? [] : [...$('transcript').childNodes], known = new Set(before.map(node => node.dataset?.receipt));
    const nodes = [];
    for (const row of page.messages) {
      if (known.has(row.id) || !['pm', 'app'].includes(row.value?.role) || typeof row.value.text !== 'string') continue;
      nodes.push(message(row.value.text, row.value.role === 'pm', currentContext, false, row.id));
    }
    $('transcript').replaceChildren(...nodes, ...before);
    if (!page.older && promptRevision === page.edit && (page.replace || !$('prompt').value)) $('prompt').value = page.draft;
  } });
const workspaces = await initWorkspaces({ el, message, show: () => {
  $('chat-view').hidden = true; $('settings-view').hidden = true; $('workspace-view').hidden = false; $('issues-view').hidden = true;
  for (const id of ['chat-nav', 'settings-nav', 'repositories-nav', 'issues-nav']) { $(id).classList.toggle('current', id === 'repositories-nav'); if (id === 'repositories-nav') $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current'); }
} });
const issues = await initIssues({ el, message, setContext, show: () => {
  for (const id of ['chat-view', 'workspace-view', 'settings-view', 'issues-view']) $(id).hidden = id !== 'issues-view';
  for (const id of ['chat-nav', 'settings-nav', 'repositories-nav', 'issues-nav']) { $(id).classList.toggle('current', id === 'issues-nav'); if (id === 'issues-nav') $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current'); }
} });
const pipelines = await initPipelines({ el, message });
const development = await initDevelopment({ el, message });
const scheduling = await initScheduling({ el, message });
const background = await initBackground({ el, message });
const skills = await initSkills({ el, message });
const tools = await initTools({ el, message });
const appearance = await initAppearance({ el, message, show: () => { showSettings(); $('settings-appearance').click(); } });
const permissions = await initPermissions({ el, message, show: () => { showSettings(); $('settings-permissions').click(); } });
const delivery = await initDelivery({ el, message, show: () => { showSettings(); $('settings-delivery').click(); },
  editRelease: scope => { showSettings(); $('settings-pipelines').click(); pipelines.chat('Edit ' + scope + ' Release pipeline'); } });
$('prompt').addEventListener('input', () => { promptRevision++; void privacy.draft($('prompt').value).catch(() => {}); });
$('composer').addEventListener('submit', event => { event.preventDefault(); const text = $('prompt').value.trim(); if (!text) return;
  if (containsSecret(text) && !(skills.handles(text) && skills.safe(text)) && !(tools.handles(text) && tools.safe(text))) { $('prompt').value = ''; promptRevision++; void privacy.draft('').catch(() => {}); message('Use the protected connection surface for keys. Nothing was sent; protected-looking text was not saved.'); $('prompt').focus(); return; }
  const target = currentContext;
  // Consume only the submitted text before IPC. A later reply must preserve a new draft.
  $('prompt').value = ''; promptRevision++;
  if (privacy.handles(text)) { privacy.chat(text); return; }
  void privacy.draft('', target).catch(() => {});
  if (!connectionCommand(text).connection && appearance.handles(text)) appearance.chat(text);
  else if (!connectionCommand(text).connection && permissions.handles(text)) permissions.chat(text);
  else if (!connectionCommand(text).connection && delivery.handles(text)) delivery.chat(text);
  else if (!connectionCommand(text).connection && skills.handles(text)) skills.chat(text);
  else if (!connectionCommand(text).connection && tools.handles(text)) tools.chat(text);
  else if (!connectionCommand(text).connection && background.handles(text)) background.chat(text);
  else if (!connectionCommand(text).connection && scheduling.handles(text)) scheduling.chat(text);
  else if (!connectionCommand(text).connection && development.handles(text)) development.chat(text);
  else if (!connectionCommand(text).connection && pipelines.handles(text)) pipelines.chat(text);
  else if (!connectionCommand(text).connection && issues.handles(text)) issues.chat(text);
  else if (!connectionCommand(text).connection && workspaces.handles(text)) workspaces.chat(text);
  else request({ operation: 'chat', text }, text);
});
$('chat-nav').addEventListener('click', () => showSettings(false)); $('settings-nav').addEventListener('click', () => showSettings());
for (const category of ['connections', 'pipelines', 'agents', 'schedule', 'background', 'skills', 'privacy', 'appearance', 'delivery', 'permissions']) $('settings-' + category).addEventListener('click', () => {
  $('connection-settings').hidden = category !== 'connections'; $('pipeline-settings').hidden = category !== 'pipelines'; $('agent-settings').hidden = category !== 'agents'; $('schedule-settings').hidden = category !== 'schedule';
  $('background-settings').hidden = category !== 'background';
  $('skill-settings').hidden = category !== 'skills';
  $('tool-settings').hidden = category !== 'skills';
  $('privacy-settings').hidden = category !== 'privacy';
  $('appearance-settings').hidden = category !== 'appearance';
  $('delivery-settings').hidden = category !== 'delivery';
  $('permission-settings').hidden = category !== 'permissions';
  for (const name of ['connections', 'pipelines', 'agents', 'schedule', 'background', 'skills', 'privacy', 'appearance', 'delivery', 'permissions']) $('settings-' + name).setAttribute('aria-pressed', String(name === category));
});
for (const button of document.querySelectorAll('[data-settings]')) button.addEventListener('click', () => showSettings());
for (const button of document.querySelectorAll('[data-chat]')) button.addEventListener('click', () => request({ operation: 'chat', text: button.dataset.chat }, button.dataset.chat));
window.pipeliner.onStatus(render); render(await window.pipeliner.request({ operation: 'status' }));
