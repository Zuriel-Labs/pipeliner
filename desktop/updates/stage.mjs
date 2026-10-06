import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { constants } from 'node:fs';
import { open, lstat, realpath, statfs, unlink } from 'node:fs/promises';
import { join, resolve as absolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { checkUpdateContext } from './manifest.mjs';
import { destination, endpointURL, publicAddress } from '../tools/transport.mjs';

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateFile = value => value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && value.uid === process.getuid() && (value.mode & 0o777) === 0o600;

// Host-only explicit staging. Protected history supplies authenticated metadata; no native trust or install is implied.
export async function stageUpdateInstaller(options, { request = httpsRequest, resolve = destination, clock = Date.now } = {}) {
  let parent, file, path, owner, root, timer, req, response, reqClosed, socketClosed, abort, signal, keep = false, repair = false, written = 0;
  const hash = createHash('sha256'), started = performance.now();
  async function owned() {
    const directory = await lstat(options.directory), held = await parent.stat();
    if (!same(directory, root) || !same(held, root) || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()
      || (directory.mode & 0o777) !== 0o700 || await realpath(options.directory) !== options.directory) throw Error();
    if (!file) return;
    const actual = await file.stat(), named = await lstat(path);
    if (!privateFile(actual) || !privateFile(named) || !same(actual, owner) || !same(named, owner) || actual.size !== written
      || actual.size !== named.size || actual.mtimeMs !== named.mtimeMs || actual.ctimeMs !== named.ctimeMs) throw Error();
    return actual;
  }
  async function digest(abortable) {
    const before = await owned(), result = createHash('sha256'), bytes = Buffer.alloc(65536);
    for (let position = 0; position < written;) {
      if (abortable) signal.throwIfAborted();
      const count = (await file.read(bytes, 0, Math.min(bytes.length, written - position), position)).bytesRead;
      if (!count) throw Error(); result.update(bytes.subarray(0, count)); position += count;
    }
    const after = await owned(); if (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error();
    return result.digest('hex');
  }
  async function closeRequest() {
    if (abort) signal?.removeEventListener('abort', abort);
    const socket = req?.socket;
    if (socket && !socket.closed) socketClosed = new Promise(resolve => socket.once('close', resolve));
    const responseClosed = response && !response.closed ? new Promise(resolve => response.once('close', resolve)) : null;
    try { response?.destroy(); } catch { repair = true; }
    try { req?.destroy(); } catch { repair = true; }
    await Promise.all([reqClosed, socketClosed, responseClosed]); if (repair) throw Error();
  }
  try {
    record(options, ['directory', 'history', 'trust', 'current', 'maxBytes', 'reserveBytes', 'timeoutMs', 'isCurrent'], ['signal']);
    record(options.trust, ['id', 'key', 'origin', 'path']); record(options.current, ['channel', 'platform', 'architecture', 'version']);
    options = { ...options, trust: { ...options.trust }, current: { ...options.current } };
    if (![request, resolve, clock, options.isCurrent, options.history?.read].every(value => typeof value === 'function')
      || typeof options.directory !== 'string' || absolute(options.directory) !== options.directory
      || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 8 * 1024 ** 3
      || !Number.isSafeInteger(options.reserveBytes) || options.reserveBytes < 0
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 1800000
      || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw Error();
    const trust = { ...options.trust }, current = { ...options.current }, began = clock(), controller = new AbortController();
    checkUpdateContext(trust, { ...current, sequence: 0 }, began);
    signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const active = () => {
      const now = clock(); if (!Number.isSafeInteger(now) || now < began || performance.now() - started >= options.timeoutMs || options.isCurrent() !== true) throw Error();
      signal.throwIfAborted(); return now;
    };
    const snapshot = () => {
      active(); const saved = options.history.read(trust, current);
      if (!saved.availability?.available || saved.sequence !== saved.availability.release.sequence) throw Error();
      return immutable(saved.availability.release);
    };
    const release = snapshot(); if (release.bytes > options.maxBytes) throw Error();
    root = await lstat(options.directory); parent = await open(options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await owned();
    async function ready() {
      const now = active(); if (now < release.issuedAt || now >= release.expiresAt) throw Error(); await owned();
      const space = await statfs(options.directory, { bigint: true });
      if (space.bavail * space.bsize < BigInt(options.reserveBytes) + BigInt(release.bytes - written)) throw Error();
    }
    await ready();
    const endpoint = release.url, url = endpointURL(endpoint), hostname = url.hostname.replace(/^\[|\]$/g, '');
    const target = await resolve(url, undefined, signal); record(target, ['address', 'family']);
    if (url.href !== endpoint || !publicAddress(target.address) || isIP(target.address) !== target.family) throw Error();
    const pinned = { ...target }; await ready();
    path = join(options.directory, 'update-' + randomUUID() + '.dmg');
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); owner = await file.stat();
    await owned(); await parent.sync();
    try {
      response = await new Promise((done, reject) => {
        req = request(url, { method: 'GET', agent: false, rejectUnauthorized: true, family: pinned.family, maxHeaderSize: 8192,
          headers: { Accept: 'application/octet-stream, application/x-apple-diskimage', 'Accept-Encoding': 'identity' },
          lookup(host, lookupOptions, callback) {
            if (host.replace(/^\[|\]$/g, '') !== hostname) return callback(Error());
            callback(null, lookupOptions.all ? [pinned] : pinned.address, pinned.family);
          } }, value => { response = value; value.on('error', () => controller.abort()); done(value); });
        reqClosed = new Promise(resolve => req.once('close', () => { if (!response) reject(Error()); resolve(); }));
        req.on('error', () => { controller.abort(); if (!response) reject(Error()); });
        abort = () => { response?.destroy(Error('update-download-cancelled')); req.destroy(); if (!response) reject(Error()); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; } req.end();
      });
      const type = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), declared = response.headers['content-length'];
      if (response.statusCode !== 200 || !['application/octet-stream', 'application/x-apple-diskimage'].includes(type)
        || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity'
        || declared !== undefined && (typeof declared !== 'string' || !/^[1-9]\d{0,9}$/.test(declared) || Number(declared) !== release.bytes)) throw Error();
      for await (const chunk of response) {
        await ready(); if (!Buffer.isBuffer(chunk) || chunk.length > release.bytes - written) throw Error();
        for (let offset = 0; offset < chunk.length;) {
          active();
          const count = (await file.write(chunk, offset, Math.min(65536, chunk.length - offset), written)).bytesWritten;
          if (!count) throw Error(); hash.update(chunk.subarray(offset, offset + count)); written += count; offset += count;
        }
      }
    } finally { await closeRequest(); }
    if (written !== release.bytes || hash.copy().digest('hex') !== release.sha256) throw Error();
    await file.sync(); await ready(); if (await digest(true) !== release.sha256) throw Error(); await ready();
    if (canonicalJSON(snapshot()) !== canonicalJSON(release)) throw Error();
    await parent.sync(); keep = true; return immutable({ file: path, bytes: written, sha256: release.sha256, release });
  } catch { throw Error('update-installer-unverified'); }
  finally {
    clearTimeout(timer);
    if (file && !keep) try {
      if (await digest(false) !== hash.copy().digest('hex')) throw Error(); await unlink(path); await parent.sync();
    } catch { repair = true; }
    try { await file?.close(); } catch { repair = true; }
    try { await parent?.close(); } catch { repair = true; }
    if (repair) throw Error('update-installer-recovery-required');
  }
}
