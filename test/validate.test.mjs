import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareProjectSnapshot,
  isPinnedActionReference,
  validateAdoptionContract,
  validateProjectBlueprint,
  validateRepository,
} from "../scripts/lib/validation.mjs";

function validBlueprint() {
  return {
    version: 1,
    workingExample: {
      owner: "Example-Org",
      number: 0,
      title: "Example",
      url: "",
      visibility: "PUBLIC",
      repository: "Example-Org/example",
    },
    fields: [
      { name: "Status", kind: "single-select", options: ["Backlog", "On Hold", "In Progress", "In Review", "Done"] },
      { name: "Priority", kind: "single-select", options: ["P0", "P1", "P2", "P3"] },
      { name: "Impact", kind: "single-select", options: ["High", "Medium", "Low"] },
      { name: "Effort", kind: "single-select", options: ["XS", "S", "M", "L", "XL"] },
    ],
    views: [
      { name: "Backlog", layout: "BOARD_LAYOUT", purpose: "Available work" },
      { name: "Kanban", layout: "BOARD_LAYOUT", purpose: "Lifecycle" },
    ],
    workflows: [
      { name: "Auto-add sub-issues to project", enabled: true },
      { name: "Auto-close issue", enabled: true },
      { name: "Item added to project", enabled: true },
      { name: "Item closed", enabled: true },
      { name: "Pull request linked to issue", enabled: true },
      { name: "Pull request merged", enabled: false, reason: "Merge is not completion" },
    ],
    automationLimits: ["Discover identifiers at runtime"],
  };
}

test("validateProjectBlueprint accepts the required lifecycle contract", () => {
  const blueprint = validBlueprint();
  assert.equal(validateProjectBlueprint(blueprint), blueprint);
});

test("validateProjectBlueprint rejects merge-driven completion", () => {
  const blueprint = validBlueprint();
  blueprint.workflows.find((workflow) => workflow.name === "Pull request merged").enabled = true;
  assert.throws(() => validateProjectBlueprint(blueprint), /Pull request merged.*disabled/s);
});

test("action references require a full commit SHA", () => {
  assert.equal(
    isPinnedActionReference("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"),
    true,
  );
  assert.equal(isPinnedActionReference("actions/checkout@v6"), false);
  assert.equal(isPinnedActionReference("owner/action@main"), false);
});

test("autonomous adoption requires an explicit target before mutation", () => {
  const errors = validateAdoptionContract({
    agents: "Install Pipeliner when requested.",
    adoptionSkill: "Inspect the repository and apply the files.",
  });

  assert.ok(errors.some((error) => error.includes("target repository location")));
  assert.ok(errors.some((error) => error.includes("wait before target or Project mutation")));
  assert.ok(errors.some((error) => error.includes("complete autonomous adoption workflow")));
});

test("autonomous adoption accepts the complete target and ownership contract", () => {
  assert.deepEqual(
    validateAdoptionContract({
      agents:
        "Target repository location is required. If omitted, ask one concise question and wait before target or Project mutation.",
      adoptionSkill:
        "Own the complete autonomous adoption workflow: resolve identity, create the profile, dry-run, reconcile conflicts, align the GitHub Project, validate, read back, perform agent testing, remediate findings, and rerun affected checks. No PM Testing is required for adoption or updates.",
    }),
    [],
  );
});

test("adoption rejects the obsolete PM handoff without agent remediation", () => {
  const errors = validateAdoptionContract({
    agents: "Target repository location is required. If omitted, ask one concise question and wait before target or Project mutation.",
    adoptionSkill: "Own the complete autonomous adoption workflow: resolve identity, create the profile, dry-run, reconcile conflicts, align the GitHub Project, validate, read back, and provide PM Testing steps.",
  });
  assert.ok(errors.some(error => error.includes("complete autonomous adoption workflow")));
});

test("README gives an agent a target-driven adoption entrypoint", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /^## Agent quick start$/m);
  assert.match(readme, /TARGET_REPOSITORY_LOCATION/);
  assert.match(readme, /absolute local checkout path/);
  assert.match(readme, /`OWNER\/REPO`/);
  assert.match(readme, /waits before making any target repository or GitHub Project mutation/);
  assert.match(readme, /What the agent owns after the target is known/);
});

