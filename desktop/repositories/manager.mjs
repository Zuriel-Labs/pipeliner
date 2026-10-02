import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJSON } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';
import * as github from './github.mjs';
import * as local from './local.mjs';

const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const workspaceId = repo => 'repo_' + hash(repo.id).slice(0, 24);
const safeError = error => /^(http-\d{3}|graphql-(forbidden|insufficient-scopes|not-found|rejected|validation)|partial-access|connection-(unavailable|changed|denied)|account-changed|owner-unavailable|repository-unavailable|installation-access-required|project-unavailable|field-conflict|readback-mismatch|creation-denied|folder-(unavailable|changed|exists)|local-identity-invalid|workspace-conflict|setup-(changed|uncertain|busy|expired|incomplete)|git-(clone-incomplete|cleanup-failed|destination-denied)|native-entry-(failed|cancelled))$/.test(error?.message) ? error.message : 'setup-check-failed';
const repoIdentity = repo => ({ id: repo.id, numericId: repo.numericId, owner: repo.owner, name: repo.name, slug: repo.slug, private: repo.private });
const sameFields = (first, second) => isDeepStrictEqual([...first].sort((a, b) => a.id.localeCompare(b.id)), [...second].sort((a, b) => a.id.localeCompare(b.id)));
const immutableChoice = draft => ['applying', 'waiting-access', 'uncertain', 'recovery-required'].includes(draft?.state);

