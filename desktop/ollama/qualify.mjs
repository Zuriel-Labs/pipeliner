import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { retryAfter } from '../core/reliability.mjs';

const ORIGINS = { cloud: 'https://ollama.com', 'local-cloud': 'http://127.0.0.1:11434' };
const MODELS = { cloud: 'deepseek-v4.1-flash', 'local-cloud': 'deepseek-v4.1-flash:cloud' };
const LIMIT = 1024 * 1024;
const fixture = 'fixture-ok';

export async function parseStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', size = 0, done = false, responseModel = null, doneReason = null;
  const message = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  const usage = { input: null, output: null };
  const line = (text) => {
    if (done) throw new Error('stream-after-terminal');
    let part;
    try { part = JSON.parse(text); } catch { throw new Error('malformed-stream'); }
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('malformed-stream');
    if (part.model !== undefined) {
      if (typeof part.model !== 'string' || (responseModel && part.model !== responseModel)) throw new Error('model-mismatch');
      responseModel = part.model;
    }
    const chunk = part.message;
    if (chunk !== undefined) {
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new Error('malformed-message');
      if (chunk.role !== undefined && chunk.role !== 'assistant') throw new Error('malformed-message');
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
      doneReason = typeof part.done_reason === 'string' ? part.done_reason : null;
      if (Number.isSafeInteger(part.prompt_eval_count) && part.prompt_eval_count >= 0) usage.input = part.prompt_eval_count;
      if (Number.isSafeInteger(part.eval_count) && part.eval_count >= 0) usage.output = part.eval_count;
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
    return { ...message, usage, responseModel, doneReason };
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
  assert.equal(Object.hasOwn(ORIGINS, state.route), true);
  const data = { version: 1, model: state.model, route: state.route, target: state.target, nonce: state.nonce,
    epoch: state.epoch, applied: true, messages: state.messages };
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function resume(path, expected) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (data.version !== 1 || data.applied !== true || data.model !== expected.model || data.route !== expected.route ||
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
  const route = options.route ?? 'cloud';
  if (!Object.hasOwn(ORIGINS, route)) throw new Error('route-denied');
  const paths = route === 'local-cloud' ? ['/api/tags', '/api/chat', '/api/version', '/api/show'] : ['/api/tags', '/api/chat'];
  if (!paths.includes(path)) throw new Error('endpoint-denied');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    signal.throwIfAborted();
    const response = await send(`${ORIGINS[route]}${path}`, {
      method: options.body ? 'POST' : 'GET',
      headers: { ...(route === 'cloud' ? { Authorization: `Bearer ${key}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'error',
      signal,
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); const error = new Error(`http-${response.status}`); error.retryAfterMs = retryAfter(response); throw error; }
    const result = options.consume ? await options.consume(response) : response;
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw new Error('cancelled');
    if (controller.signal.aborted) throw new Error('timeout');
    if (/^http-\d+$/.test(error.message)) throw error;
    if (/^(?:stream-|malformed-|missing-|model-mismatch|incomplete-line|line-too-large)/.test(error.message)) throw error;
    throw new Error('transport-failed');
  } finally { clearTimeout(timer); }
}

export async function readBounded(body) {
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

export async function catalog(key, route = 'cloud', options = {}) {
  const text = await api('/api/tags', key, { route, signal: options.signal, consume: (response) => readBounded(response.body) }, options.send ?? fetch);
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('catalog-malformed'); }
  if (!Array.isArray(result.models)) throw new Error('catalog-malformed');
  return result.models;
}

export function selectedModel(models, route) {
  const model = models.find((entry) => entry?.name === MODELS[route]);
  if (!model || (route === 'local-cloud' &&
    (model.remote_host !== 'https://ollama.com' || model.remote_model !== MODELS.cloud))) throw new Error('selected-model-unavailable');
  return model;
}

export async function chat(key, model, messages, tools, route = 'cloud', options = {}) {
  const numPredict = options.numPredict ?? 128;
  if (!Number.isSafeInteger(numPredict) || numPredict < 1 || numPredict > 8192) throw new Error('output-limit-invalid');
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('timeout-limit-invalid');
  const result = await api('/api/chat', key, { ...options, route, body: {
    model, messages, tools, stream: true, think: false, options: { temperature: 0, num_predict: numPredict },
  }, consume: options.consume ?? ((response) => parseStream(response.body)) }, options.send ?? fetch, timeoutMs);
  if (result.responseModel !== model && !(route === 'local-cloud' && model.endsWith(':cloud') && result.responseModel === model.slice(0, -6))) throw new Error('model-mismatch');
  if (result.doneReason === 'length') throw new Error('output-truncated');
  return result;
}

async function live() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--route=local-cloud' && arg !== '--route=cloud')) throw new Error('argument-denied');
  if (args.length > 1) throw new Error('argument-denied');
  const route = args[0]?.slice('--route='.length) ?? 'cloud';
  const key = route === 'cloud' ? process.env.OLLAMA_API_KEY : undefined;
  if (route === 'cloud' && !key) throw new Error('key-unavailable');
  const models = await catalog(key, route).catch((error) => { throw new Error(`catalog-${error.message}`); });
  const metadata = selectedModel(models, route);
  const model = metadata.name;
  let serviceVersion = null, capabilities = null;
  if (route === 'local-cloud') {
    const getJson = (path, body) => api(path, key, { route, body,
      consume: async (response) => JSON.parse(await readBounded(response.body)) });
    serviceVersion = (await getJson('/api/version')).version;
    const shown = await getJson('/api/show', { model });
    capabilities = shown.capabilities;
    if (!capabilities?.includes('tools') || !shown.thinking?.values?.includes(false)) throw new Error('capability-unavailable');
  }
  const context = { model, route, target: 'synthetic-pipeliner-repo', nonce: randomUUID(), epoch: 1, applied: false };
  const tool = { type: 'function', function: { name: 'lookup_fixture', description: 'Read one synthetic fixture.',
    parameters: { type: 'object', required: ['target', 'nonce', 'epoch'], properties: {
      target: { type: 'string' }, nonce: { type: 'string' }, epoch: { type: 'integer' },
    } } } };
  const prompt = `Call lookup_fixture once with target ${context.target}, nonce ${context.nonce}, epoch ${context.epoch}. Use the tool before answering.`;
  const started = performance.now();
  const first = await chat(key, model, [{ role: 'user', content: prompt }], [tool], route)
    .catch((error) => { throw new Error(`first-chat-${error.message}`); });
  const report = { route, model, serviceVersion, capabilities, manifestDigest: metadata.digest ?? null,
    responseModel: first.responseModel, doneReason: first.doneReason,
    catalogCount: models.length, streamedTerminal: true, firstRequestMs: Math.round(performance.now() - started),
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
        const resumedAt = performance.now();
        const next = await chat(key, model, restored.messages, undefined, route)
          .catch((error) => { throw new Error(`resume-chat-${error.message}`); });
        report.resumed = next.content.includes(fixture) && next.tool_calls.length === 0;
        report.resumeRequestMs = Math.round(performance.now() - resumedAt);
        report.resumeUsage = next.usage;
      } finally { await rm(dir, { recursive: true }); }
    }
  }
  const denied = await chat(key, model, [{ role: 'user', content: prompt.replace(context.target, 'different-fixture-repo') }], [tool], route);
  report.wrongTargetDenied = denied.tool_calls.length === 1 &&
    !broker(denied.tool_calls[0], { ...context, applied: false }).allowed;
  const cancellation = new AbortController();
  let responseBytesSeen = false;
  try {
    await chat(key, model, [{ role: 'user', content: 'Count to eight in one sentence.' }], undefined, route, {
      signal: cancellation.signal,
      consume(response) {
        return parseStream(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
          responseBytesSeen = true;
          cancellation.abort();
          controller.enqueue(chunk);
        } })));
      },
    });
    report.cancelledAfterBytes = false;
  } catch (error) { report.cancelledAfterBytes = responseBytesSeen && error.message === 'cancelled'; }
  report.invalidKeyRejected = null;
  if (route === 'cloud') {
    try { await api('/api/chat', 'deliberately-invalid-pipeliner-probe', { body: {
      model, messages: [{ role: 'user', content: 'Hi' }], stream: false,
    } }); report.invalidKeyRejected = false; }
    catch (error) { report.invalidKeyRejected = error.message === 'http-401'; }
  }
  console.log(JSON.stringify(report));
  if (!report.brokerAllowed || !report.resumed || !report.wrongTargetDenied || !report.cancelledAfterBytes ||
    (route === 'cloud' && !report.invalidKeyRejected)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  live().catch((error) => {
    console.error(JSON.stringify({ qualificationError: error.message }));
    process.exitCode = 1;
  });
}
