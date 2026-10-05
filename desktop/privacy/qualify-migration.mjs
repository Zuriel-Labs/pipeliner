import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, copyFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJSON, developmentTemplate } from '../core/settings.mjs';
import { legacyWorkspace } from '../repositories/legacy-fixture.mjs';
import { legacyDevelopment } from '../development/legacy-fixture.mjs';
import { openWorkspaceStore } from '../repositories/store.mjs';
import { openDevelopmentStore } from '../development/state.mjs';
import { verifyProtectedBackup } from './backup.mjs';

// Development-only native qualification: actual OS-wrapped vault, synthetic legacy content, no dispatch transport.
export function qualifyProtectedMigration(directory, vault) {
  const root = realpathSync(mkdtempSync(join(directory, 'migration-'))), owned = lstatSync(root); let workspaceStore, developmentStore;
  const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value)).digest('hex');
  try {
    const workspace = { id: 'native-repo', repositoryId: 'R_NATIVE', slug: 'fixture/native', localKey: '1:2', path: root, project: { id: 'P_NATIVE' }, name: 'Private native workspace marker' };
    const effect = { id: 'native-effect', job: 'native-job', step: 'write', binding: { repository: workspace.id, text: 'Private native effect marker' }, state: 'uncertain', result: { text: 'Private native result marker' } };
    legacyWorkspace(root, 4, { workspaces: [workspace], selected: workspace.id, draft: { id: 'native-draft', text: 'Private native draft marker' }, effects: [effect], issues: { [workspace.id]: { selected: 7, text: 'Private native Issue marker' } }, pipelines: [{ context: { repository: workspace.id, kind: 'development' }, value: { text: 'Private native pipeline marker' } }], schedules: { [workspace.id]: { text: 'Private native schedule marker' } } });
    const legacySnapshot = join(root, 'workspaces-v4-11111111-1111-1111-1111-111111111111.sqlite'); copyFileSync(join(root, 'workspaces.sqlite'), legacySnapshot);
    const source = { sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40) }, run = { id: 'native-run', repository: workspace.id, issue: 7, dev: 'native-dev', policyRevision: 1, policyHash: 'c'.repeat(64), pipelineHash: hash(developmentTemplate), limits: { 'limits.stepTurns': 3, 'limits.issueTurns': 5, 'limits.agentSeconds': 1800 } };
    const captured = { run, pipeline: structuredClone(developmentTemplate), source, developer: { id: run.dev, connection: 'ollama', model: 'synthetic' }, skillsHash: 'd'.repeat(64), issueHash: 'e'.repeat(64), checks: [{ name: 'Private native check marker', command: 'node --test' }], logBytes: 1048576 };
    const state = { runId: run.id, epoch: 3, step: 'research', state: 'executing', candidate: source, visits: { research: 2 }, retries: {}, visit: 2, turns: 2, stepTurns: 2, budgets: { research: { turns: 2, spentMs: 400, activeAt: null } }, attempts: {}, remediationCycles: 1, developer: run.dev, takeovers: [], budgetClock: 1000, usage: { input: 2, output: 3, unavailable: false }, message: 'Private native state marker' };
    const request = { id: 'native-request', runId: run.id, epoch: 3, step: 'research', visit: 2, kind: 'source', candidate: source, payload: { text: 'Private native request marker' } }, result = { candidate: source, result: { text: 'Private native reply marker' } }, output = { outcome: 'failure', summary: 'Private native output marker', evidence: [], documents: [], findings: [] };
    legacyDevelopment(root, { captured, state, requests: [{ document: request, state: 'uncertain', result }], outputs: [{ run: run.id, visit: 1, step: 'research', candidate: source, output }] });
    const originals = Object.fromEntries(['workspaces', 'development'].map(store => [store, hash(readFileSync(join(root, store + '.sqlite')))]));
    workspaceStore = openWorkspaceStore(root, { vault }); developmentStore = openDevelopmentStore(root, { vault });
    assert.equal(workspaceStore.draft().text, 'Private native draft marker'); assert.deepEqual(workspaceStore.pending()[0], effect); assert.equal(workspaceStore.selected(), workspace.id);
    assert.deepEqual(developmentStore.status(run.id), state); assert.deepEqual(developmentStore.captured(run.id), captured); assert.deepEqual(developmentStore.evidence({ runId: run.id, epoch: 3 })[0], { ...request, state: 'uncertain', result });
    assert.equal(developmentStore.outputs(run.id)[0].output.summary, 'Private native output marker'); assert.throws(() => developmentStore.rebind(run.id, 4), /recovery/);
    workspaceStore.close(); workspaceStore = null; developmentStore.close(); developmentStore = null;
    workspaceStore = openWorkspaceStore(root, { vault }); developmentStore = openDevelopmentStore(root, { vault });
    assert.equal(workspaceStore.issueContext(workspace.id).selected, 7); assert.equal(developmentStore.status(run.id).turns, 2); assert.equal(developmentStore.recovery()[0].uncertainEffects, 1);
    assert.equal(existsSync(legacySnapshot), false);
    const backups = readdirSync(root).filter(name => name.endsWith('.pipeliner-backup')); assert.equal(backups.length, 3);
    for (const name of backups) { const store = name.startsWith('workspaces-') ? 'workspaces' : 'development'; assert.equal(verifyProtectedBackup(join(root, name), { vault, store, version: store === 'workspaces' ? 4 : 1 }).sourceHash, originals[store]); }
    for (const name of readdirSync(root)) assert.equal(readFileSync(join(root, name)).includes('Private native '), false, name);
    return { schemas: { workspaces: 5, development: 2 }, originalBackups: 3, unchangedBudgets: true, uncertainEffectsRetained: true, replayedEffects: 0 };
  } finally {
    workspaceStore?.close(); developmentStore?.close(); const current = lstatSync(root);
    assert.ok(current.dev === owned.dev && current.ino === owned.ino && current.isDirectory() && !current.isSymbolicLink() && current.uid === process.getuid() && realpathSync(root) === root);
    rmSync(root, { recursive: true }); assert.equal(existsSync(root), false);
  }
}
