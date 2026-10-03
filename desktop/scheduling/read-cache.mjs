// Memory-only conditional GETs. Each connection epoch owns a separate bounded cache.
export function conditionalReads(send = fetch) {
  const cache = new Map(); let total = 0;
  return async (url, request) => {
    const prior = request.method === 'GET' ? cache.get(url) : null;
    const response = await send(url, { ...request, headers: { ...request.headers, ...(prior ? { 'If-None-Match': prior.etag } : {}) } });
    if (response.status === 304) {
      if (!prior) throw new Error('read-failed');
      return new Response(prior.body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const etag = response.headers.get('etag');
    if (request.method !== 'GET' || response.status !== 200 || !etag || etag.length > 240 || !/^https:\/\/api\.github\.com\//.test(url)) return response;
    // Read one bounded body and return it to the normal typed transport; never cache credentials or writes.
    const reader = response.body?.getReader(); if (!reader) return response;
    const chunks = []; let bytes = 0;
    try { for (;;) { const part = await reader.read(); request.signal?.throwIfAborted(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1048576) throw new Error('response-too-large'); chunks.push(part.value); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    if (cache.has(url)) { total -= cache.get(url).body.byteLength; cache.delete(url); }
    while (cache.size >= 32 || total + bytes > 4 * 1048576) { const oldest = cache.keys().next().value; if (!oldest) break; total -= cache.get(oldest).body.byteLength; cache.delete(oldest); }
    cache.set(url, { etag, body }); total += bytes;
    return new Response(body, { status: response.status, headers: response.headers });
  };
}
