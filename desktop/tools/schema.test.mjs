import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, headerParameters, headerValue } from './schema.mjs';

const schema = { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 240, 'x-mcp-header': 'Title' },
  target: { type: 'object', properties: { issue: { type: 'integer', minimum: 1, 'x-mcp-header': 'Issue' } }, required: ['issue'], additionalProperties: false } },
  required: ['title', 'target'], additionalProperties: false };

test('bounded schemas validate exact typed input without coercion, mutation or extra properties', async () => {
  const input = { title: 'Scoped review', target: { issue: 54 } }, original = JSON.stringify(input);
  assert.equal(await checkSchema(schema, input), true); assert.equal(JSON.stringify(input), original);
  for (const value of [{ title: '', target: { issue: 54 } }, { title: 'Review', target: { issue: '54' } }, { ...input, extra: true }]) assert.equal(await checkSchema(schema, value), false);
  assert.equal(await checkSchema(schema), true, 'discovery checks the schema without invoking a tool');
});

test('header annotations follow only static properties; safe types, uniqueness and encoding prevent ambiguity', () => {
  assert.deepEqual(headerParameters(schema, { title: 'Harbor\nQueue', target: { issue: 54 } }), { 'Mcp-Param-Title': '=?base64?SGFyYm9yClF1ZXVl?=', 'Mcp-Param-Issue': '54' });
  assert.equal(headerValue(' padded '), '=?base64?IHBhZGRlZCA=?='); assert.equal(headerValue('=?base64?literal?='), '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
  for (const value of [
    { type: 'object', properties: { a: { type: 'number', 'x-mcp-header': 'A' } } },
    { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A' }, b: { type: 'string', 'x-mcp-header': 'a' } } },
    { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Bad\r\nAuthorization' } } },
    { type: 'object', allOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }] },
    { type: 'array', items: { type: 'string', 'x-mcp-header': 'A' } },
  ]) assert.throws(() => headerParameters(value, {}), /MCP schema/);
});

test('external references, executable keywords, reserved data and oversized schema fail before compilation', async () => {
  for (const value of [{ $ref: 'https://example.test/private' }, { $async: true }, JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
    { type: 'string', description: 'x'.repeat(65537) }]) await assert.rejects(checkSchema(value, {}), /MCP schema/);
  await assert.rejects(checkSchema({ type: 'object' }, JSON.parse('{"constructor":{"admin":true}}')), /MCP data/);
});

test('expensive untrusted validation expires off the PM thread and its owned worker terminates', async () => {
  const malicious = { type: 'string', pattern: '^(a+)+$' }, at = performance.now();
  await assert.rejects(checkSchema(malicious, 'a'.repeat(80) + '!', { timeoutMs: 300 }), /MCP schema deadline/);
  assert.ok(performance.now() - at < 3000); assert.equal(await checkSchema({ type: 'integer' }, 54), true, 'no poisoned worker is reused');
});
