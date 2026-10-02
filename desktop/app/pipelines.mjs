import { pipelineCommand } from './pipeline-commands.mjs';

export async function initPipelines({ el, message }) {
  let state, lastMessage, pending = false; const $ = id => document.getElementById(id);
  const scenarioNames = { supervised: 'Supervised Dev', 'pm-autonomous': 'PM-triggered Autonomous Dev', 'scheduled-autonomous': 'Scheduled Autonomous Dev', custom: 'Custom' };
  const title = kind => kind === 'development' ? 'Development' : 'Release';
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); if (id) node.id = id;
    node.disabled = pending || !state.storageAvailable; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function field(label, value, id, change, options, type = 'text') {
    const row = el('div', undefined, 'setup-field'), name = el('label', label), input = el(options ? 'select' : 'input'); input.id = id; name.htmlFor = id;
    if (options) for (const [value, label] of options) { const option = el('option', label); option.value = value; input.append(option); }
    else { input.type = type; input.maxLength = 240; input.autocomplete = 'off'; if (type === 'number') { input.min = id.includes('retryLimit') || id === 'pipeline-version' ? 0 : 1; input.max = id === 'pipeline-version' ? state.current.revision : id.includes('retryLimit') ? 10 : 100; input.step = 1; } }
    input.value = value; input.disabled = pending || !state.storageAvailable;
    input.addEventListener('change', () => change(type === 'number' ? Number(input.value) : input.value)); row.append(name, input); return row;
  }
  const destination = (graph, id) => ['complete', 'blocked'].includes(id) ? id === 'complete' ? 'Complete' : 'Blocked'
    : graph.steps.some(step => step.id === id) ? 'Step ' + (graph.steps.findIndex(step => step.id === id) + 1) + ' · ' + graph.steps.find(step => step.id === id).label : 'Missing destination · correction required';
  function definition(graph, heading) {
    const section = el('section', undefined, 'pipeline-definition'); section.append(el('h3', heading), el('p', 'Start: ' + destination(graph, graph.entry), 'small'));
    const list = el('ol'); for (const step of graph.steps) {
      const item = el('li'); item.append(el('strong', step.label), el('p', state.options.types[step.kind], 'small'), el('p', 'Expected: ' + step.expectedResult));
      for (const field of ['inputs', 'evidence', 'permissions']) item.append(el('p', field.charAt(0).toUpperCase() + field.slice(1) + ': ' + (step[field].map(value => state.options[field]?.[value] ?? value).join(', ') || 'None'), 'small'));
      item.append(el('p', ['success', 'failure', 'feedback'].map(outcome => outcome + ' → ' + destination(graph, step.routes[outcome])).join(' · '), 'small'),
        el('p', 'Retries: ' + step.retryLimit + ' · Maximum visits: ' + step.visitLimit, 'small')); list.append(item);
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
      for (const name of ['inputs', 'evidence', 'permissions']) detail.append(declarations(step, number, name));
      for (const outcome of ['success', 'failure', 'feedback']) {
        const target = step.routes[outcome], value = ['complete', 'blocked'].includes(target) ? target : graph.steps.some(step => step.id === target) ? String(graph.steps.findIndex(step => step.id === target) + 1) : 'missing';
        detail.append(field('On ' + outcome, value, detail.id + '-' + outcome, value => edit(outcome, /^(complete|blocked)$/.test(value) ? value : Number(value)),
          [...(value === 'missing' ? [['missing', 'Missing destination · choose a step']] : []), ...destinations, ['complete', 'Complete'], ['blocked', 'Blocked']]));
      }
      detail.append(field('Maximum retries · 0–10', step.retryLimit, detail.id + '-retryLimit', value => edit('retryLimit', value), null, 'number'),
        field('Maximum visits · 1–100', step.visitLimit, detail.id + '-visitLimit', value => edit('visitLimit', value), null, 'number'),
        field('Move before · rewrites start and the success sequence', String(number), detail.id + '-move', before => request({ operation: 'edit', action: { operation: 'move', step: number, before: Number(before) } }), destinations));
      const actions = el('div', undefined, 'connection-actions'); actions.append(button('Start here', 'edit', { action: { operation: 'entry', step: number } }, detail.id + '-entry'), button('Remove this step', 'edit', { action: { operation: 'remove', step: number } }, detail.id + '-remove')); detail.append(actions); card.append(detail);
    });
    const add = el('form', undefined, 'setup-preview'); add.append(el('h3', 'Add a step'), field('Step name', '', 'pipeline-add-label', () => {}),
      field('Step type', 'agent', 'pipeline-add-kind', () => {}, Object.entries(state.options.types)), field('Insert after', String(graph.steps.length), 'pipeline-add-after', () => {}, [['0', 'Before the first step'], ...destinations]));
    const submit = el('button', 'Add step', 'secondary'); submit.type = 'submit'; submit.disabled = pending; add.append(submit); add.querySelector('input').required = true;
    add.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'edit', action: { operation: 'add', step: Number($('pipeline-add-after').value), kind: $('pipeline-add-kind').value, label: $('pipeline-add-label').value } }); }); card.append(add);
    const actions = el('div', undefined, 'connection-actions'); actions.append(button('Review pipeline', 'prepare', {}, 'pipeline-review'), button('Discard draft', 'discard', {}, 'pipeline-discard')); card.append(actions); return card;
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
        el('p', 'Pipeline permissions declare requirements; they do not grant access. Scheduling and execution controls await qualification.', 'small'));
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
      if (text) { message(text, true, target); $('prompt').value = ''; }
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
