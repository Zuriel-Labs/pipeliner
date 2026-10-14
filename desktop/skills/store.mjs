import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { transact } from '../core/runtime.mjs';
import { starterSkills } from '../development/starter.mjs';
import { skillPackage, skillName } from './package.mjs';

export const skillManifestHash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const bundled = starterSkills.map(skill => ({ ...skill, name: skill.id, originalName: skill.id, kind: 'bundled', requirements: [] }));
const pin = pack => 'skill-' + skillManifestHash({ name: pack.name, digest: pack.digest }).slice(0, 40);
function verified(pack) {
  const checked = skillPackage({ source: pack.source, files: pack.files }, { name: pack.name });
  if (canonicalJSON(checked) !== canonicalJSON(pack)) throw new Error('Skill package must be verified before installation.');
  return checked;
}
const manifestEntry = item => ({ id: item.id, name: item.name, version: item.version, digest: item.digest, kind: item.kind });

export function openSkillStore(directory, { occupiedNames = () => [] } = {}) {
  const db = new DatabaseSync(protectedFile(directory, 'skills.sqlite'), { allowExtension: false, timeout: 1000 });
  let closed = false;
  const ready = () => { if (closed) throw new Error('Skill storage unavailable.'); };
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version)) throw new Error('Unsupported skill storage.');
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (!version) transact(db, () => {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('Unrecognized skill storage.');
      db.exec(`CREATE TABLE skill_versions(id TEXT PRIMARY KEY, document TEXT NOT NULL, hash TEXT NOT NULL, digest TEXT NOT NULL);
        CREATE TABLE skill_names(name TEXT PRIMARY KEY, current_id TEXT NOT NULL REFERENCES skill_versions(id), installed INTEGER NOT NULL CHECK(installed IN (0,1)));
        CREATE TABLE skill_events(revision INTEGER PRIMARY KEY, operation TEXT NOT NULL, name TEXT NOT NULL, pin TEXT NOT NULL);
        CREATE TRIGGER immutable_skill_update BEFORE UPDATE ON skill_versions BEGIN SELECT RAISE(ABORT,'Immutable skill version'); END;
        CREATE TRIGGER immutable_skill_delete BEFORE DELETE ON skill_versions BEGIN SELECT RAISE(ABORT,'Immutable skill version'); END;
        PRAGMA user_version=1;`);
    });
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Skill storage integrity failed.');
  } catch (error) { db.close(); throw error; }
  const revision = () => { ready(); return db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM skill_events').get().revision; };
  const checkRevision = expected => { if (!Number.isSafeInteger(expected) || revision() !== expected) throw new Error('Skill inventory changed; review the current version.'); };
  function get(id) {
    ready(); const built = bundled.find(item => item.id === id); if (built) return immutable(structuredClone(built));
    if (typeof id !== 'string' || !/^skill-[a-f0-9]{40}$/.test(id)) throw new Error('Skill pin unavailable.');
    const row = db.prepare('SELECT * FROM skill_versions WHERE id=?').get(id); if (!row) throw new Error('Skill pin unavailable.');
    const pack = JSON.parse(row.document);
    if (row.hash !== skillManifestHash(pack) || pin(verified(pack)) !== id) throw new Error('Skill content integrity failed.');
    return immutable({ ...pack, id, kind: 'external' });
  }
  function list() {
    ready(); return immutable([...bundled.map(item => structuredClone(item)), ...db.prepare('SELECT current_id FROM skill_names WHERE installed=1 ORDER BY name').all().map(row => get(row.current_id))]);
  }
  function available(item) { return item.kind === 'bundled' || db.prepare('SELECT installed FROM skill_names WHERE name=?').get(item.name)?.installed === 1; }
  const generation = item => item.kind === 'bundled' ? 0 : db.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM skill_events WHERE name=? AND operation='remove'").get(item.name).revision;
  function sourceCollision(pack) {
    const occupied = occupiedNames(); if (!Array.isArray(occupied) || !occupied.every(skillName)) throw new Error('Skill name inventory unavailable.');
    if (occupied.includes(pack.name)) throw new Error('Skill name collision.');
    if (bundled.some(item => item.name === pack.name)) throw new Error('Skill name collision.');
    const current = db.prepare('SELECT current_id FROM skill_names WHERE name=?').get(pack.name);
    if (current) { const old = get(current.current_id); if (old.source.repository !== pack.source.repository || old.source.path !== pack.source.path || old.originalName !== pack.originalName) throw new Error('Skill name collision.'); }
    return current;
  }
  function persist(pack) {
    const id = pin(pack), previous = db.prepare('SELECT document FROM skill_versions WHERE id=?').get(id);
    if (previous && previous.document !== canonicalJSON(pack)) throw new Error('Skill immutable pin conflict.');
    if (!previous) { if (db.prepare('SELECT COUNT(*) AS count FROM skill_versions').get().count >= 512) throw new Error('Skill version capacity reached; retained run pins need review.'); db.prepare('INSERT INTO skill_versions VALUES(?,?,?,?)').run(id, canonicalJSON(pack), skillManifestHash(pack), pack.digest); }
    return { id, added: !previous };
  }
  function capture(view) {
    const values = view.values, selected = values['skills.extensions'].value, disabled = values['skills.disabled'].value;
    const items = [...(values['skills.bundledEnabled'].value ? bundled : []), ...selected.filter(id => !bundled.some(item => item.id === id)).map(get)]
      .filter(item => !disabled.includes(item.id));
    if (!items.length) throw new Error('Selected skill set is empty. Enable at least one skill before starting Development.');
    if (items.some(item => !available(item))) throw new Error('Selected skill content unavailable. Remove its selection or restore its exact pin.');
    const manifest = items.map(item => ({ ...manifestEntry(item), generation: generation(item) }));
    return immutable({ manifest, hash: skillManifestHash(manifest) });
  }
  function prompt(manifest, hash, authority) {
    ready(); if (!Array.isArray(manifest) || !manifest.length || manifest.length > 64 || new Set(manifest.map(item => item.id)).size !== manifest.length
      || skillManifestHash(manifest) !== hash) throw new Error('Captured skill manifest integrity failed.');
    let bytes = 0;
    return manifest.map(entry => {
      record(entry, ['id', 'name', 'version', 'digest', 'kind', 'generation']); const item = get(entry.id);
      if (canonicalJSON({ ...manifestEntry(item), generation: entry.generation }) !== canonicalJSON(entry)) throw new Error('Captured skill content integrity failed.');
      if (!Number.isSafeInteger(entry.generation) || entry.generation !== generation(item)) throw new Error('Captured skill authority revoked by removal. Start a new run with the current selection.');
      if (!available(item)) throw new Error('Captured skill content unavailable. Restore the exact pin or start a new run.');
      if (authority.deniedExtensions?.includes(item.id) || (item.kind === 'bundled' ? !authority.bundledSkills : !authority.extensions.includes(item.id))) throw new Error('Captured skill authority revoked. Start a new run with the current selection.');
      const content = item.kind === 'bundled' ? item.instructions : item.instructions + '\n' + item.files.filter(file => file.path.startsWith('references/')).map(file => file.path + '\n' + file.content).join('\n');
      bytes += Buffer.byteLength(content); if (bytes > 262144) throw new Error('Captured skill instructions exceed the qualified context limit.');
      return item.name + ' ' + item.version + ' (' + item.digest + ')\n' + content;
    }).join('\n\n');
  }
  return Object.freeze({ revision, get, list, capture, prompt,
    names() { ready(); return [...bundled.map(item => item.name), ...db.prepare('SELECT name FROM skill_names ORDER BY name').all().map(row => row.name)]; },
    available(id) { return available(get(id)); },
    removed(id) { const item = get(id); return item.kind !== 'bundled' && db.prepare('SELECT installed FROM skill_names WHERE name=?').get(item.name)?.installed === 0; },
    catalog() { ready(); return [...bundled.map(({ id, digest }) => ({ id, digest })), ...db.prepare('SELECT id,digest FROM skill_versions ORDER BY id').all().map(({ id, digest }) => ({ id, digest }))]; },
    pins(name) { if (!skillName(name)) throw new Error('Skill name unavailable.'); return [...bundled.filter(item => item.name === name), ...db.prepare('SELECT id FROM skill_versions ORDER BY id').all().map(row => get(row.id)).filter(item => item.name === name)].map(item => item.id); },
    stage(input, expected) { ready(); const pack = verified(input); return transact(db, () => { checkRevision(expected); sourceCollision(pack); const { id, added } = persist(pack);
      if (added) db.prepare('INSERT INTO skill_events VALUES(?,?,?,?)').run(expected + 1, 'stage', pack.name, id);
      return get(id); }); },
    install(input, expected) {
      ready(); const pack = verified(input);
      return transact(db, () => {
        checkRevision(expected); const current = sourceCollision(pack), { id } = persist(pack);
        db.prepare('INSERT INTO skill_names VALUES(?,?,1) ON CONFLICT(name) DO UPDATE SET current_id=excluded.current_id,installed=1').run(pack.name, id);
        db.prepare('INSERT INTO skill_events VALUES(?,?,?,?)').run(expected + 1, current ? 'update' : 'install', pack.name, id);
        const readback = get(id); if (readback.digest !== pack.digest || !available(readback)) throw new Error('Skill install readback failed.');
        return readback;
      });
    },
    remove(name, expected) { ready(); return transact(db, () => { checkRevision(expected); if (!skillName(name) || bundled.some(item => item.name === name)) throw new Error('Bundled skills can be disabled, not removed.');
      const row = db.prepare('SELECT current_id,installed FROM skill_names WHERE name=?').get(name); if (!row?.installed) throw new Error('Installed skill unavailable.');
      db.prepare('UPDATE skill_names SET installed=0 WHERE name=?').run(name); db.prepare('INSERT INTO skill_events VALUES(?,?,?,?)').run(expected + 1, 'remove', name, row.current_id);
      if (db.prepare('SELECT installed FROM skill_names WHERE name=?').get(name).installed !== 0) throw new Error('Skill removal readback failed.'); return { name, retainedPins: true }; }); },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
