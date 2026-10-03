import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, retryAfter, retryDelay } from './reliability.mjs';

test('retry classification excludes controls, authentication, malformed output and uncertain writes', () => {
  for (const code of ['http-408', 'http-429', 'http-503', 'timeout', 'transport-failed', 'read-failed']) assert.equal(isTransient(new Error(code)), true);
  for (const code of ['http-401', 'http-403', 'write-result-uncertain', 'connection-changed', 'cancelled', 'malformed-stream', 'response-invalid']) assert.equal(isTransient(new Error(code)), false);
  assert.equal(retryDelay(1, null, () => 0.5), 2000); assert.equal(retryDelay(2, null, () => 0.5), 8000);
  assert.equal(retryDelay(1, 12000, () => 0.5), 12000);
  assert.equal(retryAfter(new Response(null, { headers: { 'retry-after': '12' } })), 12000);
  assert.equal(retryAfter(new Response(null, { headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:15 GMT' } }), 1000), 14000);
  assert.equal(retryAfter(new Response(null, { headers: { 'retry-after': 'private response text' } })), null);
});
