import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from 'node:crypto';

import { applyAdoptionPlan, planAdoption } from "../scripts/lib/adoption.mjs";
import { validateProfile } from "../scripts/lib/config.mjs";

function validProfile() {
  return {
    version: 1,
    repository: {
      owner: "Example-Org",
      name: "example-app",
      defaultBranch: "main",
      projectManager: "octocat",
    },
    project: {
      owner: "Example-Org",
      number: 7,
      title: "Example App",
      statusField: "Status",
      statuses: {
        backlog: "Backlog",
        onHold: "On Hold",
        inProgress: "In Progress",
        inReview: "In Review",
        done: "Done",
      },
      metadataFields: {
        priority: { name: "Priority", options: ["P0", "P1", "P2", "P3"] },
        impact: { name: "Impact", options: ["High", "Medium", "Low"] },
        effort: { name: "Effort", options: ["XS", "S", "M", "L", "XL"] },
      },
    },
    workflow: {
      maxActiveIssues: 1,
      branchPattern: "issue/{number}-{slug}",
      issueReference: "Refs #{number}",
      approvalPhrases: {
        issueCreation: "Approved",
        production: "Approved",
        completion: "Approved",
        nativeCandidate: "Approved",
      },
      pmTesting: {
        required: true,
        terms: ["Project Manager QA", "PM Testing"],
        requiredSections: [
          "target",
          "prerequisites",
          "numbered actions",
          "expected results",
          "regression checks",
        ],
      },
    },
    quality: {
      commands: ["npm run check"],
      requiredChecks: ["Quality / verify"],
    },
    release: {
      strategy: "direct-production",
      candidateIdentity: ["sourceCommit", "gitTree", "deploymentId"],
      environments: [
        {
          name: "Production",
          role: "production",
          url: "https://example.test",
          buildCommand: "npm run build",
          deployCommand: "npm run deploy",
          verifyCommand: "npm run verify:live",
          approvalPhrase: "Approved",
          promoteWithoutRebuild: false,
        },
      ],
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipeliner-adopt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  await mkdir(path.join(sourceRoot, ".agents", "skills", "pipeliner-work-issue"), {
    recursive: true,
  });
  await mkdir(path.join(sourceRoot, ".claude", "skills", "pipeliner-work-issue"), {
    recursive: true,
  });
  await mkdir(path.join(sourceRoot, "scripts"), { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "AGENTS.md"), "canonical policy\n");
  await writeFile(path.join(sourceRoot, "CLAUDE.md"), "@AGENTS.md\n");
  await writeFile(path.join(sourceRoot, "GEMINI.md"), "@./AGENTS.md\n");
  await writeFile(path.join(sourceRoot, "scripts", "validate-repository.mjs"), "validator\n");
  await writeFile(
    path.join(sourceRoot, ".agents", "skills", "pipeliner-work-issue", "SKILL.md"),
    "canonical skill\n",
  );
  await writeFile(
    path.join(sourceRoot, ".claude", "skills", "pipeliner-work-issue", "SKILL.md"),
    "adapter\n",
  );
  return { sourceRoot, targetRoot };
}

test("validateProfile accepts a complete supported profile", () => {
  const profile = validProfile();
  assert.equal(validateProfile(profile), profile);
});

test('adoption requires the official approval word without rewriting legacy evidence', async (t) => {
  const roots = await fixture(t);
  for (const phrase of ['Beta approved', 'approved', 'Approved ', 'Approved to complete Issue #{number}']) {
    const profile = validProfile();
    profile.workflow.approvalPhrases.completion = phrase;
    assert.equal(validateProfile(profile), profile); // Legacy profiles remain readable.
    await assert.rejects(planAdoption({ ...roots, profile }), /exactly Approved/);
    assert.equal(profile.workflow.approvalPhrases.completion, phrase);
  }
  const profile = validProfile();
  profile.release.environments[0].approvalPhrase = 'Deploy approved';
  await assert.rejects(planAdoption({ ...roots, profile }), /exactly Approved/);
});

test("validateProfile rejects a missing repository identity", () => {
  const profile = validProfile();
  profile.repository.owner = "";
  assert.throws(() => validateProfile(profile), /repository\.owner must be a non-empty string/);
});

test("validateProfile rejects an inconsistent immutable promotion", () => {
  const profile = validProfile();
  profile.release.strategy = "immutable-promotion";
  profile.release.environments[0].promoteWithoutRebuild = false;
  assert.throws(() => validateProfile(profile), /immutable-promotion.*promoteWithoutRebuild/s);
});

test("planAdoption creates canonical files and the supplied profile", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  const profile = validProfile();
  const plan = await planAdoption({ sourceRoot, targetRoot, profile });

  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(
    plan.create.map((entry) => entry.relativePath),
    [
      ".agents/skills/pipeliner-work-issue/SKILL.md",
      ".claude/skills/pipeliner-work-issue/SKILL.md",
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      "pipeliner.config.json",
      "scripts/validate-repository.mjs",
    ],
  );
});

test("planAdoption skips identical files and refuses differing collisions", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  const profile = validProfile();
  await writeFile(path.join(targetRoot, "AGENTS.md"), "canonical policy\n");
  await writeFile(path.join(targetRoot, "CLAUDE.md"), "custom policy\n");

  const plan = await planAdoption({ sourceRoot, targetRoot, profile });

  assert.deepEqual(plan.identical.map((entry) => entry.relativePath), ["AGENTS.md"]);
  assert.deepEqual(plan.conflicts.map((entry) => entry.relativePath), ["CLAUDE.md"]);
});

