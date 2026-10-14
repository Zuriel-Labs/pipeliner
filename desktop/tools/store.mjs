import { DatabaseSync } from 'node:sqlite';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { transact } from '../core/runtime.mjs';
import { skillName } from '../skills/package.mjs';
import { toolPackage, toolManifestHash } from './package.mjs';

export { toolManifestHash } from './package.mjs';
const pin = pack => 'tool-' + toolManifestHash({ name: pack.name, digest: pack.digest }).slice(0, 40);
function verified(pack) {
  const checked = toolPackage(pack.definition, { name: pack.name });
  if (canonicalJSON(checked) !== canonicalJSON(pack)) throw new Error('Tool package must be verified before installation.'); return checked;
}
const entry = pack => ({ id: pack.id, name: pack.name, kind: pack.kind, version: pack.version, digest: pack.digest });

export function openToolStore(directory, { occupiedNames = () => [] } = {}) {
  const db = new DatabaseSync(protectedFile(directory, 'tools.sqlite'), { allowExtension: false, timeout: 1000 }); let closed = false;
  const ready = () => { if (closed) throw new Error('Tool storage unavailable.'); };
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version; if (![0, 1].includes(version)) throw new Error('Unsupported tool storage.');
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (!version) transact(db, () => {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('Unrecognized tool storage.');
      db.exec(`CREATE TABLE tool_versions(id TEXT PRIMARY KEY, document TEXT NOT NULL, hash TEXT NOT NULL, digest TEXT NOT NULL);
        CREATE TABLE tool_names(name TEXT PRIMARY KEY, current_id TEXT NOT NULL REFERENCES tool_versions(id), installed INTEGER NOT NULL CHECK(installed IN (0,1)));
        CREATE TABLE tool_events(revision INTEGER PRIMARY KEY, operation TEXT NOT NULL, name TEXT NOT NULL, pin TEXT NOT NULL);
        CREATE TRIGGER immutable_tool_update BEFORE UPDATE ON tool_versions BEGIN SELECT RAISE(ABORT,'Immutable tool version'); END;
        CREATE TRIGGER immutable_tool_delete BEFORE DELETE ON tool_versions BEGIN SELECT RAISE(ABORT,'Immutable tool version'); END;
        PRAGMA user_version=1;`);
    });
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Tool storage integrity failed.');
  } catch (error) { db.close(); throw error; }
  const revision = () => { ready(); return db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM tool_events').get().revision; };
  const checkRevision = expected => { if (!Number.isSafeInteger(expected) || revision() !== expected) throw new Error('Tool inventory changed; review the current version.'); };
  function get(id) {
    ready(); if (typeof id !== 'string' || !/^tool-[a-f0-9]{40}$/.test(id)) throw new Error('Tool pin unavailable.');
    const row = db.prepare('SELECT * FROM tool_versions WHERE id=?').get(id); if (!row) throw new Error('Tool pin unavailable.');
    const pack = JSON.parse(row.document);
    if (row.hash !== toolManifestHash(pack) || row.digest !== pack.digest || pin(verified(pack)) !== id) throw new Error('Tool content integrity failed.');
    return immutable({ ...pack, id });
  }
  const available = item => db.prepare('SELECT installed FROM tool_names WHERE name=?').get(item.name)?.installed === 1;
  const generation = item => db.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM tool_events WHERE name=? AND operation='remove'").get(item.name).revision;
  const names = () => { ready(); return db.prepare('SELECT name FROM tool_names ORDER BY name').all().map(row => row.name); };
  function sourceCollision(pack) {
    const occupied = occupiedNames(); if (!Array.isArray(occupied) || !occupied.every(skillName)) throw new Error('Tool name inventory unavailable.');
    if (occupied.includes(pack.name)) throw new Error('Tool name collision.');
    const current = db.prepare('SELECT current_id FROM tool_names WHERE name=?').get(pack.name);
    if (current) {
      const old = get(current.current_id);
      if (old.kind !== pack.kind || old.originalName !== pack.originalName || pack.kind === 'mcp' && (old.sourceIdentity.endpoint !== pack.sourceIdentity.endpoint || old.sourceIdentity.tool !== pack.sourceIdentity.tool)) throw new Error('Tool name collision.');
    }
    return current;
  }
  function persist(pack) {
    const id = pin(pack), previous = db.prepare('SELECT document FROM tool_versions WHERE id=?').get(id);
    if (previous && previous.document !== canonicalJSON(pack)) throw new Error('Tool immutable pin conflict.');
    if (!previous) {
      if (db.prepare('SELECT COUNT(*) AS count FROM tool_versions').get().count >= 512) throw new Error('Tool version capacity reached; retained run pins need review.');
      db.prepare('INSERT INTO tool_versions VALUES(?,?,?,?)').run(id, canonicalJSON(pack), toolManifestHash(pack), pack.digest);
    }
    return { id, added: !previous };
  }
  function capture(view, { epoch } = {}) {
    ready(); const selected = view.values['tools.extensions']?.value ?? [], disabled = view.values['tools.disabled']?.value ?? [];
    if (!Array.isArray(selected) || selected.length > 64 || new Set(selected).size !== selected.length || !Array.isArray(disabled)) throw new Error('Tool selection unavailable.');
    const manifest = selected.filter(id => !disabled.includes(id)).map(id => {
      const item = get(id); if (!available(item)) throw new Error('Selected tool unavailable.');
      const binding = item.kind === 'mcp' && epoch ? { connectionEpoch: epoch(item.definition.mcp.endpoint) } : {};
      if (Object.hasOwn(binding, 'connectionEpoch') && (!Number.isSafeInteger(binding.connectionEpoch) || binding.connectionEpoch < 0)) throw new Error('Tool connection epoch unavailable.');
      return { ...entry(item), generation: generation(item), ...binding };
    });
    return immutable({ manifest, hash: toolManifestHash(manifest) });
  }
  function assertCaptured(manifest, hash, authority, { epoch } = {}) {
    ready(); if (!Array.isArray(manifest) || manifest.length > 64 || new Set(manifest.map(value => value.id)).size !== manifest.length || toolManifestHash(manifest) !== hash) throw new Error('Captured tool manifest integrity failed.');
    return immutable(manifest.map(value => {
      record(value, ['id', 'name', 'kind', 'version', 'digest', 'generation'], ['connectionEpoch']); const item = get(value.id);
      const connection = Object.hasOwn(value, 'connectionEpoch') ? { connectionEpoch: value.connectionEpoch } : {};
      if (canonicalJSON({ ...entry(item), generation: value.generation, ...connection }) !== canonicalJSON(value)) throw new Error('Captured tool content integrity failed.');
      if (Object.hasOwn(connection, 'connectionEpoch') && (item.kind !== 'mcp' || !Number.isSafeInteger(value.connectionEpoch) || value.connectionEpoch < 0
        || typeof epoch !== 'function' || epoch(item.definition.mcp.endpoint) !== value.connectionEpoch)) throw new Error('Captured tool connection changed. Start a new run with the current connection.');
      if (!Number.isSafeInteger(value.generation) || generation(item) !== value.generation || !available(item)
        || !authority.tools?.includes(item.id) || authority.deniedTools?.includes(item.id) || item.permissions.some(permission => !authority.capabilities?.includes(permission))) throw new Error('Captured tool authority revoked. Start a new run with the current selection.');
      return item;
    }));
  }
  return Object.freeze({ revision, get, names, capture, assertCaptured,
    pins(name) { ready(); if (!skillName(name)) throw new Error('Tool name unavailable.'); return db.prepare('SELECT id FROM tool_versions ORDER BY id').all().map(row => get(row.id)).filter(item => item.name === name).map(item => item.id); },
    removed(id) { ready(); const item = get(id); return db.prepare('SELECT installed FROM tool_names WHERE name=?').get(item.name)?.installed === 0; },
    available(id) { ready(); return available(get(id)); },
    list() { ready(); return immutable(db.prepare('SELECT current_id FROM tool_names WHERE installed=1 ORDER BY name').all().map(row => get(row.current_id))); },
    catalog() { ready(); return db.prepare('SELECT id,digest FROM tool_versions ORDER BY id').all().map(({ id, digest }) => ({ id, digest })); },
    stage(input, expected) { ready(); const pack = verified(input); return transact(db, () => { checkRevision(expected); sourceCollision(pack); const { id, added } = persist(pack);
      if (added) db.prepare('INSERT INTO tool_events VALUES(?,?,?,?)').run(expected + 1, 'stage', pack.name, id); return get(id); }); },
    install(input, expected) { ready(); const pack = verified(input); return transact(db, () => {
      checkRevision(expected); const current = sourceCollision(pack), { id } = persist(pack);
      db.prepare('INSERT INTO tool_names VALUES(?,?,1) ON CONFLICT(name) DO UPDATE SET current_id=excluded.current_id,installed=1').run(pack.name, id);
      db.prepare('INSERT INTO tool_events VALUES(?,?,?,?)').run(expected + 1, current ? 'update' : 'install', pack.name, id);
      const readback = get(id); if (!available(readback) || readback.digest !== pack.digest) throw new Error('Tool install readback failed.'); return readback;
    }); },
    remove(name, expected) { ready(); return transact(db, () => { checkRevision(expected); if (!skillName(name)) throw new Error('Tool name unavailable.');
      const row = db.prepare('SELECT current_id,installed FROM tool_names WHERE name=?').get(name); if (!row?.installed) throw new Error('Installed tool unavailable.');
      db.prepare('UPDATE tool_names SET installed=0 WHERE name=?').run(name); db.prepare('INSERT INTO tool_events VALUES(?,?,?,?)').run(expected + 1, 'remove', name, row.current_id);
      if (db.prepare('SELECT installed FROM tool_names WHERE name=?').get(name).installed !== 0) throw new Error('Tool removal readback failed.'); return { name, retainedPins: true }; }); },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
