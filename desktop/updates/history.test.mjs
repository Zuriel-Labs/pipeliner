import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJSON } from '../core/settings.mjs';
import { openVault } from '../connections/vault.mjs';
import { createRecordCodec } from '../privacy/records.mjs';
import { openUpdateHistory } from './history.mjs';

test('protected update history persists exact signed releases, fences completion and bounds automatic checks', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-update-history-')));
  const protection = { available: async () => true, encrypt: async text => Buffer.from(text),
    decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trust = { id: 'synthetic-publisher', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const current = { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.1.0' };
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, ...current,
    version: '0.2.0', sequence: 1, issuedAt: 900, expiresAt: 7 * 86400000, url: trust.origin + trust.path + 'private-synthetic-name.dmg', bytes: 1000,
    sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  const signed = value => Buffer.from(canonicalJSON({ release: value, signature: sign(null, Buffer.from(canonicalJSON(value)), privateKey).toString('base64') }));
  const bytes = signed(release); let now = 1000, vault, history, other;
  try {
    vault = await openVault(root, protection); const open = () => openUpdateHistory(root, { vault, clock: () => now }); history = open();
    assert.deepEqual(history.read(trust, current), { sequence: 0, lastAttempt: null, lastCheck: null, availability: null });
    const first = history.begin(trust, current); assert.equal(first.current.sequence, 0); assert.equal(first.retained, null); assert(Object.isFrozen(first.current));
    assert.throws(() => history.begin(trust, current), /update-history/);
    assert.throws(() => history.complete({}, bytes), /update-history/);
    const result = history.complete(first.token, bytes); assert.deepEqual(result, { release, available: true });
    assert.throws(() => history.complete(first.token, bytes), /update-history/);
    assert.equal(history.read(trust, current).sequence, 1);
    assert.equal(history.begin(trust, current), null);
    assert.equal(readFileSync(join(root, 'updates.sqlite')).includes('private-synthetic-name'), false);
    history.close(); vault.close(); vault = await openVault(root, protection); history = open();
    assert.deepEqual(history.read(trust, current).availability, result); assert.equal(history.begin(trust, current), null);
    assert.equal(history.read(trust, { ...current, channel: 'beta' }).sequence, 0);
    const refreshed = history.begin(trust, current, { manual: true }); assert.equal(refreshed.retained, bytes.toString()); now++;
    assert.deepEqual(history.complete(refreshed.token, bytes), result); assert.equal(history.read(trust, current).lastCheck, now);
    const duplicate = history.begin(trust, current, { manual: true });
    assert.throws(() => history.complete(duplicate.token, signed({ ...release, bytes: 1001 })), /update-history/);
    assert.equal(history.read(trust, current).sequence, 1); history.fail(duplicate.token);
    const advance = history.begin(trust, current, { manual: true }), newer = { ...release, sequence: 2, version: '0.3.0' };
    history.complete(advance.token, signed(newer)); assert.equal(history.read(trust, current).sequence, 2);
    const replay = history.begin(trust, current, { manual: true });
    assert.throws(() => history.complete(replay.token, bytes), /update-history/); history.fail(replay.token);
    const stale = history.begin(trust, current, { manual: true }); other = open();
    const replacing = other.begin(trust, current, { manual: true }); other.fail(replacing.token);
    assert.throws(() => history.complete(stale.token, signed({ ...newer, sequence: 3 })), /update-history/); history.fail(stale.token);
    now += 86400000; const daily = history.begin(trust, current); history.fail(daily.token);
    history.close(); history = open(); assert.equal(history.begin(trust, current), null);
    assert.equal(history.read(trust, { ...current, version: '0.3.0' }).availability.available, false);
    now = release.expiresAt; assert.equal(history.read(trust, current).availability, null); assert.equal(history.read(trust, current).sequence, 2);
    now = 1; assert.throws(() => history.read(trust, current), /update-history/); now = release.expiresAt;
    for (let i = 1; i < 64; i++) {
      const bounded = history.begin({ ...trust, id: trust.id + '-' + i }, current); history.fail(bounded.token);
    }
    assert.throws(() => history.begin({ ...trust, id: trust.id + '-overflow' }, current), /update-history/);
    assert.equal(history.read(trust, current).sequence, 2);
    const db = new DatabaseSync(join(root, 'updates.sqlite')), row = db.prepare('SELECT id,payload FROM update_history LIMIT 1').get();
    const codec = createRecordCodec(vault, 'update'), identity = { repository: null, table: 'update_history', key: row.id };
    assert.throws(() => createRecordCodec(vault, 'workspace').decode(identity, row.payload), /protected-record/);
    const changed = Buffer.from(row.payload); changed[changed.length - 1] ^= 1;
    db.prepare('UPDATE update_history SET payload=? WHERE id=?').run(changed, row.id); db.close();
    assert.throws(() => history.read(trust, current), /update-history/);
    history.close(); assert.throws(() => history.read(trust, current), /update-history/);
  } finally {
    other?.close(); history?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false);
  }
});
