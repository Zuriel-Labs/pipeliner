import { issueCommand } from './issue-commands.mjs';
export async function initIssues({ el, message, setContext, show }) {
  let state = null, lastMessage = null, lastQuestion = null; const $ = id => document.getElementById(id);
  const active = ['In Progress', 'In Review', 'Pending Review'];
  const errors = { 'ready-active': 'Ready cannot be removed while this Issue is In Progress, In Review or Pending Review.', 'issue-state-conflict': 'GitHub activity and the local run disagree, or more than one Issue is active. Resolve the recorded state before changing readiness.',
    'issue-state-incomplete': 'The complete Issue and Project state could not be verified. Check GitHub access.', 'issue-uncertain': 'A sent result is uncertain. Check its recorded result; creation and other writes will not repeat blindly.',
    'issue-changed': 'This draft, policy or connection changed. Review a fresh preview.', 'issue-expired': 'This preview expired. Review the draft again.', 'issue-policy-unavailable': 'Select a connected repository with available protected storage.',
    'field-conflict': 'The linked Project fields changed. Its saved mapping needs review.', 'protected-or-invalid-label': 'Choose existing labels. Only direct Ready controls can change Ready for Development.', 'metadata-invalid': 'Choose Priority, Impact and Effort from the linked Project.',
    'dependency-unavailable': 'Choose dependencies in this repository.', 'draft-incomplete': 'Complete the title, outcome, acceptance criteria and metadata.', 'issue-authority-denied': 'This run no longer has the captured Issue creation authority.' };
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'create' || operation === 'policy-apply' ? 'primary' : 'secondary');
    if (id) node.id = id; node.disabled = !state.storageAvailable || !state.workspaceId || state.busy && operation !== 'cancel';
    const target = state.workspaceId; node.addEventListener('click', () => { if (state.workspaceId === target) request({ operation, ...extra }); }); return node;
  }
  function field(label, value, options, change, id, multiline = false) {
    const row = el('div', undefined, 'setup-field'), name = el('label', label), input = options ? el('select') : el(multiline ? 'textarea' : 'input'); input.id = id; name.htmlFor = id;
    if (options) { const placeholder = el('option', 'Choose…'); placeholder.value = ''; input.append(placeholder); for (const item of options) { const option = el('option', item.name); option.value = item.name; input.append(option); } }
    else { input.maxLength = multiline ? 32000 : 256; input.autocomplete = 'off'; if (!multiline) input.type = 'text'; else input.rows = 4; }
    input.value = value ?? ''; input.disabled = state.busy; input.addEventListener('change', () => change(input.value)); row.append(name, input); return row;
  }
  function readable(body) {
    if (!/^\s*(?:<!doctype html>|<html[\s>])/i.test(body)) return body;
    const document = new DOMParser().parseFromString(body, 'text/html');
    document.querySelectorAll('script,style,template').forEach(node => node.remove());
    for (const block of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,dt,dd,tr,br')) { block.prepend(document.createTextNode('\n')); block.append(document.createTextNode('\n')); }
    return document.body.textContent.replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n').trim(); // Inert text only: never adopt remote nodes or execute Issue HTML.
  }
  function readyControl(issue) {
    const controls = el('div', undefined, 'connection-actions'), disabled = issue.ready && active.includes(issue.status);
    const control = button(issue.ready ? 'Remove Ready' : 'Add Ready', 'ready', { number: issue.number, enabled: !issue.ready }, 'ready-' + issue.number);
    control.disabled ||= disabled || !issue.status;
    controls.append(control);
    if (disabled) controls.append(el('p', 'Active Issues keep Ready until they leave In Progress, In Review and Pending Review.', 'small'));
    if (!issue.status) controls.append(el('p', 'Readiness is blocked until this Issue has a verified Status in the linked Project.', 'small'));
    return controls;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const changed = state?.workspaceId !== snapshot.workspaceId, focused = document.activeElement?.id; state = snapshot;
    if (changed) { lastMessage = null; lastQuestion = null; setContext(state.workspaceId, state.repositoryLabel); }
    $('issue-context').textContent = state.repositoryLabel ?? 'Select a repository to view its Issues.';
    $('issue-refresh').disabled = !state.workspaceId || !state.storageAvailable || state.busy; $('issue-begin').disabled = $('issue-refresh').disabled;
    $('issue-health').textContent = !state.storageAvailable ? 'Issue storage or policy is unavailable. Actions remain blocked.' : !state.workspaceId ? 'Import or select a repository first.'
      : state.busy ? 'Checking the selected repository…' : state.catalog ? 'Read from GitHub at ' + new Date(state.catalog.observedAt).toLocaleString() : 'Check Issues to read current GitHub state.';
    $('issue-health').className = state.catalog && !state.busy && !state.error ? 'protected-state' : 'availability';
    $('issue-operation-error').hidden = !state.error; $('issue-operation-error').textContent = state.error ? errors[state.error] ?? 'The check did not finish. Check GitHub access and the selected repository before continuing.' : '';
    const rows = (state.catalog?.issues ?? []).map(issue => {
      const row = el('article', undefined, 'connection-card'); row.append(el('h2', '#' + issue.number + ' · ' + issue.title), el('p', (issue.status ?? 'Not tracked in this Project') + ' · ' + issue.state + (issue.ready ? ' · Ready for Development' : ''), 'small'),
        el('p', ['Priority', 'Impact', 'Effort'].map(role => role + ': ' + (issue.metadata[role] ?? 'not set')).join(' · '), 'small'));
      row.append(button(state.selected === issue.number ? 'Selected Issue' : 'View Issue', 'select', { number: issue.number }, 'select-issue-' + issue.number), readyControl(issue)); return row;
    }); $('issue-list').replaceChildren(...rows);
    const detail = state.detail, selected = state.catalog?.issues.find(issue => issue.number === state.selected), contents = [];
    if (detail && selected && detail.id === selected.id) {
      const card = el('article', undefined, 'connection-card'); card.id = 'selected-issue'; card.append(el('h2', '#' + detail.number + ' · ' + detail.title), el('p', readable(detail.body), 'issue-body'),
        el('p', 'Labels: ' + (detail.labels.join(', ') || 'none'), 'small'), el('p', 'Assigned: ' + (detail.assignees.join(', ') || 'unassigned'), 'small'));
      const dependencies = el('ul'); for (const dependency of detail.dependencies) dependencies.append(el('li', '#' + dependency.number + ' · ' + dependency.title + ' · ' + dependency.state));
      card.append(el('h3', 'Dependencies'), dependencies); if (!detail.dependencies.length) card.append(el('p', 'No recorded dependencies.', 'small'));
      card.append(el('h3', 'Pull requests and checks'));
      for (const pr of detail.pullRequests) {
        card.append(el('p', pr.repositoryName + ' #' + pr.number + ' · ' + pr.title + ' · ' + pr.state + ' · ' + pr.relationship), el('p', pr.checks ? 'Checks: ' + pr.checks.state + (pr.checks.current ? '' : ' · from an older commit') : 'Checks not reported.', 'small'));
        const checks = el('ul'); for (const check of pr.checks?.results ?? []) checks.append(el('li', check.name + ' · ' + check.state)); card.append(checks);
      }
      if (!detail.pullRequests.length) card.append(el('p', 'No linked pull requests reported by GitHub.', 'small'));
      card.append(el('h3', 'Release evidence'), el('p', detail.releaseEvidence.explanation, 'small')); contents.push(card);
    } $('issue-detail').replaceChildren(...contents);
    const draft = state.draft, drafts = [];
    if (draft) {
      const card = el('article', undefined, 'connection-card'); card.id = 'issue-draft';
      card.append(el('h2', ({ preview: 'Review this Issue', creating: 'Creating the Issue', complete: 'Issue created', cancelled: 'Draft cancelled', uncertain: 'Result needs inspection', 'recovery-required': 'Recorded result needs readback', failed: 'Draft needs attention' })[draft.state] ?? 'Draft an Issue'));
      if (draft.error) card.append(el('p', errors[draft.error] ?? 'The check did not finish. Check access and the selected repository before continuing.', 'connection-error'));
      const locked = ['creating', 'complete', 'cancelled', 'uncertain', 'recovery-required'].includes(draft.state);
      if (!locked) {
        const values = draft.values;
        for (const [key, label] of [['title', 'Title'], ['summary', 'Intended outcome'], ['acceptance', 'Acceptance criteria · one per line']]) card.append(field(label, key === 'acceptance' ? (values[key] ?? []).join('\n') : values[key], null,
          value => request({ operation: 'choose', field: key, value: key === 'acceptance' ? value.split('\n').map(line => line.trim()).filter(Boolean) : value }), 'draft-' + key, key !== 'title'));
        for (const role of ['Priority', 'Impact', 'Effort']) card.append(field(role, values[role.toLowerCase()], state.catalog?.fields?.[role]?.options ?? state.options?.[role] ?? [],
          value => request({ operation: 'choose', field: role.toLowerCase(), value }), 'draft-' + role.toLowerCase()));
        const selections = el('fieldset', undefined, 'issue-selections'); selections.append(el('legend', 'Labels'));
        for (const label of state.catalog?.labels ?? []) if (label !== 'Ready for Development') {
          const row = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = (values.labels ?? []).includes(label); input.disabled = state.busy;
          input.addEventListener('change', () => request({ operation: 'choose', field: 'labels', value: input.checked ? [...(state.draft.values.labels ?? []), label] : state.draft.values.labels.filter(value => value !== label) })); row.append(input, document.createTextNode(label)); selections.append(row);
        } card.append(selections);
        const dependencies = el('fieldset', undefined, 'issue-selections'); dependencies.append(el('legend', 'Dependencies in this repository'));
        for (const issue of state.catalog?.issues ?? []) {
          const row = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = (values.dependencies ?? []).includes(issue.number); input.disabled = state.busy;
          input.addEventListener('change', () => request({ operation: 'choose', field: 'dependencies', value: input.checked ? [...(state.draft.values.dependencies ?? []), issue.number] : state.draft.values.dependencies.filter(value => value !== issue.number) })); row.append(input, document.createTextNode('#' + issue.number + ' · ' + issue.title)); dependencies.append(row);
        } card.append(dependencies);
        if (draft.preview) {
          const preview = el('div', undefined, 'setup-preview'); preview.id = 'issue-preview'; preview.append(el('h3', draft.values.title), el('p', draft.values.summary), el('p', state.repositoryLabel + ' · Backlog · Unassigned · Not Ready', 'protected-state'));
          const criteria = el('ol'); for (const item of draft.values.acceptance) criteria.append(el('li', item)); preview.append(criteria,
            el('p', ['priority', 'impact', 'effort'].map(key => key + ': ' + draft.values[key]).join(' · ')), el('p', 'Labels: ' + (draft.values.labels.join(', ') || 'none')),
            el('p', 'Dependencies: ' + (draft.values.dependencies.map(number => '#' + number).join(', ') || 'none'))); card.append(preview);
        }
        const actions = el('div', undefined, 'connection-actions'); actions.append(button('Review Issue', 'prepare', {}, 'issue-review'));
        if (draft.state === 'preview') actions.append(button('Create this Issue', 'create', { hash: draft.preview.hash }, 'issue-create'));
        actions.append(button('Cancel draft', 'cancel', {}, 'issue-cancel')); card.append(actions);
      } else if (['uncertain', 'recovery-required'].includes(draft.state)) {
        card.append(button('Check recorded result', 'repair', {}, 'issue-repair'));
        if (draft.state === 'recovery-required') card.append(button('Review remaining changes', 'prepare', {}, 'issue-review'));
      }
      else if (draft.state === 'complete') card.append(el('p', '#' + draft.result.number + ' · Backlog · Unassigned · Not Ready', 'protected-state'));
      else if (state.busy) card.append(button('Cancel', 'cancel', {}, 'issue-cancel'));
      drafts.push(card);
    }
    if (state.pending.length) drafts.push(el('p', 'Some sent effects need readback. An unknown creation reply requires deliberate inspection on GitHub; Pipeliner will not create a duplicate.', 'connection-error'), button('Check recorded effects', 'repair'));
    $('issue-drafts').replaceChildren(...drafts);
    const policies = [], policy = state.policy;
    if (policy) {
      policies.push(el('h2', 'Issue authoring · ' + state.repositoryLabel), el('p', 'Ready remains PM-owned in every mode. Agent creation also requires an assigned Dev and current GitHub permissions.', 'small'));
      const modes = [{ name: 'pm', label: 'PM writes Issues' }, { name: 'coauthored', label: 'Draft together' }, { name: 'agent', label: 'Agent writes Issues' }];
      const row = el('div', undefined, 'setup-field'), label = el('label', 'Authoring mode'), select = el('select'); select.id = 'intake-mode'; label.htmlFor = select.id;
      for (const mode of modes) { const option = el('option', mode.label); option.value = mode.name; select.append(option); } select.value = policy.mode.value; row.append(label, select); policies.push(row);
      const creation = el('label', undefined, 'issue-toggle'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.id = 'intake-agent-creation'; checkbox.checked = policy.agentCreation.value; creation.append(checkbox, document.createTextNode('Allow agent Issue creation')); policies.push(creation,
        el('p', 'Current source: mode ' + policy.mode.source + '; creation ' + policy.agentCreation.source + '. Changes apply to new runs; revocations block current runs immediately.', 'small'));
      const submit = el('button', 'Review authoring change', 'secondary'); submit.id = 'intake-review';
      const changed = () => { submit.disabled = state.busy || select.value === policy.mode.value && checkbox.checked === policy.agentCreation.value; };
      select.addEventListener('change', changed); checkbox.addEventListener('change', changed); changed();
      submit.addEventListener('click', () => request({ operation: 'policy-prepare', mode: select.value, agentCreation: checkbox.checked })); policies.push(submit);
      if (state.policyPreview) {
        const preview = el('div', undefined, 'setup-preview'); preview.id = 'intake-preview';
        for (const key of ['intake.mode', 'intake.agentCreation']) preview.append(el('p', state.policyPreview.before[key].label + ': ' + state.policyPreview.before[key].value + ' to ' + state.policyPreview.after[key].value));
        preview.append(button('Apply authoring change', 'policy-apply', { hash: state.policyPreview.hash }, 'intake-apply'), button('Cancel change', 'policy-cancel')); policies.push(preview);
      }
    } else policies.push(el('p', 'Select a repository to manage its Issue authoring policy.', 'small'));
    $('intake-settings').replaceChildren(...policies);
    if (state.message && state.message !== lastMessage) { message(state.message, false, state.workspaceId); lastMessage = state.message; $('announcement').textContent = state.message; }
    if (state.question && state.question.text !== lastQuestion) {
      message(state.question.text, false, state.workspaceId); lastQuestion = state.question.text; const choices = el('div', undefined, 'suggestions');
      for (const choice of state.question.choices) { const { label, ...action } = choice; const node = choice.operation === 'show' ? el('button', label, 'secondary') : button(label, action.operation, action); if (choice.operation === 'show') node.addEventListener('click', show); choices.append(node); }
      $('transcript').lastElementChild?.append(choices);
    }
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus();
  }
  async function request(payload, text) {
    if (!state) return; const target = state.workspaceId;
    try {
      const result = await window.pipeliner.issueRequest({ ...payload, contextRevision: state.revision });
      if (state.workspaceId !== target) return;
      if (text) { message(text, true, target); $('prompt').value = ''; }
      if (result.snapshot) render(result.snapshot); if (result.message) message(result.message, false, target);
    } catch { if (state.workspaceId !== target) return; message('This Issue or repository context changed. Check Issues and review the exact target again.', false, target); render(await window.pipeliner.issueRequest({ operation: 'status' })); }
    if (!$('chat-view').hidden) $('prompt').focus();
  }
  $('issues-nav').addEventListener('click', show); $('issue-refresh').addEventListener('click', () => request({ operation: 'refresh' })); $('issue-begin').addEventListener('click', () => request({ operation: 'begin' }));
  window.pipeliner.onIssues(render); render(await window.pipeliner.issueRequest({ operation: 'status' }));
  return { chat: text => request({ operation: 'chat', text }, text), handles: text => Boolean(issueCommand(text)) || Boolean(state?.draft && !['complete', 'cancelled', 'uncertain', 'recovery-required'].includes(state.draft.state)) };
}
