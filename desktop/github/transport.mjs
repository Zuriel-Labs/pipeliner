export const appPermissions = Object.freeze({ actions: 'read', checks: 'read', contents: 'write', issues: 'write', metadata: 'read',
  organization_projects: 'write', pull_requests: 'write', statuses: 'read' });

export function makeRequest(accessToken, send, signal) {
  return async function request(method, path, body, upload = false) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    let reader, dispatched = false;
    const mutation = method !== 'GET' && !(path === '/graphql' && body?.query?.startsWith('query('));
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
  };
}
