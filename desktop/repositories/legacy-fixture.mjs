import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON } from '../core/settings.mjs';

// Historical plaintext fixtures, not a runtime fallback. Never packaged.
export function legacyWorkspace(directory, version, values = {}) {
  const db = new DatabaseSync(protectedFile(directory, 'workspaces.sqlite'));
  const json = canonicalJSON, hash = value => createHash('sha256').update(json(value)).digest('hex');
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE setup_draft(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE workspaces(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL UNIQUE,slug TEXT NOT NULL UNIQUE,local_key TEXT NOT NULL UNIQUE,data TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE setup_effects(id TEXT PRIMARY KEY,job TEXT NOT NULL,step TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL,result TEXT,UNIQUE(job,step)); CREATE TABLE workspace_selection(id INTEGER PRIMARY KEY CHECK(id=1),workspace TEXT REFERENCES workspaces(id));');
    if (version >= 2) db.exec('CREATE TABLE issue_contexts(repository TEXT PRIMARY KEY REFERENCES workspaces(id),data TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE issue_ready(repository TEXT NOT NULL REFERENCES workspaces(id),issue TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1)),observed_at INTEGER NOT NULL,PRIMARY KEY(repository,issue));');
    if (version >= 3) db.exec('CREATE TABLE pipeline_drafts(context TEXT PRIMARY KEY,data TEXT NOT NULL,hash TEXT NOT NULL);');
    if (version >= 4) db.exec('CREATE TABLE schedule_states(repository TEXT PRIMARY KEY REFERENCES workspaces(id),data TEXT NOT NULL,hash TEXT NOT NULL);');
    for (const value of values.workspaces ?? []) db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?)').run(value.id, value.repositoryId, value.slug, value.localKey, json(value), hash(value));
    if (values.draft) db.prepare('INSERT INTO setup_draft VALUES(1,?,?)').run(json(values.draft), hash(values.draft));
    if (values.selected) db.prepare('INSERT INTO workspace_selection VALUES(1,?)').run(values.selected);
    for (const row of values.effects ?? []) db.prepare('INSERT INTO setup_effects VALUES(?,?,?,?,?,?,?)').run(row.id, row.job, row.step, hash(row.binding), json(row.binding), row.state, row.result === null ? null : json(row.result));
    for (const [repository, data] of Object.entries(values.issues ?? {})) db.prepare('INSERT INTO issue_contexts VALUES(?,?,?)').run(repository, json(data), hash(data));
    for (const row of values.ready ?? []) db.prepare('INSERT INTO issue_ready VALUES(?,?,?,?)').run(row.repository, row.issue, Number(row.ready), row.observedAt);
    for (const row of values.pipelines ?? []) db.prepare('INSERT INTO pipeline_drafts VALUES(?,?,?)').run(json(row.context), json(row.value), hash(row.value));
    for (const [repository, data] of Object.entries(values.schedules ?? {})) db.prepare('INSERT INTO schedule_states VALUES(?,?,?)').run(repository, json(data), hash(data));
    db.exec('PRAGMA user_version=' + version);
  } finally { db.close(); }
}
