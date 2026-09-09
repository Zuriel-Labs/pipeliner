import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareProjectSnapshot,
  isPinnedActionReference,
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
  assert.deepEqual(compareProjectSnapshot(blueprint, snapshot), []);

  snapshot.workflows.find((workflow) => workflow.name === "Pull request merged").enabled = true;
  snapshot.repositories = [];
  const errors = compareProjectSnapshot(blueprint, snapshot);
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
  assert.ok(errors.some((error) => error.includes("CLAUDE.md must contain only @AGENTS.md")));
  assert.ok(errors.some((error) => error.includes("color-scheme: dark")));
  assert.ok(errors.some((error) => error.includes("frontmatter name")));
  assert.ok(errors.some((error) => error.includes("canonical skill")));
});
