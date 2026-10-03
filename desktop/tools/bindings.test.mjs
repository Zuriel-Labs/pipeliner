import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePipeline, developmentTemplate } from '../core/settings.mjs';
import { boundToolInput } from './bindings.mjs';
import { toolPackage } from './package.mjs';
const pin = 'tool-' + 'a'.repeat(40), candidate = { sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
const extension = { kind: 'mcp', pin, bindings: [{ path: ['title'], source: 'issue.title' }], constants: { limit: 1 } };
const pack = toolPackage({ name: 'queue', purpose: 'Read scoped queue', version: '1', license: 'MIT', dataCategories: ['issue.title', 'pm.supplied'],
  mcp: { endpoint: 'https://example.com/mcp', protocolVersion: '2026-07-28', tool: { name: 'queue', inputSchema: { type: 'object' } } } });
function pipeline(value = extension) { const graph = structuredClone(developmentTemplate); graph.steps[1].kind = 'extension'; graph.steps[1].extension = value; return graph; }

test('typed extension declarations reject forged identities, executable fields, ambiguous paths and unbounded retry', () => {
  validatePipeline(pipeline(), true);
  for (const value of [{ ...extension, endpoint: 'https://other.example/mcp' }, { ...extension, pin: 'invented' }, { ...extension, kind: 'host-command' },
    { ...extension, bindings: [{ path: ['__proto__'], source: 'issue.title' }] }, { ...extension, bindings: [...extension.bindings, ...extension.bindings] },
    { ...extension, bindings: [{ path: ['title'], source: 'credentials' }] }, { ...extension, bindings: [{ path: ['title'], source: 'previous.structuredContent', step: 'missing' }] },
    { ...extension, constants: { title: 'overwrite bound title' } }]) assert.throws(() => validatePipeline(pipeline(value), true), /Extension/);
  const retry = pipeline(); retry.steps[1].retryLimit = 1; assert.throws(() => validatePipeline(retry, true), /Extension/);
});

test('only explicitly declared data reaches a destination; constants cannot override binding or manufacture source values', () => {
  const context = { issue: { number: 54, title: 'Scoped work', body: 'Private body excluded.' }, candidate, records: [] };
  assert.deepEqual(boundToolInput(extension, pack, context), { title: 'Scoped work', limit: 1 });
  const undeclared = toolPackage({ ...pack.definition, dataCategories: ['issue.title'] }); assert.throws(() => boundToolInput(extension, undeclared, context), /data category/);
  const body = { ...extension, bindings: [{ path: ['title'], source: 'issue.body' }] }; assert.throws(() => boundToolInput(body, pack, context), /data category/);
});

test('prior-result bindings require verified exact-candidate evidence from the declared step; no fallback or cross-step data', () => {
  const value = { ...extension, bindings: [{ path: ['count'], source: 'previous.structuredContent', step: 'research', selection: ['count'] }], constants: {} };
  const selected = toolPackage({ ...pack.definition, dataCategories: ['previous.structuredContent'] });
  const row = { step: 'research', kind: 'extension', state: 'verified', result: { candidate, result: { structuredContent: { count: 2, ignored: 'Excluded.' } } } };
  assert.deepEqual(boundToolInput(value, selected, { issue: {}, candidate, records: [row] }), { count: 2 });
  for (const records of [[], [{ ...row, state: 'uncertain' }], [{ ...row, step: 'other' }], [{ ...row, result: { ...row.result, candidate: { ...candidate, gitTree: 'd'.repeat(40) } } }]]) assert.throws(() => boundToolInput(value, selected, { issue: {}, candidate, records }), /verified source/);
});
