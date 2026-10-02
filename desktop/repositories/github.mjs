import { isDeepStrictEqual } from 'node:util';
import { collectConnection } from '../../scripts/lib/project.mjs';
import { makeRequest } from '../github/transport.mjs';

export const definitions = Object.freeze([
  { role: 'Status', choices: ['Backlog', 'On Hold', 'In Progress', 'In Review', 'Pending Review', 'Done'] },
  { role: 'Priority', choices: ['P0', 'P1', 'P2', 'P3'] },
  { role: 'Impact', choices: ['High', 'Medium', 'Low'] },
  { role: 'Effort', choices: ['XS', 'S', 'M', 'L', 'XL'] },
]);
const node = value => typeof value === 'string' && /^[A-Za-z0-9_=-]{1,180}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(value);
export const githubRequest = (lease, method, path, body) => { lease.check(); return makeRequest(lease.value.credential.accessToken, lease.send ?? fetch, lease.signal)(method, path, body).then(value => { lease.check(); return value; }); };
const request = githubRequest;
const query = (lease, query, variables) => request(lease, 'POST', '/graphql', { query, variables });
async function pages(fetchPage) { let count = 0; return collectConnection(cursor => { if (++count > 100) throw new Error('partial-access'); return fetchPage(cursor); }).catch(error => { if (/^(http-|graphql-|connection-|cancelled)/.test(error.message)) throw error; throw new Error('partial-access'); }); }

export function planFields(fields, mapping = {}) {
  if (!Array.isArray(fields) || fields.some(field => !node(field?.id) || !text(field.name, 256)) || new Set(fields.map(field => field.id)).size !== fields.length
    || Object.keys(mapping).some(role => !definitions.some(definition => definition.role === role))) throw new Error('field-conflict');
  const plan = definitions.map(({ role, choices }) => {
    const matches = Object.hasOwn(mapping, role) ? mapping[role] === null ? [] : fields.filter(field => field.id === mapping[role]) : fields.filter(field => field.name === role);
    if (matches.length > 1 || Object.hasOwn(mapping, role) && mapping[role] !== null && matches.length !== 1) throw new Error('field-conflict');
    const existing = matches[0];
    if (!existing && fields.some(field => field.name === role) || existing && (!Array.isArray(existing.options) || existing.options.some(option =>
      !node(option?.id) || !text(option.name, 100) || !/^(GRAY|BLUE|GREEN|YELLOW|ORANGE|RED|PINK|PURPLE)$/.test(option.color) || typeof option.description !== 'string' || option.description.length > 1024)
      || new Set(existing.options.map(option => option.id)).size !== existing.options.length || new Set(existing.options.map(option => option.name)).size !== existing.options.length)) throw new Error('field-conflict');
    const options = existing ? existing.options.map(({ id, name, color, description }) => ({ id, name, color, description })) : [];
    const missing = choices.filter(name => !options.some(option => option.name === name));
    for (const name of missing) options.push({ name, color: name === 'Done' ? 'GREEN' : name === 'On Hold' ? 'GRAY' : 'BLUE', description: 'Pipeliner governance option' });
    if (options.length > 50) throw new Error('field-conflict');
    return { role, name: existing?.name ?? role, id: existing?.id ?? null, options, missing };
  });
  const mapped = plan.map(field => field.id).filter(Boolean);
  if (new Set(mapped).size !== mapped.length) throw new Error('field-conflict');
  return plan;
}

export function verifyFields(actual, plan) {
  for (const expected of plan) {
    const matches = actual.filter(field => expected.id ? field?.id === expected.id : field?.name === expected.name);
    const field = matches[0];
    if (matches.length !== 1 || !node(field.id) || field.name !== expected.name || !Array.isArray(field.options) || field.options.length !== expected.options.length
      || new Set(field.options.map(option => option.id)).size !== field.options.length || expected.options.some((option, i) =>
        !node(field.options[i]?.id) || Object.entries(option).some(([key, value]) => !isDeepStrictEqual(field.options[i][key], value)))) throw new Error('readback-mismatch');
  }
  return true;
}

