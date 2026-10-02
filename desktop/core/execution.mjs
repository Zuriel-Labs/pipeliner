import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, fstatSync, fsyncSync, writeFileSync, readFileSync, lstatSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { protectedFile } from './storage.mjs';
import { canonicalJSON, immutable, record } from './settings.mjs';
import { workspaceData, workspaceCandidate } from './identity.mjs';
import { transact } from './runtime.mjs';
import { openWorkerEnvironment, restrictedWorkerArgs } from './worker.mjs';

const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const filename = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
const failure = error => typeof error.message === 'string' && /^[A-Za-z][A-Za-z ;,-]{0,159}$/.test(error.message) ? error.message : 'Execution could not be verified; local recovery required';

// ponytail: one trusted broker per local app store; it may supervise several repository slots.
export function acquireExecutionOwner(directory) {
  const path = protectedFile(directory, 'owner.sqlite');
  // Qualified local filesystems only. SQLite advisory locks do not qualify network storage.
  if (![26, 17, 1, 0xef53, 0x794c7630].includes(statfsSync(directory).type)) throw new Error('Execution owner requires qualified local storage');
  const db = new DatabaseSync(path, { allowExtension: false, timeout: 0 });
  try { db.exec('PRAGMA journal_mode=DELETE; PRAGMA trusted_schema=OFF; BEGIN EXCLUSIVE;'); }
  catch { db.close(); throw new Error('Execution owner unavailable'); }
  let closed = false;
  return Object.freeze({ close() { if (!closed) { db.close(); closed = true; } } });
}

