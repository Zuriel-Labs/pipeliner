import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { protectedFile } from '../core/storage.mjs';

export const connectionIds = Object.freeze(['github', 'github-setup', 'codex', 'ollama']);
const validId = id => { if (!connectionIds.includes(id) && !(typeof id === 'string' && /^mcp-[a-f0-9]{64}$/.test(id))) throw new Error('connection-denied'); };
const limit = 2 * 1024 * 1024;

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
    return Object.freeze({ get, begin,
      current(id, epoch) { ready(); validId(id); return (db.prepare('SELECT epoch FROM connections WHERE id=?').get(id)?.epoch ?? 0) === epoch; },
      save(id, epoch, value) { ready(); validId(id); return db.prepare('UPDATE connections SET payload=? WHERE id=? AND epoch=?').run(seal(id, epoch, value), id, epoch).changes === 1; },
      erase: id => begin(id, true),
      close() { if (!closed) { closed = true; db.close(); key.fill(0); } },
    });
  } catch { db.close(); key?.fill(0); throw new Error('secure-storage-unavailable'); }
}
