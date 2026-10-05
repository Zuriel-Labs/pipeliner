import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, record } from '../core/settings.mjs';

const categories = Object.freeze(['conversation', 'log', 'audit']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const repository = value => value === null || identifier(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const defaults = Object.freeze({ conversationDays: 90, logDays: 30, auditDays: 365, runLogBytes: 50 * 1024 ** 2, totalLogBytes: 500 * 1024 ** 2 });
const hash = value => createHash('sha256').update(value).digest('hex');
const metadata = row => ({ version: 1, id: row.id, repository: row.repository, category: row.category,
  runId: row.run_id, createdAt: row.created_at, completedAt: row.completed_at });
const binding = row => ({ purpose: row.category, repository: row.repository, id: row.id });

export function openPrivacyStore(directory, { vault, clock = Date.now, limits = () => defaults, held = () => false } = {}) {
  // Fail before creating a file, including when the OS-protected vault has closed.
  try {
    const identity = { purpose: 'audit', repository: null, id: 'privacy-store' }, probe = Buffer.from('protected');
    if (!vault?.openPayload(identity, vault.sealPayload(identity, probe)).equals(probe)) throw new Error();
  } catch { throw new Error('Privacy protection unavailable'); }
  if (![clock, limits, held].every(value => typeof value === 'function')) throw new Error('Privacy host controls unavailable');
  const db = new DatabaseSync(protectedFile(directory, 'privacy.sqlite'), { allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1) throw new Error('Privacy storage version unavailable');
    if (version === 0) {
      if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n) throw new Error('Privacy storage invalid');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE privacy_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0),clock INTEGER NOT NULL CHECK(clock>=0));
        INSERT INTO privacy_state VALUES(1,0,0);
        CREATE TABLE privacy_records(id TEXT PRIMARY KEY,repository TEXT,category TEXT NOT NULL CHECK(category IN ('conversation','log','audit')),
          run_id TEXT,created_at INTEGER NOT NULL,completed_at INTEGER,payload BLOB NOT NULL CHECK(length(payload) BETWEEN 28 AND 2097180));
        CREATE INDEX privacy_scope ON privacy_records(repository,category,created_at,id);
        CREATE INDEX privacy_run ON privacy_records(category,repository,run_id,created_at,id);
        PRAGMA user_version=1; COMMIT;`);
    }
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Privacy storage invalid');
    let closed = false;
    const previews = new Map();
    const ready = () => { if (closed) throw new Error('Privacy storage closed'); };
    const state = () => {
      ready(); const value = db.prepare('SELECT revision,clock FROM privacy_state WHERE id=1').get();
      if (!value || !timestamp(value.revision) || !timestamp(value.clock)) throw new Error('Privacy storage invalid');
      return value;
    };
    function now() {
      const value = clock(); if (!timestamp(value) || value < state().clock) throw new Error('Privacy clock changed'); return value;
    }
    function configured(target) {
      const value = limits(target); canonicalJSON(value); record(value, Object.keys(defaults));
      for (const key of Object.keys(defaults)) if (!Number.isSafeInteger(value[key]) || value[key] < 1
        || value[key] > (key.endsWith('Days') ? 36500 : 100000 * 1024 ** 2)) throw new Error('Privacy limits invalid');
      if (value.runLogBytes > value.totalLogBytes) throw new Error('Privacy limits invalid');
      return value;
    }
    function recovery(row) {
      const result = held(row.repository, row.run_id);
      if (typeof result !== 'boolean') throw new Error('Privacy recovery state unavailable');
      return result;
    }
    function decode(row) {
      const bytes = vault.openPayload(binding(row), Buffer.from(row.payload));
      try {
        const value = JSON.parse(bytes.toString('utf8')); record(value, ['metadata', 'value']);
        if (canonicalJSON(value.metadata) !== canonicalJSON(metadata(row))) throw new Error();
        canonicalJSON(value.value); return value.value;
      } catch { throw new Error('protected-payload-invalid'); }
      finally { bytes.fill(0); }
    }
    function transaction(action) {
      ready(); db.exec('BEGIN IMMEDIATE');
      try {
        const time = now(), result = action(time);
        if (result.changed) {
          if (state().revision === Number.MAX_SAFE_INTEGER) throw new Error('Privacy revision exhausted');
          db.prepare('UPDATE privacy_state SET revision=revision+1,clock=? WHERE id=1').run(time);
        } else db.prepare('UPDATE privacy_state SET clock=? WHERE id=1').run(time);
        db.exec('COMMIT'); if (result.changed) previews.clear(); return result.value;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    function remove(ids) { for (const id of ids) db.prepare('DELETE FROM privacy_records WHERE id=?').run(id); }
    function rotate(row, runLimit, totalLimit) {
      const bytes = query => db.prepare(query).get().n;
      const runBytes = () => db.prepare("SELECT COALESCE(SUM(length(payload)),0) AS n FROM privacy_records WHERE category='log' AND repository IS ? AND run_id IS ?").get(row.repository, row.run_id).n;
      const totalBytes = () => bytes("SELECT COALESCE(SUM(length(payload)),0) AS n FROM privacy_records WHERE category='log'");
      if (row.payload.length > Math.min(runLimit, totalLimit)) throw new Error('Privacy log exceeds storage limit');
      // Bounded work per allocation; a busy store must retry after explicit retention, never discard recovery evidence.
      let examined = 0;
      function reclaim(query, parameters, exceeded) {
        for (const candidate of db.prepare(query).iterate(...parameters)) {
          if (!exceeded()) break;
          if (++examined > 10000) throw new Error('Privacy rotation needs a retention pass');
          decode(candidate);
          if (candidate.completed_at !== null && !recovery(candidate)) remove([candidate.id]);
        }
        if (exceeded()) throw new Error('Protected recovery prevents log allocation');
      }
      reclaim("SELECT * FROM privacy_records WHERE category='log' AND repository IS ? AND run_id IS ? AND id!=? ORDER BY created_at,id",
        [row.repository, row.run_id, row.id], () => runBytes() > runLimit);
      reclaim("SELECT * FROM privacy_records WHERE category='log' AND id!=? ORDER BY created_at,id", [row.id], () => totalBytes() > totalLimit);
    }
    function append(input) {
      canonicalJSON(input); record(input, ['repository', 'category', 'value'], ['runId', 'completedAt']);
      if (!repository(input.repository) || !categories.includes(input.category) || input.runId !== undefined && !identifier(input.runId)
        || input.category === 'log' && !identifier(input.runId) || input.completedAt !== undefined && !timestamp(input.completedAt)) throw new Error('Privacy record invalid');
      return transaction(time => {
        if (input.completedAt > time) throw new Error('Privacy completion time invalid');
        const row = { id: randomUUID(), repository: input.repository, category: input.category, run_id: input.runId ?? null,
          created_at: time, completed_at: input.completedAt ?? null };
        const plain = Buffer.from(canonicalJSON({ metadata: metadata(row), value: input.value }));
        try { row.payload = vault.sealPayload(binding(row), plain); } finally { plain.fill(0); }
        db.prepare('INSERT INTO privacy_records VALUES(?,?,?,?,?,?,?)').run(row.id, row.repository, row.category, row.run_id, time, row.completed_at, row.payload);
        if (row.category === 'log') rotate(row, configured(row.repository).runLogBytes, configured(null).totalLogBytes);
        return { changed: true, value: { id: row.id } };
      });
    }
    function list(target, category, options = {}) {
      ready(); if (!repository(target) || !categories.includes(category)) throw new Error('Privacy scope invalid');
      canonicalJSON(options); record(options, [], ['limit', 'before']); const { limit = 50, before = null } = options;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || before !== null && !identifier(before)) throw new Error('Privacy page invalid');
      const cursor = before === null ? null : db.prepare('SELECT * FROM privacy_records WHERE id=? AND repository IS ? AND category=?').get(before, target, category);
      if (before !== null && !cursor) throw new Error('Privacy page changed');
      if (cursor) decode(cursor);
      const rows = cursor ? db.prepare('SELECT * FROM privacy_records WHERE repository IS ? AND category=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?')
        .iterate(target, category, cursor.created_at, cursor.created_at, cursor.id, limit) : db.prepare('SELECT * FROM privacy_records WHERE repository IS ? AND category=? ORDER BY created_at DESC,id DESC LIMIT ?').iterate(target, category, limit);
      const page = []; let bytes = 0;
      for (const row of rows) {
        if (page.length && bytes + row.payload.length > 2 * 1024 ** 2) break;
        page.push({ ...metadata(row), value: decode(row) }); bytes += row.payload.length;
      }
      return page;
    }
    function selection(target, chosen, after, limit) {
      const selected = [], protectedIds = [], digest = createHash('sha256');
      // A preview is bounded. The next cursor includes held records, allowing progress past protected batches.
      let count = 0, next = null, more = false;
      for (const row of db.prepare(`SELECT * FROM privacy_records WHERE repository IS ? AND category IN (${chosen.map(() => '?').join(',')}) AND id>? ORDER BY id LIMIT ?`).iterate(target, ...chosen, after ?? '', limit + 1)) {
        if (++count > limit) { more = true; break; }
        decode(row); const protectedRecord = recovery(row);
        next = row.id;
        (protectedRecord ? protectedIds : selected).push(row.id);
        digest.update(canonicalJSON({ ...metadata(row), protectedRecord, payload: hash(row.payload) }));
      }
      return { selected, retainedRecovery: protectedIds.length, digest: digest.digest('hex'), next, more };
    }
    function previewDeletion(target, chosen, options = {}) {
      if (!repository(target) || !Array.isArray(chosen) || !chosen.length || chosen.length > categories.length
        || new Set(chosen).size !== chosen.length || chosen.some(value => !categories.includes(value))) throw new Error('Privacy scope invalid');
      canonicalJSON(options); record(options, [], ['after', 'limit']); const { after = null, limit = 1000 } = options;
      if (after !== null && !identifier(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Privacy deletion page invalid');
      const time = now(), snapshot = selection(target, [...chosen].sort(), after, limit);
      const preview = { id: randomUUID(), repository: target, categories: [...chosen].sort(), revision: state().revision, expires: time + 900000,
        digest: snapshot.digest, count: snapshot.selected.length, retainedRecovery: snapshot.retainedRecovery, after, limit, next: snapshot.next, more: snapshot.more };
      if (!timestamp(preview.expires)) throw new Error('Privacy clock changed');
      db.prepare('UPDATE privacy_state SET clock=? WHERE id=1').run(time);
      for (const [id, value] of previews) if (value.expires < time) previews.delete(id);
      if (previews.size >= 256) throw new Error('Privacy preview capacity reached');
      previews.set(preview.id, { preview: canonicalJSON(preview), selected: snapshot.selected, expires: preview.expires, applied: false });
      return preview;
    }
    function deleteRecords(preview) {
      ready(); const saved = previews.get(preview?.id);
      if (!saved || canonicalJSON(preview) !== saved.preview) throw new Error('Privacy preview changed');
      if (now() > saved.expires) throw new Error('Privacy preview expired');
      if (saved.applied) return { applied: false, deleted: 0 };
      const result = transaction(() => {
        const snapshot = selection(preview.repository, preview.categories, preview.after, preview.limit);
        if (state().revision !== preview.revision || snapshot.digest !== preview.digest || snapshot.next !== preview.next || snapshot.more !== preview.more) throw new Error('Privacy preview changed');
        remove(saved.selected);
        return { changed: saved.selected.length > 0, value: { applied: true, deleted: saved.selected.length } };
      });
      saved.applied = true;
      // Preserve the consumed identity for idempotent retries while invalidating other previews.
      previews.set(preview.id, saved);
      return result;
    }
    function expire(options = {}) {
      canonicalJSON(options); record(options, [], ['after', 'limit']); const { after = null, limit = 500 } = options;
      if (after !== null && !identifier(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Privacy retention page invalid');
      return transaction(time => {
        const ids = []; let retainedRecovery = 0, count = 0, cursor = null;
        for (const row of db.prepare('SELECT * FROM privacy_records WHERE id>? ORDER BY id LIMIT ?').iterate(after ?? '', limit)) {
          count++; cursor = row.id;
          decode(row);
          if (recovery(row)) { retainedRecovery++; continue; }
          if (row.completed_at !== null && time - row.completed_at >= configured(row.repository)[row.category + 'Days'] * 86400000) ids.push(row.id);
        }
        remove(ids);
        return { changed: ids.length > 0, value: { deleted: ids.length, retainedRecovery, after: cursor, more: count === limit } };
      });
    }
    function inventory() {
      const current = state();
      return { revision: current.revision, categories: db.prepare('SELECT repository,category,COUNT(*) AS count,SUM(length(payload)) AS bytes FROM privacy_records GROUP BY repository,category ORDER BY repository,category').all() };
    }
    return Object.freeze({ append, list, inventory, expire, previewDeletion, delete: deleteRecords,
      close() { if (!closed) { closed = true; previews.clear(); db.close(); } } });
  } catch (error) { db.close(); throw error; }
}
