import { repositories, journeys, settings, makeProposal, applyProposal } from './state.mjs';

const byId = id => document.getElementById(id);
const state = { repositoryId: repositories[0].id, view: 'work', settingId: 'connections', version: 0, pending: null, overrides: new Map(), transcripts: new Map() };
const after = { intake: 'Fully Autonomous · zero Pipeliner gates', pipelines: 'Accessibility review after design', scheduling: 'Every 30 minutes · background still off', limits: '15 turns per step', testing: 'PM testing before merge', appearance: 'Dark theme' };

function node(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
function announce(message) { byId('announcement').textContent = message; }
function selectedRepository() { return repositories.find(item => item.id === state.repositoryId); }

function renderRepositories() {
  const list = byId('repositories'); list.replaceChildren();
  for (const repository of repositories) {
    const button = node('button', repository.name, 'repository');
    button.type = 'button'; button.setAttribute('aria-pressed', String(repository.id === state.repositoryId));
    button.addEventListener('click', () => {
      state.repositoryId = repository.id;
      renderRepositories(); renderContext(); renderTranscript(); renderSetting();
      announce(`${repository.name} selected. Pending proposals keep their original target.`);
    });
    list.append(button);
  }
}
function renderContext() {
  const repository = selectedRepository();
  byId('target-name').textContent = repository.name;
  byId('work-title').textContent = repository.id === 'example-studio' ? 'See how PM testing will work.' : 'Choose an Issue to begin.';
  byId('issue-state').textContent = `${repository.issue} · ${repository.stage}`;
  byId('next-action').textContent = repository.id === 'example-studio' ? 'Next: inspect a synthetic handoff' : 'Next: draft or select an Issue';
  byId('scope-description').textContent = `${repository.name} · Repository view`;
  byId('evidence-status').textContent = repository.id === 'example-studio' ? 'Waiting for PM' : 'No active Issue';
  byId('evidence-detail').textContent = repository.id === 'example-studio'
    ? 'Example Issue #42 remains active until its configured outcome is verified.'
    : 'Field Notes has no active Issue or candidate. Select or draft an Issue before work starts.';
}
function renderTranscript() {
  if (!state.transcripts.has(state.repositoryId)) {
    const guide = node('article', '', 'message assistant');
    guide.append(node('div', 'Pipeliner · Prototype guide', 'message-label'),
      node('p', `This is ${selectedRepository().name}'s synthetic conversation. Rehearse a guided task. No live action can occur.`));
    state.transcripts.set(state.repositoryId, [guide]);
  }
  byId('transcript').replaceChildren(...state.transcripts.get(state.repositoryId));
}
function setView(view) {
  state.view = view;
  byId('work-view').hidden = view !== 'work'; byId('settings-view').hidden = view !== 'settings';
  for (const [id, active] of [['work-nav', view === 'work'], ['settings-nav', view === 'settings']]) {
    const button = byId(id); button.classList.toggle('current', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  if (view === 'settings') { renderCategories(); renderSetting(); byId('settings-title').focus(); }
  else byId('work-title').focus();
}
function closeEvidence() {
  byId('evidence').classList.add('closed');
  byId('main').inert = false; document.querySelector('.rail').inert = false;
  byId('evidence-nav').focus();
}
function openEvidence() {
  byId('evidence').classList.remove('closed');
  if (matchMedia('(max-width: 1130px)').matches) {
    byId('main').inert = true; document.querySelector('.rail').inert = true;
  }
  byId('close-evidence').focus();
}

function addMessage(kind, label, content, action) {
  const article = node('article', '', `message ${kind}`);
  article.append(node('div', label, 'message-label'), node('p', content));
  if (action) {
    const button = node('button', action.label, 'secondary'); button.type = 'button';
    button.addEventListener('click', () => { setView('settings'); state.settingId = action.settingId; renderCategories(); renderSetting(); });
    article.append(button);
  }
  state.transcripts.get(state.repositoryId).push(article);
  byId('transcript').append(article);
}
function chooseJourney(journey) {
  addMessage('pm', 'PM · Rehearsal', journey.prompt);
  addMessage('assistant', `Pipeliner · ${journey.title} · Simulated`, `${journey.detail} No live action occurred.`, { label: journey.next, settingId: journey.setting });
  announce(`${journey.title} shown. No live action occurred.`);
}
function renderJourneys() {
  const list = byId('journey-list'); list.replaceChildren();
  for (const journey of journeys) {
    const button = node('button', journey.label, 'journey-button'); button.type = 'button';
    button.addEventListener('click', () => chooseJourney(journey)); list.append(button);
  }
}
function renderCategories() {
  const query = byId('settings-search').value.trim().toLowerCase();
  const list = byId('category-list'); list.replaceChildren();
  for (const setting of settings.filter(item => `${item.name} ${item.detail} ${item.value} ${item.search ?? ''}`.toLowerCase().includes(query))) {
    const button = node('button', `${setting.code} · ${setting.name}`, 'category-button'); button.type = 'button';
    button.setAttribute('aria-pressed', String(setting.id === state.settingId));
    button.addEventListener('click', () => { state.settingId = setting.id; renderCategories(); renderSetting(); });
    list.append(button);
  }
  if (!list.children.length) list.append(node('p', 'No setting matches. Try another ordinary term.', 'small'));
}
function renderSetting() {
  const setting = settings.find(item => item.id === state.settingId); if (!setting) return;
  const detail = byId('setting-detail'); detail.replaceChildren();
  const scope = byId('scope').value;
  detail.append(node('p', setting.code, 'kicker'), node('h2', setting.name), node('p', setting.detail));
  const value = state.overrides.get(`${state.repositoryId}:${setting.id}`) ?? setting.value;
  const effective = node('div', '', 'effective');
  effective.append(node('span', 'Effective value', 'small'), node('strong', value), node('span', `Source: ${state.overrides.has(`${state.repositoryId}:${setting.id}`) ? 'Prototype repository override' : setting.source}`, 'small'));
  detail.append(effective, node('p', `Default: ${setting.value}`, 'small'), node('p', `Scope: ${setting.scope}`, 'small'), node('p', `Timing: ${setting.timing}`, 'small'));
  if (!setting.available) { detail.append(node('p', 'Unavailable in this prototype. This control needs the qualified product runtime.', 'availability')); return; }
  if (scope === 'global') { detail.append(node('p', 'Global changes are read-only in this prototype. Return to selected repository to rehearse a proposal.', 'availability')); return; }
  if (state.pending && state.pending.settingId !== setting.id) {
    const old = settings.find(item => item.id === state.pending.settingId);
    detail.append(node('p', `A ${old.name} proposal is still pending for ${repositories.find(item => item.id === state.pending.repositoryId).name}. Review or discard it before starting another.`, 'availability'));
    const review = node('button', 'Review pending proposal', 'secondary'); review.type = 'button';
    review.addEventListener('click', () => { state.settingId = old.id; renderCategories(); renderSetting(); });
    detail.append(review); return;
  }
  if (state.pending && state.pending.settingId === setting.id) {
    const proposal = node('section', '', 'proposal');
    proposal.append(node('h3', 'Example proposal · simulated'), node('p', `Target: ${repositories.find(item => item.id === state.pending.repositoryId)?.name ?? 'Unknown'}`),
      node('p', `Before: ${setting.value}`), node('p', `After: ${after[setting.id]}`), node('p', `Effect: ${setting.timing}`));
    const actions = node('div', '', 'proposal-actions');
    const apply = node('button', 'Apply in prototype', 'primary'); apply.type = 'button';
    apply.addEventListener('click', () => {
      const outcome = applyProposal(state.pending, { repositoryId: state.repositoryId, settingId: state.settingId, version: state.version });
      if (!outcome.applied) { announce(outcome.reason); detail.append(node('p', outcome.reason, 'error')); return; }
      state.version = outcome.version;
      state.overrides.set(`${state.repositoryId}:${setting.id}`, after[setting.id]); state.pending = null;
      renderSetting(); announce('Prototype value changed. No real setting changed.');
    });
    const discard = node('button', 'Discard proposal', 'secondary'); discard.type = 'button';
    discard.addEventListener('click', () => { state.pending = null; renderSetting(); announce('Prototype proposal discarded.'); });
    actions.append(apply, discard); proposal.append(actions); detail.append(proposal);
  } else {
    const preview = node('button', `Preview example change`, 'secondary'); preview.type = 'button';
    preview.addEventListener('click', () => { state.pending = makeProposal({ repositoryId: state.repositoryId, settingId: setting.id, version: state.version }); renderSetting(); announce('Prototype proposal ready for review.'); });
    detail.append(preview);
  }
}

byId('work-nav').addEventListener('click', () => setView('work'));
byId('settings-nav').addEventListener('click', () => setView('settings'));
byId('evidence-nav').addEventListener('click', openEvidence);
byId('close-evidence').addEventListener('click', closeEvidence);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !byId('evidence').classList.contains('closed')) closeEvidence(); });
byId('settings-search').addEventListener('input', renderCategories);
byId('scope').addEventListener('change', () => { renderSetting(); announce(`${byId('scope').selectedOptions[0].textContent} shown.`); });
byId('composer').addEventListener('submit', event => {
  event.preventDefault(); const input = byId('message'); const message = input.value.trim(); if (!message) return;
  input.value = '';
  const exact = journeys.find(item => item.prompt.toLowerCase() === message.toLowerCase());
  const patterns = { setup: /\b(connect|import)\b/, issue: /\b(draft|create an issue|onboarding flow)\b/, supervised: /\b(test before merge|let me test)\b/, autonomous: /\b(automatically|autonomous)\b/, schedule: /\b(schedule|half hour)\b/, pipeline: /\b(pipeline|accessibility review)\b/, stop: /\b(stop work|pause work)\b/, delivery: /\b(installer|update pipeliner)\b/ };
  const matches = journeys.filter(item => patterns[item.id].test(message.toLowerCase()));
  const journey = exact ?? (matches.length === 1 ? matches[0] : null);
  if (journey) { addMessage('pm', 'PM · Rehearsal', message); addMessage('assistant', `Pipeliner · ${journey.title} · Simulated`, `${journey.detail} No live action occurred.`, { label: journey.next, settingId: journey.setting }); announce(`${journey.title} shown. No live action occurred.`); }
  else { addMessage('pm', 'PM · Rehearsal', message); addMessage('assistant', 'Pipeliner · Prototype limit', 'I cannot interpret that request in this prototype. Try a guided example. No action occurred.'); announce('Prototype cannot interpret the request. No action occurred.'); }
});
byId('work-title').tabIndex = -1; byId('settings-title').tabIndex = -1; byId('evidence-title').tabIndex = -1;
if (matchMedia('(max-width: 1130px)').matches) byId('evidence').classList.add('closed');
matchMedia('(max-width: 1130px)').addEventListener('change', event => {
  if (event.matches) {
    const focusWasInDrawer = byId('evidence').contains(document.activeElement);
    byId('evidence').classList.add('closed');
    byId('main').inert = false; document.querySelector('.rail').inert = false;
    if (focusWasInDrawer) byId('evidence-nav').focus();
  }
  else { byId('main').inert = false; document.querySelector('.rail').inert = false; }
});
renderRepositories(); renderContext(); renderTranscript(); renderJourneys(); renderCategories(); renderSetting();
