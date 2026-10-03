import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMCPClient, ownedLoopback, publicAddress, endpointURL, protocolVersion } from './transport.mjs';

const schema = { type: 'object', properties: { title: { type: 'string', 'x-mcp-header': 'Title' } }, required: ['title'], additionalProperties: false };
const output = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };
const tool = { name: 'queue_count', description: 'Counts synthetic queue entries.', inputSchema: schema, outputSchema: output };
const token = 'synthetic-only-no-account';
async function fixture(handler, run) {
  const sockets = new Set(), calls = [], failures = [];
  const server = createServer(async (request, response) => {
    try {
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes); calls.push({ body, headers: request.headers });
      await handler({ request, response, body, index: calls.length });
    } catch (error) { failures.push(error); response.destroy(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = ownedLoopback(server), client = createMCPClient({ endpoint: local.endpoint, local, credential: token, authorize() {} });
  try { await run({ client, calls, server, local }); }
  finally {
    client.close(); const closed = once(server, 'close'), socketClosures = [...sockets].map(socket => once(socket, 'close'));
    server.close(); for (const socket of sockets) socket.destroy(); await Promise.all([closed, ...socketClosures]);
    assert.equal(server.listening, false); assert.equal(sockets.size, 0); assert.deepEqual(failures, []);
  }
}
function json(response, body, result) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); }

test('destination validation denies private, mapped, special and unowned loopback endpoints', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.2', '100.64.0.1', '192.0.2.3', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:808:808::1', '3fff::1', '2001::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicAddress(address), true, address);
  for (const endpoint of ['http://example.com/mcp', 'http://127.0.0.1:4321/mcp', 'https://localhost/mcp', 'https://10.1.2.3/mcp', 'https://user:password@example.com/mcp', 'https://example.com/mcp?token=secret', 'https://example.com/mcp#fragment']) assert.throws(() => endpointURL(endpoint), /MCP destination/);
  assert.equal(endpointURL('https://example.com/mcp').href, 'https://example.com/mcp');
});

test('actual owned HTTP socket carries exact modern metadata, typed headers and bounded structured output', async () => {
  await fixture(({ response, body }) => json(response, body, body.method === 'tools/list' ? { resultType: 'complete', tools: [tool] }
    : { resultType: 'complete', content: [{ type: 'text', text: 'One synthetic entry.' }], structuredContent: { count: 1 } }), async ({ client, calls }) => {
    assert.deepEqual((await client.list()).tools, [tool]);
    const result = await client.call(tool, { title: 'Queue\nname' }); assert.deepEqual(result.structuredContent, { count: 1 });
    const call = calls[1]; assert.equal(call.headers.authorization, 'Bearer ' + token);
    assert.equal(call.headers['mcp-protocol-version'], protocolVersion); assert.equal(call.headers['mcp-method'], 'tools/call'); assert.equal(call.headers['mcp-name'], tool.name);
    assert.equal(call.headers['mcp-param-title'], '=?base64?UXVldWUKbmFtZQ==?=');
    assert.equal(call.headers.accept, 'application/json, text/event-stream');
    assert.deepEqual(call.body.params._meta, { 'io.modelcontextprotocol/protocolVersion': protocolVersion, 'io.modelcontextprotocol/clientInfo': { name: 'Pipeliner', version: '0.1.0' }, 'io.modelcontextprotocol/clientCapabilities': {} });
    await assert.rejects(client.call(tool, { title: 54 }), /MCP input invalid/); assert.equal(calls.length, 2, 'invalid input sends no request');
  });
});

test('chunked SSE handles comments and multiline JSON; notifications never invoke host actions', async () => {
  await fixture(({ response, body }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = [': keepalive\r', '\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
      'event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":' + JSON.stringify(body.id) + ',"result":{"resultType":"complete","content":[],"structuredContent":{"count":2}}}\r\n\r\n'];
    chunks.forEach(chunk => response.write(chunk)); // Deliberately do not end; the final response must close its owned socket.
  }, async ({ client }) => assert.deepEqual((await client.call(tool, { title: 'Queue' })).structuredContent, { count: 2 }));
});