test("applyAdoptionPlan writes planned files and never overwrites conflicts", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  const profile = validProfile();
  await writeFile(path.join(targetRoot, "CLAUDE.md"), "keep me\n");
  const conflicted = await planAdoption({ sourceRoot, targetRoot, profile });

  await assert.rejects(() => applyAdoptionPlan(conflicted), /refusing to overwrite/);
  assert.equal(await readFile(path.join(targetRoot, "CLAUDE.md"), "utf8"), "keep me\n");

  await writeFile(path.join(targetRoot, "CLAUDE.md"), "@AGENTS.md\n");
  const safe = await planAdoption({ sourceRoot, targetRoot, profile });
  const result = await applyAdoptionPlan(safe);

  assert.equal(result.created, safe.create.length);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(targetRoot, "pipeliner.config.json"), "utf8")),
    profile,
  );
});

test('reviewed reconciliation preserves custom bytes, repeats safely, and expires on drift', async t => {
  const roots = await fixture(t);
  const profile = validProfile();
  const custom = 'canonical policy\nStronger target requirement\n';
  await writeFile(path.join(roots.targetRoot, 'AGENTS.md'), custom);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const reconciliation = { version: 1, files: { 'AGENTS.md': {
    sourceSha256: hash('canonical policy\n'), targetSha256: hash(custom), rationale: 'Merged canonical policy while preserving stronger requirement.' } } };
  const plan = await planAdoption({ ...roots, profile, reconciliation });
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.reconciled.length, 1);
  await applyAdoptionPlan(plan);
  assert.equal(await readFile(path.join(roots.targetRoot, 'AGENTS.md'), 'utf8'), custom);
  assert.equal((await planAdoption({ ...roots, profile, reconciliation })).create.length, 0);
  await writeFile(path.join(roots.targetRoot, 'AGENTS.md'), custom + 'drift');
  await assert.rejects(applyAdoptionPlan(plan), /changed after planning/);
  assert.equal((await planAdoption({ ...roots, profile, reconciliation })).conflicts.length, 1);
});

test('adoption refuses a symlink destination before creating files', async t => {
  const roots = await fixture(t);
  const outside = path.join(roots.sourceRoot, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(roots.targetRoot, '.agents'));
  await assert.rejects(planAdoption({ ...roots, profile: validProfile() }), /symlink/);
});
