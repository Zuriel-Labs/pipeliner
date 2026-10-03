import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { skillName, skillPackage, collisionChoices } from './package.mjs';
import { discoverSkill, discoverSkillLink } from './source.mjs';
import { skillManifestHash } from './store.mjs';
import { skillCommand, skillShapes } from './commands.mjs';
export { skillCommand, skillShapes } from './commands.mjs';

const keys = ['skills.bundledEnabled', 'skills.extensions', 'skills.disabled'];
const metadata = ({ instructions: _instructions, files: _files, ...item }) => item;
const packageData = ({ id: _id, kind: _kind, ...item }) => item;

// Narrow host action: only the exact policy-approved pin, under both permission ceilings.
export function installAuthorizedSkills(skills, view, grant, check = () => {}) {
  const pins = view.values['skills.extensions'].value.filter(id => !view.values['skills.disabled'].value.includes(id));
  for (const id of pins) {
    check(); const item = skills.get(id); if (item.kind === 'bundled' || skills.available(id)) continue;
    if (skills.removed(id) || !grant.extensions.includes(id) || !grant.capabilities.includes('extension.install')) throw new Error('Skill installation needs the exact approved source pin and host/repository permission.');
    skills.install(packageData(item), skills.revision()); check();
  }
}

export function createSkillManager({ store, policy, skills, occupiedNames = () => skills?.names() ?? [], discover = discoverSkill, discoverLink = discoverSkillLink, initialRevision = 1, onChange = () => {}, onApplied = () => {} }) {
  let workspaceId = store?.selected() ?? null, scope = workspaceId ? 'repository' : 'global', revision = initialRevision;
  let conversation = randomUUID(), observedPolicy = policy?.worker.read(null).revision, observedSkills = skills?.revision(), preview = null, pendingPackage = null;
  let collision = null, busy = false, controller = null, closed = false, message = null, error = null, lastSnapshot;
  const target = () => scope === 'repository' ? workspaceId : null;
  const invalidate = () => { if (preview?.proposal) policy.control.invalidate(preview.proposal.inputId); preview = null; };
  function sync() {
    if (closed) return;
    const next = store?.selected() ?? null, p = policy?.worker.read(null).revision, s = skills?.revision();
    if (next !== workspaceId || p !== observedPolicy || s !== observedSkills) {
      invalidate(); controller?.abort(); pendingPackage = null; collision = null; conversation = randomUUID(); revision++;
      if (next !== workspaceId) { workspaceId = next; scope = next ? 'repository' : 'global'; }
      observedPolicy = p; observedSkills = s;
    }
  }
  function status() {
    if (closed) return { ...lastSnapshot, storageAvailable: false, preview: null, busy: false };
    sync(); const view = policy?.worker.read(target()), values = view ? Object.fromEntries(keys.map(key => [key, view.values[key]])) : null;
    const inventory = skills ? [...skills.list()] : [], references = view?.values['skills.extensions'].value ?? [];
    for (const id of references) if (!inventory.some(item => item.id === id)) inventory.push(skills.get(id));
    return lastSnapshot = { revision, workspaceId, scope, repositoryLabel: store?.workspaces().find(item => item.id === workspaceId)?.name ?? null,
      storageAvailable: Boolean(store && policy && skills), busy, values, preview, collision, message, error,
      installPermissions: view ? { host: view.values['permissions.ceiling'].value.includes('extension.install'), repository: workspaceId ? policy.worker.read(workspaceId).values['permissions.grants'].value.includes('extension.install') : false } : null,
      inventory: inventory.map(item => ({ ...metadata(item), available: skills.available(item.id), enabled: Boolean(view && !view.values['skills.disabled'].value.includes(item.id)
        && (item.kind === 'bundled' ? view.values['skills.bundledEnabled'].value : references.includes(item.id))), scope: target(),
        sourceLabel: typeof item.source === 'string' ? item.source : item.source.repository + ' @ ' + item.source.commit + ' / ' + item.source.path })),
      limitation: 'Qualified external packages contain instructions and text references only. Scripts, hooks, binaries and MCP are unavailable here. Tool requirements grant no permission. Removed pins remain as recovery evidence.' };
  }
  const publish = () => { revision++; if (!closed) onChange(status()); };
  function ready() { sync(); if (closed || !store || !policy || !skills || scope === 'repository' && !workspaceId) throw new Error('Skill storage or selected scope unavailable.'); }
  function preparePolicy(action, name, item = null) {
    invalidate(); const view = policy.worker.read(target()), changes = {}, reset = [], disabled = view.values['skills.disabled'].value;
    const current = item ?? status().inventory.find(value => value.name === name);
    if (action === 'reset') { if (scope !== 'repository') throw new Error('Choose repository scope to inherit skills.'); reset.push(...keys); }
    else if (!current) throw new Error('Skill name unavailable in the selected inventory.');
    else if (action === 'remove') {
      if (current.kind === 'bundled') throw new Error('Bundled skills can be disabled, not removed.');
      // Removal is an app inventory action, and visibly tightens every repository immediately.
    } else if (action === 'disable') changes['skills.disabled'] = [...new Set([...disabled, ...skills.pins(name)])];
    else if (['enable', 'install', 'authorize'].includes(action)) {
      changes['skills.disabled'] = disabled.filter(id => !skills.pins(name).includes(id));
      if (current.kind === 'bundled') changes['skills.bundledEnabled'] = true;
      else {
        const retained = view.values['skills.extensions'].value.filter(id => skills.get(id).name !== name);
        changes['skills.extensions'] = [...retained, current.id];
      }
    } else throw new Error('Skill action unavailable.');
    let proposal = null;
    if (action !== 'remove') {
      const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: target(), text: 'Review ' + scope + ' skill ' + action + ' ' + (name ?? 'inheritance') });
      try { proposal = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope, target: target(), changes, reset }); }
      catch (reason) { policy.control.invalidate(input.id); if (reason.message !== 'Policy proposal has no change') throw reason; }
    }
    const value = { action, name, item: current ? metadata(current) : null, proposal, scope, target: target(),
      inventoryRevision: skills.revision(), policyRevision: view.revision, affectedRepositories: action === 'remove' ? store.workspaces().map(item => item.name)
        : proposal?.affectedRepositories.map(id => store.workspaces().find(item => item.id === id)?.name ?? id) ?? (target() ? [store.workspaces().find(item => item.id === target())?.name] : store.workspaces().map(item => item.name)),
      timing: action === 'remove' ? 'Immediately blocks every run using this name. Immutable content remains for recovery.'
        : action === 'disable' ? 'Immediately blocks captured use. Re-enabling applies to new runs.' : 'Future runs use this exact pin; active runs retain their captured versions.' };
    preview = { ...value, hash: skillManifestHash(value) }; message = 'Review skill, exact version, affected scope and timing. Installation grants no tools.'; publish();
  }
  async function discoverPackage(payload) {
    if (Object.hasOwn(payload, 'source') === Object.hasOwn(payload, 'link')) throw new Error('Skill discovery needs one folder link or exact source.');
    busy = true; controller = new AbortController(); invalidate(); pendingPackage = null; collision = null; error = null; publish();
    const context = conversation, scopeTarget = target();
    try {
      const pack = await (payload.link ? discoverLink(payload.link, { signal: controller.signal, ...(payload.name ? { name: payload.name } : {}) })
        : discover(payload.source, { signal: controller.signal, ...(payload.name ? { name: payload.name } : {}) }));
      controller.signal.throwIfAborted(); sync(); if (conversation !== context || target() !== scopeTarget) throw new Error('Skill discovery context changed.');
      pendingPackage = pack; const occupied = occupiedNames(), existing = skills.list().find(item => item.name === pack.name) ?? skills.pins(pack.name).map(id => skills.get(id)).at(-1);
      if (occupied.includes(pack.name) && (!existing || typeof existing.source === 'string' || existing.source.repository !== pack.source.repository || existing.source.path !== pack.source.path)) {
        collision = { name: pack.name, choices: collisionChoices(pack.name, occupied) }; message = 'Skill name already exists. Choose an available single-word name; existing skill stays intact.'; publish();
      } else stage();
    } finally { busy = false; controller = null; publish(); }
  }
  function stage() {
    const item = skills.stage(pendingPackage, skills.revision()); observedSkills = skills.revision(); collision = null;
    preparePolicy('install', item.name, item);
  }
  function preparePermission(payload) {
    if (!['host', 'repository'].includes(payload.scope) || typeof payload.enabled !== 'boolean' || payload.scope === 'repository' && !workspaceId) throw new Error('Choose host or repository installation permission.');
    invalidate(); const policyTarget = payload.scope === 'host' ? null : workspaceId, view = policy.worker.read(policyTarget), key = payload.scope === 'host' ? 'permissions.ceiling' : 'permissions.grants';
    const values = view.values[key].configuredValue, changes = { [key]: payload.enabled ? [...new Set([...values, 'extension.install'])] : values.filter(value => value !== 'extension.install') };
    const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: policyTarget, text: 'Review ' + payload.scope + ' agent installation permission ' + payload.enabled });
    let proposal; try { proposal = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope: payload.scope, target: policyTarget, changes, reset: [] }); }
    catch (reason) { policy.control.invalidate(input.id); if (reason.message === 'Policy proposal has no change') { message = 'Skill installation permission already matches.'; publish(); return; } throw reason; }
    const value = { action: payload.enabled ? 'allow agent installs' : 'deny agent installs', name: null, item: null, proposal, scope: payload.scope, target: policyTarget,
      contextScope: scope, contextTarget: target(), inventoryRevision: skills.revision(), policyRevision: view.revision,
      affectedRepositories: proposal.affectedRepositories.map(id => store.workspaces().find(item => item.id === id)?.name ?? id),
      timing: payload.enabled ? 'New runs only. Agent installs still need an exact approved source pin; packages grant no tools.' : 'Revokes installation immediately for captured runs.' };
    preview = { ...value, hash: skillManifestHash(value) }; message = 'Review installation permission separately from skill content.'; publish();
  }
  async function dispatch(payload) {
    try {
      ready(); canonicalJSON(payload); const shape = skillShapes[payload.operation]; if (!shape) throw new Error('Skill action unavailable.'); record(payload, ['operation', ...shape[0]], shape[1]);
      if (payload.operation === 'chat') { const action = skillCommand(payload.text); return action ? dispatch(action) : { snapshot: status(), message: 'Ask to show skills, enable or disable a named skill, inspect a source, apply the skill change or cancel it.' }; }
      if (busy && payload.operation !== 'cancel') throw new Error('Skill discovery already pending.'); error = null;
      if (payload.operation === 'view') { if (payload.scope !== undefined) { if (!['global', 'repository'].includes(payload.scope) || payload.scope === 'repository' && !workspaceId) throw new Error('Choose repository or global skill scope.'); if (scope !== payload.scope) { invalidate(); pendingPackage = null; collision = null; scope = payload.scope; conversation = randomUUID(); } } publish(); }
      else if (payload.operation === 'discover') await discoverPackage(payload);
      else if (payload.operation === 'choose') {
        if (!pendingPackage || !collision || !skillName(payload.name) || occupiedNames().includes(payload.name)) throw new Error('Choose an available skill name.');
        pendingPackage = skillPackage({ source: pendingPackage.source, files: pendingPackage.files }, { name: payload.name, occupied: occupiedNames() }); stage();
      } else if (payload.operation === 'prepare') {
        const selected = payload.action === 'authorize' && preview?.action === 'install' ? skills.get(preview.item.id) : null;
        if (payload.action === 'authorize' && !selected) throw new Error('Skill source needs an exact install preview before authorization.');
        preparePolicy(payload.action, selected?.name ?? payload.name, selected);
      }
      else if (payload.operation === 'permission') preparePermission(payload);
      else if (payload.operation === 'reset') preparePolicy('reset', null);
      else if (payload.operation === 'cancel') { controller?.abort(); invalidate(); pendingPackage = null; collision = null; message = 'Skill change cancelled.'; publish(); }
      else if (payload.operation === 'apply') {
        if (!preview || payload.hash && preview.hash !== payload.hash) throw new Error('Skill preview changed; review before applying.');
        const p = preview; if (skills.revision() !== p.inventoryRevision || policy.worker.read(p.target).revision !== p.policyRevision || target() !== (Object.hasOwn(p, 'contextTarget') ? p.contextTarget : p.target) || scope !== (p.contextScope ?? p.scope)) throw new Error('Skill preview context changed.');
        if (p.action === 'remove') skills.remove(p.name, p.inventoryRevision);
        else {
          // Staged immutable content is not installed or authorized until this direct PM action.
          if (p.action === 'install') skills.install(packageData(skills.get(p.item.id)), p.inventoryRevision);
          if (p.proposal) try { policy.control.apply({ commandId: randomUUID(), proposalId: p.proposal.id, inputId: p.proposal.inputId, hash: p.proposal.hash, conversationId: conversation, target: p.target }); }
          catch (reason) {
            if (p.action !== 'install') throw reason;
            invalidate(); pendingPackage = null; observedPolicy = policy.worker.read(null).revision; observedSkills = skills.revision();
            throw new Error('Skill installed in app inventory, but scope selection did not finish. Inspect current selection, then explicitly enable the skill if needed. No automatic retry.');
          }
        }
        preview = null; pendingPackage = null; observedPolicy = policy.worker.read(null).revision; observedSkills = skills.revision();
        message = 'Skill ' + p.action + ' verified. Existing runs keep their pins; disabled or removed content blocks immediately.'; publish(); onApplied();
      }
      return { snapshot: status() };
    } catch (reason) { error = /^Skill |^Captured skill |^Choose |^Bundled skills |^http-\d{3}$|^cancelled$/.test(reason.message) ? reason.message
      : 'Skill change blocked. Saved configuration and run evidence remain preserved; refresh the selected scope.'; publish(); throw new Error(error); }
  }
  return Object.freeze({ status, dispatch, sync() { const before = revision; sync(); if (before !== revision) onChange(status()); }, close() { controller?.abort(); invalidate(); closed = true; } });
}
