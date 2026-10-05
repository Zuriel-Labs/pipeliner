import test from 'node:test';
import assert from 'node:assert/strict';
import { invokePinnedTool } from './invoke.mjs';
import { toolPackage, toolManifestHash } from './package.mjs';
const binding = { runId: 'fixture-run', epoch: 1 }, inputSchema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
const mcp = toolPackage({ name: 'queue', purpose: 'Read scoped queue', version: '1', license: 'MIT', dataCategories: ['issue.title'], mcp: {
  endpoint: 'https://example.com/mcp', protocolVersion: '2026-07-28', tool: { name: 'queue', inputSchema } } });
const command = toolPackage({ name: 'check', purpose: 'Check scoped work', version: '1', license: 'MIT', dataCategories: ['issue.title'],
  command: { script: 'printf done', timeoutSeconds: 30, inputSchema } });
function connector(options = {}) {
  const calls = [];
  return { calls, connect: async pack => ({ endpoint: pack.definition.mcp.endpoint, protocolVersion: '2026-07-28',
    async list() { calls.push('list'); return { tools: [options.changed ? { ...pack.definition.mcp.tool, description: 'changed' } : pack.definition.mcp.tool] }; },
    async call(tool, input) { calls.push({ tool, input }); options.revoke?.(); if (options.error) throw options.error;
      return { resultType: 'complete', content: [], structuredContent: { count: 1 }, ...(options.isError ? { isError: true } : {}) }; }, close() { calls.push('close'); } }) };
}
test('MCP invocation pins destination and complete catalog; input and authority failures send no effect', async () => {
  const target = connector(), args = { pack: mcp, binding, input: { title: 'Scoped work' }, connectMCP: target.connect, authorize() {} };
  const result = await invokePinnedTool(args); assert.deepEqual(result.structuredContent, { count: 1 }); assert.equal(result.sourceDigest, mcp.digest);
  assert.equal(target.calls[1].input.title, 'Scoped work'); assert.equal(target.calls.at(-1), 'close');
  const before = target.calls.length;
  await assert.rejects(invokePinnedTool({ ...args, input: { title: 54 } }), error => /Tool input/.test(error.message) && error.dispatched === false);
  await assert.rejects(invokePinnedTool({ ...args, authorize: () => false }), error => /Tool authority/.test(error.message) && !error.dispatched); assert.equal(target.calls.length, before);
  const changed = connector({ changed: true }); await assert.rejects(invokePinnedTool({ ...args, connectMCP: changed.connect }), error => /Tool catalog changed/.test(error.message) && !error.dispatched);
  assert.deepEqual(changed.calls, ['list', 'close']);
});
test('revoked authority, lost replies and server errors block with effect uncertainty and no automatic replay', async () => {
  for (const kind of ['revoked', 'lost', 'error-result']) {
    let granted = true;
    const target = connector({ ...(kind === 'revoked' ? { revoke: () => { granted = false; } } : {}), ...(kind === 'lost' ? { error: Object.assign(new Error('private-token'), { dispatched: true }) } : {}), ...(kind === 'error-result' ? { isError: true } : {}) });
    await assert.rejects(invokePinnedTool({ pack: mcp, binding, input: { title: 'Scoped work' }, connectMCP: target.connect, authorize: () => granted }), error => error.dispatched === true && !error.message.includes('private-token'));
    assert.equal(target.calls.filter(value => typeof value === 'object').length, 1); assert.equal(target.calls.at(-1), 'close');
  }
});
test('connection cleanup is awaited and a cleanup failure withholds the result without leaking credentials or losing effect uncertainty', async () => {
  let closed = false;
  const connectMCP = async pack => ({ endpoint: pack.definition.mcp.endpoint, protocolVersion: '2026-07-28',
    list: async () => ({ tools: [pack.definition.mcp.tool] }), call: async () => ({ content: [], structuredContent: {} }),
    async close() { await new Promise(resolve => setTimeout(resolve, 10)); closed = true; throw new Error('private-cleanup-token'); } });
  await assert.rejects(invokePinnedTool({ pack: mcp, binding, input: { title: 'Scoped work' }, connectMCP, authorize() {} }),
    error => error.dispatched === true && error.message === 'Tool cleanup could not be verified; effect needs readback.');
  assert.equal(closed, true);
});
test('custom command uses exact fixed definition and typed input through the restricted worker; output never selects another command', async () => {
  const calls = [], supervisor = { async tool(actual, request) { calls.push({ actual, request }); return { ok: true, result: { exitCode: 0, output: 'done', truncated: false, timedOut: false } }; } };
  const result = await invokePinnedTool({ pack: command, binding, input: { title: "$(printf malicious); 'quoted'" }, supervisor, authorize() {} });
  assert.deepEqual(calls[0].actual, binding); assert.deepEqual(calls[0].request, { operation: 'run', command: 'printf done', timeoutMs: 30000, input: { title: "$(printf malicious); 'quoted'" } });
  assert.equal(result.structuredContent.exitCode, 0); assert.equal(result.sourceDigest, command.digest); assert.equal(toolManifestHash(command.definition), command.digest);
});
