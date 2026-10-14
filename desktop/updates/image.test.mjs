import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { canonicalJSON } from '../core/settings.mjs';
import { openVault } from '../connections/vault.mjs';
import { openUpdateHistory } from './history.mjs';
import { withMacUpdateImage } from './image.mjs';
import { runMacUpdateCommand } from './mac.mjs';

test('signed image consumption requires exact read-only native binding and awaits owned detach on every outcome', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-update-image-'))), directory = join(root, 'updates');
  mkdirSync(directory, { mode: 0o700 });
  const bytes = Buffer.from('Synthetic image: never attached by this test.'), file = join(directory, 'update-' + randomUUID() + '.dmg');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), team = 'ABCDEF1234';
  const trust = { id: 'synthetic-publisher', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const current = { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.1.0' };
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, ...current, version: '0.2.0', sequence: 1,
    issuedAt: 900, expiresAt: 2000, url: trust.origin + trust.path + 'Pipeliner.dmg', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  const identity = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: release.sourceCommit, gitTree: release.gitTree,
    version: release.version, platform: release.platform, architecture: release.architecture };
  let vault, history, mode, attached, mount, controller, authorized, calls, consumed, detached;
  const entities = () => { const device = mode === 'device-changed' && consumed ? '/dev/disk997' : '/dev/disk999';
    return [{ 'dev-entry': device, 'content-hint': 'GUID_partition_scheme' },
      { 'dev-entry': device + 's1', 'content-hint': 'Apple_HFS', 'mount-point': mount }]; };
  const image = () => ({ 'image-path': file, 'system-entities': entities() });
  const run = async (command, args, signal, input) => {
    signal.throwIfAborted(); calls.push({ command, args });
    if (command === '/usr/bin/plutil' && input !== undefined) {
      assert.deepEqual(args, ['-convert', 'json', '-o', '-', '-']); return { stdout: input, stderr: '' };
    }
    if (command === '/usr/bin/hdiutil') {
      if (args[0] === 'info') {
        assert.deepEqual(args, ['info', '-plist']);
        const images = attached ? [image()] : [];
        if (mode === 'already' && !attached) images.push({ 'image-path': file, 'system-entities': [{ 'dev-entry': '/dev/disk998' }] });
        if (mode === 'duplicate' && attached) images.push(image());
        if (mode === 'foreign' && attached) images[0]['image-path'] = join(directory, 'unrelated.dmg');
        return { stdout: JSON.stringify({ images }), stderr: '' };
      }
      if (args[0] === 'attach') {
        mount = args[args.indexOf('-mountpoint') + 1];
        assert.deepEqual(args, ['attach', '-plist', '-readonly', '-nobrowse', '-noautoopen', '-owners', 'on', '-verify', '-noignorebadchecksums', '-mountpoint', mount, file]);
        assert(mount.startsWith(directory + '/mount-')); assert.deepEqual(readdirSync(mount), []); attached = true;
        const bundle = join(mount, 'Pipeliner.app'); mkdirSync(join(bundle, 'Contents/Resources'), { recursive: true, mode: 0o700 });
        mkdirSync(join(bundle, 'Contents/MacOS'), { mode: 0o700 });
        writeFileSync(join(bundle, 'Contents/MacOS/Pipeliner'), 'Synthetic never-executed executable', { mode: 0o700 });
        writeFileSync(join(bundle, 'Contents/Info.plist'), 'Synthetic native plist', { mode: 0o600 });
        writeFileSync(join(bundle, 'Contents/Resources/pipeliner-build.json'), canonicalJSON(identity) + '\n', { mode: 0o600 });
        if (mode === 'partial') throw Error('Synthetic partial attachment');
        if (mode === 'cancel') controller.abort();
        return { stdout: JSON.stringify({ 'system-entities': entities() }), stderr: '' };
      }
      assert.deepEqual(args, ['detach', '/dev/disk999']);
      assert.equal(signal.aborted, false); assert.equal(attached, true);
      if (mode === 'detach') throw Error('Synthetic detach denial');
      await new Promise(resolve => setImmediate(resolve));
      if (mode !== 'detach-incomplete') { rmSync(join(mount, 'Pipeliner.app'), { recursive: true }); attached = false; }
      detached++; return { stdout: '', stderr: '' };
    }
    if (command === '/usr/sbin/diskutil') {
      assert.deepEqual(args, ['info', '-plist', mount]);
      return { stdout: JSON.stringify({ DeviceNode: '/dev/disk999s1', MountPoint: mode === 'mountpoint' ? '/foreign' : mount,
        ReadOnlyMedia: mode !== 'media', ReadOnlyVolume: mode !== 'volume', VolumeUUID: mode === 'uuid-changed' && consumed
          ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : mode === 'uuid-invalid' ? 'invalid' : '11111111-2222-3333-4444-555555555555' }), stderr: '' };
    }
    if (command === '/usr/bin/codesign') {
      if (args.includes('--verify')) { assert(args.includes('--strict')); assert(args[args.indexOf('-R') + 1].includes(team)); if (mode === 'signature') throw Error(); }
      return { stdout: '', stderr: 'TeamIdentifier=' + team + '\nCodeDirectory v=20500 size=10 flags=0x10000(runtime)\nTimestamp=synthetic timestamp\n' };
    }
    if (command === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: 'com.zuriellabs.pipeliner.desktop', CFBundleExecutable: 'Pipeliner',
      CFBundlePackageType: 'APPL', CFBundleShortVersionString: release.version, CFBundleVersion: release.version }), stderr: '' };
    if (command === '/usr/bin/lipo') return { stdout: 'arm64\n', stderr: '' };
    assert.equal(command, '/usr/bin/syspolicy_check'); if (mode === 'policy') throw Error();
    return { stdout: '', stderr: '' };
  };
  async function invoke(selected) {
    mode = selected; attached = false; mount = null; controller = new AbortController(); authorized = true; calls = []; consumed = 0; detached = 0;
    writeFileSync(file, bytes, { mode: 0o600 });
    return withMacUpdateImage({ directory, file, history, trust, current, team, signal: controller.signal, isCurrent: () => authorized }, async value => {
      consumed++; assert.equal(value.bundle, join(mount, 'Pipeliner.app')); assert.deepEqual(value.identity, identity); assert.equal(value.team, team);
      assert.equal(attached, true); assert.equal(detached, 0);
      if (mode === 'callback') throw Error('Synthetic callback error');
      if (mode === 'stale') authorized = false;
      if (mode === 'tamper') writeFileSync(file, Buffer.alloc(bytes.length, 8));
      if (mode === 'cancel-callback') controller.abort();
      return 'Synthetic staged copy';
    }, { run, clock: () => 1000 });
  }
  try {
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async data => ({ result: data.toString(), shouldReEncrypt: false }) });
    history = openUpdateHistory(root, { vault, clock: () => 1000 });
    const attempt = history.begin(trust, current);
    history.complete(attempt.token, Buffer.from(canonicalJSON({ release, signature: sign(null, Buffer.from(canonicalJSON(release)), privateKey).toString('base64') })));
    assert.equal(await invoke('valid'), 'Synthetic staged copy'); assert.equal(consumed, 1); assert.equal(detached, 1); assert.equal(existsSync(mount), false);
    for (const selected of ['already', 'partial', 'media', 'volume', 'mountpoint', 'uuid-invalid', 'signature', 'policy', 'cancel', 'callback', 'stale', 'tamper', 'cancel-callback']) {
      await assert.rejects(invoke(selected), /^Error: update-image-unverified$/);
      assert.equal(attached, false); assert.equal(existsSync(mount ?? join(directory, 'absent')), false);
      assert.equal(readFileSync(file).length, bytes.length);
    }
    for (const selected of ['duplicate', 'foreign', 'detach', 'detach-incomplete', 'device-changed', 'uuid-changed']) {
      await assert.rejects(invoke(selected), /^Error: update-image-recovery-required$/);
      assert.equal(attached, true); assert.equal(existsSync(mount), true);
      // Only synthetic fixture directories exist; no native mount is created.
      rmSync(mount, { recursive: true }); attached = false;
    }
    const prior = history.read(trust, current); assert.equal(prior.sequence, 1); assert.equal(prior.availability.release.sha256, release.sha256);
    const converted = await runMacUpdateCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], new AbortController().signal,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>synthetic</key><true/></dict></plist>');
    assert.deepEqual(JSON.parse(converted.stdout), { synthetic: true });
  } finally { history?.close(); vault?.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});
