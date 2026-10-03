import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaults, canonicalJSON } from '../core/settings.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { scheduleConfig, selectReadyWork } from './model.mjs';
import { createScheduler } from './scheduler.mjs';

const repo = id => ({ id, name: id, slug: 'fixture/' + id, connections: {}, project: { fields: { Priority: { options: [{ name: 'P0' }, { name: 'P1' }, { name: 'P2' }, { name: 'P3' }] } } } });
const issue = (number, priority = 'P1', extra = {}) => ({ id: 'I' + number, number, state: 'OPEN', status: 'Backlog', ready: true, itemId: 'ITEM' + number, metadata: { Priority: priority, Impact: 'High', Effort: 'S' }, ...extra });
function fixture(t, { count = 1, enabled = true, automatic = true, capacity = 1, hostAuthority = () => true } = {}) {
  let now = 1000, requests = 0, starts = [], gate, readGate, onRead, failed = false;
  const workspaces = Array.from({ length: count }, (_, i) => repo('R' + i)), states = new Map(), views = new Map(), runs = new Map();
  for (const workspace of workspaces) views.set(workspace.id, { hash: 'a'.repeat(64), values: Object.fromEntries(Object.entries({ ...defaults, 'scheduling.enabled': enabled, 'intake.trigger': automatic ? 'schedule' : 'pm', 'limits.concurrency': capacity }).map(([id, value]) => [id, { value }])) });
  const catalogs = new Map(workspaces.map(value => [value.id, { complete: true, active: [], issues: [issue(7), issue(2)] }]));
  const store = { workspaces: () => workspaces, schedule: id => structuredClone(states.get(id) ?? null), saveSchedule: (id, state) => states.set(id, structuredClone(state)) };
  const policy = { worker: { read: id => structuredClone(views.get(id ?? workspaces[0].id)) }, runtime: { status: id => runs.get(id) ?? null } };
  const scheduler = createScheduler({ store, policy, clock: () => now, hostAuthority,
    development: { availability: id => ({ busy: false, qualified: true, run: runs.get(id) ?? null }), startScheduled: async (id, number, hash, automaticStart) => {
      if (gate) await gate; starts.push({ id, number, hash, automaticStart }); runs.set(id, { id: 'run-' + id, issue: number, control: 'running' }); return { accepted: true };
    } },
    connections: { acquire: async () => ({ check() {}, close() {}, signal: new AbortController().signal }) },
    api: { readCatalog: async (_app, _project, workspace) => { requests++; if (readGate) await readGate; onRead?.(); if (failed) throw new Error('partial-access'); return structuredClone(catalogs.get(workspace.id)); },
      readDetail: async (_app, workspace, number) => ({ ...catalogs.get(workspace.id).issues.find(i => i.number === number), dependencies: [], pullRequests: [] }) },
    nextCalendar: async (_config, after) => after + 86400000,
    timers: { set: () => ({ unref() {} }), clear() {} } });
  t.after(async () => scheduler.close());
  return { scheduler, store, states, views, runs, catalogs, workspaces, starts, requests: () => requests,
    time: value => { now = value; }, fail: value => { failed = value; }, hold: value => { gate = value; }, holdRead: value => { readGate = value; }, onRead: value => { onRead = value; } };
}

test('selection follows Project priority order, then number, after complete readiness and dependency/PR proof', async () => {
  const workspace = repo('R'), catalog = { complete: true, active: [], issues: [issue(1, 'P1'), issue(4, 'P0'), issue(2, 'P0'), issue(3, 'P0', { ready: false })] };
  const inspected = [];
  const api = { readDetail: async (_lease, _workspace, number) => { inspected.push(number); return { ...catalog.issues.find(i => i.number === number), dependencies: number === 2 ? [{ state: 'OPEN' }] : [], pullRequests: [] }; } };
  assert.equal((await selectReadyWork(catalog, workspace, api, null)).issue.number, 4);
  assert.deepEqual(inspected, [2, 4]);
  catalog.active = [issue(10, 'P1', { status: 'Pending Review' })];
  assert.equal((await selectReadyWork(catalog, workspace, api, null)).reason, 'active-issue');
  catalog.complete = false; await assert.rejects(selectReadyWork(catalog, workspace, api, null), /incomplete/);
});

test('disabled scheduling does no service or model work; explicit Run Now is bounded PM authority', async t => {
  const f = fixture(t, { enabled: false, automatic: false });
  await f.scheduler.check('startup'); assert.equal(f.requests(), 0); assert.equal(f.starts.length, 0);
  await f.scheduler.check('manual', 'R0'); assert.equal(f.starts.length, 1); assert.equal(f.starts[0].automaticStart, false);
});

test('hidden unauthorized host makes no reads or starts; revocation during read blocks dispatch', async t => {
  let allowed = false; const f = fixture(t, { hostAuthority: () => allowed });
  await f.scheduler.check('startup'); assert.equal(f.requests(), 0); assert.equal(f.starts.length, 0);
  allowed = true; f.onRead(() => { allowed = false; }); await f.scheduler.check('wake');
  assert.equal(f.requests(), 1); assert.equal(f.starts.length, 0);
  allowed = true; f.onRead(null); await f.scheduler.wake(); assert.equal(f.starts.length, 1);
});

test('duplicate wake, timer and Run Now checks coalesce; reservation blocks later duplicate starts', async t => {
  const f = fixture(t); let release; f.hold(new Promise(resolve => { release = resolve; }));
  const first = f.scheduler.check('startup'); await new Promise(resolve => setImmediate(resolve));
  const duplicate = f.scheduler.check('manual', 'R0'); release(); await Promise.all([first, duplicate]);
  assert.equal(f.requests(), 1); assert.equal(f.starts.length, 1);
  await f.scheduler.check('wake'); assert.equal(f.starts.length, 1); assert.equal(f.states.get('R0').reason, 'repository-reserved');
});

