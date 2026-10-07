import { lstat, realpath, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { buildIdentity } from '../package/build.mjs';
import { verifyStagedInstaller } from './stage.mjs';
import { verifyMacUpdateBundle, runMacUpdateCommand } from './mac.mjs';

const same = (a, b) => ['dev', 'ino', 'uid', 'mode'].every(key => a[key] === b[key]);
const unchanged = (a, b) => same(a, b) && ['size', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

function binding(images, file, mount) {
  if (!Array.isArray(images) || images.length > 64) throw Error();
  const matches = images.filter(image => image?.['image-path'] === file || mount && Array.isArray(image?.['system-entities'])
    && image['system-entities'].some(entity => entity?.['mount-point'] === mount));
  if (!matches.length) return null;
  if (!mount || matches.length !== 1 || matches[0]['image-path'] !== file) throw Error();
  const entities = matches[0]['system-entities'];
  if (!Array.isArray(entities) || !entities.length || entities.length > 16
    || entities.some(entity => !/^\/dev\/disk\d+(?:s\d+)*$/.test(entity?.['dev-entry']))) throw Error();
  const devices = entities.map(entity => entity['dev-entry']), roots = devices.filter(device => /^\/dev\/disk\d+$/.test(device));
  const volumes = entities.filter(entity => entity['mount-point'] !== undefined);
  if (new Set(devices).size !== devices.length || roots.length !== 1 || volumes.length !== 1 || volumes[0]['mount-point'] !== mount) throw Error();
  return { device: roots[0], volume: volumes[0]['dev-entry'], devices };
}

// Host-only staging callback. Promotion may occur only after this scope verifies detach.
export async function withMacUpdateImage(options, consume, { run = runMacUpdateCommand, clock = Date.now } = {}) {
  let mount, owner, parent, attachment, volumeId, attempted = false, repair = false;
  try {
    record(options, ['directory', 'file', 'history', 'trust', 'current', 'team', 'isCurrent'], ['signal']);
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || typeof consume !== 'function' || typeof run !== 'function'
      || typeof clock !== 'function' || typeof options.team !== 'string' || !/^[A-Z0-9]{10}$/.test(options.team)
      || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw Error();
    options = { ...options, trust: { ...options.trust }, current: { ...options.current } };
    const signal = options.signal ?? new AbortController().signal, { team, ...stage } = options;
    const initial = await verifyStagedInstaller(stage, { clock }), original = await lstat(options.file);
    parent = await lstat(options.directory);
    const identity = buildIdentity({ kind: 'pipeliner-desktop-build', schemaVersion: 1,
      ...Object.fromEntries(['version', 'platform', 'architecture', 'sourceCommit', 'gitTree'].map(key => [key, initial.release[key]])) });
    async function plist(file, args, selectedSignal = signal) {
      const output = (await run(file, args, selectedSignal)).stdout;
      if (typeof output !== 'string' || Buffer.byteLength(output) > 32768) throw Error();
      const converted = (await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], selectedSignal, output)).stdout;
      if (typeof converted !== 'string' || Buffer.byteLength(converted) > 32768) throw Error();
      return JSON.parse(converted);
    }
    async function images(selectedSignal = signal) { return (await plist('/usr/bin/hdiutil', ['info', '-plist'], selectedSignal)).images; }
    async function current() {
      signal.throwIfAborted();
      if (options.isCurrent() !== true || canonicalJSON(await verifyStagedInstaller(stage, { clock })) !== canonicalJSON(initial)
        || !unchanged(original, await lstat(options.file)) || !same(parent, await lstat(options.directory))) throw Error();
      signal.throwIfAborted();
    }
    binding(await images(), options.file, null); await current();
    mount = join(options.directory, 'mount-' + randomUUID()); await mkdir(mount, { mode: 0o700 }); owner = await lstat(mount);
    if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid() || (owner.mode & 0o777) !== 0o700
      || await realpath(mount) !== mount) throw Error();
    let mountedOwner;
    async function mounted() {
      const bound = binding(await images(), options.file, mount);
      if (!bound || attachment && canonicalJSON(bound) !== canonicalJSON(attachment)) throw Error();
      const volume = await plist('/usr/sbin/diskutil', ['info', '-plist', mount]), info = await lstat(mount);
      if (volume.DeviceNode !== bound.volume || volume.MountPoint !== mount || volume.ReadOnlyMedia !== true || volume.ReadOnlyVolume !== true
        || typeof volume.VolumeUUID !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(volume.VolumeUUID)
        || !info.isDirectory() || info.isSymbolicLink()
        || ![0, process.getuid()].includes(info.uid) || info.mode & 0o022 || await realpath(mount) !== mount
        || mountedOwner && !same(mountedOwner, info) || volumeId && volumeId !== volume.VolumeUUID) throw Error();
      mountedOwner ??= info; volumeId ??= volume.VolumeUUID; return bound;
    }
    try {
      await current(); attempted = true;
      const attached = await plist('/usr/bin/hdiutil', ['attach', '-plist', '-readonly', '-nobrowse', '-noautoopen', '-owners', 'on',
        '-verify', '-noignorebadchecksums', '-mountpoint', mount, options.file]);
      attachment = binding([{ 'image-path': options.file, 'system-entities': attached['system-entities'] }], options.file, mount);
      await mounted();
      const bundle = join(mount, 'Pipeliner.app'); await current();
      await verifyMacUpdateBundle({ bundle, team, identity, signal }, { run }); await current(); await mounted();
      const result = await consume(immutable({ bundle, team, identity }));
      await current(); await verifyMacUpdateBundle({ bundle, team, identity, signal }, { run }); await mounted(); await current();
      return result;
    } finally {
      try {
        const cleanup = new AbortController().signal;
        if (attempted) {
          const bound = binding(await images(cleanup), options.file, mount);
          if (bound) {
            if (attachment && canonicalJSON(bound) !== canonicalJSON(attachment)) throw Error();
            if (volumeId) {
              const volume = await plist('/usr/sbin/diskutil', ['info', '-plist', mount], cleanup);
              if (volume.VolumeUUID !== volumeId || volume.DeviceNode !== bound.volume || volume.MountPoint !== mount) throw Error();
            }
            await run('/usr/bin/hdiutil', ['detach', bound.device], cleanup);
            if (binding(await images(cleanup), options.file, mount)) throw Error();
          }
        }
        const info = await lstat(mount);
        if (!same(owner, info) || !info.isDirectory() || info.isSymbolicLink() || await realpath(mount) !== mount
          || !same(parent, await lstat(options.directory)) || await realpath(options.directory) !== options.directory) throw Error();
        await rmdir(mount);
        try { await lstat(mount); throw Error(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        mount = undefined;
      } catch { repair = true; }
    }
  } catch { throw Error('update-image-unverified'); }
  finally { if (repair || mount) throw Error('update-image-recovery-required'); }
}
