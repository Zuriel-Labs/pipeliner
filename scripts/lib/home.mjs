import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
function repositoryOf(remote) {
  // Reject credentials, alternate hosts and local paths; never echo remote values.
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}
export async function resolveHome(anchor) {
  let location = await realpath(anchor);
  if (!(await stat(location)).isDirectory()) location = path.dirname(location);
  const root = await realpath((await run('git', ['-C', location, 'rev-parse', '--show-toplevel'])).stdout.trim());
  // Anchor is the installed canonical path, never a remembered checkout or unrelated cwd.
  if (location !== root && !location.startsWith(root + path.sep)) throw new Error('home anchor outside Git root');
  await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const profile = JSON.parse(await readFile(path.join(root, 'pipeliner.config.json'), 'utf8'));
  await verifyRepository(root, profile);
  return { root, repository: `${profile.repository.owner}/${profile.repository.name}`, profilePath: path.join(root, 'pipeliner.config.json') };
}
export async function verifyRepository(target, profile) {
  const root = await realpath(target);
  const git = async (...args) => (await run('git', ['-C', root, ...args], { maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await realpath(await git('rev-parse', '--show-toplevel')) !== root) throw new Error('adoption target must be its own Git root');
  const { owner, name } = profile.repository ?? {};
  if (![owner, name].every(value => typeof value === 'string' && /^[\w.-]+$/.test(value))) throw new Error('home repository identity missing');
  const expected = `${owner}/${name}`;
  for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
    const remotes = (await git(...args)).split('\n');
    if (!remotes.length || remotes.some(remote => repositoryOf(remote) !== expected.toLowerCase())) throw new Error('home remote identity mismatch or unsupported remote');
  }
  return { root, repository: expected };
}
