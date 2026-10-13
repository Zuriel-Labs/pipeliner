import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./app.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');

function fixture() {
  const nodes = new Map();
  function element(id = '') {
    const listeners = new Map(), attributes = new Map();
    return { id, value: '', textContent: '', hidden: false, disabled: false, childNodes: [], children: [], dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      classList: { toggle() {} }, append() {}, replaceChildren() {}, focus() {}, getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
      setAttribute(key, value) { attributes.set(key, value); }, getAttribute(key) { return attributes.get(key) ?? null; }, removeAttribute(key) { attributes.delete(key); },
      addEventListener(name, callback) { listeners.set(name, callback); },
      submit() { listeners.get('submit')?.({ preventDefault() {} }); } };
  }
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const node = element(tag[1]); node.disabled = /\bdisabled(?:\s|>)/.test(tag[0]);
    if (/aria-busy="true"/.test(tag[0])) node.setAttribute('aria-busy', 'true');
    nodes.set(node.id, node);
  }
  const sendTag = html.match(/<button[^>]*type="submit"[^>]*>/)[0];
  const send = nodes.get('chat-send') ?? element(); send.disabled = /\bdisabled(?:\s|>)/.test(sendTag);
  nodes.set('chat-send', send);
  const node = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  let restore, finish, reached;
  const held = new Promise(resolve => { finish = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  const requests = [], manager = { handles: () => false };
  const context = { document: { getElementById: node, createElement: () => element(), querySelectorAll: () => [], activeElement: null },
    crypto: { randomUUID }, containsSecret: () => false, connectionCommand: () => ({}),
    window: { pipeliner: { onStatus() {}, request: async () => ({ revision: 1, storageAvailable: true, connections: [] }) } },
    initPrivacy: async options => { restore = options.history; return { record() {}, draft: async () => {}, handles: text => text === 'Show diagnostics', chat: text => requests.push(text) }; },
    initUpdates: async () => {
      restore({ repository: null, messages: [], older: false, replace: false, edit: 0, draft: 'Retained PM draft' });
      reached(); await held; return manager;
    } };
  for (const name of ['Workspaces', 'Issues', 'Pipelines', 'Development', 'Scheduling', 'Background', 'Skills', 'Tools', 'Appearance', 'Permissions', 'Delivery']) context['init' + name] = async () => manager;
  const running = runInNewContext(`(async () => {${source}\n})();`, context, { timeout: 1000 });
  return { node, send, requests, waiting, running, finish };
}

test('restored chat stays unavailable while its final manager and submit handler are not ready', async () => {
  const f = fixture();
  try {
    await f.waiting;
    assert.equal(f.node('prompt').value, 'Retained PM draft');
    assert.equal(f.node('prompt').disabled, true);
    assert.equal(f.send.disabled, true);
    assert.equal(f.node('composer').getAttribute('aria-busy'), 'true');
    assert.equal(f.node('chat-readiness').hidden, false);
    assert.deepEqual(f.requests, []);
  } finally { f.finish(); await f.running; }
});

test('ready chat preserves its draft and dispatches diagnostics through the existing route exactly once', async () => {
  const f = fixture(); await f.waiting; f.finish(); await f.running;
  assert.equal(f.node('prompt').disabled, false); assert.equal(f.send.disabled, false);
  assert.equal(f.node('composer').getAttribute('aria-busy'), null);
  assert.equal(f.node('chat-readiness').hidden, true);
  assert.equal(f.node('prompt').value, 'Retained PM draft');
  f.node('prompt').value = 'Show diagnostics'; f.node('composer').submit();
  assert.deepEqual(f.requests, ['Show diagnostics']); assert.equal(f.node('prompt').value, '');
});
