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

test('installed question guidance reaches provider paths and conflicting customizations block CLI writes', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-question-scenario-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const targetRoot = path.join(parent, 'target'); await mkdir(targetRoot);
  const profile = JSON.parse(await readFile(path.join(sourceRoot, 'pipeliner.config.json')));
  const config = path.join(parent, 'profile.json'); await writeFile(config, JSON.stringify(profile));
  await applyAdoptionPlan(await planAdoption({ sourceRoot, targetRoot, profile }));
  for (const relative of ['AGENTS.md', '.agents/skills/pipeliner-adopt/SKILL.md',
    '.agents/skills/pipeliner-adopt/references/discovery.md', '.agents/skills/pipeliner-maintain/references/questions.md',
    '.agents/skills/pipeliner-adopt/agents/openai.yaml', '.agents/skills/pipeliner-update/agents/openai.yaml']) {
    const installed = await readFile(path.join(targetRoot, relative), 'utf8');
    assert.equal(installed, await readFile(path.join(sourceRoot, relative), 'utf8'));
    assert.match(installed, /end the turn immediately/);
  }
  const args = [path.join(sourceRoot, 'scripts/adopt.mjs'), '--target', targetRoot, '--config', config];
  for (const relative of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md',
    '.agents/skills/pipeliner-adopt/agents/openai.yaml', '.claude/skills/pipeliner-adopt/SKILL.md']) {
    const file = path.join(targetRoot, relative);
    const original = await readFile(file, 'utf8');
    const bad = original + '\nUse request_user_input for clarification.\n';
    await writeFile(file, bad);
    const reconciliation = { version: 1, files: { [relative]: {
      sourceSha256: digest(original), targetSha256: digest(bad), rationale: 'Previously reviewed customization.' } } };
    const manifest = path.join(parent, 'reconciliation.json');
    await writeFile(manifest, JSON.stringify(reconciliation));
    for (const extra of [[], ['--dry-run']]) {
      assert.throws(() => execFileSync(process.execPath, [...args, '--reconciliation', manifest, ...extra], { stdio: 'pipe' }), /conflicting question instructions/);
    }
    assert.equal(await readFile(file, 'utf8'), bad);
    assert.ok((await validateRepository(targetRoot)).some(error => error.startsWith(relative + ': superseded native-question')));
    await writeFile(file, original);
  }
  assert.deepEqual((await planAdoption({ sourceRoot, targetRoot, profile })).questionConflicts, []);
});

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

test('non-Node adoption installs stack-neutral instructions and usable module entrypoints', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-non-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = JSON.parse(await readFile(path.join(sourceRoot, 'blueprints/profiles/direct-production.config.json')));
  profile.quality.commands = ['python3 -m unittest'];
  const plan = await planAdoption({ sourceRoot, targetRoot: root, profile });
  await applyAdoptionPlan(plan);
  const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /npm (ci|test|run check|run validate)/);
  assert.match(agents, /quality\.commands/);
  assert.match(agents, /reviewed.*source checkout/);
  assert.ok(!(await readdir(root)).includes('package.json'));
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/lib/qa.mjs'); await import('./scripts/lib/project.mjs');"], { cwd: root, stdio: 'pipe' });
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

test('installed validation rejects a broken reference and missing lifecycle skill', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = JSON.parse(await readFile(path.join(sourceRoot, 'blueprints/profiles/direct-production.config.json')));
  await applyAdoptionPlan(await planAdoption({ sourceRoot, targetRoot: root, profile }));
  const skill = path.join(root, '.agents/skills/pipeliner-work-issue/SKILL.md');
  await writeFile(skill, (await readFile(skill, 'utf8')) + '\nRead [missing reference](references/missing.md).\n');
  assert.ok((await validateRepository(root)).some(error => error.includes('missing.md')));
  await rm(path.join(root, '.agents/skills/pipeliner-review-issue'), { recursive: true });
  await rm(path.join(root, '.claude/skills/pipeliner-review-issue'), { recursive: true });
  assert.ok((await validateRepository(root)).some(error => error.includes('canonical pipeliner-review-issue skill is required')));
});

test('CLI adoption verifies target identity and installed home works outside the target cwd', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pipeliner-home-cli-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'target'); await mkdir(target);
  const profile = JSON.parse(await readFile(path.join(sourceRoot, 'blueprints/profiles/direct-production.config.json')));
  const config = path.join(parent, 'profile.json'); await writeFile(config, JSON.stringify(profile));
  const args = [path.join(sourceRoot, 'scripts/adopt.mjs'), '--target', target, '--config', config];
  execFileSync('git', ['init', target], { stdio: 'ignore' });
  execFileSync('git', ['-C', target, 'remote', 'add', 'origin', 'https://github.com/Wrong/repository.git']);
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /identity mismatch/);
  assert.deepEqual(await readdir(target), ['.git']);
  execFileSync('git', ['-C', target, 'remote', 'set-url', 'origin', `https://github.com/${profile.repository.owner}/${profile.repository.name}.git`]);
  execFileSync(process.execPath, args, { stdio: 'pipe' });
  const home = JSON.parse(execFileSync(process.execPath, [path.join(target, 'scripts/resolve-home.mjs')], { cwd: parent, encoding: 'utf8' }));
  assert.equal(home.repository, `${profile.repository.owner}/${profile.repository.name}`);
  execFileSync(process.execPath, args, { stdio: 'pipe' });
  const legacy = structuredClone(profile); delete legacy.qa.mode; delete legacy.qa.pms; legacy.qa.developers.forEach(d => { delete d.kind; delete d.github; });
  await writeFile(config, JSON.stringify(legacy));
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /paired QA discovery/);
});
