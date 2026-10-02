import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openVault } from './vault.mjs';

// Synthetic wrapper only. The native suite independently exercises actual safeStorage.
const protection = { available: async () => true,
  encrypt: async value => Buffer.from(value.split('').reverse().join('')),
  decrypt: async value => ({ result: value.toString().split('').reverse().join(''), shouldReEncrypt: false }) };
test('encrypted restart, corruption/swap rejection and a durable disconnect fence', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-vault-test-'))); chmodSync(root, 0o700);
  let vault;
  try {
    vault = await openVault(root, protection);
    const first = vault.begin('ollama');
    assert.equal(vault.save('ollama', first, { credential: 'synthetic-secret-must-not-appear' }), true);
    assert.equal(readFileSync(join(root, 'connections.sqlite')).includes('synthetic-secret-must-not-appear'), false);
    vault.close(); vault = await openVault(root, protection);
    assert.equal(vault.get('ollama').value.credential, 'synthetic-secret-must-not-appear');
    const cancelled = vault.begin('ollama'); vault.erase('ollama');
    assert.equal(vault.save('ollama', cancelled, { credential: 'late-credential' }), false);
    assert.equal(vault.get('ollama').value, null);
    const next = vault.begin('codex'); vault.save('codex', next, { account: 'synthetic' }); vault.close(); vault = null;
    const db = new DatabaseSync(join(root, 'connections.sqlite'));
    const bytes = db.prepare('SELECT payload FROM connections WHERE id=?').get('codex').payload;
    db.prepare('UPDATE connections SET payload=? WHERE id=?').run(bytes, 'ollama'); db.close();
    vault = await openVault(root, protection);
    assert.throws(() => vault.get('ollama'), /protected-record-invalid/);
    assert.equal(vault.get('codex').value.account, 'synthetic');
    vault.close(); vault = null;
    const damaged = new DatabaseSync(join(root, 'connections.sqlite'));
    const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1;
    damaged.prepare('UPDATE connections SET payload=? WHERE id=?').run(corrupted, 'codex'); damaged.close();
    vault = await openVault(root, protection); assert.throws(() => vault.get('codex'), /protected-record-invalid/);
  } finally { vault?.close(); rmSync(root, { recursive: true, force: true }); }
});
test('unavailable OS protection never creates credential storage', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-vault-unavailable-'))); chmodSync(root, 0o700);
  try { await assert.rejects(openVault(root, { ...protection, available: async () => false }), /secure-storage-unavailable/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
