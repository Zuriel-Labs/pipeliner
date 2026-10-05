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
