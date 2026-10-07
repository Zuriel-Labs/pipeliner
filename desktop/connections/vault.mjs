import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, record } from '../core/settings.mjs';

export const connectionIds = Object.freeze(['github', 'github-setup', 'codex', 'ollama']);
const validId = id => { if (!connectionIds.includes(id) && !(typeof id === 'string' && /^mcp-[a-f0-9]{64}$/.test(id))) throw new Error('connection-denied'); };
const limit = 2 * 1024 * 1024;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
function payloadBinding(value) {
  try {
    const text = canonicalJSON(value); record(value, ['purpose', 'repository', 'id']);
    if (!['conversation', 'log', 'audit', 'development', 'workspace', 'migration', 'artifact', 'update'].includes(value.purpose)
      || value.repository !== null && !identifier(value.repository) || !identifier(value.id)) throw new Error();
    return Buffer.from('pipeliner:protected-payload:1:' + text);
  } catch { throw new Error('protected-payload-binding'); }
}

export async function openVault(directory, protection) {
  if (!await protection.available()) throw new Error('secure-storage-unavailable');
  const db = new DatabaseSync(protectedFile(directory, 'connections.sqlite'));
  let key;
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS vault_key(id INTEGER PRIMARY KEY CHECK(id=1),payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL CHECK(epoch>0),payload BLOB);');
    let wrapped = db.prepare('SELECT payload FROM vault_key WHERE id=1').get()?.payload;
    if (!wrapped) {
      const fresh = randomBytes(32);
      try { db.prepare('INSERT OR IGNORE INTO vault_key VALUES(1,?)').run(await protection.encrypt(fresh.toString('base64'))); }
      finally { fresh.fill(0); }
      wrapped = db.prepare('SELECT payload FROM vault_key WHERE id=1').get().payload;
    }
    const unwrapped = await protection.decrypt(Buffer.from(wrapped));
    if (typeof unwrapped.result !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(unwrapped.result)) throw new Error('protected-record-invalid');
    key = Buffer.from(unwrapped.result, 'base64');
    if (key.length !== 32) throw new Error('protected-record-invalid');
    if (unwrapped.shouldReEncrypt) db.prepare('UPDATE vault_key SET payload=? WHERE id=1 AND payload=?')
      .run(await protection.encrypt(unwrapped.result), wrapped);
    const retainedKey = Buffer.from(db.prepare('SELECT payload FROM vault_key WHERE id=1').get().payload);
    let closed = false;
    const ready = () => { if (closed) throw new Error('vault-closed'); };
    const seal = (id, epoch, value) => {
      const plain = JSON.stringify({ version: 1, id, epoch, value });
      if (Buffer.byteLength(plain) > limit) throw new Error('protected-record-too-large');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(`${id}:${epoch}:1`));
      return Buffer.concat([nonce, cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    };
    function get(id) {
      ready(); validId(id);
      const row = db.prepare('SELECT epoch,payload FROM connections WHERE id=?').get(id);
      if (!row) return { epoch: 0, value: null };
      if (!Number.isSafeInteger(row.epoch) || row.epoch < 1) throw new Error('protected-record-invalid');
      if (row.payload === null) return { epoch: row.epoch, value: null };
      try {
        const bytes = Buffer.from(row.payload);
        if (bytes.length < 28 || bytes.length > limit + 28) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${id}:${row.epoch}:1`)); decipher.setAuthTag(bytes.subarray(-16));
        const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'));
        if (data.version !== 1 || data.id !== id || data.epoch !== row.epoch) throw new Error();
        return { epoch: row.epoch, value: data.value };
      } catch { throw new Error('protected-record-invalid'); }
    }
    function begin(id, erase = false) {
      const before = get(id), epoch = before.epoch + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('connection-generation-exhausted');
      const payload = erase || before.value === null ? null : seal(id, epoch, before.value);
      if (before.epoch === 0) db.prepare('INSERT INTO connections VALUES(?,?,?)').run(id, epoch, payload);
      else if (db.prepare('UPDATE connections SET epoch=?,payload=? WHERE id=? AND epoch=?').run(epoch, payload, id, before.epoch).changes !== 1) throw new Error('connection-changed');
      return epoch;
    }
    function inventory() {
      if (db.prepare('SELECT length(payload) AS bytes FROM vault_key WHERE id=1').get()?.bytes !== retainedKey.length
        || !Buffer.from(db.prepare('SELECT payload FROM vault_key WHERE id=1').get().payload).equals(retainedKey)) throw Error();
      const hash = createHash('sha256').update('pipeliner:credential-inventory:1\n').update(retainedKey);
      let count = 0, stored = 0, bytes = 0;
      // ponytail: 2,048 rows and 8 MiB of ciphertext; qualify larger inventories before raising these ceilings.
      for (const row of db.prepare('SELECT id,epoch,length(payload) AS bytes FROM connections ORDER BY id LIMIT 2049').iterate()) {
        if (++count > 2048 || !Number.isSafeInteger(row.epoch) || row.epoch < 1) throw Error(); validId(row.id);
        if (row.bytes !== null) {
          if (!Number.isSafeInteger(row.bytes) || row.bytes < 28 || row.bytes > limit + 28 || (bytes += row.bytes) > 4 * limit) throw Error();
          get(row.id); stored++;
        }
        hash.update(canonicalJSON(row) + '\n');
        if (row.bytes !== null) hash.update(Buffer.from(db.prepare('SELECT payload FROM connections WHERE id=?').get(row.id).payload));
      }
      return Object.freeze({ count, stored, sha256: hash.digest('hex') });
    }
    function credentialTransaction(exclusive, work, failure) {
      ready(); let started = false;
      try {
        db.exec(exclusive ? 'BEGIN IMMEDIATE' : 'BEGIN'); started = true;
        const result = work(); db.exec('COMMIT'); started = false; return result;
      } catch {
        if (started) try { db.exec('ROLLBACK'); } catch {
          closed = true; key.fill(0); retainedKey.fill(0);
          try { db.close(); } catch { /* Storage remains unavailable; no completion is reported. */ }
        }
        throw Error(failure);
      }
    }
    return Object.freeze({ get, begin,
      connectionInventory: () => credentialTransaction(false, inventory, 'credential-inventory-unverified'),
      // Host-only uninstall primitive. The coordinator must first settle leases/logout under its durable idle fence.
      forgetCredentials(expected) {
        return credentialTransaction(true, () => {
          canonicalJSON(expected); record(expected, ['count', 'stored', 'sha256']); const before = inventory();
          if (canonicalJSON(expected) !== canonicalJSON(before)) throw Error();
          const epochs = db.prepare('SELECT id,epoch FROM connections ORDER BY id').all();
          if (epochs.some(row => !Number.isSafeInteger(row.epoch + 1))) throw Error();
          if (db.prepare('UPDATE connections SET epoch=epoch+1,payload=NULL').run().changes !== before.count) throw Error();
          const after = inventory(); if (after.count !== before.count || after.stored !== 0) throw Error();
          const current = db.prepare('SELECT epoch,payload IS NOT NULL AS stored FROM connections WHERE id=?');
          for (const row of epochs) { const saved = current.get(row.id); if (saved?.epoch !== row.epoch + 1 || saved.stored !== 0) throw Error(); }
          return after;
        }, 'credential-removal-unverified');
      },
      sealPayload(binding, bytes) {
        ready(); const aad = payloadBinding(binding);
        if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw new Error('protected-payload-limit');
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad);
        return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
      },
      openPayload(binding, bytes) {
        ready(); const aad = payloadBinding(binding);
        try {
          if (!Buffer.isBuffer(bytes) || bytes.length < 28 || bytes.length > limit + 28) throw new Error();
          const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
          decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(-16));
          return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
        } catch { throw new Error('protected-payload-invalid'); }
      },
      current(id, epoch) { ready(); validId(id); return (db.prepare('SELECT epoch FROM connections WHERE id=?').get(id)?.epoch ?? 0) === epoch; },
      save(id, epoch, value) { ready(); validId(id); return db.prepare('UPDATE connections SET payload=? WHERE id=? AND epoch=?').run(seal(id, epoch, value), id, epoch).changes === 1; },
      erase: id => begin(id, true),
      close() { if (!closed) { closed = true; db.close(); key.fill(0); retainedKey.fill(0); } },
    });
  } catch { db.close(); key?.fill(0); throw new Error('secure-storage-unavailable'); }
}
