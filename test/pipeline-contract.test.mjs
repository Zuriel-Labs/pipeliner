import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validateProfile } from '../scripts/lib/config.mjs';
import { infrastructureReadiness, releaseChannelPath, validateCycle } from '../scripts/lib/release-cycle.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = file => readFile(path.join(root, file), 'utf8');

test('repository-local contract is explicit and does not create global pipeline state', async () => {
  const agents = await read('AGENTS.md');
  const skill = await read('.agents/skills/pipeliner-work-issue/SKILL.md');
  const lifecycle = await read('.agents/skills/pipeliner-work-issue/references/lifecycle.md');
  assert.match(agents, /Repository-local contract/);
  assert.match(agents, /Pending Review/);
  assert.match(agents, /PM must explicitly call for the next Issue/);
  assert.match(skill, /feature branch/);
  assert.match(skill, /exact PR may be merged/);
  assert.match(lifecycle, /Never auto-select/);
  assert.doesNotMatch(agents, /\/Users\/[^/\s]+\//);
  assert.doesNotMatch(skill, /\/Users\/[^/\s]+\//);
});

test('profile accepts an exact native Pending Review mapping without inventing one', async () => {
  const profile = JSON.parse(await read('pipeliner.config.json'));
  assert.equal(profile.project.statuses.pendingReview, undefined);
  const mapped = structuredClone(profile);
  mapped.project.statuses.pendingReview = 'Pending Review';
  validateProfile(mapped);
  mapped.project.statuses.pendingReview = mapped.project.statuses.inReview;
  assert.throws(() => validateProfile(mapped), /values must be unique/);
});

test('release channel defaults require a testing Canary and Stable promotion', async () => {
  assert.deepEqual(releaseChannelPath(), ['Canary', 'Alpha', 'Canary', 'Beta', 'Stable']);
  assert.deepEqual(releaseChannelPath({ omitAlpha: true }), ['Canary', 'Beta', 'Stable']);
  assert.deepEqual(releaseChannelPath({ omitAlpha: true, omitBeta: true }), ['Canary', 'Stable']);
  assert.deepEqual(releaseChannelPath({ extraCanaryBeforeStable: true }), ['Canary', 'Alpha', 'Canary', 'Beta', 'Canary', 'Stable']);
  assert.throws(() => releaseChannelPath({ omitBeta: true }), /only when Alpha/);

  const profile = JSON.parse(await read('pipeliner.config.json'));
  profile.release.strategy = 'multi-environment';
  const channels = releaseChannelPath();
  profile.release.environments = channels.map((channel, index) => ({
    name: `${channel.toLowerCase()}-${index}`,
    role: index === channels.length - 1 ? 'native' : 'native',
    buildCommand: '',
    deployCommand: '',
    verifyCommand: 'verify',
  }));
  profile.release.cycle = {
    channelPlan: {},
    phases: channels.map((channel, index) => ({
      id: `${channel.toLowerCase()}-${index}`,
      kind: index === channels.length - 1 ? 'production' : 'development',
      channel,
      branch: `release/${channel.toLowerCase()}-${index}`,
      environments: [`${channel.toLowerCase()}-${index}`],
      approvalPhrase: 'Approved',
      readiness: ['full Dev Pipeline and PM approval'],
      promotion: 'source',
      forwardPortTo: [],
    })),
  };
  validateCycle(profile);
  profile.release.cycle.phases[0].channel = 'Stable';
  assert.throws(() => validateCycle(profile), /release channel order/);
});

test('infrastructure agreement gates only build and deploy actions', async () => {
  const profile = JSON.parse(await read('pipeliner.config.json'));
  assert.equal(infrastructureReadiness(profile, 'plan').ready, true);
  assert.equal(infrastructureReadiness(profile, 'build').ready, false);
  profile.workflow.infrastructureAgreement = {
    state: 'agreed',
    buildMethod: 'local deterministic command set',
    testEnvironments: ['local-mac'],
    releaseDestinations: [],
    agreedBy: [{ role: 'human-pm', id: 'pm' }, { role: 'agent-dev', id: 'dev' }],
    evidence: 'Explicit repository-local agreement record',
  };
  validateProfile(profile);
  assert.equal(infrastructureReadiness(profile, 'build').ready, true);
  assert.equal(infrastructureReadiness(profile, 'deploy').ready, false);
  profile.workflow.infrastructureAgreement.releaseDestinations = ['configured destination'];
  assert.equal(infrastructureReadiness(profile, 'deploy').ready, true);
});
