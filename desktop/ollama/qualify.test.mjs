import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { api, broker, checkpoint, parseStream, resume, selectedModel } from './qualify.mjs';

const context = { target: 'fixture-repo', nonce: 'nonce-123', epoch: 7 };
const call = { function: { name: 'lookup_fixture', arguments: context } };
const stream = (parts) => new ReadableStream({
  start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); },
});

test('stream waits for terminal chunk and decodes split UTF-8', async () => {
  const bytes = new TextEncoder().encode(`${JSON.stringify({ message: { content: '✓', tool_calls: [call] }, done: false })}\n${JSON.stringify({ done: true, prompt_eval_count: 9, eval_count: 3 })}\n`);
  const message = await parseStream(stream([...bytes].map((byte) => Uint8Array.of(byte))));
  assert.equal(message.content, '✓');
  assert.deepEqual(message.tool_calls, [call]);
  assert.deepEqual(message.usage, { input: 9, output: 3 });
});

test('malformed, incomplete, and duplicate terminal streams fail closed', async () => {
  for (const body of ['{bad}\n', '{"message":{}}\n', '{"done":true}\n{"done":true}\n',
    '{"message":{"role":"user"},"done":true}\n',
    '{"model":"a","done":false}\n{"model":"b","done":true}\n']) {
    await assert.rejects(parseStream(stream([new TextEncoder().encode(body)])));
  }
});

test('broker allows one exact synthetic effect and denies replay or wrong scope', () => {
  const state = { ...context, applied: false };
  assert.deepEqual(broker(call, state), { allowed: true, result: 'fixture-ok' });
  assert.equal(state.applied, true);
  assert.equal(broker(call, state).allowed, false);
  assert.equal(broker({ function: { name: 'lookup_fixture', arguments: { ...context, target: 'other' } } }, { ...context, applied: false }).allowed, false);
  assert.equal(broker({ function: { name: 'unknown', arguments: context } }, { ...context, applied: false }).allowed, false);
  assert.equal(broker(call, { ...context, epoch: 8, applied: false }).allowed, false);
});

test('checkpoint has no credential and resume cannot replay effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipeliner-ollama-test-'));
  try {
    const path = join(dir, 'checkpoint.json');
    const messages = [{ role: 'user', content: 'synthetic task' },
      { role: 'assistant', content: '', thinking: '', tool_calls: [call] },
      { role: 'tool', tool_name: 'lookup_fixture', content: 'fixture-ok' }];
    const expected = { ...context, model: 'deepseek-v4.1-flash', route: 'cloud' };
    await checkpoint(path, { ...expected, applied: true, secret: 'secret-credential', messages });
    const contents = await readFile(path, 'utf8');
    assert.equal(contents.includes('secret'), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await resume(path, expected)).applied, true);
    await assert.rejects(resume(path, { ...expected, epoch: 8 }));
    await assert.rejects(resume(path, { ...expected, route: 'local-cloud' }));
    await assert.rejects(resume(path, { ...expected, model: 'another-model' }));
    await writeFile(path, JSON.stringify({ ...JSON.parse(contents), messages: [{ role: 'system', content: 'tampered' }] }));
    await assert.rejects(resume(path, expected));
  } finally { await rm(dir, { recursive: true }); }
});

test('transport outage and cancellation never return a dispatchable message', async () => {
  await assert.rejects(api('/api/chat', 'test-key', {}, async () => { throw new Error('offline'); }), /transport-failed/);
  await assert.rejects(api('/api/chat', 'test-key', {}, async (_url, options) => {
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  }, 10), /timeout/);
});

test('Cloud request uses the exact fixed destination and bearer header', async () => {
  const key = 'synthetic-key';
  const response = await api('/api/chat', key, { body: { model: 'synthetic' } }, async (url, options) => {
    assert.equal(url, 'https://ollama.com/api/chat');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.redirect, 'error');
    return { ok: true, status: 200 };
  });
  assert.equal(response.status, 200);
  await assert.rejects(api('/unapproved', key), /endpoint-denied/);
});

test('explicit installed Cloud route drops the key and rejects foreign model metadata', async () => {
  await api('/api/chat', 'never-forward-this', { route: 'local-cloud', body: {} }, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
    return { ok: true, status: 200 };
  });
  const model = { name: 'deepseek-v4.1-flash:cloud', remote_host: 'https://ollama.com', remote_model: 'deepseek-v4.1-flash' };
  assert.equal(selectedModel([model], 'local-cloud').name, model.name);
  assert.throws(() => selectedModel([{ ...model, remote_host: 'https://other.invalid' }], 'local-cloud'));
  assert.throws(() => selectedModel([{ name: 'expensive-unconfigured-model' }], 'cloud'));
  await assert.rejects(api('/api/chat', 'key', { route: 'unapproved' }), /route-denied/);
});

test('caller cancellation prevents dispatch even after response consumption', async () => {
  const controller = new AbortController();
  let dispatched = false;
  await assert.rejects(api('/api/chat', 'key', { signal: controller.signal, consume() {
    controller.abort();
    return { complete: true };
  } }, async () => ({ ok: true, status: 200 })).then(() => { dispatched = true; }), /cancelled/);
  assert.equal(dispatched, false);
});
