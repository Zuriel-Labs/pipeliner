import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { protectedFile } from '../core/storage.mjs';
import { canonicalJSON, immutable, record, validatePipeline } from '../core/settings.mjs';
import { transact } from '../core/runtime.mjs';
import { showcaseComplete } from '../../scripts/lib/showcase.mjs';

const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, maximum = 4096) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
function candidate(value) { record(value, ['sourceCommit', 'gitTree']); if (!Object.values(value).every(v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v))) throw new Error('Invalid Development candidate'); }
function document(value) {
  record(value, ['title', 'paragraphs']);
  if (!text(value.title, 240) || !Array.isArray(value.paragraphs) || !value.paragraphs.length || value.paragraphs.length > 64 || !value.paragraphs.every(v => text(v, 8192))) throw new Error('Invalid Development document');
}
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function developmentIssueHash(issue) {
  record(issue, ['number', 'title', 'body']);
  if (!Number.isSafeInteger(issue.number) || issue.number < 1 || typeof issue.title !== 'string' || issue.title.length > 256
    || typeof issue.body !== 'string' || issue.body.length > 65536) throw new Error('Development Issue input unavailable');
  return hash(issue);
}
// Untrusted prose becomes escaped text, never renderer markup or executable HTML.
export function documentHTML(value) {
  document(value);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>' + escape(value.title) + '</title><style>body{color:#edf2f8;background:#101722;font:17px/1.6 system-ui,sans-serif;max-width:960px;margin:auto;padding:32px}p{white-space:pre-wrap}</style></head><body><h1>' + escape(value.title) + '</h1>' + value.paragraphs.map(paragraph => '<p>' + escape(paragraph) + '</p>').join('') + '</body></html>\n';
}
export function validateDevelopmentOutput(value) {
  canonicalJSON(value); record(value, ['outcome', 'summary', 'evidence', 'documents', 'findings']);
  if (!['success', 'failure', 'feedback'].includes(value.outcome) || !text(value.summary) || !Array.isArray(value.evidence) || value.evidence.length > 64
    || new Set(value.evidence).size !== value.evidence.length || !value.evidence.every(id) || !Array.isArray(value.documents) || value.documents.length > 8
    || !Array.isArray(value.findings) || value.findings.length > 32) throw new Error('Invalid Development output');
  for (const item of value.documents) { record(item, ['kind', 'title', 'paragraphs']); if (!['research', 'specification', 'design', 'review'].includes(item.kind)) throw new Error('Unknown Development document'); document({ title: item.title, paragraphs: item.paragraphs }); }
  if (new Set(value.documents.map(item => item.kind)).size !== value.documents.length) throw new Error('Duplicate Development document');
  for (const finding of value.findings) { record(finding, ['severity', 'text']); if (!['low', 'medium', 'high', 'critical'].includes(finding.severity) || !text(finding.text)) throw new Error('Invalid Development finding'); }
}

// Only the trusted Development host receives this ledger. Policy/runtime own authority.
export function openDevelopmentStore(directory) {
  const db = new DatabaseSync(protectedFile(directory, 'development.sqlite'), { allowExtension: false, timeout: 1000 });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version)) throw new Error('Unsupported Development store');
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (!version) transact(db, () => {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('Unrecognized Development store');
      db.exec(`CREATE TABLE development_runs(id TEXT PRIMARY KEY, captured TEXT NOT NULL, captured_hash TEXT NOT NULL, state TEXT NOT NULL, state_hash TEXT NOT NULL);
        CREATE TABLE development_requests(run TEXT NOT NULL REFERENCES development_runs(id), id TEXT NOT NULL, document TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, result_hash TEXT, PRIMARY KEY(run,id));
        CREATE TABLE development_outputs(run TEXT NOT NULL REFERENCES development_runs(id), visit INTEGER NOT NULL, step TEXT NOT NULL, candidate TEXT NOT NULL, document TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(run,visit));
        CREATE TRIGGER immutable_development_binding BEFORE UPDATE OF captured,captured_hash ON development_runs BEGIN SELECT RAISE(ABORT,'Immutable Development binding'); END;
        CREATE TRIGGER immutable_development_request BEFORE UPDATE OF run,id,document,hash ON development_requests BEGIN SELECT RAISE(ABORT,'Immutable Development request'); END;
        CREATE TRIGGER immutable_development_output BEFORE UPDATE ON development_outputs BEGIN SELECT RAISE(ABORT,'Immutable Development output'); END;
        PRAGMA user_version=1;`);
    });
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Development store integrity failed');
  } catch (error) { db.close(); throw error; }
  let closed = false;
  const requireOpen = () => { if (closed) throw new Error('Development store closed'); };
  function read(runId) {
    requireOpen(); if (!id(runId)) throw new Error('Invalid Development run');
    const row = db.prepare('SELECT * FROM development_runs WHERE id=?').get(runId);
    if (!row) throw new Error('Unknown Development run');
    const captured = JSON.parse(row.captured), state = JSON.parse(row.state);
    if (hash(captured) !== row.captured_hash || hash(state) !== row.state_hash || captured.run.id !== runId || state.runId !== runId) throw new Error('Development record integrity failed');
    return { captured, state };
  }
  function bound(binding) {
    canonicalJSON(binding); record(binding, ['runId', 'epoch']);
    const value = read(binding.runId);
    if (value.state.epoch !== binding.epoch) throw new Error('Stale Development epoch');
    return value;
  }
  const write = state => { quota(state.runId, state, 0, true); db.prepare('UPDATE development_runs SET state=?,state_hash=? WHERE id=?').run(canonicalJSON(state), hash(state), state.runId); };
  function request(row) {
    if (!row) throw new Error('Unknown Development request');
    const data = JSON.parse(row.document), result = row.result ? JSON.parse(row.result) : null;
    if (hash(data) !== row.hash || result && hash(result) !== row.result_hash || !['prepared', 'dispatched', 'uncertain', 'verified', 'denied'].includes(row.state)) throw new Error('Development request integrity failed');
    return immutable({ ...data, state: row.state, result });
  }
  const requests = runId => db.prepare('SELECT * FROM development_requests WHERE run=? ORDER BY rowid').all(runId).map(request);
  function quota(runId, value, reservedBytes = 0, replacesState = false) {
    const { captured, state } = read(runId);
    const used = db.prepare('SELECT COALESCE(SUM(length(CAST(document AS BLOB))+COALESCE(length(CAST(result AS BLOB)),0)),0) AS bytes FROM development_requests WHERE run=?').get(runId).bytes
      + db.prepare('SELECT COALESCE(SUM(length(CAST(document AS BLOB))),0) AS bytes FROM development_outputs WHERE run=?').get(runId).bytes;
    if (used + (replacesState ? 0 : Buffer.byteLength(canonicalJSON(state))) + Buffer.byteLength(canonicalJSON(value)) + reservedBytes > captured.logBytes) throw new Error('Captured Development log limit exhausted');
  }
  function executing(binding) {
    const value = bound(binding);
    if (value.state.state !== 'executing') throw new Error('Development step is not executing');
    return value;
  }
  return Object.freeze({
    create(run, settings) {
      canonicalJSON(run); canonicalJSON(settings); record(settings, ['pipeline', 'source', 'developer', 'skillsHash', 'issueHash', 'checks', 'logBytes']);
      validatePipeline(settings.pipeline, true); candidate(settings.source);
      record(settings.developer, ['id', 'connection', 'model']);
      if (settings.developer.id !== run.dev || !['codex', 'ollama'].includes(settings.developer.connection) || !text(settings.developer.model, 160)) throw new Error('Invalid captured Development model');
      if (!id(run.id) || !id(run.repository) || !id(run.dev) || !Number.isSafeInteger(run.issue) || run.issue < 1 || !Number.isSafeInteger(run.epoch) || run.epoch < 1
        || !Number.isSafeInteger(run.policyRevision) || run.policyRevision < 0 || !sha(run.policyHash) || run.pipelineHash !== hash(settings.pipeline) || !sha(settings.skillsHash) || !sha(settings.issueHash)
        || !Number.isSafeInteger(settings.logBytes) || settings.logBytes < 65536 || settings.logBytes > 50 * 1024 * 1024 || !Array.isArray(settings.checks) || !settings.checks.length || settings.checks.length > 32) throw new Error('Invalid captured Development binding');
      for (const check of settings.checks) { record(check, ['name', 'command']); if (!text(check.name, 240) || !text(check.command, 4096)) throw new Error('Invalid repository check'); }
      if (new Set(settings.checks.map(check => check.name)).size !== settings.checks.length) throw new Error('Duplicate repository check');
      const captured = { run: Object.fromEntries(['id', 'repository', 'issue', 'dev', 'policyRevision', 'policyHash', 'pipelineHash', 'limits'].map(key => [key, run[key]])), ...settings };
      for (const limit of ['limits.stepTurns', 'limits.issueTurns', 'limits.agentSeconds']) if (!Number.isSafeInteger(run.limits[limit]) || run.limits[limit] < 1) throw new Error('Invalid captured Development limit');
      return transact(db, () => {
        const previous = db.prepare('SELECT * FROM development_runs WHERE id=?').get(run.id);
        if (previous) { if (previous.captured_hash !== hash(captured)) throw new Error('Development run binding conflict'); return immutable(read(run.id).state); }
        const state = { runId: run.id, epoch: run.epoch, step: settings.pipeline.entry, state: 'ready', candidate: settings.source, visits: {}, retries: {}, visit: 0,
          turns: 0, stepTurns: 0, usage: { input: 0, output: 0, unavailable: false }, message: null };
        db.prepare('INSERT INTO development_runs VALUES(?,?,?,?,?)').run(run.id, canonicalJSON(captured), hash(captured), canonicalJSON(state), hash(state));
        return immutable(state);
      });
    },
    status: runId => immutable(read(runId).state),
    captured: runId => immutable(read(runId).captured),
    evidence(binding) { bound(binding); return requests(binding.runId); },
    outputs(runId) {
      read(runId); return db.prepare('SELECT * FROM development_outputs WHERE run=? ORDER BY visit').all(runId).map(row => {
        const data = JSON.parse(row.document); if (hash(data) !== row.hash) throw new Error('Development output integrity failed'); return immutable({ step: row.step, visit: row.visit, candidate: JSON.parse(row.candidate), output: data });
      });
    },
    begin(binding) {
      return transact(db, () => {
        const { captured, state } = bound(binding);
        if (state.state !== 'ready') throw new Error('Development blocked or requires pending-step recovery');
        const step = captured.pipeline.steps.find(step => step.id === state.step);
        if (!step) throw new Error('Development reached an unsupported boundary');
        if (['pm-qa', 'pr-integration'].includes(step.kind)) { state.state = 'candidate'; write(state); return immutable(state); }
        if (!['agent', 'check'].includes(step.kind)) throw new Error('Captured Development step capability unavailable');
        const visits = Object.hasOwn(state.visits, step.id) ? state.visits[step.id] : 0;
        if (visits >= step.visitLimit) throw new Error('Captured Development visit limit exhausted');
        state.visits[step.id] = visits + 1; state.visit++; state.stepTurns = 0; state.state = 'executing'; state.message = null;
        write(state); return immutable(state);
      });
    },
    turn(binding) {
      return transact(db, () => {
        const { captured, state } = executing(binding);
        if (state.turns >= captured.run.limits['limits.issueTurns'] || state.stepTurns >= captured.run.limits['limits.stepTurns']) throw new Error('Captured Development turn limit exhausted');
        state.turns++; state.stepTurns++; write(state); return immutable({ turns: state.turns, stepTurns: state.stepTurns });
      });
    },
    usage(binding, value) {
      record(value, ['input', 'output']);
      if (![value.input, value.output].every(v => v === null || Number.isSafeInteger(v) && v >= 0)) throw new Error('Invalid provider usage');
      return transact(db, () => { const { state } = bound(binding); for (const key of ['input', 'output']) { if (value[key] === null) state.usage.unavailable = true; else state.usage[key] += value[key]; } write(state); return immutable(state.usage); });
    },
    prepare(binding, requestId, kind, payload) {
      if (!id(requestId) || !['provider', 'source', 'implementation', 'command', 'tests', 'review', 'publication'].includes(kind)) throw new Error('Invalid Development request kind');
      canonicalJSON(payload);
      return transact(db, () => {
        const { state } = executing(binding), data = { id: requestId, runId: binding.runId, epoch: binding.epoch, step: state.step, visit: state.visit, kind, candidate: state.candidate, payload };
        const previous = db.prepare('SELECT * FROM development_requests WHERE run=? AND id=?').get(binding.runId, requestId);
        if (previous) { if (previous.hash !== hash(data)) throw new Error('Development request binding conflict'); return request(previous); }
        // Reserve the bounded reply before dispatch; a full log cannot strand a new effect.
        quota(binding.runId, data, ['implementation', 'command', 'tests'].includes(kind) ? 131072 : 524288);
        db.prepare("INSERT INTO development_requests VALUES(?,?,?,?,'prepared',NULL,NULL)").run(binding.runId, requestId, canonicalJSON(data), hash(data));
        return request(db.prepare('SELECT * FROM development_requests WHERE run=? AND id=?').get(binding.runId, requestId));
      });
    },
    dispatch(binding, requestId) {
      return transact(db, () => {
        const { state } = executing(binding), value = request(db.prepare('SELECT * FROM development_requests WHERE run=? AND id=?').get(binding.runId, requestId));
        if (value.epoch !== binding.epoch || value.step !== state.step || value.visit !== state.visit) throw new Error('Stale Development request epoch or step');
        if (value.state !== 'prepared') return false;
        if (requests(binding.runId).some(other => other.id !== requestId && ['dispatched', 'uncertain'].includes(other.state))) throw new Error('Pending Development request needs recovery');
        return db.prepare("UPDATE development_requests SET state='dispatched' WHERE run=? AND id=? AND state='prepared'").run(binding.runId, requestId).changes === 1;
      });
    },
    finish(binding, requestId, value, state = 'verified') {
      record(value, ['candidate', 'result']); candidate(value.candidate); canonicalJSON(value);
      if (!['verified', 'denied', 'uncertain'].includes(state)) throw new Error('Invalid Development request outcome');
      return transact(db, () => {
        const current = bound(binding), before = request(db.prepare('SELECT * FROM development_requests WHERE run=? AND id=?').get(binding.runId, requestId));
        if (before.epoch !== binding.epoch || !['dispatched', 'uncertain'].includes(before.state)) throw new Error('Development request epoch or state conflict');
        if (canonicalJSON(value.candidate) !== canonicalJSON(current.state.candidate)) throw new Error('Development result candidate changed');
        quota(binding.runId, value);
        db.prepare('UPDATE development_requests SET state=?,result=?,result_hash=? WHERE run=? AND id=?').run(state, canonicalJSON(value), hash(value), binding.runId, requestId);
        return request(db.prepare('SELECT * FROM development_requests WHERE run=? AND id=?').get(binding.runId, requestId));
      });
    },
    setCandidate(binding, value) { candidate(value); return transact(db, () => { const { state } = bound(binding);
      if (canonicalJSON(value) !== canonicalJSON(state.candidate)) { state.qa = null; state.integration = null; }
      state.candidate = value; write(state); return immutable(state); }); },
    offerQA(binding, showcase) {
      canonicalJSON(showcase); candidate(showcase.candidate);
      return transact(db, () => {
        const { captured, state } = bound(binding), step = captured.pipeline.steps.find(step => step.id === state.step);
        if (state.state !== 'candidate' || step?.kind !== 'pm-qa' || showcase.candidate.gitTree !== state.candidate.gitTree
          || !showcaseComplete(showcase, ['sourceCommit', 'gitTree'], showcase.candidate, 'Approved', { issue: captured.run.issue })) throw new Error('Current Development Showcase unavailable');
        const fingerprint = hash(showcase);
        if (state.qa?.hash === fingerprint) return immutable(state.qa);
        const visits = Object.hasOwn(state.visits, step.id) ? state.visits[step.id] : 0;
        if (visits >= step.visitLimit) throw new Error('Captured Development QA visit limit exhausted');
        state.visits[step.id] = visits + 1;
        state.qa = { hash: fingerprint, step: step.id, showcase, decision: null }; write(state); return immutable(state.qa);
      });
    },
    decideQA(binding, value) {
      record(value, ['inputId', 'hash', 'decision', 'text']);
      if (!id(value.inputId) || !sha(value.hash) || !['approve', 'feedback'].includes(value.decision) || !text(value.text, 2000)) throw new Error('Invalid Development PM decision');
      return transact(db, () => {
        const { captured, state } = bound(binding), step = captured.pipeline.steps.find(step => step.id === state.step);
        if (state.state !== 'candidate' || step?.kind !== 'pm-qa' || !state.qa || state.qa.decision || state.qa.hash !== value.hash
          || state.qa.showcase.candidate.gitTree !== state.candidate.gitTree) throw new Error('Development Showcase changed or decision is not pending');
        if (state.qaHistory?.some(row => row.inputId === value.inputId)) throw new Error('Duplicate Development PM decision');
        const decision = { ...value, epoch: binding.epoch, step: state.step, candidate: state.qa.showcase.candidate };
        state.qaHistory = [...(state.qaHistory ?? []), decision];
        state.step = step.routes[value.decision === 'approve' ? 'success' : 'feedback'];
        if (value.decision === 'approve') { state.qa.decision = 'approve'; state.qa.inputId = value.inputId; state.state = 'candidate'; }
        else { state.feedback = decision; state.qa = null; state.integration = null; state.state = state.step === 'blocked' ? 'blocked' : 'ready'; }
        state.message = value.decision === 'approve' ? 'Current tested candidate approved for the disclosed outcome.' : value.text;
        write(state); return immutable(state);
      });
    },
    recordIntegration(binding, value) {
      record(value, ['candidate', 'source', 'resultHash', 'pullRequest']); candidate(value.candidate); candidate(value.source);
      if (!sha(value.resultHash) || !Number.isSafeInteger(value.pullRequest) || value.pullRequest < 1) throw new Error('Invalid Development integration');
      return transact(db, () => {
        const { captured, state } = bound(binding), step = captured.pipeline.steps.find(step => step.id === state.step);
        if (state.state !== 'candidate' || step?.kind !== 'pr-integration' || step.routes.success !== 'complete' || value.candidate.gitTree !== state.candidate.gitTree
          || !state.qa || state.qa.decision !== 'approve' || canonicalJSON(value.source) !== canonicalJSON(state.qa.showcase.candidate)) throw new Error('Development integration does not match the approved candidate');
        state.integration = value; write(state); return immutable(value);
      });
    },
    complete(binding, resultHash) {
      return transact(db, () => { const { state } = bound(binding);
        if (state.state !== 'candidate' || !state.integration || state.integration.resultHash !== resultHash) throw new Error('Verified Development integration required for completion');
        state.state = 'complete'; state.step = 'complete'; state.message = 'Verified integration and source-only closeout complete.'; write(state); return immutable(state);
      });
    },
    advance(binding, result) {
      validateDevelopmentOutput(result);
      return transact(db, () => {
        const { captured, state } = executing(binding), step = captured.pipeline.steps.find(step => step.id === state.step), records = requests(binding.runId);
        if (records.some(value => ['prepared', 'dispatched', 'uncertain'].includes(value.state))) throw new Error('Pending Development evidence needs recovery');
        const evidence = result.evidence.map(reference => {
          const value = records.find(value => value.id === reference && value.state === 'verified' && value.kind !== 'provider');
          if (!value) throw new Error('Unknown or unverified Development evidence');
          if (canonicalJSON(value.result.candidate) !== canonicalJSON(state.candidate)) throw new Error('Development evidence candidate changed');
          return value;
        });
        if (result.outcome === 'success') {
          if (!evidence.length) throw new Error('Development success requires verified evidence');
          if (result.findings.some(value => ['high', 'critical'].includes(value.severity))) throw new Error('Unresolved scoped review findings');
          for (const required of step.evidence) {
            if (required === 'verified-result') continue;
            if (!['tests', 'review', 'implementation'].includes(required) || !evidence.some(value => value.kind === required)) throw new Error('Required Development evidence unavailable');
          }
          if (step.kind === 'check') for (const check of captured.checks) {
            if (!evidence.some(value => value.kind === 'tests' && value.result.result?.name === check.name && value.result.result.command === check.command && value.result.result.exitCode === 0)) throw new Error('Repository check has no passing test evidence');
          }
        }
        quota(binding.runId, result);
        db.prepare('INSERT INTO development_outputs VALUES(?,?,?,?,?,?)').run(binding.runId, state.visit, state.step, canonicalJSON(state.candidate), canonicalJSON(result), hash(result));
        const retries = Object.hasOwn(state.retries, state.step) ? state.retries[state.step] : 0;
        if (result.outcome === 'failure' && retries < step.retryLimit) { state.retries[state.step] = retries + 1; state.state = 'ready'; }
        else { state.step = step.routes[result.outcome]; state.state = state.step === 'blocked' ? 'blocked' : state.step === 'complete' ? 'integration-required' : 'ready'; }
        state.message = result.summary; write(state); return immutable(state);
      });
    },
    rebind(runId, epoch) {
      return transact(db, () => {
        const { state } = read(runId);
        if (!Number.isSafeInteger(epoch) || epoch <= state.epoch || requests(runId).some(value => ['prepared', 'dispatched', 'uncertain'].includes(value.state))) throw new Error('Development epoch recovery unresolved');
        state.epoch = epoch; write(state); return immutable(state);
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
