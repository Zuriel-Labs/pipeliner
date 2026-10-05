import { appearanceCommand } from './appearance-commands.mjs';

export async function initAppearance({ el, message, show }) {
  const $ = id => document.getElementById(id);
  let state, pending = false, lastMessage;
  const category = el('button', 'Appearance and Accessibility', 'category-button'); category.id = 'settings-appearance'; category.setAttribute('aria-pressed', 'false');
  document.querySelector('.settings-categories').append(category);
  const section = el('section'); section.id = 'appearance-settings'; section.hidden = true; section.setAttribute('aria-label', 'Appearance and accessibility settings'); $('settings-view').append(section);
  const chatPreview = el('section'); chatPreview.id = 'appearance-chat-preview'; chatPreview.setAttribute('aria-label', 'Current appearance preview'); $('composer').before(chatPreview);
  const labels = { system: 'Follow this Mac', light: 'Light', dark: 'Dark', comfortable: 'Comfortable', compact: 'Compact', reduced: 'Reduced motion' };
  const percentage = value => Number((value * 100).toPrecision(15));
  const readable = (key, value) => key === 'appearance.textScale' ? percentage(value) + '%' : labels[value] ?? String(value);
  function button(text, operation, extra = {}, id) {
    const node = el('button', text, operation === 'apply' ? 'primary' : 'secondary'); node.type = 'button'; node.id = id;
    node.disabled = !state.storageAvailable || pending; node.addEventListener('click', () => request({ operation, ...extra })); return node;
  }
  function preview(p, suffix = '') {
    const card = el('article', undefined, 'setup-preview'); card.id = 'appearance-preview' + suffix; card.append(el('h3', 'Review this Mac’s display'),
      el('p', 'From configuration version ' + p.baseRevision + '. Display changes immediately when applied. Active work keeps its captured configuration.', 'small'));
    for (const [key, row] of Object.entries(p.after)) card.append(el('p', row.label + ': ' + readable(key, p.before[key].value) + ' becomes ' + readable(key, row.value) + '. Source: ' + row.source + '.'));
    card.append(button('Apply appearance change', 'apply', { hash: p.hash }, 'appearance-apply' + suffix), button('Cancel change', 'cancel', {}, 'appearance-cancel' + suffix)); return card;
  }
  function render(snapshot) {
    if (state && snapshot.revision < state.revision) return;
    const focused = document.activeElement?.id, form = $('appearance-form'), unchanged = state && JSON.stringify(state.values) === JSON.stringify(snapshot.values),
      draft = unchanged && form ? Object.fromEntries([...form.querySelectorAll('[data-key]')].map(input => [input.dataset.key, input.value])) : null;
    state = snapshot;
    if (state.values) {
      const root = document.documentElement;
      root.style.fontSize = 16 * state.values['appearance.textScale'].value + 'px';
      root.style.setProperty('--text-scale', state.values['appearance.textScale'].value);
      root.dataset.density = state.values['appearance.density'].value; root.dataset.motion = state.values['appearance.motion'].value;
    }
    const head = el('article', undefined, 'connection-card'); head.append(el('p', 'Your display, your pace', 'kicker'), el('h2', 'Appearance and accessibility'),
      el('p', 'These preferences apply to this Pipeliner installation. System accessibility preferences remain in effect. Display changes leave projects, conversation drafts and active work intact.', 'small'));
    const nodes = [head];
    if (!state.storageAvailable) nodes.push(el('p', 'Protected configuration is loading or unavailable. Preferences stay blocked until it opens safely.', 'availability'));
    else {
      const form = el('form', undefined, 'connection-card'); form.id = 'appearance-form';
      for (const [key, options] of [['appearance.theme', ['system', 'light', 'dark']], ['appearance.density', ['comfortable', 'compact']], ['appearance.textScale', null], ['appearance.motion', ['system', 'reduced']]]) {
        const value = state.values[key], row = el('div', undefined, 'setup-field'), label = el('label', value.label + (options ? '' : ' (%)')), input = el(options ? 'select' : 'input');
        input.id = key.replaceAll('.', '-'); label.htmlFor = input.id; input.dataset.key = key;
        if (options) for (const value of options) { const option = el('option', labels[value]); option.value = value; input.append(option); }
        else { input.type = 'number'; input.min = 100; input.max = 200; input.step = 'any'; input.required = true; }
        input.dataset.current = options ? value.value : percentage(value.value);
        input.value = draft?.[key] ?? input.dataset.current; input.disabled = pending;
        row.append(label, input, el('p', 'Source: ' + value.source + '. Applies immediately after your change.', 'small')); form.append(row);
      }
      const submit = el('button', 'Review display change', 'primary'); submit.type = 'submit'; submit.disabled = pending; form.append(submit);
      form.addEventListener('submit', event => { event.preventDefault(); request({ operation: 'prepare', changes: Object.fromEntries([...form.querySelectorAll('[data-key]')].filter(input => input.value !== input.dataset.current).map(input => [input.dataset.key, input.dataset.key === 'appearance.textScale' ? Number(input.value) / 100 : input.value])) }); });
      form.append(button('Review default appearance', 'reset', {}, 'appearance-reset')); nodes.push(form);
    }
    if (state.preview) nodes.push(preview(state.preview)); chatPreview.replaceChildren(...(state.preview ? [preview(state.preview, '-chat')] : []));
    if (state.message) nodes.push(el('p', state.message, 'protected-state'));
    section.replaceChildren(...nodes); if (focused && $(focused) && !$(focused).disabled) $(focused).focus({ preventScroll: true });
    if (state.message && state.message !== lastMessage) { message(state.message, false); $('announcement').textContent = state.message; lastMessage = state.message; }
  }
  async function request(payload, text) {
    if (!state || pending) return; pending = true;
    if (text) message(text, true);
    if (text && appearanceCommand(text)?.operation === 'view') show();
    try { const result = await window.pipeliner.appearanceRequest({ ...payload, contextRevision: state.revision }); pending = false; render(result.snapshot ?? state); }
    catch { pending = false; render(await window.pipeliner.appearanceRequest({ operation: 'status' })); message('Appearance change could not finish. Review the current values and create a fresh preview.'); }
    if (!$('chat-view').hidden) $('prompt').focus({ preventScroll: true });
  }
  window.pipeliner.onAppearance(render); render(await window.pipeliner.appearanceRequest({ operation: 'status' }));
  return { handles: text => Boolean(appearanceCommand(text)), chat: text => request({ operation: 'chat', text }, text) };
}