export function openExecutionSupervisor(directory, { store }) {
  const owner = acquireExecutionOwner(directory);
  let db, environment, closed = false, foregroundPausing = false, foregroundError = null;
  try {
    db = new DatabaseSync(protectedFile(directory, 'execution.sqlite'), { allowExtension: false, timeout: 1000 });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version)) throw new Error('Unsupported execution inventory');
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (!version) transact(db, () => {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('Unrecognized execution inventory');
      db.exec(`CREATE TABLE workers(run_id TEXT NOT NULL, epoch INTEGER NOT NULL, repository TEXT NOT NULL, document TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, cid TEXT, error TEXT, PRIMARY KEY(run_id,epoch));
        CREATE UNIQUE INDEX one_execution ON workers(repository) WHERE state NOT IN ('stopped','exited');
        CREATE TABLE effects(command_id TEXT PRIMARY KEY, document TEXT NOT NULL, hash TEXT NOT NULL);
        CREATE TRIGGER immutable_worker BEFORE UPDATE OF run_id,epoch,repository,document,hash ON workers BEGIN SELECT RAISE(ABORT,'Immutable worker binding'); END;
        CREATE TRIGGER immutable_effect BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT,'Immutable effect binding'); END;
        PRAGMA user_version=1;`);
    });
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Execution inventory integrity failed');
    environment = openWorkerEnvironment(directory);
  } catch (error) { db?.close(); owner.close(); throw error; }
  const identities = new Map(), inFlight = new Map(), pendingControls = new Map();
  let monitorWork = null;
  const requireOpen = () => { if (closed) throw new Error('Execution supervisor closed'); };
  function rowFor(binding) {
    const row = db.prepare('SELECT * FROM workers WHERE run_id=? AND epoch=?').get(binding.runId, binding.epoch);
    if (!row) return null;
    const data = JSON.parse(row.document);
    if (digest(data) !== row.hash || data.manifest.runId !== row.run_id || data.manifest.epoch !== row.epoch || data.manifest.repository !== row.repository
      || !['starting', 'created', 'running', 'exited', 'stopping', 'stopped', 'blocked'].includes(row.state)) throw new Error('Execution resource integrity failed');
    return { ...row, data };
  }
  function update(binding, state, cid, error = null) { transact(db, () => db.prepare('UPDATE workers SET state=?,cid=?,error=? WHERE run_id=? AND epoch=?').run(state, cid, error, binding.runId, binding.epoch)); }
  function current(binding, running = false) {
    requireOpen(); record(binding, ['runId', 'epoch']);
    if (typeof binding.runId !== 'string' || !Number.isSafeInteger(binding.epoch)) throw new Error('Invalid execution binding');
    const repository = db.prepare('SELECT repository FROM workers WHERE run_id=? ORDER BY epoch DESC LIMIT 1').get(binding.runId)?.repository;
    const run = repository ? store.runtime.status(repository) : [...identities.keys()].map(repo => store.runtime.status(repo)).find(value => value?.id === binding.runId);
    if (!run || run.id !== binding.runId || run.epoch !== binding.epoch) throw new Error('Stale execution epoch');
    if (running && (foregroundPausing || run.control !== 'running')) throw new Error('Execution paused, stopped or recovery-required');
    if (running) { const authority = store.worker.authority(run.repository, run.policyRevision); if (authority.dev !== run.dev || !authority.capabilities.includes('worker.exec')) throw new Error('Execution authority unavailable or revoked'); }
    return run;
  }
  function candidateCheck(identity, candidate) { if (canonicalJSON(workspaceCandidate(identity)) !== canonicalJSON(candidate)) throw new Error('Execution candidate changed'); }
  async function termination(binding) {
    const row = rowFor(binding); if (!row) return;
    update(binding, 'stopping', row.cid);
    try {
      const result = await environment.terminate(row.data.manifest, row.state === 'stopped' ? null : row.cid);
      await environment.remove(row.data.manifest, result.id);
      update(binding, 'stopped', row.cid ?? result.id);
    } catch (error) { update(binding, 'blocked', row.cid, failure(error)); throw error; }
  }
  async function reconcilePending(binding) {
    const run = current(binding), action = run.pendingAction;
    if (action && ['dispatched', 'uncertain'].includes(action.state)) {
      const result = await store.runtime.reconcile(binding, action.id);
      if (result.state === 'uncertain') throw new Error('Worker stopped; effect recovery remains unresolved');
    }
  }
  const supervisor = {
    attach(identity) { requireOpen(); const workspace = workspaceData(identity); identities.set(workspace.repository, identity); },
    prepare: () => environment.prepare(),
    async start(identity, binding, { candidate, program, allowedPath }) {
      this.attach(identity); const run = current(binding, true); candidateCheck(identity, candidate);
      if (!filename(allowedPath)) throw new Error('Invalid scoped effect target');
      if (inFlight.has(run.id)) throw new Error('Execution operation already pending');
      const previous = rowFor(binding);
      if (previous) {
        if (canonicalJSON(previous.data.candidate) !== canonicalJSON(candidate) || previous.data.program !== program || previous.data.allowedPath !== allowedPath) throw new Error('Worker launch identity conflict');
        return immutable({ created: false, state: previous.state });
      }
      const work = (async () => {
        const refreshed = await store.runtime.reserve(identity, { commandId: `worker-${run.id}-${run.epoch}`, issue: run.issue, pipeline: run.pipeline });
        if (refreshed.run.id !== run.id) throw new Error('Repository reservation changed'); current(binding, true);
        const prepared = await environment.prepare(); current(binding, true); candidateCheck(identity, candidate);
        const older = db.prepare('SELECT epoch FROM workers WHERE run_id=? ORDER BY epoch DESC LIMIT 1').get(run.id);
        const retained = older ? rowFor({ runId: run.id, epoch: older.epoch }) : null;
        const nonce = randomUUID().replaceAll('-', '');
        const manifest = { name: `pipeliner-${nonce}`, nonce, runId: run.id, repository: run.repository, epoch: run.epoch, workspace: retained?.data.manifest.workspace ?? `${prepared.workspaceRoot}/${run.id.replaceAll('-', '')}`, image: prepared.image };
        const data = { manifest, issue: run.issue, dev: run.dev, policyHash: run.policyHash, candidate, program, allowedPath, deadline: retained?.data.deadline ?? run.createdAt + run.limits['limits.agentSeconds'] * 1000 };
        if (data.deadline <= Date.now()) throw new Error('Captured execution deadline exhausted');
        // Validate before recording, but record before the container can be created.
        restrictedWorkerArgs(manifest, program); current(binding, true);
        for (const prior of db.prepare('SELECT run_id,epoch FROM workers WHERE run_id=?').all(run.id)) await termination({ runId: prior.run_id, epoch: prior.epoch });
        transact(db, () => {
          const maximum = Math.min(run.limits['limits.concurrency'], store.worker.read(run.repository).values['limits.concurrency'].value);
          if (db.prepare("SELECT COUNT(*) AS count FROM workers WHERE state NOT IN ('stopped','exited')").get().count >= maximum) throw new Error('Configured worker concurrency exhausted');
          db.prepare("INSERT INTO workers VALUES(?,?,?,?,?,'starting',NULL,NULL)").run(run.id, run.epoch, run.repository, canonicalJSON(data), digest(data));
        });
        try {
          const cid = await environment.create(manifest, program); update(binding, 'created', cid); current(binding, true);
          const observation = await environment.start(manifest, cid); update(binding, observation.state, cid);
          return immutable({ created: true, state: observation.state });
        } catch (error) { const row = rowFor(binding); update(binding, 'blocked', row?.cid ?? null, failure(error)); throw error; }
      })();
      inFlight.set(run.id, work);
      try { return await work; } finally { if (inFlight.get(run.id) === work) inFlight.delete(run.id); }
    },
    status(repository) {
      requireOpen(); const run = store.runtime.status(repository); if (!run) return immutable({ run: null, worker: null, pending: null, error: null });
      const row = rowFor({ runId: run.id, epoch: run.epoch });
      return immutable({ run, worker: row?.state ?? null, pending: pendingControls.get(run.id) ?? null, error: row?.error ?? foregroundError });
    },
    async refresh(repository) {
      requireOpen(); const run = store.runtime.status(repository); if (!run) return this.status(repository);
      const binding = { runId: run.id, epoch: run.epoch }, row = rowFor(binding);
      if (row && !inFlight.has(run.id)) {
        const work = (async () => {
          const observation = await environment.inspect(row.data.manifest, row.state === 'stopped' ? null : row.cid);
          if (['running', 'created', 'exited'].includes(observation.state) && row.state !== 'blocked') update(binding, observation.state, observation.id);
        })();
        inFlight.set(run.id, work);
        try { await work; } finally { if (inFlight.get(run.id) === work) inFlight.delete(run.id); }
      }
      return this.status(repository);
    },
    async inspectWorker(binding) {
      requireOpen(); const row = rowFor(binding);
      if (inFlight.has(binding.runId) && !pendingControls.has(binding.runId)) throw new Error('Worker launch still pending');
      if (row) {
        const observed = await environment.inspect(row.data.manifest, row.state === 'stopped' ? null : row.cid);
        if (!['exited', 'absent', 'vm-stopped'].includes(observed.state)) throw new Error('Owned worker still running');
      }
      return { runId: binding.runId, epoch: binding.epoch, state: 'stopped', observedAt: Date.now() };
    },
    async applyResult(binding) {
      const run = current(binding, true), row = rowFor(binding), identity = identities.get(run.repository);
      if (!row || !identity) throw new Error('Worker result binding unavailable'); candidateCheck(identity, row.data.candidate);
      const request = JSON.parse(await environment.output(row.data.manifest, row.cid));
      canonicalJSON(request); record(request, ['operation', 'commandId', 'epoch', 'path', 'content']);
      if (request.operation !== 'workspace.create' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(request.commandId) || request.epoch !== binding.epoch
        || request.path !== row.data.allowedPath || !filename(request.path) || typeof request.content !== 'string' || Buffer.byteLength(request.content) > 4096) throw new Error('Worker effect denied');
      current(binding, true); candidateCheck(identity, row.data.candidate);
      const root = workspaceData(identity).checkoutRoot;
      const content = canonicalJSON({ commandId: request.commandId, runId: run.id, content: request.content }) + '\n';
      const data = { repository: run.repository, candidate: row.data.candidate, path: request.path, root, content, requestHash: digest(request) };
      const old = db.prepare('SELECT * FROM effects WHERE command_id=?').get(request.commandId);
      if (old && (old.hash !== digest(data) || old.document !== canonicalJSON(data))) throw new Error('Effect command identity conflict');
      if (!old) transact(db, () => db.prepare('INSERT INTO effects VALUES(?,?,?)').run(request.commandId, canonicalJSON(data), digest(data)));
      const action = store.runtime.intent(binding, { commandId: request.commandId, step: 'implement', operation: 'workspace.write', candidate: data.candidate,
        requestHash: data.requestHash, preconditionsHash: digest({ path: request.path, exists: false }), expectedHash: bytesHash(content) });
      if (!store.runtime.dispatch(binding, action.id).dispatched) return store.runtime.reconcile(binding, action.id);
      const authority = store.worker.authority(run.repository, run.policyRevision); if (!authority.capabilities.includes('workspace.write')) throw new Error('Workspace effect authority revoked');
      candidateCheck(identity, row.data.candidate);
      const before = lstatSync(root), path = join(root, request.path);
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
      const directoryFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      const after = lstatSync(root); if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Workspace changed during effect; readback required');
      return store.runtime.reconcile(binding, action.id);
    },
    async inspectEffect(action) {
      requireOpen(); const row = db.prepare('SELECT * FROM effects WHERE command_id=?').get(action.commandId);
      let result = 'unknown', resultHash = null;
      if (row) {
        const data = JSON.parse(row.document), identity = identities.get(data.repository);
        if (digest(data) !== row.hash || action.repository !== data.repository || action.requestHash !== data.requestHash || canonicalJSON(action.candidate) !== canonicalJSON(data.candidate)
          || bytesHash(data.content) !== action.expectedHash || !identity || workspaceData(identity).checkoutRoot !== data.root) throw new Error('Effect readback binding mismatch');
        candidateCheck(identity, data.candidate);
        try {
          const fd = openSync(join(data.root, data.path), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { const stat = fstatSync(fd); if (stat.isFile() && stat.nlink === 1 && stat.size <= 8192 && stat.uid === process.getuid()) { const actual = bytesHash(readFileSync(fd)); if (actual === action.expectedHash) { result = 'present'; resultHash = actual; } } }
          finally { closeSync(fd); }
        } catch (error) { if (error.code === 'ENOENT') result = 'absent'; else if (!['ELOOP', 'EACCES'].includes(error.code)) throw error; }
      }
      const keys = ['runId', 'repository', 'issue', 'step', 'epoch', 'operation', 'candidate', 'commandId', 'requestHash', 'preconditionsHash', 'expectedHash', 'fingerprint', 'attempts', 'dispatchEpoch'];
      return { ...Object.fromEntries(keys.map(key => [key, action[key]])), result, resultHash, observationHash: digest({ result, resultHash }), observedAt: Date.now() };
    },
    control(binding, operation) {
      const run = current(binding);
      if (!['status', 'pause', 'resume', 'stop'].includes(operation)) throw new Error('Invalid execution control');
      if (operation === 'status') return this.status(run.repository);
      if (operation === 'resume' && foregroundPausing) throw new Error('Foreground execution is pausing');
      if ((operation === 'pause' && run.control === 'paused' || operation === 'stop' && run.control === 'stopped') && !inFlight.has(run.id)) return immutable({ received: true, verified: true });
      if (pendingControls.has(run.id)) {
        if (operation === 'stop') store.runtime.requestControl(binding, 'stop');
        return immutable({ received: true, verified: false });
      }
      if (operation === 'resume' && run.control === 'running' && ['running', 'exited'].includes(rowFor(binding)?.state)) return immutable({ received: true, verified: true });
      const previous = inFlight.get(run.id);
      if (operation !== 'resume') store.runtime.requestControl(binding, operation);
      pendingControls.set(run.id, operation);
      const work = (async () => {
        await previous?.catch(() => {}); await termination(binding); await reconcilePending(binding);
        const identity = identities.get(run.repository), row = rowFor(binding);
        if (operation === 'resume') {
          if (!identity || !row) throw new Error('Recovery workspace unavailable'); candidateCheck(identity, row.data.candidate);
          if (current(binding).control === 'running') { store.runtime.requestControl(binding, 'pause'); await store.runtime.verifyControl(binding); }
          const resumed = await store.runtime.resume(binding), next = { runId: resumed.id, epoch: resumed.epoch };
          // Let start own the launch slot; the received control stays visible throughout startup.
          inFlight.delete(run.id); await this.start(identity, next, row.data);
        } else {
          try { await store.runtime.verifyControl(binding); }
          catch (error) { if (error.message !== 'Control request changed') throw error; await store.runtime.verifyControl(binding); }
          if (!db.prepare("SELECT 1 FROM workers WHERE state NOT IN ('stopped','exited') LIMIT 1").get()) await environment.stop();
        }
      })();
      inFlight.set(run.id, work);
      work.catch(error => { const row = rowFor({ runId: run.id, epoch: store.runtime.status(run.repository)?.epoch ?? binding.epoch }); if (row) update({ runId: row.run_id, epoch: row.epoch }, 'blocked', row.cid, failure(error)); })
        .finally(() => { pendingControls.delete(run.id); if (inFlight.get(run.id) === work) inFlight.delete(run.id); });
      return immutable({ received: true, verified: false });
    },
    async settle(repository) { const run = store.runtime.status(repository); if (run) await inFlight.get(run.id); return this.status(repository); },
    async pauseForeground() {
      requireOpen();
      foregroundPausing = true;
      try { await monitorWork;
      // A verified run state can precede its final VM stop; wait before inspecting any repository.
      while (inFlight.size) await Promise.all([...inFlight.values()]);
      for (const { repository } of db.prepare('SELECT DISTINCT repository FROM workers').all()) {
        const run = store.runtime.status(repository); if (run) { const binding = { runId: run.id, epoch: run.epoch }; if (run.control === 'recovery-required') { await termination(binding); await reconcilePending(binding); } else if (!['paused', 'stopped'].includes(run.control)) this.control(binding, 'pause'); await this.settle(repository); await this.inspectWorker(binding); }
      }
      if (inFlight.size) throw new Error('Execution operations still pending'); await environment.stop(); foregroundError = null;
      } catch (error) { foregroundError = failure(error); throw error; }
      finally { foregroundPausing = false; }
    },
    async shutdown() {
      clearInterval(monitor); await this.pauseForeground(); db.close(); owner.close(); closed = true;
    },
    async destroyEnvironment() { requireOpen(); if (inFlight.size) throw new Error('Execution operations still pending'); for (const row of db.prepare('SELECT run_id,epoch FROM workers').all()) await termination({ runId: row.run_id, epoch: row.epoch }); return environment.destroy(); },
  };
  // Inspect authority and elapsed budgets locally; no provider call or automatic resume.
  const monitor = setInterval(() => {
    if (closed || monitorWork) return;
    monitorWork = (async () => {
      for (const resource of db.prepare("SELECT run_id,epoch,repository FROM workers WHERE state IN ('running','created')").all()) {
        if (inFlight.has(resource.run_id)) continue;
        const binding = { runId: resource.run_id, epoch: resource.epoch }, row = rowFor(binding), run = store.runtime.status(resource.repository);
        try {
          if (!run || run.id !== binding.runId || run.epoch !== binding.epoch || run.control === 'recovery-required') {
            const work = termination(binding); inFlight.set(resource.run_id, work);
            try { await work; } finally { if (inFlight.get(resource.run_id) === work) inFlight.delete(resource.run_id); }
            continue;
          }
          let grant; try { grant = store.worker.authority(run.repository, run.policyRevision); } catch { supervisor.control(binding, 'stop'); continue; }
          if (Date.now() >= row.data.deadline || grant.dev !== run.dev || !grant.capabilities.includes('worker.exec')) { supervisor.control(binding, 'stop'); continue; }
          await supervisor.refresh(resource.repository);
        } catch (error) { update(binding, 'blocked', row.cid, failure(error)); }
      }
    })().catch(() => {}).finally(() => { monitorWork = null; });
  }, 1000);
  monitor.unref();
  return Object.freeze(supervisor);
}
