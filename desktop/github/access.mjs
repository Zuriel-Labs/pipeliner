import { isDeepStrictEqual } from 'node:util';
import { collectConnection } from '../../scripts/lib/project.mjs';

// Qualification scope only; these fixtures were explicitly designated by the PM.
export const fixtures = Object.freeze([
  Object.freeze({ owner: 'brimdor', type: 'User', name: 'pipeliner-d05-26-personal', id: 1399877876, node: 'R_kgDOU3Bw9A' }),
  Object.freeze({ owner: 'Zuriel-Labs', type: 'Organization', name: 'pipeliner-d05-26-org', id: 1399878351, node: 'R_kgDOU3Byzw' }),
]);
export const appPermissions = Object.freeze({ actions: 'read', checks: 'read', contents: 'write', issues: 'write', metadata: 'read',
  organization_projects: 'write', pull_requests: 'write', statuses: 'read' });
const safeError = error => /^(http-\d{3}|graphql-(forbidden|rejected)|readback-mismatch|write-result-uncertain|response-invalid|response-too-large|cancelled|read-failed)$/.test(error?.message)
  ? error.message : 'qualification-failed';

export async function qualifyAccess(accessToken, { send = fetch, signal, onResult } = {}) {
  if (typeof accessToken !== 'string' || !/^ghu_[A-Za-z0-9_]{8,200}$/.test(accessToken)) throw new Error('app-token-required');
  const rows = [];
  async function request(method, path, body) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    let reader, dispatched = false;
    const mutation = method !== 'GET' && !(path === '/graphql' && body?.query?.startsWith('query('));
    try {
      combined.throwIfAborted();
      dispatched = true;
      const response = await send(`https://api.github.com${path}`, { method, redirect: 'error', signal: combined,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Pipeliner-D05-Qualification',
          ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`http-${response.status}`);
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error('response-invalid');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, text = '';
      while (true) {
        const part = await reader.read();
        combined.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1048576) throw new Error('response-too-large');
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('response-invalid'); }
      combined.throwIfAborted();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('response-invalid');
      if (data.errors?.length) throw new Error(data.errors.some(e => e.type === 'FORBIDDEN') ? 'graphql-forbidden' : 'graphql-rejected');
      return data;
    } catch (error) {
      await reader?.cancel().catch(() => {});
      if (signal?.aborted) throw new Error(mutation && dispatched ? 'write-result-uncertain' : 'cancelled');
      if (/^(http-\d{3}|graphql-(forbidden|rejected))$/.test(error?.message)) throw error;
      if (!mutation && /^(response-invalid|response-too-large)$/.test(error?.message)) throw error;
      // A lost write reply never authorizes another dispatch.
      throw new Error(mutation && dispatched ? 'write-result-uncertain' : 'read-failed');
    } finally { reader?.releaseLock(); }
  }
  async function list(path, key) {
    const values = [];
    let total;
    for (let page = 1; page <= 100; page++) {
      const data = await request('GET', `${path}?per_page=100&page=${page}`);
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
        !Array.isArray(data[key]) || data[key].length > 100 || (total !== undefined && total !== data.total_count)) throw new Error('incomplete-list');
      total = data.total_count;
      values.push(...data[key]);
      if (values.some(v => !Number.isSafeInteger(v.id) || v.id < 1) || new Set(values.map(v => v.id)).size !== values.length ||
        values.length > total) throw new Error('incomplete-list');
      if (values.length === total) return values;
      if (data[key].length !== 100) throw new Error('incomplete-list');
    }
    throw new Error('incomplete-list');
  }
  if ((await request('GET', '/user')).login !== 'brimdor') throw new Error('account-mismatch');
  const installations = (await list('/user/installations', 'installations')).filter(i => i.app_id === 5148613);
  if (installations.length !== fixtures.length) throw new Error('installation-mismatch');
  for (const fixture of fixtures) {
    const installation = installations.find(i => i.account?.login === fixture.owner && i.account.type === fixture.type);
    const expected = fixture.type === 'User' ? Object.fromEntries(Object.entries(appPermissions).filter(([key]) => key !== 'organization_projects')) : appPermissions;
    if (!installation || installation.repository_selection !== 'selected' ||
      !(isDeepStrictEqual(installation.permissions, expected) || isDeepStrictEqual(installation.permissions, appPermissions))) throw new Error('installation-mismatch');
    const repositories = await list(`/user/installations/${installation.id}/repositories`, 'repositories');
    if (repositories.length !== 1 || repositories[0].id !== fixture.id || repositories[0].node_id !== fixture.node ||
      repositories[0].full_name !== `${fixture.owner}/${fixture.name}` || repositories[0].private !== true) {
      onResult?.({ fixture: `${fixture.owner}/${fixture.name}`, operation: 'repository-binding', status: 'failed', detail: {
        count: repositories.length, idMatches: repositories[0]?.id === fixture.id, nodeMatches: repositories[0]?.node_id === fixture.node,
        pathMatches: repositories[0]?.full_name === `${fixture.owner}/${fixture.name}`, privateMatches: repositories[0]?.private === true,
      } });
      throw new Error('repository-mismatch');
    }
  }
  async function record(fixture, operation, action) {
    const started = performance.now();
    try {
      const detail = await action();
      rows.push({ fixture: `${fixture.owner}/${fixture.name}`, operation,
        status: detail?.unexpectedCreation ? 'failed' : 'passed', detail, milliseconds: performance.now() - started });
    }
    catch (error) { rows.push({ fixture: `${fixture.owner}/${fixture.name}`, operation,
      status: /^(http-(401|403|404)|graphql-forbidden)$/.test(error?.message) ? 'blocked' : 'failed',
      detail: safeError(error), milliseconds: performance.now() - started }); }
    onResult?.(rows.at(-1));
  }
  for (const fixture of fixtures) {
    const prefix = `/repos/${fixture.owner}/${fixture.name}`;
    await record(fixture, 'issue-create-edit-assignment-readback', async () => {
      const issue = await request('POST', `${prefix}/issues`, { title: 'D-05 synthetic Issue',
        body: 'Task-owned qualification fixture for Pipeliner Issue #26. No product or private data.', assignees: ['brimdor'] });
      if (!Number.isSafeInteger(issue.number) || issue.number < 1 || !Number.isSafeInteger(issue.id) || typeof issue.node_id !== 'string') throw new Error('readback-mismatch');
      await request('PATCH', `${prefix}/issues/${issue.number}`, { title: 'D-05 synthetic Issue — updated' });
      const actual = await request('GET', `${prefix}/issues/${issue.number}`);
      if (actual.id !== issue.id || actual.node_id !== issue.node_id || actual.number !== issue.number ||
        actual.title !== 'D-05 synthetic Issue — updated' || actual.state !== 'open' ||
        !Array.isArray(actual.assignees) || actual.assignees.length !== 1 || actual.assignees[0].login !== 'brimdor') throw new Error('readback-mismatch');
      return { number: issue.number, id: issue.id, node: issue.node_id };
    });
    await record(fixture, 'repository-creation', async () => {
      const created = await request('POST', fixture.type === 'User' ? '/user/repos' : `/orgs/${fixture.owner}/repos`,
        { name: fixture.name, private: true, description: 'Disposable Pipeliner D-05 qualification fixture' });
      // The designated name already exists. An unexpected creation is retained for reconciliation, never silently adopted.
      if (!Number.isSafeInteger(created.id) || created.full_name !== `${fixture.owner}/${fixture.name}` || created.private !== true) throw new Error('readback-mismatch');
      return { unexpectedCreation: true, id: created.id, node: created.node_id };
    });
    await record(fixture, 'projects-access', async () => {
      const kind = fixture.type === 'User' ? 'user' : 'organization';
      const projects = await collectConnection(async cursor => {
        const data = await request('POST', '/graphql', { query:
          `query($login:String!,$cursor:String){${kind}(login:$login){login projectsV2(first:100,after:$cursor){totalCount nodes{id title public} pageInfo{hasNextPage endCursor}}}}`,
          variables: { login: fixture.owner, cursor } });
        if (data.data?.[kind]?.login !== fixture.owner) throw new Error('readback-mismatch');
        return data.data[kind].projectsV2;
      });
      const title = `Pipeliner D-05 #26 ${fixture.type === 'User' ? 'Personal' : 'Organization'} Fixture`;
      return { count: projects.length, fixtureCollision: projects.some(p => p.title === title) };
    });
  }
  return { installations: 'passed', rows, limitations: [
    'Repository creation at an existing fixture name cannot prove successful creation; HTTP 422 is inconclusive.',
    'Project creation/fields, labels/Ready, Git transport, PR/check/merge, publication, revocation and full native product integration are not qualified by this preflight.',
    'Uncertain writes require reconciliation before a later attempt; this function never retries them.',
  ] };
}
