import { randomUUID } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';
import { skillName, collisionChoices } from '../skills/package.mjs';
import { toolPackage, qualifyToolPackage, toolManifestHash } from './package.mjs';
import { toolCommand, toolShapes, toolDataNames } from './commands.mjs';
import { endpointURL } from './transport.mjs';

const keys = ['tools.extensions', 'tools.disabled'];
const packageData = ({ id: _id, ...pack }) => pack;
const metadata = pack => ({ id: pack.id, name: pack.name, originalName: pack.originalName, kind: pack.kind, purpose: pack.purpose, version: pack.version,
  license: pack.license, digest: pack.digest, sourceIdentity: pack.sourceIdentity, permissions: pack.permissions, dataCategories: pack.definition.dataCategories,
  inputSchema: (pack.definition.mcp?.tool ?? pack.definition.command).inputSchema });

// Exact previously authorized source only. Packages cannot choose scope or grant installation/invocation.
export async function installAuthorizedTools(tools, view, grant, check) {
  for (const id of view.values['tools.extensions'].value.filter(id => !view.values['tools.disabled'].value.includes(id))) {
    check(); if (tools.available(id)) continue;
    if (tools.removed(id) || !grant.tools.includes(id) || !grant.capabilities.includes('extension.install')) throw new Error('Development tool installation needs an exact approved pin and both permission scopes.');
    const pack = packageData(tools.get(id)); await qualifyToolPackage(pack); check(); tools.install(pack, tools.revision()); check();
  }
}

