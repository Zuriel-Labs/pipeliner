import { constants } from 'node:fs';
import { open, lstat, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, resolve, dirname, basename, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../core/settings.mjs';
import { configurationChanges, createDiagnosticExport } from './model.mjs';

const maximum = 2 * 1024 ** 2;
const same = (first, second) => first.dev === second.dev && first.ino === second.ino;
const regular = value => value.isFile() && value.uid === process.getuid() && value.nlink === 1 && !(value.mode & 0o022);
const cancelled = signal => { if (signal?.aborted) throw new Error('Privacy export cancelled'); };
async function chosenPath(path, protectedPaths = []) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)
    || basename(path).length > 180 || basename(path).startsWith('.') || !/\.json$/i.test(path)
    || !Array.isArray(protectedPaths) || protectedPaths.length > 64) throw new Error();
  for (const root of protectedPaths) {
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) throw new Error();
    const insensitive = ['darwin', 'win32'].includes(process.platform), item = relative(insensitive ? root.toLowerCase() : root, insensitive ? path.toLowerCase() : path);
    if (!item || !item.startsWith('..' + sep) && item !== '..' && !isAbsolute(item)) throw new Error();
  }
  const parent = dirname(path), info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o022 || await realpath(parent) !== parent) throw new Error();
  return { parent, info };
}
function envelope(document) {
  canonicalJSON(document);
  if (document.kind === 'pipeliner-configuration') configurationChanges(document, { scope: document.scope, target: document.target, currentSettings: {} });
  else if (document.kind === 'pipeliner-diagnostics') {
    const { kind: _kind, version: _version, createdAt, digest: _digest, ...input } = document;
    if (canonicalJSON(createDiagnosticExport(input, createdAt)) !== canonicalJSON(document)) throw new Error();
  } else throw new Error();
}
async function readBounded(file, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) throw new Error();
  const bytes = Buffer.alloc(size); let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
    if (!bytesRead) throw new Error(); offset += bytesRead;
  }
  if ((await file.read(Buffer.alloc(1), 0, 1, size)).bytesRead) throw new Error();
  return bytes;
}

// Only the host calls these functions. The path comes from a native panel, never from a renderer/worker request.
export async function writeExportFile(destination, document, { protectedPaths = [], signal } = {}) {
  let file, created, bytes;
  try {
    cancelled(signal); envelope(document); bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n');
    if (bytes.length > maximum) throw new Error();
    const parent = await chosenPath(destination, protectedPaths); cancelled(signal);
    file = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    created = await file.stat();
    if (!regular(created) || created.size !== 0 || (created.mode & 0o777) !== 0o600) throw new Error();
    cancelled(signal); await file.writeFile(bytes); await file.sync(); cancelled(signal);
    const written = await file.stat(), actual = await readBounded(file, written.size), current = await lstat(destination), after = await file.stat();
    if (!actual.equals(bytes) || !regular(current) || (current.mode & 0o777) !== 0o600 || !same(created, current) || !same(written, after) || written.size !== after.size
      || written.mtimeMs !== after.mtimeMs || written.ctimeMs !== after.ctimeMs || await realpath(parent.parent) !== parent.parent
      || !same(parent.info, await lstat(parent.parent))) throw new Error();
    const directory = await open(parent.parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!same(parent.info, await directory.stat())) throw new Error(); await directory.sync(); } finally { await directory.close(); }
    cancelled(signal);
    return { destination, bytes: bytes.length, sha256: createHash('sha256').update(actual).digest('hex') };
  } catch {
    let preserved = false;
    if (file && created) {
      try {
        const current = await lstat(destination), state = await file.stat();
        if (!regular(current) || (current.mode & 0o777) !== 0o600 || !same(created, current) || !same(current, state) || state.size > bytes.length
          || !(await readBounded(file, state.size)).equals(bytes.subarray(0, state.size))) throw new Error();
        await unlink(destination);
      } catch (error) { preserved = error.code !== 'ENOENT'; }
    }
    throw new Error(preserved ? 'Privacy export failed; an altered selected file was preserved' : signal?.aborted ? 'Privacy export cancelled' : 'Privacy export failed; choose a new local JSON filename');
  } finally { await file?.close(); }
}

export async function readConfigurationFile(source, context, { protectedPaths = [], signal } = {}) {
  let file, stage = 'location';
  try {
    cancelled(signal); const parent = await chosenPath(source, protectedPaths);
    stage = 'open';
    file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = await file.stat();
    stage = 'links'; if (before.nlink !== 1) throw new Error();
    stage = 'metadata';
    if (!regular(before) || before.size < 1 || before.size > maximum) throw new Error();
    stage = 'bytes';
    const bytes = await readBounded(file, before.size); cancelled(signal);
    stage = 'stability';
    const after = await file.stat(), current = await lstat(source);
    stage = 'links'; if (current.nlink !== 1) throw new Error(); stage = 'stability';
    if (!regular(current) || !same(before, current) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || await realpath(parent.parent) !== parent.parent || !same(parent.info, await lstat(parent.parent))) throw new Error();
    stage = 'configuration';
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    configurationChanges(document, { ...context, currentSettings: {} }); return document;
  } catch (cause) { const error = new Error(signal?.aborted ? 'Privacy import cancelled' : stage === 'location'
    ? 'Privacy import failed; choose a JSON export in an owned local folder outside protected application data'
    : stage === 'links' ? 'Privacy import failed; the selected file has another hard link. Export a new copy to an unsynced local folder'
    : stage !== 'configuration' ? 'Privacy import failed; choose an unchanged regular local JSON file under 2 MiB'
      : 'Privacy import failed; choose an intact Pipeliner configuration export for the current scope');
    error.code = 'PRIVACY_IMPORT_' + stage.toUpperCase();
    if (['EINVAL', 'EACCES', 'ENOENT', 'ELOOP', 'ESTALE'].includes(cause.code)) error.reason = cause.code;
    throw error; }
  finally { await file?.close(); }
}
