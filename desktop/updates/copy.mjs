import { constants } from 'node:fs';
import { lstat, realpath, mkdir, rmdir, readdir, readlink, statfs, open } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { buildIdentity } from '../package/build.mjs';
import { withMacUpdateImage } from './image.mjs';
import { verifyMacUpdateBundle, runMacUpdateCommand } from './mac.mjs';

const same = (a, b) => ['dev', 'ino', 'uid', 'mode'].every(key => a[key] === b[key]);
const stable = (a, b) => same(a, b) && ['size', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const stat = path => lstat(path, { bigint: true });
const inside = (root, path) => path === root || path.startsWith(root + '/');

// Host-only, pre-promotion copy. Its coordinator must persist maintenance intent first.
export async function stageMacUpdateBundle(options, { run = runMacUpdateCommand, clock = Date.now } = {}) {
  let root, owner, appOwner, copiedTree, copying = false;
  try {
    record(options, ['directory', 'installed', 'image', 'maxBytes', 'reserveBytes']);
    record(options.installed, ['bundle', 'team', 'identity']);
    const installed = { ...options.installed, identity: buildIdentity(options.installed.identity) };
    const image = { ...options.image, current: { ...options.image.current }, trust: { ...options.image.trust } };
    const { directory, maxBytes, reserveBytes } = options, signal = image.signal ?? new AbortController().signal;
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || typeof run !== 'function' || typeof clock !== 'function'
      || !(signal instanceof AbortSignal) || typeof directory !== 'string' || resolve(directory) !== directory
      || /[\x00-\x1f\x7f]/.test(directory) || typeof image.isCurrent !== 'function' || installed.team !== image.team
      || ['version', 'platform', 'architecture'].some(key => installed.identity[key] !== image.current?.[key])
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 ** 3
      || !Number.isSafeInteger(reserveBytes) || reserveBytes < 1024 ** 2 || reserveBytes > 1024 ** 4) throw Error();
    function current() { signal.throwIfAborted(); if (image.isCurrent() !== true) throw Error(); }
    current(); await verifyMacUpdateBundle({ ...installed, signal }, { run }); current();
    const helper = join(installed.bundle, 'Contents/Resources/helpers/update-exchange'), executable = await stat(helper);
    if (!executable.isFile() || executable.nlink !== 1n || ![0n, BigInt(process.getuid())].includes(executable.uid)
      || executable.mode & 0o022n || !(executable.mode & 0o111n) || await realpath(helper) !== helper) throw Error();
    const parent = await stat(directory);
    if (!installed.bundle.endsWith('/Pipeliner.app') || (await stat(installed.bundle)).dev !== parent.dev) throw Error();
    async function privateDirectory(path, original) {
      current(); const info = await stat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid())
        || (info.mode & 0o777n) !== 0o700n || await realpath(path) !== path || !same(info, original)
        || !stable(executable, await stat(helper)) || await realpath(helper) !== helper) throw Error();
      const result = await run(helper, ['--verify-parent', path, info.dev.toString(), info.ino.toString()], signal);
      current();
      if (result.stdout !== 'pipeliner-update-parent-verified\n' || result.stderr !== '' || !same(info, await stat(path))
        || await realpath(path) !== path || !stable(executable, await stat(helper))) throw Error();
    }
    await privateDirectory(directory, parent);
    async function inventory(bundle, owned) {
      const device = (await stat(bundle)).dev, items = []; let bytes = 0;
      async function inspect(path, relative, depth) {
        if (depth > 64 || items.length >= 20000) throw Error();
        const info = await stat(path), mode = info.mode & 0o7777n;
        if (info.dev !== device || mode & 0o6000n || !info.isSymbolicLink() && mode & 0o022n
          || (owned ? info.uid !== BigInt(process.getuid()) : ![0n, BigInt(process.getuid())].includes(info.uid))) throw Error();
        const item = { path, relative, info, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'link' : null };
        if (!item.type) throw Error();
        if (item.type === 'link') {
          // macOS reports link mode 0777; write permission on links is not an access grant.
          item.link = await readlink(path);
          if (info.nlink !== 1n || isAbsolute(item.link) || /[\x00-\x1f\x7f]/.test(item.link) || !inside(bundle, resolve(dirname(path), item.link))
            || !inside(bundle, await realpath(path))) throw Error();
        } else {
          if (await realpath(path) !== path) throw Error();
          if (item.type === 'file') { if (info.nlink !== 1n || info.size < 0n || info.size > BigInt(maxBytes - bytes)) throw Error(); bytes += Number(info.size); }
        }
        items.push(item);
        if (item.type === 'directory') for (const name of (await readdir(path)).sort()) {
          if (/[\x00-\x1f\x7f]/.test(name)) throw Error(); await inspect(join(path, name), relative ? relative + '/' + name : name, depth + 1);
        }
        if (!stable(info, await stat(path))) throw Error();
      }
      await inspect(bundle, '', 0); current(); return { items, bytes };
    }
    async function unchanged(snapshot) {
      for (const item of snapshot.items) {
        current(); if (!stable(item.info, await stat(item.path)) || item.type === 'link' && await readlink(item.path) !== item.link) throw Error();
      }
    }
    const result = await withMacUpdateImage({ ...image, signal }, async source => {
      const original = await inventory(source.bundle, false), capacity = await statfs(directory, { bigint: true });
      if (capacity.bavail * capacity.bsize < BigInt(original.bytes + reserveBytes)) throw Error();
      await privateDirectory(directory, parent); await unchanged(original);
      root = join(directory, 'candidate-' + randomUUID()); await mkdir(root, { mode: 0o700 }); owner = await stat(root);
      if (owner.dev !== parent.dev) throw Error();
      await privateDirectory(root, owner); const bundle = join(root, 'Pipeliner.app');
      try { await stat(bundle); throw Error(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      current(); copying = true;
      await run('/usr/bin/ditto', ['-X', '--rsrc', '--extattr', '--qtn', '--noacl', source.bundle, bundle], signal);
      current(); appOwner = await stat(bundle); const copied = await inventory(bundle, true); copiedTree = copied;
      const shape = snapshot => canonicalJSON(snapshot.items.map(item => ({ relative: item.relative, type: item.type,
        ...(item.type === 'file' ? { bytes: Number(item.info.size) } : item.type === 'link' ? { link: item.link } : {}) })));
      if (!same(appOwner, await stat(bundle)) || shape(original) !== shape(copied) || original.bytes !== copied.bytes) throw Error();
      await verifyMacUpdateBundle({ bundle, team: source.team, identity: source.identity, signal }, { run });
      await verifyMacUpdateBundle({ ...installed, signal }, { run }); await unchanged(original); await unchanged(copied);
      for (const item of copied.items.toReversed().filter(item => item.type !== 'link')) {
        current(); const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | (item.type === 'directory' ? constants.O_DIRECTORY : constants.O_NONBLOCK));
        try { if (!stable(item.info, await file.stat({ bigint: true }))) throw Error(); await file.sync(); if (!stable(item.info, await file.stat({ bigint: true }))) throw Error(); }
        finally { await file.close(); }
      }
      for (const path of [root, directory]) { const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); } }
      await unchanged(copied); await privateDirectory(root, owner); await privateDirectory(directory, parent);
      return immutable({ directory: root, bundle, identity: source.identity, team: source.team,
        bytes: copied.bytes, nodes: copied.items.length, device: appOwner.dev.toString(), inode: appOwner.ino.toString() });
    }, { run, clock });
    await unchanged(copiedTree); await verifyMacUpdateBundle({ bundle: result.bundle, team: result.team, identity: result.identity, signal }, { run });
    await unchanged(copiedTree); await privateDirectory(root, owner); await privateDirectory(directory, parent); current(); return result;
  } catch (error) {
    // After copy starts, partial or changed trees remain for the durable coordinator's recovery.
    if (copying || error?.message === 'update-image-recovery-required') throw Error('update-bundle-copy-recovery-required');
    if (owner) try {
      if (!same(owner, await stat(root)) || await realpath(root) !== root) throw Error();
      if (appOwner) { const bundle = join(root, 'Pipeliner.app'); if (!same(appOwner, await stat(bundle))) throw Error(); await rmdir(bundle); }
      await rmdir(root);
    } catch { throw Error('update-bundle-copy-recovery-required'); }
    throw Error('update-bundle-copy-unverified');
  }
}
