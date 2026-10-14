import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON } from '../core/settings.mjs';

// Explicit historical plaintext qualification data only. Excluded from the packaged runtime.
export function legacyDevelopment(directory, { captured, state, requests = [], outputs = [] }, { wal = false } = {}) {
  const db = new DatabaseSync(protectedFile(directory, 'development.sqlite'));
  const json = canonicalJSON, hash = value => createHash('sha256').update(json(value)).digest('hex');
  try {
    db.exec('PRAGMA journal_mode=' + (wal ? 'WAL' : 'DELETE') + '; PRAGMA synchronous=FULL; CREATE TABLE development_runs(id TEXT PRIMARY KEY,captured TEXT NOT NULL,captured_hash TEXT NOT NULL,state TEXT NOT NULL,state_hash TEXT NOT NULL); CREATE TABLE development_requests(run TEXT NOT NULL REFERENCES development_runs(id),id TEXT NOT NULL,document TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,result_hash TEXT,PRIMARY KEY(run,id)); CREATE TABLE development_outputs(run TEXT NOT NULL REFERENCES development_runs(id),visit INTEGER NOT NULL,step TEXT NOT NULL,candidate TEXT NOT NULL,document TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(run,visit)); CREATE TRIGGER immutable_development_binding BEFORE UPDATE OF captured,captured_hash ON development_runs BEGIN SELECT RAISE(ABORT,\'Immutable Development binding\'); END; CREATE TRIGGER immutable_development_request BEFORE UPDATE OF run,id,document,hash ON development_requests BEGIN SELECT RAISE(ABORT,\'Immutable Development request\'); END; CREATE TRIGGER immutable_development_output BEFORE UPDATE ON development_outputs BEGIN SELECT RAISE(ABORT,\'Immutable Development output\'); END; PRAGMA user_version=1;');
    db.prepare('INSERT INTO development_runs VALUES(?,?,?,?,?)').run(captured.run.id, json(captured), hash(captured), json(state), hash(state));
    for (const { document, state: requestState, result = null } of requests) db.prepare('INSERT INTO development_requests VALUES(?,?,?,?,?,?,?)').run(document.runId, document.id, json(document), hash(document), requestState, result === null ? null : json(result), result === null ? null : hash(result));
    for (const { run, visit, step, candidate, output } of outputs) db.prepare('INSERT INTO development_outputs VALUES(?,?,?,?,?,?)').run(run, visit, step, json(candidate), json(output), hash(output));
  } finally { db.close(); }
}
