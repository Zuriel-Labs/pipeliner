import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJSON } from '../core/settings.mjs';
import { verifyUpdateManifest } from './manifest.mjs';

test('update metadata needs pinned signatures, fresh host-bound newer releases and strict asset identity', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const trust = { id: 'pipeliner-release', key: publicKey, origin: 'https://github.com', path: '/Zuriel-Labs/pipeliner/releases/download/' };
  const current = { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.1.0', sequence: 3 };
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, channel: 'stable', platform: 'darwin', architecture: 'arm64',
    version: '0.2.0', sequence: 4, issuedAt: 900, expiresAt: 2000, url: trust.origin + trust.path + 'v0.2.0/Pipeliner.dmg', bytes: 1000,
    sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  const signed = (value = release, key = privateKey) => Buffer.from(canonicalJSON({ release: value, signature: sign(null, Buffer.from(canonicalJSON(value)), key).toString('base64') }));
  const verify = (value = signed(), options = {}) => verifyUpdateManifest(value, { trust, current, now: 1000, ...options });
  const result = verify(); assert.deepEqual(result, release); assert(Object.isFrozen(result)); assert.throws(() => { result.url = 'https://foreign.invalid'; });
  assert.throws(() => verify(signed(release, other.privateKey)));
  const forged = JSON.parse(signed()); forged.release.bytes++; assert.throws(() => verify(Buffer.from(canonicalJSON(forged))));
  for (const signature of ['x'.repeat(88), 'A'.repeat(88), 'A'.repeat(86) + '==']) {
    assert.throws(() => verify(Buffer.from(canonicalJSON({ release, signature }))));
  }
  assert.throws(() => verify(Buffer.from(signed().toString() + '\n')));
  assert.throws(() => verify(signed(), { trust: { ...trust, key: privateKey } }));
  for (const changes of [{ channel: 'beta' }, { platform: 'win32' }, { architecture: 'x64' }, { source: 'foreign' }, { sequence: 3 }, { sequence: Infinity },
    { version: '0.1.0' }, { version: '0.0.99' }, { version: '0.1.0-alpha.1' }, { version: '00.2.0' }, { version: '0.2.0-alpha.01' },
    { issuedAt: 1001 }, { expiresAt: 1000 }, { expiresAt: 900 }, { expiresAt: 900 + 8 * 86400000 }, { bytes: 0 }, { bytes: 8 * 1024 ** 3 + 1 },
    { sha256: 'invalid' }, { sourceCommit: 'b'.repeat(39) }, { gitTree: 'c'.repeat(41) }, { extra: true },
    ...['http://github.com/x', 'https://foreign.invalid/x.dmg', trust.origin + trust.path + '../foreign.dmg', trust.origin + trust.path + 'x.dmg?token=synthetic',
      trust.origin + trust.path + 'x.dmg#fragment', 'https://user@github.com' + trust.path + 'x.dmg', trust.origin + trust.path + '%2e%2e/foreign.dmg',
      trust.origin + '/Zuriel-Labs/foreign/releases/download/x.dmg'].map(url => ({ url }))]) {
    assert.throws(() => verify(signed({ ...release, ...changes })), JSON.stringify(changes));
  }
  for (const data of [Buffer.alloc(16385), Buffer.from('{}'), Buffer.from('{'), Buffer.from([255])]) assert.throws(() => verify(data));
  assert.throws(() => verify(signed(), { trust: { ...trust, key: other.publicKey } }));
  for (const version of ['0.2.0-alpha.9', '0.2.0-alpha.beta', '0.2.0-rc.1', '0.2.0']) {
    const candidate = { ...release, version }, older = { ...current, channel: 'alpha', version: '0.2.0-alpha.8' };
    assert.equal(verify(signed({ ...candidate, channel: 'alpha' }), { current: older }).version, version);
  }
  assert.throws(() => verify(signed({ ...release, version: '0.1.0+new-build' })));
  assert.throws(() => verify(signed({ ...release, version: '0.2.0-alpha.9' }), { current: { ...current, version: '0.2.0-alpha.10' } }));
});
