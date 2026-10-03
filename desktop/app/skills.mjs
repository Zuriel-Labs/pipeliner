import { skillCommand, skillChatSafe } from './skill-commands.mjs';

export async function initSkills({ el, message }) {
  let state, pending = false, lastMessage; const drafts = new Map(), $ = id => document.getElementById(id);
  const context = snapshot => snapshot.scope + ':' + (snapshot.workspaceId ?? 'installation');
  function button(label, operation, extra = {}, id) {
    const node = el('button', label, operation === 'apply' ? 'primary' : 'secondary'); node.id = id;
    node.disabled = pending || state.busy || !state.storageAvailable; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, open = new Set([...document.querySelectorAll('#skill-settings details[open]')].map(node => node.id));
    if (state && $('skill-link')) drafts.set(context(state), $('skill-link').value);
    state = snapshot; const nodes = [], head = el('article', undefined, 'connection-card');
    head.append(el('p', 'Instruction library', 'kicker'), el('h2', 'Skills, with clear authority.'), el('p', 'Choose which instructions future runs use. A skill can guide work; only your permissions authorize tools.', 'small'));
    const row = el('div', undefined, 'setup-field'), label = el('label', 'Skill scope'), scope = el('select'); scope.id = 'skill-scope'; label.htmlFor = scope.id;
    for (const [value, text] of [['repository', state.repositoryLabel ? 'Repository · ' + state.repositoryLabel : 'Repository · select one first'], ['global', 'Global defaults · all repositories']]) {
      const option = el('option', text); option.value = value; option.disabled = value === 'repository' && !state.workspaceId; scope.append(option);
    }
    scope.value = state.scope; scope.disabled = pending || state.busy || !state.storageAvailable; scope.addEventListener('change', () => request({ operation: 'view', scope: scope.value })); row.append(label, scope); head.append(row);
    if (state.values) head.append(el('p', 'Bundled selection: ' + (state.values['skills.bundledEnabled'].value ? 'On' : 'Off') + ' · source: ' + state.values['skills.bundledEnabled'].source + '. Disabled names: ' + state.values['skills.disabled'].source + '. Active runs retain their pins.', 'small'));
    if (state.scope === 'repository') head.append(button('Use inherited skill selection', 'reset', {}, 'skill-reset'));
    if (state.installPermissions) {
      const permission = el('details', undefined, 'resources'); permission.id = 'skill-install-permissions'; permission.open = open.has(permission.id); permission.append(el('summary', 'Agent installation permissions'), el('p', 'Both scopes must allow installation. Only exact sources you authorize can be installed. Content never expands tool permissions.', 'small'));
      for (const scope of ['host', 'repository']) {
        permission.append(el('p', scope + ': ' + (state.installPermissions[scope] ? 'Allowed' : 'Denied'), 'small'));
        if (scope === 'host' || state.workspaceId) permission.append(button('Review ' + (state.installPermissions[scope] ? 'denying' : 'allowing') + ' ' + scope + ' installs', 'permission', { scope, enabled: !state.installPermissions[scope] }, 'skill-permission-' + scope));
      }
      head.append(permission);
    }
    nodes.push(head);
    if (state.error) nodes.push(el('p', state.error, 'connection-error'));
    if (state.preview) {
      const p = state.preview, card = el('article', undefined, 'setup-preview'); card.id = 'skill-preview';
      card.append(el('h3', 'Review ' + p.action + ' · ' + (p.name ?? 'inherited selection')), el('p', 'Scope: ' + (p.action === 'remove' ? 'Application inventory' : p.scope) + '. Affected: ' + (p.affectedRepositories.join(', ') || 'Future registered repositories') + '.'), el('p', p.timing));
      if (p.item) {
        const item = p.item; card.append(el('p', item.purpose), el('p', 'Version ' + item.version + ' · declared license ' + item.license + ' · content ' + item.digest, 'small'),
          el('p', 'Source: ' + (typeof item.source === 'string' ? item.source : item.source.repository + ' @ ' + item.source.commit + ' / ' + item.source.path), 'small'),
          el('p', 'Tools granted: none. Declared requirements: ' + (item.requirements?.join(', ') || 'none') + '.', 'small'));
      }
      card.append(button('Apply this skill change', 'apply', { hash: p.hash }, 'skill-apply'), button('Cancel change', 'cancel', {}, 'skill-cancel')); nodes.push(card);
      if (p.action === 'install') card.append(button('Authorize exact source for agent install', 'prepare', { action: 'authorize', name: p.name }, 'skill-authorize-source'));
    }
    if (state.collision) {
      const card = el('article', undefined, 'setup-preview'); card.id = 'skill-collision'; card.append(el('h3', 'Name already exists: ' + state.collision.name), el('p', 'Choose a relevant available name. Existing content stays intact.'));
      const choices = el('div', undefined, 'connection-actions'); for (const name of state.collision.choices) choices.append(button(name, 'choose', { name }, 'skill-choice-' + name));
      if (!state.collision.choices.length) choices.append(el('p', 'Suggested names are occupied. Cancel and choose another source name.')); card.append(choices, button('Cancel package', 'cancel', {}, 'skill-cancel-package')); nodes.push(card);
    }
    const library = el('div', undefined, 'connection-list'); library.id = 'skill-library';
    for (const item of state.inventory) {
      const card = el('article', undefined, 'connection-card'); card.id = 'skill-' + item.id;
      const heading = el('div', undefined, 'connection-heading'); heading.append(el('h3', item.name), el('span', !item.available ? 'Content unavailable' : item.enabled ? 'Enabled' : 'Disabled', 'connection-state')); card.append(heading, el('p', item.purpose));
      card.append(el('p', item.trigger, 'small'), el('p', item.kind === 'bundled' ? 'Included with Pipeliner · MIT · version ' + item.version : 'External instructions · declared license ' + item.license + ' · version ' + item.version, 'small'));
      const details = el('details', undefined, 'resources'); details.id = 'skill-details-' + item.id; details.open = open.has(details.id); details.append(el('summary', 'Source, exact pin and requirements'),
        el('p', item.sourceLabel), el('p', 'Content digest: ' + item.digest), el('p', 'Original name: ' + item.originalName + '. Tools granted by this package: none.'), el('p', 'Declared requirements: ' + (item.requirements?.join(', ') || 'none') + '. These do not authorize tools.'));
      if (item.compatibility) details.append(el('p', 'Source compatibility: ' + item.compatibility + '. Execution support requires separate qualification.'));
      card.append(details); const actions = el('div', undefined, 'connection-actions');
      if (item.available) actions.append(button(item.enabled ? 'Disable skill' : 'Enable skill', 'prepare', { action: item.enabled ? 'disable' : 'enable', name: item.name }, 'skill-toggle-' + item.id));
      if (item.kind === 'external' && item.available) actions.append(button('Remove from app inventory', 'prepare', { action: 'remove', name: item.name }, 'skill-remove-' + item.id));
      if (item.kind === 'external' && !item.available) {
        card.append(el('p', 'This required pin is unavailable. Inspect its exact source to restore it for future runs. Older runs revoked by removal stay blocked.', 'availability'));
        actions.append(button('Inspect exact source for recovery', 'discover', { source: item.source, name: item.name }, 'skill-restore-' + item.id));
      }
      card.append(actions); library.append(card);
    }
    nodes.push(library);
    const form = el('form', undefined, 'connection-card'); form.id = 'skill-source-form'; form.append(el('h3', 'Inspect a skill source'), el('p', 'Paste a public GitHub skill folder link. Pipeliner reads it, pins its exact version and shows a preview before installation. To update a skill, inspect the same folder again.', 'small'));
    const field = el('div', undefined, 'setup-field'), name = el('label', 'Skill folder link'), input = el('input'); input.id = 'skill-link'; name.htmlFor = input.id; input.type = 'url'; input.maxLength = 1024; input.required = true; input.placeholder = 'https://github.com/owner/repository/tree/main/skills/name'; input.value = drafts.get(context(state)) ?? '';
    input.disabled = pending || state.busy || !state.storageAvailable; input.addEventListener('input', () => drafts.set(context(state), input.value)); field.append(name, input); form.append(field);
    const inspect = el('button', state.busy ? 'Reading source…' : 'Inspect source', 'primary'); inspect.type = 'submit'; inspect.id = 'skill-inspect'; inspect.disabled = pending || state.busy || !state.storageAvailable; form.append(inspect);
    if (state.busy) form.append(button('Cancel discovery', 'cancel', {}, 'skill-cancel-discovery'));
    form.addEventListener('submit', event => { event.preventDefault(); const link = $('skill-link').value.trim();
      if (!skillChatSafe('add skill from ' + link)) { $('skill-link').value = ''; drafts.delete(context(state)); message('Use a public folder link without credentials. Keys stay in protected connection surfaces.'); return; }
      request({ operation: 'discover', link }); }); nodes.push(form, el('p', state.limitation, 'small'));
    $('skill-settings').replaceChildren(...nodes); if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
    if (state.message && state.message !== lastMessage) { message(state.message, false, state.workspaceId); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || pending && payload.operation !== 'cancel') return; const target = state.workspaceId; pending = true;
    if (text) message(text, true, target);
    try { const result = await window.pipeliner.skillRequest({ ...payload, contextRevision: state.revision }); pending = false; render(result.snapshot ?? state); }
    catch { pending = false; render(await window.pipeliner.skillRequest({ operation: 'status' })); message('Skill action could not finish. Check its scope, current source and recovery message.', false, target); }
    if (!$('chat-view').hidden) $('prompt').focus();
  }
  window.pipeliner.onSkills(render); render(await window.pipeliner.skillRequest({ operation: 'status' }));
  return { handles: text => Boolean(skillCommand(text)), safe: skillChatSafe, chat: text => request({ operation: 'chat', text }, text) };
}
