import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest, auditCI } from '../scripts/lib/ci.mjs';

test('CI requires reviewed workflow and transitive bytes and rejects stale evidence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.github/workflows'), { recursive: true });
  const workflow = 'name: lightweight\njobs:\n  check:\n    steps:\n      - run: node lint.mjs\n';
  await writeFile(path.join(root, '.github/workflows/check.yml'), workflow);
  await writeFile(path.join(root, 'lint.mjs'), '// reviewed linter');
  assert.ok((await auditCI(root)).length);
  const review = { version: 1, workflows: { '.github/workflows/check.yml': {
    rationale: 'Reviewed transitive linter, no build or dynamic code loading.', files: {
      '.github/workflows/check.yml': digest(workflow), 'lint.mjs': digest('// reviewed linter') } } } };
  assert.deepEqual(await auditCI(root, review), []);
  await writeFile(path.join(root, 'lint.mjs'), 'buildApplication()');
  assert.ok((await auditCI(root, review)).some(error => error.includes('lint.mjs')));
  review.workflows['.github/workflows/check.yml'].files['../escape'] = 'a'.repeat(64);
  assert.ok((await auditCI(root, review)).some(error => error.includes('unsafe')));
});
