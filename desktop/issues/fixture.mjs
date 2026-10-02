import { activeIssueStatuses, protectedLabel } from '../github/operations.mjs';

// Qualification data only. This transport never contacts GitHub or proves a Human account grant.
export function issueFixture(workspace) {
  const copy = value => structuredClone(value), writes = [], labels = ['type:feature', 'area:workflow', protectedLabel];
  const issues = [{ id: 'I7', numericId: 7, repositoryId: workspace.repositoryId, number: 7, title: 'Preserve existing work', body: 'Keep tracked and untracked work intact.',
    state: 'OPEN', labels: ['type:feature'], ready: false, assignees: [], status: 'Backlog', itemId: 'ITEM7', metadata: { Status: 'Backlog', Priority: 'P1', Impact: 'High', Effort: 'M' }, dependencies: [], url: 'https://github.com/' + workspace.slug + '/issues/7' }];
  let lose = null, wait = null;
  const lookup = number => { const issue = issues.find(issue => issue.number === number); if (!issue) throw new Error('issue-unavailable'); return issue; };
  const api = {
    async readCatalog(_app, _project, target) {
      if (wait) { const pending = wait; wait = null; await pending(_app.signal); }
      if (target.repositoryId !== workspace.repositoryId) throw new Error('issue-context-changed');
      const active = issues.filter(issue => activeIssueStatuses.includes(issue.status)).map(({ id, number, status }) => ({ id, number, status }));
      if (active.length > 1) throw new Error('issue-state-conflict');
      return copy({ complete: true, repositoryId: target.repositoryId, projectId: target.project.id, labels, issues, active });
    },
    readIssue: async (_lease, _target, number) => copy(lookup(number)),
    readDependencies: async (_lease, _target, number) => lookup(number).dependencies.map(number => copy(lookup(number))),
    readDetail: async (_lease, _target, number) => ({ ...copy(lookup(number)), dependencies: lookup(number).dependencies.map(number => copy(lookup(number))), pullRequests: [], releaseEvidence: { status: 'unavailable', explanation: 'No release has been verified for this fixture.' } }),
    async createIssue(_lease, _target, values, body, checkpoint) {
      writes.push('create'); const number = Math.max(...issues.map(issue => issue.number)) + 1;
      const issue = { ...copy(issues[0]), id: 'I' + number, numericId: number, number, title: values.title, body, labels: [...values.labels], ready: false, assignees: [], itemId: null, status: null, metadata: {}, dependencies: [], url: 'https://github.com/' + workspace.slug + '/issues/' + number };
      issues.push(issue); if (lose === 'create-unknown') throw new Error('write-result-uncertain');
      checkpoint({ id: issue.id, number, numericId: issue.numericId, repositoryId: issue.repositoryId });
      if (lose === 'create-known') throw new Error('write-result-uncertain'); return copy(issue);
    },
    async addItem(_lease, _target, created) { writes.push('project'); lookup(created.number).itemId = 'ITEM' + created.number; if (lose === 'project') throw new Error('write-result-uncertain'); return { id: 'ITEM' + created.number }; },
    async setField(_lease, _target, item, role, name) {
      writes.push('field-' + role); const issue = issues.find(issue => issue.itemId === item); if (!issue) throw new Error('issue-unavailable');
      issue.metadata[role] = name; if (role === 'Status') issue.status = name;
      if (lose === 'field-' + role) throw new Error('write-result-uncertain'); return { itemId: item, role, name };
    },
    async addDependency(_lease, _target, created, dependency) { writes.push('dependency'); lookup(created.number).dependencies.push(dependency.number); return { id: dependency.id, number: dependency.number }; },
    async ensureReadyLabel() { writes.push('ready-label'); labels.push(protectedLabel); return { name: protectedLabel }; },
    async setReady(_lease, _target, created, enabled) {
      writes.push('ready'); const issue = lookup(created.number); issue.ready = enabled;
      issue.labels = enabled ? [...issue.labels, protectedLabel] : issue.labels.filter(label => label !== protectedLabel); return { number: issue.number, ready: enabled };
    },
  };
  return { api, writes, issues, lose: step => { lose = step; }, delay: fn => { wait = fn; } };
}