export async function readOwner(lease, login) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('owner-unavailable');
  const expected = lease.value.view.owners?.find(owner => owner.login.toLowerCase() === login.toLowerCase());
  if (!expected) throw new Error('owner-unavailable');
  const owner = await request(lease, 'GET', '/users/' + expected.login);
  if (owner.id !== expected.id || owner.node_id !== expected.node || owner.login !== expected.login || owner.type !== expected.type) throw new Error('account-changed');
  if (owner.type === 'User' && owner.id !== lease.value.account.id) throw new Error('owner-unavailable');
  return { id: owner.node_id, numericId: owner.id, login: owner.login, type: owner.type };
}

export async function ownerRepositories(lease, owner) {
  return pages(async cursor => {
    const result = await query(lease, `query($id:ID!,$cursor:String){node(id:$id){... on ${owner.type}{id repositories(first:100,after:$cursor,ownerAffiliations:[OWNER]){totalCount nodes{id nameWithOwner isPrivate owner{id}} pageInfo{hasNextPage endCursor}}}}}`, { id: owner.id, cursor });
    if (result.data?.node?.id !== owner.id) throw new Error('partial-access');
    return result.data.node.repositories;
  }).then(repositories => { if (repositories.some(repo => !node(repo.id) || !text(repo.nameWithOwner, 140) || !repo.nameWithOwner.startsWith(owner.login + '/') || repo.owner?.id !== owner.id || typeof repo.isPrivate !== 'boolean')) throw new Error('partial-access'); return repositories; });
}

export async function readRepository(lease, slug) {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(slug) || ['.', '..'].includes(slug.split('/')[1])) throw new Error('repository-unavailable');
  const repo = await request(lease, 'GET', '/repos/' + slug);
  if (!positive(repo?.id) || !node(repo.node_id) || !positive(repo.owner?.id) || !node(repo.owner.node_id) || !['User', 'Organization'].includes(repo.owner.type)
    || repo.full_name?.toLowerCase() !== slug.toLowerCase() || repo.full_name !== repo.owner.login + '/' + repo.name || typeof repo.private !== 'boolean'
    || repo.archived !== false || repo.disabled !== false || repo.has_issues !== true || repo.permissions?.pull !== true) throw new Error('repository-unavailable');
  if (lease.id === 'github') {
    const allowed = lease.value.view.repositories.find(entry => entry.id === repo.node_id && entry.numericId === repo.id && entry.name === repo.full_name && entry.private === repo.private && entry.permissions.includes('pull'));
    if (!allowed) throw new Error('installation-access-required');
  } else if (lease.id !== 'github-setup') throw new Error('connection-denied');
  return { id: repo.node_id, numericId: repo.id, owner: { id: repo.owner.node_id, numericId: repo.owner.id, login: repo.owner.login, type: repo.owner.type },
    name: repo.name, slug: repo.full_name.toLowerCase(), displayName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, permissions: repo.permissions };
}

export async function createRepository(lease, owner, values) {
  if (lease.id !== 'github-setup' || !/^[A-Za-z0-9_.-]{1,100}$/.test(values.name) || ['.', '..'].includes(values.name)
    || !text(values.purpose, 350) || !['private', 'public'].includes(values.visibility)) throw new Error('creation-denied');
  if (owner.type === 'Organization') {
    const membership = await request(lease, 'GET', '/user/memberships/orgs/' + owner.login);
    if (membership.state !== 'active' || membership.organization?.id !== owner.numericId || !['admin', 'member'].includes(membership.role)) throw new Error('creation-denied');
  } else if (owner.numericId !== lease.value.account.id) throw new Error('creation-denied');
  const created = await request(lease, 'POST', owner.type === 'User' ? '/user/repos' : '/orgs/' + owner.login + '/repos',
    { name: values.name, description: values.purpose, private: values.visibility === 'private', auto_init: true, has_issues: true });
  if (!positive(created?.id) || !node(created.node_id) || created.owner?.id !== owner.numericId || created.owner.node_id !== owner.id
    || created.name !== values.name || created.private !== (values.visibility === 'private')) throw new Error('readback-mismatch');
  const repo = await readRepository(lease, owner.login + '/' + values.name);
  if (repo.id !== created.node_id || repo.numericId !== created.id || repo.private !== created.private) throw new Error('readback-mismatch');
  return repo;
}

