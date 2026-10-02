import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceData, workspaceCandidate } from '../core/identity.mjs';
import { record } from '../core/settings.mjs';

export const sourceLimits = Object.freeze({ files: 1200, fileBytes: 262144, totalBytes: 16 * 1024 * 1024 });
const objectHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
export const sourceSecretPattern = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:gh[pousr]_|sk-proj-|sk-ant-)[A-Za-z0-9_-]{36,}/;
export function sourcePath(value, writing = false) {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)) return false;
  const parts = value.toLowerCase().split('/');
  if (parts.some(part => ['.', '..', '.git', '.ssh', '.codex', '.pipeliner', 'node_modules'].includes(part) || part === '.env' || part.endsWith('.pem') || part.endsWith('.key') || part === 'id_rsa' || part === 'id_ed25519')) return false;
  return !writing || !(parts[0] === 'pipeliner.config.json' || parts[0] === 'agents.md' || parts[0] === '.agents' || parts[0] === '.claude' || parts[0] === '.github');
}
export function checkedFiles(files) {
  if (!Array.isArray(files) || files.length > sourceLimits.files) throw new Error('Development source file limit exceeded');
  const paths = new Set(); let bytes = 0;
  for (const file of files) {
    record(file, ['path', 'mode', 'content']);
    if (!sourcePath(file.path)) throw new Error('Protected or invalid Development source path');
    if (paths.has(file.path)) throw new Error('Duplicate Development source path'); paths.add(file.path);
    if (!['100644', '100755'].includes(file.mode)) throw new Error('Development source must contain regular files');
    if (typeof file.content !== 'string' || file.content.length > Math.ceil(sourceLimits.fileBytes / 3) * 4) throw new Error('Development source file limit exceeded');
    const data = Buffer.from(file.content, 'base64');
    if (data.toString('base64') !== file.content) throw new Error('Invalid Development source encoding');
    if (data.length > sourceLimits.fileBytes || (bytes += data.length) > sourceLimits.totalBytes) throw new Error('Development source byte limit exceeded');
    if (sourceSecretPattern.test(data.toString('utf8'))) throw new Error('Credential-like source content blocked');
  }
  for (const path of paths) { const parts = path.split('/'); parts.pop(); while (parts.length) { if (paths.has(parts.join('/'))) throw new Error('Development source file and directory conflict'); parts.pop(); } }
  return files;
}
// Git tree hashing is independent of any worker-created .git/config, index or hooks.
export function sourceTree(files) {
  checkedFiles(files); const root = new Map();
  for (const file of files) {
    const parts = file.path.split('/'), name = parts.pop(); let directory = root;
    for (const part of parts) { if (!directory.has(part)) directory.set(part, new Map()); directory = directory.get(part); }
    directory.set(name, { mode: file.mode, sha: objectHash('blob', Buffer.from(file.content, 'base64')) });
  }
  function tree(directory) {
    const entries = [...directory].map(([name, value]) => value instanceof Map ? { name, mode: '40000', sha: tree(value), directory: true } : { name, ...value, directory: false });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.directory ? '/' : '')), Buffer.from(b.name + (b.directory ? '/' : ''))));
    return objectHash('tree', Buffer.concat(entries.map(value => Buffer.concat([Buffer.from(value.mode + ' ' + value.name + '\0'), Buffer.from(value.sha, 'hex')]))));
  }
  return tree(root);
}
export function changedFiles(before, after) {
  checkedFiles(before); checkedFiles(after);
  const original = new Map(before.map(file => [file.path, file])), current = new Map(after.map(file => [file.path, file]));
  const changes = [...new Set([...original.keys(), ...current.keys()])].sort().filter(path => {
    const old = original.get(path), next = current.get(path); return !old || !next || old.mode !== next.mode || old.content !== next.content;
  }).map(path => { if (!sourcePath(path, true)) throw new Error('Protected Development source change'); return current.get(path) ?? { path, mode: original.get(path).mode, content: null }; });
  if (!changes.length) throw new Error('Development candidate has no source change');
  return changes;
}

export function snapshotWorkspace(identity) {
  const workspace = workspaceData(identity), candidate = workspaceCandidate(identity);
  if (existsSync(join(workspace.commonPath, 'objects/info/alternates'))) throw new Error('Git alternate object storage is not qualified');
  const git = (args, options = {}) => {
    try { return execFileSync('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace.checkoutRoot, ...args],
      { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        timeout: 10000, maxBuffer: sourceLimits.totalBytes + 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
    catch { throw new Error('Immutable Development source read failed'); }
  };
  const listing = new TextDecoder('utf8', { fatal: true }).decode(git(['ls-tree', '-rz', candidate.gitTree]));
  if (listing && !listing.endsWith('\0')) throw new Error('Incomplete Development source tree');
  const entries = listing.split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match || !sourcePath(match[3])) throw new Error('Development source has an unsupported or protected entry');
    return { path: match[3], mode: match[1], sha: match[2] };
  });
  if (entries.length > sourceLimits.files) throw new Error('Development source file limit exceeded');
  const objects = git(['cat-file', '--batch'], { input: entries.map(entry => entry.sha + '\n').join('') });
  let cursor = 0;
  const files = entries.map(entry => {
    const end = objects.indexOf(10, cursor); if (end < cursor) throw new Error('Incomplete Development source object');
    const header = objects.subarray(cursor, end).toString('ascii'), match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.sha || Number(match[2]) > sourceLimits.fileBytes) throw new Error('Invalid Development source object');
    const size = Number(match[2]), bytes = objects.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size || objects[end + 1 + size] !== 10 || objectHash('blob', bytes) !== entry.sha) throw new Error('Development source object hash mismatch');
    cursor = end + size + 2; return { path: entry.path, mode: entry.mode, content: bytes.toString('base64') };
  });
  if (cursor !== objects.length || sourceTree(files) !== candidate.gitTree || JSON.stringify(workspaceCandidate(identity)) !== JSON.stringify(candidate)) throw new Error('Development source changed during capture');
  return { candidate, files: checkedFiles(files) };
}
