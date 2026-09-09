#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadProfile } from "./lib/config.mjs";
import { compareProjectSnapshot, validateProjectBlueprint } from "./lib/validation.mjs";

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") {
    throw new Error("Usage: node scripts/audit-project.mjs --config <absolute-config-path>");
  }
  return path.resolve(argv[1]);
}

function ghJson(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const configPath = parseArguments(process.argv.slice(2));
  const profile = await loadProfile(configPath);
  if (profile.project.number === 0) throw new Error("project.number must identify a live Project");
  if (!/^[A-Za-z0-9-]+$/.test(profile.project.owner)) throw new Error("project.owner is not a GitHub login");

  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const blueprintPath = path.resolve(scriptDirectory, "..", "blueprints", "github-project.json");
  const blueprint = validateProjectBlueprint(JSON.parse(await readFile(blueprintPath, "utf8")));
  const project = ghJson([
    "project",
    "view",
    String(profile.project.number),
    "--owner",
    profile.project.owner,
    "--format",
    "json",
  ]);
  const fieldResult = ghJson([
    "project",
    "field-list",
    String(profile.project.number),
    "--owner",
    profile.project.owner,
    "--limit",
    "100",
    "--format",
    "json",
  ]);
  const query = `query($owner:String!,$number:Int!){organization(login:$owner){projectV2(number:$number){repositories(first:100){nodes{nameWithOwner}} views(first:100){nodes{name layout}} workflows(first:100){nodes{name enabled}}}}}`;
  const details = ghJson([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${profile.project.owner}`,
    "-F",
    `number=${profile.project.number}`,
  ]).data.organization.projectV2;

  const snapshot = {
    title: project.title,
    public: project.public,
    repositories: details.repositories.nodes.map((repository) => repository.nameWithOwner),
    fields: fieldResult.fields.map((field) => ({
      name: field.name,
      options: (field.options ?? []).map((option) => option.name),
    })),
    views: details.views.nodes,
    workflows: details.workflows.nodes,
  };
  const errors = compareProjectSnapshot(blueprint, snapshot);
  console.log(JSON.stringify({ project: project.url, snapshot, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Pipeliner Project audit failed: ${error.message}`);
  process.exitCode = 1;
});
