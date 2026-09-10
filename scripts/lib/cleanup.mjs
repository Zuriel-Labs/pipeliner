import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const marker = '.pipeliner-test-owner';
export async function createTestWorkspace(parent) {
  const directory = await mkdtemp(path.join(await realpath(parent), 'pipeliner-run-'));
  const workspace = { path: directory, token: randomUUID() };
  await writeFile(path.join(directory, marker), workspace.token, { flag: 'wx', mode: 0o600 });
  return workspace;
}
export async function removeTestWorkspace(workspace) {
  const directory = path.resolve(workspace.path);
  if (!path.basename(directory).startsWith('pipeliner-run-')) throw new Error('invalid workspace ownership boundary');
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('refusing symlink workspace or ancestor');
  if (typeof workspace.token !== 'string' || await readFile(path.join(directory, marker), 'utf8') !== workspace.token) throw new Error('workspace ownership mismatch');
  await rm(directory, { recursive: true });
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return { removed: true }; throw error; }
  throw new Error('workspace cleanup readback failed');
}
export function cleanupComplete(cleanup) {
  return cleanup?.verified === true && typeof cleanup.evidence === 'string' && cleanup.evidence.trim() !== '' &&
    Array.isArray(cleanup.resources) && cleanup.resources.every(resource =>
      ['process', 'container', 'image', 'volume', 'workspace', 'artifact'].includes(resource?.kind) &&
      ['id', 'run', 'owner', 'evidence'].every(key => typeof resource[key] === 'string' && resource[key].trim()) && resource.status === 'removed');
}
