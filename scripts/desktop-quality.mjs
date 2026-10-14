import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.slice(2).some(value => value !== '--probe') || process.env.NODE_OPTIONS) throw Error('test-quality-startup-unqualified');
const { bootstrap, run } = createRequire(import.meta.url)('./desktop-test-process.cjs').activate();
const child = spawn(process.argv.includes('--probe') ? process.execPath : '/bin/sh',
  process.argv.includes('--probe') ? [join(root, 'scripts/desktop-test-process-probe.cjs')] : ['-c', 'npm run check'],
  { cwd: root, env: { ...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(bootstrap),
    NODE_COMPILE_CACHE: join(run, 'tmp', 'node-compile-cache'), npm_config_cache: join(run, 'tmp', 'npm-cache'),
    npm_config_logs_dir: join(run, 'logs', 'npm') }, stdio: 'inherit' });
process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
