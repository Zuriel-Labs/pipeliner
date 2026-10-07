import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { canonicalJSON } from '../core/settings.mjs';
import { openVault } from '../connections/vault.mjs';
import { openUpdateHistory } from './history.mjs';
import { runMacUpdateCommand } from './mac.mjs';
import { stageMacUpdateBundle } from './copy.mjs';
import { openUpdateMaintenance } from './maintenance.mjs';
import { captureUpdateBackups } from './backup.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openDevelopmentStore } from '../development/state.mjs';
import { openArtifactStore } from '../delivery/artifacts.mjs';
import { DatabaseSync } from 'node:sqlite';

async function checkCopy(unsafe, journaled = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-54-update-copy-'))), directory = join(root, 'updates');
  await mkdir(directory, { mode: 0o700 });
  const installed = join(root, 'Pipeliner.app'), team = 'ABCDEF1234', helper = join(installed, 'Contents/Resources/helpers/update-exchange');
  const from = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'a'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
  const to = { ...from, version: '0.2.0', sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  async function fixture(bundle, identity) {
    await mkdir(join(bundle, 'Contents/Resources'), { recursive: true, mode: 0o700 });
    await mkdir(join(bundle, 'Contents/MacOS'), { mode: 0o700 });
    await writeFile(join(bundle, 'Contents/Resources/pipeliner-build.json'), canonicalJSON(identity) + '\n', { mode: 0o600 });
    await writeFile(join(bundle, 'Contents/Info.plist'), 'Synthetic plist; never native verified.', { mode: 0o600 });
    await writeFile(join(bundle, 'Contents/MacOS/Pipeliner'), 'Synthetic executable; never launched.', { mode: 0o700 });
  }
  await fixture(installed, from); await mkdir(join(installed, 'Contents/Resources/helpers'), { mode: 0o700 });
  await writeFile(helper, 'Synthetic helper; never executed.', { mode: 0o700 });
  const bytes = Buffer.from('Synthetic image; never attached.'), file = join(directory, 'update-' + randomUUID() + '.dmg');
  await writeFile(file, bytes, { mode: 0o600 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trust = { id: 'synthetic-publisher', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const current = { channel: 'stable', version: from.version, platform: from.platform, architecture: from.architecture };
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, ...current, version: to.version, sequence: 1,
    issuedAt: 900, expiresAt: 2000, url: trust.origin + trust.path + 'Pipeliner.dmg', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), sourceCommit: to.sourceCommit, gitTree: to.gitTree };
  let mode, mount, attached, copied, detached, authorized, controller, destination, vault, history, journal, journalToken, workspaces, development, artifacts, db;
  const quarantine = '0081;00000000;PipelinerSynthetic54;';
  const entities = () => [{ 'dev-entry': '/dev/disk999' }, { 'dev-entry': '/dev/disk999s1', 'mount-point': mount }];
  const run = async (command, args, signal, input) => {
    signal.throwIfAborted();
    if (command === '/usr/bin/plutil' && input !== undefined) return { stdout: input, stderr: '' };
    if (command === '/usr/bin/hdiutil') {
      if (args[0] === 'info') return { stdout: JSON.stringify({ images: attached ? [{ 'image-path': file, 'system-entities': entities() }] : [] }), stderr: '' };
      if (args[0] === 'attach') {
        mount = args[args.indexOf('-mountpoint') + 1]; attached = true;
        const bundle = join(mount, 'Pipeliner.app'); await fixture(bundle, mode === 'wrong-target' ? { ...to, gitTree: 'd'.repeat(40) } : to);
        const framework = join(bundle, 'Contents/Frameworks/Synthetic.framework/Versions/A'); await mkdir(framework, { recursive: true, mode: 0o700 });
        await writeFile(join(framework, 'Synthetic'), 'Synthetic framework bytes', { mode: 0o600 });
        await symlink('A', join(framework, '../Current'));
        if (mode === 'external-link') await symlink(installed, join(bundle, 'outside'));
        if (mode === 'hardlink') await link(join(framework, 'Synthetic'), join(framework, 'linked'));
        await runMacUpdateCommand('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, bundle], signal);
        return { stdout: JSON.stringify({ 'system-entities': entities() }), stderr: '' };
      }
      assert.deepEqual(args, ['detach', '/dev/disk999']); assert.equal(signal.aborted, false);
      if (mode === 'detach') throw Error('Synthetic detach refusal');
      if (mode === 'detach-tamper') await writeFile(join(destination, 'Contents/Resources/pipeliner-build.json'), canonicalJSON({ ...to, gitTree: 'd'.repeat(40) }) + '\n');
      await rm(join(mount, 'Pipeliner.app'), { recursive: true }); attached = false; detached++;
      return { stdout: '', stderr: '' };
    }
    if (command === '/usr/sbin/diskutil') return { stdout: JSON.stringify({ DeviceNode: '/dev/disk999s1', MountPoint: mount,
      ReadOnlyMedia: true, ReadOnlyVolume: true, VolumeUUID: '11111111-2222-3333-4444-555555555555' }), stderr: '' };
    if (command === helper) {
      assert.equal(args[0], '--verify-parent'); const info = await lstat(args[1], { bigint: true });
      assert.deepEqual(args.slice(2), [info.dev.toString(), info.ino.toString()]);
      if (mode === 'guard') throw Error('Synthetic ownership refusal');
      return { stdout: 'pipeliner-update-parent-verified\n', stderr: '' };
    }
    if (command === '/usr/bin/ditto') {
      copied++; destination = args.at(-1); assert.equal(detached, 0); assert.equal(attached, true);
      if (journaled) {
        assert.equal(journal.read().copy.directory, join(directory, 'candidate-' + journal.read().id));
        const saved = journal.read(); assert.equal(saved.copy.directory, join(directory, 'candidate-' + saved.id));
        assert.equal(destination, join(saved.copy.directory, 'Pipeliner.app')); assert.equal(saved.copy.receipt, undefined);
        assert.deepEqual(saved.copy.installed, { bundle: installed, team, identity: from });
      }
      assert.deepEqual(args.slice(0, -2), ['-X', '--rsrc', '--extattr', '--qtn', '--noacl']);
      await assert.rejects(lstat(destination), error => error.code === 'ENOENT');
      await runMacUpdateCommand(command, args, signal);
      if (mode === 'copy') throw Error('Synthetic completed-copy failure');
      if (mode === 'tamper') await writeFile(join(destination, 'Contents/Resources/pipeliner-build.json'), canonicalJSON({ ...to, gitTree: 'd'.repeat(40) }) + '\n');
      if (mode === 'stale') authorized = false;
      if (mode === 'cancel') controller.abort();
      return { stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/codesign') {
      if (journaled) {
        await assert.rejects(journal.stageBundle(journalToken, { installed: { bundle: installed, team, identity: from }, history, trust, current,
          maxBytes: 1024 ** 2, reserveBytes: 1024 ** 2 }, { run }));
        assert.throws(() => journal.cancel(journalToken));
      }
      const bundle = args.at(-1);
      if (args.includes('--verify') && (mode === 'installed-signature' && bundle === installed || mode === 'source-signature' && mount && bundle === join(mount, 'Pipeliner.app'))) throw Error('Synthetic signature refusal');
      return { stdout: '', stderr: 'TeamIdentifier=' + team + '\nCodeDirectory v=20500 size=10 flags=0x10000(runtime)\nTimestamp=synthetic\n' };
    }
    if (command === '/usr/bin/plutil') {
      const bundle = args.at(-1).slice(0, -'/Contents/Info.plist'.length), identity = JSON.parse(await readFile(join(bundle, 'Contents/Resources/pipeliner-build.json'), 'utf8'));
      return { stdout: JSON.stringify({ CFBundleIdentifier: 'com.zuriellabs.pipeliner.desktop', CFBundleExecutable: 'Pipeliner', CFBundlePackageType: 'APPL',
        CFBundleShortVersionString: identity.version, CFBundleVersion: identity.version }), stderr: '' };
    }
    if (command === '/usr/bin/lipo') return { stdout: 'arm64\n', stderr: '' };
    assert.equal(command, '/usr/bin/syspolicy_check'); return { stdout: '', stderr: '' };
  };
  const reset = selected => {
    mode = selected; mount = null; attached = false; copied = 0; detached = 0; authorized = true; destination = null; controller = new AbortController();
  };
  const invoke = selected => {
    reset(selected);
    return stageMacUpdateBundle({ directory, id: randomUUID(), installed: { bundle: installed, identity: mode === 'wrong-current' ? to : from, team },
      image: { directory, file, history, trust, current, team, signal: controller.signal, isCurrent: () => authorized },
      maxBytes: mode === 'overflow' ? 1 : 1024 ** 2, reserveBytes: 1024 ** 2 }, { run, clock: () => 1000 });
  };
  try {
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text), decrypt: async data => ({ result: data.toString(), shouldReEncrypt: false }) });
    history = openUpdateHistory(root, { vault, clock: () => 1000 }); const attempt = history.begin(trust, current);
    history.complete(attempt.token, Buffer.from(canonicalJSON({ release, signature: sign(null, Buffer.from(canonicalJSON(release)), privateKey).toString('base64') })));
    if (journaled) {
      workspaces = openWorkspaceStore(root, { vault }); development = openDevelopmentStore(root, { vault });
      artifacts = await openArtifactStore(root, { vault, limits: () => ({ keepLatest: 3, warningBytes: 1024 ** 3, capacityBytes: 2 * 1024 ** 3 }) });
      const backups = captureUpdateBackups({ directory: root, vault, build: from, checkpoint() {} });
      journal = openUpdateMaintenance(root, { vault, clock: () => 1000 });
      const plan = { from, to, bytes: release.bytes, sha256: release.sha256 }, staged = { file, bytes: release.bytes, sha256: release.sha256, release };
      const binding = { history, trust, current, checkpoint() {} };
      const copy = (token, selected = 'valid', extra = {}) => {
        reset(selected);
        return journal.stageBundle(token, { installed: { bundle: installed, team, identity: mode === 'wrong-current' ? to : from },
          history, trust, current, maxBytes: 1024 ** 2, reserveBytes: 1024 ** 2, checkpoint() {}, ...extra }, { run });
      };
      let token = journal.begin(plan); journalToken = token;
      await assert.rejects(copy(token)); assert.equal(journal.read().copy, undefined); assert.equal(copied, 0);
      await journal.bindInstaller(token, staged, binding);
      await assert.rejects(copy(token)); assert.equal(journal.read().copy, undefined); assert.equal(copied, 0);
      journal.bindBackups(token, backups); assert.throws(() => journal.advance(token, 'verified'));
      await assert.rejects(copy({}, 'valid')); await assert.rejects(copy(token, 'wrong-current'));
      assert.equal(journal.read().copy, undefined); assert.equal(copied, 0);
      db = new DatabaseSync(join(root, 'maintenance.sqlite'));
      db.exec("CREATE TRIGGER refuse_copy BEFORE UPDATE ON maintenance_state BEGIN SELECT RAISE(ABORT,'synthetic reservation refusal'); END;");
      await assert.rejects(copy(token)); assert.equal(journal.read().copy, undefined); assert.equal(copied, 0);
      db.exec('DROP TRIGGER refuse_copy'); db.close(); db = undefined;
      const stopped = new AbortController(); stopped.abort();
      await assert.rejects(copy(token, 'valid', { signal: stopped.signal })); assert.equal(journal.read().copy, undefined);
      const receipt = await copy(token), saved = journal.read();
      assert.equal(detached, 1); assert.equal(attached, false); assert.equal(copied, 1);
      assert.deepEqual(saved.copy.receipt, receipt); assert.deepEqual(receipt.identity, to);
      assert.equal((await readFile(join(root, 'maintenance.sqlite'))).includes(Buffer.from(receipt.directory)), false);
      await assert.rejects(copy(token)); assert.equal(copied, 0); assert.deepEqual(journal.read(), saved);
      assert.throws(() => journal.cancel(token)); journal.advance(token, 'verified');
      await rm(receipt.directory, { recursive: true }); journal.cancel(token); assert.equal(journal.clear(), true);
      token = journal.begin(plan); journalToken = token; await journal.bindInstaller(token, staged, binding); journal.bindBackups(token, backups);
      const collision = join(directory, 'candidate-' + journal.read().id); await mkdir(collision, { mode: 0o700 });
      await writeFile(join(collision, 'sentinel'), 'Synthetic preexisting object', { mode: 0o600 });
      await assert.rejects(copy(token)); assert.equal(copied, 0); assert.equal(journal.read().copy.directory, collision);
      assert.equal(await readFile(join(collision, 'sentinel'), 'utf8'), 'Synthetic preexisting object'); assert.throws(() => journal.cancel(token));
      await rm(collision, { recursive: true }); journal.cancel(token);
      token = journal.begin(plan); journalToken = token; await journal.bindInstaller(token, staged, binding); journal.bindBackups(token, backups);
      const changedRelease = { ...release, sequence: 2, gitTree: 'd'.repeat(40) }, changedAttempt = history.begin(trust, current, { manual: true });
      history.complete(changedAttempt.token, Buffer.from(canonicalJSON({ release: changedRelease,
        signature: sign(null, Buffer.from(canonicalJSON(changedRelease)), privateKey).toString('base64') })));
      await assert.rejects(copy(token, 'wrong-target')); assert.equal(copied, 1); assert.equal(detached, 1);
      const wrongTarget = journal.read(); assert.equal(wrongTarget.copy.receipt, undefined);
      assert.throws(() => journal.advance(token, 'verified')); assert.throws(() => journal.cancel(token));
      await rm(wrongTarget.copy.directory, { recursive: true }); journal.cancel(token);
      const nextRelease = { ...release, sequence: 3 }, nextAttempt = history.begin(trust, current, { manual: true });
      history.complete(nextAttempt.token, Buffer.from(canonicalJSON({ release: nextRelease,
        signature: sign(null, Buffer.from(canonicalJSON(nextRelease)), privateKey).toString('base64') })));
      staged.release = nextRelease;
      token = journal.begin(plan); journalToken = token; await journal.bindInstaller(token, staged, binding); journal.bindBackups(token, backups);
      await assert.rejects(copy(token, 'copy')); assert.equal(copied, 1); assert.equal(attached, false);
      const interrupted = journal.read(); assert.equal(interrupted.copy.receipt, undefined);
      assert.equal(interrupted.phase, 'repair-required');
      assert.throws(() => journal.advance(token, 'verified')); assert.throws(() => journal.cancel(token));
      journal.close(); journal = openUpdateMaintenance(root, { vault, clock: () => 1000 });
      assert.deepEqual(journal.read(), interrupted); assert.equal(journal.owned(), false); assert.equal(journal.clear(), false);
      await assert.rejects(copy(token)); assert.equal(copied, 0); assert.throws(() => journal.cancel(token)); assert.throws(() => journal.begin(plan));
      return;
    }
    if (unsafe) {
      for (const selected of ['external-link', 'hardlink']) {
        await assert.rejects(invoke(selected), /^Error: update-bundle-copy-unverified$/);
        assert.equal(attached, false); assert.equal(copied, 0);
      }
      return;
    }
    const receipt = await invoke('valid'); assert.equal(detached, 1); assert.equal(attached, false); assert.equal(copied, 1);
    assert.equal(receipt.bundle, destination); assert.deepEqual(receipt.identity, to); assert.equal(receipt.team, team); assert(Object.isFrozen(receipt));
    assert.equal(await realpath(join(receipt.bundle, 'Contents/Frameworks/Synthetic.framework/Versions/Current')), join(receipt.bundle, 'Contents/Frameworks/Synthetic.framework/Versions/A'));
    const copiedQuarantine = (await runMacUpdateCommand('/usr/bin/xattr', ['-p', 'com.apple.quarantine', receipt.bundle], new AbortController().signal)).stdout.trim().split(';');
    assert(copiedQuarantine.length >= 4); assert.deepEqual(copiedQuarantine.slice(0, 2), quarantine.split(';').slice(0, 2));
    await rm(receipt.directory, { recursive: true });
    for (const selected of ['wrong-current', 'installed-signature', 'source-signature', 'guard', 'overflow']) {
      await assert.rejects(invoke(selected), /^Error: update-bundle-copy-unverified$/);
      assert.equal(attached, false); assert.equal((await readdir(directory)).filter(name => name.startsWith('candidate-')).length, 0);
      assert.equal(copied, 0);
    }
    for (const selected of ['copy', 'tamper', 'stale', 'cancel', 'detach-tamper']) {
      await assert.rejects(invoke(selected), /^Error: update-bundle-copy-recovery-required$/);
      assert.equal(attached, false); const retained = (await readdir(directory)).filter(name => name.startsWith('candidate-'));
      assert.equal(retained.length, 1); assert.equal(copied, 1);
      // This test owns every synthetic root; product recovery deliberately retains them.
      await rm(join(directory, retained[0]), { recursive: true });
    }
    await assert.rejects(invoke('detach'), /^Error: update-bundle-copy-recovery-required$/);
    assert.equal(attached, true); assert((await readdir(directory)).some(name => name.startsWith('candidate-')));
    assert.deepEqual(await readFile(file), bytes); assert.deepEqual(JSON.parse(await readFile(join(installed, 'Contents/Resources/pipeliner-build.json'), 'utf8')), from);
  } finally { db?.close(); journal?.close(); await artifacts?.close(); development?.close(); workspaces?.close(); history?.close(); vault?.close(); await rm(root, { recursive: true }); await assert.rejects(lstat(root), error => error.code === 'ENOENT'); }
}
test('verified image copying preserves native metadata and links, rejects stale trust and returns only after detach', () => checkCopy(false));
test('copy tree guards refuse absolute external aliases and hard-linked files before native copying', () => checkCopy(true));
test('journal records exact copy ownership before effects, binds detached target and fences retained or interrupted resources', () => checkCopy(false, true));
