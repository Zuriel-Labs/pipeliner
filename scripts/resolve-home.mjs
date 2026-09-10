#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolveHome } from './lib/home.mjs';
try {
  if (process.argv.length > 2) throw new Error('Usage: node scripts/resolve-home.mjs (uses this installed script, not cwd)');
  console.log(JSON.stringify(await resolveHome(fileURLToPath(import.meta.url)), null, 2));
} catch { console.error('Pipeliner home could not be verified. Resolve missing/conflicting Git root, AGENTS.md, profile or origin identity before work.'); process.exitCode = 1; }
