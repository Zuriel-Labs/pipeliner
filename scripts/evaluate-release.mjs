#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadProfile } from './lib/config.mjs';
import { evaluatePhase } from './lib/release-cycle.mjs';
try {
  const [config, evidence, ...extra] = process.argv.slice(2);
  if (!config || !evidence || extra.length) throw new Error('Usage: node scripts/evaluate-release.mjs <profile.json> <evidence.json>');
  const result = evaluatePhase(await loadProfile(config), JSON.parse(await readFile(evidence, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== 'ready') process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
