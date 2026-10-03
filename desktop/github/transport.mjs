import { setTimeout as sleep } from 'node:timers/promises';
import { isTransient, retryAfter, retryDelay } from '../core/reliability.mjs';

export const appPermissions = Object.freeze({ actions: 'read', checks: 'read', contents: 'write', issues: 'write', metadata: 'read',
  organization_projects: 'write', pull_requests: 'write', statuses: 'read' });

export function makeRequest(accessToken, send, signal, retry) {
  if (retry && (!Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 10 || !Number.isSafeInteger(retry.deadlineAt))) throw new Error('Invalid transport retry bounds');
  return async function request(method, path, body, upload = false) {
    const mutation = method !== 'GET' && !(path === '/graphql' && body?.query?.startsWith('query('));
    async function execute() {
    const remaining = retry ? retry.deadlineAt - Date.now() : 30000;
    if (remaining <= 0) throw new Error('Transport deadline exhausted');
    const deadline = AbortSignal.timeout(Math.min(30000, remaining));
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let reader, dispatched = false;
    try {
      combined.throwIfAborted();
      dispatched = true;
      const response = await send(`https://${upload ? 'uploads' : 'api'}.github.com${path}`, { method, redirect: 'error', signal: combined,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Pipeliner-D05-Qualification',
          ...(body ? { 'Content-Type': upload ? 'application/octet-stream' : 'application/json' } : {}) },
        body: body ? upload ? body : JSON.stringify(body) : undefined });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new Error(`http-${response.status}`); error.retryAfterMs = retryAfter(response); throw error;
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
      if (!data || typeof data !== 'object') throw new Error('response-invalid');
      if (data.errors?.length) {
        const kind = data.errors.some(error => error.type === 'FORBIDDEN') ? 'forbidden'
          : data.errors.some(error => error.type === 'INSUFFICIENT_SCOPES') ? 'insufficient-scopes'
          : data.errors.some(error => error.type === 'NOT_FOUND') ? 'not-found'
          : data.errors.some(error => ['undefinedField', 'argumentNotAccepted', 'variableMismatch', 'missingRequiredArguments'].includes(error.extensions?.code)) ? 'validation' : 'rejected';
        const error = new Error(`graphql-${kind}`);
        error.fields = [...new Set(data.errors.flatMap(error => Array.isArray(error.path) ? error.path : [])
          .filter(field => ['id', 'login', 'repositories', 'projectsV2', 'owner', 'createProjectV2'].includes(field)))];
        throw error;
      }
      return data;
    } catch (error) {
      await reader?.cancel().catch(() => {});
      if (signal?.aborted) throw new Error(mutation && dispatched ? 'write-result-uncertain' : 'cancelled');
      if (/^(http-\d{3}|graphql-(forbidden|rejected|insufficient-scopes|validation|not-found))$/.test(error?.message)) throw error;
      if (!mutation && /^(response-invalid|response-too-large)$/.test(error?.message)) throw error;
      // A lost write reply never authorizes another dispatch.
      throw new Error(mutation && dispatched ? 'write-result-uncertain' : 'read-failed');
    } finally { reader?.releaseLock(); }
    }
    for (let attempt = 1; ; attempt++) {
      try { return await execute(); }
      catch (error) {
        if (mutation || signal?.aborted || !isTransient(error) || attempt >= (retry?.attempts ?? 1)) throw error;
        const delay = retryDelay(attempt, error.retryAfterMs);
        if (Date.now() + delay >= retry.deadlineAt) throw new Error('Transport retry cannot fit remaining deadline');
        await sleep(delay, undefined, { signal });
      }
    }
  };
}
