export async function initWorkspaces({ el, message, show }) {
  let state = null, lastMessage = null, lastQuestion = null; const $ = id => document.getElementById(id);
  const errors = { 'setup-incomplete': 'Resolve the remaining choices, then review setup.', 'connection-unavailable': 'Connect GitHub first. Creating repositories or using personal Projects also needs the separate setup and Projects connection.',
    'local-identity-invalid': 'The selected folder and GitHub repository do not match, or local identity could not be inspected. Choose the correct checkout; existing work is preserved.',
    'folder-exists': 'That destination already exists. Choose a different parent folder or import the existing checkout.',
    'folder-unavailable': 'Choose a project folder you own, outside application and system storage.',
    'folder-changed': 'The chosen folder changed. Choose it again.', 'repository-unavailable': 'The repository is unavailable, already exists, or does not provide the required access.',
    'field-conflict': 'Choose distinct existing selection fields below. Incompatible or duplicate fields are preserved.',
    'setup-changed': 'The target, connection or Project changed. Review a fresh setup before applying.',
    'setup-expired': 'This preview expired. Review setup again.', 'setup-uncertain': 'A previous effect has an uncertain result. It will not be repeated. Inspect the existing result before using it.',
    'installation-access-required': 'Grant this repository to the scoped GitHub App, then continue setup.',
    'project-unavailable': 'Choose an editable Project owned by this repository owner, or a new private Project.',
    'partial-access': 'The resource list was incomplete. Check access and review again.', cancelled: 'Setup cancelled; existing work and created resources are preserved.' };
  const roles = ['Status', 'Priority', 'Impact', 'Effort'];
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary');
    if (id) node.id = id;
    node.disabled = !state.storageAvailable || state.busy && operation !== 'cancel';
    node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function field(label, value, options, change, id) {
    const row = el('div', undefined, 'setup-field'), name = el('label', label), input = options ? el('select') : el('input');
    input.id = id; name.htmlFor = id; input.disabled = state.busy; if (!options) { input.type = 'text'; input.maxLength = label === 'Purpose' ? 350 : 100; input.autocomplete = 'off'; }
    if (options) {
      const placeholder = el('option', 'Choose…'); placeholder.value = ''; input.append(placeholder);
      for (const item of options) { const option = el('option', item.name); option.value = item.value; option.disabled = item.disabled ?? false; input.append(option); }
    }
    input.value = value ?? ''; input.addEventListener('change', () => { if (input.value) change(input.value); }); row.append(name, input); return row;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id; state = snapshot;
    $('workspace-context').textContent = state.workspaces.find(workspace => workspace.id === state.selected)?.name ?? 'No project selected';
    const list = state.workspaces.map(workspace => {
      const card = el('article', undefined, 'connection-card'); card.append(el('h2', workspace.name), el('p', workspace.private ? 'Private repository' : 'Public repository', 'small'),
        el('p', workspace.path, 'small'), el('p', workspace.project.owner.login + ' / ' + workspace.project.title, 'small'));
      card.append(button(state.selected === workspace.id ? 'Selected' : 'Select project', 'select', { workspace: workspace.id })); return card;
    });
    $('workspace-list').replaceChildren(...list);
    const draft = state.draft, nodes = [];
    if (draft) {
      const card = el('article', undefined, 'connection-card'); card.id = 'setup-card';
      const states = { choosing: 'Choose your project', preview: 'Review this setup', applying: 'Applying setup', complete: 'Project connected', cancelled: 'Setup cancelled', failed: 'Setup needs attention', uncertain: 'Result needs inspection', 'waiting-access': 'Scoped access needed', 'recovery-required': 'Setup needs readback' };
      card.append(el('h2', states[draft.state] ?? 'Project setup'), el('p', state.message ?? 'Resolve the choices below.', 'small'));
      if (draft.error) card.append(el('p', errors[draft.error] ?? 'The check could not finish. Check access and review the selected target again.', 'connection-error'));
      const locked = ['applying', 'waiting-access', 'uncertain', 'recovery-required', 'complete', 'cancelled'].includes(draft.state);
      if (!locked) {
        const values = draft.values;
        if (draft.mode === 'create') {
          card.append(field('Owner', values.owner, state.owners.map(owner => ({ value: owner.login, name: owner.login })), value => request({ operation: 'choose', field: 'owner', value }), 'setup-owner'),
            field('Name', values.name, null, value => request({ operation: 'choose', field: 'name', value }), 'setup-name'),
            field('Purpose', values.purpose, null, value => request({ operation: 'choose', field: 'purpose', value }), 'setup-purpose'),
            field('Visibility', values.visibility, [{ value: 'private', name: 'Private · recommended' }, { value: 'public', name: 'Public' }], value => request({ operation: 'choose', field: 'visibility', value }), 'setup-visibility'));
        } else if (draft.mode !== 'local') {
          card.append(field('Repository', values.repository, state.repositories.map(repo => ({ value: repo.name, name: repo.name + (repo.private ? ' · Private' : ' · Public') })), value => request({ operation: 'choose', field: 'repository', value }), 'setup-repository'),
            field('Local workspace', values.source ?? 'download', [{ value: 'download', name: 'Download into a new folder' }, { value: 'local', name: 'Use my existing checkout' }], value => request({ operation: 'choose', field: 'source', value }), 'setup-source'));
        }
        card.append(button(draft.folder ? 'Change folder' : draft.mode === 'local' || values.source === 'local' ? 'Choose existing project folder' : 'Choose destination parent folder', 'folder', {}, 'setup-folder'));
        if (draft.folder) card.append(el('p', draft.folder.path, 'small'));
        if (draft.projects) card.append(field('Linked Project', values.project, [{ value: 'new', name: 'Create a new private Project' }, ...draft.projects.map(project => ({ value: project.id, name: project.title, disabled: project.viewerCanUpdate === false }))], value => request({ operation: 'choose', field: 'project', value }), 'setup-project'));
        if (draft.projectSnapshot) for (const role of roles) card.append(field(role + ' field', Object.hasOwn(draft.mapping ?? {}, role) ? draft.mapping[role] ?? 'new' : draft.projectSnapshot.fields.find(field => field.name === role)?.id ?? 'new',
          [{ value: 'new', name: 'Add missing ' + role + ' field' }, ...draft.projectSnapshot.fields.filter(field => field.options).map(field => ({ value: field.id, name: field.name }))],
          value => request({ operation: 'map', role, field: value === 'new' ? null : value }), 'mapping-' + role.toLowerCase()));
        if (draft.preview) {
          const preview = el('div', undefined, 'setup-preview'), data = draft.preview;
          preview.append(el('h3', 'Changes to apply'), el('p', data.target + ' · ' + (data.values.visibility ?? (data.repo?.private ? 'private' : 'public'))),
            el('p', data.values.purpose ?? 'Existing repository; files and configuration remain preserved.'),
            el('p', draft.mode === 'local' || draft.values.source === 'local' ? 'Use existing checkout: ' + data.folder.path : 'Create a new child folder for ' + (data.repo?.name ?? data.values.name) + ' in ' + data.folder.path),
            el('p', data.project ? 'Use ' + data.project.title + (data.project.repositories.some(repo => repo.id === data.repo?.id) ? '; repository is already linked.' : '; add this repository link.') : 'Create a new private Project: ' + data.title));
          const changes = el('ul');
          for (const field of data.plan) changes.append(el('li', field.role + ': ' + (field.id ? 'preserve ' + field.name + ' and its option IDs' : 'add field') + (field.missing.length ? '; add ' + field.missing.join(', ') : '; no option changes')));
          preview.append(changes, el('p', 'No Dev assignment, Issue start, protection change or background service. Existing Project data is preserved.', 'small')); card.append(preview);
        }
        const actions = el('div', undefined, 'connection-actions'); actions.append(button('Review setup', 'prepare', {}, 'setup-review'));
        if (draft.state === 'preview') actions.append(button('Apply this setup', 'apply', { hash: draft.preview.hash }, 'setup-apply'));
        actions.append(button('Cancel setup', 'cancel', {}, 'setup-cancel')); card.append(actions);
      } else if (draft.state === 'waiting-access') card.append(button('Grant scoped App access', 'install', {}, 'setup-install'), button('Continue setup', 'repair', {}, 'setup-repair'), button('Cancel setup', 'cancel'));
      else if (['uncertain', 'recovery-required'].includes(draft.state)) card.append(button('Check setup result', 'repair', {}, 'setup-repair'), button('Cancel setup', 'cancel'));
      else if (state.busy) card.append(button('Cancel setup', 'cancel', {}, 'setup-cancel'));
      if (draft.result) card.append(el('p', draft.result.name + ' · ' + draft.result.project.title, 'protected-state'));
      nodes.push(card);
    }
    if (!state.storageAvailable) nodes.push(el('p', 'Protected storage is unavailable or loading. Project setup remains blocked.', 'connection-error'));
    if (state.pending.length) nodes.push(el('p', state.pending.length + ' setup effect(s) need inspection. No automatic replay or resource deletion occurs.', 'connection-error'));
    $('setup-detail').replaceChildren(...nodes);
    if (state.message && state.message !== lastMessage) { message(state.message); $('announcement').textContent = state.message; lastMessage = state.message; }
    if (state.question && state.question.text !== lastQuestion) {
      message(state.question.text); lastQuestion = state.question.text;
      const choices = el('div', undefined, 'suggestions');
      for (const choice of state.question.choices) {
        const node = el('button', choice.label, 'secondary');
        node.addEventListener('click', () => { if (choice.operation === 'show') show(); else { const { label, ...action } = choice; request(action); } }); choices.append(node);
      }
      $('transcript').lastElementChild.append(choices);
    }
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
  }
  async function request(payload, text) {
    if (!state) return;
    try {
      const result = await window.pipeliner.workspaceRequest({ ...payload, contextRevision: state.revision });
      if (text) message(text, true);
      if (result.snapshot) render(result.snapshot); if (result.message) message(result.message);
    } catch { message('This setup or view changed. Review the selected project and try again. No new target was chosen.'); render(await window.pipeliner.workspaceRequest({ operation: 'status' })); }
    if (!$('chat-view').hidden) $('prompt').focus();
  }
  $('repositories-nav').addEventListener('click', show);
  for (const button of document.querySelectorAll('[data-setup]')) button.addEventListener('click', () => { show(); request({ operation: 'begin', mode: button.dataset.setup }); });
  window.pipeliner.onWorkspaces(render); render(await window.pipeliner.workspaceRequest({ operation: 'status' }));
  return { chat: text => request({ operation: 'chat', text }, text), handles: text => /^(?:(?:please|can you) )?(?:import|create|name|call|make|keep|use|select|choose|review|preview|apply|finish|confirm|cancel|continue|repair|check).*(?:project|repository|setup|folder|owner|status|priority|impact|effort|it)/i.test(text) || Boolean(state?.draft && !['cancelled', 'complete'].includes(state.draft.state)) };
}
