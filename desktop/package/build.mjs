import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { parseUpdateVersion } from '../updates/manifest.mjs';

export const buildIdentityName = 'pipeliner-build.json';
export function buildIdentity(value) {
  record(value, ['kind', 'schemaVersion', 'sourceCommit', 'gitTree', 'version', 'platform', 'architecture']); canonicalJSON(value);
  if (value.kind !== 'pipeliner-desktop-build' || value.schemaVersion !== 1 || value.platform !== 'darwin' || value.architecture !== 'arm64'
    || ![value.sourceCommit, value.gitTree].every(item => typeof item === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item))) throw Error('package-build-identity-invalid');
  parseUpdateVersion(value.version); return immutable(value);
}
const stable = (a, b) => ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const owner = value => value.uid === process.getuid() || value.uid === 0;

// A bounded resource read is not signature validation. The native verifier authenticates its containing bundle.
export async function readBuildIdentity(bundle, { signal } = {}) {
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
    const path = join(directories[2], buildIdentityName);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const original = await file.stat();
    if (!original.isFile() || original.nlink !== 1 || !owner(original) || original.mode & 0o022 || original.size < 1 || original.size > 4096) throw Error();
    const bytes = Buffer.alloc(original.size); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted(); const count = (await file.read(bytes, offset, bytes.length - offset, offset)).bytesRead;
      if (!count) throw Error(); offset += count;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead || !stable(original, await file.stat()) || !stable(original, await lstat(path))) throw Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), result = buildIdentity(JSON.parse(text));
    if (text !== canonicalJSON(result) + '\n') throw Error();
    for (let index = 0; index < directories.length; index++) {
      if (!stable(before[index], await lstat(directories[index])) || await realpath(directories[index]) !== directories[index]) throw Error();
    }
    signal?.throwIfAborted(); return result;
  } catch { throw Error('package-build-identity-unverified'); }
  finally { await file?.close(); }
}
