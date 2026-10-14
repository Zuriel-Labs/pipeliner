import { toolCommand, toolChatSafe } from './tool-commands.mjs';

export async function initTools({ el, message }) {
  let state, pending = false, lastMessage; const drafts = new Map(), dataDrafts = new Map(), $ = id => document.getElementById(id);
  const context = snapshot => snapshot.scope + ':' + (snapshot.workspaceId ?? 'installation');
  const idle = () => !pending && !state.busy && state.storageAvailable;
  function button(label, operation, extra = {}, id) {
    const node = el('button', label, operation === 'apply' ? 'primary' : 'secondary'); node.type = 'button'; node.id = id;
    node.disabled = !idle() && operation !== 'cancel'; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function field(parent, label, id, value = '', type = 'text') {
    const row = el('div', undefined, 'setup-field'), name = el('label', label), input = el(type === 'textarea' ? 'textarea' : 'input');
    input.id = id; name.htmlFor = id; if (type !== 'textarea') input.type = type; input.value = value; input.disabled = !idle(); row.append(name, input); parent.append(row); return input;
  }
  function dataForm(item, id) {
    const details = el('details', undefined, 'resources'); details.id = id; details.append(el('summary', 'Review allowed data'),
      el('p', 'Choose categories this exact tool may receive. Pipeline bindings choose actual fields. Changes create a new pin; existing pipeline steps need explicit rebinding.', 'small'));
    const form = el('form'), choices = el('div', undefined, 'issue-selections'), draftKey = context(state) + ':' + id + ':' + item.digest;
    const selected = dataDrafts.get(draftKey) ?? item.dataCategories;
    for (const [key, text] of Object.entries(state.dataOptions)) {
      const label = el('label'), input = el('input'); input.type = 'checkbox'; input.value = key; input.checked = selected.includes(key); input.disabled = !idle();
      input.addEventListener('change', () => dataDrafts.set(draftKey, [...choices.querySelectorAll('input:checked')].map(node => node.value))); label.append(input, el('span', text)); choices.append(label);
    }
    const submit = el('button', 'Preview data selection', 'secondary'); submit.type = 'submit'; submit.disabled = !idle();
    form.append(choices, submit); form.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'data', name: item.name, categories: [...choices.querySelectorAll('input:checked')].map(node => node.value) }); });
    details.append(form); return details;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, open = new Set([...document.querySelectorAll('#tool-settings details[open]')].map(node => node.id));
    if (state && $('tool-endpoint')) drafts.set(context(state), { endpoint: $('tool-endpoint').value, authentication: $('tool-authentication').value,
      command: Object.fromEntries(['name', 'purpose', 'version', 'license', 'script', 'schema', 'timeout'].map(key => [key, $('tool-command-' + key)?.value ?? ''])) });
    state = snapshot; const saved = drafts.get(context(state)) ?? {}, nodes = [], head = el('article', undefined, 'connection-card');
    head.append(el('p', 'Tools and data', 'kicker'), el('h2', 'Tools, within your permissions.'), el('p', 'Add a server or a fixed custom command. Installation adds no pipeline step and grants no access.', 'small'));
    const row = el('div', undefined, 'setup-field'), label = el('label', 'Tool scope'), scope = el('select'); scope.id = 'tool-scope'; label.htmlFor = scope.id;
    for (const [value, text] of [['repository', state.repositoryLabel ? 'Repository · ' + state.repositoryLabel : 'Repository · select one first'], ['global', 'Global defaults · all repositories']]) {
      const option = el('option', text); option.value = value; option.disabled = value === 'repository' && !state.workspaceId; scope.append(option);
    }
    scope.value = state.scope; scope.disabled = !idle(); scope.addEventListener('change', () => request({ operation: 'view', scope: scope.value })); row.append(label, scope); head.append(row);
    if (state.values) head.append(el('p', 'Selection source: ' + state.values['tools.extensions'].source + '. Disabled tools: ' + state.values['tools.disabled'].source + '.', 'small'));
    if (state.scope === 'repository') head.append(button('Use inherited tool selection', 'reset', {}, 'tool-reset'));
    if (state.permissions) {
      const details = el('details', undefined, 'resources'); details.id = 'tool-permissions'; details.append(el('summary', 'Tool invocation permissions'), el('p', 'Both host and repository must allow calls. Exact pins, declared data and pipeline steps remain required. Restricted commands also require worker permissions.', 'small'));
      for (const scope of ['host', 'repository']) {
        details.append(el('p', scope + ': ' + (state.permissions[scope] ? 'Allowed' : 'Denied'), 'small'));
        if (scope === 'host' || state.workspaceId) details.append(button('Review ' + (state.permissions[scope] ? 'denying' : 'allowing') + ' ' + scope + ' calls', 'permission', { scope, enabled: !state.permissions[scope] }, 'tool-permission-' + scope));
      }
      head.append(details);
    }
    nodes.push(head); if (state.error) nodes.push(el('p', state.error, 'connection-error'));
    if (state.preview) {
      const p = state.preview, card = el('article', undefined, 'setup-preview'); card.id = 'tool-preview'; card.append(el('h3', 'Review ' + p.action + ' · ' + (p.name ?? 'tool permission')),
        el('p', 'Scope: ' + (p.action === 'remove' ? 'Application inventory' : p.scope) + '. Affected: ' + (p.affectedRepositories.join(', ') || 'Future registered repositories') + '.'), el('p', p.timing));
      if (p.item) {
        const item = p.item; card.append(el('p', item.purpose), el('p', 'Version ' + item.version + ' · declared license: ' + item.license, 'small'),
          el('p', 'Destination: ' + (item.sourceIdentity.endpoint ?? 'Restricted repository worker') + '. Required permissions: ' + item.permissions.join(', ') + '.', 'small'),
          el('p', 'Allowed data: ' + (item.dataCategories.map(key => state.dataOptions[key]).join(', ') || 'None') + '. Exact pin: ' + item.id, 'small'));
        if (p.action === 'install') card.append(dataForm(item, 'tool-preview-data'));
      }
      card.append(button('Apply this tool change', 'apply', { hash: p.hash }, 'tool-apply'), button('Cancel change', 'cancel', {}, 'tool-cancel'));
      if (p.action === 'install') card.append(button('Authorize exact source for agent install', 'prepare', { action: 'authorize', name: p.name }, 'tool-authorize-source')); nodes.push(card);
    }
    if (state.collision) {
      const card = el('article', undefined, 'setup-preview'); card.id = 'tool-collision'; card.append(el('h3', 'Name already exists: ' + state.collision.name), el('p', 'Choose an available name. Existing content stays intact.'));
      const choices = el('div', undefined, 'connection-actions'); for (const name of state.collision.choices) choices.append(button(name, 'rename', { name }, 'tool-choice-' + name));
      card.append(choices, button('Cancel definition', 'cancel', {}, 'tool-cancel-definition')); nodes.push(card);
    }
    if (state.catalog) {
      const card = el('article', undefined, 'connection-card'); card.id = 'tool-catalog'; card.append(el('h3', 'Server tools'), el('p', state.catalog.endpoint, 'small'));
      for (const tool of state.catalog.tools) {
        const item = el('section'); item.append(el('h4', tool.title || tool.name), el('p', tool.description || 'Server supplied no description.', 'small'), button('Inspect ' + tool.name, 'select', { tool: tool.name }, 'tool-select-' + tool.name)); card.append(item);
      }
      if (state.catalog.rejected.length) card.append(el('p', state.catalog.rejected.length + ' unsupported tool definitions were excluded.', 'availability')); nodes.push(card);
    }
    const library = el('div', undefined, 'connection-list'); library.id = 'tool-library';
    for (const item of state.inventory) {
      const card = el('article', undefined, 'connection-card'); card.id = 'tool-' + item.id;
      const heading = el('div', undefined, 'connection-heading'); heading.append(el('h3', item.name), el('span', !item.available ? 'Content unavailable' : item.enabled ? 'Enabled' : 'Disabled', 'connection-state')); card.append(heading, el('p', item.purpose));
      card.append(el('p', item.kind === 'mcp' ? 'Server destination: ' + item.sourceIdentity.endpoint : 'Fixed command · restricted repository worker', 'small'),
        el('p', 'Version ' + item.version + ' · declared license: ' + item.license, 'small'), el('p', 'Allowed data: ' + (item.dataCategories.map(key => state.dataOptions[key]).join(', ') || 'None'), 'small'));
      const details = el('details', undefined, 'resources'); details.id = 'tool-details-' + item.id; details.append(el('summary', 'Exact definition and typed inputs'),
        el('p', 'Pin: ' + item.id + '. Content: ' + item.digest), el('p', 'Required permissions: ' + item.permissions.join(', ') + '. Installation grants none.'), el('pre', JSON.stringify(item.inputSchema, null, 2), 'tool-schema'));
      card.append(details); const actions = el('div', undefined, 'connection-actions');
      if (item.available) {
        actions.append(button(item.enabled ? 'Disable tool' : 'Enable tool', 'prepare', { action: item.enabled ? 'disable' : 'enable', name: item.name }, 'tool-toggle-' + item.id),
          button('Remove from app inventory', 'prepare', { action: 'remove', name: item.name }, 'tool-remove-' + item.id)); card.append(dataForm(item, 'tool-data-' + item.id));
      } else card.append(el('p', 'Inspect the same source to restore an exact pin for future runs. Removed runs stay blocked.', 'availability'));
      if (item.kind === 'mcp' && item.available) {
        card.append(el('p', item.connection?.hasCredential ? 'Protected bearer credential stored for this exact server.' : 'No saved credential. Anonymous server access only.', 'small'));
        actions.append(button(item.connection?.hasCredential ? 'Replace credential securely' : 'Enter credential securely', 'credential', { name: item.name, action: 'connect' }, 'tool-connect-' + item.id));
        if (item.connection?.hasCredential) actions.append(button('Disconnect server credential', 'credential', { name: item.name, action: 'disconnect' }, 'tool-disconnect-' + item.id));
      }
      card.append(actions); library.append(card);
    }
    nodes.push(library);
    const form = el('form', undefined, 'connection-card'); form.id = 'tool-source-form'; form.append(el('h3', 'Inspect a tool server'), el('p', 'Use a public HTTPS server address. Inspection reads its catalog without sending Issue content or calling a tool. Update by inspecting the same server again.', 'small'));
    const endpoint = field(form, 'Server address', 'tool-endpoint', saved.endpoint ?? '', 'url'); endpoint.required = true; endpoint.maxLength = 2048; endpoint.placeholder = 'https://example.com/mcp';
    const authRow = el('div', undefined, 'setup-field'), authLabel = el('label', 'Server authentication'), auth = el('select'); auth.id = 'tool-authentication'; authLabel.htmlFor = auth.id;
    for (const [value, text] of [['none', 'Anonymous or existing saved credential'], ['bearer', 'Enter or replace a bearer credential securely']]) { const option = el('option', text); option.value = value; auth.append(option); }
    auth.value = saved.authentication ?? 'none'; auth.disabled = !idle(); authRow.append(authLabel, auth); form.append(authRow);
    const inspect = el('button', state.busy ? 'Checking server…' : 'Inspect server', 'primary'); inspect.id = 'tool-inspect'; inspect.type = 'submit'; inspect.disabled = !idle(); form.append(inspect);
    form.addEventListener('submit', event => { event.preventDefault(); if (!toolChatSafe('inspect tool server from ' + endpoint.value)) { endpoint.value = ''; drafts.delete(context(state)); message('Use an address without credentials. Enter credentials only in the protected native field.'); return; }
      request({ operation: 'discover', endpoint: endpoint.value.trim(), authentication: auth.value }); }); nodes.push(form);
    const custom = el('details', undefined, 'connection-card'); custom.id = 'tool-custom-command'; custom.append(el('summary', 'Advanced · fixed custom command'), el('p', 'Expert definitions run in the restricted repository worker. Core PM tasks do not require a command. Scripts cannot grant host access or permissions.', 'small'));
    const commandForm = el('form'), values = {};
    for (const [key, text, value, type] of [['name', 'Unique tool name', '', 'text'], ['purpose', 'Purpose', '', 'text'], ['version', 'Declared version', '1', 'text'], ['license', 'Declared license', 'No license declared', 'text'],
      ['script', 'Fixed command', '', 'textarea'], ['schema', 'Typed input schema · JSON', '{"type":"object","additionalProperties":false}', 'textarea'], ['timeout', 'Timeout in seconds', '30', 'number']]) {
      values[key] = field(commandForm, text, 'tool-command-' + key, saved.command?.[key] || value, type); values[key].required = true; values[key].maxLength = key === 'schema' ? 16384 : key === 'script' ? 4096 : 240;
    }
    values.timeout.min = 1; values.timeout.max = 300; const define = el('button', 'Preview fixed command', 'secondary'); define.type = 'submit'; define.disabled = !idle(); commandForm.append(define);
    commandForm.addEventListener('submit', event => { event.preventDefault(); try { const definition = { name: values.name.value.trim(), purpose: values.purpose.value.trim(), version: values.version.value.trim(), license: values.license.value.trim(), dataCategories: [],
      command: { script: values.script.value, timeoutSeconds: Number(values.timeout.value), inputSchema: JSON.parse(values.schema.value) } }; request({ operation: 'define', definition }); }
      catch { message('Input schema must be valid JSON. The command definition was not sent.', false, state.workspaceId); } }); custom.append(commandForm); nodes.push(custom);
    if (state.busy) nodes.push(button('Cancel tool operation', 'cancel', {}, 'tool-cancel-operation'));
    nodes.push(el('p', state.limitation, 'small')); $('tool-settings').replaceChildren(...nodes);
    for (const id of open) if ($(id)) $(id).open = true;
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
    if (state.message && state.message !== lastMessage) { message(state.message, false, state.workspaceId); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || pending && payload.operation !== 'cancel') return; const target = state.workspaceId; pending = true; if (text) message(text, true, target);
    try { const result = await window.pipeliner.toolRequest({ ...payload, contextRevision: state.revision }); pending = false; render(result.snapshot ?? state); }
    catch { pending = false; render(await window.pipeliner.toolRequest({ operation: 'status' })); message('Tool action did not finish. Check its scope, destination and recovery message.', false, target); }
    if (!$('chat-view').hidden) $('prompt').focus();
  }
  window.pipeliner.onTools(render); render(await window.pipeliner.toolRequest({ operation: 'status' }));
  return { handles: text => Boolean(toolCommand(text)), safe: toolChatSafe, chat: text => request({ operation: 'chat', text }, text) };
}
