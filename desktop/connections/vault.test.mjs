import test, { mock } from 'node:test';
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
test('MCP endpoint identities share OS protection without accepting arbitrary vault names or swapping endpoint envelopes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-vault-mcp-'))), first = 'mcp-' + 'a'.repeat(64), second = 'mcp-' + 'b'.repeat(64);
  let vault;
  try {
    vault = await openVault(root, protection); assert.equal(vault.current(first, 0), true);
    const epoch = vault.begin(first); vault.save(first, epoch, { kind: 'mcp-bearer', endpoint: 'https://example.com/mcp', credential: 'synthetic-mcp-secret' });
    assert.equal(readFileSync(join(root, 'connections.sqlite')).includes('synthetic-mcp-secret'), false);
    vault.close(); vault = await openVault(root, protection); assert.equal(vault.get(first).value.credential, 'synthetic-mcp-secret');
    for (const id of ['mcp-short', 'mcp-' + 'x'.repeat(64), 'https://example.com/mcp', '__proto__']) assert.throws(() => vault.get(id), /connection-denied/);
    vault.begin(second); vault.close(); vault = null;
    const db = new DatabaseSync(join(root, 'connections.sqlite'));
    db.prepare('UPDATE connections SET payload=(SELECT payload FROM connections WHERE id=?) WHERE id=?').run(first, second); db.close();
    vault = await openVault(root, protection); assert.throws(() => vault.get(second), /protected-record-invalid/);
    vault.erase(first); assert.equal(vault.current(first, epoch), false); assert.equal(vault.save(first, epoch, {}), false);
  } finally { vault?.close(); rmSync(root, { recursive: true }); }
});

test('host payload encryption binds purpose, repository and record without exposing keys or weakening credential envelopes', async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-payload-test-')));
  let vault;
  const binding={purpose:'conversation',repository:'first',id:'record-1'},value=Buffer.from('private conversation content');
  try {
    vault=await openVault(root,protection);
    const encrypted=vault.sealPayload(binding,value);
    assert.equal(encrypted.includes(value),false);assert.deepEqual(vault.openPayload(binding,encrypted),value);
    for(const replacement of [{...binding,purpose:'log'},{...binding,repository:'second'},{...binding,id:'record-2'}])assert.throws(()=>vault.openPayload(replacement,encrypted),/protected-payload-invalid/);
    const corrupted=Buffer.from(encrypted);corrupted[corrupted.length-1]^=1;assert.throws(()=>vault.openPayload(binding,corrupted),/protected-payload-invalid/);
    assert.throws(()=>vault.sealPayload({...binding,purpose:'credential'},value),/protected-payload-binding/);
    assert.throws(()=>vault.sealPayload({...binding,extra:true},value),/protected-payload-binding/);
    assert.throws(()=>vault.sealPayload(binding,Buffer.alloc(2*1024**2+1)),/protected-payload-limit/);
    vault.close();assert.throws(()=>vault.openPayload(binding,encrypted),/vault-closed/);
    vault=await openVault(root,protection);assert.deepEqual(vault.openPayload(binding,encrypted),value);
    const epoch=vault.begin('ollama');vault.save('ollama',epoch,{credential:'synthetic-only'});
    const db=new DatabaseSync(join(root,'connections.sqlite'),{readOnly:true});const connection=db.prepare('SELECT payload FROM connections WHERE id=?').get('ollama').payload;db.close();
    assert.throws(()=>vault.openPayload(binding,Buffer.from(connection)),/protected-payload-invalid/);assert.equal(vault.get('ollama').value.credential,'synthetic-only');
  }finally{vault?.close();rmSync(root,{recursive:true});}
});

