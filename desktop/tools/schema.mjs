import { Worker } from 'node:worker_threads';
import { canonicalJSON } from '../core/settings.mjs';

let active = 0;
export function checkedJSON(value, kind, maximum = 65536) {
  try {
    if (Buffer.byteLength(canonicalJSON(value)) > maximum) throw new Error();
    let nodes = 0;
    function visit(item, depth = 0) {
      if (++nodes > 2000 || depth > 16) throw new Error();
      if (!item || typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error();
        visit(child, depth + 1);
      }
    }
    visit(value); return value;
  } catch { throw new Error('MCP ' + kind + ' exceeds the safe JSON contract.'); }
}

function annotations(schema) {
  checkedJSON(schema, 'schema'); const headers = [], names = new Set();
  function visit(item, path = [], reachable = true) {
    if (!item || typeof item !== 'object') return;
    if (Object.hasOwn(item, '$ref') && (typeof item.$ref !== 'string' || !item.$ref.startsWith('#')) || Object.hasOwn(item, '$async')) throw new Error('MCP schema cannot load external or executable definitions.');
    if (Object.hasOwn(item, 'x-mcp-header')) {
      const name = item['x-mcp-header'];
      if (!reachable || !path.length || typeof name !== 'string' || name.length > 64 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
        || !['integer', 'string', 'boolean'].includes(item.type) || names.has(name.toLowerCase())) throw new Error('MCP schema header annotation is invalid.');
      names.add(name.toLowerCase()); headers.push({ name, path, type: item.type });
      if (headers.length > 32) throw new Error('MCP schema header limit exceeded.');
    }
    for (const [key, value] of Object.entries(item)) {
      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, child] of Object.entries(value)) visit(child, [...path, name], reachable);
      } else if (value && typeof value === 'object') {
        if (Array.isArray(value)) value.forEach(child => visit(child, path, false)); else visit(value, path, false);
      }
    }
  }
  visit(schema); return headers;
}

export function headerValue(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192) throw new Error('MCP data header value unavailable.');
  return /^[\x20-\x7e\t]*$/.test(value) && value.trim() === value && !(value.startsWith('=?base64?') && value.endsWith('?='))
    ? value : '=?base64?' + Buffer.from(value).toString('base64') + '?=';
}

export function headerParameters(schema, input) {
  checkedJSON(input, 'data'); const output = {};
  for (const { name, path, type } of annotations(schema)) {
    let value = input;
    for (const key of path) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) { value = undefined; break; } value = value[key]; }
    if (value === undefined || value === null) continue;
    if (type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== type) throw new Error('MCP data header type mismatch.');
    output['Mcp-Param-' + name] = headerValue(String(value));
  }
  if (Buffer.byteLength(canonicalJSON(output)) > 16384) throw new Error('MCP data headers exceed the request limit.');
  return output;
}

// Compilation uses trusted code in a disposable worker; this is a responsiveness bound, not an OS security boundary.
export async function checkSchema(schema, input, { signal, timeoutMs = 2000 } = {}) {
  annotations(schema); if (input !== undefined) checkedJSON(input, 'data'); signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) throw new Error('MCP schema deadline invalid.');
  if (active >= 5) throw new Error('MCP schema capacity unavailable.');
  active++; let worker, timer, abort;
  try {
    return await new Promise((resolve, reject) => {
      worker = new Worker(new URL('./schema-worker.mjs', import.meta.url), { workerData: { schema, ...(input !== undefined ? { input } : {}) },
        env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
      abort = () => reject(new Error('MCP schema cancelled.')); signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', result => result?.ok === true && typeof result.valid === 'boolean' ? resolve(result.valid) : reject(new Error('MCP schema could not be qualified.')));
      worker.once('error', () => reject(new Error('MCP schema worker failed.')));
      worker.once('exit', () => reject(new Error('MCP schema worker closed before a result.')));
      timer = setTimeout(() => reject(new Error('MCP schema deadline exceeded.')), timeoutMs);
      if (signal?.aborted) abort();
    });
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); if (worker) await worker.terminate(); active--; }
}