test("compareProjectSnapshot reports exact live drift", () => {
  const blueprint = validBlueprint();
  const snapshot = {
    title: "Example",
    public: true,
    repositories: ["Example-Org/example"],
    fields: blueprint.fields.map(({ name, options }) => ({ name, options })),
    views: blueprint.views.map(({ name, layout }) => ({ name, layout })),
    workflows: blueprint.workflows.map(({ name, enabled }) => ({ name, enabled })),
  };
  const profile = {
    version: 1,
    repository: { owner: 'Example-Org', name: 'example', defaultBranch: 'main', projectManager: 'pm' },
    project: { owner: 'Example-Org', number: 1, title: 'Example', visibility: 'PUBLIC', statusField: 'Status', statuses: { backlog: 'Backlog', onHold: 'On Hold', inProgress: 'In Progress', inReview: 'In Review', done: 'Done' }, metadataFields: Object.fromEntries(blueprint.fields.slice(1).map(field => [field.name.toLowerCase(), field])) },
    workflow: { maxActiveIssues: 1, branchPattern: 'issue/{number}', issueReference: 'Refs #{number}', approvalPhrases: { issueCreation: 'create', production: 'release', completion: 'complete', nativeCandidate: 'beta' }, pmTesting: { required: true, terms: ['Project Manager QA', 'PM Testing'], requiredSections: ['target', 'setup', 'actions', 'results', 'regressions'] } },
    quality: { commands: ['test'], requiredChecks: [] }, release: { strategy: 'none', candidateIdentity: ['sourceCommit', 'gitTree'], environments: [] },
  };
  assert.deepEqual(compareProjectSnapshot(blueprint, snapshot, profile), []);

  snapshot.workflows.find((workflow) => workflow.name === "Pull request merged").enabled = true;
  snapshot.repositories = [];
  const errors = compareProjectSnapshot(blueprint, snapshot, profile);
  assert.ok(errors.some((error) => error.includes("repository link")));
  assert.ok(errors.some((error) => error.includes("Pull request merged")));
});

test("validateRepository accepts canonical skills and regular-file adapters", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipeliner-validate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".agents", "skills", "example-skill", "agents"), { recursive: true });
  await mkdir(path.join(root, ".claude", "skills", "example-skill"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "PM Testing\nExactly one Issue may be active\n");
  await writeFile(path.join(root, "CLAUDE.md"), "@AGENTS.md\n");
  await writeFile(path.join(root, "GEMINI.md"), "@./AGENTS.md\n");
  await writeFile(
    path.join(root, ".agents", "pipeliner-policy.html"),
    '<style>:root { color-scheme: dark; }</style><p>PM Testing</p>',
  );
  await writeFile(
    path.join(root, ".agents", "skills", "example-skill", "SKILL.md"),
    "---\nname: example-skill\ndescription: Perform one example workflow when requested.\n---\n\n# Example\n",
  );
  await writeFile(
    path.join(root, ".agents", "skills", "example-skill", "agents", "openai.yaml"),
    'interface:\n  display_name: "Example"\n  short_description: "Run the example workflow"\n  default_prompt: "Use $example-skill for this request."\n',
  );
  await writeFile(
    path.join(root, ".claude", "skills", "example-skill", "SKILL.md"),
    "---\nname: example-skill\ndescription: Use the canonical example workflow.\n---\n\nFollow [the canonical skill](../../../.agents/skills/example-skill/SKILL.md).\n",
  );

  assert.deepEqual(await validateRepository(root, { requireConfig: false }), []);
  await writeFile(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n\nPreserve a stronger provider requirement.\n');
  await writeFile(path.join(root, 'GEMINI.md'), '@./AGENTS.md\n\nPreserve another provider requirement.\n');
  assert.deepEqual(await validateRepository(root, { requireConfig: false }), []);
});

test("validateRepository reports copied policy and unsafe provider drift", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipeliner-validate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".agents", "skills", "example-skill", "agents"), { recursive: true });
  await mkdir(path.join(root, ".claude", "skills", "example-skill"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "PM Testing\nExactly one Issue may be active\n");
  await writeFile(path.join(root, "CLAUDE.md"), "duplicated policy\n");
  await writeFile(path.join(root, "GEMINI.md"), "@./AGENTS.md\n");
  await writeFile(path.join(root, ".agents", "pipeliner-policy.html"), "light policy");
  await writeFile(
    path.join(root, ".agents", "skills", "example-skill", "SKILL.md"),
    "---\nname: wrong-name\ndescription: Example.\n---\n",
  );
  await writeFile(
    path.join(root, ".agents", "skills", "example-skill", "agents", "openai.yaml"),
    "interface:\n  display_name: Example\n",
  );
  await writeFile(path.join(root, ".claude", "skills", "example-skill", "SKILL.md"), "copied policy\n");

  const errors = await validateRepository(root, { requireConfig: false });
  assert.ok(errors.some((error) => error.includes("CLAUDE.md must import @AGENTS.md")));
  assert.ok(errors.some((error) => error.includes("color-scheme: dark")));
  assert.ok(errors.some((error) => error.includes("frontmatter name")));
  assert.ok(errors.some((error) => error.includes("canonical skill")));
});
