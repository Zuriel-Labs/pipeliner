import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planAdoption, applyAdoptionPlan } from '../scripts/lib/adoption.mjs';
import { validateProfile } from '../scripts/lib/config.mjs';
import { validateRepository } from '../scripts/lib/validation.mjs';
import { digest } from '../scripts/lib/ci.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
test('all topology examples work independently with direct and gated release profiles', async () => {
  for (const release of ['direct-production', 'immutable-promotion', 'multi-environment']) {
    const profile = JSON.parse(await readFile(path.join(sourceRoot, `blueprints/profiles/${release}.config.json`), 'utf8'));
    for (const filename of await readdir(path.join(sourceRoot, 'blueprints/qa'))) {
      profile.qa = JSON.parse(await readFile(path.join(sourceRoot, 'blueprints/qa', filename), 'utf8'));
      assert.equal(validateProfile(profile).release.strategy, release);
    }
  }
});

test('temporary customized repository adopts, validates and repeats without erasing policy', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-scenario-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const targetRoot = path.join(parent, 'target'); await mkdir(targetRoot);
  const profile = JSON.parse(await readFile(path.join(sourceRoot, 'blueprints/profiles/direct-production.config.json'), 'utf8'));
  const config = path.join(parent, 'profile.json'); await writeFile(config, JSON.stringify(profile));
  // CLI dry-run must not mutate even an empty destination.
  execFileSync(process.execPath, [path.join(sourceRoot, 'scripts/adopt.mjs'), '--target', targetRoot, '--config', config, '--dry-run']);
  assert.deepEqual(await readdir(targetRoot), []);
  const upstream = await readFile(path.join(sourceRoot, 'AGENTS.md'), 'utf8');
  const custom = `${upstream}\nTarget-specific rule: preserve the fixture database.\n`;
  await writeFile(path.join(targetRoot, 'AGENTS.md'), custom);
  await writeFile(path.join(targetRoot, 'unrelated.txt'), 'preserved');
  const reconciliation = { version: 1, files: { 'AGENTS.md': { sourceSha256: digest(upstream), targetSha256: digest(custom), rationale: 'Retain fixture preservation rule alongside complete canonical policy.' } } };
  const plan = await planAdoption({ sourceRoot, targetRoot, profile, reconciliation });
  assert.equal(plan.conflicts.length, 0);
  await applyAdoptionPlan(plan);
  // Review only the generated fixed Git check; never import the source repository ledger.
  const workflow = '.github/workflows/reusable-quality.yml';
  const text = await readFile(path.join(targetRoot, workflow), 'utf8');
  assert.doesNotMatch(text, /setup-command|quality-command|bash -|npm|docker build/);
  await writeFile(path.join(targetRoot, '.agents/ci-review.json'), JSON.stringify({ version: 1, workflows: {
    [workflow]: { rationale: 'Pinned checkout and fixed Git whitespace inspection only; no target setup, scripts or application builds.', files: { [workflow]: digest(text) } }
  } }));
  assert.deepEqual(await validateRepository(targetRoot), []);
  const repeated = await planAdoption({ sourceRoot, targetRoot, profile, reconciliation });
  assert.equal(repeated.create.length, 0);
  assert.equal(repeated.conflicts.length, 0);
  assert.equal(await readFile(path.join(targetRoot, 'AGENTS.md'), 'utf8'), custom);
  assert.equal(await readFile(path.join(targetRoot, 'unrelated.txt'), 'utf8'), 'preserved');
});

test('legacy adoption CLI requires discovery without changing the target', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-legacy-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'target'); await mkdir(target);
  const profile = JSON.parse(await readFile(path.join(sourceRoot, 'pipeliner.config.json'), 'utf8')); delete profile.qa;
  const config = path.join(parent, 'profile.json'); await writeFile(config, JSON.stringify(profile));
  assert.throws(() => execFileSync(process.execPath, [path.join(sourceRoot, 'scripts/adopt.mjs'), '--target', target, '--config', config], { stdio: 'pipe' }), /QA discovery required/);
  assert.deepEqual(await readdir(target), []);
});
