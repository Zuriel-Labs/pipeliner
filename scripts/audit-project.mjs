#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProfile } from './lib/config.mjs';
import { compareProjectSnapshot } from './lib/validation.mjs';
import { fetchProjectSnapshot } from './lib/project.mjs';

function ghJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`GitHub Project read failed: ${result.error?.message ?? (result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--config') throw new Error('Usage: node scripts/audit-project.mjs --config <absolute-config-path>');
  const profile = await loadProfile(path.resolve(argv[1]));
  if (profile.project.number === 0) throw new Error('project.number must identify a live Project');
  const blueprint = JSON.parse(await readFile(new URL('../blueprints/github-project.json', import.meta.url), 'utf8'));
  const result = await fetchProjectSnapshot(profile, ghJson);
  const errors = compareProjectSnapshot(blueprint, result.snapshot, profile);
  console.log(JSON.stringify({ ...result, visibilityPolicy: profile.project.visibility ?? 'observed; unchanged', errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Pipeliner Project audit failed: ${error.message}`);
  process.exitCode = 1;
});
