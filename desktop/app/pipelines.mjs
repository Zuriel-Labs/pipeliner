import { pipelineCommand } from './pipeline-commands.mjs';

export async function initPipelines({ el, message }) {
  let state, lastMessage, pending = false; const $ = id => document.getElementById(id), bindingDrafts = new Map();
  const scenarioNames = { supervised: 'Supervised Dev', 'pm-autonomous': 'PM-triggered Autonomous Dev', 'scheduled-autonomous': 'Scheduled Autonomous Dev', custom: 'Custom' };
  const title = kind => kind === 'development' ? 'Development' : 'Release';
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); if (id) node.id = id;
    node.disabled = pending || !state.storageAvailable; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function field(label, value, id, change, options, type = 'text') {
    const row = el('div', undefined, 'setup-field'), name = el('label', label), input = el(options ? 'select' : 'input'); input.id = id; name.htmlFor = id;
    if (options) for (const [value, label] of options) { const option = el('option', label); option.value = value; input.append(option); }
    else { input.type = type; input.maxLength = 240; input.autocomplete = 'off'; if (type === 'number') { input.min = id.includes('retryLimit') || id === 'pipeline-version' ? 0 : 1; input.max = id.includes('timeoutSeconds') ? 604800 : id === 'pipeline-version' ? state.current.revision : id.includes('retryLimit') ? 10 : 100; input.step = 1; } }
    input.value = value; input.disabled = pending || !state.storageAvailable;
    input.addEventListener('change', () => change(type === 'number' ? id.includes('timeoutSeconds') && input.value === '' ? null : Number(input.value) : input.value)); row.append(name, input); return row;
  }
  const destination = (graph, id) => ['complete', 'blocked'].includes(id) ? id === 'complete' ? 'Complete' : 'Blocked'
    : graph.steps.some(step => step.id === id) ? 'Step ' + (graph.steps.findIndex(step => step.id === id) + 1) + ' · ' + graph.steps.find(step => step.id === id).label : 'Missing destination · correction required';
  function definition(graph, heading) {
    const section = el('section', undefined, 'pipeline-definition'); section.append(el('h3', heading), el('p', 'Start: ' + destination(graph, graph.entry), 'small'));
    const list = el('ol'); for (const step of graph.steps) {
      const item = el('li'); item.append(el('strong', step.label), el('p', state.options.types[step.kind], 'small'), el('p', 'Expected: ' + step.expectedResult));
      for (const field of ['inputs', 'evidence', 'permissions']) item.append(el('p', field.charAt(0).toUpperCase() + field.slice(1) + ': ' + (step[field].map(value => state.options[field]?.[value] ?? value).join(', ') || 'None'), 'small'));
      if (step.extension) item.append(el('p', 'Custom ' + step.extension.kind + ' · pin ' + step.extension.pin, 'small'),
        el('p', 'Data bindings: ' + (step.extension.bindings.map(binding => binding.path.join('.') + ' receives ' + state.options.data[binding.source] + (binding.step ? ' from ' + destination(graph, binding.step) : '')).join('; ') || 'None'), 'small'),
        el('p', 'PM supplied values: ' + JSON.stringify(step.extension.constants), 'small'));
      item.append(el('p', ['success', 'failure', 'feedback'].map(outcome => outcome + ' → ' + destination(graph, step.routes[outcome])).join(' · '), 'small'),
        el('p', 'Retries: ' + step.retryLimit + ' · Maximum visits: ' + step.visitLimit + ' · Timeout: ' + (step.timeoutSeconds ? step.timeoutSeconds + ' seconds' : 'Inherited by step type'), 'small')); list.append(item);
    } section.append(list); return section;
  }
  function declarations(step, number, field) {
    const group = el('fieldset', undefined, 'issue-selections'); group.append(el('legend', field === 'permissions' ? 'Required permissions · declarations only' : 'Required ' + field));
    const choices = { ...state.options[field], ...Object.fromEntries(step[field].filter(value => !state.options[field][value]).map(value => [value, value])) };
    for (const [value, label] of Object.entries(choices)) {
      const row = el('label'), input = el('input'); input.type = 'checkbox'; input.id = 'pipeline-step-' + number + '-' + field + '-' + value; input.checked = step[field].includes(value); input.disabled = pending;
      input.addEventListener('change', () => request({ operation: 'edit', action: { operation: 'set', step: number, field, value: input.checked ? [...step[field], value] : step[field].filter(item => item !== value) } }));
      row.append(input, document.createTextNode(label)); group.append(row);
    } return group;
  }
  function editor(draft) {
    const card = el('article', undefined, 'connection-card'); card.id = 'pipeline-draft'; card.append(el('h2', title(state.kind) + ' draft'), el('p', 'Saved from version ' + draft.baseRevision + '. Finish editing a field to save it. Review the full changes before applying.', 'small'));
    if (state.staleDraft) card.append(el('p', 'Configuration changed since this draft began. Refresh its base, then review every proposed change.', 'connection-error'), button('Refresh draft base', 'rebase', {}, 'pipeline-rebase'));
    const graph = draft.definition, destinations = graph.steps.map((step, index) => [String(index + 1), 'Step ' + (index + 1) + ' · ' + step.label]);
    graph.steps.forEach((step, index) => {
      const number = index + 1, detail = el('details', undefined, 'pipeline-step'); detail.id = 'pipeline-step-' + number;
      detail.append(el('summary', number + ' · ' + step.label + (step.id === graph.entry ? ' · Start' : '')));
      const edit = (field, value) => request({ operation: 'edit', action: { operation: 'set', step: number, field, value } });
      detail.append(field('Step name', step.label, detail.id + '-label', value => edit('label', value)),
        field('Step type', step.kind, detail.id + '-kind', value => edit('kind', value), Object.entries(state.options.types)),
        field('Expected result', step.expectedResult, detail.id + '-expectedResult', value => edit('expectedResult', value)));
      if (step.kind === 'extension') detail.append(extensionEditor(step, number, graph));
      for (const name of ['inputs', 'evidence', 'permissions']) detail.append(declarations(step, number, name));
      for (const outcome of ['success', 'failure', 'feedback']) {
        const target = step.routes[outcome], value = ['complete', 'blocked'].includes(target) ? target : graph.steps.some(step => step.id === target) ? String(graph.steps.findIndex(step => step.id === target) + 1) : 'missing';
        detail.append(field('On ' + outcome, value, detail.id + '-' + outcome, value => edit(outcome, /^(complete|blocked)$/.test(value) ? value : Number(value)),
          [...(value === 'missing' ? [['missing', 'Missing destination · choose a step']] : []), ...destinations, ['complete', 'Complete'], ['blocked', 'Blocked']]));
      }
      detail.append(field('Maximum retries · 0–10', step.retryLimit, detail.id + '-retryLimit', value => edit('retryLimit', value), null, 'number'),
        field('Maximum visits · 1–100', step.visitLimit, detail.id + '-visitLimit', value => edit('visitLimit', value), null, 'number'),
        field('Timeout in seconds · leave empty to inherit', step.timeoutSeconds ?? '', detail.id + '-timeoutSeconds', value => edit('timeoutSeconds', value), null, 'number'),
        field('Move before · rewrites start and the success sequence', String(number), detail.id + '-move', before => request({ operation: 'edit', action: { operation: 'move', step: number, before: Number(before) } }), destinations));
      const actions = el('div', undefined, 'connection-actions'); actions.append(button('Start here', 'edit', { action: { operation: 'entry', step: number } }, detail.id + '-entry'), button('Remove this step', 'edit', { action: { operation: 'remove', step: number } }, detail.id + '-remove')); detail.append(actions); card.append(detail);
    });
    const add = el('form', undefined, 'setup-preview'); add.append(el('h3', 'Add a step'), field('Step name', '', 'pipeline-add-label', () => {}),
      field('Step type', 'agent', 'pipeline-add-kind', () => {}, Object.entries(state.options.types)), field('Insert after', String(graph.steps.length), 'pipeline-add-after', () => {}, [['0', 'Before the first step'], ...destinations]));
    const submit = el('button', 'Add step', 'secondary'); submit.type = 'submit'; submit.disabled = pending; add.append(submit); add.querySelector('input').required = true;
    add.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'edit', action: { operation: 'add', step: Number($('pipeline-add-after').value), kind: $('pipeline-add-kind').value, label: $('pipeline-add-label').value } }); }); card.append(add);
    const actions = el('div', undefined, 'connection-actions'); actions.append(button('Review pipeline', 'prepare', {}, 'pipeline-review'), button('Discard draft', 'discard', {}, 'pipeline-discard')); card.append(actions); return card;
  }
  function extensionEditor(step, number, graph) {
    const section = el('section'), id = 'pipeline-binding-' + number, choices = state.options.extensions, selected = choices.find(item => item.pin === step.extension?.pin);
    section.append(el('h4', 'Custom step · exact source and data'), field('Selected tool or skill', selected?.name ?? '', id + '-tool', name => {
      if (name) request({ operation: 'bind', step: number, name });
    }, [['', step.extension ? 'Selected pin unavailable · choose an approved source' : 'Choose an approved source'], ...choices.map(item => [item.name, item.name + ' · ' + item.kind])]),
    el('p', 'Binding a source declares its required permissions; it grants none. Changing the source clears prior data bindings for review.', 'small'));
    if (!step.extension) return section;
    section.append(el('p', 'Exact pin: ' + step.extension.pin, 'small'));
    if (!selected) { section.append(el('p', 'Enable or restore this exact source in Skills and Tools before applying or running the pipeline.', 'availability')); return section; }
    section.append(el('p', selected.purpose, 'small'), el('p', 'Approved data: ' + (selected.dataCategories.map(key => state.options.data[key]).join(', ') || 'None'), 'small'));
    const schema = el('details', undefined, 'resources'); schema.id = id + '-schema'; schema.append(el('summary', 'Typed inputs required by this source'), el('pre', JSON.stringify(selected.inputSchema, null, 2), 'tool-schema')); section.append(schema);
    for (const binding of step.extension.bindings) {
      const row = el('div', undefined, 'connection-actions'); row.append(el('p', binding.path.join('.') + ': ' + state.options.data[binding.source] + (binding.step ? ' · ' + destination(graph, binding.step) : ''), 'small'),
        button('Remove input ' + binding.path.join('.'), 'input', { step: number, path: binding.path, source: 'none' })); section.append(row);
    }
    for (const [key, value] of Object.entries(step.extension.constants)) {
      const row = el('div', undefined, 'connection-actions'); row.append(el('p', key + ': PM supplied ' + JSON.stringify(value), 'small'), button('Remove supplied ' + key, 'input', { step: number, path: [key], source: 'none' })); section.append(row);
    }
    if (!selected.dataCategories.length) return section;
    const form = el('form', undefined, 'setup-preview'); form.id = id + '-form'; const saved = bindingDrafts.get(state.scope + ':' + state.workspaceId + ':' + step.id) ?? {};
    form.append(el('h4', 'Add or replace an input'), field('Destination field · for example, title', saved.path ?? '', id + '-path', () => {}),
      field('Approved source', saved.source ?? selected.dataCategories[0], id + '-source', () => {}, selected.dataCategories.map(key => [key, state.options.data[key]])),
      field('Prior result step · only used for verified prior results', saved.previous ?? '', id + '-previous', () => {}, [['', 'Choose a custom step'], ...graph.steps.flatMap((item, index) => item.kind === 'extension' && index !== number - 1 ? [[String(index + 1), 'Step ' + (index + 1) + ' · ' + item.label]] : [])]),
      field('Prior result field · optional', saved.selection ?? '', id + '-selection', () => {}),
      field('Supplied value type · only used for PM supplied values', saved.type ?? 'text', id + '-type', () => {}, [['text', 'Text'], ['number', 'Number'], ['boolean', 'True or false'], ['json', 'Advanced · JSON object or array']]),
      field('Supplied value', saved.value ?? '', id + '-value', () => {}));
    const submit = el('button', 'Save input binding', 'secondary'); submit.type = 'submit'; submit.disabled = pending; form.append(submit);
    form.addEventListener('submit', event => {
      event.preventDefault(); const source = $(id + '-source').value, action = { operation: 'input', step: number, path: $(id + '-path').value.trim().split('.'), source };
      if (source === 'previous.structuredContent') { action.previous = Number($(id + '-previous').value); const selection = $(id + '-selection').value.trim(); if (selection) action.selection = selection.split('.'); }
      if (source === 'pm.supplied') {
        const type = $(id + '-type').value, value = $(id + '-value').value;
        try { action.value = type === 'text' ? value : type === 'number' && value.trim() ? Number(value) : type === 'boolean' && /^(true|false)$/i.test(value) ? value.toLowerCase() === 'true' : type === 'json' ? JSON.parse(value) : undefined;
          if (action.value === undefined || type === 'number' && !Number.isFinite(action.value)) throw new Error(); }
        catch { message('Use a valid value of the selected type. The binding was not sent.', false, state.workspaceId); return; }
      } request(action);
    }); section.append(form); return section;
  }
  function testing(instructions) {
    const detail = el('details', undefined, 'connection-card'); detail.id = 'pipeline-testing'; detail.append(el('summary', 'PM testing instructions · action and expected result'));
    instructions.forEach((instruction, index) => {
      const row = el('section'); row.append(el('h3', 'Test ' + (index + 1)));
      for (const name of ['action', 'expected']) row.append(field(name === 'action' ? 'PM action' : 'Expected result', instruction[name], 'pipeline-test-' + index + '-' + name,
        value => request({ operation: 'testing', action: { operation: 'set', index: index + 1, field: name, value } })));
      row.append(button('Remove test ' + (index + 1), 'testing', { action: { operation: 'remove', index: index + 1 } })); detail.append(row);
    });
    const add = el('form'); add.append(field('New PM action', '', 'pipeline-test-action', () => {}), field('New expected result', '', 'pipeline-test-expected', () => {}));
    for (const input of add.querySelectorAll('input')) input.required = true;
    const submit = el('button', 'Add test instruction', 'secondary'); submit.type = 'submit'; submit.disabled = pending; add.append(submit);
    add.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'testing', action: { operation: 'add', action: $('pipeline-test-action').value, expected: $('pipeline-test-expected').value } }); }); detail.append(add,
      el('p', 'These are instructions, not a PM acceptance decision. Required checks: ' + (state.current.requiredChecks.join(', ') || 'No qualified references configured.'), 'small')); return detail;
  }
  function preview(proposal) {
    const card = el('article', undefined, 'setup-preview'); card.id = 'pipeline-preview'; card.append(el('h2', 'Review the exact change'),
      el('p', proposal.scope === 'global' ? 'Global templates · affects ' + (proposal.affectedRepositories.join(', ') || 'future repositories') : state.repositoryLabel + ' · repository override', 'protected-state'),
      el('p', 'From configuration version ' + proposal.baseRevision + '. Review expires at ' + new Date(proposal.expiresAt).toLocaleTimeString() + '. Future runs use the new version; active work keeps its captured definition.', 'small'));
    for (const key of Object.keys(proposal.after)) {
      const before = proposal.before[key], after = proposal.after[key];
      if (key.startsWith('pipelines.')) { const row = el('div', undefined, 'pipeline-comparison'); row.append(definition(before.value, before.label + ' · before (' + before.source + ')'), definition(after.value, after.label + ' · after (' + after.source + ')')); card.append(row); }
      else if (key === 'testing.instructions') {
        for (const [heading, value] of [['Before', before.value], ['After', after.value]]) { card.append(el('h3', heading + ' PM instructions')); const list = el('ol'); for (const item of value) list.append(el('li', item.action + ' → ' + item.expected)); card.append(list); if (!value.length) card.append(el('p', 'No instructions.')); }
      } else {
        const readable = value => key === 'autonomy.scenario' ? scenarioNames[value] ?? 'Not chosen' : key === 'intake.trigger' ? value === 'schedule' ? 'Scheduled · execution unavailable until qualified' : 'PM-triggered' : value ? 'Enabled' : 'Disabled';
        card.append(el('p', after.label + ': ' + readable(before.value) + ' → ' + readable(after.value) + ' · ' + after.source));
      }
    }
    if (proposal.after['pipelines.development']?.value.steps.every(step => step.kind !== 'pm-qa')) card.append(el('p', 'This selects the PM-controlled Desktop workflow with no testing approval gate for new runs. Existing repository profile files stay unchanged; other framework agents keep their configured testing requirements. Required checks and external controls still apply.', 'protected-state'));
    card.append(button('Apply this pipeline', 'apply', { hash: proposal.hash }, 'pipeline-apply'), button('Discard draft', 'discard')); return card;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, open = new Set([...$('pipeline-settings').querySelectorAll('details[open]')].map(node => node.id));
    if (state?.draft) state.draft.definition.steps.forEach((step, index) => {
      const id = 'pipeline-binding-' + (index + 1); if (!$(id + '-form')) return;
      bindingDrafts.set(state.scope + ':' + state.workspaceId + ':' + step.id, Object.fromEntries(['path', 'source', 'previous', 'selection', 'type', 'value'].map(key => [key, $(id + '-' + key).value])));
    });
    if (state?.workspaceId !== snapshot.workspaceId) lastMessage = null; state = snapshot;
    const nodes = [el('h2', 'Pipelines'), el('p', 'Edit through chat or these controls. Changes remain drafts until you review and apply them.', 'small'),
      el('p', 'In chat, ask “Edit Development pipeline”, “Rename step 1 to Inspect the change”, then “Review this pipeline”.', 'small')];
    const scopeOptions = [['global', 'Global templates'], ...(state.workspaceId ? [['repository', state.repositoryLabel]] : [])];
    const scope = el('div', undefined, 'pipeline-selectors'); scope.append(field('Scope', state.scope, 'pipeline-scope', scope => request({ operation: 'view', scope }), scopeOptions),
      field('Pipeline', state.kind, 'pipeline-kind', kind => request({ operation: 'view', kind }), [['development', 'Development'], ['release', 'Release']])); nodes.push(scope);
    if (!state.storageAvailable) nodes.push(el('p', 'Protected pipeline storage is unavailable. Current configuration and drafts are preserved; reopen after checking protected storage.', 'availability'));
    else {
      const current = state.current;
      nodes.push(el('p', 'Applied version ' + current.revision + ' · ' + current.source + ' · ' + (scenarioNames[current.scenario] ?? 'No scenario chosen'), 'protected-state'),
        el('p', 'Pipeline permissions declare requirements; they do not grant access. Execution requires qualified steps, current connections and both permission scopes.', 'small'));
      if (state.error) nodes.push(el('p', state.error, 'connection-error'));
      const presets = el('div', undefined, 'connection-actions'); for (const [scenario, name] of Object.entries(scenarioNames)) if (scenario !== 'custom') presets.append(button('Draft ' + name, 'preset', { scenario }, 'pipeline-preset-' + scenario));
      nodes.push(presets, el('p', 'Presets replace both pipeline definitions and choose their trigger. They do not enable scheduling, background operation or agent Issue creation.', 'small'));
      const applied = el('details', undefined, 'connection-card'); applied.id = 'pipeline-applied'; applied.append(el('summary', 'Applied ' + title(state.kind) + ' definition · version ' + current.revision), definition(current.definition, 'Current effective definition')); nodes.push(applied);
      if (state.active) {
        const run = state.active, active = el('details', undefined, 'connection-card'); active.id = 'pipeline-active'; active.append(el('summary', 'Issue #' + run.issue + ' · captured version ' + run.policyRevision),
          el('p', 'Run: ' + title(run.runPipeline) + ' · ' + run.control + '. Later configuration edits do not replace its captured definitions.', 'small'), definition(run.definition, title(state.kind) + ' at capture')); nodes.push(active);
      } else nodes.push(el('p', 'No captured active run for this repository.', 'small'));
      nodes.push(state.draft ? editor(state.draft) : button('Edit ' + title(state.kind) + ' pipeline', 'begin', {}, 'pipeline-begin'), testing(state.draft?.instructions ?? current.instructions));
      if (state.preview) nodes.push(preview(state.preview));
      const versions = el('div', undefined, 'connection-card'); versions.append(el('h3', 'Version recovery'), el('p', 'Restore this definition as a new version. Other settings and active work stay preserved.', 'small'));
      versions.append(field('Version number', current.revision, 'pipeline-version', () => {}, null, 'number'), el('p', 'Recent versions: ' + state.history.map(version => version.revision).join(', ') + '. Any retained version may be restored.', 'small'));
      const restore = el('button', 'Draft restored definition', 'secondary'); restore.disabled = pending; restore.id = 'pipeline-restore'; restore.addEventListener('click', () => request({ operation: 'restore', version: Number($('pipeline-version').value) })); versions.append(restore);
      if (state.scope === 'repository') versions.append(button('Draft reset to inheritance', 'reset', {}, 'pipeline-reset')); nodes.push(versions);
    }
    $('pipeline-settings').replaceChildren(...nodes); for (const id of open) if ($(id)) $(id).open = true;
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
    if (state.message && state.message !== lastMessage) { message(state.message, false, state.workspaceId); lastMessage = state.message; $('announcement').textContent = state.message; }
  }
  async function request(payload, text) {
    if (!state || pending) return; const target = state.workspaceId; pending = true;
    try {
      const result = await window.pipeliner.pipelineRequest({ ...payload, contextRevision: state.revision }); pending = false;
      if (state.workspaceId !== target) return;
      if (text) message(text, true, target);
      if (result.snapshot) render(result.snapshot); if (result.message) message(result.message, false, target);
    } catch {
      pending = false; const latest = await window.pipeliner.pipelineRequest({ operation: 'status' }); render(latest);
      if (latest.workspaceId === target) message(latest.error ?? 'Pipeline context changed. Review the selected scope and exact changes again.', false, target);
    }
    if (!$('chat-view').hidden) $('prompt').focus();
  }
  window.pipeliner.onPipelines(render); render(await window.pipeliner.pipelineRequest({ operation: 'status' }));
  return { chat: text => request({ operation: 'chat', text }, text), handles: text => Boolean(pipelineCommand(text)) };
}
