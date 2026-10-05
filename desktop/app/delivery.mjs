import { deliveryCommand } from './delivery-commands.mjs';

export async function initDelivery({ el, message, show, editRelease }) {
  const $ = id => document.getElementById(id); let state, requests = 0, lastMessage;
  const category = el('button', 'Delivery and Artifacts', 'category-button'); category.id = 'settings-delivery'; category.setAttribute('aria-pressed', 'false'); document.querySelector('.settings-categories').append(category);
  const section = el('section'); section.id = 'delivery-settings'; section.hidden = true; section.setAttribute('aria-label', 'Delivery and artifact settings'); $('settings-view').append(section);
  const chatPreview = el('section'); chatPreview.id = 'delivery-chat-preview'; chatPreview.setAttribute('aria-label', 'Current delivery preview'); $('composer').before(chatPreview);
  const scopeName = scope => scope === 'host' ? 'This Mac' : scope === 'global' ? 'Global defaults' : state.repository?.name ?? 'This repository';
  const readable = (key, value) => String(value) + (key === 'delivery.keepLatest' ? ' latest verified artifacts' : ' GiB');
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, ['apply', 'artifactApply'].includes(operation) ? 'primary' : 'secondary'); node.type = 'button'; if (id) node.id = id;
    node.disabled = !state.storageAvailable || (requests > 0 || state.busy) && operation !== 'cancel'; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function preview(p, suffix = '') {
    const card = el('article', undefined, 'setup-preview'); card.id = 'delivery-preview' + suffix; card.append(el('h3', 'Review delivery limits'),
      el('p', scopeName(p.scope) + ' · configuration version ' + p.baseRevision + '. Applies to future allocation and cleanup. Pinned, active and known-good recovery targets remain protected.', 'small'));
    for (const [key, row] of Object.entries(p.after)) card.append(el('p', row.label + ': ' + readable(key, p.before[key].value) + ' becomes ' + readable(key, row.value) + '. Source: ' + row.source + '.'));
    card.append(button('Apply delivery change', 'apply', { hash: p.hash }, 'delivery-apply' + suffix), button('Cancel change', 'cancel', {}, 'delivery-cancel' + suffix)); return card;
  }
  function artifactPreview(p, suffix = '') {
    const card = el('article', undefined, 'setup-preview'); card.id = 'artifact-preview' + suffix;
    const action = { pin: 'Pin artifact', unpin: 'Remove artifact pin', recovery: 'Choose recovery target', retain: 'Remove older artifacts', discard: 'Discard interrupted allocation' }[p.action];
    card.append(el('h3', action), el('p', 'Repository: ' + state.repository.name + '. Applies to these exact retained bytes.', 'small'));
    if (p.name) card.append(el('p', p.name));
    if (p.action === 'recovery') card.append(el('p', 'Verify the stored bytes, then replace this repository’s prior recovery designation. Native validation provenance remains visible.'));
    if (p.action === 'discard') card.append(el('p', p.disposition.kind === 'absent' ? 'The exact allocation file is absent. Clear its reservation after readback; keep a minimal receipt. No file will be removed.' : 'Remove only this unchanged, owned interrupted allocation after verifying its recorded ciphertext digest. Removal cannot be undone. Source files, pins, active artifacts and recovery targets remain.'), el('p', 'The recorded command will stay blocked from automatic replay. A new build requires a deliberate new run.', 'small'));
    if (p.action === 'retain') {
      card.append(el('p', p.remove.length + ' eligible artifacts in this batch (up to 50). Latest, pinned, active and recovery artifacts remain protected. Removal cannot be undone.'));
      for (const name of p.names) card.append(el('p', name, 'small'));
    }
    card.append(button('Apply artifact change', 'artifactApply', { hash: p.hash }, 'artifact-apply' + suffix), button('Cancel change', 'cancel', {}, 'artifact-cancel' + suffix)); return card;
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
      const inventory = el('article', undefined, 'connection-card'); inventory.id = 'delivery-inventory'; inventory.append(el('h3', 'Retained artifacts'));
      const retained = state.artifacts;
      if (!state.repository) inventory.append(el('p', 'Choose a repository to inspect its retained artifacts.', 'small'));
      else if (!retained || retained.unavailable) inventory.append(el('p', 'Artifact storage needs recovery. Existing bytes are preserved; new allocations and cleanup remain blocked.', 'availability'));
      else {
        const allocation = retained.usedBytes >= 1024 ** 3 ? (retained.usedBytes / 1024 ** 3).toFixed(2) + ' GiB' : (retained.usedBytes / 1024 ** 2).toFixed(2) + ' MiB';
        inventory.append(el('p', allocation + ' allocated on this Mac, including protected reservations and metadata.', 'small'));
        if (retained.overCapacity || retained.warning) { const note = el('p', retained.overCapacity ? 'Host capacity reached. New allocations are blocked. Review safe retention or change the host limit.' : 'Artifact storage warning reached. Review safe retention before capacity fills.', 'availability'); note.setAttribute('role', 'status'); inventory.append(note); }
        if (!retained.items.length) inventory.append(el('p', 'No retained artifacts for this repository. Qualified local builds will supply verified outputs here.', 'small'));
        for (const item of retained.items) {
          const card = el('article', undefined, 'artifact-record'); card.append(el('h4', item.manifest.name), el('p', (item.state === 'verified' ? 'Stored bytes verified' : 'Needs recovery') + (item.pinned ? ' · pinned' : '') + (item.recovery ? ' · recovery target' : '') + (item.active ? ' · in use' : ''), 'small'),
            el('p', item.manifest.validation.protocol === 'synthetic-custody-fixture' ? 'Synthetic storage fixture. Native installer validation remains untested.' : 'Validation evidence recorded. Inspect artifact evidence before installation.', 'small'));
          const details = el('details'); details.append(el('summary', 'Artifact evidence'), el('p', 'Source: ' + item.manifest.sourceCommit, 'small'), el('p', 'Tree: ' + item.manifest.gitTree, 'small'), el('p', 'Checksum: ' + item.manifest.sha256, 'small'), el('p', 'Validation: ' + item.manifest.validation.protocol + ' · ' + item.manifest.validation.result, 'small'), el('p', 'Host: macOS ' + item.manifest.host.version + ' · ' + item.manifest.host.architecture + '. Size: ' + item.manifest.bytes + ' bytes.', 'small')); card.append(details);
          if (item.state === 'verified') {
            card.append(button(item.pinned ? 'Review unpin' : 'Review pin', 'artifact', { action: item.pinned ? 'unpin' : 'pin', id: item.id }, 'artifact-pin-' + item.id), button('Review recovery target', 'artifact', { action: 'recovery', id: item.id }, 'artifact-recovery-' + item.id));
          } else { card.append(el('p', 'Held for recovery; automatic replay and retention are blocked.', 'availability')); if (!item.active && !item.pinned && !item.recovery) card.append(button('Review interrupted allocation', 'artifact', { action: 'discard', id: item.id }, 'artifact-discard-' + item.id)); }
          inventory.append(card);
        }
        inventory.append(button('Review safe retention', 'artifact', { action: 'retain' }, 'artifact-retain'));
        if (retained.more) inventory.append(button('Next artifact page', 'artifacts', { after: retained.after }));
        if (retained.items.length) inventory.append(button('Latest artifacts', 'artifacts'));
      }
      nodes.push(inventory);
      const host = el('article', undefined, 'connection-card'); host.id = 'delivery-host'; host.append(el('h3', 'Build prerequisites on this Mac'));
      if (state.prerequisites) {
        const p = state.prerequisites; host.append(el('p', p.host), el('p', 'Apple compiler: ' + (p.compiler === 'detected' ? 'detected, version ' + p.compilerVersion : p.compiler === 'missing' ? 'not found' : 'not verified')),
          el('p', 'Developer ID signing: ' + (p.developerId === 'detected' ? 'identity detected' : p.developerId === 'missing' ? 'no valid identity found' : 'not verified')),
          el('p', 'Local development signing: ' + (p.localReview === 'detected' ? 'identity detected; local review only' : p.localReview === 'missing' ? 'no valid identity found' : 'not verified')));
      } else host.append(el('p', state.busy ? 'Checking this Mac…' : 'Check installed build tools and signing prerequisites. Project files are not read or changed.', 'small'));
      host.append(el('p', 'Detection does not select a signing identity or establish notarization, compatible build execution or installer trust. Required Apple authorization stays in Apple’s own setup.', 'small'));
      const actions = el('div', undefined, 'connection-actions'); actions.append(button('Check this Mac', 'inspect', {}, 'delivery-check'), button('Apple build tools setup', 'help', { kind: 'tools' }, 'delivery-help-tools'), button('Apple signing setup', 'help', { kind: 'signing' }, 'delivery-help-signing'));
      if (state.busy) actions.append(button('Cancel delivery action', 'cancel', {}, 'delivery-check-cancel')); host.append(actions); nodes.push(host);
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
    if (state.preview) nodes.push(preview(state.preview)); if (state.artifactPreview) nodes.push(artifactPreview(state.artifactPreview));
    chatPreview.replaceChildren(...(state.preview ? [preview(state.preview, '-chat')] : state.artifactPreview ? [artifactPreview(state.artifactPreview, '-chat')] : []));
    if (state.message) nodes.push(el('p', state.message, 'protected-state')); section.replaceChildren(...nodes);
    if (focused && $(focused) && !$(focused).disabled) $(focused).focus({ preventScroll: true });
    if (state.message && state.message !== lastMessage) { message(state.message); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || requests && payload.operation !== 'cancel') return; requests++;
    if (text) message(text, true); if (text && ['view', 'inspect', 'artifacts'].includes(deliveryCommand(text)?.operation)) show();
    try { const result = await window.pipeliner.deliveryRequest({ ...payload, contextRevision: state.revision }); requests--; render(result.snapshot ?? state); }
    catch { requests--; render(await window.pipeliner.deliveryRequest({ operation: 'status' })); message('Delivery action could not finish. Inspect the current scope and values, then create a fresh preview.'); }
    if (!$('chat-view').hidden) $('prompt').focus({ preventScroll: true });
  }
  window.pipeliner.onDelivery(render); render(await window.pipeliner.deliveryRequest({ operation: 'status' }));
  return { handles: text => Boolean(deliveryCommand(text)), chat: text => request({ operation: 'chat', text }, text) };
}
