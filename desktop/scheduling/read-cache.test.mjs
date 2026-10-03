import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionalReads } from './read-cache.mjs';
test('conditional reads require authenticated fresh 304 and never replay or cache writes', async () => {
  let count = 0; const seen = [];
  const send = conditionalReads(async (_url, request) => { seen.push(request); return ++count === 1 ? Response.json({ complete: true }, { headers: { etag: '"revision-one"' } }) : new Response(null, { status: 304 }); });
  const url = 'https://api.github.com/repos/fixture/repo/issues', input = { method: 'GET', headers: { Authorization: 'Bearer synthetic-test' } };
  assert.deepEqual(await (await send(url, input)).json(), { complete: true }); assert.deepEqual(await (await send(url, input)).json(), { complete: true });
  assert.equal(seen[1].headers['If-None-Match'], '"revision-one"'); assert.equal(seen[1].headers.Authorization, input.headers.Authorization);
  await assert.rejects(send(url, { ...input, method: 'POST' }), /read-failed/);
  const empty = conditionalReads(async () => new Response(null, { status: 304 })); await assert.rejects(empty(url, input), /read-failed/);
  const denied = conditionalReads(async () => new Response(null, { status: 403 })); assert.equal((await denied(url, input)).status, 403);
});
