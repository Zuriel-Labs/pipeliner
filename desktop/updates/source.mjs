import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { immutable, record } from '../core/settings.mjs';
import { destination, endpointURL, publicAddress } from '../tools/transport.mjs';
import { checkUpdateContext, verifyUpdateAvailability } from './manifest.mjs';

// Trusted host only. This reads signed metadata, never installer bytes or credentials.
export async function readUpdateSource(options, { request = httpsRequest, resolve = destination, clock = Date.now } = {}) {
  let timer;
  try {
    record(options, ['trust', 'current'], ['signal', 'timeoutMs', 'retained']);
    record(options.trust, ['id', 'key', 'origin', 'path']); record(options.current, ['channel', 'platform', 'architecture', 'version', 'sequence']);
    const trust = { ...options.trust }, current = { ...options.current }, timeoutMs = options.timeoutMs ?? 30000, retained = options.retained ?? null;
    if (![request, resolve, clock].every(value => typeof value === 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
      || options.signal !== undefined && !(options.signal instanceof AbortSignal)
      || retained !== null && (typeof retained !== 'string' || !retained.length || Buffer.byteLength(retained) > 16384 || current.sequence < 1)) throw Error();
    const began = clock(); checkUpdateContext(trust, current, began);
    const endpoint = trust.origin + trust.path + current.channel + '.json', url = endpointURL(endpoint), hostname = url.hostname.replace(/^\[|\]$/g, '');
    const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const started = performance.now();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    signal.throwIfAborted();
    const target = await resolve(url, undefined, signal);
    signal.throwIfAborted(); record(target, ['address', 'family']);
    if (url.href !== endpoint || performance.now() - started >= timeoutMs || !publicAddress(target.address) || isIP(target.address) !== target.family) throw Error();
    const pinned = { address: target.address, family: target.family };
    const bytes = await new Promise((done, reject) => {
      let req, response, settled = false, ended = false, length = 0, expected; const chunks = [];
      function finish(error, value) {
        if (settled) return; settled = true; signal.removeEventListener('abort', abort);
        const socket = req?.socket, complete = () => error ? reject(error) : done(value);
        if (socket && !socket.closed) socket.once('close', complete); else complete();
        response?.destroy(); req?.destroy();
      }
      const abort = () => finish(Error());
      try {
        req = request(url, { method: 'GET', agent: false, rejectUnauthorized: true, family: pinned.family, maxHeaderSize: 8192,
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
          lookup(host, lookupOptions, callback) {
            if (host.replace(/^\[|\]$/g, '') !== hostname) return callback(Error());
            callback(null, lookupOptions.all ? [pinned] : pinned.address, pinned.family);
          } }, value => {
          response = value;
          value.once('error', () => finish(Error())); value.once('aborted', () => finish(Error()));
          value.once('close', () => { if (!ended) finish(Error()); });
          const type = String(value.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), declared = value.headers['content-length'];
          if (value.statusCode !== 200 || type !== 'application/json' || value.headers['content-encoding'] && value.headers['content-encoding'] !== 'identity'
            || declared !== undefined && (typeof declared !== 'string' || !/^[1-9]\d{0,4}$/.test(declared) || Number(declared) > 16384)) { finish(Error()); return; }
          expected = declared === undefined ? null : Number(declared);
          value.on('data', part => {
            if (settled) return;
            if (!Buffer.isBuffer(part) || (length += part.length) > 16384) { finish(Error()); return; }
            chunks.push(part);
          });
          value.once('end', () => {
            ended = true;
            if (!length || expected !== null && length !== expected) finish(Error()); else finish(null, Buffer.concat(chunks, length));
          });
        });
        req.once('error', () => finish(Error()));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        req.end();
      } catch { finish(Error()); }
    });
    signal.throwIfAborted();
    const now = clock(); if (!Number.isSafeInteger(now) || now < began || performance.now() - started >= timeoutMs) throw Error();
    const identical = retained !== null && bytes.equals(Buffer.from(retained));
    const result = verifyUpdateAvailability(bytes, { trust, current: { ...current, sequence: identical ? current.sequence - 1 : current.sequence }, now });
    if (identical && result.release.sequence !== current.sequence) throw Error();
    return immutable({ ...result, envelope: bytes.toString('utf8') });
  } catch { throw Error('update-source-unverified'); }
  finally { clearTimeout(timer); }
}
