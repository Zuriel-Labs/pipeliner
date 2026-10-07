import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, chmod, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJSON } from '../core/settings.mjs';
import * as metadata from './build.mjs';

test('bundle data support metadata binds the exact build and preserves existing identity checks without granting recovery', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-54-data-support-'))), bundle = join(root, 'Pipeliner.app');
  const resources = join(bundle, 'Contents/Resources'), identity = { kind: 'pipeliner-desktop-build', schemaVersion: 1,
    sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
  await mkdir(resources, { recursive: true, mode: 0o700 });
  const neighbor = join(resources, 'pipeliner-build.json'), file = join(resources, 'pipeliner-data.json');
  await writeFile(neighbor, canonicalJSON(identity) + '\n', { mode: 0o600 });
  try {
    assert.equal(typeof metadata.dataCompatibilityForBuild, 'function');
    const support = metadata.dataCompatibilityForBuild(identity, '0.160.0');
    assert(Object.isFrozen(support)); assert(Object.isFrozen(support.formats.databases));
    assert.deepEqual(support.build, identity); assert.equal(support.formats.databases.maintenance, 2);
    assert.equal(support.formats.databases.policy, 3); assert.equal(support.formats.policyDocument, 4);
    assert.equal(support.codexCLI, '0.160.0'); assert.equal(metadata.dataCompatibilityName, 'pipeliner-data.json');
    assert.equal('rollbackAuthorized' in support, false); assert.equal('paths' in support, false);
    await assert.rejects(metadata.readDataCompatibility(bundle, identity));
    const original = canonicalJSON(support) + '\n', save = text => writeFile(file, text, { mode: 0o600 });
    await save(original); assert.deepEqual(await metadata.readDataCompatibility(bundle, identity), support);
    const expected = { ...identity }, reading = metadata.readDataCompatibility(bundle, expected);
    expected.gitTree = 'c'.repeat(40); assert.deepEqual(await reading, support);
    assert.deepEqual(await metadata.readBuildIdentity(bundle), identity);
    await assert.rejects(metadata.readDataCompatibility(bundle, { ...identity, gitTree: 'c'.repeat(40) }));
    for (const text of ['\ufeff' + original, JSON.stringify(support) + '\n', original.slice(0, -1), original + ' ', 'x'.repeat(4097),
      canonicalJSON({ ...support, schemaVersion: 2 }) + '\n', canonicalJSON({ ...support, extra: true }) + '\n',
      canonicalJSON({ ...support, formats: { ...support.formats, databases: { ...support.formats.databases, maintenance: -1 } } }) + '\n',
      canonicalJSON({ ...support, formats: { ...support.formats, policyDocument: 0 } }) + '\n',
      canonicalJSON({ ...support, formats: { ...support.formats, databases: { ...support.formats.databases, foreign: 1 } } }) + '\n',
      canonicalJSON({ ...support, codexCLI: 'version-1' }) + '\n']) {
      await save(text); await assert.rejects(metadata.readDataCompatibility(bundle, identity)); assert.equal(await readFile(file, 'utf8'), text);
    }
    await save(original); await chmod(file, 0o666); await assert.rejects(metadata.readDataCompatibility(bundle, identity)); await chmod(file, 0o600);
    const stopped = new AbortController(); stopped.abort(); await assert.rejects(metadata.readDataCompatibility(bundle, identity, { signal: stopped.signal }));
    let getters = 0; assert.throws(() => metadata.dataCompatibilityForBuild({ ...identity, get sourceCommit() { getters++; return identity.sourceCommit; } }, '0.160.0'));
    assert.equal(getters, 0); assert.equal(await readFile(neighbor, 'utf8'), canonicalJSON(identity) + '\n');
  } finally { await rm(root, { recursive: true }); await assert.rejects(lstat(root), error => error.code === 'ENOENT'); }
});
