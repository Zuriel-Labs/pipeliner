import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { fields, defaults, capabilityNames, canonicalJSON, immutable, record, rawValues, validateState, validateValue } from './settings.mjs';
import { migrateRuntime, createRuntime, transact } from './runtime.mjs';
import { protectedFile } from './storage.mjs';

const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value) && !['constructor', 'prototype'].includes(value);
const checkedId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) throw new Error('Invalid command identity'); };
const empty = () => ({ schemaVersion: 1, defaults, host: {}, global: {}, repositories: {} });
function catalogData(value) {
  canonicalJSON(value);
  record(value, ['repositories', 'capabilities', 'maxConcurrency', 'background', 'connections', 'developers', 'extensions'], ['resources', 'checks', 'updateSources', 'notifications']);
  const ids = list => Array.isArray(list) && list.length <= 1000 && list.every(id) && new Set(list).size === list.length;
  if (!ids(value.repositories) || !Array.isArray(value.capabilities) || !value.capabilities.every(v => capabilityNames.includes(v))
    || new Set(value.capabilities).size !== value.capabilities.length || !Number.isSafeInteger(value.maxConcurrency) || value.maxConcurrency < 1 || value.maxConcurrency > 5
    || typeof value.background !== 'boolean' || (value.notifications !== undefined && typeof value.notifications !== 'boolean')) throw new Error('Invalid host capability catalog');
  for (const key of ['resources', 'checks', 'updateSources']) if (value[key] !== undefined && !ids(value[key])) throw new Error('Invalid capability references');
  for (const key of ['connections', 'developers', 'extensions']) {
    if (!Array.isArray(value[key]) || value[key].length > 1000 || new Set(value[key].map(v => v.id)).size !== value[key].length) throw new Error('Invalid capability catalog');
    for (const item of value[key]) {
      if (!id(item.id)) throw new Error('Invalid capability identity');
      if (key === 'connections') {
        record(item, ['id', 'provider', 'repositories'], ['healthy']);
        if (!['github', 'codex', 'ollama'].includes(item.provider) || !ids(item.repositories) || item.repositories.some(r => !value.repositories.includes(r))
          || (item.healthy !== undefined && typeof item.healthy !== 'boolean')) throw new Error('Invalid connection binding');
      } else if (key === 'developers') {
        record(item, ['id', 'connection', 'metrics'], ['model']);
        if (!value.connections.some(c => c.id === item.connection && ['codex', 'ollama'].includes(c.provider)) || !Array.isArray(item.metrics)
          || item.metrics.some(m => !['tokens', 'cost'].includes(m)) || new Set(item.metrics).size !== item.metrics.length
          || (item.model !== undefined && (typeof item.model !== 'string' || !item.model.length || item.model.length > 240))) throw new Error('Invalid Dev binding');
      } else {
        record(item, ['id', 'digest']);
        if (typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)) throw new Error('Invalid extension pin');
      }
    }
  }
  return JSON.parse(canonicalJSON(value));
}

