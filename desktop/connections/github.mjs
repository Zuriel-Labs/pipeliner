import { isDeepStrictEqual } from 'node:util';
import { collectConnection } from '../../scripts/lib/project.mjs';
import { readApp, startDevice, startSetupDevice, refreshDevice, refreshSetupDevice } from '../github/device.mjs';
import { makeRequest, appPermissions } from '../github/transport.mjs';

export const githubApp = Object.freeze({ slug: 'pipeliner-desktop', id: 5148613, clientId: 'Iv23liXNpydn3E3Qt5JK', owner: 'Zuriel-Labs' });
const setupClient = 'Ov23liqnTj1cUOMnqW1l'; // Public OAuth client, never a client secret.
const positive = n => Number.isSafeInteger(n) && n > 0;
const nodeId = id => typeof id === 'string' && /^[A-Za-z0-9_=-]{1,180}$/.test(id);
const login = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(name);

async function restPages(read, path, collection, signal) {
  const nodes = [], ids = new Set(); let expected;
  for (let page = 1; page <= 100; page++) {
    signal?.throwIfAborted();
    const value = await read('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = collection ? value[collection] : value;
    if (!Array.isArray(rows) || rows.length > 100 || (collection && (!Number.isSafeInteger(value.total_count) || value.total_count < 0))) throw new Error('partial-access');
    if (collection) { expected ??= value.total_count; if (expected !== value.total_count) throw new Error('partial-access'); }
    for (const row of rows) { if (!positive(row?.id) || ids.has(row.id)) throw new Error('partial-access'); ids.add(row.id); nodes.push(row); }
    if (rows.length < 100) { if (collection && nodes.length !== expected) throw new Error('partial-access'); return nodes; }
  }
  throw new Error('partial-access');
}

async function projectPages(read, owner, signal) {
  let pages = 0;
  return collectConnection(async cursor => {
    signal?.throwIfAborted(); if (++pages > 100) throw new Error('partial-access');
    const result = await read('POST', '/graphql', { query: `query($id:ID!,$cursor:String){node(id:$id){... on ${owner.type}{id projectsV2(first:100,after:$cursor){totalCount nodes{id number title public} pageInfo{hasNextPage endCursor}}}}}`, variables: { id: owner.node_id, cursor } });
    if (result.data?.node?.id !== owner.node_id) throw new Error('partial-access');
    return result.data.node.projectsV2;
  }).then(projects => projects.map(project => {
    if (!nodeId(project.id) || !positive(project.number) || typeof project.title !== 'string' || !project.title.length || project.title.length > 256 || typeof project.public !== 'boolean') throw new Error('partial-access');
    return { id: project.id, number: project.number, title: project.title, owner: owner.login, ownerId: owner.node_id };
  })).catch(error => { if (error.message.startsWith('graphql-') || error.message.startsWith('http-')) throw error; throw new Error('partial-access'); });
}

export async function inspectGitHub(credential, { setup = false, previousAccount, signal, send = fetch, now = Date.now } = {}) {
  if (typeof credential?.accessToken !== 'string' || !(setup ? /^gho_[A-Za-z0-9_]{8,200}$/ : /^ghu_[A-Za-z0-9_]{8,200}$/).test(credential.accessToken)) throw new Error('reauthentication-required');
  const read = makeRequest(credential.accessToken, send, signal), account = await read('GET', '/user');
  if (!positive(account.id) || !nodeId(account.node_id) || !login(account.login) || account.type !== 'User') throw new Error('response-invalid');
  if (previousAccount && (account.id !== previousAccount.id || account.node_id !== previousAccount.node)) throw new Error('account-changed');
  const repositories = [], projects = [], installations = [], owners = new Map(); let projectsComplete = true;
  if (setup) {
    owners.set(account.id, account);
    for (const owner of await restPages(read, '/user/orgs', null, signal)) {
      if (!login(owner.login) || !nodeId(owner.node_id)) throw new Error('partial-access');
      owners.set(owner.id, { ...owner, type: 'Organization' });
    }
    for (const repo of await restPages(read, '/user/repos?affiliation=owner,organization_member,collaborator', null, signal)) repositories.push(repo);
  } else {
    const app = await readApp(githubApp.slug, { send, signal });
    if (app.id !== githubApp.id || app.clientId !== githubApp.clientId || app.owner !== githubApp.owner || !isDeepStrictEqual(app.permissions, appPermissions)) throw new Error('app-changed');
    for (const installation of await restPages(read, '/user/installations', 'installations', signal)) {
      const owner = installation.account;
      if (installation.app_id !== githubApp.id || !positive(owner?.id) || !nodeId(owner.node_id) || !login(owner.login) || !['User', 'Organization'].includes(owner.type) ||
        !['all', 'selected'].includes(installation.repository_selection) || !installation.permissions || typeof installation.permissions !== 'object') throw new Error('partial-access');
      if (installation.suspended_at) continue;
      owners.set(owner.id, owner);
      installations.push({ id: installation.id, account: owner.login, selection: installation.repository_selection,
        permissions: Object.entries(installation.permissions).map(([name, level]) => `${name}: ${level}`) });
      for (const repo of await restPages(read, `/user/installations/${installation.id}/repositories`, 'repositories', signal)) {
        if (repo.owner?.id !== owner.id) throw new Error('partial-access'); repositories.push(repo);
      }
    }
  }
  const normalized = repositories.map(repo => {
    if (!nodeId(repo.node_id) || !login(repo.owner?.login) || typeof repo.full_name !== 'string' || typeof repo.name !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repo.name) || repo.full_name !== `${repo.owner.login}/${repo.name}` || typeof repo.private !== 'boolean') throw new Error('partial-access');
    return { id: repo.node_id, numericId: repo.id, name: repo.full_name, owner: repo.owner.login, private: repo.private,
      permissions: Object.entries(repo.permissions ?? {}).filter(([, allowed]) => allowed === true).map(([name]) => name) };
  });
  if (new Set(normalized.map(repo => repo.id)).size !== normalized.length) throw new Error('partial-access');
  for (const owner of owners.values()) {
    if (!setup && owner.type === 'User') { projectsComplete = false; continue; }
    try { projects.push(...await projectPages(read, owner, signal)); }
    catch (error) { if (!/^(http-403|graphql-(forbidden|insufficient-scopes|not-found))$/.test(error.message)) throw error; projectsComplete = false; }
  }
  const after = await read('GET', '/user');
  if (after.id !== account.id || after.node_id !== account.node_id || after.login !== account.login) throw new Error('account-changed');
  return { credential, account: { id: account.id, node: account.node_id }, view: { account: account.login,
    health: projectsComplete ? 'connected' : 'limited', lastVerified: now(), expiresAt: credential.expiresAt,
    repositories: normalized, projects, installations, resourceCompleteness: { repositories: true, projects: projectsComplete },
    owners: [...owners.values()].map(owner => ({ id: owner.id, node: owner.node_id, login: owner.login, type: owner.type })),
    permissions: setup ? [...credential.scopes] : Object.entries(appPermissions).map(([name, level]) => `${name}: ${level}`), models: [], capability: null } };
}

