import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, chmodSync, symlinkSync, unlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openVault } from '../connections/vault.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openDevelopmentStore } from '../development/state.mjs';
import { openArtifactStore } from '../delivery/artifacts.mjs';
import { verifyProtectedBackup, materializeProtectedBackup } from '../privacy/backup.mjs';
import { captureUpdateBackups } from './backup.mjs';

test('update capture seals current compatible stores under real read locks and preserves authority on refusal', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-update-backup-')));
  const build = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40),
    version: '0.1.0', platform: 'darwin', architecture: 'arm64' };
  const stores = ['workspaces', 'development', 'artifacts']; let vault, workspaces, development, artifacts, writer;
  try {
    // Authenticated installation encryption is real; only the OS wrapping of its key is synthetic.
    vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text),
      decrypt: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) });
    workspaces = openWorkspaceStore(root, { vault }); workspaces.saveDraft({ id: 'synthetic', text: 'private fixture' });
    development = openDevelopmentStore(root, { vault });
    artifacts = await openArtifactStore(root, { vault, limits: () => ({ keepLatest: 3, warningBytes: 1024 ** 3, capacityBytes: 2 * 1024 ** 3 }) });
    const authority = join(root, 'unrelated-authority'), bytes = Buffer.from('untouched'); writeFileSync(authority, bytes, { mode: 0o600 });
    const originals = Object.fromEntries(stores.map(store => [store, readFileSync(join(root, store + '.sqlite'))]));
    const archives = () => readdirSync(root).filter(name => name.endsWith('.pipeliner-backup'));
    let blocked = false;
    writer = new DatabaseSync(join(root, 'workspaces.sqlite'), { timeout: 0 });
    const captured = captureUpdateBackups({ directory: root, vault, build, checkpoint() {
      if (!blocked && archives().length) { assert.throws(() => writer.exec('PRAGMA user_version=6'), /locked/); blocked = true; }
    } });
    assert.equal(blocked, true); assert(Object.isFrozen(captured)); assert.deepEqual(captured.build, build);
    assert.deepEqual(captured.databases.map(value => [value.store, value.schemaVersion]), [['workspaces', 5], ['development', 2], ['artifacts', 2]]);
    assert.equal(archives().length, 3);
    for (const receipt of captured.databases) {
      assert.deepEqual(verifyProtectedBackup(receipt.path, { vault, store: receipt.store, version: receipt.schemaVersion }), receipt);
      assert.equal(readFileSync(receipt.path).includes(Buffer.from('private fixture')), false);
      assert.deepEqual(readFileSync(join(root, receipt.store + '.sqlite')), originals[receipt.store]);
    }
    assert.deepEqual(readFileSync(authority), bytes);
    const recovery = realpathSync(mkdtempSync(join(root, 'recovery-'))), restored = [];
    for (const receipt of captured.databases) {
      const value = materializeProtectedBackup(receipt.path, { directory: recovery, vault, store: receipt.store, version: receipt.schemaVersion, checkpoint() {} });
      assert.equal(value.sha256, receipt.sourceHash); assert.equal(value.bytes, receipt.sourceBytes);
      assert.deepEqual(readFileSync(value.destination), originals[receipt.store]); restored.push(value);
    }
    const recoveredWorkspaces = openWorkspaceStore(recovery, { vault }), recoveredDevelopment = openDevelopmentStore(recovery, { vault });
    const recoveredArtifacts = await openArtifactStore(recovery, { vault, limits: () => ({ keepLatest: 3, warningBytes: 1024 ** 3, capacityBytes: 2 * 1024 ** 3 }) });
    try { assert.deepEqual(recoveredWorkspaces.draft(), { id: 'synthetic', text: 'private fixture' }); assert.equal(recoveredArtifacts.inventory('synthetic').items.length, 0); }
    finally { await recoveredArtifacts.close(); recoveredDevelopment.close(); recoveredWorkspaces.close(); }
    const first = captured.databases[0], preserved = readFileSync(restored[0].destination);
    assert.throws(() => materializeProtectedBackup(first.path, { directory: recovery, vault, store: first.store, version: first.schemaVersion, checkpoint() {} }));
    assert.deepEqual(readFileSync(restored[0].destination), preserved);
    const refused = realpathSync(mkdtempSync(join(root, 'refused-recovery-'))), archive = readFileSync(first.path), corrupt = Buffer.from(archive);
    corrupt[corrupt.length - 1] ^= 1; writeFileSync(first.path, corrupt);
    assert.throws(() => materializeProtectedBackup(first.path, { directory: refused, vault, store: first.store, version: first.schemaVersion }), /protected-backup-materialization-failed/);
    assert.deepEqual(readdirSync(refused), []); writeFileSync(first.path, archive);
    const interrupted = new AbortController(); let partial = false;
    assert.throws(() => materializeProtectedBackup(first.path, { directory: refused, vault, store: first.store, version: first.schemaVersion,
      signal: interrupted.signal, checkpoint() {
        const copy = join(refused, 'workspaces.sqlite');
        if (existsSync(copy) && readFileSync(copy).length) { partial = true; interrupted.abort(); }
      } }), /protected-backup-materialization-failed/);
    assert.equal(partial, true); assert.deepEqual(readdirSync(refused), []);
    assert.deepEqual(readFileSync(first.path), archive);
    const altered = realpathSync(mkdtempSync(join(root, 'altered-recovery-'))), output = join(altered, 'workspaces.sqlite'); let alteredOutput = false;
    assert.throws(() => materializeProtectedBackup(first.path, { directory: altered, vault, store: first.store, version: first.schemaVersion, checkpoint() {
      if (!alteredOutput && existsSync(output) && readFileSync(output).length) { appendFileSync(output, 'altered'); alteredOutput = true; }
    } }), /protected-backup-recovery-required/);
    assert.equal(alteredOutput, true); assert.equal(existsSync(output), true);
    // A completed capture releases every SQLite read transaction.
    writer.exec('PRAGMA user_version=6'); const changed = readFileSync(join(root, 'workspaces.sqlite'));
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build, checkpoint() {} }), /update-backup-unverified/);
    assert.deepEqual(readFileSync(join(root, 'workspaces.sqlite')), changed); assert.equal(archives().length, 3);
    writer.exec('PRAGMA user_version=5');
    const file = join(root, 'artifacts.sqlite'); chmodSync(file, 0o640);
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build, checkpoint() {} }));
    assert.equal(archives().length, 3); chmodSync(file, 0o600);
    const cancelled = new AbortController(); let checks = 0;
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build, signal: cancelled.signal,
      checkpoint() { checks++; if (archives().length > 3) cancelled.abort(); } }), /update-backup-unverified/);
    assert(checks > 0); assert.equal(archives().length, 3); writer.exec('BEGIN EXCLUSIVE; ROLLBACK;');
    const stale = new AbortController(); stale.abort();
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build, signal: stale.signal, checkpoint() {} }));
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build: { ...build, architecture: 'x64' }, checkpoint() {} }));
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build, checkpoint() { throw Error('stale admission'); } }));
    assert.equal(archives().length, 3); assert.deepEqual(readFileSync(authority), bytes);
    const sidecar = join(root, 'workspaces.sqlite-journal'); symlinkSync(join(root, 'absent'), sidecar);
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build, checkpoint() {} }));
    assert.equal(archives().length, 3); unlinkSync(sidecar);
    // Non-SQLite mutation by the owning account is detected, preserved, and never accepted as a capture.
    const source = join(root, 'workspaces.sqlite'), beforeMutation = readFileSync(source); let mutated = false;
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build, checkpoint() {
      if (!mutated && archives().length > 3) { mutated = true; appendFileSync(source, Buffer.from('synthetic alteration')); }
    } }));
    assert.equal(mutated, true); assert.deepEqual(readFileSync(source), Buffer.concat([beforeMutation, Buffer.from('synthetic alteration')]));
    assert.equal(archives().length, 3); writeFileSync(source, beforeMutation);
    // A later failure retains a previously completed encrypted archive, without a complete set receipt.
    const beforeLate = Object.fromEntries(stores.map(store => [store, readFileSync(join(root, store + '.sqlite'))]));
    assert.throws(() => captureUpdateBackups({ directory: root, vault, build, checkpoint() {
      if (archives().length > 4) throw Error('synthetic late refusal');
    } }));
    assert.equal(archives().length, 4); writer.exec('BEGIN EXCLUSIVE; ROLLBACK;');
    for (const store of stores) assert.deepEqual(readFileSync(join(root, store + '.sqlite')), beforeLate[store]);
  } finally {
    writer?.close(); await artifacts?.close(); development?.close(); workspaces?.close(); vault?.close();
    rmSync(root, { recursive: true }); assert.equal(existsSync(root), false);
  }
});
