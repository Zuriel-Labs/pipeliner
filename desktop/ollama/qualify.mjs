import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseStream, broker, api, readBounded, catalog, selectedModel, chat } from './client.mjs';
export { parseStream, broker, api, readBounded, catalog, selectedModel, chat };

const ORIGINS = { cloud: 'https://ollama.com', 'local-cloud': 'http://127.0.0.1:11434' };
const MODELS = { cloud: 'deepseek-v4.1-flash', 'local-cloud': 'deepseek-v4.1-flash:cloud' };
const fixture = 'fixture-ok';

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
