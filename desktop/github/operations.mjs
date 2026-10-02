import { isDeepStrictEqual } from 'node:util';
import { collectConnection } from '../../scripts/lib/project.mjs';

export const protectedLabel = 'Ready for Development';
export const activeIssueStatuses = Object.freeze(['In Progress', 'In Review', 'Pending Review']);
const activeStatuses = new Set(activeIssueStatuses);
export const normalizeLabel = value => value.normalize('NFKC').trim().toLowerCase();
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0');

function keys(value, allowed, required = []) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) ||
    required.some(key => !Object.hasOwn(value, key))) throw new Error('invalid-payload');
}

export function planOperation(request, scope, live) {
  keys(request, ['operation', 'payload', 'repositoryId', 'issueId', 'runId', 'epoch', 'policyVersion'],
    ['operation', 'payload', 'repositoryId', 'issueId', 'runId', 'epoch', 'policyVersion']);
  if (!scope?.repository || !scope.issue || !scope.project ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(scope.repository.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(scope.repository.name) || ['.', '..'].includes(scope.repository.name) ||
    !Number.isSafeInteger(scope.issue.number) || scope.issue.number < 1 ||
    !Number.isSafeInteger(scope.epoch) || !Number.isSafeInteger(scope.policyVersion) ||
    !['id', 'itemId', 'statusFieldId'].every(key => text(scope.project[key], 180)) ||
    !text(scope.runId, 180) || !text(scope.repository.id, 180) || !text(scope.issue.id, 180)) throw new Error('invalid-scope');
  if (request.repositoryId !== scope.repository.id || request.issueId !== scope.issue.id ||
    request.runId !== scope.runId || request.epoch !== scope.epoch || request.policyVersion !== scope.policyVersion) throw new Error('scope-denied');
  if (live?.complete !== true || live.repositoryId !== scope.repository.id || live.issueId !== scope.issue.id ||
    live.projectId !== scope.project.id || live.itemId !== scope.project.itemId || live.statusFieldId !== scope.project.statusFieldId ||
    !Array.isArray(live.activeIssueIds) || live.activeIssueIds.length !== 1 || live.activeIssueIds[0] !== scope.issue.id ||
    live.issueState !== 'OPEN' || !activeStatuses.has(live.status)) throw new Error('live-state-incomplete');
  const prefix = `/repos/${scope.repository.owner}/${scope.repository.name}`;
  const payload = request.payload;
  switch (request.operation) {
    case 'issue-edit': {
      keys(payload, ['title', 'body']);
      if (!Reflect.ownKeys(payload).length ||
        (Object.hasOwn(payload, 'title') && !text(payload.title, 256)) ||
        (Object.hasOwn(payload, 'body') && (typeof payload.body !== 'string' || payload.body.length > 65536))) throw new Error('invalid-payload');
      return { method: 'PATCH', path: `${prefix}/issues/${scope.issue.number}`, body: { ...payload } };
    }
    case 'labels-add': {
      keys(payload, ['labels'], ['labels']);
      if (!Array.isArray(payload.labels) || payload.labels.length < 1 || payload.labels.length > 50 ||
        payload.labels.some(label => !text(label, 50) || /[\p{Cc}\p{Cf}]/u.test(label) || normalizeLabel(label) === normalizeLabel(protectedLabel)) ||
        new Set(payload.labels.map(normalizeLabel)).size !== payload.labels.length) throw new Error('protected-or-invalid-label');
      // Bulk replacement could remove Ready after a concurrent external label edit.
      return { method: 'POST', path: `${prefix}/issues/${scope.issue.number}/labels`, body: { labels: [...payload.labels] } };
    }
    case 'label-remove': {
      keys(payload, ['label'], ['label']);
      if (!text(payload.label, 50) || /[\p{Cc}\p{Cf}]/u.test(payload.label) ||
        normalizeLabel(payload.label) === normalizeLabel(protectedLabel)) throw new Error('protected-or-invalid-label');
      return { method: 'DELETE', path: `${prefix}/issues/${scope.issue.number}/labels/${encodeURIComponent(payload.label)}` };
    }
    case 'project-status': {
      keys(payload, ['status'], ['status']);
      // PM On Hold and completion require their own verified control/closeout path.
      if (!activeStatuses.has(payload.status) || !plain(scope.project.statuses) ||
        !Object.hasOwn(scope.project.statuses, payload.status) ||
        !text(scope.project.statuses[payload.status], 180)) throw new Error('status-denied');
      return { method: 'POST', path: '/graphql', body: {
        query: 'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}',
        variables: { project: scope.project.id, item: scope.project.itemId, field: scope.project.statusFieldId,
          option: scope.project.statuses[payload.status] } } };
    }
    case 'pr-merge': {
      keys(payload, ['number', 'head'], ['number', 'head']);
      if (!Number.isSafeInteger(payload.number) || payload.number < 1 ||
        typeof payload.head !== 'string' || !/^[0-9a-f]{40}$/.test(payload.head) ||
        scope.pullRequest?.number !== payload.number || !text(scope.pullRequest.id, 180) ||
        live.pullRequestId !== scope.pullRequest.id || scope.pullRequest.head !== payload.head ||
        scope.mergeAuthorizedHead !== payload.head || live.head !== payload.head ||
        live.checksHead !== payload.head || live.checksPassed !== true) throw new Error('candidate-denied');
      return { method: 'PUT', path: `${prefix}/pulls/${payload.number}/merge`, body: { sha: payload.head, merge_method: 'squash' } };
    }
    default: throw new Error('operation-denied');
  }
}

export function verifyReadback(actual, expected) {
  if (!plain(actual) || !plain(expected) || !text(expected.id, 180) || actual.id !== expected.id ||
    Object.entries(expected).some(([key, value]) => !Object.hasOwn(actual, key) || !isDeepStrictEqual(actual[key], value))) throw new Error('readback-mismatch');
  return true;
}

export async function readProject(projectId, query) {
  if (!text(projectId, 180)) throw new Error('invalid-project');
  return collectConnection(async cursor => {
    const result = await query('query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{id items(first:100,after:$cursor){totalCount nodes{id content{... on Issue{id number state repository{id}}} fieldValues(first:100){totalCount nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{id name}}}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}', { id: projectId, cursor });
    if (!plain(result) || (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length))) throw new Error('partial-project');
    if (result.data?.node?.id !== projectId) throw new Error('project-identity');
    const connection = result.data.node.items;
    if (connection?.nodes?.some(item => !item.content || item.content.repository?.id === undefined ||
      !Array.isArray(item.fieldValues?.nodes) || item.fieldValues.pageInfo?.hasNextPage !== false ||
      item.fieldValues.totalCount !== item.fieldValues.nodes.length)) throw new Error('incomplete-project-item');
    return connection;
  });
}
