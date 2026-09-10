import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { validateProfile } from "./config.mjs";
import { auditCI } from './ci.mjs';
import { validateQA } from './qa.mjs';

const REQUIRED_FIELDS = new Map([
  ["Status", ["Backlog", "On Hold", "In Progress", "In Review", "Done"]],
  ["Priority", ["P0", "P1", "P2", "P3"]],
  ["Impact", ["High", "Medium", "Low"]],
  ["Effort", ["XS", "S", "M", "L", "XL"]],
]);

const REQUIRED_WORKFLOWS = new Map([
  ["Auto-add sub-issues to project", true],
  ["Auto-close issue", true],
  ["Item added to project", true],
  ["Item closed", true],
  ["Pull request linked to issue", true],
  ["Pull request merged", false],
]);

async function readText(filePath, errors, label = filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    errors.push(`missing or unreadable ${label}: ${error.message}`);
    return "";
  }
}

const REQUIRED_SKILLS = ['adopt', 'audit-backlog', 'close-issue', 'create-issue', 'maintain', 'monitor-updates', 'pipeline-health', 'release-candidate', 'release-production', 'review-issue', 'update', 'work-issue'].map(name => `pipeliner-${name}`);

// Detect known superseded directives after reconciliation, not arbitrary natural-language semantics.
export function validateOperationalText(text) {
  const errors = [];
  if (/prefer[^.\n]*native question|use permitted native app questions|questions use native controls|ask focused questions through[^.\n]*native question/i.test(text)) errors.push('superseded native-question directive; use message-only questions');
  if (/retest from the first turn|restart (?:QA )?from the first turn/i.test(text)) errors.push('superseded fixed QA restart; finish current pair then circulate');
  return errors;
}

async function validateLocalLinks(root, files) {
  const errors = [];
  for (const file of files.filter(file => /\.(md|html)$/.test(file))) {
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch { errors.push(`unreadable reference source: ${path.relative(root, file)}`); continue; }
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/href="([^"]+)"/g)];
    for (const match of links) {
      const link = match[1].split('#')[0];
      if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      const target = path.resolve(path.dirname(file), link);
      try {
        if (!target.startsWith(root + path.sep) || !(await lstat(target)).isFile()) throw new Error('missing or unsafe target');
      } catch {
        errors.push(`${path.relative(root, file)} has broken local reference: ${match[1]}`);
      }
    }
  }
  return errors;
}

function sameValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1 || /^\s/.test(line)) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

