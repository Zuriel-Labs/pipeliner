import { permissionCommand, permissionLabels } from './permission-commands.mjs';

export async function initPermissions({ el, message, show }) {
  const $ = id => document.getElementById(id); let state, pending = false, lastMessage;
  const category = el('button', 'Permissions and Local Testing', 'category-button'); category.id = 'settings-permissions'; category.setAttribute('aria-pressed', 'false'); document.querySelector('.settings-categories').append(category);
  const section = el('section'); section.id = 'permission-settings'; section.hidden = true; section.setAttribute('aria-label', 'Permissions and local testing'); $('settings-view').append(section);
  const chatPreview = el('section'); chatPreview.id = 'permission-chat-preview'; chatPreview.setAttribute('aria-label', 'Current permission preview'); $('composer').before(chatPreview);
  const names = values => values.map(value => permissionLabels[value] ?? value).join(', ') || 'None';
  const equal = (a, b) => a.length === b.length && a.every(value => b.includes(value));
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); node.type = 'button'; if (id) node.id = id;
    node.disabled = !state.storageAvailable || pending || state.busy; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function preview(p, suffix = '') {
    const card = el('article', undefined, 'setup-preview'); card.id = 'permission-preview' + suffix;
    card.append(el('h3', 'Review permission change'), el('p', p.scope === 'host' ? 'This Mac’s ceiling affects every repository.' : p.scope === 'global' ? 'Global defaults affect repositories without an override.' : 'Repository: ' + state.repository.name, 'small'),
      el('p', 'Tightening denies the next affected action and safely pauses affected work. Expansion applies to a new run or explicit restart. Regranting cannot revive revoked rights in an old run.'));
    for (const [key, row] of Object.entries(p.after)) card.append(el('h4', row.label), el('p', 'Configured before: ' + names(p.before[key].configuredValue)), el('p', 'Configured after: ' + names(row.configuredValue)), el('p', 'Effective after: ' + names(row.value) + '. Source: ' + row.source + '.', 'small'));
    card.append(button('Apply permission change', 'apply', { hash: p.hash }, 'permission-apply' + suffix), button('Cancel change', 'cancel', {}, 'permission-cancel' + suffix)); return card;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, form = $('permission-form'), unchanged = state && state.scope === snapshot.scope && state.repository?.id === snapshot.repository?.id && JSON.stringify(state.values) === JSON.stringify(snapshot.values) && JSON.stringify(state.capabilities) === JSON.stringify(snapshot.capabilities) && JSON.stringify(state.resources) === JSON.stringify(snapshot.resources),
      draft = unchanged && form ? Object.fromEntries([...form.querySelectorAll('input')].map(input => [input.id, input.checked])) : null;
    state = snapshot;
    const head = el('article', undefined, 'connection-card'); head.append(el('p', 'Control what your Dev can do', 'kicker'), el('h2', 'Permissions and local testing'),
      el('p', 'Your selected workspace and task resources are the boundary. Credentials, PM configuration, authentication and system security controls remain excluded. Provider and OS consent remain required.', 'small'));
    if (state.repository) head.append(el('p', 'Selected repository: ' + state.repository.name), el('p', state.repository.path ?? 'No verified local folder', 'small'));
    const nodes = [head];
    if (!state.storageAvailable) nodes.push(el('p', 'Protected configuration is loading or unavailable. Permission changes remain blocked.', 'availability'));
    else {
      const scopes = el('div', undefined, 'settings-categories'); scopes.setAttribute('role', 'group'); scopes.setAttribute('aria-label', 'Permission scope');
      for (const [scope, label] of [['host', 'This Mac’s ceiling'], ['global', 'Global defaults'], ['repository', 'This repository']]) {
        const node = button(label, 'view', { scope }, 'permission-scope-' + scope); node.setAttribute('aria-pressed', String(state.scope === scope)); if (scope === 'repository' && !state.repository) node.disabled = true; scopes.append(node);
      } nodes.push(scopes);
      const form = el('form', undefined, 'connection-card'); form.id = 'permission-form';
      const key = state.scope === 'host' ? 'permissions.ceiling' : 'permissions.grants', value = state.values[key], group = el('fieldset', undefined, 'permission-group');
      group.append(el('legend', value.label), el('p', 'Source: ' + value.source + '. Checkboxes are draft choices. Saved grants stay in effect until you apply a reviewed change.', 'small'));
      for (const item of state.capabilities) {
        const id = 'permission-' + item.id.replaceAll('.', '-'), label = el('label', undefined, 'permission-option'), input = el('input'), copy = el('span');
        input.type = 'checkbox'; input.id = id; input.dataset.key = key; input.dataset.value = item.id; input.checked = draft?.[id] ?? value.configuredValue.includes(item.id); label.htmlFor = id;
        const allowed = item.available && (state.scope === 'host' || state.values['permissions.ceiling'].value.includes(item.id));
        input.disabled = pending || state.busy || !allowed && !value.configuredValue.includes(item.id);
        copy.append(el('strong', item.label), el('span', !item.available ? 'Not qualified on this Mac. Grant unavailable.' : !allowed ? value.configuredValue.includes(item.id) ? 'Saved grant is above this Mac’s ceiling. Remove it or review the host ceiling.' : 'Above this Mac’s ceiling. Review the host ceiling to grant.' : value.value.includes(item.id) ? 'Saved grant is effective in this scope.' : 'No saved grant in this scope.', 'small'));
        label.append(input, copy); group.append(label);
      } form.append(group);
      if (state.scope !== 'host') {
        const resources = el('fieldset', undefined, 'permission-group'); resources.append(el('legend', 'Additional qualified resources'), el('p', 'Source: ' + state.values['permissions.resources'].source + '. Only already-qualified references can be selected. Ask to allow or revoke qualified resource followed by its displayed name.', 'small'));
        const choices = [...new Set([...state.resources, ...state.values['permissions.resources'].configuredValue])];
        if (!choices.length) resources.append(el('p', 'No additional resource is qualified. The selected workspace remains the existing project boundary.', 'availability'));
        for (const ref of choices) {
          const id = 'permission-resource-' + ref, label = el('label', undefined, 'permission-option'), input = el('input'); input.type = 'checkbox'; input.id = id; input.dataset.key = 'permissions.resources'; input.dataset.value = ref;
          input.checked = draft?.[id] ?? state.values['permissions.resources'].configuredValue.includes(ref); input.disabled = pending || state.busy || !state.resources.includes(ref) && !input.checked; label.htmlFor = id;
          label.append(input, el('span', ref + (state.resources.includes(ref) ? '' : ' · no longer qualified; removal only'))); resources.append(label);
        } form.append(resources);
      }
      const submit = el('button', 'Review permission change', 'primary'); submit.type = 'submit'; submit.disabled = pending || state.busy; form.append(submit);
      form.addEventListener('submit', event => { event.preventDefault(); const changes = {};
        for (const field of state.scope === 'host' ? [key] : [key, 'permissions.resources']) { const selected = [...form.querySelectorAll('input')].filter(input => input.dataset.key === field && input.checked).map(input => input.dataset.value); if (!equal(selected, state.values[field].configuredValue)) changes[field] = selected; }
        request({ operation: 'prepare', scope: state.scope, changes });
      });
      form.append(button('Review reset of this scope', 'reset', {}, 'permission-reset'), button('Review revoking this scope', 'revoke', {}, 'permission-revoke')); nodes.push(form);
      if (state.active) { const active = el('article', undefined, 'connection-card'); active.id = 'permission-active'; active.append(el('h3', 'Current repository work'));
        if (state.active.unavailable) active.append(el('p', 'Captured permission evidence needs repair; no authority is inferred.', 'availability'));
        else active.append(el('p', 'Issue #' + state.active.issue + ' · ' + state.active.control + ' · captured version ' + state.active.policyRevision), el('p', 'Captured: ' + names(state.active.captured)), el('p', 'Remaining authority: ' + names(state.active.effective)), el('p', 'Resources: ' + names(state.active.resources)));
        nodes.push(active);
      }
      if (state.preview) nodes.push(preview(state.preview));
      nodes.push(button('Retry permission recovery', 'repair', {}, 'permission-repair'));
    }
    if (state.message) nodes.push(el('p', state.message, 'protected-state'));
    chatPreview.replaceChildren(...(state.preview ? [preview(state.preview, '-chat')] : [])); section.replaceChildren(...nodes);
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus({ preventScroll: true });
    if (state.message && state.message !== lastMessage) { message(state.message, false); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || pending) return; pending = true;
    if (text) message(text, true); if (text && permissionCommand(text)?.operation === 'view') show();
    try { const result = await window.pipeliner.permissionRequest({ ...payload, contextRevision: state.revision }); pending = false; render(result.snapshot ?? state); }
    catch { pending = false; render(await window.pipeliner.permissionRequest({ operation: 'status' })); message('Permission change could not finish. Review the current ceiling, scope and qualification, then create a fresh preview.'); }
    if (!$('chat-view').hidden) $('prompt').focus({ preventScroll: true });
  }
  window.pipeliner.onPermissions(render); render(await window.pipeliner.permissionRequest({ operation: 'status' }));
  return { handles: text => Boolean(permissionCommand(text)), chat: text => request({ operation: 'chat', text }, text) };
}