export function createWorkspaceManager({ store, connections, folder, protectedPaths = [], openInstallation, api = github, inspect = local.inspectLocal, checkout = local.createCheckout, initialRevision = 1, onChange = () => {}, now = Date.now }) {
  let revision = initialRevision, task = null, closed = false, finalStatus = null, draft = store?.draft() ?? null, message = null;
  if (draft && ['applying', 'working'].includes(draft.state)) { draft.state = 'recovery-required'; store.saveDraft(draft); }
  const publish = () => { revision++; onChange(publicStatus()); };
  const save = (value, text) => { store.saveDraft(value); draft = value; if (text) message = text; publish(); };
  function status() {
    if (finalStatus) return finalStatus;
    const publicConnections = connections.status().connections;
    return { revision, storageAvailable: Boolean(store), busy: Boolean(task), draft, message,
      repositories: publicConnections.find(connection => connection.id === 'github')?.repositories ?? [],
      owners: publicConnections.find(connection => connection.id === 'github-setup')?.owners ?? [],
      workspaces: store?.workspaces() ?? [], selected: store?.selected() ?? null,
      pending: store?.pending('setup').map(effect => ({ job: effect.job, step: effect.step, state: effect.state, target: effect.binding.target })) ?? [] };
  }
  function question() {
    if (!draft || ['complete', 'cancelled'].includes(draft.state)) return null;
    if (task || immutableChoice(draft)) return null;
    const choices = [], values = draft.values;
    if (draft.mode === 'create') {
      if (!values.owner) return { text: status().owners.length ? 'Who should own this project? Choose an account below or type its name.' : 'Connect GitHub setup and Projects to choose a verified owner.', choices: status().owners.map(owner => ({ label: owner.login, operation: 'choose', field: 'owner', value: owner.login })) };
      if (!values.name) return { text: 'What should the repository be called? Use letters, numbers, dots, underscores or hyphens.', choices };
      if (!values.purpose) return { text: 'What is the purpose of this project?', choices };
      if (!values.visibility) return { text: 'Should the repository be Private or Public? Private is recommended; the choice is yours.', choices: ['private', 'public'].map(value => ({ label: value === 'private' ? 'Private' : 'Public', operation: 'choose', field: 'visibility', value })) };
    } else if (!isLocal() && !values.repository) return { text: 'Which authorized GitHub repository should I import?', choices: status().repositories.map(repo => ({ label: repo.name, operation: 'choose', field: 'repository', value: repo.name })) };
    if (!draft.folder) return { text: isLocal() ? 'Choose the existing project folder. I will inspect it while preserving your work.' : 'Choose the parent folder for a new checkout. Existing folders will be preserved.', choices: [{ label: 'Choose folder', operation: 'folder' }] };
    if (!draft.projects) return { text: 'Your folder is selected. Review setup to discover the available Projects.', choices: [{ label: 'Review setup', operation: 'prepare' }] };
    if (!values.project) return { text: 'Which Project should track this repository? Existing data stays preserved.', choices: [{ label: 'New private Project', operation: 'choose', field: 'project', value: 'new' },
      ...draft.projects.filter(project => project.viewerCanUpdate !== false).map(project => ({ label: project.title, operation: 'choose', field: 'project', value: project.id }))] };
    if (draft.state === 'preview') return { text: 'The setup preview is ready for ' + draft.preview.target + '. Inspect the changes below, then say “Apply this setup” or cancel.', choices: [{ label: 'Show setup preview', operation: 'show' }, { label: 'Apply this setup', operation: 'apply', hash: draft.preview.hash }] };
    return { text: 'Your choices are saved. Review the exact setup before applying it.', choices: [{ label: 'Review setup', operation: 'prepare' }] };
  }
  function ready() { if (closed || !store) throw new Error('connection-unavailable'); }
  function requireDraft() { ready(); if (!draft || ['cancelled', 'complete'].includes(draft.state)) throw new Error('setup-incomplete'); }
  function operate(fn) {
    requireDraft(); if (task) throw new Error('setup-busy');
    const controller = new AbortController(), id = draft.id, active = { controller };
    task = active; publish();
    active.done = Promise.resolve().then(() => fn(controller.signal)).catch(error => {
      if (draft.id !== id) return;
      const pending = store.effects(id).some(effect => ['dispatched', 'uncertain'].includes(effect.state));
      const verified = store.effects(id).some(effect => effect.state === 'verified');
      const state = pending ? 'uncertain' : controller.signal.aborted ? 'cancelled' : error.message === 'installation-access-required' ? 'waiting-access' : verified ? 'recovery-required' : 'failed';
      save({ ...draft, state, error: controller.signal.aborted ? 'cancelled' : safeError(error) },
        pending ? 'A setup result is uncertain. It will not be repeated. Check the result or deliberately import existing resources; nothing is deleted automatically.' : state === 'waiting-access' ? 'The created repository is preserved. Grant it to the scoped GitHub App, then continue setup.' : state === 'cancelled' ? 'Setup cancelled. Existing work and any created resources are preserved.' : 'Setup could not finish. The selected target and existing work are preserved.');
    }).finally(() => { if (task === active) { task = null; publish(); } });
    return { accepted: true, snapshot: publicStatus() };
  }
  function setChoice(field, value) {
    requireDraft(); if (task || immutableChoice(draft)) throw new Error('setup-busy');
    const allowed = ['repository', 'owner', 'name', 'purpose', 'visibility', 'project', 'source'];
    if (!allowed.includes(field) || typeof value !== 'string' || value.length > 350 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('setup-incomplete');
    if (field === 'visibility' && !['private', 'public'].includes(value) || field === 'source' && !['local', 'download'].includes(value)
      || field === 'name' && (!/^[A-Za-z0-9_.-]{1,100}$/.test(value) || ['.', '..'].includes(value))
      || field === 'purpose' && (!value.trim() || containsSecret(value))) throw new Error('setup-incomplete');
    if (field === 'repository' && !status().repositories.some(repo => repo.name.toLowerCase() === value.toLowerCase())) throw new Error('repository-unavailable');
    if (field === 'owner' && !status().owners.some(owner => owner.login.toLowerCase() === value.toLowerCase())) throw new Error('owner-unavailable');
    if (field === 'project' && value !== 'new' && !draft.projects?.some(project => project.id === value)) throw new Error('project-unavailable');
    const values = { ...draft.values, [field]: value };
    const changed = { ...draft };
    if (['owner', 'repository', 'source'].includes(field)) {
      delete values.project;
      for (const key of ['projects', 'projectSnapshot', 'project', 'repo', 'owner', 'inspected']) delete changed[key];
      if (field === 'source') delete changed.folder;
    }
    if (field === 'project') { delete changed.projectSnapshot; delete changed.project; }
    save({ ...changed, values, preview: null, error: null, state: 'choosing', mapping: {} }, 'Choice saved. Review setup after resolving the remaining choices.');
    return { snapshot: publicStatus() };
  }
  async function leases(signal, setup, app) {
    const result = {};
    try {
      if (setup) result.setup = await connections.acquire('github-setup', signal);
      if (app) result.app = await connections.acquire('github', signal);
      return result;
    } catch (error) { Object.values(result).forEach(lease => lease.close()); throw error; }
  }
  const closeLeases = values => Object.values(values).forEach(lease => lease.close());
  const isLocal = () => draft.mode === 'local' || draft.values.source === 'local';
  async function prepare(signal) {
    if (immutableChoice(draft)) throw new Error('setup-uncertain');
    if (!draft.folder) throw new Error('setup-incomplete');
    const creating = draft.mode === 'create', values = draft.values;
    if (creating && (!values.owner || !values.name || !values.purpose || !values.visibility)) throw new Error('setup-incomplete');
    if (!creating && !isLocal() && !values.repository) throw new Error('setup-incomplete');
    await local.checkFolder(draft.folder, { protectedPaths, workspace: isLocal() });
    let inspected = isLocal() ? await inspect(draft.folder.path, undefined, signal) : null;
    if (inspected && values.repository && values.repository.toLowerCase() !== inspected.slug) throw new Error('local-identity-invalid');
    const held = await leases(signal, creating, !creating);
    try {
      let repo = null, owner, projectLease;
      if (creating) {
        owner = await api.readOwner(held.setup, values.owner);
        const repositories = await api.ownerRepositories(held.setup, owner);
        if (repositories.some(repo => repo.nameWithOwner.toLowerCase() === (owner.login + '/' + values.name).toLowerCase())) throw new Error('repository-unavailable');
        projectLease = held.setup;
      } else {
        repo = await api.readRepository(held.app, inspected?.slug ?? values.repository); repo.workspaceId = workspaceId(repo);
        const existing = store.workspaces().find(workspace => workspace.repositoryId === repo.id);
        if (existing) {
          await inspect(existing.path, { repository: existing.id, owner: repo.owner.login, name: repo.name }, signal);
          store.select(existing.id); save({ ...draft, state: 'complete', result: existing }, 'This repository already has a workspace. Its existing folder is selected.'); return;
        }
        owner = repo.owner; projectLease = held.app;
        if (owner.type === 'User') { held.setup = await connections.acquire('github-setup', signal); projectLease = held.setup; }
        if (inspected) inspected = await inspect(draft.folder.path, { repository: repo.workspaceId, owner: repo.owner.login, name: repo.name }, signal);
      }
      const projects = await api.listProjects(projectLease, owner);
      save({ ...draft, repo, owner, projects, inspected, state: 'choosing', error: null }, 'Choose a linked Project, then review the exact setup.');
      if (!values.project) return;
      const project = values.project === 'new' ? null : await api.readProject(projectLease, values.project);
      if (project && project.owner.id !== owner.id) throw new Error('project-unavailable');
      save({ ...draft, projectSnapshot: project }, 'Project fields inspected. Existing option identities are preserved.');
      const title = 'Pipeliner · ' + (repo?.name ?? values.name);
      if (!project && projects.some(project => project.title === title)) throw new Error('project-unavailable');
      const plan = api.planFields(project?.fields ?? [], draft.mapping ?? {});
      const target = repo?.slug ?? (owner.login + '/' + values.name).toLowerCase();
      if (store.pending('setup').some(effect => effect.binding.target === target) && (!project || plan.some(field => field.missing.length) || !project.repositories.some(item => item.id === repo?.id))) throw new Error('setup-uncertain');
      if (!inspected) await local.destination(draft.folder, repo?.name ?? values.name, { protectedPaths });
      const preview = { target, title, folder: draft.folder, values, owner, repo, project, plan, inspected, mapping: draft.mapping ?? {},
        appEpoch: held.app?.epoch ?? null, setupEpoch: held.setup?.epoch ?? null,
        appAccount: held.app?.value.account ?? null, setupAccount: held.setup?.value.account ?? null, expiresAt: now() + 900000 };
      preview.hash = hash(preview); signal.throwIfAborted();
      save({ ...draft, preview, state: 'preview', error: null }, 'Review the target, visibility, folder and Project changes. Apply this setup to make only these changes.');
    } finally { closeLeases(held); }
  }
  async function effect(step, binding, fn, signal) {
    signal.throwIfAborted();
    const action = store.prepare(draft.id, step, { target: draft.preview.target, ...binding });
    if (action.state === 'verified') return action.result;
    if (action.state !== 'prepared' || !store.dispatch(action.id)) throw new Error('setup-uncertain');
    try {
      const result = await fn(); signal.throwIfAborted(); store.finish(action.id, 'verified', result); return result;
    } catch (error) { store.finish(action.id, /^(http-(401|403|404|422)|graphql-(forbidden|insufficient-scopes|validation))$/.test(error.message) ? 'denied' : 'uncertain'); throw error; }
  }
  async function apply(signal, repairing = false) {
    const preview = draft.preview;
    if (!preview || hash(Object.fromEntries(Object.entries(preview).filter(([key]) => key !== 'hash'))) !== preview.hash || !repairing && preview.expiresAt < now()) throw new Error('setup-expired');
    if (store.effects(draft.id).some(effect => ['dispatched', 'uncertain', 'denied'].includes(effect.state))) throw new Error('setup-uncertain');
    const creating = draft.mode === 'create', owner = preview.owner, needSetup = creating || owner.type === 'User';
    if (!repairing) for (const [id, epoch] of [['github', preview.appEpoch], ['github-setup', preview.setupEpoch]]) if (epoch !== null && connections.epoch(id) !== epoch) throw new Error('setup-changed');
    save({ ...draft, state: 'applying', error: null }, 'Applying this setup. Existing work, fields and controls stay preserved.');
    const held = await leases(signal, needSetup, !creating);
    try {
      for (const [key, expected] of [['app', preview.appAccount], ['setup', preview.setupAccount]]) if (expected && !isDeepStrictEqual(held[key]?.value.account, expected)) throw new Error('account-changed');
      await local.checkFolder(draft.folder, { protectedPaths, workspace: isLocal() });
      const projectLease = needSetup ? held.setup : held.app;
      let repo;
      if (creating) {
        const known = store.effects(draft.id).find(effect => effect.step === 'create-repository' && effect.state === 'verified');
        if (known) {
          repo = await api.readRepository(held.setup, known.result.slug);
          if (!isDeepStrictEqual(repoIdentity(repo), repoIdentity(known.result))) throw new Error('readback-mismatch');
        } else {
          const currentOwner = await api.readOwner(held.setup, owner.login);
          if (!isDeepStrictEqual(currentOwner, owner) || (await api.ownerRepositories(held.setup, owner)).some(repo => repo.nameWithOwner.toLowerCase() === preview.target)) throw new Error('setup-changed');
          repo = await effect('create-repository', { owner, values: preview.values }, () => api.createRepository(held.setup, owner, preview.values), signal);
        }
      } else {
        repo = await api.readRepository(held.app, preview.repo.slug);
        if (!isDeepStrictEqual(repoIdentity(repo), repoIdentity(preview.repo))) throw new Error('setup-changed');
      }
      repo.workspaceId = workspaceId(repo); save({ ...draft, repo }, 'Repository identity verified; checking the linked Project.');
      let project;
      if (preview.project) {
        project = await api.readProject(projectLease, preview.project.id);
        const ownWrites = store.effects(draft.id).some(effect => effect.state === 'verified' && (effect.step === 'link-project' || effect.step.startsWith('field-')));
        if (project.owner.id !== owner.id || !ownWrites && !isDeepStrictEqual(project, preview.project)) throw new Error('setup-changed');
        if (!project.repositories.some(item => item.id === repo.id)) project = await effect('link-project', { project: project.id, repo: repo.id }, () => api.linkProject(projectLease, project, repo), signal);
      } else {
        const known = store.effects(draft.id).find(effect => effect.step === 'create-project' && effect.state === 'verified');
        if (known) project = await api.readProject(projectLease, known.result.id);
        else {
          if ((await api.listProjects(projectLease, owner)).some(project => project.title === preview.title)) throw new Error('setup-changed');
          project = await effect('create-project', { owner, repository: repo.id, title: preview.title }, () => api.createProject(projectLease, owner, repo, preview.title), signal);
        }
      }
      if (project.owner.id !== owner.id || !project.repositories.some(item => item.id === repo.id)) throw new Error('readback-mismatch');
      save({ ...draft, project }, 'Project identity verified; preserving existing field and option identities.');
      const baseline = preview.project ?? store.effects(draft.id).find(effect => effect.step === 'create-project')?.result;
      let expectedFields = [...baseline.fields];
      for (const recorded of store.effects(draft.id).filter(effect => effect.step.startsWith('field-') && effect.state === 'verified')) {
        expectedFields = [...expectedFields.filter(field => field.id !== recorded.result.id), recorded.result];
      }
      if (!sameFields(project.fields, expectedFields)) throw new Error('setup-changed');
      const plans = api.planFields(project.fields, preview.mapping);
      for (const field of plans) {
        if (!field.missing.length) continue;
        const before = await api.readProject(projectLease, project.id);
        if (!sameFields(before.fields, expectedFields)) throw new Error('setup-changed');
        const changed = await effect('field-' + field.role, { project: project.id, field }, () => api.applyField(projectLease, project.id, field), signal);
        expectedFields = [...expectedFields.filter(existing => existing.id !== changed.id), changed];
        project = await api.readProject(projectLease, project.id);
        if (!sameFields(project.fields, expectedFields)) throw new Error('setup-changed');
        api.verifyFields(project.fields, [{ ...field, id: changed.id }]);
      }
      const final = await api.readProject(projectLease, project.id);
      if (!sameFields(final.fields, expectedFields)) throw new Error('setup-changed');
      api.verifyFields(final.fields, api.planFields(final.fields, preview.mapping));
      if (final.owner.id !== owner.id || !final.repositories.some(item => item.id === repo.id)) throw new Error('readback-mismatch');
      if (creating) {
        try { held.app = await connections.acquire('github', signal); }
        catch { throw new Error('installation-access-required'); }
        let scoped;
        try { scoped = await api.readRepository(held.app, repo.slug); }
        catch { throw new Error('installation-access-required'); }
        if (!isDeepStrictEqual(repoIdentity(scoped), repoIdentity(repo))) throw new Error('readback-mismatch');
      }
      let inspected;
      if (isLocal()) inspected = await inspect(draft.folder.path, { repository: repo.workspaceId, owner: repo.owner.login, name: repo.name }, signal);
      else inspected = await effect('clone', { repository: repo.id, folder: draft.folder },
        () => checkout(draft.folder, repo, held.app, { signal, protectedPaths, onProcess: process => save({ ...draft, process }, 'Preparing only the selected new checkout.') }), signal);
      const verified = await inspect(inspected.identity.checkoutRoot, { repository: repo.workspaceId, owner: repo.owner.login, name: repo.name }, signal);
      if (verified.identity.localKey !== inspected.identity.localKey || verified.identity.slug !== repo.slug) throw new Error('local-identity-invalid');
      const currentProject = await api.readProject(projectLease, final.id), currentRepo = await api.readRepository(held.app, repo.slug);
      if (!isDeepStrictEqual(currentProject, final) || !isDeepStrictEqual(repoIdentity(currentRepo), repoIdentity(repo))) throw new Error('setup-changed');
      held.app.check(); projectLease.check(); signal.throwIfAborted();
      const fields = Object.fromEntries(api.planFields(final.fields, preview.mapping).map(field => {
        const actual = final.fields.find(item => item.id === field.id);
        return [field.role, { id: actual.id, name: actual.name, options: actual.options.map(({ id, name }) => ({ id, name })) }];
      }));
      const workspace = { id: repo.workspaceId, repositoryId: repo.id, numericId: repo.numericId, slug: repo.slug, name: repo.displayName,
        private: repo.private, path: verified.identity.checkoutRoot, localKey: verified.identity.localKey, commonPath: verified.identity.commonPath,
        project: { id: final.id, number: final.number, title: final.title, owner: final.owner, public: final.public, fields },
        connections: { github: 'github', setup: needSetup ? 'github-setup' : null }, verifiedAt: now(), changes: verified.changes };
      const registered = store.register(workspace); store.select(registered.workspace.id);
      save({ ...draft, state: 'complete', result: registered.workspace, error: null }, 'Project connected. Existing work is preserved. No Dev is assigned, no Issue has started, and background is off.');
    } finally { closeLeases(held); }
  }
  function dispatch(payload) {
    ready();
    if (payload.operation === 'begin') {
      if (task || immutableChoice(draft)) throw new Error('setup-busy');
      if (!['local', 'import', 'create'].includes(payload.mode)) throw new Error('setup-incomplete');
      save({ id: randomUUID(), mode: payload.mode, values: {}, mapping: {}, state: 'choosing' }, 'Choose the target and folder. Private is recommended for a new project; choose visibility explicitly.');
      for (const [field, value] of Object.entries(payload.values ?? {})) setChoice(field, value);
      return { snapshot: publicStatus() };
    }
    if (payload.operation === 'select') { if (task) throw new Error('setup-busy'); store.select(payload.workspace); publish(); return { snapshot: publicStatus(), message: 'Saved workspace selected. Access is checked again before an affected action.' }; }
    if (payload.operation === 'cancel') { requireDraft(); task?.controller.abort(); save({ ...draft, state: 'cancelled' }, 'Setup cancelled. Any created or uncertain resources remain preserved.'); return { snapshot: publicStatus() }; }
    if (payload.operation === 'choose') {
      let field = payload.field, value = payload.value;
      if (field === 'projectName') { const choices = draft?.projects?.filter(project => project.title.toLowerCase() === value.toLowerCase()); if (choices?.length !== 1) throw new Error('project-unavailable'); field = 'project'; value = choices[0].id; }
      return setChoice(field, value);
    }
    if (payload.operation === 'map') {
      requireDraft(); if (task || immutableChoice(draft)) throw new Error('setup-busy');
      const role = github.definitions.find(item => item.role.toLowerCase() === payload.role.toLowerCase())?.role;
      let field = payload.field;
      if (payload.name) { const matches = draft.projectSnapshot?.fields?.filter(field => field.options && field.name.toLowerCase() === payload.name.toLowerCase()); if (matches?.length !== 1) throw new Error('field-conflict'); field = matches[0].id; }
      if (!role || field !== null && !draft.projectSnapshot?.fields?.some(item => item.id === field && item.options)) throw new Error('field-conflict');
      save({ ...draft, mapping: { ...draft.mapping, [role]: field }, preview: null, state: 'choosing' }, 'Field choice saved; review the setup again.'); return { snapshot: publicStatus() };
    }
    if (payload.operation === 'folder') return operate(async signal => {
      if (immutableChoice(draft)) throw new Error('setup-busy');
      const path = await folder(signal, isLocal()); signal.throwIfAborted();
      const selected = await local.folderIdentity(path, { protectedPaths, workspace: isLocal() });
      save({ ...draft, folder: selected, preview: null, state: 'choosing', error: null }, 'Folder selected. Existing contents are preserved.');
    });
    if (payload.operation === 'prepare') return operate(prepare);
    if (payload.operation === 'apply') {
      if (draft?.state === 'complete' && (!payload.hash || payload.hash === draft.preview?.hash)) return { snapshot: publicStatus() };
      requireDraft();
      if (draft.state !== 'preview' || payload.hash && payload.hash !== draft.preview?.hash) throw new Error('setup-changed');
      return operate(signal => apply(signal));
    }
    if (payload.operation === 'repair') return operate(async signal => {
      if (store.effects(draft.id).some(effect => ['dispatched', 'uncertain', 'denied'].includes(effect.state))) throw new Error('setup-uncertain');
      if (['waiting-access', 'recovery-required', 'failed'].includes(draft.state) && draft.preview) return apply(signal, true);
      return prepare(signal);
    });
    if (payload.operation === 'install') { requireDraft(); if (draft.state !== 'waiting-access') throw new Error('installation-access-required'); return operate(async signal => { await openInstallation(); signal.throwIfAborted(); message = 'Grant the created repository to the scoped GitHub App, then continue setup.'; }); }
    if (payload.operation === 'answer') {
      requireDraft(); if (typeof payload.text !== 'string' || containsSecret(payload.text)) throw new Error('setup-incomplete');
      const value = payload.text.trim();
      if (draft.mode === 'create') {
        for (const field of ['owner', 'name', 'purpose', 'visibility']) if (!draft.values[field]) return setChoice(field, field === 'visibility' ? value.toLowerCase() : value);
      } else if (!isLocal() && !draft.values.repository) return setChoice('repository', value.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, ''));
      if (draft.projects?.length || draft.folder) {
        if (/^(?:new|new project)$/i.test(value)) return setChoice('project', 'new');
        const projects = draft.projects?.filter(project => project.title.toLowerCase() === value.toLowerCase());
        if (projects?.length === 1) return setChoice('project', projects[0].id);
      }
      return { message: 'Choose a folder or Project below, then review and apply this setup.' };
    }
    throw new Error('setup-incomplete');
  }
  const publicStatus = () => ({ ...status(), question: closed ? null : question() });
  return Object.freeze({ status: publicStatus, dispatch, async idle() { if (task) await task.done; }, async close() { closed = true; task?.controller.abort(); if (task) await task.done; finalStatus = { ...status(), busy: false }; } });
}
