import { request as httpsRequest } from 'node:https';
import { request as httpRequest, Server } from 'node:http';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { sourceSecretPattern } from '../development/source.mjs';
import { checkSchema, checkedJSON, headerParameters } from './schema.mjs';

export const protocolVersion = '2026-07-28';
const localServices = new WeakMap(), toolName = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
let active = 0;
const failure = (message, dispatched = false) => Object.assign(new Error('MCP ' + message + '.'), { dispatched });

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const parts = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(value => parseInt(value, 16));
  return parts[0] >= 0x2000 && parts[0] < 0x4000 && parts[0] !== 0x2002 && parts[0] !== 0x3fff
    && !(parts[0] === 0x2001 && (parts[1] < 0x200 || parts[1] === 0xdb8));
}

// Only a live server owned by this host process creates this test/service capability. A renderer cannot forge it.
// External loopback processes require the installation broker's separate ownership qualification.
export function ownedLoopback(server) {
  const address = server instanceof Server && server.address();
  if (!server.listening || !address || address.address !== '127.0.0.1') throw failure('destination ownership unavailable');
  const handle = Object.freeze({ endpoint: `http://127.0.0.1:${address.port}/mcp` });
  localServices.set(handle, () => { const current = server.address(); return server.listening && current?.address === address.address && current.port === address.port; });
  return handle;
}

export function endpointURL(endpoint, local) {
  let url; try { url = new URL(endpoint); } catch { throw failure('destination invalid'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || url.href !== endpoint || url.username || url.password || url.search || url.hash
    || sourceSecretPattern.test(endpoint)) throw failure('destination invalid');
  if (local) {
    if (local.endpoint !== endpoint || !localServices.get(local)?.()) throw failure('destination ownership unavailable');
  } else if (url.protocol !== 'https:' || ['localhost', 'localhost.localdomain'].includes(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || isIP(hostname) && !publicAddress(hostname) || !isIP(hostname) && !hostname.includes('.')) throw failure('destination unavailable');
  return url;
}

async function destination(url, local, signal) {
  signal.throwIfAborted(); if (local) return { address: '127.0.0.1', family: 4 };
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  const resolver = new Resolver(), abort = () => resolver.cancel(); signal.addEventListener('abort', abort, { once: true });
  try {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]); signal.throwIfAborted();
    const addresses = results.flatMap((result, index) => result.status === 'fulfilled' ? result.value.map(address => ({ address, family: index === 0 ? 4 : 6 })) : []);
    if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw failure('destination resolution unavailable');
    return addresses[0];
  } finally { signal.removeEventListener('abort', abort); resolver.cancel(); }
}

function readMessage(value, id, allowNotification) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || value.jsonrpc !== '2.0') throw failure('response invalid');
  if (allowNotification && !Object.hasOwn(value, 'id') && ['notifications/progress', 'notifications/message'].includes(value.method)) {
    record(value, ['jsonrpc', 'method'], ['params']); return null;
  }
  record(value, ['jsonrpc', 'id'], ['result', 'error']);
  if (value.id !== id || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) throw failure('response identity invalid');
  if (Object.hasOwn(value, 'error')) throw failure('server rejected request');
  if (!value.result || Array.isArray(value.result) || typeof value.result !== 'object') throw failure('result invalid');
  if (value.result.resultType === 'input_required') throw failure('external input required; execution blocked');
  if (value.result.resultType !== 'complete') throw failure('result protocol unavailable');
  return value.result;
}

async function validateTool(tool, signal) {
  checkedJSON(tool, 'tool'); record(tool, ['name', 'inputSchema'], ['title', 'description', 'outputSchema', 'annotations', 'icons', '_meta']);
  if (!toolName(tool.name) || tool.title !== undefined && (typeof tool.title !== 'string' || tool.title.length > 240)
    || tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 8192)
    || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw failure('tool definition invalid');
  await checkSchema(tool.inputSchema, undefined, { signal });
  if (Object.hasOwn(tool, 'outputSchema')) await checkSchema(tool.outputSchema, undefined, { signal });
  return tool;
}

