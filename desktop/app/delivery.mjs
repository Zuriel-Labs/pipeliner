import { deliveryCommand } from './delivery-commands.mjs';

export async function initDelivery({ el, message, show, editRelease }) {
  const $ = id => document.getElementById(id); let state, requests = 0, lastMessage;
  const category = el('button', 'Delivery and Artifacts', 'category-button'); category.id = 'settings-delivery'; category.setAttribute('aria-pressed', 'false'); document.querySelector('.settings-categories').append(category);
  const section = el('section'); section.id = 'delivery-settings'; section.hidden = true; section.setAttribute('aria-label', 'Delivery and artifact settings'); $('settings-view').append(section);
  const chatPreview = el('section'); chatPreview.id = 'delivery-chat-preview'; chatPreview.setAttribute('aria-label', 'Current delivery preview'); $('composer').before(chatPreview);
  const scopeName = scope => scope === 'host' ? 'This Mac' : scope === 'global' ? 'Global defaults' : state.repository?.name ?? 'This repository';
  const readable = (key, value) => String(value) + (key === 'delivery.keepLatest' ? ' latest verified artifacts' : ' GiB');
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); node.type = 'button'; if (id) node.id = id;
    node.disabled = !state.storageAvailable || (requests > 0 || state.busy) && operation !== 'cancel'; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function preview(p, suffix = '') {
    const card = el('article', undefined, 'setup-preview'); card.id = 'delivery-preview' + suffix; card.append(el('h3', 'Review delivery limits'),
      el('p', scopeName(p.scope) + ' · configuration version ' + p.baseRevision + '. Applies to future allocation and cleanup. Pinned, active and known-good recovery targets remain protected.', 'small'));
    for (const [key, row] of Object.entries(p.after)) card.append(el('p', row.label + ': ' + readable(key, p.before[key].value) + ' becomes ' + readable(key, row.value) + '. Source: ' + row.source + '.'));
    card.append(button('Apply delivery change', 'apply', { hash: p.hash }, 'delivery-apply' + suffix), button('Cancel change', 'cancel', {}, 'delivery-cancel' + suffix)); return card;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, previous = $('delivery-form'), unchanged = state && state.scope === snapshot.scope && state.repository?.id === snapshot.repository?.id && JSON.stringify(state.values) === JSON.stringify(snapshot.values),
      draft = unchanged && previous ? Object.fromEntries([...previous.querySelectorAll('[data-key]')].map(input => [input.dataset.key, input.value])) : null;
    state = snapshot;
    const head = el('article', undefined, 'connection-card'); head.append(el('p', 'From verified work to a local installer', 'kicker'), el('h2', 'Delivery and artifacts'),
      el('p', state.repository ? 'Selected repository: ' + state.repository.name : 'Choose a repository to inspect its delivery settings.', 'small'));
    const nodes = [head];
    if (!state.storageAvailable) nodes.push(el('p', 'Protected configuration is loading or unavailable. Delivery changes stay blocked until it opens safely.', 'availability'));
    else {
      const artifact = el('article', undefined, 'connection-card'); artifact.id = 'delivery-artifact'; artifact.append(el('h3', 'Your installer'),
        el('p', 'No verified project installer is available yet. A compatible local build, exact source and tree, installer checksum and native validation are required.', 'availability'),
        el('p', 'Mac project build isolation is not qualified yet. Builds remain blocked. Windows and Linux installers require matching hosts.', 'small'),
        el('p', 'GitHub Releases publication is ' + (state.values['delivery.publish'].value ? 'configured in the Release pipeline' : 'off') + ' for ' + scopeName(state.scope) + '. Publication must use the same verified artifact.', 'small'));
      const release = el('button', 'Inspect Release pipeline', 'secondary'); release.type = 'button'; release.disabled = requests > 0 || state.busy;
      release.addEventListener('click', () => editRelease(state.scope === 'repository' ? 'repository' : 'global')); artifact.append(release); nodes.push(artifact);
      const host = el('article', undefined, 'connection-card'); host.id = 'delivery-host'; host.append(el('h3', 'Build prerequisites on this Mac'));
      if (state.prerequisites) {
        const p = state.prerequisites; host.append(el('p', p.host), el('p', 'Apple compiler: ' + (p.compiler === 'detected' ? 'detected, version ' + p.compilerVersion : p.compiler === 'missing' ? 'not found' : 'not verified')),
          el('p', 'Developer ID signing: ' + (p.developerId === 'detected' ? 'identity detected' : p.developerId === 'missing' ? 'no valid identity found' : 'not verified')),
          el('p', 'Local development signing: ' + (p.localReview === 'detected' ? 'identity detected; local review only' : p.localReview === 'missing' ? 'no valid identity found' : 'not verified')));
      } else host.append(el('p', state.busy ? 'Checking this Mac…' : 'Check installed build tools and signing prerequisites. Project files are not read or changed.', 'small'));
      host.append(el('p', 'Detection does not select a signing identity or establish notarization, compatible build execution or installer trust. Required Apple authorization stays in Apple’s own setup.', 'small'));
      const actions = el('div', undefined, 'connection-actions'); actions.append(button('Check this Mac', 'inspect', {}, 'delivery-check'), button('Apple build tools setup', 'help', { kind: 'tools' }, 'delivery-help-tools'), button('Apple signing setup', 'help', { kind: 'signing' }, 'delivery-help-signing'));
      if (state.busy) actions.append(button('Cancel Mac check', 'cancel', {}, 'delivery-check-cancel')); host.append(actions); nodes.push(host);
      const form = el('form', undefined, 'connection-card'); form.id = 'delivery-form'; form.append(el('h3', 'Retention and storage limits'));
      const scopes = el('div', undefined, 'connection-actions');
      for (const scope of ['repository', 'global', 'host']) { const choose = button(scopeName(scope), 'scope', { scope }, 'delivery-scope-' + scope); choose.setAttribute('aria-pressed', String(state.scope === scope)); if (scope === 'repository' && !state.repository) choose.disabled = true; scopes.append(choose); } form.append(scopes);
      const keys = state.scope === 'host' ? ['delivery.warningGiB', 'delivery.capacityGiB'] : ['delivery.keepLatest'];
      for (const key of keys) {
        const value = state.values[key], row = el('div', undefined, 'setup-field'), label = el('label', value.label + (key === 'delivery.keepLatest' ? '' : ' (GiB)')), input = el('input');
        input.id = key.replaceAll('.', '-'); label.htmlFor = input.id; input.dataset.key = key; input.dataset.current = value.value;
        input.type = 'number'; input.min = 1; input.max = key === 'delivery.keepLatest' ? 100 : 100000; input.step = 1; input.required = true;
        input.value = draft?.[key] ?? input.dataset.current; input.disabled = requests > 0 || state.busy;
        row.append(label, input, el('p', 'Source: ' + value.source + '. ' + (state.scope === 'host' ? 'This Mac ceiling applies to every repository.' : 'Pinned, active and the known-good recovery artifact are retained in addition.'), 'small')); form.append(row);
      }
      form.append(el('p', 'Saving changes settings only. Future allocations require their own free-space check; future cleanup must preserve protected artifacts.', 'small'));
      const submit = el('button', 'Review delivery limits', 'primary'); submit.type = 'submit'; submit.disabled = requests > 0 || state.busy; form.append(submit, button('Review inherited defaults', 'reset', { scope: state.scope }, 'delivery-reset'));
      form.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'prepare', scope: state.scope, changes: Object.fromEntries([...form.querySelectorAll('[data-key]')].filter(input => input.value !== input.dataset.current).map(input => [input.dataset.key, Number(input.value)])) }); }); nodes.push(form);
    }
    if (state.preview) nodes.push(preview(state.preview)); chatPreview.replaceChildren(...(state.preview ? [preview(state.preview, '-chat')] : []));
    if (state.message) nodes.push(el('p', state.message, 'protected-state')); section.replaceChildren(...nodes);
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus({ preventScroll: true });
    if (state.message && state.message !== lastMessage) { message(state.message); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || requests && payload.operation !== 'cancel') return; requests++;
    if (text) message(text, true); if (text && ['view', 'inspect'].includes(deliveryCommand(text)?.operation)) show();
    try { const result = await window.pipeliner.deliveryRequest({ ...payload, contextRevision: state.revision }); requests--; render(result.snapshot ?? state); }
    catch { requests--; render(await window.pipeliner.deliveryRequest({ operation: 'status' })); message('Delivery action could not finish. Inspect the current scope and values, then create a fresh preview.'); }
    if (!$('chat-view').hidden) $('prompt').focus({ preventScroll: true });
  }
  window.pipeliner.onDelivery(render); render(await window.pipeliner.deliveryRequest({ operation: 'status' }));
  return { handles: text => Boolean(deliveryCommand(text)), chat: text => request({ operation: 'chat', text }, text) };
}
