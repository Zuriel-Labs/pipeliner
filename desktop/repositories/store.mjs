import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON } from '../core/settings.mjs';
import { transact } from '../core/runtime.mjs';
import { createRecordCodec } from '../privacy/records.mjs';
import { migrateProtectedStore, finishProtectedMigration } from '../privacy/migration.mjs';
import { protectLegacyBackups } from '../privacy/backup.mjs';

const encode = value => { const text = canonicalJSON(value); if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('setup-record-too-large'); return text; };
const digest = value => createHash('sha256').update(encode(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value);
const remoteIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_=-]{1,180}$/.test(value);
const states = ['prepared', 'dispatched', 'verified', 'uncertain', 'denied'];

export function openWorkspaceStore(directory, { vault } = {}) {
  const codec = createRecordCodec(vault, 'workspace');
  const db = new DatabaseSync(protectedFile(directory, 'workspaces.sqlite'), { allowExtension: false, timeout: 1000 });
  const tables = ['setup_draft', 'workspaces', 'issue_contexts', 'pipeline_drafts', 'schedule_states'];
  function identity(table, row) {
    const context = table === 'pipeline_drafts' ? JSON.parse(row.context) : null;
    if (context && (!['development', 'release'].includes(context.kind) || context.repository !== null && !identifier(context.repository))) throw Error('setup-record-invalid');
    return { repository: table === 'workspaces' ? row.id : context ? context.repository : row.repository ?? null,
      table, key: context ?? row.id ?? row.repository };
  }
  function metadata(table, row) {
    if (table === 'workspaces') return { id: row.id, repositoryId: row.repository_id, slug: row.slug, localKey: row.local_key, hash: row.hash };
    return { hash: row.hash };
  }
  function decode(table, row, legacy = false) {
    if (!row) return null;
    const value = legacy ? JSON.parse(row.data) : codec.decode(identity(table, row), row.data, metadata(table, row));
    if (digest(value) !== row.hash || table === 'workspaces' && [value.id, value.repositoryId, value.slug, value.localKey].some((v, i) => v !== [row.id, row.repository_id, row.slug, row.local_key][i])) throw Error('setup-record-invalid');
    return value;
  }
  const seal = (table, row, value) => codec.encode(identity(table, row), value, metadata(table, row));
  const effectIdentity = row => ({ repository: row.repository, table: 'setup_effects', key: row.id });
  const effectMetadata = row => ({ id: row.id, job: row.job, step: row.step, fingerprint: row.fingerprint, state: row.state });
  function effect(row, legacy = false) {
    if (!row) return null;
    const value = legacy ? { binding: JSON.parse(row.data), result: row.result ? JSON.parse(row.result) : null } : codec.decode(effectIdentity(row), row.data, effectMetadata(row));
    if (digest(value.binding) !== row.fingerprint || !states.includes(row.state) || !legacy && (row.result !== null || (value.binding.repository ?? null) !== row.repository)) throw Error('setup-record-invalid');
    return { id: row.id, job: row.job, step: row.step, binding: value.binding, state: row.state, result: value.result };
  }
  const sealEffect = (row, value) => codec.encode(effectIdentity(row), { binding: value.binding, result: value.result }, effectMetadata(row));
  function selection(row, legacy = false) {
    if (!row) return null;
    if (!legacy && codec.decode({ repository: row.workspace, table: 'workspace_selection', key: 1 }, row.payload).workspace !== row.workspace) throw Error('setup-record-invalid');
    return row.workspace;
  }
  const readyIdentity = row => ({ repository: row.repository, table: 'issue_ready', key: row.issue });
  const readyValue = row => ({ ready: row.ready, observedAt: row.observed_at });
  function readyObservation(row, legacy = false) {
    if (!row) return null;
    if (![0, 1].includes(row.ready) || !Number.isSafeInteger(row.observed_at) || row.observed_at < 0 || !legacy && encode(codec.decode(readyIdentity(row), row.payload)) !== encode(readyValue(row))) throw Error('setup-record-invalid');
    return row;
  }
  function addTables(version) {
    if (!version) db.exec('CREATE TABLE setup_draft(id INTEGER PRIMARY KEY CHECK(id=1),data BLOB NOT NULL,hash TEXT NOT NULL); CREATE TABLE workspaces(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL UNIQUE,slug TEXT NOT NULL UNIQUE,local_key TEXT NOT NULL UNIQUE,data BLOB NOT NULL,hash TEXT NOT NULL); CREATE TABLE setup_effects(id TEXT PRIMARY KEY,job TEXT NOT NULL,step TEXT NOT NULL,fingerprint TEXT NOT NULL,data BLOB NOT NULL,state TEXT NOT NULL,result BLOB,UNIQUE(job,step)); CREATE TABLE workspace_selection(id INTEGER PRIMARY KEY CHECK(id=1),workspace TEXT REFERENCES workspaces(id));');
    if (version < 2) db.exec('CREATE TABLE issue_contexts(repository TEXT PRIMARY KEY REFERENCES workspaces(id),data BLOB NOT NULL,hash TEXT NOT NULL); CREATE TABLE issue_ready(repository TEXT NOT NULL REFERENCES workspaces(id),issue TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1)),observed_at INTEGER NOT NULL,PRIMARY KEY(repository,issue));');
    if (version < 3) db.exec('CREATE TABLE pipeline_drafts(context TEXT PRIMARY KEY,data BLOB NOT NULL,hash TEXT NOT NULL);');
    if (version < 4) db.exec('CREATE TABLE schedule_states(repository TEXT PRIMARY KEY REFERENCES workspaces(id),data BLOB NOT NULL,hash TEXT NOT NULL);');
    db.exec('ALTER TABLE setup_effects ADD COLUMN repository TEXT; ALTER TABLE workspace_selection ADD COLUMN payload BLOB; ALTER TABLE issue_ready ADD COLUMN payload BLOB;');
  }
  function verify() {
    for (const table of tables) for (const row of db.prepare('SELECT * FROM ' + table).iterate()) decode(table, row);
    for (const row of db.prepare('SELECT * FROM setup_effects').iterate()) effect(row);
    for (const row of db.prepare('SELECT * FROM issue_ready').iterate()) readyObservation(row);
    for (const row of db.prepare('SELECT * FROM workspace_selection').iterate()) selection(row);
    if (db.prepare('PRAGMA foreign_key_check').get()) throw Error('setup-record-invalid');
    return true;
  }
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, 2, 3, 4, 5].includes(version)) throw new Error('setup-schema-unsupported');
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
    if (!version) transact(db, () => {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('setup-schema-unsupported');
      addTables(0); db.exec('PRAGMA user_version=5;');
    });
    else if (version < 5) migrateProtectedStore(db, directory, 'workspaces', { vault, from: version, to: 5, verify, transform() {
      addTables(version);
      for (const table of tables) for (const row of db.prepare('SELECT rowid AS record_id,* FROM ' + table).iterate()) {
        const value = decode(table, row, true); db.prepare('UPDATE ' + table + ' SET data=? WHERE rowid=?').run(seal(table, row, value), row.record_id);
      }
      for (const row of db.prepare('SELECT * FROM setup_effects').iterate()) {
        const value = effect(row, true); row.repository = value.binding.repository ?? null;
        db.prepare('UPDATE setup_effects SET data=?,result=NULL,repository=? WHERE id=?').run(sealEffect(row, value), row.repository, row.id);
      }
      for (const row of db.prepare('SELECT * FROM workspace_selection').iterate()) db.prepare('UPDATE workspace_selection SET payload=? WHERE id=?').run(codec.encode({ repository: row.workspace, table: 'workspace_selection', key: 1 }, { workspace: selection(row, true) }), row.id);
      for (const row of db.prepare('SELECT * FROM issue_ready').iterate()) db.prepare('UPDATE issue_ready SET payload=? WHERE repository=? AND issue=?').run(codec.encode(readyIdentity(row), readyValue(readyObservation(row, true))), row.repository, row.issue);
    } });
    finishProtectedMigration(db, directory, 'workspaces', { vault, verify }); verify();
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('setup-record-invalid');
    protectLegacyBackups(directory, 'workspaces', { vault, currentVersion: 5 });
  } catch (error) { db.close(); throw error; }
  function transition(id, allowed, state, result) {
    return transact(db, () => {
      const row = db.prepare('SELECT * FROM setup_effects WHERE id=?').get(id), value = effect(row);
      if (!row || !allowed.includes(row.state)) return false;
      row.state = state; if (result !== undefined) value.result = result;
      return db.prepare('UPDATE setup_effects SET state=?,data=?,result=NULL WHERE id=?').run(state, sealEffect(row, value), id).changes === 1;
    });
  }
  function pipelineContext(repository, kind) {
    if (!['development', 'release'].includes(kind)) throw new Error('pipeline-kind-invalid');
    if (repository !== null && (!identifier(repository) || !db.prepare('SELECT id FROM workspaces WHERE id=?').get(repository))) throw new Error('workspace-unavailable');
    return encode({ repository, kind });
  }
  return Object.freeze({
    schedule: repository => decode('schedule_states', db.prepare('SELECT * FROM schedule_states WHERE repository=?').get(repository)),
    saveSchedule(repository, state) {
      if (!identifier(repository) || !db.prepare('SELECT id FROM workspaces WHERE id=?').get(repository)) throw new Error('workspace-unavailable');
      db.prepare('INSERT INTO schedule_states VALUES(?,?,?) ON CONFLICT(repository) DO UPDATE SET data=excluded.data,hash=excluded.hash').run(repository, seal('schedule_states', { repository, hash: digest(state) }, state), digest(state));
    },
    pipelineDraft: (repository, kind) => decode('pipeline_drafts', db.prepare('SELECT * FROM pipeline_drafts WHERE context=?').get(pipelineContext(repository, kind))),
    savePipelineDraft(repository, kind, draft) { const context = pipelineContext(repository, kind); db.prepare('INSERT INTO pipeline_drafts VALUES(?,?,?) ON CONFLICT(context) DO UPDATE SET data=excluded.data,hash=excluded.hash').run(context, seal('pipeline_drafts', { context, hash: digest(draft) }, draft), digest(draft)); },
    clearPipelineDraft(repository, kind) { db.prepare('DELETE FROM pipeline_drafts WHERE context=?').run(pipelineContext(repository, kind)); },
    draft: () => decode('setup_draft', db.prepare('SELECT * FROM setup_draft WHERE id=1').get()),
    saveDraft(value) { if (!identifier(value?.id)) throw new Error('setup-record-invalid'); db.prepare('INSERT INTO setup_draft VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,hash=excluded.hash').run(seal('setup_draft', { id: 1, hash: digest(value) }, value), digest(value)); },
    workspaces: () => db.prepare('SELECT * FROM workspaces ORDER BY rowid').all().map(row => decode('workspaces', row)),
    selected: () => selection(db.prepare('SELECT * FROM workspace_selection WHERE id=1').get()),
    select(id) { if (!db.prepare('SELECT id FROM workspaces WHERE id=?').get(id)) throw new Error('workspace-unavailable'); db.prepare('INSERT INTO workspace_selection VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,payload=excluded.payload').run(id, codec.encode({ repository: id, table: 'workspace_selection', key: 1 }, { workspace: id })); },
    issueContext: repository => decode('issue_contexts', db.prepare('SELECT * FROM issue_contexts WHERE repository=?').get(repository)),
    saveIssueContext(repository, value) {
      if (!identifier(repository) || !db.prepare('SELECT id FROM workspaces WHERE id=?').get(repository)) throw new Error('workspace-unavailable');
      db.prepare('INSERT INTO issue_contexts VALUES(?,?,?) ON CONFLICT(repository) DO UPDATE SET data=excluded.data,hash=excluded.hash').run(repository, seal('issue_contexts', { repository, hash: digest(value) }, value), digest(value));
    },
    observeReady(repository, issue, ready, observedAt, own = false) {
      if (!identifier(repository) || !remoteIdentifier(issue) || typeof ready !== 'boolean' || !Number.isSafeInteger(observedAt) || observedAt < 0 || typeof own !== 'boolean') throw new Error('setup-record-invalid');
      return transact(db, () => {
        const before = readyObservation(db.prepare('SELECT * FROM issue_ready WHERE repository=? AND issue=?').get(repository, issue));
        const row = { repository, issue, ready: Number(ready), observed_at: observedAt };
        db.prepare('INSERT INTO issue_ready VALUES(?,?,?,?,?) ON CONFLICT(repository,issue) DO UPDATE SET ready=excluded.ready,observed_at=excluded.observed_at,payload=excluded.payload').run(repository, issue, Number(ready), observedAt, codec.encode(readyIdentity(row), readyValue(row)));
        return { ready, drift: Boolean(before && Boolean(before.ready) !== ready && !own) };
      });
    },
    register(value) {
      if (!identifier(value?.id) || !remoteIdentifier(value.repositoryId) || typeof value.slug !== 'string' || !/^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/.test(value.slug)
        || typeof value.localKey !== 'string' || !/^\d+:\d+$/.test(value.localKey) || !isAbsolute(value.path) || !remoteIdentifier(value.project?.id)) throw new Error('setup-record-invalid');
      return transact(db, () => {
        const matches = db.prepare('SELECT * FROM workspaces WHERE id=? OR repository_id=? OR slug=? OR local_key=?').all(value.id, value.repositoryId, value.slug, value.localKey);
        if (matches.length) {
          if (matches.length !== 1 || ['id', 'repository_id', 'slug', 'local_key'].some((key, i) => matches[0][key] !== [value.id, value.repositoryId, value.slug, value.localKey][i])) throw new Error('workspace-conflict');
          return { created: false, workspace: decode('workspaces', matches[0]) };
        }
        db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?)').run(value.id, value.repositoryId, value.slug, value.localKey, seal('workspaces', { id: value.id, repository_id: value.repositoryId, slug: value.slug, local_key: value.localKey, hash: digest(value) }, value), digest(value));
        return { created: true, workspace: value };
      });
    },
    effects: job => db.prepare('SELECT * FROM setup_effects WHERE job=? ORDER BY rowid').all(job).map(row => effect(row)),
    pending: kind => db.prepare('SELECT * FROM setup_effects ORDER BY rowid').all().map(row => effect(row)).filter(effect => ['dispatched', 'uncertain'].includes(effect.state) && (kind === undefined || (effect.binding.kind ?? 'setup') === kind)),
    prepare(job, step, binding) {
      if (!identifier(job) || !identifier(step)) throw new Error('setup-record-invalid');
      return transact(db, () => {
        const before = db.prepare('SELECT * FROM setup_effects WHERE job=? AND step=?').get(job, step), fingerprint = digest(binding);
        if (before) { if (before.fingerprint !== fingerprint) throw new Error('effect-conflict'); return effect(before); }
        const row = { id: randomUUID(), job, step, fingerprint, state: 'prepared', repository: binding.repository ?? null };
        db.prepare("INSERT INTO setup_effects VALUES(?,?,?,?,?,'prepared',NULL,?)").run(row.id, job, step, fingerprint, sealEffect(row, { binding, result: null }), row.repository);
        return effect(db.prepare('SELECT * FROM setup_effects WHERE id=?').get(row.id));
      });
    },
    dispatch(id) { return transition(id, ['prepared'], 'dispatched'); },
    checkpoint(id, result) { if (!transition(id, ['dispatched'], 'dispatched', result)) throw new Error('effect-state-conflict'); },
    finish(id, state, result = null) {
      if (!['verified', 'uncertain', 'denied'].includes(state) || !transition(id, ['dispatched', 'uncertain'], state, result)) throw new Error('effect-state-conflict');
    },
    close: () => db.close(),
  });
}
