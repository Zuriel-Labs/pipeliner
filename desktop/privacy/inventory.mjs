import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const definitions = [
  ['connections', 'Connections and installation key', ['connections.sqlite'], 'OS-wrapped key and encrypted credentials', 'Managed through protected Connections', 'connections'],
  ['policy', 'PM settings and authority receipts', ['policy.sqlite'], 'Private PM control plane; credential values excluded', 'Versioned settings and minimal authority receipts are preserved', 'pipelines'],
  ['workspaces', 'Workspaces, context and schedules', ['workspaces.sqlite'], 'Authenticated encryption with the installation key', 'Current workspace and recovery records are preserved', 'repositories'],
  ['development', 'Development and recovery evidence', ['development.sqlite'], 'Authenticated encryption with the installation key', 'Active and uncertain execution evidence is preserved', 'agents'],
  ['execution', 'Execution ownership and effect ledger', ['owner.sqlite', 'execution.sqlite'], 'Private host control plane', 'Ownership and effect receipts are preserved', 'agents'],
  ['extensions', 'Skill and tool definitions', ['skills.sqlite', 'tools.sqlite'], 'Private installation storage; credentials stored separately', 'Pinned definitions needed by captured runs remain retained', 'skills'],
  ['privacy', 'Conversations, logs and audit', ['privacy.sqlite'], 'Authenticated encryption with the installation key', 'Scoped category retention and previewed deletion', 'privacy'],
  ['artifacts', 'Artifact index and command receipts', ['artifacts.sqlite'], 'Authenticated encryption with the installation key', 'Minimal command identities remain after archive removal', 'delivery'],
];
const folders = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'SharedDictionary', 'Network', 'crashes'];
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const backupName = new RegExp('^(?:workspaces|development|artifacts)-v(?:[1-9][0-9]?|100)-' + uuid + '\\.pipeliner-backup$');
function info(path, privateFile = false) {
  const value = lstatSync(path);
  if (value.isSymbolicLink() || value.uid !== process.getuid() || (value.mode & 0o022) || !Number.isSafeInteger(value.size)
    || value.isFile() && (value.nlink !== 1 || privateFile && (value.mode & 0o777) !== 0o600) || !value.isFile() && !value.isDirectory()) throw Error();
  return value;
}
function optional(path, privateFile) { try { return info(path, privateFile); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function boundedNames(path) {
  const directory = opendirSync(path), names = [];
  try { let entry; while ((entry = directory.readSync())) { if (names.length >= 512) throw Error(); names.push(entry.name); } }
  finally { directory.closeSync(); } return names;
}
function fileSet(root, names) {
  let bytes = 0, count = 0;
  for (const name of names) { const value = optional(join(root, name), true); if (!value) continue; if (!value.isFile()) throw Error(); bytes += value.size; count++; }
  return { bytes, count };
}
function directorySet(root, names) {
  const queue = names.map(name => ({ path: join(root, name), depth: 0 })); let bytes = 0, count = 0, examined = 0;
  while (queue.length) {
    const item = queue.shift(), value = optional(item.path, false); if (!value) continue;
    if (++examined > 512 || item.depth > 8) throw Error();
    if (value.isFile()) { bytes += value.size; count++; }
    else for (const name of boundedNames(item.path)) { if (queue.length + examined >= 512) throw Error(); queue.push({ path: join(item.path, name), depth: item.depth + 1 }); }
  }
  return { bytes, count };
}

// Read metadata only. Fixed app-owned categories; no credential payloads, paths or unknown filenames leave this module.
export function inspectManagedData(directory) {
  try {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700 || resolve(directory) !== directory || realpathSync(directory) !== directory) throw Error();
    function category(id, label, protection, retention, manage, inspect) {
      try { const data = inspect(); return { id, label, protection, retention, manage, scope: 'installation', destination: 'local', state: data.count ? 'present' : 'empty', ...data }; }
      catch { return { id, label, protection, retention, manage, scope: 'installation', destination: 'local', state: 'unavailable', count: null, bytes: null }; }
    }
    const results = definitions.map(([id, label, files, protection, retention, manage]) => category(id, label, protection, retention, manage,
      () => fileSet(directory, files.flatMap(file => [file, file + '-journal', file + '-wal', file + '-shm']))));
    results.push(category('archives', 'Retained artifact archives', 'Authenticated encrypted chunks; interrupted allocations may need repair', 'Latest, pinned, active and designated recovery protections apply', 'delivery', () => directorySet(directory, ['artifacts'])));
    results.push(category('provider', 'Managed Codex state', 'Private managed provider folder; login credentials remain in the OS keyring', 'Managed through protected Connections; provider copies remain external', 'connections', () => directorySet(directory, ['codex'])));
    results.push(category('migration', 'Compatible migration backups', 'Authenticated encrypted original state', 'Retained for compatible recovery; never restored automatically', 'privacy', () => fileSet(directory, boundedNames(directory).filter(name => backupName.test(name)))));
    results.push(category('cache', 'Runtime caches and crash records', 'Private installation folder; these files are not promised encrypted', 'Current Electron caches and local crash records; no automatic upload', 'privacy', () => directorySet(directory, folders)));
    if (realpathSync(directory) !== directory || lstatSync(directory).dev !== root.dev || lstatSync(directory).ino !== root.ino) throw Error();
    return results;
  } catch { throw Error('Installation data inventory unavailable; existing data preserved'); }
}