// Direct PM frame only. The engine and extensions never receive this manager.
export function createToolManager({ store, policy, tools, connections, occupiedNames = () => tools?.names() ?? [], initialRevision = 1, onChange = () => {}, onApplied = () => {} }) {
  let workspaceId = store?.selected() ?? null, scope = workspaceId ? 'repository' : 'global', revision = initialRevision, conversation = randomUUID();
  let observedPolicy = policy?.worker.read(null).revision, observedTools = tools?.revision(), preview = null, catalog = null, pendingPackage = null, collision = null;
  let busy = false, task = null, closed = false, message = null, error = null, lastSnapshot;
  const target = () => scope === 'repository' ? workspaceId : null;
  const invalidate = () => { if (preview?.proposal) policy.control.invalidate(preview.proposal.inputId); preview = null; };
  const clear = () => { invalidate(); catalog = null; pendingPackage = null; collision = null; };
  function sync() {
    if (closed) return;
    const next = store?.selected() ?? null, p = policy?.worker.read(null).revision, t = tools?.revision();
    if (next !== workspaceId || p !== observedPolicy || t !== observedTools) {
      task?.controller.abort(); clear(); conversation = randomUUID(); revision++;
      if (next !== workspaceId) { workspaceId = next; scope = next ? 'repository' : 'global'; }
      observedPolicy = p; observedTools = t;
    }
  }
  function status() {
    if (closed) return { ...lastSnapshot, storageAvailable: false, busy: false, preview: null };
    sync(); const view = policy?.worker.read(target()), refs = view?.values['tools.extensions'].value ?? [], inventory = tools ? [...tools.list()] : [];
    for (const id of refs) if (!inventory.some(item => item.id === id)) inventory.push(tools.get(id));
    return lastSnapshot = { revision, workspaceId, scope, repositoryLabel: store?.workspaces().find(item => item.id === workspaceId)?.name ?? null,
      storageAvailable: Boolean(store && policy && tools), busy, preview, catalog, collision, message, error, dataOptions: toolDataNames,
      values: view ? Object.fromEntries(keys.map(key => [key, view.values[key]])) : null,
      permissions: view ? { host: view.values['permissions.ceiling'].value.includes('extension.invoke'),
        repository: workspaceId ? policy.worker.read(workspaceId).values['permissions.grants'].value.includes('extension.invoke') : false } : null,
      inventory: inventory.map(pack => ({ ...metadata(pack), available: tools.available(pack.id), enabled: Boolean(view && refs.includes(pack.id) && !view.values['tools.disabled'].value.includes(pack.id)),
        connection: pack.kind === 'mcp' && connections ? connections.status(pack.definition.mcp.endpoint) : null })),
      limitation: 'Tool calls require both permission scopes, an exact selected pin and a configured pipeline step. Adding a tool grants no access or step. Credentials stay in native secure entry. Qualified remote servers use HTTPS; unsupported authentication or transports stay unavailable.' };
  }
  const publish = () => { revision++; if (!closed) onChange(status()); };
  const ready = () => { sync(); if (closed || !store || !policy || !tools || scope === 'repository' && !workspaceId) throw new Error('Tool storage or selected scope unavailable.'); };
  async function operate(work) {
    busy = true; const controller = new AbortController(), context = conversation; let finish;
    const done = new Promise(resolve => { finish = resolve; }); task = { controller, done }; publish();
    const check = () => { controller.signal.throwIfAborted(); sync(); if (closed || conversation !== context) throw new Error('Tool operation context changed.'); };
    try { return await work(controller.signal, check); }
    finally { busy = false; task = null; finish(); publish(); }
  }
  function preparePolicy(action, name, pack = null) {
    invalidate(); const view = policy.worker.read(target()), changes = {}, reset = [], item = pack ?? tools.list().find(item => item.name === name); let tightened = [];
    if (action === 'reset') { if (scope !== 'repository') throw new Error('Tool inheritance requires repository scope.'); reset.push(...keys); }
    else if (!item) throw new Error('Tool name unavailable in this inventory.');
    else if (action === 'remove') { /* Removal visibly blocks every repository; immutable evidence remains. */ }
    else if (action === 'disable') changes['tools.disabled'] = [...new Set([...view.values['tools.disabled'].value, ...tools.pins(name)])];
    else if (['enable', 'install', 'authorize'].includes(action)) {
      const pins = tools.pins(name);
      tightened = pins.filter(id => id !== item.id && tools.get(id).definition.dataCategories.some(category => !item.definition.dataCategories.includes(category)));
      changes['tools.disabled'] = [...new Set([...view.values['tools.disabled'].value.filter(id => !pins.includes(id)), ...tightened])];
      changes['tools.extensions'] = [...view.values['tools.extensions'].value.filter(id => tools.get(id).name !== name), item.id];
    } else throw new Error('Tool action unavailable.');
    let proposal = null;
    if (action !== 'remove') {
      const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: target(), text: 'Review ' + scope + ' tool ' + action + ' ' + (name ?? 'inheritance') });
      try { proposal = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope, target: target(), changes, reset }); }
      catch (reason) { policy.control.invalidate(input.id); if (reason.message !== 'Policy proposal has no change') throw reason; }
    }
    const value = { action, name, item: item ? metadata(item) : null, proposal, scope, target: target(), inventoryRevision: tools.revision(), policyRevision: view.revision,
      affectedRepositories: action === 'remove' ? store.workspaces().map(item => item.name) : proposal?.affectedRepositories.map(id => store.workspaces().find(item => item.id === id)?.name ?? id) ?? (target() ? [store.workspaces().find(item => item.id === target()).name] : store.workspaces().map(item => item.name)),
      timing: action === 'remove' ? 'Immediately blocks this name across every repository. Pins stay for recovery; reinstall never revives an old run.'
        : action === 'disable' ? 'Immediately blocks captured use. Re-enabling applies to new runs.' : tightened.length ? 'Removed data categories immediately revoke ' + tightened.length + ' older pins in this scope. Future runs use the new pin; pipeline steps need explicit rebinding. No permissions or steps are added.'
          : 'Future runs use the exact selected definition. Active runs keep their pins. No permissions or pipeline steps are added.' };
    preview = { ...value, hash: toolManifestHash(value) }; message = 'Review tool, destination, data categories, permissions and affected scope before applying.'; publish();
  }
  function stage() {
    const existing = tools.list().find(item => item.name === pendingPackage.name) ?? tools.pins(pendingPackage.name).map(id => tools.get(id)).at(-1), occupied = occupiedNames();
    if (occupied.includes(pendingPackage.name) && (!existing || existing.kind !== pendingPackage.kind || existing.originalName !== pendingPackage.originalName
      || existing.kind === 'mcp' && (existing.sourceIdentity.endpoint !== pendingPackage.sourceIdentity.endpoint || existing.sourceIdentity.tool !== pendingPackage.sourceIdentity.tool))) {
      collision = { name: pendingPackage.name, choices: collisionChoices(pendingPackage.name, occupied) }; message = 'Tool name already exists. Choose an available single-word name; existing content stays intact.'; publish(); return;
    }
    const item = tools.stage(pendingPackage, tools.revision()); observedTools = tools.revision(); collision = null; preparePolicy('install', item.name, item);
  }
  function permission(payload) {
    if (!['host', 'repository'].includes(payload.scope) || typeof payload.enabled !== 'boolean' || payload.scope === 'repository' && !workspaceId) throw new Error('Tool permission needs host or repository scope.');
    invalidate(); const policyTarget = payload.scope === 'host' ? null : workspaceId, view = policy.worker.read(policyTarget), key = payload.scope === 'host' ? 'permissions.ceiling' : 'permissions.grants', before = view.values[key].configuredValue;
    const input = policy.control.capture({ commandId: randomUUID(), conversationId: conversation, target: policyTarget, text: 'Review ' + payload.scope + ' tool calls ' + payload.enabled });
    let proposal;
    try { proposal = policy.control.prepare({ inputId: input.id, requestId: randomUUID(), conversationId: conversation, scope: payload.scope, target: policyTarget,
      changes: { [key]: payload.enabled ? [...new Set([...before, 'extension.invoke'])] : before.filter(item => item !== 'extension.invoke') }, reset: [] }); }
    catch (reason) { policy.control.invalidate(input.id); if (reason.message === 'Policy proposal has no change') { message = 'Tool permission already matches.'; publish(); return; } throw reason; }
    const value = { action: payload.enabled ? 'allow tool calls' : 'deny tool calls', name: null, item: null, proposal, scope: payload.scope, target: policyTarget,
      contextScope: scope, contextTarget: target(), inventoryRevision: tools.revision(), policyRevision: view.revision,
      affectedRepositories: proposal.affectedRepositories.map(id => store.workspaces().find(item => item.id === id)?.name ?? id),
      timing: payload.enabled ? 'New runs only. Exact selected tools, data categories and pipeline bindings remain required. Command steps also need restricted worker permissions.' : 'Immediately revokes tool calls for captured runs.' };
    preview = { ...value, hash: toolManifestHash(value) }; message = 'Review invocation permission separately from tool installation and source data.'; publish();
  }
  async function dispatch(payload) {
    const context = conversation;
    try {
      ready(); canonicalJSON(payload); const shape = toolShapes[payload.operation]; if (!shape) throw new Error('Tool action unavailable.'); record(payload, ['operation', ...shape[0]], shape[1]);
      if (payload.operation === 'chat') { const action = toolCommand(payload.text); return action ? dispatch(action) : { snapshot: status(), message: 'Ask to show tools, inspect a tool server, choose its tool, enable or disable it, review permissions, apply the tool change or cancel.' }; }
      if (busy && !['cancel', 'view'].includes(payload.operation)) throw new Error('Tool operation already pending.'); error = null;
      if (payload.operation === 'view') {
        if (payload.scope !== undefined) { if (!['global', 'repository'].includes(payload.scope) || payload.scope === 'repository' && !workspaceId) throw new Error('Tool scope unavailable.');
          if (scope !== payload.scope) { task?.controller.abort(); clear(); scope = payload.scope; conversation = randomUUID(); } }
        publish();
      } else if (payload.operation === 'discover') await operate(async (signal, check) => {
        clear(); endpointURL(payload.endpoint); if (!['none', 'bearer'].includes(payload.authentication ?? 'none') || !connections) throw new Error('Tool authentication or connection unavailable.');
        if (payload.authentication === 'bearer') await connections.configure(payload.endpoint, { signal, authorize: check }); check();
        let client;
        try { client = await connections.lease({ definition: { mcp: { endpoint: payload.endpoint } } }, { signal, authorize: check }); const result = await client.list({ signal }); check();
          catalog = { endpoint: payload.endpoint, tools: result.tools, rejected: result.rejected ?? [] }; message = 'Server catalog read. Choose a tool to inspect. No Issue data, installation, permission grant or tool call occurred.'; }
        finally { await client?.close(); }
      });
      else if (payload.operation === 'select') {
        const tool = catalog?.tools.find(item => item.name === payload.tool); if (!tool) throw new Error('Tool catalog selection unavailable.');
        pendingPackage = toolPackage({ name: tool.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64),
          purpose: tool.description || tool.title || 'Captured tool ' + tool.name, version: 'catalog-' + toolManifestHash(tool).slice(0, 16),
          license: typeof tool._meta?.license === 'string' ? tool._meta.license : 'Server did not declare a license', dataCategories: [],
          mcp: { endpoint: catalog.endpoint, protocolVersion: '2026-07-28', tool } }); stage();
      } else if (payload.operation === 'define') await operate(async (signal, check) => {
        invalidate(); catalog = null; pendingPackage = toolPackage(payload.definition); await qualifyToolPackage(pendingPackage, { signal }); check(); stage();
      });
      else if (payload.operation === 'data') {
        const item = preview?.item?.name === payload.name ? tools.get(preview.item.id) : tools.list().find(item => item.name === payload.name);
        if (!item) throw new Error('Tool data selection needs an installed or inspected tool.');
        pendingPackage = toolPackage({ ...item.definition, dataCategories: payload.categories }, { name: item.name }); stage();
      }
      else if (payload.operation === 'rename') {
        if (!pendingPackage || !collision || !skillName(payload.name) || occupiedNames().includes(payload.name)) throw new Error('Tool name is unavailable. Choose one displayed alternative.');
        pendingPackage = toolPackage(pendingPackage.definition, { name: payload.name }); stage();
      } else if (payload.operation === 'prepare') {
        const item = payload.action === 'authorize' && preview?.action === 'install' ? tools.get(preview.item.id) : null;
        if (payload.action === 'authorize' && !item) throw new Error('Tool source needs an exact install preview before authorization.'); preparePolicy(payload.action, item?.name ?? payload.name, item);
      } else if (payload.operation === 'permission') permission(payload);
      else if (payload.operation === 'credential') await operate(async (signal, check) => {
        const item = tools.list().find(item => item.name === payload.name);
        if (!connections || item?.kind !== 'mcp' || !['connect', 'disconnect'].includes(payload.action)) throw new Error('Tool credential action unavailable.');
        clear(); if (payload.action === 'connect') await connections.configure(item.definition.mcp.endpoint, { signal, authorize: check });
        else await connections.disconnect(item.definition.mcp.endpoint, { signal, authorize: check }); check();
        message = 'Tool connection changed for this exact server across its repositories. Active requests stopped; old runs retain their captured credential version.'; onApplied();
      });
      else if (payload.operation === 'reset') preparePolicy('reset', null);
      else if (payload.operation === 'cancel') { task?.controller.abort(); clear(); conversation = randomUUID(); message = 'Tool change cancelled. Applied policy remains preserved.'; publish(); }
      else if (payload.operation === 'apply') {
        const p = preview; if (!p || payload.hash && p.hash !== payload.hash) throw new Error('Tool preview changed; review before applying.');
        if (tools.revision() !== p.inventoryRevision || policy.worker.read(p.target).revision !== p.policyRevision || target() !== (Object.hasOwn(p, 'contextTarget') ? p.contextTarget : p.target) || scope !== (p.contextScope ?? p.scope)) throw new Error('Tool preview context changed.');
        if (p.action === 'remove') tools.remove(p.name, p.inventoryRevision);
        else {
          if (p.action === 'install') tools.install(packageData(tools.get(p.item.id)), p.inventoryRevision);
          if (p.proposal) try { policy.control.apply({ commandId: randomUUID(), proposalId: p.proposal.id, inputId: p.proposal.inputId, hash: p.proposal.hash, conversationId: conversation, target: p.target }); }
          catch { clear(); observedTools = tools.revision(); observedPolicy = policy.worker.read(null).revision;
            throw new Error(p.action === 'install' ? 'Tool installed in inventory, but scope selection did not finish. Inspect selection and explicitly enable it; no automatic retry.' : 'Tool policy change did not finish. Refresh this scope and review again.'); }
        }
        preview = null; catalog = null; pendingPackage = null; observedTools = tools.revision(); observedPolicy = policy.worker.read(null).revision;
        message = 'Tool ' + p.action + ' verified. Captured pins stay fixed; disabled or removed content blocks immediately.'; publish(); onApplied();
      }
      return { snapshot: status() };
    } catch (reason) {
      const safe = /^Tool /.test(reason?.message) && reason.message.length < 240 ? reason.message : 'Tool action blocked. Check destination, supported authentication, declared inputs and current scope. No raw server error is shown.';
      if (!closed && conversation === context) { error = safe; publish(); } throw new Error(safe);
    }
  }
  return Object.freeze({ status, dispatch, sync() { const before = revision; sync(); if (before !== revision) onChange(status()); }, async close() { task?.controller.abort(); invalidate(); closed = true; await task?.done; } });
}