test('exact host credential removal is atomic, covers orphaned MCP records and preserves readable local data', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-vault-uninstall-'))), orphan = 'mcp-' + 'c'.repeat(64);
  const binding = { purpose: 'workspace', repository: 'preserved', id: 'record-1' }, plain = Buffer.from('Preserve local records');
  let vault, db;
  try {
    vault = await openVault(root, protection);
    const encrypted = vault.sealPayload(binding, plain);
    for (const id of ['github', 'ollama', orphan]) vault.save(id, vault.begin(id), { credential: 'synthetic-uninstall-secret-' + id });
    db = new DatabaseSync(join(root, 'connections.sqlite'));
    const wrapped = Buffer.from(db.prepare('SELECT payload FROM vault_key WHERE id=1').get().payload);
    const first = vault.connectionInventory();
    const predicted = vault.previewCredentialRemoval();
    assert.equal(Object.isFrozen(predicted), true); assert.deepEqual(predicted.before, first);
    assert.equal(predicted.after.count, first.count); assert.equal(predicted.after.stored, 0);
    assert.notEqual(predicted.after.sha256, first.sha256); assert.deepEqual(vault.connectionInventory(), first);
    assert.equal(Object.isFrozen(first), true); assert.equal(first.count, 3); assert.equal(first.stored, 3);
    assert.deepEqual(Object.keys(first).sort(), ['count', 'sha256', 'stored']); assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(first).includes('synthetic-uninstall-secret'), false);
    vault.save('github', vault.get('github').epoch, { credential: 'synthetic-uninstall-secret-changed' });
    assert.throws(() => vault.forgetCredentials(first), /credential-removal-unverified/);
    assert.equal(vault.connectionInventory().stored, 3);
    const before = vault.connectionInventory(), expectedAfter = vault.previewCredentialRemoval().after;
    const epochs = new Map(['github', 'ollama', orphan].map(id => [id, vault.get(id).epoch]));
    for (const invalid of [{ ...before, count: 2 }, { ...before, extra: true }, { ...before, sha256: '0'.repeat(64) }, null])
      assert.throws(() => vault.forgetCredentials(invalid), /credential-removal-unverified/);
    let getters = 0;
    assert.throws(() => vault.forgetCredentials({ ...before, get sha256() { getters++; return before.sha256; } }), /credential-removal-unverified/);
    assert.equal(getters, 0); assert.deepEqual(vault.connectionInventory(), before);
    db.exec("CREATE TRIGGER refuse_credential_removal BEFORE UPDATE ON connections WHEN OLD.id='ollama' BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END;");
    assert.throws(() => vault.forgetCredentials(before), /credential-removal-unverified/);
    assert.deepEqual(vault.connectionInventory(), before);
    db.exec('DROP TRIGGER refuse_credential_removal');
    db.exec('CREATE TRIGGER alter_retained_key AFTER UPDATE ON connections BEGIN UPDATE vault_key SET payload=zeroblob(length(payload)) WHERE id=1; END;');
    assert.throws(() => vault.forgetCredentials(before), /credential-removal-unverified/);
    assert.deepEqual(vault.connectionInventory(), before); assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM vault_key WHERE id=1').get().payload), wrapped);
    db.exec('DROP TRIGGER alter_retained_key');
    db.exec('CREATE TRIGGER refuse_generation AFTER UPDATE ON connections WHEN NEW.epoch=OLD.epoch+1 BEGIN UPDATE connections SET epoch=OLD.epoch WHERE id=NEW.id; END;');
    assert.throws(() => vault.forgetCredentials(before), /credential-removal-unverified/); assert.deepEqual(vault.connectionInventory(), before);
    db.exec('DROP TRIGGER refuse_generation');
    const bytes = Buffer.from(db.prepare('SELECT payload FROM connections WHERE id=?').get(orphan).payload), damaged = Buffer.from(bytes);
    damaged[damaged.length - 1] ^= 1; db.prepare('UPDATE connections SET payload=? WHERE id=?').run(damaged, orphan);
    assert.throws(() => vault.connectionInventory(), /credential-inventory-unverified/);
    assert.throws(() => vault.forgetCredentials(before), /credential-removal-unverified/);
    assert.equal(vault.get('github').epoch, epochs.get('github')); assert.equal(vault.get('ollama').epoch, epochs.get('ollama'));
    db.prepare('UPDATE connections SET payload=? WHERE id=?').run(bytes, orphan); assert.deepEqual(vault.connectionInventory(), before);
    const after = vault.forgetCredentials(before); assert.equal(after.count, 3); assert.equal(after.stored, 0); assert.notEqual(after.sha256, before.sha256);
    assert.deepEqual(after, expectedAfter); assert.deepEqual(after, predicted.after);
    for (const [id, epoch] of epochs) {
      assert.deepEqual(vault.get(id), { epoch: epoch + 1, value: null }); assert.equal(vault.current(id, epoch), false);
      assert.equal(vault.save(id, epoch, { credential: 'late secret' }), false);
    }
    assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM vault_key WHERE id=1').get().payload), wrapped);
    assert.deepEqual(vault.openPayload(binding, encrypted), plain);
    assert.throws(() => vault.forgetCredentials(before), /credential-removal-unverified/);
    db.prepare('UPDATE connections SET epoch=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, 'ollama');
    const exhausted = vault.connectionInventory(); assert.throws(() => vault.forgetCredentials(exhausted), /credential-removal-unverified/);
    assert.throws(() => vault.previewCredentialRemoval(), /credential-removal-preview-unverified/);
    assert.deepEqual(vault.connectionInventory(), exhausted); db.prepare('UPDATE connections SET epoch=2 WHERE id=?').run('ollama');
    db.prepare('INSERT INTO connections VALUES(?,?,NULL)').run('foreign-entry', 1);
    assert.throws(() => vault.connectionInventory(), /credential-inventory-unverified/);
    db.prepare('DELETE FROM connections WHERE id=?').run('foreign-entry');
    db.exec('BEGIN');
    for (let i = 0; i < 2046; i++) db.prepare('INSERT INTO connections VALUES(?,?,NULL)').run('mcp-' + i.toString(16).padStart(64, '0'), 1);
    db.exec('COMMIT'); assert.throws(() => vault.connectionInventory(), /credential-inventory-unverified/);
    assert.throws(() => vault.forgetCredentials(after), /credential-removal-unverified/);
    db.prepare('DELETE FROM connections WHERE id NOT IN (?,?,?)').run('github', 'ollama', orphan);
    const large = Array.from({ length: 5 }, (_, i) => 'mcp-' + 'd'.repeat(63) + i);
    for (const id of large) vault.save(id, vault.begin(id), { credential: 'x'.repeat(1750000) });
    assert.throws(() => vault.connectionInventory(), /credential-inventory-unverified/);
    assert.throws(() => vault.forgetCredentials(after), /credential-removal-unverified/);
    assert.equal(vault.get(large[0]).value.credential.length, 1750000);
    for (const id of large) db.prepare('DELETE FROM connections WHERE id=?').run(id);
    db.close(); db = null; vault.close();
    assert.throws(() => vault.connectionInventory(), /vault-closed/);
    vault = await openVault(root, protection); assert.equal(vault.connectionInventory().stored, 0);
    assert.deepEqual(vault.openPayload(binding, encrypted), plain);
    vault.save('github', vault.begin('github'), { credential: 'synthetic-final-rollback-check' });
    db = new DatabaseSync(join(root, 'connections.sqlite'));
    db.exec("CREATE TRIGGER final_refusal BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END;");
    const finalSnapshot = vault.connectionInventory(), exec = DatabaseSync.prototype.exec;
    const rollback = mock.method(DatabaseSync.prototype, 'exec', function (sql) { if (sql === 'ROLLBACK') throw Error('Synthetic rollback refusal'); return exec.call(this, sql); });
    try { assert.throws(() => vault.forgetCredentials(finalSnapshot), /credential-removal-unverified/); } finally { rollback.mock.restore(); }
    assert.throws(() => vault.get('github'), /vault-closed/); assert.throws(() => vault.openPayload(binding, encrypted), /vault-closed/);
    db.exec('DROP TRIGGER final_refusal'); db.close(); db = null;
    vault = await openVault(root, protection); assert.equal(vault.get('github').value.credential, 'synthetic-final-rollback-check');
    assert.deepEqual(vault.openPayload(binding, encrypted), plain);
  } finally { db?.close(); vault?.close(); rmSync(root, { recursive: true }); }
});
