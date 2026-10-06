import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJSON } from '../core/settings.mjs';
import { readUpdateSource } from './source.mjs';

test('update availability reads only pinned metadata and awaits cleanup for success, refusal and cancellation', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trust = { id: 'pipeliner-release', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const current = { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.1.0', sequence: 3 };
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, channel: 'stable', platform: 'darwin', architecture: 'arm64',
    version: '0.2.0', sequence: 4, issuedAt: 900, expiresAt: 2000, url: trust.origin + trust.path + 'v0.2.0/Pipeliner.dmg', bytes: 1000,
    sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  const signed = value => Buffer.from(canonicalJSON({ release: value, signature: sign(null, Buffer.from(canonicalJSON(value)), privateKey).toString('base64') }));
  const bytes = signed(release);
  let dispatched = 0, closed = 0, responses = 0;
  async function invoke(change = {}) {
    let clock = 1000;
    const controller = new AbortController(); if (change.preAbort) controller.abort();
    const resolve = async (url, local, signal) => {
      assert.equal(url.href, trust.origin + trust.path + 'stable.json'); assert.equal(local, undefined); assert.equal(signal.aborted, false);
      if (change.dnsAbort) controller.abort();
      if (change.substitute) url.hostname = 'foreign.example.com';
      return change.target ?? { address: '8.8.8.8', family: 4 };
    };
    const request = (url, options, callback) => {
      dispatched++; assert.equal(url.href, trust.origin + trust.path + 'stable.json');
      assert.equal(options.method, 'GET'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.maxHeaderSize, 8192); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined);
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      options.lookup(url.hostname, {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
      options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
      const socket = new EventEmitter(); socket.closed = false;
      const req = new EventEmitter(); req.socket = socket;
      req.destroy = () => { if (!socket.closed) setImmediate(() => { if (change.closeExpire) clock = 2000; socket.closed = true; closed++; socket.emit('close'); }); };
      req.end = () => {
        if (change.hang) { if (change.abort) controller.abort(); return; }
        if (change.expire) clock = 2000;
        if (change.clockBack) clock = 999;
        const body = change.body ?? bytes, response = Readable.from(change.chunks ?? [body]); responses++;
        response.statusCode = change.status ?? 200;
        response.headers = { 'content-type': 'application/json', 'content-length': String(body.length), ...change.headers };
        callback(response);
        if (change.interrupt) queueMicrotask(() => response.destroy(Error('private transport detail')));
      };
      return req;
    };
    return readUpdateSource({ trust, current: change.current ?? current, retained: change.retained,
      signal: controller.signal, timeoutMs: change.hang ? 100 : 1000 }, { resolve, request, clock: () => clock });
  }
  const result = await invoke(); assert.deepEqual(result, { release, available: true, envelope: bytes.toString() }); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.release)); assert.equal(closed, 1);
  assert.deepEqual(await invoke({ current: { ...current, sequence: 4 }, retained: bytes.toString() }), result);
  const changedSequence = { current: { ...current, sequence: 4 }, retained: bytes.toString(), body: signed({ ...release, bytes: 1001 }) };
  await assert.rejects(invoke(changedSequence), /^Error: update-source-unverified$/); assert.equal(closed, dispatched);
  for (const version of ['0.1.0', '0.0.99']) {
    const unchanged = { ...release, version }, view = await invoke({ body: signed(unchanged) });
    assert.deepEqual(view, { release: unchanged, available: false, envelope: signed(unchanged).toString() });
  }
  for (const change of [{ status: 302 }, { status: 204 }, { headers: { 'content-type': 'text/html' } }, { headers: { 'content-encoding': 'gzip' } },
    { body: Buffer.alloc(16385) }, { headers: { 'content-length': '16385' } }, { headers: { 'content-length': '0' } },
    { headers: { 'content-length': String(bytes.length + 1) } }, { chunks: [bytes, Buffer.from('x')] }, { body: Buffer.from('{}') },
    { body: Buffer.from(bytes.toString().replace('0.2.0', '0.3.0')) }, { body: Buffer.from([255]) }, { interrupt: true },
    { hang: true }, { hang: true, abort: true }, { expire: true }, { closeExpire: true }, { clockBack: true }]) {
    const before = closed; await assert.rejects(invoke(change), /^Error: update-source-unverified$/); assert.equal(closed, before + 1);
  }
  const before = dispatched;
  for (const change of [{ preAbort: true }, { dnsAbort: true }, { substitute: true }, { target: { address: '127.0.0.1', family: 4 } },
    { target: { address: '8.8.8.8', family: 6 } }]) await assert.rejects(invoke(change), /^Error: update-source-unverified$/);
  assert.equal(dispatched, before); assert.equal(closed, dispatched); assert(responses > 0);
  for (const changes of [{ trust: { ...trust, origin: 'http://updates.example.com' } }, { trust: { ...trust, key: privateKey } },
    { trust: { ...trust, path: '/../' } }, { current: { ...current, channel: 'canary' } },
    { current: { ...current, version: 'invalid' } }, { current: { ...current, sequence: -1 } }, { timeoutMs: 0 }, { retained: 'x'.repeat(16385) },
    { retained: bytes.toString(), current: { ...current, sequence: 0 } }]) {
    let invalidDispatches = 0, invalidResolutions = 0;
    await assert.rejects(readUpdateSource({ trust, current, signal: new AbortController().signal, ...changes }, {
      clock: () => 1000,
      resolve() { invalidResolutions++; throw Error('must not resolve'); },
      request() { invalidDispatches++; throw Error('must not dispatch'); },
    }), /^Error: update-source-unverified$/);
    assert.equal(invalidResolutions, 0); assert.equal(invalidDispatches, 0);
  }
});
