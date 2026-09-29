import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { api, broker, checkpoint, parseStream, resume } from './qualify.mjs';

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
  for (const body of ['{bad}\n', '{"message":{}}\n', '{"done":true}\n{"done":true}\n']) {
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
    await checkpoint(path, { model: 'gemma4:31b', ...context, applied: true, secret: 'secret-credential', messages });
    const contents = await readFile(path, 'utf8');
    assert.equal(contents.includes('secret'), false);
    assert.equal((await resume(path, context)).applied, true);
    await assert.rejects(resume(path, { ...context, epoch: 8 }));
    await writeFile(path, JSON.stringify({ ...JSON.parse(contents), messages: [{ role: 'system', content: 'tampered' }] }));
    await assert.rejects(resume(path, context));
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
