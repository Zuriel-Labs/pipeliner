import { randomUUID, createHash } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { updateShapes, updateCommand } from './commands.mjs';
import { checkUpdateContext, parseUpdateVersion } from './manifest.mjs';
import { readUpdateSource } from './source.mjs';
import { endpointURL } from '../tools/transport.mjs';

export function createUpdateManager({ policy, version = null, history = null, sources = () => [], reader = readUpdateSource,
  host = { platform: process.platform, architecture: process.arch }, foreground = () => true, maintenance = null, recovery = () => false,
  prepareInstaller = null, ownsIntent = () => false, recoveryDetails = () => null, initialRevision = 1, onChange = () => {}, onApplied = () => {} }) {
  record(host, ['platform', 'architecture']);
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 1 || [onChange, onApplied, sources, reader, foreground, recovery, ownsIntent, recoveryDetails].some(fn => typeof fn !== 'function')
    || prepareInstaller !== null && typeof prepareInstaller !== 'function'
    || history !== null && ['read', 'begin', 'complete', 'fail'].some(name => typeof history[name] !== 'function')
    || maintenance !== null && typeof maintenance.exclusive !== 'function'
    || Object.values(host).some(value => typeof value !== 'string' || !/^[a-z0-9_-]{1,16}$/.test(value))
    || version !== null && (typeof version !== 'string' || version.length > 128 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version))) throw Error('Desktop update controls unavailable');
  host = { ...host };
  const recovering = () => { try { return recovery() !== false; } catch { return true; } };
  const conversationId = randomUUID(); let revision = initialRevision, observed, preview = null, applied = null, message = null, closed = false, pending = null;
  function catalog() {
    const input = sources(), ids = new Set(), labels = new Set(); if (!Array.isArray(input) || input.length > 64) throw Error();
    const items = input.map(value => {
      record(value, ['id', 'label', 'key', 'origin', 'path']);
      const { label, ...trust } = value;
      if (typeof label !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,119}$/u.test(label) || ids.has(trust.id) || labels.has(label.toLowerCase())) throw Error();
      checkUpdateContext(trust, { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.0.0', sequence: 0 }, Date.now());
      endpointURL(trust.origin + trust.path + 'stable.json'); ids.add(trust.id); labels.add(label.toLowerCase());
      return { label, trust, keyHash: createHash('sha256').update(trust.key.export({ type: 'spki', format: 'der' })).digest('hex') };
    }).sort((a, b) => a.trust.id.localeCompare(b.trust.id));
    const fingerprint = canonicalJSON(items.map(({ label, trust: { key: _key, ...trust }, keyHash }) => ({ label, ...trust, keyHash })));
    return { items, fingerprint };
  }
  function inspect() {
    const view = !closed && policy ? policy.worker.read(null) : null;
    let approved; try { approved = catalog(); } catch { approved = { items: [], fingerprint: 'unavailable' }; }
    const selected = approved.items.find(item => item.trust.id === view?.values['updates.source'].value) ?? null;
    return { view, approved, selected, current: view ? { ...host, channel: view.values['updates.channel'].value, version } : null };
  }
  function ownsPreparation(operation = pending) {
    try { return Boolean(operation?.intent && operation === pending && operation.kind === 'install' && ownsIntent(operation.intent) === true); }
    catch { return false; }
  }
  const signature = value => canonicalJSON({ revision: value.view?.revision ?? null, catalog: value.approved.fingerprint, recovery: recovering() && !ownsPreparation() });
  function invalidate() { if (preview) policy.control.invalidate(preview.inputId); preview = null; applied = null; }
  function sync() {
    const value = inspect(), current = signature(value);
    if (observed !== undefined && current !== observed) { invalidate(); pending?.controller.abort(); revision++; }
    observed = current; return value;
  }
  const capable = value => value.view && value.selected && history && version && host.platform === 'darwin' && host.architecture === 'arm64';
  function status() {
    const context = sync(), { view, selected, approved } = context; let saved = null;
    try { if (capable(context)) saved = history.read(selected.trust, context.current); } catch { /* Preserve history and fail closed. */ }
    const sourceName = id => id === null ? null : approved.items.find(item => item.trust.id === id)?.label ?? 'Unavailable saved source';
    const display = values => Object.fromEntries(preview.keys.map(id => [id, id === 'updates.source'
      ? { ...values[id], value: sourceName(values[id].value), configuredValue: sourceName(values[id].configuredValue) } : values[id]]));
    const recoveryRequired = recovering(); let maintenance = null;
    if (recoveryRequired) try {
      const value = recoveryDetails();
      if (value !== null) {
        canonicalJSON(value); record(value, ['phase', 'fromVersion', 'toVersion', 'installerRecorded', 'backupsRecorded', 'candidateRecorded', 'replacementRecorded']);
        if (!['preparing', 'staged', 'verified', 'replacing', 'relaunching', 'repair-required'].includes(value.phase)
          || !['installerRecorded', 'candidateRecorded', 'replacementRecorded'].every(key => typeof value[key] === 'boolean')
          || !Number.isSafeInteger(value.backupsRecorded) || value.backupsRecorded < 0 || value.backupsRecorded > 3) throw Error();
        parseUpdateVersion(value.fromVersion); parseUpdateVersion(value.toVersion); maintenance = { ...value };
      }
    } catch { /* Unverified details are omitted; the physical recovery fence remains. */ }
    return { revision, storageAvailable: Boolean(view), recoveryRequired, scope: 'host', policyRevision: view?.revision ?? null, installedVersion: version,
      values: view ? { 'updates.channel': view.values['updates.channel'] } : null,
      sources: approved.items.map(item => ({ name: item.label })), sourceName: selected?.label ?? null,
      sourceConfigured: Boolean(view?.values['updates.source'].value), sourceQualified: Boolean(saved), installQualified: false, busy: Boolean(pending),
      lastCheck: saved?.lastCheck ?? null, upToDate: Boolean(saved?.availability && !saved.availability.available),
      release: saved?.availability?.available ? Object.fromEntries(['version', 'channel', 'platform', 'architecture', 'sequence', 'bytes', 'sha256', 'sourceCommit', 'gitTree', 'expiresAt']
        .map(key => [key, saved.availability.release[key]])) : null,
      maintenance, preview: preview ? { hash: preview.hash, scope: preview.scope, target: preview.target, baseRevision: preview.baseRevision, expiresAt: preview.expiresAt,
        before: display(preview.before), after: display(preview.after) } : null,
      message: recoveryRequired && !ownsPreparation() ? 'Desktop maintenance needs verified recovery before work can resume. Keep the installed app and saved data; settings and repositories are preserved.' : message };
  }
  function publish() { try { onChange(status()); } catch { message = 'Update view needs refresh. Reopen Settings to inspect saved settings.'; } }
  function prepare(changes, reset = []) {
    record(changes, [], ['updates.channel', 'updates.source']); invalidate();
    const input = policy.control.capture({ commandId: randomUUID(), conversationId, target: null, text: 'Review this Mac’s Desktop update settings.' });
    try {
      preview = { ...policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId, scope: 'host', target: null, changes, reset }),
        keys: [...Object.keys(changes), ...reset] };
      message = 'Review this Mac’s update settings. Applying saves settings only; no update is checked, downloaded or installed.';
    } catch (error) {
      policy.control.invalidate(input.id);
      if (error.message !== 'Policy proposal has no change') throw error;
      message = 'Desktop update settings already match. No configuration version was created.';
    }
    revision++; publish(); return { snapshot: status() };
  }
  async function check(manual) {
    const context = sync(); if (pending) return { snapshot: status() };
    if (!capable(context) || !status().sourceQualified) {
      if (!manual) return { snapshot: status() };
      revision++; message = 'Updates cannot be checked yet. A trusted source and protected update history need qualification. No check or download ran.';
      publish(); return { snapshot: status() };
    }
    let attempt;
    try { attempt = history.begin(context.selected.trust, context.current, { manual }); }
    catch { revision++; message = 'Protected update history needs repair. No check or download ran.'; publish(); return { snapshot: status() }; }
    if (!attempt) return { snapshot: status() };
    const operation = { controller: new AbortController(), signature: signature(context) }; pending = operation;
    revision++; message = 'Checking signed update availability. No installer is downloaded.';
    operation.done = (async () => {
      try {
        operation.controller.signal.throwIfAborted(); if (signature(sync()) !== operation.signature || closed) throw Error();
        const result = await reader({ trust: context.selected.trust, current: attempt.current, retained: attempt.retained, signal: operation.controller.signal });
        operation.controller.signal.throwIfAborted(); if (signature(sync()) !== operation.signature || closed
          || typeof result?.envelope !== 'string' || Buffer.byteLength(result.envelope) > 16384) throw Error();
        const verified = history.complete(attempt.token, Buffer.from(result.envelope));
        message = verified.available ? 'Version ' + verified.release.version + ' is available. Installation needs a verified installer and recovery plan.'
          : 'No newer signed release was provided. No installer was downloaded.';
      } catch {
        message = operation.controller.signal.aborted || closed ? 'Update check cancelled or changed. Previous verified history is preserved.'
          : 'Update availability could not be verified. Previous verified history is preserved; retry Check Now when ready.';
        try { history.fail(attempt.token); } catch { message = 'Protected update history needs repair. Existing data is preserved.'; }
      } finally { pending = null; revision++; publish(); }
    })();
    publish(); await operation.done; return { snapshot: status() };
  }
  async function dispatch(payload) {
    sync(); if (closed) throw Error('Desktop update protected configuration unavailable'); canonicalJSON(payload);
    const shape = updateShapes[payload?.operation]; if (!shape) throw Error('Desktop update operation unavailable'); record(payload, ['operation', ...shape[0]], shape[1]);
    if (payload.operation === 'chat') {
      const action = updateCommand(payload.text); if (!action) throw Error('Desktop update command unavailable'); return dispatch(action);
    }
    if (payload.operation === 'view') return { snapshot: status() };
    if (!policy) throw Error('Desktop update protected configuration unavailable');
    if (recovering() && !['view', 'stop'].includes(payload.operation)) throw Error('maintenance-recovery-required');
    if (payload.operation === 'prepare') { record(payload.changes, [], ['updates.channel']); return prepare(payload.changes); }
    if (payload.operation === 'source') {
      if (payload.name === null) return prepare({ 'updates.source': null });
      if (typeof payload.name !== 'string' || payload.name.length > 120) throw Error('Desktop update source unavailable');
      const source = catalog().items.find(item => item.label.toLowerCase() === payload.name.trim().toLowerCase());
      if (!source) throw Error('Desktop update source unavailable'); return prepare({ 'updates.source': source.trust.id });
    }
    if (payload.operation === 'check') return check(true);
    if (payload.operation === 'stop') { const operation = pending; operation?.controller.abort(); await operation?.done; return { snapshot: status() }; }
    if (payload.operation === 'reset') return prepare({}, ['updates.channel']);
    if (payload.operation === 'cancel') { invalidate(); revision++; message = 'Update settings change cancelled. Saved settings and app files are preserved.'; }
    else if (payload.operation === 'apply') {
      if (payload.hash !== undefined && (typeof payload.hash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.hash))) throw Error('Desktop update preview changed');
      if (!preview) { if (applied && (payload.hash === undefined || applied === payload.hash)) return { snapshot: status(), applied: false }; throw Error('Desktop update preview unavailable'); }
      const p = preview; if (payload.hash !== undefined && payload.hash !== p.hash) throw Error('Desktop update preview changed');
      const result = policy.control.apply({ commandId: randomUUID(), proposalId: p.id, inputId: p.inputId, hash: p.hash, conversationId, target: null });
      preview = null; applied = p.hash; observed = signature(inspect()); pending?.controller.abort(); revision++; message = 'Update settings saved for this Mac. No check, download, installation or restart ran.';
      try { onApplied(); } catch { message = 'Update settings saved. Refresh did not finish; reopen Settings to inspect them.'; }
      publish(); return { snapshot: status(), applied: result.applied };
    } else if (payload.operation === 'install') {
      if (pending) return { snapshot: status() };
      const context = inspect();
      if (!capable(context) || !status().release || !maintenance) {
        revision++; message = 'Update installation is unavailable. A verified release, qualified installer and migration/recovery preview are required. No app files changed.';
      } else {
        const operation = { kind: 'install', controller: new AbortController(), signature: signature(context) }; pending = operation; revision++;
        message = 'Inspecting idle work on this Mac. No installer is downloaded.';
        operation.done = (async () => {
          try {
            await maintenance.exclusive(async checkpoint => {
              const check = () => {
                operation.controller.signal.throwIfAborted();
                if (closed || pending !== operation || signature(sync()) !== operation.signature || operation.intent && !ownsPreparation(operation)) throw Error('maintenance-deferred');
                checkpoint(); operation.controller.signal.throwIfAborted();
              };
              check();
              if (!prepareInstaller) { message = 'Idle work verified. Installation still needs a qualified native installer and compatible recovery preview. No app files changed.'; return; }
              message = 'Preparing the verified update and protected recovery copies. The installed app is preserved.';
              const token = await prepareInstaller(Object.freeze({ trust: Object.freeze({ ...context.selected.trust }), current: Object.freeze({ ...context.current }),
                checkpoint: check, signal: operation.controller.signal, onIntent(token) {
                  if (operation.intent || closed || pending !== operation || operation.controller.signal.aborted || !token || typeof token !== 'object'
                    || !Object.isFrozen(token) || ownsIntent(token) !== true || !recovering()) throw Error('maintenance-deferred');
                  operation.intent = token; check(); publish();
                } }));
              check(); if (token !== operation.intent || !ownsPreparation(operation)) throw Error('maintenance-deferred');
              message = 'Update preparation verified. Installation and restart still need qualified completion; the installed app is preserved.';
            }, { signal: operation.controller.signal, ownsRecovery: () => ownsPreparation(operation) });
          } catch { message = 'Update deferred: work is busy, changed or unverified. Finish or repair pending work, then retry. No work was stopped and no app files changed.'; }
          finally { pending = null; revision++; publish(); }
        })();
        publish(); await operation.done; return { snapshot: status() };
      }
    } else if (payload.operation !== 'view') throw Error('Desktop update operation unavailable');
    publish(); return { snapshot: status() };
  }
  return Object.freeze({ status, dispatch, sync() { sync(); publish(); },
    async poll() { if (closed || recovering() || foreground() !== true) return { snapshot: status() }; return check(false); },
    async stop() { const operation = pending; operation?.controller.abort(); await operation?.done; },
    async close() { if (!closed) { invalidate(); closed = true; } const operation = pending; operation?.controller.abort(); await operation?.done; } });
}
