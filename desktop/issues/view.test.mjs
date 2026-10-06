import test from 'node:test';
import assert from 'node:assert/strict';
import { issuePage } from './view.mjs';

test('cached Issue pages expose every result within a fixed bound, literal search and unchanged input', () => {
  const issues = Array.from({ length: 10000 }, (_, i) => ({ number: i + 1, title: 'Synthetic Issue ' + (i + 1) }));
  const first = issuePage(issues, '', 0), last = issuePage(issues, '', 999);
  assert.equal(first.rows.length, 50); assert.equal(first.count, 10000); assert.equal(first.pages, 200); assert.equal(first.rows[0], issues[0]);
  assert.equal(last.page, 199); assert.equal(last.rows[49], issues[9999]); assert.equal(issues.length, 10000);
  assert.deepEqual(issuePage(issues, '#10000', 1).rows, [issues[9999]]);
  assert.equal(issuePage(issues, 'synthetic issue 10000', 0).count, 1);
  assert.equal(issuePage(issues, '.*', 0).count, 0); assert.equal(issuePage([], '', 0).page, 0);
  for (const [query, page] of [['', -1], ['', Infinity], ['x'.repeat(257), 0], [null, 0]]) assert.throws(() => issuePage(issues, query, page));
});
