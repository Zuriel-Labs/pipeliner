import { isDeepStrictEqual } from 'node:util';
import { collectConnection } from '../../scripts/lib/project.mjs';
import { githubRequest, readRepository, readProject } from '../repositories/github.mjs';
import { activeIssueStatuses, protectedLabel, normalizeLabel } from '../github/operations.mjs';
import { containsSecret } from '../connections/commands.mjs';

const node = value => typeof value === 'string' && /^[A-Za-z0-9_=-]{1,180}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const prefix = workspace => '/repos/' + workspace.slug;
const query = (lease, query, variables) => githubRequest(lease, 'POST', '/graphql', { query, variables });
const pullSelection = 'id number title state repository{id nameWithOwner} headRefOid commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){totalCount nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}} pageInfo{hasNextPage endCursor}}}}}}';
async function pages(lease, path) {
  const results = [], seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const data = await githubRequest(lease, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length > 100 || data.some(item => !positive(item?.id) || seen.has(item.id))) throw new Error('partial-access');
    for (const item of data) { if (seen.has(item.id)) throw new Error('partial-access'); seen.add(item.id); results.push(item); }
    if (data.length < 100) return results;
  }
  throw new Error('partial-access');
}
async function connection(fetchPage) { let count = 0; return collectConnection(cursor => { if (++count > 100) throw new Error('partial-access'); return fetchPage(cursor); }); }
function issueData(raw, workspace) {
  if (!positive(raw?.id) || !node(raw.node_id) || !positive(raw.number) || !['open', 'closed'].includes(raw.state) || typeof raw.title !== 'string' || raw.title.length > 256
    || raw.body !== null && typeof raw.body !== 'string' || (raw.body?.length ?? 0) > 65536 || raw.pull_request || !Array.isArray(raw.labels) || !Array.isArray(raw.assignees)
    || raw.labels.some(label => !positive(label?.id) || typeof label.name !== 'string' || label.name.length > 50) || raw.assignees.some(person => !positive(person?.id) || typeof person.login !== 'string')
    || raw.html_url !== `https://github.com/${workspace.slug}/issues/${raw.number}` && raw.html_url?.toLowerCase() !== `https://github.com/${workspace.slug}/issues/${raw.number}`) throw new Error('issue-state-incomplete');
  const labels = raw.labels.map(label => label.name);
  if (new Set(labels.map(normalizeLabel)).size !== labels.length || labels.some(label => normalizeLabel(label) === normalizeLabel(protectedLabel) && label !== protectedLabel)) throw new Error('protected-or-invalid-label');
  return { id: raw.node_id, numericId: raw.id, repositoryId: workspace.repositoryId, number: raw.number, title: containsSecret(raw.title) ? 'Sensitive title hidden' : raw.title,
    body: containsSecret(raw.body ?? '') ? 'Sensitive content hidden. Inspect the Issue securely on GitHub.' : raw.body ?? '',
    state: raw.state.toUpperCase(), labels, ready: labels.includes(protectedLabel), assignees: raw.assignees.map(person => person.login), url: raw.html_url };
}
export async function readCatalog(app, projectLease, workspace) {
  const repo = await readRepository(app, workspace.slug), project = await readProject(projectLease, workspace.project.id);
  if (repo.id !== workspace.repositoryId || repo.numericId !== workspace.numericId || repo.private !== workspace.private || project.owner.id !== workspace.project.owner.id
    || !project.repositories.some(repository => repository.id === repo.id)) throw new Error('issue-context-changed');
  for (const [role, expected] of Object.entries(workspace.project.fields)) {
    const actual = project.fields.find(field => field.id === expected.id);
    if (!actual || actual.name !== expected.name || !Array.isArray(actual.options) || !isDeepStrictEqual(actual.options.map(({ id, name }) => ({ id, name })), expected.options)) throw new Error('field-conflict');
  }
  const items = await connection(async cursor => {
    const data = await query(projectLease, 'query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{id items(first:100,after:$cursor){totalCount nodes{id content{__typename ... on Issue{id number state repository{id}} ... on PullRequest{id repository{id}} ... on DraftIssue{id}} fieldValues(first:100){totalCount nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{optionId name field{... on ProjectV2FieldCommon{id}}}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}', { id: project.id, cursor });
    if (data.data?.node?.id !== project.id) throw new Error('partial-access');
    const page = data.data.node.items;
    if (page?.nodes?.some(item => !node(item?.id) || !node(item.content?.id) || !['Issue', 'PullRequest', 'DraftIssue'].includes(item.content.__typename)
      || item.content.__typename !== 'DraftIssue' && !node(item.content.repository?.id) || !Array.isArray(item.fieldValues?.nodes) || item.fieldValues.pageInfo?.hasNextPage !== false
      || item.fieldValues.totalCount !== item.fieldValues.nodes.length)) throw new Error('partial-access');
    return page;
  });
  const labels = (await pages(app, prefix(workspace) + '/labels')).map(label => {
    if (typeof label.name !== 'string' || label.name.length > 50 || normalizeLabel(label.name) === normalizeLabel(protectedLabel) && label.name !== protectedLabel) throw new Error('protected-or-invalid-label'); return label.name;
  });
  if (new Set(labels.map(normalizeLabel)).size !== labels.length) throw new Error('protected-or-invalid-label');
  const issues = (await pages(app, prefix(workspace) + '/issues?state=all')).filter(raw => !raw.pull_request).map(raw => issueData(raw, workspace));
  const mapped = items.filter(item => item.content.__typename === 'Issue' && item.content.repository.id === workspace.repositoryId);
  if (new Set(mapped.map(item => item.content.id)).size !== mapped.length) throw new Error('issue-state-conflict');
  for (const item of mapped) if (!issues.some(issue => issue.id === item.content.id && issue.number === item.content.number && issue.state === item.content.state)) throw new Error('issue-state-conflict');
  for (const issue of issues) {
    const item = mapped.find(item => item.content.id === issue.id); issue.itemId = item?.id ?? null; issue.metadata = {};
    for (const [role, field] of Object.entries(workspace.project.fields)) {
      const values = item?.fieldValues.nodes.filter(value => value.field?.id === field.id) ?? [];
      if (values.length > 1 || values.length && (!node(values[0].optionId) || !field.options.some(option => option.id === values[0].optionId && option.name === values[0].name))) throw new Error('issue-state-conflict');
      issue.metadata[role] = values[0]?.name ?? null;
    }
    issue.status = issue.metadata.Status;
    if (activeIssueStatuses.includes(issue.status) && issue.state !== 'OPEN') throw new Error('issue-state-conflict');
  }
  const active = issues.filter(issue => activeIssueStatuses.includes(issue.status)).map(({ id, number, status }) => ({ id, number, status }));
  if (active.length > 1) throw new Error('issue-state-conflict');
  return { complete: true, repositoryId: repo.id, projectId: project.id, labels, issues, active };
}
export async function readIssue(lease, workspace, number) {
  if (!positive(number)) throw new Error('issue-unavailable');
  return issueData(await githubRequest(lease, 'GET', `${prefix(workspace)}/issues/${number}`), workspace);
}
export async function readDependencies(lease, workspace, number) {
  if (!positive(number)) throw new Error('issue-unavailable');
  return (await pages(lease, `${prefix(workspace)}/issues/${number}/dependencies/blocked_by`)).map(raw => issueData(raw, workspace));
}
export async function readDetail(lease, workspace, number) {
  const issue = await readIssue(lease, workspace, number), dependencies = await readDependencies(lease, workspace, number);
  const linked = await connection(async cursor => {
    const data = await query(lease, `query($id:ID!,$cursor:String){node(id:$id){... on Issue{id closedByPullRequestsReferences(first:100,after:$cursor,includeClosedPrs:true){totalCount nodes{${pullSelection}} pageInfo{hasNextPage endCursor}}}}}`, { id: issue.id, cursor });
    if (data.data?.node?.id !== issue.id) throw new Error('partial-access'); return data.data.node.closedByPullRequestsReferences;
  });
  const timeline = await connection(async cursor => {
    const subject = `__typename ... on PullRequest{${pullSelection}}`;
    const data = await query(lease, `query($id:ID!,$cursor:String){node(id:$id){... on Issue{id timelineItems(first:100,after:$cursor,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){totalCount nodes{__typename ... on CrossReferencedEvent{id source{${subject}}} ... on ConnectedEvent{id source{${subject}} subject{${subject}}}} pageInfo{hasNextPage endCursor}}}}}`, { id: issue.id, cursor });
    if (data.data?.node?.id !== issue.id) throw new Error('partial-access'); return data.data.node.timelineItems;
  });
  const pullRequests = new Map(linked.map(pr => [pr.id, { ...pr, relationship: 'linked' }]));
  for (const event of timeline) {
    if (!['CrossReferencedEvent', 'ConnectedEvent'].includes(event.__typename) || !event.source) throw new Error('partial-access');
    for (const subject of [event.source, event.subject].filter(Boolean)) if (subject.__typename === 'PullRequest' && !pullRequests.has(subject.id)) pullRequests.set(subject.id, { ...subject, relationship: 'referenced' });
  }
  return { ...issue, dependencies: dependencies.map(({ id, number, title, state }) => ({ id, number, title, state })), pullRequests: [...pullRequests.values()].map(pr => {
    const commit = pr.commits?.nodes?.[0]?.commit, checks = commit?.statusCheckRollup?.contexts;
    if (!node(pr.id) || !positive(pr.number) || !node(pr.repository?.id) || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(pr.repository.nameWithOwner) || typeof pr.title !== 'string' || pr.title.length > 256
      || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) || !/^[a-f0-9]{40}$/.test(pr.headRefOid) || commit && !/^[a-f0-9]{40}$/.test(commit.oid)
      || checks && (!Array.isArray(checks.nodes) || checks.pageInfo?.hasNextPage !== false || checks.totalCount !== checks.nodes.length
        || checks.nodes.some(check => !['CheckRun', 'StatusContext'].includes(check.__typename) || typeof (check.name ?? check.context) !== 'string'))) throw new Error('partial-access');
    return { id: pr.id, number: pr.number, title: containsSecret(pr.title) ? 'Sensitive title hidden' : pr.title, state: pr.state, relationship: pr.relationship, repositoryId: pr.repository.id, repositoryName: pr.repository.nameWithOwner, head: pr.headRefOid,
      checks: checks ? { head: commit.oid, current: commit.oid === pr.headRefOid, state: commit.statusCheckRollup.state,
        results: checks.nodes.map(check => ({ name: check.name ?? check.context, state: check.conclusion ?? check.status ?? check.state })) } : null };
  }), releaseEvidence: { status: 'unavailable', explanation: 'No verified release record is attached to this Issue in Pipeliner.' } };
}
export async function createIssue(lease, workspace, draft, body, checkpoint = () => {}) {
  const issue = issueData(await githubRequest(lease, 'POST', prefix(workspace) + '/issues', { title: draft.title, body, labels: draft.labels, assignees: [] }), workspace);
  checkpoint({ id: issue.id, number: issue.number, numericId: issue.numericId, repositoryId: issue.repositoryId });
  if (issue.title !== draft.title || issue.body !== body || issue.state !== 'OPEN' || issue.assignees.length || issue.ready || !isDeepStrictEqual([...issue.labels].sort(), [...draft.labels].sort())) throw new Error('readback-mismatch');
  return issue;
}
export async function addItem(lease, workspace, issue) {
  const data = await query(lease, 'mutation($project:ID!,$issue:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$issue}){item{id}}}', { project: workspace.project.id, issue: issue.id });
  const id = data.data?.addProjectV2ItemById?.item?.id; if (!node(id)) throw new Error('readback-mismatch'); return { id };
}
export async function setField(lease, workspace, itemId, role, name) {
  const field = workspace.project.fields[role], option = field?.options.find(option => option.name === name);
  if (!node(itemId) || !option) throw new Error('metadata-invalid');
  const data = await query(lease, 'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}', { project: workspace.project.id, item: itemId, field: field.id, option: option.id });
  if (data.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) throw new Error('readback-mismatch'); return { itemId, role, name };
}
export async function addDependency(lease, workspace, issue, dependency) {
  if (issue.repositoryId !== workspace.repositoryId || dependency.repositoryId !== workspace.repositoryId || issue.id === dependency.id) throw new Error('dependency-unavailable');
  await githubRequest(lease, 'POST', `${prefix(workspace)}/issues/${issue.number}/dependencies/blocked_by`, { issue_id: dependency.numericId });
  if (!(await readDependencies(lease, workspace, issue.number)).some(value => value.id === dependency.id)) throw new Error('readback-mismatch'); return { id: dependency.id, number: dependency.number };
}
export async function ensureReadyLabel(lease, workspace) {
  const result = await githubRequest(lease, 'POST', prefix(workspace) + '/labels', { name: protectedLabel, color: '6EB8A2', description: 'PM-owned eligibility for development.' });
  if (!positive(result?.id) || result.name !== protectedLabel) throw new Error('readback-mismatch'); return { name: protectedLabel };
}
export async function setReady(lease, workspace, issue, enabled) {
  const path = `${prefix(workspace)}/issues/${issue.number}/labels`;
  await githubRequest(lease, enabled ? 'POST' : 'DELETE', enabled ? path : path + '/' + encodeURIComponent(protectedLabel), enabled ? { labels: [protectedLabel] } : undefined);
  return { number: issue.number, ready: enabled };
}