async function directoryNames(directoryPath, errors, label) {
  try {
    return (await readdir(directoryPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    errors.push(`missing or unreadable ${label}: ${error.message}`);
    return [];
  }
}

async function walkFiles(directoryPath) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

export function isPinnedActionReference(reference) {
  const separator = reference.lastIndexOf("@");
  if (separator < 1) return false;
  return /^[a-f0-9]{40}$/i.test(reference.slice(separator + 1));
}

export function validateAdoptionContract({ agents = "", adoptionSkill = "" } = {}) {
  const errors = [];
  if (!/target repository location is required/i.test(agents)) {
    errors.push("AGENTS.md must state that the target repository location is required");
  }
  if (!/ask one concise question[\s\S]*wait before target or Project mutation/i.test(agents)) {
    errors.push("AGENTS.md must require the agent to ask once and wait before target or Project mutation");
  }

  const adoptionSteps = [
    "resolve identity",
    "create the profile",
    "dry-run",
    "reconcile conflicts",
    "align the GitHub Project",
    "validate",
    "read back",
    "agent testing",
    "remediate findings",
    "rerun affected checks",
    "No PM Testing is required for adoption or updates",
  ];
  const ownsWorkflow = /complete autonomous adoption workflow/i.test(adoptionSkill);
  if (!ownsWorkflow || adoptionSteps.some((step) => !adoptionSkill.includes(step))) {
    errors.push("pipeliner-adopt must define the complete autonomous adoption workflow");
  }
  return errors;
}

export function validateProjectBlueprint(blueprint) {
  if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) {
    throw new Error("Project blueprint must be an object");
  }
  if (blueprint.version !== 1) throw new Error("Project blueprint version must equal 1");
  if (blueprint.workingExample?.visibility !== "PUBLIC") {
    throw new Error("Project working example must be PUBLIC");
  }
  if (!Number.isInteger(blueprint.workingExample?.number) || blueprint.workingExample.number < 0) {
    throw new Error("Project working example number must be a non-negative integer");
  }

  const fields = new Map((blueprint.fields ?? []).map((field) => [field.name, field]));
  for (const [name, options] of REQUIRED_FIELDS) {
    const field = fields.get(name);
    if (!field || field.kind !== "single-select" || !sameValues(field.options ?? [], options)) {
      throw new Error(`Project field ${name} must have options ${options.join(", ")}`);
    }
  }

  const views = new Map((blueprint.views ?? []).map((view) => [view.name, view]));
  for (const name of ["Backlog", "Kanban"]) {
    if (views.get(name)?.layout !== "BOARD_LAYOUT") {
      throw new Error(`Project view ${name} must use BOARD_LAYOUT`);
    }
  }

  const workflows = new Map((blueprint.workflows ?? []).map((workflow) => [workflow.name, workflow]));
  for (const [name, enabled] of REQUIRED_WORKFLOWS) {
    if (!workflows.has(name) || workflows.get(name).enabled !== enabled) {
      throw new Error(`Project workflow ${name} must be ${enabled ? "enabled" : "disabled"}`);
    }
  }
  if (!Array.isArray(blueprint.automationLimits) || blueprint.automationLimits.length === 0) {
    throw new Error("Project blueprint must document automationLimits");
  }
  return blueprint;
}

export function compareProjectSnapshot(blueprint, snapshot, profile) {
  validateProjectBlueprint(blueprint);
  validateProfile(profile);
  const errors = [];
  if (snapshot.title !== profile.project.title) {
    errors.push(`title mismatch: expected ${profile.project.title}; found ${snapshot.title}`);
  }
  if (profile.project.visibility !== undefined && snapshot.public !== (profile.project.visibility === 'PUBLIC')) {
    errors.push(`visibility mismatch: expected ${profile.project.visibility}`);
  }
  const repository = `${profile.repository.owner}/${profile.repository.name}`;
  if (!snapshot.repositories.some(name => name.toLowerCase() === repository.toLowerCase())) {
    errors.push(`repository link missing: ${repository}`);
  }

  const fields = new Map(snapshot.fields.map((field) => [field.name, field]));
  const expectedFields = [{ name: profile.project.statusField, options: ['backlog', 'onHold', 'inProgress', 'inReview', 'done'].map(key => profile.project.statuses[key]) }, ...Object.values(profile.project.metadataFields)];
  for (const expected of expectedFields) {
    const actual = fields.get(expected.name);
    if (!actual) errors.push(`field missing: ${expected.name}`);
    else if (!sameValues(actual.options ?? [], expected.options)) {
      errors.push(`field options mismatch for ${expected.name}`);
    }
  }
  const views = new Map(snapshot.views.map((view) => [view.name, view]));
  for (const expected of blueprint.views) {
    const actual = views.get(expected.name);
    if (!actual) errors.push(`view missing: ${expected.name}`);
    else if (actual.layout !== expected.layout) errors.push(`view layout mismatch for ${expected.name}`);
  }
  const workflows = new Map(snapshot.workflows.map((workflow) => [workflow.name, workflow]));
  for (const expected of blueprint.workflows) {
    const actual = workflows.get(expected.name);
    if (!actual) errors.push(`workflow missing: ${expected.name}`);
    else if (actual.enabled !== expected.enabled) {
      errors.push(`workflow state mismatch for ${expected.name}: expected ${expected.enabled}`);
    }
  }
  return errors;
}

export async function validateRepository(rootPath, { requireConfig = true } = {}) {
  const root = path.resolve(rootPath);
  const errors = [];
  const agents = await readText(path.join(root, "AGENTS.md"), errors, "AGENTS.md");
  const claude = await readText(path.join(root, "CLAUDE.md"), errors, "CLAUDE.md");
  const gemini = await readText(path.join(root, "GEMINI.md"), errors, "GEMINI.md");
  const policy = await readText(
    path.join(root, ".agents", "pipeliner-policy.html"),
    errors,
    ".agents/pipeliner-policy.html",
  );

  if (!/^@AGENTS\.md\s*$/m.test(claude)) errors.push("CLAUDE.md must import @AGENTS.md");
  if (!/^@\.\/AGENTS\.md\s*$/m.test(gemini)) errors.push("GEMINI.md must import @./AGENTS.md");
  if (!agents.includes("PM Testing")) errors.push("AGENTS.md must contain PM Testing");
  if (!agents.includes("Exactly one Issue may be active")) {
    errors.push("AGENTS.md must define the one-active-Issue invariant");
  }
  if (!policy.includes("color-scheme: dark")) {
    errors.push(".agents/pipeliner-policy.html must contain color-scheme: dark");
  }
  if (!policy.includes("PM Testing")) errors.push("pipeline policy must contain PM Testing");

  if (requireConfig) {
    const profileContent = await readText(path.join(root, "pipeliner.config.json"), errors, "pipeliner.config.json");
    if (profileContent) {
      try {
        validateProfile(JSON.parse(profileContent));
      } catch (error) {
        errors.push(`invalid pipeliner.config.json: ${error.message}`);
      }
    }
    const blueprintContent = await readText(
      path.join(root, "blueprints", "github-project.json"),
      errors,
      "blueprints/github-project.json",
    );
    if (blueprintContent) {
      try {
        validateProjectBlueprint(JSON.parse(blueprintContent));
      } catch (error) {
        errors.push(`invalid blueprints/github-project.json: ${error.message}`);
      }
    }
    for (const examplePath of await walkFiles(path.join(root, "blueprints", "profiles"))) {
      if (!examplePath.endsWith(".json")) continue;
      try {
        validateProfile(JSON.parse(await readFile(examplePath, "utf8")));
      } catch (error) {
        errors.push(`invalid ${path.relative(root, examplePath)}: ${error.message}`);
      }
    }
  }

  for (const examplePath of await walkFiles(path.join(root, 'blueprints', 'qa'))) {
    if (!examplePath.endsWith('.json')) continue;
    try { validateQA(JSON.parse(await readFile(examplePath, 'utf8'))); }
    catch (error) { errors.push(`invalid ${path.relative(root, examplePath)}: ${error.message}`); }
  }

  const skillsRoot = path.join(root, ".agents", "skills");
  const adapterRoot = path.join(root, ".claude", "skills");
  const skillNames = await directoryNames(skillsRoot, errors, ".agents/skills");
  const adapterNames = await directoryNames(adapterRoot, errors, ".claude/skills");
  if (skillNames.length === 0) errors.push("at least one canonical skill is required");
  if (!sameValues(adapterNames, skillNames)) errors.push("Claude adapter registry must match canonical skills");

  let adoptionSkill = "";
  for (const name of skillNames) {
    const skillRelative = `.agents/skills/${name}/SKILL.md`;
    const skill = await readText(path.join(root, skillRelative), errors, skillRelative);
    if (name === "pipeliner-adopt") adoptionSkill = skill;
    const frontmatter = parseFrontmatter(skill);
    if (!frontmatter) errors.push(`${skillRelative} has invalid frontmatter`);
    else {
      if (frontmatter.name !== name) errors.push(`${skillRelative} frontmatter name must equal ${name}`);
      if (!frontmatter.description) errors.push(`${skillRelative} frontmatter description is required`);
    }

    const metadataRelative = `.agents/skills/${name}/agents/openai.yaml`;
    const metadata = await readText(path.join(root, metadataRelative), errors, metadataRelative);
    for (const field of ["display_name:", "short_description:", "default_prompt:"]) {
      if (!metadata.includes(field)) errors.push(`${metadataRelative} must contain ${field}`);
    }

    const adapterRelative = `.claude/skills/${name}/SKILL.md`;
    const adapterPath = path.join(root, adapterRelative);
    const adapter = await readText(adapterPath, errors, adapterRelative);
    try {
      if ((await lstat(adapterPath)).isSymbolicLink()) errors.push(`${adapterRelative} must be a regular file`);
    } catch {
      // readText already recorded the missing file.
    }
    const adapterFrontmatter = parseFrontmatter(adapter);
    if (!adapterFrontmatter || adapterFrontmatter.name !== name) {
      errors.push(`${adapterRelative} frontmatter name must equal ${name}`);
    }
    const canonicalTarget = `../../../.agents/skills/${name}/SKILL.md`;
    if (!adapter.includes(canonicalTarget)) errors.push(`${adapterRelative} must link to the canonical skill`);
  }

  if (requireConfig) {
    for (const name of REQUIRED_SKILLS) if (!skillNames.includes(name)) errors.push(`canonical ${name} skill is required`);
    errors.push(...validateAdoptionContract({ agents, adoptionSkill }));
    errors.push(...await validateLocalLinks(root, [path.join(root, 'AGENTS.md'), ...await walkFiles(skillsRoot), ...await walkFiles(adapterRoot)]));
    for (const file of [path.join(root, 'AGENTS.md'), path.join(root, '.agents/pipeliner-policy.html'), ...await walkFiles(skillsRoot)]) {
      if (!/\.(md|html)$/.test(file)) continue;
      for (const error of validateOperationalText(await readFile(file, 'utf8'))) errors.push(`${path.relative(root, file)}: ${error}`);
    }
  }

  for (const managedText of [agents, policy]) {
    if (/\bhuman QA\b/i.test(managedText)) {
      errors.push("managed policy must use Project Manager QA or PM Testing instead of human QA");
    }
    if (/\/Users\/[^/\s]+\/|\b[A-Za-z]:\\Users\\/i.test(managedText)) {
      errors.push("managed policy must not contain user-specific absolute paths");
    }
  }

  const workflows = await walkFiles(path.join(root, ".github", "workflows"));
  for (const workflowPath of workflows.filter((filePath) => /\.ya?ml$/.test(filePath))) {
    const workflow = await readFile(workflowPath, "utf8");
    for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)) {
      const reference = match[1];
      if (!reference.startsWith("./") && !isPinnedActionReference(reference)) {
        errors.push(`${path.relative(root, workflowPath)} has unpinned action ${reference}`);
      }
    }
  }

  errors.push(...await auditCI(root));
  return [...new Set(errors)];
}
