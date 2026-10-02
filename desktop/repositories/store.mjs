import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { protectedFile, backupDatabase } from '../core/storage.mjs';
import { canonicalJSON } from '../core/settings.mjs';
import { transact } from '../core/runtime.mjs';

const encode = value => { const text = canonicalJSON(value); if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('setup-record-too-large'); return text; };
const digest = value => createHash('sha256').update(encode(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value);
const remoteIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_=-]{1,180}$/.test(value);
const decode = row => { if (!row) return null; const value = JSON.parse(row.data); if (digest(value) !== row.hash) throw new Error('setup-record-invalid'); return value; };

export function openWorkspaceStore(directory) {
  const db = new DatabaseSync(protectedFile(directory, 'workspaces.sqlite'), { allowExtension: false, timeout: 1000 });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, 2, 3].includes(version)) throw new Error('setup-schema-unsupported');
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    if (version && version < 3) backupDatabase(db, directory, 'workspaces', version);
    if (!version) transact(db, () => {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('setup-schema-unsupported');
      db.exec("CREATE TABLE setup_draft(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE workspaces(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL UNIQUE,slug TEXT NOT NULL UNIQUE,local_key TEXT NOT NULL UNIQUE,data TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE setup_effects(id TEXT PRIMARY KEY,job TEXT NOT NULL,step TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL,result TEXT,UNIQUE(job,step)); CREATE TABLE workspace_selection(id INTEGER PRIMARY KEY CHECK(id=1),workspace TEXT REFERENCES workspaces(id)); PRAGMA user_version=1;");
    });
    if (version < 2) transact(db, () => {
      db.exec('CREATE TABLE issue_contexts(repository TEXT PRIMARY KEY REFERENCES workspaces(id),data TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE issue_ready(repository TEXT NOT NULL REFERENCES workspaces(id),issue TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1)),observed_at INTEGER NOT NULL,PRIMARY KEY(repository,issue)); PRAGMA user_version=2;');
    });
    if (version < 3) transact(db, () => {
      db.exec('CREATE TABLE pipeline_drafts(context TEXT PRIMARY KEY,data TEXT NOT NULL,hash TEXT NOT NULL); PRAGMA user_version=3;');
    });
  } catch (error) { db.close(); throw error; }
  function effect(row) {
    if (!row) return null; const binding = JSON.parse(row.data);
    if (digest(binding) !== row.fingerprint || !['prepared', 'dispatched', 'verified', 'uncertain', 'denied'].includes(row.state)) throw new Error('setup-record-invalid');
    return { id: row.id, job: row.job, step: row.step, binding, state: row.state, result: row.result ? JSON.parse(row.result) : null };
  }
  function pipelineContext(repository, kind) {
    if (!['development', 'release'].includes(kind)) throw new Error('pipeline-kind-invalid');
    if (repository !== null && (!identifier(repository) || !db.prepare('SELECT id FROM workspaces WHERE id=?').get(repository))) throw new Error('workspace-unavailable');
    return encode({ repository, kind });
  }
  return Object.freeze({
    pipelineDraft: (repository, kind) => decode(db.prepare('SELECT data,hash FROM pipeline_drafts WHERE context=?').get(pipelineContext(repository, kind))),
    savePipelineDraft(repository, kind, draft) { db.prepare('INSERT INTO pipeline_drafts VALUES(?,?,?) ON CONFLICT(context) DO UPDATE SET data=excluded.data,hash=excluded.hash').run(pipelineContext(repository, kind), encode(draft), digest(draft)); },
    clearPipelineDraft(repository, kind) { db.prepare('DELETE FROM pipeline_drafts WHERE context=?').run(pipelineContext(repository, kind)); },
    draft: () => decode(db.prepare('SELECT * FROM setup_draft WHERE id=1').get()),
    saveDraft(value) { if (!identifier(value?.id)) throw new Error('setup-record-invalid'); db.prepare('INSERT INTO setup_draft VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,hash=excluded.hash').run(encode(value), digest(value)); },
    workspaces: () => db.prepare('SELECT data,hash FROM workspaces ORDER BY rowid').all().map(decode),
    selected: () => db.prepare('SELECT workspace FROM workspace_selection WHERE id=1').get()?.workspace ?? null,
    select(id) { if (!db.prepare('SELECT id FROM workspaces WHERE id=?').get(id)) throw new Error('workspace-unavailable'); db.prepare('INSERT INTO workspace_selection VALUES(1,?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace').run(id); },
    issueContext: repository => decode(db.prepare('SELECT data,hash FROM issue_contexts WHERE repository=?').get(repository)),
    saveIssueContext(repository, value) {
      if (!identifier(repository) || !db.prepare('SELECT id FROM workspaces WHERE id=?').get(repository)) throw new Error('workspace-unavailable');
      db.prepare('INSERT INTO issue_contexts VALUES(?,?,?) ON CONFLICT(repository) DO UPDATE SET data=excluded.data,hash=excluded.hash').run(repository, encode(value), digest(value));
    },
    observeReady(repository, issue, ready, observedAt, own = false) {
      if (!identifier(repository) || !remoteIdentifier(issue) || typeof ready !== 'boolean' || !Number.isSafeInteger(observedAt) || observedAt < 0 || typeof own !== 'boolean') throw new Error('setup-record-invalid');
      return transact(db, () => {
        const before = db.prepare('SELECT ready FROM issue_ready WHERE repository=? AND issue=?').get(repository, issue);
        db.prepare('INSERT INTO issue_ready VALUES(?,?,?,?) ON CONFLICT(repository,issue) DO UPDATE SET ready=excluded.ready,observed_at=excluded.observed_at').run(repository, issue, Number(ready), observedAt);
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
          return { created: false, workspace: decode(matches[0]) };
        }
        db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?)').run(value.id, value.repositoryId, value.slug, value.localKey, encode(value), digest(value));
        return { created: true, workspace: value };
      });
    },
    effects: job => db.prepare('SELECT * FROM setup_effects WHERE job=? ORDER BY rowid').all(job).map(effect),
    pending: kind => db.prepare("SELECT * FROM setup_effects WHERE state IN ('dispatched','uncertain') ORDER BY rowid").all().map(effect).filter(effect => kind === undefined || (effect.binding.kind ?? 'setup') === kind),
    prepare(job, step, binding) {
      if (!identifier(job) || !identifier(step)) throw new Error('setup-record-invalid');
      return transact(db, () => {
        const before = db.prepare('SELECT * FROM setup_effects WHERE job=? AND step=?').get(job, step), fingerprint = digest(binding);
        if (before) { if (before.fingerprint !== fingerprint) throw new Error('effect-conflict'); return effect(before); }
        const id = randomUUID(); db.prepare("INSERT INTO setup_effects VALUES(?,?,?,?,?,'prepared',NULL)").run(id, job, step, fingerprint, encode(binding));
        return effect(db.prepare('SELECT * FROM setup_effects WHERE id=?').get(id));
      });
    },
    dispatch(id) { return db.prepare("UPDATE setup_effects SET state='dispatched' WHERE id=? AND state='prepared'").run(id).changes === 1; },
    checkpoint(id, result) { if (db.prepare("UPDATE setup_effects SET result=? WHERE id=? AND state='dispatched'").run(encode(result), id).changes !== 1) throw new Error('effect-state-conflict'); },
    finish(id, state, result = null) {
      if (!['verified', 'uncertain', 'denied'].includes(state) || db.prepare("UPDATE setup_effects SET state=?,result=? WHERE id=? AND state IN ('dispatched','uncertain')").run(state, encode(result), id).changes !== 1) throw new Error('effect-state-conflict');
    },
    close: () => db.close(),
  });
}