export async function listProjects(lease, owner) {
  return pages(async cursor => {
    const result = await query(lease, `query($id:ID!,$cursor:String){node(id:$id){... on ${owner.type}{id projectsV2(first:100,after:$cursor){totalCount nodes{id number title public closed viewerCanUpdate} pageInfo{hasNextPage endCursor}}}}}`, { id: owner.id, cursor });
    if (result.data?.node?.id !== owner.id) throw new Error('partial-access'); return result.data.node.projectsV2;
  }).then(projects => { if (projects.some(project => !node(project.id) || !positive(project.number) || !text(project.title, 256) || typeof project.public !== 'boolean' || typeof project.closed !== 'boolean' || typeof project.viewerCanUpdate !== 'boolean')) throw new Error('partial-access'); return projects.filter(project => !project.closed); });
}

export async function readProject(lease, id) {
  if (!node(id)) throw new Error('project-unavailable');
  const result = await query(lease, 'query($id:ID!){node(id:$id){... on ProjectV2{id number title public closed viewerCanUpdate owner{... on User{id login} ... on Organization{id login}}}}}', { id });
  const project = result.data?.node;
  if (project?.id !== id || !positive(project.number) || !text(project.title, 256) || typeof project.public !== 'boolean' || project.closed !== false || project.viewerCanUpdate !== true || !node(project.owner?.id)) throw new Error('project-unavailable');
  for (const collection of ['fields', 'repositories']) {
    project[collection] = await pages(async cursor => {
      const selection = collection === 'fields' ? '... on ProjectV2FieldCommon{id name} ... on ProjectV2SingleSelectField{options{id name color description}}' : 'id nameWithOwner';
      const data = await query(lease, `query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{id ${collection}(first:100,after:$cursor){totalCount nodes{${selection}} pageInfo{hasNextPage endCursor}}}}}`, { id, cursor });
      if (data.data?.node?.id !== id) throw new Error('partial-access'); return data.data.node[collection];
    });
  }
  return project;
}

export async function createProject(lease, owner, repo, title) {
  if (!text(title, 256)) throw new Error('project-unavailable');
  const data = await query(lease, 'mutation($owner:ID!,$repository:ID!,$title:String!){createProjectV2(input:{ownerId:$owner,repositoryId:$repository,title:$title}){projectV2{id}}}', { owner: owner.id, repository: repo.id, title });
  const project = await readProject(lease, data.data?.createProjectV2?.projectV2?.id);
  if (project.owner.id !== owner.id || project.title !== title || project.public !== false || !project.repositories.some(repository => repository.id === repo.id)) throw new Error('readback-mismatch');
  return project;
}

export async function linkProject(lease, project, repo) {
  const data = await query(lease, 'mutation($project:ID!,$repository:ID!){linkProjectV2ToRepository(input:{projectId:$project,repositoryId:$repository}){repository{id}}}', { project: project.id, repository: repo.id });
  if (data.data?.linkProjectV2ToRepository?.repository?.id !== repo.id) throw new Error('readback-mismatch');
  const actual = await readProject(lease, project.id);
  if (actual.owner.id !== project.owner.id || !actual.repositories.some(repository => repository.id === repo.id)) throw new Error('readback-mismatch');
  return actual;
}

export async function applyField(lease, projectId, field) {
  const variables = field.id ? { id: field.id, options: field.options } : { project: projectId, name: field.name, options: field.options };
  const data = await query(lease, field.id
    ? 'mutation($id:ID!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){updateProjectV2Field(input:{fieldId:$id,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id name options{id name color description}}}}}'
    : 'mutation($project:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){createProjectV2Field(input:{projectId:$project,dataType:SINGLE_SELECT,name:$name,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id name options{id name color description}}}}}', variables);
  const actual = data.data?.[field.id ? 'updateProjectV2Field' : 'createProjectV2Field']?.projectV2Field;
  verifyFields([actual], [field]); return actual;
}
