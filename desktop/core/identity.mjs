import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { immutable, canonicalJSON, record } from './settings.mjs';

const identities = new WeakMap();
function localGit(checkout, args, missing = false) {
  try { return execFileSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', checkout, ...args],
    { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { if (missing && error.status === 1) return ''; throw new Error('Local Git identity inspection failed'); }
}
export function repositoryOrigin(value) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/.exec(value);
  if (!match) throw new Error('Unsupported or credential-bearing repository origin');
  const name = match[2].replace(/\.git$/, '');
  if (['', '.', '..'].includes(name)) throw new Error('Invalid repository origin');
  return `${match[1]}/${name}`.toLowerCase();
}

export function workspaceRemote(directory) {
  const checkout = realpathSync(directory);
  const urls = localGit(checkout, ['config', '--no-includes', '--local', '--get-all', 'remote.origin.url']).split('\n');
  const pushes = localGit(checkout, ['config', '--no-includes', '--local', '--get-all', 'remote.origin.pushurl'], true);
  if (urls.length !== 1) throw new Error('Local origin is ambiguous');
  const slug = repositoryOrigin(urls[0]);
  if (pushes && pushes.split('\n').some(value => repositoryOrigin(value) !== slug)) throw new Error('Local fetch and push identity mismatch');
  return slug;
}

// Host only: remote comes from the selected, independently verified GitHub catalog.
export function inspectWorkspace(directory, remote) {
  canonicalJSON(remote); record(remote, ['repository', 'owner', 'name']);
  if (typeof remote.repository !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(remote.repository)
    || typeof remote.owner !== 'string' || typeof remote.name !== 'string' || typeof directory !== 'string' || directory.includes('\0')) throw new Error('Invalid repository identity');
  if (!/^[A-Za-z0-9-]{1,39}$/.test(remote.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(remote.name) || ['.', '..'].includes(remote.name)) throw new Error('Invalid selected repository identity');
  const selected = `${remote.owner}/${remote.name}`.toLowerCase(), checkout = realpathSync(directory);
  const git = (args, missing) => localGit(checkout, args, missing);
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') throw new Error('Select a Git working directory');
  const checkoutRoot = realpathSync(git(['rev-parse', '--show-toplevel']));
  if (checkout !== checkoutRoot && !checkout.startsWith(`${checkoutRoot}${sep}`)) throw new Error('Selected folder is outside the verified working tree');
  const urls = git(['config', '--no-includes', '--local', '--get-all', 'remote.origin.url']).split('\n');
  const pushes = git(['config', '--no-includes', '--local', '--get-all', 'remote.origin.pushurl'], true);
  if (urls.length !== 1 || [...urls, ...(pushes ? pushes.split('\n') : [])].some(url => repositoryOrigin(url) !== selected)) throw new Error('Local and selected GitHub identity mismatch');
  const commonPath = realpathSync(resolve(checkout, git(['rev-parse', '--path-format=absolute', '--git-common-dir'])));
  const common = statSync(commonPath, { bigint: true });
  if (!common.isDirectory()) throw new Error('Invalid Git common directory');
  const data = { repository: remote.repository, host: 'github.com', slug: selected, localKey: `${common.dev}:${common.ino}`, commonPath, checkoutRoot };
  const handle = immutable({ repository: data.repository }); identities.set(handle, { data: immutable(data), remote: immutable({ ...remote }) }); return handle;
}

export function workspaceData(handle) {
  const stored = identities.get(handle); if (!stored) throw new Error('Unverified repository identity handle');
  const current = identities.get(inspectWorkspace(stored.data.checkoutRoot, stored.remote)).data;
  if (canonicalJSON(current) !== canonicalJSON(stored.data)) throw new Error('Local filesystem identity changed since inspection');
  return stored.data;
}

export function workspaceCandidate(handle) {
  const { checkoutRoot } = workspaceData(handle);
  const value = { sourceCommit: localGit(checkoutRoot, ['rev-parse', 'HEAD']), gitTree: localGit(checkoutRoot, ['rev-parse', 'HEAD^{tree}']) };
  if (!Object.values(value).every(v => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v))) throw new Error('Invalid local candidate');
  return immutable(value);
}
