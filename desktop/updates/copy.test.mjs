import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, link, rename } from 'node:fs/promises';
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
import { dataCompatibilityForBuild } from '../package/build.mjs';

async function checkCopy(unsafe, journaled = false, replacement = null, recovery = null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-54-update-copy-'))), directory = join(root, 'updates');
  await mkdir(directory, { mode: 0o700 });
  const installed = join(root, 'Pipeliner.app'), team = 'ABCDEF1234', helper = join(installed, 'Contents/Resources/helpers/update-exchange');
  const from = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'a'.repeat(40), version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
  const to = { ...from, version: '0.2.0', sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  async function fixture(bundle, identity) {
    await mkdir(join(bundle, 'Contents/Resources'), { recursive: true, mode: 0o700 });
    await mkdir(join(bundle, 'Contents/MacOS'), { mode: 0o700 });
    await writeFile(join(bundle, 'Contents/Resources/pipeliner-build.json'), canonicalJSON(identity) + '\n', { mode: 0o600 });
    await writeFile(join(bundle, 'Contents/Resources/pipeliner-data.json'), canonicalJSON(dataCompatibilityForBuild(identity, '0.160.0')) + '\n', { mode: 0o600 });
    await writeFile(join(bundle, 'Contents/Info.plist'), 'Synthetic plist; never native verified.', { mode: 0o600 });
    await writeFile(join(bundle, 'Contents/MacOS/Pipeliner'), 'Synthetic executable; never launched.', { mode: 0o700 });
    await mkdir(join(bundle, 'Contents/Resources/helpers'), { mode: 0o700 });
    await writeFile(join(bundle, 'Contents/Resources/helpers/update-exchange'), 'Synthetic helper; never executed.', { mode: 0o700 });
  }
  await fixture(installed, from);
  const bytes = Buffer.from('Synthetic image; never attached.'), file = join(directory, 'update-' + randomUUID() + '.dmg');
  await writeFile(file, bytes, { mode: 0o600 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trust = { id: 'synthetic-publisher', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const current = { channel: 'stable', version: from.version, platform: from.platform, architecture: from.architecture };
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, ...current, version: to.version, sequence: 1,
    issuedAt: 900, expiresAt: 2000, url: trust.origin + trust.path + 'Pipeliner.dmg', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), sourceCommit: to.sourceCommit, gitTree: to.gitTree };
  let mode, mount, attached, copied, detached, authorized, controller, destination, vault, history, journal, journalToken, workspaces, development, artifacts, db, custodyFailure, exchanges = 0;
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
      if (args[0] !== '--verify-parent') {
        const saved = journal.read(), original = await lstat(installed, { bigint: true });
        assert.equal(saved.phase, 'replacing'); assert.deepEqual(saved.replacement, { device: original.dev.toString(), inode: original.ino.toString() });
        assert.deepEqual(args, [root, saved.copy.directory, saved.replacement.device, saved.replacement.inode,
          saved.copy.receipt.device, saved.copy.receipt.inode]); exchanges++;
        if (mode === 'swap-refusal') throw Error('Synthetic before-effect helper refusal');
        // Only a namespace simulation; the product uses one native atomic exchange, never these renames.
        const temporary = join(saved.copy.directory, 'synthetic-previous.app');
        await rename(installed, temporary); await rename(saved.copy.receipt.bundle, installed); await rename(temporary, saved.copy.receipt.bundle);
        if (mode === 'swap-tamper') await writeFile(join(installed, 'Contents/Resources/pipeliner-build.json'), canonicalJSON({ ...to, gitTree: 'd'.repeat(40) }) + '\n');
        if (mode === 'swap-support-tamper') {
          const path = join(installed, 'Contents/Resources/pipeliner-data.json'), support = JSON.parse(await readFile(path, 'utf8'));
          support.formats.databases.workspaces++; await writeFile(path, canonicalJSON(support) + '\n');
        }
        if (mode === 'swap-stale') journal.advance(journalToken, 'repair-required');
        if (mode === 'swap-journal-refusal') {
          db = new DatabaseSync(join(root, 'maintenance.sqlite'));
          db.exec("CREATE TRIGGER refuse_completion BEFORE UPDATE ON maintenance_state BEGIN SELECT RAISE(ABORT,'synthetic completion refusal'); END;");
        }
        return { stdout: 'pipeliner-update-exchanged\n', stderr: '' };
      }
      assert.equal(args[0], '--verify-parent'); const info = await lstat(args[1], { bigint: true });
      assert.deepEqual(args.slice(2), [info.dev.toString(), info.ino.toString()]);
      if (mode === 'guard' || mode === 'swap-parent') throw Error('Synthetic ownership refusal');
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
      if (args.includes('--verify') && (['installed-signature', 'relaunch-signature'].includes(mode) && bundle === installed || mode === 'source-signature' && mount && bundle === join(mount, 'Pipeliner.app'))) throw Error('Synthetic signature refusal');
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
      workspaces.register({ id: 'repo-one', repositoryId: 'repository-one', slug: 'synthetic/one', localKey: '1:2', path: root, project: { id: 'project-one' } });
      workspaces.select('repo-one'); workspaces.saveIssueContext('repo-one', { selected: '54', source: 'synthetic-pm-selection' });
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
      if (replacement) {
        journalToken = journal.begin(plan); await journal.bindInstaller(journalToken, staged, binding); journal.bindBackups(journalToken, backups);
        const receipt = await copy(journalToken); journal.advance(journalToken, 'verified');
        assert.throws(() => journal.advance(journalToken, 'replacing'));
        const before = journal.read(); mode = replacement;
        const replace = options => journal.replaceBundle(journalToken, { ...binding, signal: controller.signal, ...options }, { run });
        if (['pre-tamper', 'swap-parent', 'swap-cancel', 'missing-source-support', 'missing-target-support', 'changed-target-support', 'changed-target-provider'].includes(replacement)) {
          if (replacement === 'pre-tamper') await writeFile(join(receipt.bundle, 'Contents/Resources/pipeliner-build.json'), canonicalJSON({ ...to, gitTree: 'd'.repeat(40) }) + '\n');
          if (replacement === 'swap-cancel') controller.abort();
          const supportPath = join(receipt.bundle, 'Contents/Resources/pipeliner-data.json');
          if (replacement === 'missing-source-support') await rm(join(installed, 'Contents/Resources/pipeliner-data.json'));
          if (replacement === 'missing-target-support') await rm(supportPath);
          if (['changed-target-support', 'changed-target-provider'].includes(replacement)) {
            const support = JSON.parse(await readFile(supportPath, 'utf8'));
            if (replacement === 'changed-target-support') support.formats.databases.development++;
            else support.codexCLI = '0.161.0';
            await writeFile(supportPath, canonicalJSON(support) + '\n');
          }
          await assert.rejects(replace()); assert.equal(exchanges, 0); assert.deepEqual(journal.read(), before);
        } else if (replacement === 'valid-swap') {
          const result = await replace(); assert.deepEqual(result, { installed, rollback: receipt.bundle, identity: to });
          const saved = journal.read(); assert.equal(saved.phase, 'relaunching'); assert.equal(exchanges, 1);
          assert.equal((await lstat(installed, { bigint: true })).ino.toString(), receipt.inode);
          assert.equal((await lstat(receipt.bundle, { bigint: true })).ino.toString(), saved.replacement.inode);
          assert.deepEqual(JSON.parse(await readFile(join(installed, 'Contents/Resources/pipeliner-build.json'), 'utf8')), to);
          assert.deepEqual(JSON.parse(await readFile(join(receipt.bundle, 'Contents/Resources/pipeliner-build.json'), 'utf8')), from);
          assert.throws(() => journal.cancel(journalToken)); await assert.rejects(replace()); assert.equal(exchanges, 1);
        } else {
          await assert.rejects(replace()); assert.equal(exchanges, 1); assert.equal(journal.read().phase, replacement === 'swap-journal-refusal' ? 'replacing' : 'repair-required');
          assert.throws(() => journal.cancel(journalToken)); await assert.rejects(replace()); assert.equal(exchanges, 1);
          assert.equal((await lstat(installed)).isDirectory(), true); assert.equal((await lstat(receipt.bundle)).isDirectory(), true);
        }
        const pending = journal.read(); journal.close(); journal = openUpdateMaintenance(root, { vault, clock: () => 1000 });
        assert.deepEqual(journal.read(), pending); assert.equal(journal.owned(), false); assert.equal(journal.clear(), false);
        if (recovery) {
          workspaces.close(); workspaces = undefined; development.close(); development = undefined; await artifacts.close(); artifacts = undefined;
          if (db) { db.exec('DROP TRIGGER refuse_completion'); db.close(); db = undefined; }
          const sourceFiles = ['workspaces', 'development', 'artifacts'].map(name => join(root, name + '.sqlite'));
          const dataDigest = file => {
            const data = new DatabaseSync(file, { readOnly: true, allowExtension: false });
            try {
              const schema = data.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
              const rows = schema.filter(row => row.type === 'table').map(row => [row.name,
                data.prepare('SELECT * FROM "' + row.name.replaceAll('"', '""') + '" ORDER BY rowid').all()]);
              return createHash('sha256').update(JSON.stringify({ version: data.prepare('PRAGMA user_version').get(), schema, rows })).digest('hex');
            } finally { data.close(); }
          };
          const beforeData = sourceFiles.map(dataDigest);
          assert.deepEqual(journal.completed(), []);
          const action = () => journal.finishRelaunch({ running: { bundle: installed, identity: recovery === 'wrong-build' ? from : to },
            checkpoint() { if (recovery === 'lost-checkpoint') throw Error('Synthetic startup cancellation'); }, signal: controller.signal }, { run });
          let getters = 0;
          await assert.rejects(journal.finishRelaunch({ get running() { getters++; throw Error(); }, checkpoint() {}, signal: controller.signal }, { run }));
          assert.equal(getters, 0); assert.deepEqual(journal.read(), pending);
          mode = recovery;
          if (recovery === 'cancel') controller.abort();
          if (recovery === 'changed-bundle') {
            const moved = join(root, 'synthetic-moved.app'); await rename(installed, moved); await fixture(installed, to);
          }
          if (recovery === 'missing-data') await rename(sourceFiles[0], sourceFiles[0] + '.saved');
          if (recovery === 'future-data') { db = new DatabaseSync(sourceFiles[1]); db.exec('PRAGMA user_version=3'); db.close(); db = undefined; }
          if (recovery === 'missing-support') await rm(join(installed, 'Contents/Resources/pipeliner-data.json'));
          if (['changed-support', 'changed-provider'].includes(recovery)) {
            const path = join(installed, 'Contents/Resources/pipeliner-data.json'), support = JSON.parse(await readFile(path, 'utf8'));
            if (recovery === 'changed-support') support.formats.protectedPayload++;
            else support.codexCLI = '0.161.0';
            await writeFile(path, canonicalJSON(support) + '\n');
          }
          if (recovery === 'journal-refusal') { db = new DatabaseSync(join(root, 'maintenance.sqlite')); db.exec("CREATE TRIGGER refuse_finish BEFORE UPDATE ON maintenance_state BEGIN SELECT RAISE(ABORT,'synthetic finish refusal'); END;"); }
          if (recovery === 'custody-refusal') {
            const prepare = DatabaseSync.prototype.prepare;
            custodyFailure = mock.method(DatabaseSync.prototype, 'prepare', function(sql, ...args) {
              if (sql.startsWith('INSERT INTO maintenance_completed ')) throw Error('Synthetic custody insert refusal');
              return Reflect.apply(prepare, this, [sql, ...args]);
            });
          }
          if (['valid-relaunch', 'uncertain-relaunch'].includes(recovery)) {
            await action(); assert.equal(journal.clear(), true); assert.equal(journal.read(), null); assert.equal(journal.owned(), false);
            await assert.rejects(action()); assert.throws(() => journal.advance(journalToken, 'staged'));
            assert.deepEqual(sourceFiles.map(dataDigest), beforeData);
            const completed = journal.completed(); assert.deepEqual(completed, [{ intent: pending, completedAt: 1000 }]); assert(Object.isFrozen(completed));
            assert.equal((await readFile(join(root, 'maintenance.sqlite'))).includes(Buffer.from(receipt.directory)), false);
            journal.close(); journal = openUpdateMaintenance(root, { vault, clock: () => 1000 });
            assert.deepEqual(journal.completed(), completed); assert.equal(journal.clear(), true);
            db = new DatabaseSync(join(root, 'maintenance.sqlite'));
            assert.throws(() => db.exec('DELETE FROM maintenance_completed'), /Immutable/);
            assert.throws(() => db.exec('UPDATE maintenance_completed SET clock=clock+1'), /Immutable/);
            const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='immutable_maintenance_completed_update'").get().sql;
            db.exec('DROP TRIGGER immutable_maintenance_completed_update');
            const archived = db.prepare('SELECT payload FROM maintenance_completed WHERE id=?').get(pending.id), changed = Buffer.from(archived.payload); changed[changed.length - 1] ^= 1;
            db.prepare('UPDATE maintenance_completed SET payload=? WHERE id=?').run(changed, pending.id);
            db.exec(trigger);
            assert.throws(() => journal.completed()); assert.throws(() => journal.begin(plan));
            assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM maintenance_completed WHERE id=?').get(pending.id).payload), changed);
          } else {
            await assert.rejects(action()); assert.deepEqual(journal.read(), pending); assert.equal(journal.clear(), false); assert.deepEqual(journal.completed(), []);
            if (['missing-support', 'changed-support', 'changed-provider'].includes(recovery)) assert.deepEqual(sourceFiles.map(dataDigest), beforeData);
            if (custodyFailure) assert.equal(custodyFailure.mock.calls.filter(call => call.arguments[0].startsWith('INSERT INTO maintenance_completed ') && call.error?.message === 'Synthetic custody insert refusal').length, 1);
          }
          assert.equal(exchanges, 1); assert.equal((await lstat(receipt.bundle)).isDirectory(), true);
        }
        return;
      }
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
  } finally { custodyFailure?.mock.restore(); db?.close(); journal?.close(); await artifacts?.close(); development?.close(); workspaces?.close(); history?.close(); vault?.close(); await rm(root, { recursive: true }); await assert.rejects(lstat(root), error => error.code === 'ENOENT'); }
}
test('verified image copying preserves native metadata and links, rejects stale trust and returns only after detach', () => checkCopy(false));
test('copy tree guards refuse absolute external aliases and hard-linked files before native copying', () => checkCopy(true));
test('journal records exact copy ownership before effects, binds detached target and fences retained or interrupted resources', () => checkCopy(false, true));
test('replacement coordinator persists effect identities, verifies both namespace bindings and retains uncertain outcomes without retry', async () => {
  for (const mode of ['pre-tamper', 'swap-parent', 'swap-cancel', 'missing-source-support', 'missing-target-support', 'changed-target-support', 'changed-target-provider', 'valid-swap', 'swap-refusal', 'swap-tamper', 'swap-support-tamper', 'swap-stale', 'swap-journal-refusal']) await checkCopy(false, true, mode);
});

test('startup reconciliation requires the exact exchanged target and compatible protected data without replay', async () => {
  for (const recovery of ['valid-relaunch', 'wrong-build', 'relaunch-signature', 'changed-bundle', 'missing-data', 'future-data', 'missing-support', 'changed-support', 'changed-provider', 'cancel', 'lost-checkpoint', 'journal-refusal', 'custody-refusal'])
    await checkCopy(false, true, 'valid-swap', recovery);
  await checkCopy(false, true, 'swap-journal-refusal', 'uncertain-relaunch');
});
