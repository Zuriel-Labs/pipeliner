import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { canonicalJSON } from '../core/settings.mjs';
import { openVault } from '../connections/vault.mjs';
import { openUpdateHistory } from './history.mjs';
import { stageUpdateInstaller } from './stage.mjs';

test('installer staging requires protected signed history, exact bytes, current authority and awaited owned cleanup', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-update-stage-'))), directory = join(root, 'stage'); mkdirSync(directory, { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), trust = { id: 'synthetic-publisher', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const current = { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.1.0' }, bytes = Buffer.alloc(512 * 1024 + 79, 7);
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, ...current, version: '0.2.0', sequence: 1,
    issuedAt: 900, expiresAt: 2000, url: trust.origin + trust.path + 'Pipeliner.dmg', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  let now = 1000, vault, history, requests = 0, closed = 0;
  try {
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async data => ({ result: data.toString(), shouldReEncrypt: false }) });
    history = openUpdateHistory(root, { vault, clock: () => now });
    const attempt = history.begin(trust, current), envelope = Buffer.from(canonicalJSON({ release, signature: sign(null, Buffer.from(canonicalJSON(release)), privateKey).toString('base64') }));
    history.complete(attempt.token, envelope);
    async function invoke(change = {}) {
      let authorized = true; const controller = new AbortController(); if (change.preAbort) controller.abort();
      return stageUpdateInstaller({ directory, history, trust, current, maxBytes: change.maxBytes ?? 2 * 1024 ** 2, reserveBytes: 1024 ** 2,
        signal: controller.signal, timeoutMs: change.hang || change.bodyHang ? 100 : 30000, isCurrent: () => authorized }, {
        clock: () => now,
        resolve: async (url, local, signal) => { assert.equal(url.href, release.url); assert.equal(local, undefined); signal.throwIfAborted(); return change.privateDNS ? { address: '127.0.0.1', family: 4 } : { address: '8.8.8.8', family: 4 }; },
        request(url, options, callback) {
          requests++; assert.equal(url.href, release.url); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
          assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers['Accept-Encoding'], 'identity');
          options.lookup(url.hostname, {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
          const req = new EventEmitter(), socket = new EventEmitter(); socket.closed = false; req.socket = socket;
          req.destroy = () => { if (!socket.closed) setImmediate(() => {
            if (socket.closed) return; if (change.expire) now = 2000;
            if (change.replace) { const file = join(directory, readdirSync(directory).find(name => name.startsWith('update-'))); unlinkSync(file); writeFileSync(file, 'preserve replaced file', { mode: 0o600 }); }
            socket.closed = true; closed++; socket.emit('close'); req.emit('close');
          }); };
          req.end = () => {
            if (change.hang) return;
            const body = change.body ?? bytes;
            const response = change.bodyHang ? new PassThrough() : Readable.from((async function* () {
              for (let offset = 0; offset < body.length; offset += 8192) {
                yield body.subarray(offset, offset + 8192);
                if (change.abort && offset === 0) controller.abort();
                if (change.stale && offset === 0) authorized = false;
              }
            })(), { objectMode: false });
            response.statusCode = change.status ?? 200; response.headers = { 'content-type': 'application/octet-stream', 'content-length': String(body.length), ...change.headers }; callback(response);
            if (change.bodyHang) response.write(body.subarray(0, 8192));
          }; return req;
        },
      });
    }
    const result = await invoke(); assert.equal(result.bytes, bytes.length); assert.equal(result.sha256, release.sha256); assert.deepEqual(result.release, release);
    assert.deepEqual(readFileSync(result.file), bytes); assert(Object.isFrozen(result)); assert.equal(closed, requests); unlinkSync(result.file);
    for (const change of [{ status: 302 }, { headers: { 'content-type': 'text/html' } }, { headers: { 'content-encoding': 'gzip' } },
      { headers: { 'content-length': String(bytes.length - 1) } }, { body: Buffer.alloc(bytes.length + 1, 7) },
      { body: Buffer.alloc(bytes.length, 8) }, { body: bytes.subarray(0, bytes.length - 1), headers: { 'content-length': String(bytes.length) } },
      { abort: true }, { stale: true }, { hang: true }, { bodyHang: true }, { expire: true }]) {
      now = 1000; const before = closed; await assert.rejects(invoke(change), /^Error: update-installer-unverified$/);
      assert.equal(closed, before + 1); assert.deepEqual(readdirSync(directory), []);
    }
    now = 1000; const before = requests;
    for (const change of [{ preAbort: true }, { privateDNS: true }, { maxBytes: bytes.length - 1 }]) await assert.rejects(invoke(change), /^Error: update-installer-unverified$/);
    assert.equal(requests, before); assert.deepEqual(readdirSync(directory), []);
    await assert.rejects(invoke({ replace: true }), /^Error: update-installer-recovery-required$/);
    const held = readdirSync(directory); assert.equal(held.length, 1); assert.equal(readFileSync(join(directory, held[0]), 'utf8'), 'preserve replaced file');
    assert.equal(history.read(trust, current).sequence, 1); assert.equal(closed, requests);
  } finally { history?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});
