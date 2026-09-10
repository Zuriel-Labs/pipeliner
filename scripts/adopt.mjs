#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from 'node:fs/promises';
import { requirePairedQA } from './lib/qa.mjs';
import { verifyRepository } from './lib/home.mjs';

import { applyAdoptionPlan, planAdoption } from "./lib/adoption.mjs";
import { loadProfile } from "./lib/config.mjs";

function usage() {
  return "Usage: node scripts/adopt.mjs --target <path> --config <path> [--source <path>] [--reconciliation <path>] [--dry-run]";
}

function parseArguments(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (["--target", "--config", "--source", "--reconciliation"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.target || !options.config) throw new Error(usage());
  return options;
}

function publicPlan(plan) {
  const paths = (items) => items.map((item) => item.relativePath);
  return {
    target: plan.targetRoot,
    create: paths(plan.create),
    identical: paths(plan.identical),
    reconciled: paths(plan.reconciled),
    conflicts: paths(plan.conflicts),
    questionConflicts: plan.questionConflicts,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sourceRoot = path.resolve(options.source ?? path.join(scriptDirectory, ".."));
  const targetRoot = path.resolve(options.target);
  const profile = await loadProfile(path.resolve(options.config));
  requirePairedQA(profile.qa);
  const reconciliation = options.reconciliation ? JSON.parse(await readFile(options.reconciliation, 'utf8')) : undefined;
  const plan = await planAdoption({ sourceRoot, targetRoot, profile, reconciliation });

  console.log(JSON.stringify(publicPlan(plan), null, 2));
  if (plan.questionConflicts.length > 0) {
    throw new Error('conflicting question instructions; reconcile authorized text, preserve unrelated instructions, and rerun the dry-run');
  }
  if (plan.conflicts.length > 0) {
    throw new Error("adoption has conflicts; reconcile them manually and run the dry-run again");
  }
  if (options.dryRun) return;

  // Dry-run can inspect a proposed destination. Writes require the actual target identity.
  await verifyRepository(targetRoot, profile);

  const result = await applyAdoptionPlan(plan);
  console.log(`Adoption complete: ${result.created} created, ${result.identical} already aligned.`);
}

main().catch((error) => {
  console.error(`pipeliner adoption failed: ${error.message}`);
  process.exitCode = 1;
});