export function openPolicyStore(directory, { catalog, clock = Date.now, inspectors }) {
  const path = protectedFile(directory, 'policy.sqlite');
  const facts = () => catalogData(catalog());
  const now = () => { const n = clock(); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid policy clock'); return n; };
  const db = new DatabaseSync(path, { allowExtension: false, timeout: 1000 });
  let closed = false;
  const transaction = fn => transact(db, fn);
  const close = () => { if (!closed) { db.close(); closed = true; } };
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, 2].includes(version)) throw new Error('Unsupported policy database schema');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (!version) transaction(() => {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('Unrecognized policy database');
      db.exec(`CREATE TABLE policy_versions (revision INTEGER PRIMARY KEY, document TEXT NOT NULL, catalog TEXT NOT NULL, hash TEXT NOT NULL, input_id TEXT, proposal_id TEXT, command_id TEXT UNIQUE, created_at INTEGER NOT NULL);
        CREATE TABLE policy_inputs (id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL, target TEXT, text_hash TEXT NOT NULL, valid INTEGER NOT NULL CHECK(valid IN (0,1)), created_at INTEGER NOT NULL);
        CREATE TABLE policy_proposals (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, input_id TEXT NOT NULL REFERENCES policy_inputs(id), fingerprint TEXT NOT NULL, preview TEXT NOT NULL, document TEXT NOT NULL, catalog_hash TEXT NOT NULL, consumed_revision INTEGER REFERENCES policy_versions(revision));
        CREATE TABLE policy_revocations (repository TEXT NOT NULL, kind TEXT NOT NULL, reference TEXT NOT NULL, revision INTEGER NOT NULL REFERENCES policy_versions(revision), PRIMARY KEY(repository,kind,reference));
        CREATE TRIGGER immutable_policy_update BEFORE UPDATE ON policy_versions BEGIN SELECT RAISE(ABORT, 'Immutable policy version'); END;
        CREATE TRIGGER immutable_policy_delete BEFORE DELETE ON policy_versions BEGIN SELECT RAISE(ABORT, 'Immutable policy version'); END;
        PRAGMA user_version=1;`);
      const document = empty(), current = facts(); validateState(document);
      db.prepare('INSERT INTO policy_versions VALUES(?,?,?,?,NULL,NULL,NULL,?)').run(0, canonicalJSON(document), canonicalJSON(current), digest({ document, catalog: current }), now());
    });
    function versionData(revision) {
      const row = revision === undefined ? db.prepare('SELECT * FROM policy_versions ORDER BY revision DESC LIMIT 1').get()
        : db.prepare('SELECT * FROM policy_versions WHERE revision=?').get(revision);
      if (!row) throw new Error('Unknown policy version');
      const document = JSON.parse(row.document), bindings = catalogData(JSON.parse(row.catalog));
      if (digest({ document, catalog: bindings }) !== row.hash) throw new Error('Policy integrity check failed');
      validateState(document); return { revision: row.revision, document, bindings, hash: row.hash };
    }
    versionData();
    const targetCheck = (target, current = facts()) => {
      if (target !== null && (!id(target) || !current.repositories.includes(target))) throw new Error('Unknown repository target');
    };
    function view(version, target, current = facts()) {
      targetCheck(target, current); const s = version.document, values = rawValues(s, target);
      const resolved = Object.fromEntries([...fields].map(([key, field]) => [key, { value: values[key], configuredValue: values[key],
        source: target && Object.hasOwn(s.repositories[target] ?? {}, key) ? 'repository' : Object.hasOwn(s.host, key) ? 'host' : Object.hasOwn(s.global, key) ? 'global' : 'shipped',
        scope: field.scope, timing: field.timing, label: field.label }]));
      resolved['permissions.grants'].value = values['permissions.grants'].filter(c => values['permissions.ceiling'].includes(c) && current.capabilities.includes(c));
      for (const provider of ['github', 'codex', 'ollama']) {
        const ref = resolved[`connections.${provider}`];
        ref.binding = current.connections.find(c => c.id === ref.value && c.provider === provider) ?? null;
        ref.available = ref.value === null || Boolean(ref.binding && ref.binding.healthy !== false && (!target || ref.binding.repositories.includes(target)));
      }
      resolved['agents.dev'].binding = current.developers.find(d => d.id === values['agents.dev']) ?? null;
      const connection = current.connections.find(c => c.id === resolved['agents.dev'].binding?.connection);
      resolved['agents.dev'].available = values['agents.dev'] === null || Boolean(connection && connection.healthy !== false && (!target || connection.repositories.includes(target)));
      return { revision: version.revision, hash: version.hash, schemaVersion: 1, target, values: resolved, bindings: version.bindings };
    }
    function previewEdit(request, currentVersion, current) {
      record(request, ['scope', 'target', 'changes', 'reset'], ['restoreRevision']); canonicalJSON(request);
      const { scope, target } = request; targetCheck(target, current);
      if (!['host', 'global', 'repository'].includes(scope) || (scope === 'repository') !== (target !== null)) throw new Error('Invalid policy scope or target');
      if (!request.changes || Array.isArray(request.changes) || !Array.isArray(request.reset) || new Set(request.reset).size !== request.reset.length) throw new Error('Invalid policy changes');
      const document = JSON.parse(canonicalJSON(currentVersion.document));
      if (scope === 'repository') document.repositories[target] ??= {};
      const values = scope === 'repository' ? document.repositories[target] : document[scope];
      let changes = request.changes, reset = request.reset;
      if (request.restoreRevision !== undefined) {
        if (!Number.isSafeInteger(request.restoreRevision) || request.restoreRevision < 0 || Object.keys(changes).length || reset.length) throw new Error('Invalid restore request');
        const old = versionData(request.restoreRevision).document;
        changes = scope === 'repository' ? old.repositories[target] ?? {} : old[scope];
        reset = Object.keys(values).filter(k => !Object.hasOwn(changes, k));
      }
      const touched = [...Object.keys(changes), ...reset];
      if (touched.length > fields.size || reset.some(k => Object.hasOwn(changes, k))) throw new Error('Invalid policy changes');
      for (const key of touched) {
        const field = fields.get(key); if (!field) throw new Error('Unknown policy field');
        if (field.scope === 'read-only' || (field.scope === 'host') !== (scope === 'host')) throw new Error('Host-only or read-only policy field');
        if (Object.hasOwn(changes, key)) { validateValue(key, changes[key]); values[key] = changes[key]; } else delete values[key];
      }
      if (scope === 'repository' && !Object.keys(values).length) delete document.repositories[target];
      validateState(document);
      const after = rawValues(document, target);
      for (const key of touched) {
        const value = after[key];
        if (key.startsWith('connections.') && value !== null) {
          const provider = key.split('.')[1];
          if (!current.connections.some(c => c.id === value && c.provider === provider && c.healthy !== false && (!target || c.repositories.includes(target)))) throw new Error('Connection capability unavailable');
        }
        if (key === 'agents.dev' || key === 'agents.fallbacks') for (const dev of key === 'agents.dev' ? value === null ? [] : [value] : value) {
          const d = current.developers.find(d => d.id === dev), c = current.connections.find(c => c.id === d?.connection);
          if (!d || !c || c.healthy === false || (target && !c.repositories.includes(target))) throw new Error('Dev capability unavailable');
        }
        if (['permissions.grants', 'permissions.ceiling'].includes(key)) {
          if (value.some(c => !current.capabilities.includes(c))) throw new Error('Host capability unavailable');
          if (key === 'permissions.grants' && value.some(c => !after['permissions.ceiling'].includes(c))) throw new Error('Repository permission exceeds host ceiling');
        }
        const referenceLists = { 'permissions.resources': 'resources', 'skills.extensions': 'extensions', 'skills.disabled': 'extensions', 'testing.requiredChecks': 'checks', 'delivery.output': 'resources', 'updates.source': 'updateSources' };
        if (Object.hasOwn(referenceLists, key)) for (const ref of Array.isArray(value) ? value : value === null ? [] : [value]) {
          if (!(current[referenceLists[key]] ?? []).some(item => (typeof item === 'string' ? item : item.id) === ref)) throw new Error('Referenced capability unavailable');
        }
        if ((key.startsWith('background.') && value && !current.background) || (key === 'appearance.osNotifications' && value && !current.notifications)
          || (key === 'limits.concurrency' && value > current.maxConcurrency)) throw new Error('Host capability unavailable');
      }
      for (const repo of target ? [target] : [null, ...current.repositories]) {
        const resolved = rawValues(document, repo);
        const devIds = [resolved['agents.dev'], ...(resolved['agents.takeover'] ? resolved['agents.fallbacks'] : [])].filter(Boolean);
        for (const [key, metric] of [['limits.tokens', 'tokens'], ['limits.costUsd', 'cost']]) if (resolved[key] !== null
          && (!devIds.length || devIds.some(dev => !current.developers.find(d => d.id === dev)?.metrics.includes(metric)))) throw new Error('Selected provider metric unavailable for hard cap');
      }
      if (canonicalJSON(document) === canonicalJSON(currentVersion.document)) throw new Error('Policy proposal has no change');
      const next = { ...currentVersion, document, bindings: current };
      return { document, before: view(currentVersion, target, current).values, after: view(next, target, current).values,
        affectedRepositories: target ? [target] : current.repositories, timing: [...new Set(touched.map(key => fields.get(key).timing))] };
    }
    const control = {
      capture(request) {
        canonicalJSON(request); record(request, ['commandId', 'conversationId', 'target', 'text']); checkedId(request.commandId); checkedId(request.conversationId); targetCheck(request.target);
        if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 4096) throw new Error('Invalid direct PM input');
        return transaction(() => {
          const existing = db.prepare('SELECT * FROM policy_inputs WHERE command_id=?').get(request.commandId);
          if (existing) {
            if (existing.conversation !== request.conversationId || existing.target !== request.target || existing.text_hash !== digest(request.text)) throw new Error('Command identity conflict');
            return immutable({ id: existing.id });
          }
          const inputId = randomUUID();
          db.prepare('INSERT INTO policy_inputs VALUES(?,?,?,?,?,1,?)').run(inputId, request.commandId, request.conversationId, request.target, digest(request.text), now());
          return immutable({ id: inputId });
        });
      },
      invalidate(inputId, binding) {
        checkedId(inputId);
        if (binding) {
          record(binding, ['conversationId', 'target']);
          const input = db.prepare('SELECT conversation,target FROM policy_inputs WHERE id=?').get(inputId);
          if (!input || input.conversation !== binding.conversationId || input.target !== binding.target) throw new Error('Original input context changed');
        }
        db.prepare('UPDATE policy_inputs SET valid=0 WHERE id=?').run(inputId);
      },
      prepare(request) {
        canonicalJSON(request); record(request, ['inputId', 'requestId', 'scope', 'target', 'changes', 'reset'], ['restoreRevision', 'conversationId']); checkedId(request.inputId); checkedId(request.requestId);
        return transaction(() => {
          const input = db.prepare('SELECT * FROM policy_inputs WHERE id=?').get(request.inputId);
          if (!input?.valid || input.target !== request.target || (request.conversationId !== undefined && request.conversationId !== input.conversation)
            || input.created_at + 900000 < now()) throw new Error('Original PM input invalid, expired or wrong context');
          const fingerprint = digest(request), existing = db.prepare('SELECT * FROM policy_proposals WHERE request_id=?').get(request.requestId);
          if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('Proposal identity conflict'); return immutable(JSON.parse(existing.preview)); }
          const current = facts(), currentVersion = versionData();
          const { inputId: _input, requestId: _request, conversationId: _conversation, ...edit } = request;
          const preview = previewEdit(edit, currentVersion, current);
          const proposal = { id: randomUUID(), inputId: input.id, inputHash: input.text_hash, conversationId: input.conversation, target: input.target, scope: request.scope,
            baseRevision: currentVersion.revision, expiresAt: now() + 900000, ...preview };
          proposal.hash = digest({ ...proposal, catalogHash: digest(current) });
          const { document, ...publicProposal } = proposal;
          db.prepare('INSERT INTO policy_proposals VALUES(?,?,?,?,?,?,?,NULL)').run(proposal.id, request.requestId, input.id, fingerprint, canonicalJSON(publicProposal), canonicalJSON(document), digest(current));
          return immutable(publicProposal);
        });
      },
      apply(request) {
        canonicalJSON(request); record(request, ['commandId', 'proposalId', 'hash', 'inputId', 'conversationId', 'target']);
        for (const key of ['commandId', 'proposalId', 'inputId', 'conversationId']) checkedId(request[key]);
        if (typeof request.hash !== 'string' || !/^[a-f0-9]{64}$/.test(request.hash)) throw new Error('Invalid proposal hash');
        return transaction(() => {
          const row = db.prepare('SELECT * FROM policy_proposals WHERE id=?').get(request.proposalId);
          if (!row) throw new Error('Unknown proposal'); const p = JSON.parse(row.preview);
          if (p.hash !== request.hash || p.inputId !== request.inputId) throw new Error('Proposal binding changed');
          if (p.target !== request.target || p.conversationId !== request.conversationId) throw new Error('Proposal context changed');
          const input = db.prepare('SELECT * FROM policy_inputs WHERE id=?').get(p.inputId);
          if (!input?.valid || input.text_hash !== p.inputHash) throw new Error('Original PM input invalid');
          if (row.consumed_revision !== null) return immutable({ applied: false, reason: 'already-applied', revision: row.consumed_revision });
          if (p.expiresAt < now()) throw new Error('Proposal expired');
          const currentVersion = versionData(); if (p.baseRevision !== currentVersion.revision) throw new Error('Stale policy proposal');
          const current = facts(); if (row.catalog_hash !== digest(current)) throw new Error('Capability context changed; refresh proposal');
          const document = JSON.parse(row.document); validateState(document);
          const { hash: _hash, ...bound } = p;
          if (digest({ ...bound, document, catalogHash: row.catalog_hash }) !== p.hash) throw new Error('Stored proposal integrity check failed');
          const revision = currentVersion.revision + 1, hash = digest({ document, catalog: current });
          db.prepare('INSERT INTO policy_versions VALUES(?,?,?,?,?,?,?,?)').run(revision, canonicalJSON(document), canonicalJSON(current), hash, p.inputId, p.id, request.commandId, now());
          const revoke = db.prepare('INSERT INTO policy_revocations VALUES(?,?,?,?) ON CONFLICT(repository,kind,reference) DO UPDATE SET revision=excluded.revision');
          for (const repository of current.repositories) {
            const before = rawValues(currentVersion.document, repository), after = rawValues(document, repository);
            for (const capability of before['permissions.grants'].filter(c => before['permissions.ceiling'].includes(c) && currentVersion.bindings.capabilities.includes(c))) {
              if (!after['permissions.grants'].includes(capability) || !after['permissions.ceiling'].includes(capability) || !current.capabilities.includes(capability)) revoke.run(repository, 'capability', capability, revision);
            }
            for (const resource of before['permissions.resources']) if (!after['permissions.resources'].includes(resource) || !(current.resources ?? []).includes(resource)) revoke.run(repository, 'resource', resource, revision);
            for (const provider of ['github', 'codex', 'ollama']) if (before[`connections.${provider}`] && after[`connections.${provider}`] === null) revoke.run(repository, 'connection', before[`connections.${provider}`], revision);
            for (const extension of after['skills.disabled']) if (!before['skills.disabled'].includes(extension)) revoke.run(repository, 'extension', extension, revision);
            if (before['skills.bundledEnabled'] && !after['skills.bundledEnabled']) revoke.run(repository, 'bundled', 'bundled', revision);
            if (before['agents.takeover'] && !after['agents.takeover']) revoke.run(repository, 'takeover', 'automatic', revision);
          }
          db.prepare('UPDATE policy_proposals SET consumed_revision=? WHERE id=? AND consumed_revision IS NULL').run(revision, p.id);
          return immutable({ applied: true, revision, hash, target: p.target, values: view({ revision, hash, document, bindings: current }, p.target, current).values });
        });
      },
    };
    const worker = {
      read(target, revision) { if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error('Invalid policy version'); return immutable(view(versionData(revision), target)); },
      propose(request) { const current = facts(); const preview = previewEdit(request, versionData(), current); const { document: _document, ...visible } = preview; return immutable({ origin: 'agent', ...visible }); },
      authority(target, revision) {
        const current = facts(), captured = versionData(revision), latest = versionData(); targetCheck(target, current);
        const revocations = db.prepare('SELECT kind,reference FROM policy_revocations WHERE repository=? AND revision>?').all(target, captured.revision);
        const revoked = (kind, reference) => revocations.some(r => r.kind === kind && r.reference === reference);
        const old = rawValues(captured.document, target), active = rawValues(latest.document, target);
        const stillBound = (key, ref) => ref && captured.bindings[key].some(b => b.id === ref && current[key].some(n => n.id === ref && canonicalJSON(n) === canonicalJSON(b)));
        const connectionAllowed = ref => !revoked('connection', ref) && stillBound('connections', ref) && current.connections.some(c => c.id === ref && c.healthy !== false && (!target || c.repositories.includes(target)));
        const connections = ['github', 'codex', 'ollama'].map(provider => old[`connections.${provider}`]).filter(connectionAllowed);
        const dev = old['agents.dev'];
        const devAllowed = ref => stillBound('developers', ref) && connectionAllowed(current.developers.find(d => d.id === ref).connection);
        return immutable({ capabilities: old['permissions.grants'].filter(c => !revoked('capability', c) && old['permissions.ceiling'].includes(c) && active['permissions.grants'].includes(c) && active['permissions.ceiling'].includes(c) && current.capabilities.includes(c)),
          resources: old['permissions.resources'].filter(ref => !revoked('resource', ref) && active['permissions.resources'].includes(ref) && (current.resources ?? []).includes(ref)),
          connections, dev: dev && devAllowed(dev) ? dev : null,
          fallbacks: old['agents.fallbacks'].filter(devAllowed), takeover: old['agents.takeover'] && active['agents.takeover'] && !revoked('takeover', 'automatic'),
          extensions: old['skills.extensions'].filter(ref => !revoked('extension', ref) && !old['skills.disabled'].includes(ref) && !active['skills.disabled'].includes(ref) && stillBound('extensions', ref)),
          bundledSkills: old['skills.bundledEnabled'] && active['skills.bundledEnabled'] && !revoked('bundled', 'bundled') });
      },
    };
    migrateRuntime(db, directory, transaction, !version);
    const runtime = createRuntime(db, { transaction, policy: worker, clock: now, inspectors });
    return Object.freeze({ control: Object.freeze(control), worker: Object.freeze(worker), runtime, close });
  } catch (error) { close(); throw error; }
}
