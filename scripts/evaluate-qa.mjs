#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadProfile } from './lib/config.mjs';
import { evaluateQA, requirePairedQA } from './lib/qa.mjs';

try {
  const [profilePath, evidencePath, ...extra] = process.argv.slice(2);
  if (!profilePath || !evidencePath || extra.length) throw new Error('Usage: node scripts/evaluate-qa.mjs <profile.json> <evidence.json>');
  const profile = await loadProfile(profilePath);
  requirePairedQA(profile.qa);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const result = evaluateQA(profile.qa, evidence.candidate, evidence.records, { currentTurn: evidence.currentTurn, scope: evidence.scope, issue: evidence.issue, cleanupResolutions: evidence.cleanupResolutions });
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== 'complete') process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
