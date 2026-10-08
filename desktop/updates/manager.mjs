import { randomUUID, createHash } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { updateShapes, updateCommand } from './commands.mjs';
import { checkUpdateContext, parseUpdateVersion } from './manifest.mjs';
import { readUpdateSource } from './source.mjs';
import { endpointURL } from '../tools/transport.mjs';
import { checkUninstallPlan } from './uninstall.mjs';

export function createUpdateManager({ policy, version = null, history = null, sources = () => [], reader = readUpdateSource,
  host = { platform: process.platform, architecture: process.arch }, foreground = () => true, maintenance = null, recovery = () => false,
  prepareInstaller = null, ownsIntent = () => false, recoveryDetails = () => null, inspectRemoval = null, removalDetails = () => null,
  removeApp = null, recoverRemoval = null, onRemoved = () => {},
  clock = Date.now, initialRevision = 1, onChange = () => {}, onApplied = () => {} }) {
  record(host, ['platform', 'architecture']);
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 1 || [onChange, onApplied, onRemoved, sources, reader, foreground, recovery, ownsIntent, recoveryDetails, removalDetails, clock].some(fn => typeof fn !== 'function')
    || prepareInstaller !== null && typeof prepareInstaller !== 'function'
    || inspectRemoval !== null && typeof inspectRemoval !== 'function'
    || [removeApp, recoverRemoval].some(value => value !== null && typeof value !== 'function')
    || history !== null && ['read', 'begin', 'complete', 'fail'].some(name => typeof history[name] !== 'function')
    || maintenance !== null && typeof maintenance.exclusive !== 'function'
    || Object.values(host).some(value => typeof value !== 'string' || !/^[a-z0-9_-]{1,16}$/.test(value))
    || version !== null && (typeof version !== 'string' || version.length > 128 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version))) throw Error('Desktop update controls unavailable');
  host = { ...host };
  const recovering = () => { try { return recovery() !== false; } catch { return true; } };
  const conversationId = randomUUID(); let revision = initialRevision, observed, preview = null, removalPreview = null, removalPlan = null, applied = null, message = null, closed = false, pending = null;
  function time() { const now = clock(); if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 900000) throw Error('Desktop maintenance clock unavailable'); return now; }
  function removalRecord() {
    try {
      const value = removalDetails(); if (value === null) return null;
      canonicalJSON(value); record(value, ['phase', 'version', 'credentialCount', 'backgroundStatus']); parseUpdateVersion(value.version);
      if (!['logout-pending', 'service-pending', 'credentials-pending', 'trash-pending', 'removed'].includes(value.phase)
        || !Number.isSafeInteger(value.credentialCount) || value.credentialCount < 0 || value.credentialCount > 2048
        || !['not-registered', 'enabled', 'requires-approval', 'not-found'].includes(value.backgroundStatus)) throw Error();
      return { ...value };
    } catch { return null; } // Details do not clear the independent physical recovery fence.
  }
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
  const removing = () => ['removal-apply', 'removal-resume'].includes(pending?.kind);
  // The native host verifies each journal transition; policy/catalog changes still cancel this operation.
  const signature = value => canonicalJSON({ revision: value.view?.revision ?? null, catalog: value.approved.fingerprint,
    recovery: removing() ? pending.baselineRecovery : recovering() && !ownsPreparation(), removal: removing() ? pending.baselineRemoval : removalRecord() });
  function invalidate() { if (preview) policy.control.invalidate(preview.inputId); preview = null; removalPreview = null; removalPlan = null; applied = null; }
  function sync() {
    const value = inspect(), current = signature(value);
    if (observed !== undefined && current !== observed) { invalidate(); pending?.controller.abort(); revision++; }
    if (removalPreview && removalPreview.expiresAt < time()) { removalPreview = null; removalPlan = null; revision++; message = 'Removal inspection expired. Review Desktop removal again; app files and saved data are preserved.'; }
    observed = current; return value;
  }
  const capable = value => value.view && value.selected && history && version && host.platform === 'darwin' && host.architecture === 'arm64';
  function status() {
    const context = sync(), { view, selected, approved } = context; let saved = null;
    try { if (capable(context)) saved = history.read(selected.trust, context.current); } catch { /* Preserve history and fail closed. */ }
    const sourceName = id => id === null ? null : approved.items.find(item => item.trust.id === id)?.label ?? 'Unavailable saved source';
    const display = values => Object.fromEntries(preview.keys.map(id => [id, id === 'updates.source'
      ? { ...values[id], value: sourceName(values[id].value), configuredValue: sourceName(values[id].configuredValue) } : values[id]]));
    const recoveryRequired = recovering(), removal = removalRecord(); let maintenanceDetails = null;
    if (recoveryRequired) try {
      const value = recoveryDetails();
      if (value !== null) {
        canonicalJSON(value); record(value, ['phase', 'fromVersion', 'toVersion', 'installerRecorded', 'backupsRecorded', 'candidateRecorded', 'replacementRecorded']);
        if (!['preparing', 'staged', 'verified', 'replacing', 'relaunching', 'repair-required'].includes(value.phase)
          || !['installerRecorded', 'candidateRecorded', 'replacementRecorded'].every(key => typeof value[key] === 'boolean')
          || !Number.isSafeInteger(value.backupsRecorded) || value.backupsRecorded < 0 || value.backupsRecorded > 3) throw Error();
        parseUpdateVersion(value.fromVersion); parseUpdateVersion(value.toVersion); maintenanceDetails = { ...value };
      }
    } catch { /* Unverified details are omitted; the physical recovery fence remains. */ }
    return { revision, storageAvailable: Boolean(view), recoveryRequired, scope: 'host', policyRevision: view?.revision ?? null, installedVersion: version,
      values: view ? { 'updates.channel': view.values['updates.channel'] } : null,
      sources: approved.items.map(item => ({ name: item.label })), sourceName: selected?.label ?? null,
      sourceConfigured: Boolean(view?.values['updates.source'].value), sourceQualified: Boolean(saved), installQualified: false, busy: Boolean(pending),
      busyOperation: pending?.kind ?? (pending ? 'check' : null),
      lastCheck: saved?.lastCheck ?? null, upToDate: Boolean(saved?.availability && !saved.availability.available),
      release: saved?.availability?.available ? Object.fromEntries(['version', 'channel', 'platform', 'architecture', 'sequence', 'bytes', 'sha256', 'sourceCommit', 'gitTree', 'expiresAt']
        .map(key => [key, saved.availability.release[key]])) : null,
      maintenance: maintenanceDetails, removal, removalInspectable: Boolean(view && version && inspectRemoval && maintenance && host.platform === 'darwin' && host.architecture === 'arm64' && !recoveryRequired),
      removalQualified: Boolean(removeApp && version && host.platform === 'darwin' && host.architecture === 'arm64' && !recoveryRequired),
      removalRecoverable: Boolean(recoverRemoval && version && host.platform === 'darwin' && host.architecture === 'arm64' && recoveryRequired && removal && removal.phase !== 'removed'),
      removalPreview: removalPreview ? { ...removalPreview } : null,
      preview: preview ? { hash: preview.hash, scope: preview.scope, target: preview.target, baseRevision: preview.baseRevision, expiresAt: preview.expiresAt,
        before: display(preview.before), after: display(preview.after) } : null,
      message: recoveryRequired && !ownsPreparation() && !removing() ? 'Desktop maintenance needs verified recovery before work can resume. Keep the installed app and saved data; settings and repositories are preserved.' : message };
  }
  function publish() { try { onChange(status()); } catch { message = 'Update view needs refresh. Reopen Settings to inspect saved settings.'; } }
  async function inspectAppRemoval() {
    if (pending) return { snapshot: status() };
    if (!status().removalInspectable) {
      revision++; message = 'App removal inspection needs the packaged foreground Mac and protected idle state. No removal ran.'; publish(); return { snapshot: status() };
    }
    invalidate(); const operation = { kind: 'removal-inspect', controller: new AbortController(), signature: signature(inspect()) }; pending = operation;
    revision++; message = 'Inspecting this app and preserved data while work is idle. No removal ran.';
    operation.done = (async () => {
      try {
        await maintenance.exclusive(async checkpoint => {
          const check = () => {
            operation.controller.signal.throwIfAborted();
            if (closed || pending !== operation || signature(sync()) !== operation.signature) throw Error('maintenance-deferred');
            checkpoint(); operation.controller.signal.throwIfAborted();
          };
          check(); const captured = await inspectRemoval(Object.freeze({ checkpoint: check, signal: operation.controller.signal })); check();
          checkUninstallPlan(captured); if (!Object.isFrozen(captured) || captured.identity.version !== version) throw Error();
          const expiresAt = time() + 900000;
          removalPreview = Object.freeze({ hash: createHash('sha256').update(canonicalJSON({ plan: captured, policyRevision: inspect().view.revision, expiresAt })).digest('hex'),
            version: captured.identity.version, sourceCommit: captured.identity.sourceCommit, gitTree: captured.identity.gitTree,
            credentialCount: captured.credentials.before.stored, backgroundStatus: captured.service.status, expiresAt });
          removalPlan = captured;
          message = removeApp ? 'Review app removal. Remove Desktop app signs out its managed account, removes local credentials and background registration, then moves this app to Trash. Repository files and nonsecret records stay preserved.'
            : 'Removal inspection ready. Verified removal is not yet available in this installation. App files, credentials and saved data are preserved.';
        }, { signal: operation.controller.signal });
      } catch { removalPreview = null; removalPlan = null; message = 'Removal inspection did not finish: work is busy, changed or unverified. No removal ran; app files and saved data are preserved.'; }
      finally { pending = null; revision++; publish(); }
    })();
    publish(); await operation.done; return { snapshot: status() };
  }
  async function remove(payload) {
    if (pending) throw Error('Desktop removal already active');
    const resume = payload.operation === 'removal-resume', capability = status();
    if (resume ? !capability.removalRecoverable : !capability.removalQualified || !removalPreview || !removalPlan) throw Error('Desktop removal unavailable');
    if (!resume && payload.hash !== undefined && payload.hash !== removalPreview.hash) throw Error('Desktop removal preview changed');
    const plan = removalPlan, baselineRecovery = recovering(), baselineRemoval = removalRecord();
    invalidate();
    const operation = { kind: payload.operation, controller: new AbortController(), baselineRecovery, baselineRemoval }; pending = operation;
    operation.signature = signature(inspect()); revision++; message = resume ? 'Verifying interrupted app removal before resuming.' : 'Removing this app while work is idle. Repository files and nonsecret records stay preserved.';
    operation.done = (async () => {
      let removed = false;
      try {
        const checkpoint = () => {
          operation.controller.signal.throwIfAborted();
          if (closed || pending !== operation || signature(sync()) !== operation.signature) throw Error('maintenance-deferred');
        };
        checkpoint();
        removed = await (resume ? recoverRemoval : removeApp)(Object.freeze({ ...(resume ? {} : { plan }), signal: operation.controller.signal, checkpoint })) === true;
        if (!removed) throw Error('uninstall-recovery-required');
        message = 'App removal verified. Pipeliner is closing; repository files and nonsecret records stay preserved.';
      } catch { removed = false; message = 'App removal did not finish. Inspect recovery before resuming; completed effects are not undone.'; }
      finally { pending = null; observed = signature(inspect()); revision++; publish(); }
      if (removed) onRemoved();
    })();
    publish(); await operation.done; return { snapshot: status() };
  }
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
    if (payload.operation === 'stop' || payload.operation === 'removal-cancel' && removing()) {
      const operation = pending; operation?.controller.abort(); await operation?.done; return { snapshot: status() };
    }
    if (payload.operation === 'removal-resume') return remove(payload);
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
    if (payload.operation === 'removal-apply') return remove(payload);
    if (payload.operation === 'removal-inspect') return inspectAppRemoval();
    if (payload.operation === 'removal-cancel') {
      if (pending && pending.kind !== 'removal-inspect') throw Error('Desktop removal inspection unavailable');
      removalPreview = null; removalPlan = null; const operation = pending; operation?.controller.abort(); await operation?.done;
      revision++; message = 'Removal inspection cancelled. App files, credentials and saved data are preserved.'; publish(); return { snapshot: status() };
    }
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