// Fixed destination and host-only credential. No proxy, redirect, legacy downgrade, session, server request or replay.
export function createMCPClient({ endpoint, local, credential = null, authorize }) {
  const url = endpointURL(endpoint, local), requests = new Set(), operations = new Set(), completions = new Set(); let closed = false;
  if (typeof authorize !== 'function' || credential !== null && (typeof credential !== 'string' || !/^[A-Za-z0-9._~+\/-]{8,4096}={0,2}$/.test(credential))) throw failure('connection unavailable');
  function fence(signal) {
    if (closed) throw failure('connection closed'); signal?.throwIfAborted(); endpointURL(endpoint, local);
    try {
      const result = authorize();
      if (result instanceof Promise) { result.catch(() => {}); throw new Error(); }
      if (result === false) throw new Error();
    } catch { throw failure('authority unavailable'); }
  }
  async function operation(work, options = {}) {
    const { signal: external, timeoutMs = 30000 } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || active >= 5) throw failure('capacity or deadline unavailable');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let finish; const done = new Promise(resolve => { finish = resolve; }); completions.add(done);
    operations.add(controller);
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    active++; let dispatched = false;
    try { fence(signal); return await work(signal, () => { dispatched = true; }); }
    catch (error) { throw failure(closed ? 'connection closed' : external?.aborted ? 'cancelled' : controller.signal.aborted ? 'deadline exceeded' : /^MCP /.test(error?.message) ? error.message.slice(4, -1) : 'response invalid or unavailable', dispatched); }
    finally { clearTimeout(timer); operations.delete(controller); active--; completions.delete(done); finish(); }
  }
  async function rpc(method, params, headers, signal, markDispatched) {
    fence(signal); const target = await destination(url, local, signal); fence(signal);
    const id = randomUUID(), body = canonicalJSON({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': protocolVersion, 'io.modelcontextprotocol/clientInfo': { name: 'Pipeliner', version: '0.1.0' }, 'io.modelcontextprotocol/clientCapabilities': {},
    } } });
    if (Buffer.byteLength(body) > 65536) throw failure('request too large');
    const result = await new Promise((resolve, reject) => {
      let response, request, settled = false, bytes = 0, text = '', data = [], event = '', events = 0, skipLF = false;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      function finish(error, value) {
        if (settled) return; settled = true; signal.removeEventListener('abort', abort);
        const socket = request?.socket, complete = () => { requests.delete(request); error ? reject(error) : resolve(value); };
        if (socket && !socket.closed) socket.once('close', complete); else complete();
        response?.destroy(); request?.destroy();
      }
      const abort = () => finish(failure('cancelled'));
      function parseJSON(input, notification = false) {
        const value = JSON.parse(input); checkedJSON(value, 'response', 1048576);
        if (sourceSecretPattern.test(input) || credential && input.includes(credential)) throw failure('sensitive response withheld');
        return readMessage(value, id, notification);
      }
      function line(value) {
        if (!value) {
          if (++events > 64) throw failure('stream event limit exceeded');
          if (data.length && (!event || event === 'message')) { const result = parseJSON(data.join('\n'), true); if (result) finish(null, result); }
          else if (data.length) throw failure('stream event unavailable');
          data = []; event = ''; return;
        }
        if (value.startsWith(':')) return;
        const separator = value.indexOf(':'), field = separator < 0 ? value : value.slice(0, separator), content = separator < 0 ? '' : value.slice(separator + 1).replace(/^ /, '');
        if (field === 'data') data.push(content); else if (field === 'event') event = content;
        // id/retry/unknown SSE fields carry no authority and never establish resume/replay.
      }
      function stream(value) {
        if (!value) return;
        if (skipLF) { skipLF = false; if (value.startsWith('\n')) value = value.slice(1); }
        text += value;
        let match;
        while (!settled && (match = /\r\n|\r|\n/.exec(text))) {
          const value = text.slice(0, match.index); if (value.length > 262144) throw failure('stream line limit exceeded');
          const loneCR = match[0] === '\r' && match.index === text.length - 1;
          text = text.slice(match.index + match[0].length); line(value); if (loneCR) skipLF = true;
        }
        if (text.length > 262144) throw failure('stream line limit exceeded');
      }
      try {
        request = (local ? httpRequest : httpsRequest)(url, { method: 'POST', agent: false, family: target.family, rejectUnauthorized: true,
          lookup(_hostname, options, callback) { callback(null, options.all ? [target] : target.address, target.family); },
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body),
            'MCP-Protocol-Version': protocolVersion, 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}), ...headers,
            ...(credential ? { Authorization: 'Bearer ' + credential } : {}) } }, value => {
          response = value;
          const contentType = String(value.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), encoding = value.headers['content-encoding'];
          if (value.statusCode !== 200 || encoding && encoding !== 'identity' || !['application/json', 'text/event-stream'].includes(contentType)) { finish(failure('HTTP response unavailable')); return; }
          value.on('data', chunk => {
            if (settled) return;
            try { bytes += chunk.length; if (bytes > 1048576) throw failure('response too large'); const decoded = decoder.decode(chunk, { stream: true }); if (contentType === 'text/event-stream') stream(decoded); else text += decoded; }
            catch (error) { finish(error); }
          });
          value.once('end', () => {
            if (settled) return;
            try { const tail = decoder.decode(); if (contentType === 'text/event-stream') { stream(tail); if (!settled) throw failure('stream closed before result'); } else finish(null, parseJSON(text + tail)); }
            catch (error) { finish(error); }
          });
          value.once('error', () => finish(failure('response interrupted')));
          value.once('aborted', () => finish(failure('response interrupted')));
        });
        requests.add(request); request.once('error', () => finish(failure('transport unavailable')));
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
        fence(signal); markDispatched(); request.end(body);
      } catch (error) { finish(error); }
    });
    fence(signal); return result;
  }
  return Object.freeze({
    endpoint, protocolVersion,
    list(options) { return operation(async (signal, dispatch) => {
      const tools = [], rejected = [], cursors = new Set(), names = new Set(); let cursor;
      for (let page = 0; page < 8; page++) {
        const result = await rpc('tools/list', cursor ? { cursor } : {}, {}, signal, dispatch);
        record(result, ['resultType', 'tools'], ['nextCursor', 'ttlMs', 'cacheScope', '_meta']);
        if (!Array.isArray(result.tools) || result.tools.length > 100 || tools.length + rejected.length + result.tools.length > 100) throw failure('catalog limit exceeded');
        for (const tool of result.tools) {
          if (!toolName(tool?.name) || names.has(tool.name)) throw failure('catalog identity invalid'); names.add(tool.name);
          try { await validateTool(tool, signal); fence(signal); tools.push(tool); }
          catch (error) { signal.throwIfAborted(); fence(signal); rejected.push({ name: tool.name, reason: 'Unsupported or unsafe tool definition.' }); }
        }
        if (result.nextCursor === undefined) return { tools, rejected };
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) throw failure('pagination invalid');
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      throw failure('pagination limit exceeded');
    }, options); },
    call(tool, input, options) { return operation(async (signal, dispatch) => {
      await validateTool(tool, signal); fence(signal);
      if (!input || typeof input !== 'object' || Array.isArray(input) || !await checkSchema(tool.inputSchema, input, { signal })) throw failure('input invalid');
      const result = await rpc('tools/call', { name: tool.name, arguments: input }, headerParameters(tool.inputSchema, input), signal, dispatch);
      record(result, ['resultType', 'content'], ['structuredContent', 'isError', '_meta']);
      if (!Array.isArray(result.content) || result.content.length > 100 || result.isError !== undefined && typeof result.isError !== 'boolean') throw failure('tool result invalid');
      if (tool.outputSchema !== undefined && (!Object.hasOwn(result, 'structuredContent') || !await checkSchema(tool.outputSchema, result.structuredContent, { signal }))) throw failure('output invalid');
      fence(signal); return result;
    }, options); },
    async close() { closed = true; for (const controller of operations) controller.abort(); for (const request of requests) request.destroy(); await Promise.all([...completions]); },
  });
}
