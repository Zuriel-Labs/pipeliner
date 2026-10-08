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

// MCP 2026-07-28 ContentBlock fields. Valid data remains untrusted; no URI or media is opened.
export function checkContent(content) {
  try {
    checkedJSON(content, 'content', 1048576);
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const optional = (value, name, check) => !Object.hasOwn(value, name) || check(value[name]);
    const string = value => typeof value === 'string';
    const uri = value => {
      if (!string(value) || /[\s\x00-\x1f\x7f]/u.test(value) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
      try { new URL(value); return true; } catch { return false; }
    };
    const bytes = value => string(value) && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
    const annotations = value => object(value) && optional(value, 'audience', roles => Array.isArray(roles) && roles.every(role => ['user', 'assistant'].includes(role)))
      && optional(value, 'priority', priority => typeof priority === 'number' && priority >= 0 && priority <= 1) && optional(value, 'lastModified', string);
    const metadata = value => object(value) && optional(value, '_meta', object);
    const icon = value => object(value) && uri(value.src) && optional(value, 'mimeType', string)
      && optional(value, 'sizes', sizes => Array.isArray(sizes) && sizes.every(string)) && optional(value, 'theme', theme => ['dark', 'light'].includes(theme));
    if (!Array.isArray(content) || content.length > 100) throw Error();
    for (const item of content) {
      if (!metadata(item) || !optional(item, 'annotations', annotations)) throw Error();
      let valid = false;
      if (item.type === 'text') valid = string(item.text);
      else if (['image', 'audio'].includes(item.type)) valid = bytes(item.data) && string(item.mimeType);
      else if (item.type === 'resource_link') valid = uri(item.uri) && string(item.name) && optional(item, 'title', string) && optional(item, 'mimeType', string)
        && optional(item, 'size', Number.isSafeInteger) && optional(item, 'icons', icons => Array.isArray(icons) && icons.every(icon));
      else if (item.type === 'resource') {
        const value = item.resource;
        valid = metadata(value) && uri(value.uri) && optional(value, 'mimeType', string) && (string(value.text) || bytes(value.blob));
      }
      if (!valid) throw Error();
    }
  } catch { throw Error('MCP content invalid.'); }
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