export function githubAdapter({ setup = false, prompt, send = fetch, now = Date.now, wait } = {}) {
  const clientId = setup ? setupClient : githubApp.clientId;
  async function refresh({ value, signal }) {
    let credential = value.credential;
    if (credential.expiresAt !== null && credential.expiresAt <= now() + 60000) {
      if (!credential.refreshToken || credential.refreshExpiresAt <= now()) throw new Error('reauthentication-required');
      credential = await (setup ? refreshSetupDevice : refreshDevice)(clientId, credential.refreshToken, { send, signal, now });
    }
    return inspectGitHub(credential, { setup, previousAccount: value.account, send, signal, now });
  }
  return {
    async connect({ signal }) {
      const flow = await (setup ? startSetupDevice : startDevice)(clientId, { signal, send, now, ...(wait ? { wait } : {}) });
      let surface;
      try { surface = await prompt({ connection: setup ? 'github-setup' : 'github', verificationUri: flow.verificationUri, userCode: flow.userCode, signal, cancel: flow.cancel });
        return await inspectGitHub(await flow.authorize(), { setup, send, signal, now }); }
      finally { flow.cancel(); await surface?.close?.(); }
    }, refresh, test: refresh,
    async disconnect() {}, // Local erasure is owned by the manager; remote grants remain explicit.
  };
}
