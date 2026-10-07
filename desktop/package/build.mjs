import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { parseUpdateVersion } from '../updates/manifest.mjs';

export const buildIdentityName = 'pipeliner-build.json';
export const dataCompatibilityName = 'pipeliner-data.json';
const currentFormats = immutable({
  databases: { connections: 0, policy: 3, owner: 0, execution: 1, skills: 1, tools: 1, privacy: 1, updates: 1,
    workspaces: 5, development: 2, artifacts: 2, maintenance: 2 },
  policyDocument: 4, connectionRecord: 1, protectedPayload: 1, protectedRecord: 1, migrationBackup: 1,
});
export function buildIdentity(value) {
  record(value, ['kind', 'schemaVersion', 'sourceCommit', 'gitTree', 'version', 'platform', 'architecture']); canonicalJSON(value);
  if (value.kind !== 'pipeliner-desktop-build' || value.schemaVersion !== 1 || value.platform !== 'darwin' || value.architecture !== 'arm64'
    || ![value.sourceCommit, value.gitTree].every(item => typeof item === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item))) throw Error('package-build-identity-invalid');
  parseUpdateVersion(value.version); return immutable(value);
}
export function dataCompatibility(value, identity) {
  try {
    canonicalJSON(value); record(value, ['kind', 'schemaVersion', 'build', 'formats', 'codexCLI']);
    if (value.kind !== 'pipeliner-desktop-data-support' || value.schemaVersion !== 1
      || canonicalJSON(buildIdentity(value.build)) !== canonicalJSON(buildIdentity(identity))) throw Error();
    record(value.formats, Object.keys(currentFormats)); record(value.formats.databases, Object.keys(currentFormats.databases));
    if (Object.values(value.formats.databases).some(version => !Number.isSafeInteger(version) || version < 0 || version > 100)
      || Object.entries(value.formats).filter(([key]) => key !== 'databases').some(([, version]) => !Number.isSafeInteger(version) || version < 1 || version > 100)) throw Error();
    parseUpdateVersion(value.codexCLI); return immutable(value);
  } catch { throw Error('package-data-support-invalid'); }
}
// Publisher declaration only. Native trust and actual compatible data remain separate checks.
export function dataCompatibilityForBuild(identity, codexCLI) {
  return dataCompatibility({ kind: 'pipeliner-desktop-data-support', schemaVersion: 1, build: identity, formats: currentFormats, codexCLI }, identity);
}
const stable = (a, b) => ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const owner = value => value.uid === process.getuid() || value.uid === 0;

// A bounded resource read is not signature validation. The native verifier authenticates its containing bundle.
async function readBundleRecord(bundle, name, validate, signal, failure) {
  let file;
  try {
    if (typeof bundle !== 'string' || resolve(bundle) !== bundle || !bundle.endsWith('.app') || /[\x00-\x1f\x7f]/.test(bundle)
      || signal !== undefined && !(signal instanceof AbortSignal)) throw Error();
    signal?.throwIfAborted();
    const directories = [bundle, join(bundle, 'Contents'), join(bundle, 'Contents/Resources')], before = [];
    for (const path of directories) {
      const value = await lstat(path);
      if (!value.isDirectory() || value.isSymbolicLink() || !owner(value) || value.mode & 0o022 || await realpath(path) !== path) throw Error();
      before.push(value);
    }
    const path = join(directories[2], name);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const original = await file.stat();
    if (!original.isFile() || original.nlink !== 1 || !owner(original) || original.mode & 0o022 || original.size < 1 || original.size > 4096) throw Error();
    const bytes = Buffer.alloc(original.size); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted(); const count = (await file.read(bytes, offset, bytes.length - offset, offset)).bytesRead;
      if (!count) throw Error(); offset += count;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead || !stable(original, await file.stat()) || !stable(original, await lstat(path))) throw Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), result = validate(JSON.parse(text));
    if (text !== canonicalJSON(result) + '\n') throw Error();
    for (let index = 0; index < directories.length; index++) {
      if (!stable(before[index], await lstat(directories[index])) || await realpath(directories[index]) !== directories[index]) throw Error();
    }
    signal?.throwIfAborted(); return result;
  } catch { throw Error(failure); }
  finally { await file?.close(); }
}
export async function readBuildIdentity(bundle, { signal } = {}) {
  return readBundleRecord(bundle, buildIdentityName, buildIdentity, signal, 'package-build-identity-unverified');
}
export async function readDataCompatibility(bundle, identity, { signal } = {}) {
  try {
    const expected = buildIdentity(JSON.parse(canonicalJSON(identity)));
    return await readBundleRecord(bundle, dataCompatibilityName, value => dataCompatibility(value, expected), signal, 'package-data-support-unverified');
  } catch { throw Error('package-data-support-unverified'); }
}
