import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://ollama.com';
const LIMIT = 1024 * 1024;
const fixture = 'fixture-ok';

export async function parseStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', size = 0, done = false;
  const message = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  const usage = { input: null, output: null };
  const line = (text) => {
    if (done) throw new Error('stream-after-terminal');
    let part;
    try { part = JSON.parse(text); } catch { throw new Error('malformed-stream'); }
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('malformed-stream');
    const chunk = part.message;
    if (chunk !== undefined) {
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new Error('malformed-message');
      for (const key of ['content', 'thinking']) {
        if (chunk[key] !== undefined) {
          if (typeof chunk[key] !== 'string') throw new Error('malformed-message');
          message[key] += chunk[key];
        }
      }
      if (chunk.tool_calls !== undefined) {
        if (!Array.isArray(chunk.tool_calls)) throw new Error('malformed-tools');
        message.tool_calls.push(...chunk.tool_calls);
      }
    }
    if (part.done === true) {
      done = true;
      if (Number.isSafeInteger(part.prompt_eval_count)) usage.input = part.prompt_eval_count;
      if (Number.isSafeInteger(part.eval_count)) usage.output = part.eval_count;
    } else if (part.done !== false) throw new Error('missing-done-field');
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIMIT) throw new Error('stream-too-large');
      pending += decoder.decode(next.value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const text = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (text) line(text);
      }
      if (pending.length > LIMIT) throw new Error('line-too-large');
    }
    pending += decoder.decode();
    if (pending.trim()) throw new Error('incomplete-line');
    if (!done) throw new Error('missing-terminal');
    return { ...message, usage };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export function broker(call, state) {
  if (state.applied || !call || typeof call !== 'object' || Array.isArray(call)) return { allowed: false };
  const fn = call.function;
  if (!fn || fn.name !== 'lookup_fixture') return { allowed: false };
  let args = fn.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return { allowed: false }; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { allowed: false };
  if (JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(['epoch', 'nonce', 'target'])) return { allowed: false };
  if (args.target !== state.target || args.nonce !== state.nonce || args.epoch !== state.epoch) return { allowed: false };
  state.applied = true;
  return { allowed: true, result: fixture };
}

export async function checkpoint(path, state) {
  assert.equal(state.applied, true);
  assert.equal(typeof state.model, 'string');
  assert.equal(typeof state.target, 'string');
  assert.equal(typeof state.nonce, 'string');
  assert.equal(Number.isSafeInteger(state.epoch), true);
  const data = { version: 1, model: state.model, target: state.target, nonce: state.nonce,
    epoch: state.epoch, applied: true, messages: state.messages };
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function resume(path, expected) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (data.version !== 1 || data.applied !== true || typeof data.model !== 'string' ||
    data.target !== expected.target || data.nonce !== expected.nonce || data.epoch !== expected.epoch ||
    !Array.isArray(data.messages) || data.messages.length !== 3 ||
    data.messages[0]?.role !== 'user' || typeof data.messages[0].content !== 'string' ||
    data.messages[1]?.role !== 'assistant' || !Array.isArray(data.messages[1].tool_calls) ||
    data.messages[1].tool_calls.length !== 1 ||
    !broker(data.messages[1].tool_calls[0], { ...data, applied: false }).allowed ||
    data.messages[2]?.role !== 'tool' || data.messages[2].tool_name !== 'lookup_fixture' ||
    data.messages[2].content !== fixture) throw new Error('checkpoint-mismatch');
  return data;
}

export async function api(path, key, options = {}, send = fetch, timeoutMs = 30000) {
  if (path !== '/api/tags' && path !== '/api/chat') throw new Error('endpoint-denied');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await send(`${ORIGIN}${path}`, {
      method: options.body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    return options.consume ? await options.consume(response) : response;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('timeout');
    if (/^http-\d+$/.test(error.message)) throw error;
    throw new Error('transport-failed');
  } finally { clearTimeout(timer); }
}

async function readBounded(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '', size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return result + decoder.decode();
      size += next.value.byteLength;
      if (size > LIMIT) throw new Error('catalog-too-large');
      result += decoder.decode(next.value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function catalog(key) {
  const text = await api('/api/tags', key, { consume: (response) => readBounded(response.body) });
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('catalog-malformed'); }
  if (!Array.isArray(result.models)) throw new Error('catalog-malformed');
  return result.models.map((model) => model.name).filter((name) => typeof name === 'string');
}

async function chat(key, model, messages, tools) {
  return api('/api/chat', key, { body: {
    model, messages, tools, stream: true, options: { temperature: 0, num_predict: 128 },
  }, consume: (response) => parseStream(response.body) });
}

async function live() {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) throw new Error('key-unavailable');
  const models = await catalog(key).catch((error) => { throw new Error(`catalog-${error.message}`); });
  const model = models.includes('gemma4:31b') ? 'gemma4:31b' : models[0];
  if (!model) throw new Error('catalog-empty');
  const context = { target: 'synthetic-pipeliner-repo', nonce: randomUUID(), epoch: 1, applied: false };
  const tool = { type: 'function', function: { name: 'lookup_fixture', description: 'Read one synthetic fixture.',
    parameters: { type: 'object', required: ['target', 'nonce', 'epoch'], properties: {
      target: { type: 'string' }, nonce: { type: 'string' }, epoch: { type: 'integer' },
    } } } };
  const prompt = `Call lookup_fixture once with target ${context.target}, nonce ${context.nonce}, epoch ${context.epoch}. Use the tool before answering.`;
  const first = await chat(key, model, [{ role: 'user', content: prompt }], [tool])
    .catch((error) => { throw new Error(`first-chat-${error.message}`); });
  const report = { model, catalogCount: models.length, streamedTerminal: true,
    toolCalls: first.tool_calls.length, usage: first.usage, brokerAllowed: false, resumed: false };
  if (first.tool_calls.length === 1) {
    const result = broker(first.tool_calls[0], context);
    report.brokerAllowed = result.allowed;
    if (result.allowed) {
      const dir = await mkdtemp(join(tmpdir(), 'pipeliner-ollama-live-'));
      try {
        const path = join(dir, 'checkpoint.json');
        const messages = [
          { role: 'user', content: prompt },
          { role: 'assistant', content: first.content, thinking: first.thinking, tool_calls: first.tool_calls },
          { role: 'tool', tool_name: 'lookup_fixture', content: result.result },
        ];
        await checkpoint(path, { model, ...context, messages });
        const restored = await resume(path, context);
        if (broker(first.tool_calls[0], restored).allowed) throw new Error('replay-allowed');
        const next = await chat(key, model, restored.messages, undefined)
          .catch((error) => { throw new Error(`resume-chat-${error.message}`); });
        report.resumed = Boolean(next.content || next.thinking);
        report.resumeUsage = next.usage;
      } finally { await rm(dir, { recursive: true }); }
    }
  }
  try { await api('/api/chat', 'deliberately-invalid-pipeliner-probe', { body: {
    model, messages: [{ role: 'user', content: 'Hi' }], stream: false,
  } }); report.invalidKeyRejected = false; }
  catch (error) { report.invalidKeyRejected = error.message === 'http-401'; }
  console.log(JSON.stringify(report));
  if (!report.brokerAllowed || !report.resumed || !report.invalidKeyRejected) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  live().catch((error) => {
    console.error(JSON.stringify({ qualificationError: error.message }));
    process.exitCode = 1;
  });
}
