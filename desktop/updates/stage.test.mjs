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
import { stageUpdateInstaller, verifyStagedInstaller } from './stage.mjs';
import { openUpdateMaintenance } from './maintenance.mjs';
import { captureUpdateBackups } from './backup.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openDevelopmentStore } from '../development/state.mjs';
import { openArtifactStore } from '../delivery/artifacts.mjs';

test('installer staging requires protected signed history, exact bytes, current authority and awaited owned cleanup', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-update-stage-'))), directory = join(root, 'updates'); mkdirSync(directory, { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), trust = { id: 'synthetic-publisher', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const current = { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.1.0' }, bytes = Buffer.alloc(512 * 1024 + 79, 7);
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, ...current, version: '0.2.0', sequence: 1,
    issuedAt: 900, expiresAt: 2000, url: trust.origin + trust.path + 'Pipeliner.dmg', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  let now = 1000, vault, history, journal, workspaces, development, artifacts, requests = 0, closed = 0;
  try {
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async data => ({ result: data.toString(), shouldReEncrypt: false }) });
    history = openUpdateHistory(root, { vault, clock: () => now });
    const attempt = history.begin(trust, current), envelope = Buffer.from(canonicalJSON({ release, signature: sign(null, Buffer.from(canonicalJSON(release)), privateKey).toString('base64') }));
    history.complete(attempt.token, envelope);
    async function invoke(change = {}) {
      let authorized = true, reads = 0; const controller = new AbortController(); if (change.preAbort) controller.abort();
      const checkedHistory = change.tamperAtPublication ? { read(...args) {
        const value = history.read(...args);
        if (++reads === 2) writeFileSync(join(directory, readdirSync(directory)[0]), Buffer.alloc(bytes.length, 8));
        return value;
      } } : history;
      return stageUpdateInstaller({ directory, history: checkedHistory, trust, current, maxBytes: change.maxBytes ?? 2 * 1024 ** 2, reserveBytes: 1024 ** 2,
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
    assert.deepEqual(readFileSync(result.file), bytes); assert(Object.isFrozen(result)); assert.equal(closed, requests);
    const verify = (options = {}) => verifyStagedInstaller({ directory, file: result.file, history, trust, current, isCurrent: () => true, ...options }, { clock: () => now });
    assert.deepEqual(await verify(), result);
    const from = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'a'.repeat(40),
      version: current.version, platform: current.platform, architecture: current.architecture };
    journal = openUpdateMaintenance(root, { vault, clock: () => now });
    const binding = { history, trust, current, checkpoint() {} };
    const plan = { from, to: { ...from, version: release.version, sourceCommit: release.sourceCommit, gitTree: release.gitTree },
      bytes: release.bytes, sha256: release.sha256 };
    const wrongTarget = journal.begin({ ...plan, to: { ...plan.to, gitTree: 'd'.repeat(40) } }), beforeWrongTarget = journal.read();
    await assert.rejects(journal.bindInstaller(wrongTarget, result, binding));
    assert.deepEqual(journal.read(), beforeWrongTarget); assert.deepEqual(readFileSync(result.file), bytes); journal.cancel(wrongTarget);
    const intent = journal.begin(plan), preparing = journal.read();
    await assert.rejects(journal.bindInstaller({}, result, binding));
    await assert.rejects(journal.bindInstaller(intent, { ...result, sha256: 'f'.repeat(64) }, binding));
    await assert.rejects(journal.bindInstaller(intent, result, { ...binding, current: { ...current, version: '0.0.1' } }));
    const stopped = new AbortController(); let checkpoints = 0;
    await assert.rejects(journal.bindInstaller(intent, result, { ...binding, signal: stopped.signal, checkpoint() { if (++checkpoints > 5) stopped.abort(); } }));
    assert.deepEqual(journal.read(), preparing); assert.deepEqual(readFileSync(result.file), bytes);
    let changedDuringRead = false; checkpoints = 0;
    await assert.rejects(journal.bindInstaller(intent, result, { ...binding, checkpoint() {
      if (++checkpoints > 5 && !changedDuringRead) { journal.advance(intent, 'staged'); changedDuringRead = true; }
    } }));
    assert.equal(changedDuringRead, true); assert.equal(journal.read().phase, 'staged'); assert.equal(journal.read().installer, undefined);
    assert.deepEqual(readFileSync(result.file), bytes);
    await journal.bindInstaller(intent, result, binding);
    assert.deepEqual(journal.read().installer, { file: result.file, bytes: release.bytes, sha256: release.sha256 });
    assert.equal(journal.read().phase, 'staged'); assert.equal(readFileSync(join(root, 'maintenance.sqlite')).includes(Buffer.from(result.file)), false);
    await assert.rejects(journal.bindInstaller(intent, result, binding)); assert.throws(() => journal.advance(intent, 'verified'));
    workspaces = openWorkspaceStore(root, { vault }); development = openDevelopmentStore(root, { vault });
    artifacts = await openArtifactStore(root, { vault, limits: () => ({ keepLatest: 3, warningBytes: 1024 ** 3, capacityBytes: 2 * 1024 ** 3 }) });
    journal.bindBackups(intent, captureUpdateBackups({ directory: root, vault, build: from, checkpoint() {} }));
    assert.throws(() => journal.advance(intent, 'verified')); journal.advance(intent, 'repair-required'); const pending = journal.read(); assert.throws(() => journal.cancel(intent));
    journal.close(); journal = openUpdateMaintenance(root, { vault, clock: () => now });
    assert.deepEqual(journal.read(), pending); assert.equal(journal.owned(), false); assert.throws(() => journal.advance(intent, 'relaunching'));
    writeFileSync(result.file, Buffer.alloc(bytes.length, 8)); await assert.rejects(verify(), /update-installer-unverified/);
    assert.deepEqual(readFileSync(result.file), Buffer.alloc(bytes.length, 8)); writeFileSync(result.file, bytes);
    await assert.rejects(verify({ isCurrent: () => false }), /update-installer-unverified/);
    const cancelled = new AbortController(); let checked = 0;
    await assert.rejects(verify({ signal: cancelled.signal, isCurrent() { if (++checked > 3) cancelled.abort(); return true; } }), /update-installer-unverified/);
    assert.deepEqual(readFileSync(result.file), bytes);
    let replacement = false; checked = 0;
    await assert.rejects(verify({ isCurrent() {
      if (++checked > 3 && !replacement) { unlinkSync(result.file); writeFileSync(result.file, bytes, { mode: 0o600 }); replacement = true; }
      return true;
    } }), /update-installer-unverified/);
    assert.equal(replacement, true); assert.deepEqual(readFileSync(result.file), bytes);
    let historyReads = 0;
    await assert.rejects(verify({ history: { read(...args) {
      const value = history.read(...args);
      if (++historyReads === 2) writeFileSync(result.file, Buffer.alloc(bytes.length, 8)); return value;
    } } }), /update-installer-unverified/);
    assert.deepEqual(readFileSync(result.file), Buffer.alloc(bytes.length, 8)); writeFileSync(result.file, bytes);
    await assert.rejects(verify({ file: join(root, 'connections.sqlite') }), /update-installer-unverified/);
    now = 2000; await assert.rejects(verify(), /update-installer-unverified/); now = 1000;
    assert.equal(closed, requests); unlinkSync(result.file);
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
    await assert.rejects(invoke({ tamperAtPublication: true }), /^Error: update-installer-recovery-required$/);
    const changed = readdirSync(directory); assert.equal(changed.length, 1);
    assert.deepEqual(readFileSync(join(directory, changed[0])), Buffer.alloc(bytes.length, 8)); unlinkSync(join(directory, changed[0]));
    await assert.rejects(invoke({ replace: true }), /^Error: update-installer-recovery-required$/);
    const held = readdirSync(directory); assert.equal(held.length, 1); assert.equal(readFileSync(join(directory, held[0]), 'utf8'), 'preserve replaced file');
    assert.equal(history.read(trust, current).sequence, 1); assert.equal(closed, requests);
  } finally { journal?.close(); await artifacts?.close(); development?.close(); workspaces?.close(); history?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});