test('RPC trust failures and external interaction block, report dispatch uncertainty and never replay', async () => {
  const cases = [
    (body) => [{ jsonrpc: '2.0', id: body.id, result: {} }],
    () => ({ jsonrpc: '2.0', id: 'wrong', result: {} }),
    (body) => ({ jsonrpc: '2.0', id: body.id, method: 'settings.apply', params: {} }),
    (body) => ({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', inputRequests: { login: { method: 'elicitation/create' } } } }),
    (body) => ({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', content: [], structuredContent: { count: 'two' } } }),
    (body) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: token } }),
    (body) => ({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', content: [{ type: 'text', text: token }] } }),
  ];
  for (const reply of cases) await fixture(({ response, body }) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(reply(body))); }, async ({ client, calls }) => {
    await assert.rejects(client.call(tool, { title: 'Queue' }), error => error.message.startsWith('MCP ') && !error.message.includes(token) && error.dispatched === true);
    assert.equal(calls.length, 1);
  });
});

test('HTTP redirect/auth/encoding/size failures never disclose credentials or follow another destination', async () => {
  for (const kind of ['redirect', 'unauthorized', 'encoding', 'oversize', 'invalid-utf8']) await fixture(({ response, body }) => {
    if (kind === 'redirect') { response.writeHead(307, { location: 'http://127.0.0.1:1/private' }); response.end(token); }
    else if (kind === 'unauthorized') { response.writeHead(401); response.end(token); }
    else if (kind === 'encoding') { response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); response.end(token); }
    else if (kind === 'invalid-utf8') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(Buffer.from([0xff])); }
    else json(response, body, { resultType: 'complete', content: [{ type: 'text', text: 'x'.repeat(1048577) }] });
  }, async ({ client, calls }) => { await assert.rejects(client.call(tool, { title: 'Queue' }), error => error.message.startsWith('MCP ') && !error.message.includes(token)); assert.equal(calls.length, 1); });
});

test('deadline/cancel/revocation terminate owned sockets; stale or forged local handles send nothing', async () => {
  await fixture(({ response }) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); }, async ({ client, calls, local }) => {
    await assert.rejects(client.call(tool, { title: 'Queue' }, { timeoutMs: 300 }), error => /MCP deadline/.test(error.message) && error.dispatched);
    const controller = new AbortController(), work = client.call(tool, { title: 'Queue' }, { signal: controller.signal });
    while (calls.length < 2) await new Promise(resolve => setTimeout(resolve, 5)); controller.abort(); await assert.rejects(work, /MCP cancelled/);
    assert.throws(() => createMCPClient({ endpoint: local.endpoint, local: { ...local }, authorize() {} }), /MCP destination/);
    const closing = client.call(tool, { title: 'Queue' }); while (calls.length < 3) await new Promise(resolve => setTimeout(resolve, 5));
    client.close(); await assert.rejects(closing, error => /MCP connection closed/.test(error.message) && error.dispatched);
  });
  await fixture(({ response, body }) => json(response, body, { resultType: 'complete', content: [] }), async ({ local, calls }) => {
    let granted = true; const client = createMCPClient({ endpoint: local.endpoint, local, authorize() { if (!granted) throw new Error('private-detail'); } });
    granted = false; await assert.rejects(client.call(tool, { title: 'Queue' }), error => error.message === 'MCP authority unavailable.' && !error.dispatched); assert.equal(calls.length, 0); client.close();
  });
});

test('discovery excludes invalid tools with safe reasons, retains valid tools and stops cyclic pagination', async () => {
  await fixture(({ response, body }) => json(response, body, { resultType: 'complete', tools: [tool, { name: 'broken', inputSchema: { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Bad\r\nName' } } } }] }), async ({ client }) => {
    const catalog = await client.list(); assert.deepEqual(catalog.tools, [tool]); assert.deepEqual(catalog.rejected, [{ name: 'broken', reason: 'Unsupported or unsafe tool definition.' }]);
  });
  await fixture(({ response, body }) => json(response, body, { resultType: 'complete', tools: [], nextCursor: 'same' }), async ({ client, calls }) => {
    await assert.rejects(client.list(), /MCP pagination invalid/); assert.equal(calls.length, 2);
  });
});
