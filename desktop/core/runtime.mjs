import { randomUUID, createHash } from 'node:crypto';
import { backupDatabase } from './storage.mjs';
import { canonicalJSON, immutable, record } from './settings.mjs';
import { workspaceData } from './identity.mjs';

const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const activeStatuses = ['In Progress', 'In Review', 'Pending Review'];
const operations = { 'workspace.write': 'workspace.write', 'git.push': 'git.push', 'github.issue.write': 'github.issue.write', 'github.pr.write': 'github.pr.write', 'github.pr.merge': 'github.pr.write', 'github.project.write': 'github.project.write', 'artifact.publish': 'artifact.publish' };
const pending = "('prepared','dispatched','uncertain')";
export function transact(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) {
    if (db.isTransaction) { try { db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Database failure; rollback could not be verified'); } }
    throw error;
  }
}
const schema = `CREATE TABLE runtime_repositories (id TEXT PRIMARY KEY, host TEXT NOT NULL, slug TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, UNIQUE(host,slug));
  CREATE TABLE runtime_clock (id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL);
  INSERT INTO runtime_clock VALUES(1,0);
  CREATE TABLE runtime_workspaces (local_key TEXT PRIMARY KEY, common_path TEXT NOT NULL UNIQUE, repository TEXT NOT NULL REFERENCES runtime_repositories(id));
  CREATE TABLE runtime_runs (id TEXT PRIMARY KEY, repository TEXT NOT NULL REFERENCES runtime_repositories(id), issue INTEGER NOT NULL, dev TEXT NOT NULL, policy_revision INTEGER NOT NULL REFERENCES policy_versions(revision), policy_hash TEXT NOT NULL, pipeline TEXT NOT NULL, pipeline_hash TEXT NOT NULL, limits TEXT NOT NULL, epoch INTEGER NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, control TEXT NOT NULL, created_at INTEGER NOT NULL, released_at INTEGER);
  CREATE UNIQUE INDEX one_repository_reservation ON runtime_runs(repository) WHERE released_at IS NULL;
  CREATE TABLE runtime_commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runtime_runs(id));
  CREATE TABLE runtime_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runtime_runs(id), command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, dispatch_epoch INTEGER NOT NULL, deadline_at INTEGER NOT NULL, observation_hash TEXT, result_hash TEXT, updated_at INTEGER NOT NULL, UNIQUE(run_id,command_id));
  CREATE UNIQUE INDEX one_pending_mutation ON runtime_actions(run_id) WHERE state IN ${pending};
  CREATE TRIGGER immutable_run_binding BEFORE UPDATE OF repository,issue,dev,policy_revision,policy_hash,pipeline,pipeline_hash,limits,created_at ON runtime_runs BEGIN SELECT RAISE(ABORT,'Immutable run binding'); END;
  CREATE TRIGGER immutable_action_binding BEFORE UPDATE OF id,run_id,command_id,fingerprint,binding,deadline_at ON runtime_actions BEGIN SELECT RAISE(ABORT,'Immutable action binding'); END;
  PRAGMA user_version=2;`;

export function migrateRuntime(db, directory, transaction, fresh) {
  if (db.prepare('PRAGMA user_version').get().user_version === 2) return;
  if (!fresh) backupDatabase(db, directory, 'policy', 1, backup => backup.prepare('SELECT COUNT(*) AS count FROM policy_versions').get().count > 0);
  transaction(() => { if (db.prepare('PRAGMA user_version').get().user_version === 1) db.exec(schema); });
}

// Only the trusted host receives this object. Inspectors perform typed complete readback.
export function createRuntime(db, { transaction: commit, policy, clock: wallClock, inspectors = {} }) {
  const session = randomUUID();
  const clock = () => {
    const value = wallClock();
    if (!Number.isSafeInteger(value) || value < db.prepare('SELECT last_seen FROM runtime_clock WHERE id=1').get().last_seen) throw new Error('Host clock moved backwards; dispatch requires recovery');
    return value;
  };
  const transaction = fn => commit(() => { db.prepare('UPDATE runtime_clock SET last_seen=? WHERE id=1').run(clock()); return fn(); });
  function validateRun(run) {
    const captured = policy.read(run.repository, run.policy_revision);
    const limits = Object.fromEntries(Object.entries(captured.values).filter(([key]) => key.startsWith('limits.')).map(([key, value]) => [key, value.value]));
    if (!['development', 'release'].includes(run.pipeline) || captured.hash !== run.policy_hash || captured.values['agents.dev'].value !== run.dev
      || canonicalJSON(limits) !== run.limits || digest(captured.values[`pipelines.${run.pipeline}`].value) !== run.pipeline_hash || !Number.isSafeInteger(run.epoch) || run.epoch < 1
      || !['running', 'pause-requested', 'stop-requested', 'paused', 'stopped', 'complete'].includes(run.control)
      || !(run.released_at === null ? activeStatuses : ['Backlog', 'On Hold', 'Done']).includes(run.status)) throw new Error('Captured run integrity check failed');
  }
  function runFor(binding, owner = false) {
    canonicalJSON(binding); record(binding, ['runId', 'epoch']);
    if (!identifier(binding.runId) || !Number.isSafeInteger(binding.epoch) || binding.epoch < 1) throw new Error('Invalid run binding');
    const run = db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(binding.runId);
    if (!run || run.epoch !== binding.epoch) throw new Error('Stale worker epoch');
    if (run.released_at !== null) throw new Error('Repository reservation released');
    if (owner && run.owner !== session) throw new Error('Host session requires recovery');
    validateRun(run);
    return run;
  }
  function visible(run) {
    validateRun(run);
    return immutable({ id: run.id, repository: run.repository, issue: run.issue, dev: run.dev, policyRevision: run.policy_revision, policyHash: run.policy_hash,
      pipeline: run.pipeline, pipelineHash: run.pipeline_hash, limits: JSON.parse(run.limits), epoch: run.epoch, status: run.status,
      control: run.owner !== session && ['running', 'pause-requested', 'stop-requested'].includes(run.control) ? 'recovery-required' : run.control,
      createdAt: run.created_at, releasedAt: run.released_at,
      pendingAction: (() => { const action = db.prepare(`SELECT id FROM runtime_actions WHERE run_id=? AND state IN ${pending} LIMIT 1`).get(run.id); return action ? actionData(action.id, run).value : null; })() });
  }
  function fresh(observedAt) { if (!Number.isSafeInteger(observedAt) || observedAt > clock() || observedAt < clock() - 30000) throw new Error('Stale readback'); }
  async function repositoryRead(repository, issue) {
    if (typeof inspectors.repository !== 'function') throw new Error('Repository readback unavailable');
    const observation = await inspectors.repository(immutable({ repository, issue })); canonicalJSON(observation);
    record(observation, ['repository', 'issue', 'status', 'state', 'active', 'observedAt'], ['integration']); fresh(observation.observedAt);
    if (observation.repository !== repository || observation.issue !== issue || !['OPEN', 'CLOSED'].includes(observation.state) || !Array.isArray(observation.active)
      || observation.active.length > 100 || new Set(observation.active.map(v => v.issue)).size !== observation.active.length) throw new Error('Repository readback binding mismatch');
    for (const item of observation.active) { record(item, ['issue', 'status']); if (!Number.isSafeInteger(item.issue) || item.issue < 1 || !activeStatuses.includes(item.status)) throw new Error('Invalid active Issue readback'); }
    if (observation.integration !== undefined) {
      record(observation.integration, ['candidate', 'resultHash']); record(observation.integration.candidate, ['sourceCommit', 'gitTree']);
      if (!sha(observation.integration.resultHash) || !Object.values(observation.integration.candidate).every(v => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v))) throw new Error('Invalid integration readback');
    }
    return observation;
  }
  function activeRead(observation) {
    if (observation.state !== 'OPEN' || !activeStatuses.includes(observation.status) || observation.active.length !== 1 || observation.active[0].issue !== observation.issue
      || observation.active[0].status !== observation.status) throw new Error('Conflicting or missing active Issue readback');
  }
  async function stopped(run) {
    if (typeof inspectors.worker !== 'function') throw new Error('Worker termination readback unavailable');
    const value = await inspectors.worker(immutable({ runId: run.id, epoch: run.epoch })); canonicalJSON(value); record(value, ['runId', 'epoch', 'state', 'observedAt']); fresh(value.observedAt);
    if (value.runId !== run.id || value.epoch !== run.epoch || value.state !== 'stopped') throw new Error('Former worker not verified stopped');
  }
  function actionData(id, run) {
    if (!identifier(id)) throw new Error('Invalid action identity');
    const row = db.prepare('SELECT * FROM runtime_actions WHERE id=? AND run_id=?').get(id, run.id); if (!row) throw new Error('Unknown action');
    const binding = JSON.parse(row.binding); if (digest(binding) !== row.fingerprint || binding.runId !== run.id || binding.repository !== run.repository || binding.issue !== run.issue
      || !['prepared', 'dispatched', 'uncertain', 'verified', 'absent', 'denied', 'failed', 'cancelled'].includes(row.state) || !Number.isSafeInteger(row.attempts) || row.attempts < 0) throw new Error('Action integrity check failed');
    return { row, binding, value: immutable({ id: row.id, ...binding, fingerprint: row.fingerprint, state: row.state, attempts: row.attempts, dispatchEpoch: row.dispatch_epoch,
      deadlineAt: row.deadline_at, observationHash: row.observation_hash, resultHash: row.result_hash, recordedAt: row.updated_at }) };
  }
  function authority(run, operation) {
    const grant = policy.authority(run.repository, run.policy_revision);
    if (grant.dev !== run.dev || !grant.capabilities.includes(operations[operation])) throw new Error('Captured action authority unavailable or revoked');
  }
  function runnable(binding) { const run = runFor(binding, true); if (run.control !== 'running') throw new Error('Run paused, stopped or recovery-required'); return run; }
  function uncertain(run) { return db.prepare(`SELECT id FROM runtime_actions WHERE run_id=? AND state IN ('dispatched','uncertain') LIMIT 1`).get(run.id); }
  return Object.freeze({
    async reserve(identity, request) {
      const workspace = workspaceData(identity); canonicalJSON(request); record(request, ['commandId', 'issue', 'pipeline']);
      if (!identifier(request.commandId) || !Number.isSafeInteger(request.issue) || request.issue < 1 || !['development', 'release'].includes(request.pipeline)) throw new Error('Invalid reservation request');
      const observation = await repositoryRead(workspace.repository, request.issue); activeRead(observation);
      return transaction(() => {
        fresh(observation.observedAt);
        const fingerprint = digest({ repository: workspace.repository, ...request }), previous = db.prepare('SELECT * FROM runtime_commands WHERE id=?').get(request.commandId);
        if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('Reservation command identity conflict'); return immutable({ created: false, run: visible(db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(previous.run_id)) }); }
        const captured = policy.read(workspace.repository), grant = policy.authority(workspace.repository, captured.revision);
        if (!grant.dev || captured.values['agents.dev'].value !== grant.dev) throw new Error('Configured Dev unavailable');
        const existingRepository = db.prepare('SELECT * FROM runtime_repositories WHERE id=? OR (host=? AND slug=?)').all(workspace.repository, workspace.host, workspace.slug);
        if (existingRepository.some(r => r.id !== workspace.repository || r.host !== workspace.host || r.slug !== workspace.slug)) throw new Error('Canonical remote identity conflict');
        const aliases = db.prepare('SELECT * FROM runtime_workspaces WHERE local_key=? OR common_path=?').all(workspace.localKey, workspace.commonPath);
        if (aliases.some(a => a.repository !== workspace.repository || a.local_key !== workspace.localKey || a.common_path !== workspace.commonPath)) throw new Error('Local filesystem identity changed');
        db.prepare('INSERT INTO runtime_repositories(id,host,slug) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(workspace.repository, workspace.host, workspace.slug);
        db.prepare('INSERT INTO runtime_workspaces VALUES(?,?,?) ON CONFLICT(local_key) DO NOTHING').run(workspace.localKey, workspace.commonPath, workspace.repository);
        let run = db.prepare('SELECT * FROM runtime_runs WHERE repository=? AND released_at IS NULL').get(workspace.repository), created = false;
        if (run && (run.issue !== request.issue || run.pipeline !== request.pipeline)) throw new Error('Repository already reserved by another Issue or pipeline');
        if (!run) {
          const epoch = db.prepare('UPDATE runtime_repositories SET epoch=epoch+1 WHERE id=? RETURNING epoch').get(workspace.repository).epoch;
          const limits = Object.fromEntries(Object.entries(captured.values).filter(([key]) => key.startsWith('limits.')).map(([key, value]) => [key, value.value]));
          const id = randomUUID(), pipeline = captured.values[`pipelines.${request.pipeline}`].value;
          db.prepare("INSERT INTO runtime_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'running',?,NULL)").run(id, workspace.repository, request.issue, grant.dev, captured.revision, captured.hash, request.pipeline, digest(pipeline), canonicalJSON(limits), epoch, session, observation.status, clock());
          run = db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(id); created = true;
        } else { db.prepare('UPDATE runtime_runs SET status=? WHERE id=?').run(observation.status, run.id); run.status = observation.status; }
        db.prepare('INSERT INTO runtime_commands VALUES(?,?,?)').run(request.commandId, fingerprint, run.id);
        return immutable({ created, run: visible(run) });
      });
    },
    status(repository) { if (!identifier(repository)) throw new Error('Invalid repository identity'); const run = db.prepare('SELECT * FROM runtime_runs WHERE repository=? AND released_at IS NULL').get(repository); return run ? visible(run) : null; },
    intent(binding, request) {
      canonicalJSON(request); record(request, ['commandId', 'step', 'operation', 'candidate', 'requestHash', 'preconditionsHash', 'expectedHash']); record(request.candidate, ['sourceCommit', 'gitTree']);
      if (!identifier(request.commandId) || !identifier(request.step) || !Object.hasOwn(operations, request.operation) || !['requestHash', 'preconditionsHash', 'expectedHash'].every(k => sha(request[k]))
        || !Object.values(request.candidate).every(v => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v))) throw new Error('Invalid typed action intent');
      return transaction(() => {
        const run = runnable(binding), bound = { runId: run.id, repository: run.repository, issue: run.issue, ...request }, fingerprint = digest({ ...bound, epoch: run.epoch });
        const prior = db.prepare('SELECT id FROM runtime_actions WHERE run_id=? AND command_id=?').get(run.id, request.commandId);
        if (prior) { const action = actionData(prior.id, run); if (digest({ ...bound, epoch: action.binding.epoch }) !== action.row.fingerprint) throw new Error('Action command identity conflict'); return action.value; }
        if (db.prepare(`SELECT id FROM runtime_actions WHERE run_id=? AND state IN ${pending} LIMIT 1`).get(run.id)) throw new Error('Pending or uncertain mutation must reconcile first');
        const step = policy.read(run.repository, run.policy_revision).values[`pipelines.${run.pipeline}`].value.steps.find(s => s.id === request.step);
        if (!step || request.operation === 'github.pr.merge' && step.kind !== 'pr-integration') throw new Error('Action does not match captured pipeline step');
        authority(run, request.operation);
        const limits = JSON.parse(run.limits), deadline = clock() + limits[`limits.${['build', 'artifact-verify'].includes(step.kind) ? 'build' : request.operation.startsWith('github.') || request.operation === 'git.push' ? 'control' : 'agent'}Seconds`] * 1000, id = randomUUID();
        db.prepare("INSERT INTO runtime_actions VALUES(?,?,?,?,?,'prepared',0,?,?,NULL,NULL,?)").run(id, run.id, request.commandId, fingerprint, canonicalJSON({ ...bound, epoch: run.epoch }), run.epoch, deadline, clock());
        return actionData(id, run).value;
      });
    },
    dispatch(binding, id) {
      return transaction(() => {
        const run = runnable(binding), action = actionData(id, run);
        if (action.row.state !== 'prepared') return immutable({ dispatched: false, action: action.value });
        if (action.row.dispatch_epoch !== run.epoch) throw new Error('Stale action dispatch epoch');
        if (action.row.deadline_at <= clock() || action.row.attempts >= JSON.parse(run.limits)['limits.transientAttempts']) throw new Error('Action deadline or attempts exhausted');
        authority(run, action.binding.operation);
        db.prepare("UPDATE runtime_actions SET state='dispatched',attempts=attempts+1,updated_at=? WHERE id=?").run(clock(), id);
        return immutable({ dispatched: true, action: actionData(id, run).value });
      });
    },
    async reconcile(binding, id) {
      const run = runFor(binding), action = actionData(id, run);
      if (['verified', 'denied', 'failed', 'cancelled'].includes(action.row.state)) return action.value;
      if (!['dispatched', 'uncertain', 'absent'].includes(action.row.state)) throw new Error('Action has not been dispatched');
      if (run.owner !== session) await stopped(run);
      if (typeof inspectors.effect !== 'function') throw new Error('Effect readback unavailable');
      const value = await inspectors.effect(action.value); canonicalJSON(value);
      const keys = ['runId', 'repository', 'issue', 'step', 'epoch', 'operation', 'candidate', 'commandId', 'requestHash', 'preconditionsHash', 'expectedHash'];
      record(value, [...keys, 'fingerprint', 'attempts', 'dispatchEpoch', 'result', 'resultHash', 'observationHash', 'observedAt']); fresh(value.observedAt);
      if (value.fingerprint !== action.row.fingerprint || keys.some(key => canonicalJSON(value[key]) !== canonicalJSON(action.binding[key])) || !sha(value.observationHash)
        || value.attempts !== action.row.attempts || value.dispatchEpoch !== action.row.dispatch_epoch
        || !['present', 'absent', 'denied', 'permanent', 'unknown'].includes(value.result) || (value.result === 'present' ? !sha(value.resultHash) || value.resultHash !== action.binding.expectedHash : value.resultHash !== null)) throw new Error('Readback does not prove the expected bound effect');
      return transaction(() => {
        runFor(binding); fresh(value.observedAt);
        const current = actionData(id, run); if (current.row.state !== action.row.state || current.row.attempts !== action.row.attempts) throw new Error('Action changed during readback');
        const state = { present: 'verified', absent: 'absent', denied: 'denied', permanent: 'failed', unknown: 'uncertain' }[value.result];
        db.prepare('UPDATE runtime_actions SET state=?,observation_hash=?,result_hash=?,updated_at=? WHERE id=?').run(state, value.observationHash, value.resultHash, clock(), id);
        return actionData(id, run).value;
      });
    },
    async retry(binding, id) {
      const run = runnable(binding), action = actionData(id, run);
      if (action.row.state !== 'absent') throw new Error('Retry requires verified absence; denial and permanent failures cannot retry');
      if (action.row.deadline_at <= clock() || action.row.attempts >= JSON.parse(run.limits)['limits.transientAttempts']) throw new Error('Action deadline or attempts exhausted');
      const result = await this.reconcile(binding, id); if (result.state !== 'absent') throw new Error('Fresh readback does not verify absence');
      return transaction(() => { const current = runnable(binding); authority(current, action.binding.operation); if (uncertain(current)) throw new Error('Uncertain mutation');
        if (actionData(id, current).row.state !== 'absent') throw new Error('Action changed during retry');
        if (action.row.deadline_at <= clock() || action.row.attempts >= JSON.parse(current.limits)['limits.transientAttempts']) throw new Error('Action deadline or attempts exhausted');
        db.prepare("UPDATE runtime_actions SET state='prepared',dispatch_epoch=?,updated_at=? WHERE id=?").run(current.epoch, clock(), id); return actionData(id, current).value; });
    },
    requestControl(binding, operation) {
      if (!['pause', 'stop'].includes(operation)) throw new Error('Invalid control request');
      // Trusted local cancellation may fence a previous session; it never grants dispatch authority.
      return transaction(() => { const run = runFor(binding); db.prepare('UPDATE runtime_runs SET control=? WHERE id=?').run(`${operation}-requested`, run.id); return immutable({ received: true, verified: false, requested: operation }); });
    },
    async verifyControl(binding) {
      const run = runFor(binding); if (!['pause-requested', 'stop-requested'].includes(run.control)) throw new Error('No pending control request'); await stopped(run);
      return transaction(() => { const current = runFor(binding); if (current.control !== run.control) throw new Error('Control request changed');
        db.prepare('UPDATE runtime_runs SET control=? WHERE id=?').run(run.control === 'pause-requested' ? 'paused' : 'stopped', run.id);
        db.prepare("UPDATE runtime_actions SET state='cancelled',updated_at=? WHERE run_id=? AND state='prepared'").run(clock(), run.id); return immutable({ verified: true, run: visible(db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(run.id)) }); });
    },
    async resume(binding) {
      const run = runFor(binding); if (run.owner === session && run.control === 'running') throw new Error('Run already running'); if (uncertain(run)) throw new Error('Uncertain mutation requires reconciliation before resume');
      const observation = await repositoryRead(run.repository, run.issue); activeRead(observation); await stopped(run);
      return transaction(() => { const current = runFor(binding); fresh(observation.observedAt); if (uncertain(current)) throw new Error('Uncertain mutation');
        if (policy.authority(current.repository, current.policy_revision).dev !== current.dev) throw new Error('Captured Dev unavailable');
        const epoch = db.prepare('UPDATE runtime_repositories SET epoch=epoch+1 WHERE id=? RETURNING epoch').get(run.repository).epoch;
        db.prepare("UPDATE runtime_actions SET state='cancelled',updated_at=? WHERE run_id=? AND state='prepared'").run(clock(), run.id);
        db.prepare("UPDATE runtime_runs SET epoch=?,owner=?,control='running',status=? WHERE id=?").run(epoch, session, observation.status, run.id); return visible(db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(run.id)); });
    },
    async release(binding) {
      const run = runFor(binding); if (!['paused', 'stopped'].includes(run.control) || uncertain(run)) throw new Error('Stopped verification and resolved uncertainty required for release');
      const observation = await repositoryRead(run.repository, run.issue); await stopped(run);
      if (observation.active.length || !['Backlog', 'On Hold', 'Done'].includes(observation.status) || (observation.status === 'Done') !== (observation.state === 'CLOSED')) throw new Error('Verified inactive Issue readback required');
      return transaction(() => { const current = runFor(binding); fresh(observation.observedAt); if (uncertain(current)) throw new Error('Uncertain mutation');
        const latestSourceEffect = db.prepare("SELECT id FROM runtime_actions WHERE run_id=? AND state='verified' AND json_extract(binding,'$.operation') IN ('workspace.write','git.push','github.pr.write','github.pr.merge') ORDER BY rowid DESC LIMIT 1").get(run.id);
        const integration = latestSourceEffect ? actionData(latestSourceEffect.id, current) : null;
        if (observation.status === 'Done' && (current.pipeline !== 'development' || integration?.binding.operation !== 'github.pr.merge' || !observation.integration
          || canonicalJSON(observation.integration.candidate) !== canonicalJSON(integration.binding.candidate) || observation.integration.resultHash !== integration.row.result_hash)) throw new Error('Verified captured PR integration required before completion');
        db.prepare('UPDATE runtime_runs SET status=?,control=?,released_at=? WHERE id=?').run(observation.status, observation.status === 'Done' ? 'complete' : 'stopped', clock(), run.id); return visible(db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(run.id)); });
    },
  });
}
