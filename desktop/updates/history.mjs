import { lstatSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { createRecordCodec } from '../privacy/records.mjs';
import { checkUpdateContext, verifyUpdateAvailability } from './manifest.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const time = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

// Host-only history. Privacy restore/deletion cannot reset these source-bound watermarks.
export function openUpdateHistory(directory, { vault, clock = Date.now }) {
  let db;
  try {
    if (typeof clock !== 'function' || realpathSync(directory) !== directory) throw Error();
    const codec = createRecordCodec(vault, 'update'), path = protectedFile(directory, 'updates.sqlite');
    const owner = lstatSync(path), root = lstatSync(directory);
    db = new DatabaseSync(path, { allowExtension: false, timeout: 1000 });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version) || !version && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) throw Error();
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA auto_vacuum=FULL;');
    const size = db.prepare('PRAGMA page_size').get().page_size;
    if (!Number.isInteger(size) || size < 512 || size > 65536
      || db.prepare('PRAGMA max_page_count=' + Math.floor(4 * 1024 ** 2 / size)).get().max_page_count * size > 4 * 1024 ** 2) throw Error();
    if (!version) db.exec('CREATE TABLE update_history(id TEXT PRIMARY KEY,payload BLOB NOT NULL); PRAGMA user_version=1;');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 1) throw Error();
    let closed = false, active = null;
    function ready() {
      if (closed) throw Error(); const current = lstatSync(path), parent = lstatSync(directory), now = clock();
      if (!time(now) || !same(parent, root) || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
        || (parent.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory || !same(current, owner)
        || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o600) throw Error();
      return now;
    }
    function context(trust, current, now) {
      record(trust, ['id', 'key', 'origin', 'path']);
      record(current, ['channel', 'platform', 'architecture', 'version']);
      trust = { ...trust }; current = { ...current, sequence: 0 }; checkUpdateContext(trust, current, now);
      const stream = { source: trust.id, origin: trust.origin, path: trust.path,
        key: hash(trust.key.export({ type: 'spki', format: 'der' })), channel: current.channel, platform: current.platform, architecture: current.architecture };
      return { id: hash(canonicalJSON(stream)), stream, trust, current };
    }
    const identity = id => ({ repository: null, table: 'update_history', key: id });
    function state(bound, now) {
      const row = db.prepare('SELECT payload FROM update_history WHERE id=?').get(bound.id);
      if (!row) return { schemaVersion: 1, stream: bound.stream, sequence: 0, attempt: null, lastAttempt: null, lastCheck: null, envelope: null };
      const value = codec.decode(identity(bound.id), row.payload);
      record(value, ['schemaVersion', 'stream', 'sequence', 'attempt', 'lastAttempt', 'lastCheck', 'envelope']);
      if (value.schemaVersion !== 1 || canonicalJSON(value.stream) !== canonicalJSON(bound.stream) || !time(value.sequence)
        || value.attempt !== null && !uuid(value.attempt) || [value.lastAttempt, value.lastCheck].some(x => x !== null && (!time(x) || x > now))
        || value.attempt !== null && value.lastAttempt === null || value.lastCheck !== null && value.lastAttempt === null
        || !value.sequence && (value.envelope !== null || value.lastCheck !== null)
        || value.sequence && (typeof value.envelope !== 'string' || Buffer.byteLength(value.envelope) > 16384 || value.lastCheck === null)) throw Error();
      if (value.sequence) {
        const result = verifyUpdateAvailability(Buffer.from(value.envelope), { ...bound, current: { ...bound.current, sequence: value.sequence - 1 }, now: value.lastCheck });
        if (result.release.sequence !== value.sequence) throw Error();
      }
      return value;
    }
    function save(bound, value) {
      db.prepare('INSERT INTO update_history VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(bound.id, codec.encode(identity(bound.id), value));
    }
    function transaction(work) {
      const now = ready(); db.exec('BEGIN IMMEDIATE');
      try { const result = work(now); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    function guarded(work) { try { return work(); } catch { throw Error('update-history-unavailable'); } }
    return Object.freeze({
      read(trust, current) { return guarded(() => {
        const now = ready(), bound = context(trust, current, now), value = state(bound, now);
        let availability = null;
        if (value.envelope) {
          const previous = JSON.parse(value.envelope).release;
          if (previous.issuedAt <= now && now < previous.expiresAt)
            availability = verifyUpdateAvailability(Buffer.from(value.envelope), { ...bound, current: { ...bound.current, sequence: value.sequence - 1 }, now });
        }
        return immutable({ sequence: value.sequence, lastAttempt: value.lastAttempt, lastCheck: value.lastCheck, availability });
      }); },
      begin(trust, current, options = {}) { return guarded(() => {
        record(options, [], ['manual']); if (options.manual !== undefined && typeof options.manual !== 'boolean' || active) throw Error();
        const operation = transaction(now => {
          const bound = context(trust, current, now), value = state(bound, now);
          if (!options.manual && value.lastAttempt !== null && now - value.lastAttempt < 86400000) return null;
          if (!db.prepare('SELECT id FROM update_history WHERE id=?').get(bound.id) && db.prepare('SELECT COUNT(*) AS count FROM update_history').get().count >= 64) throw Error();
          const attempt = randomUUID(), token = Object.freeze({}); save(bound, { ...value, attempt, lastAttempt: now });
          return { ...bound, attempt, token, began: now, sequence: value.sequence, retained: value.envelope };
        });
        if (!operation) return null; active = operation;
        return Object.freeze({ token: operation.token, current: immutable({ ...operation.current, sequence: operation.sequence }), retained: operation.retained });
      }); },
      complete(token, bytes) { return guarded(() => {
        const bound = active; if (!bound || token !== bound.token) throw Error();
        const result = transaction(now => {
          const value = state(bound, now);
          if (value.attempt !== bound.attempt || value.sequence !== bound.sequence || now < bound.began || !Buffer.isBuffer(bytes)) throw Error();
          const identical = value.envelope !== null && bytes.equals(Buffer.from(value.envelope));
          const result = verifyUpdateAvailability(bytes, { ...bound, current: { ...bound.current, sequence: identical ? value.sequence - 1 : value.sequence }, now });
          if (identical && result.release.sequence !== value.sequence) throw Error();
          save(bound, { ...value, attempt: null, sequence: result.release.sequence, lastCheck: now, envelope: bytes.toString('utf8') }); return result;
        });
        active = null; return result;
      }); },
      fail(token) { return guarded(() => {
        const bound = active; if (!bound || token !== bound.token) throw Error();
        const cleared = transaction(now => { const value = state(bound, now); if (value.attempt !== bound.attempt) return false; save(bound, { ...value, attempt: null }); return true; });
        active = null; return cleared;
      }); },
      close() { if (!closed) { closed = true; active = null; db.close(); } },
    });
  } catch { db?.close(); throw Error('update-history-unavailable'); }
}
