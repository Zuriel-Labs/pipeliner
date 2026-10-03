import { developmentCommand } from './development-commands.mjs';
import { containsSecret } from './commands.mjs';

export async function initDevelopment({ el, message }) {
  let state, pending = false, lastMessage; const $ = id => document.getElementById(id);
  const feedbackDrafts = new Map();
  const devLabel = dev => dev?.model ? (dev.connection === 'codex' ? 'Codex' : 'Ollama Cloud') + ' · ' + dev.model : 'No Dev chosen';
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' || operation === 'start' ? 'primary' : 'secondary'); node.id = id ?? 'dev-' + operation;
    node.disabled = pending || !state.storageAvailable; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function runCard(prefix) {
    const card = el('article', undefined, 'connection-card development-card'); card.id = prefix + '-run';
    const run = state.run, development = state.development;
    card.append(el('h2', run ? 'Issue #' + run.issue + ' · Development' : 'Development'), el('p', state.repositoryLabel ?? 'Select a repository first.', 'small'));
    if (run) {
      card.append(el('p', run.control === 'paused' ? 'Paused · work preserved' : run.control === 'running' ? 'Running' : run.control, 'protected-state'),
        el('p', development?.state === 'candidate' ? state.integrationReady ? 'Verifying exact candidate integration and closeout under captured authority.' : 'Candidate ready for the configured PM Testing step.' : development ? state.stepLabel + ' · ' + development.state : 'Preparing the captured run.'),
        el('p', devLabel(state.runDeveloper) + ' · Worker: ' + (state.execution?.worker ?? 'not started'), 'small'));
      const controls = el('div', undefined, 'connection-actions');
      for (const [operation, label] of [['pause', 'Pause'], ['resume', 'Resume'], ['stop', 'Stop']]) {
        const node = button(label, operation, {}, prefix + '-' + operation);
        // Local controls remain available while a provider request is running.
        node.disabled = pending || operation === 'resume' && (!['paused', 'stopped', 'recovery-required'].includes(run.control) || state.pending.length > 0 && !state.integrationReady && state.qa?.decision !== 'approve');
        controls.append(node);
      } card.append(controls);
      if (development) card.append(el('p', 'Model turns: ' + development.turns + ' / ' + (run.limits?.['limits.issueTurns'] ?? 'captured limit') + ' per Issue · ' + (development.stepTurns ?? 0) + ' / ' + (run.limits?.['limits.stepTurns'] ?? 'captured limit') + ' for this step.', 'small'),
        el('p', 'Reported tokens: ' + (development.usage.input + development.usage.output) + (development.usage.unavailable ? ' · Some usage is unavailable.' : '.') + ' USD usage: unavailable.', 'small'),
        el('p', 'Remediation cycles: ' + (development.remediationCycles ?? 0) + ' · Dev takeovers: ' + (development.takeovers?.length ?? 0) + '. Recovery preserves these counters.', 'small'));
      if (state.publication) card.append(el('p', 'PR #' + state.publication.number + ' prepared. Head: ' + state.publication.head, 'small'), button('Open candidate PR', 'open-candidate', {}, prefix + '-open-candidate'));
      if (state.qa) card.append(qaCard(prefix));
    } else if (state.workspaceId) {
      card.append(el('p', 'Select a Ready Issue in Issues, then start it here or ask “Start this Issue”. A start request does not add Ready.'), button('Start selected Ready Issue', 'start', {}, prefix + '-start'));
    }
    if (state.error) card.append(el('p', state.error, 'connection-error'));
    if (state.pending.length) card.append(el('p', 'Pending remote readback: ' + state.pending.map(value => value.step).join(', ') + '. No duplicate write is sent.', 'availability'));
    return card;
  }
  function qaCard(prefix) {
    const qa = state.qa, showcase = qa.showcase, card = el('section', undefined, 'setup-preview'), title = prefix + '-qa-title';
    card.setAttribute('aria-labelledby', title); const heading = el('h3', 'PM Testing · current candidate'); heading.id = title;
    card.append(heading, el('p', showcase.summary), el('p', showcase.target, 'protected-state'));
    for (const [label, values] of [['Agent findings', showcase.findings.length ? showcase.findings.map(finding => finding.problem + ' ' + finding.remediation + ' Evidence: ' + finding.evidence) : ['None reported.']],
      ['Test results', showcase.testResults], ['Prerequisites', showcase.prerequisites], ['Regression checks', showcase.regressions], ['Limitations', showcase.limitations]]) {
      const list = el('ul'); for (const value of values) list.append(el('li', value)); card.append(el('h4', label), list);
    }
    const steps = el('ol'); for (const step of showcase.steps) { const item = el('li'); item.append(el('p', step.action), el('p', 'Expected: ' + step.expected, 'small')); steps.append(item); }
    card.append(el('h4', 'Test steps'), steps, el('p', 'Candidate: ' + showcase.candidate.sourceCommit + ' · Tree: ' + showcase.candidate.gitTree, 'small'), el('p', showcase.nextOutcome));
    if (qa.decision === 'approve') { card.append(el('p', 'Tested version approved. Resume verifies any interrupted integration and closeout; it does not send a duplicate merge.', 'protected-state')); return card; }
    const approve = button('Approve tested version', 'qa-approve', { hash: qa.hash }, prefix + '-qa-approve'); approve.disabled ||= state.busy;
    const key = state.workspaceId + ':' + qa.hash, feedback = el('textarea'), label = el('label', 'Corrections for this candidate');
    feedback.id = prefix + '-qa-feedback'; label.htmlFor = feedback.id; feedback.maxLength = 2000; feedback.rows = 3; feedback.value = feedbackDrafts.get(key) ?? '';
    feedback.disabled = pending || state.busy; feedback.addEventListener('input', () => feedbackDrafts.set(key, feedback.value));
    const submit = el('button', 'Send feedback', 'secondary'); submit.id = prefix + '-qa-send'; submit.disabled = pending || state.busy;
    submit.addEventListener('click', () => { const text = feedback.value.trim(); if (!text) { feedback.focus(); return; }
      if (containsSecret(text)) { feedback.value = ''; feedbackDrafts.delete(key); message('Use the protected connection surface for keys. Nothing was saved or sent.', false, state.workspaceId); feedback.focus(); return; }
      request({ operation: 'qa-feedback', hash: qa.hash, text });
    });
    const field = el('div', undefined, 'setup-field'); field.append(label, feedback);
    const actions = el('div', undefined, 'connection-actions'); actions.append(approve, submit);
    card.append(field, actions, el('p', 'You can also say “I approve this tested version” or “Please fix …” in chat.', 'small')); return card;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focus = document.activeElement?.id, opened = new Set([...$('agent-settings').querySelectorAll('details[open]')].map(node => node.id));
    if (state?.workspaceId !== snapshot.workspaceId) lastMessage = null;
    if (state?.qa?.hash !== snapshot.qa?.hash) feedbackDrafts.clear(); state = snapshot;
    $('development-status').replaceChildren(...(state.workspaceId ? [runCard('chat-development')] : []));
    const nodes = [el('h2', 'Agents and Models'), el('p', state.repositoryLabel ?? 'Select a repository to configure its Dev.', 'protected-state'),
      el('p', 'Choose a qualified provider and model. New runs pin that choice and any explicitly configured fallback order. Automatic takeover defaults off.', 'small')];
    if (!state.storageAvailable) nodes.push(el('p', 'Protected Development storage is unavailable.', 'availability'));
    if (state.workspaceId && state.storageAvailable) {
      const card = el('article', undefined, 'connection-card'); card.append(el('h3', 'Assigned Dev'), el('p', devLabel(state.configuredDev.binding), 'small'));
      if (!state.developers.length) card.append(el('p', 'No execution model is qualified. Use Connections to sign in and test a model. A successful connection probe alone does not qualify every execution path.', 'availability'));
      for (const dev of state.developers) card.append(button('Choose ' + (dev.connection === 'codex' ? 'Codex' : 'Ollama Cloud') + ' · ' + dev.model, 'dev-prepare', { dev: dev.id }, 'dev-choose-' + dev.id));
      nodes.push(card);
      const permissions = el('article', undefined, 'connection-card'); permissions.append(el('h3', 'Development permissions'), el('p', 'The host ceiling and this repository’s grants are separate. Review each scope deliberately.', 'small'));
      for (const scope of ['host', 'repository']) permissions.append(el('p', (scope === 'host' ? 'Host ceiling: ' : 'Repository grants: ') + state.permissions[scope].value.join(', '), 'small'), button('Review ' + scope + ' permissions', 'permissions-prepare', { scope }, 'dev-permissions-' + scope));
      nodes.push(permissions);
      if (state.preview) {
        const preview = state.preview, card = el('article', undefined, 'setup-preview'); card.id = 'dev-preview'; card.append(el('h3', 'Review the exact Development change'),
          el('p', preview.scope === 'host' ? 'Host scope · applies across this installation' : state.repositoryLabel + ' · repository scope', 'protected-state'));
        for (const [key, after] of Object.entries(preview.after)) {
          const readable = field => key === 'agents.dev' ? devLabel(field.binding) : Array.isArray(field.value) ? field.value.join(', ') : field.value ?? 'Not configured';
          card.append(el('p', after.label + ': ' + readable(preview.before[key]) + ' → ' + readable(after), 'small'));
        }
        card.append(el('p', 'Active work retains its captured policy. Revocation affects the next action. A provider turn sends this repository’s Issue and selected source content to that provider.', 'small'),
          button('Apply this Development change', 'apply', { hash: preview.hash }, 'dev-apply'), button('Cancel this change', 'cancel', {}, 'dev-cancel')); nodes.push(card);
      }
      nodes.push(runCard('settings-development'));
    }
    const skills = el('details', undefined, 'connection-card'); skills.id = 'dev-starter-skills'; skills.append(el('summary', 'Bundled starter skills · version and scope'));
    for (const skill of state.skills) skills.append(el('h3', skill.id + ' · ' + skill.version), el('p', skill.purpose), el('p', skill.source + ' · ' + skill.license + ' · ' + (skill.enabled ? 'Enabled for this repository' : 'Disabled or no repository selected'), 'small'),
      el('p', 'Trigger: ' + skill.trigger + '. No permission expansion. Digest: ' + skill.digest, 'small'));
    nodes.push(skills, el('p', state.limitations, 'small')); $('agent-settings').replaceChildren(...nodes);
    for (const id of opened) if ($(id)) $(id).open = true;
    if (focus && $(focus) && !$(focus).disabled) $(focus).focus();
    if (state.message && state.message !== lastMessage) { message(state.message, false, state.workspaceId); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || pending) return; const target = state.workspaceId; pending = true;
    try {
      const result = await window.pipeliner.developmentRequest({ ...payload, contextRevision: state.revision }); pending = false;
      if (target !== state.workspaceId) return;
      if (text) message(text, true, target);
      if (result.snapshot) render(result.snapshot); if (result.message) message(result.message, false, target);
    } catch {
      pending = false; const latest = await window.pipeliner.developmentRequest({ operation: 'status' }); render(latest);
      if (latest.workspaceId === target) message(latest.error ?? 'Development context changed. Review the selected repository and current configuration.', false, target);
    }
    if (!$('chat-view').hidden) $('prompt').focus();
  }
  window.pipeliner.onDevelopment(render); render(await window.pipeliner.developmentRequest({ operation: 'status' }));
  return { chat: text => request({ operation: 'chat', text }, text), handles: text => Boolean(developmentCommand(text)) };
}