test('idle checks and PM-only trigger make zero starts; failed/incomplete access never mutates', async t => {
  const f = fixture(t, { automatic: false });
  await f.scheduler.check('startup'); assert.equal(f.starts.length, 0); assert.equal(f.states.get('R0').reason, 'pm-trigger');
  f.fail(true); await f.scheduler.check('manual', 'R0'); assert.equal(f.starts.length, 0); assert.equal(f.states.get('R0').reason, 'readback-unavailable');
  assert.equal(f.states.get('R0').pending, null);
});

test('policy changes during live selection block dispatch; sleep interrupts checking before mutation', async t => {
  const f = fixture(t); f.onRead(() => { f.views.get('R0').hash = 'b'.repeat(64); });
  await f.scheduler.check('startup'); assert.equal(f.starts.length, 0); assert.equal(f.states.get('R0').reason, 'policy-changed');
  f.onRead(null); let release; f.holdRead(new Promise(resolve => { release = resolve; }));
  const checking = f.scheduler.check('wake'); await new Promise(resolve => setImmediate(resolve)); f.scheduler.suspend(); release(); await checking;
  assert.equal(f.starts.length, 0); await f.scheduler.wake(); assert.equal(f.starts.length, 1);
});

test('fair capacity uses oldest eligibility before priority and number; waiting candidates persist', async t => {
  const f = fixture(t, { count: 2 });
  f.states.set('R1', { schemaVersion: 1, config: scheduleConfig(f.views.get('R1')), nextAt: 1000, lastAt: 0, reason: 'capacity', catchUp: false, eligible: { number: 7, at: 500, priority: 1 }, pending: null });
  f.catalogs.set('R1', { complete: true, active: [], issues: [issue(7)] });
  await f.scheduler.check('startup'); assert.equal(f.starts[0].id, 'R1'); assert.equal(f.states.get('R0').reason, 'host-capacity');
});

test('durable incomplete start cannot repeat after restart, even when no local reservation exists', async t => {
  const f = fixture(t);
  f.states.set('R0', { schemaVersion: 1, config: scheduleConfig(f.views.get('R0')), nextAt: 1000, lastAt: 0, reason: 'checking', catchUp: false, eligible: null, pending: { kind: 'start', number: 2, policyHash: 'a'.repeat(64) } });
  await f.scheduler.check('startup'); assert.equal(f.starts.length, 0); assert.equal(f.requests(), 1); assert.equal(f.states.get('R0').reason, 'recovery-required');
});

test('missed intervals yield one catch-up; backwards clock cannot schedule extra timer checks', async t => {
  const f = fixture(t); f.catalogs.get('R0').issues = [];
  await f.scheduler.check('startup'); assert.equal(f.states.get('R0').nextAt, 1801000);
  f.time(100000000); await f.scheduler.check('timer'); assert.equal(f.requests(), 2); assert.equal(f.states.get('R0').nextAt, 101800000);
  f.time(500); await f.scheduler.check('timer'); assert.equal(f.requests(), 2);
});

test('completion waits by default; explicit immediate scheduling performs one new check', async t => {
  const f = fixture(t); f.catalogs.get('R0').issues = [];
  await f.scheduler.check('startup'); const before = f.requests();
  await f.scheduler.completed('R0'); assert.equal(f.requests(), before);
  f.views.get('R0').values['scheduling.afterCompletion'].value = 'immediate';
  await f.scheduler.completed('R0'); assert.equal(f.requests(), before + 1);
});

test('workspace schedule records survive backed-up additive migration; forged data fails closed', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-schedule-')));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true }); assert.equal(existsSync(directory), false); });
  store = openWorkspaceStore(directory);
  store.register({ id: 'R0', repositoryId: 'REPO', slug: 'fixture/repo', localKey: '1:2', path: directory, project: { id: 'PROJECT' } });
  store.saveIssueContext('R0', { selected: 7 }); store.close(); store = null;
  const legacy = new DatabaseSync(join(directory, 'workspaces.sqlite')); legacy.exec('DROP TABLE schedule_states; PRAGMA user_version=3;'); legacy.close();
  store = openWorkspaceStore(directory);
  const backupName = readdirSync(directory).find(name => /^workspaces-v3-[a-f0-9-]+\.sqlite$/.test(name)); assert(backupName); assert.equal(lstatSync(join(directory, backupName)).mode & 0o777, 0o600);
  const backup = new DatabaseSync(join(directory, backupName), { readOnly: true });
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 3); assert.equal(JSON.parse(backup.prepare('SELECT data FROM issue_contexts').get().data).selected, 7); } finally { backup.close(); }
  const state = { schemaVersion: 1, config: {}, nextAt: 1000, lastAt: 0, reason: 'no-ready-work', catchUp: false, eligible: null, pending: null };
  store.saveSchedule('R0', state); store.close(); store = openWorkspaceStore(directory); assert.deepEqual(store.schedule('R0'), state);
  store.close(); store = null;
  const db = new DatabaseSync(join(directory, 'workspaces.sqlite'));
  db.prepare('UPDATE schedule_states SET data=? WHERE repository=?').run(canonicalJSON({ ...state, reason: 'forged' }), 'R0'); db.close();
  store = openWorkspaceStore(directory); assert.throws(() => store.schedule('R0'), /invalid/);
});
