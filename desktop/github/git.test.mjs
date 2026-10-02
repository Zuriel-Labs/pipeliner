import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialReply, repositoryCredentialReply, cloneRepository } from './git.mjs';
import { fixtures } from './access.mjs';

test('Git credentials require the exact HTTPS fixture and never answer other destinations', () => {
  const fixture = fixtures[1], token = 'ghu_synthetic_fixture';
  const input = `protocol=https\nhost=github.com\npath=${fixture.owner}/${fixture.name}.git\n\n`;
  assert.equal(credentialReply(input, token, fixture.id), `username=x-access-token\npassword=${token}\n\n`);
  for (const changed of [input.replace('https', 'http'), input.replace('github.com', 'github.com.evil.invalid'),
    input.replace(fixture.name, 'pipeliner'), input.replace('protocol=https', 'protocol=https\nprotocol=http'),
    input + 'password=unexpected\n', 'x'.repeat(1025)]) {
    assert.throws(() => credentialReply(changed, token, fixture.id), /git-credential-denied/);
  }
  assert.throws(() => credentialReply(input, 'ghp_unapproved', fixture.id), /git-credential-denied/);
  assert.throws(() => credentialReply(input, 'gho_synthetic_setup', fixture.id), /git-credential-denied/);
  assert.throws(() => credentialReply(input, token, 123), /git-credential-denied/);
});

test('system Git helper consumes a synthetic private pipe without a credential file or network', { skip: process.platform === 'win32' }, async () => {
  const fixture = fixtures[0], token = 'ghu_synthetic_fixture';
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const helper = `!${quote(process.execPath)} ${quote(fileURLToPath(new URL('./git.mjs', import.meta.url)))} --credential ${fixture.id}`;
  const child = spawn('/usr/bin/git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`,
    '-c', 'credential.useHttpPath=true', 'credential', 'fill'], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
  let output = '';
  child.stdout.on('data', part => { output += part; });
  child.stdio[3].on('error', () => {});
  child.stdio[3].end(token);
  child.stdin.end(`protocol=https\nhost=github.com\npath=${fixture.owner}/${fixture.name}.git\n\n`);
  const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(code, 0);
    assert.equal(output.includes(`password=${token}\n`), true);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); }
});
test('repository-bound helper consumes only its exact App credential destination', { skip: process.platform === 'win32' }, async () => {
  const repository = { owner: 'fixture', name: 'repo' }, token = 'ghu_synthetic_fixture';
  const input = 'protocol=https\nhost=github.com\npath=fixture/repo.git\n\n';
  assert.throws(() => repositoryCredentialReply(input.replace('repo.git', 'other.git'), token, repository), /git-credential-denied/);
  assert.throws(() => repositoryCredentialReply(input, 'gho_synthetic_setup', repository), /git-credential-denied/);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./git.mjs', import.meta.url)), '--repository-credential', repository.owner, repository.name, 'get'],
    { env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
  let output = ''; child.stdout.on('data', part => { output += part; }); child.stdio[3].on('error', () => {}); child.stdio[3].end(token); child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
  try { const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(code, 0); assert.equal(output, 'username=x-access-token\npassword=' + token + '\n\n');
  } finally { clearTimeout(timer); }
});
test('a failed host process record terminates its actual owned Git child before returning', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-clone-cleanup-'))); let pid, closed = false;
  try {
    await assert.rejects(cloneRepository('ghu_synthetic_fixture', { owner: 'fixture', name: 'repo' }, root, { onProcess: process => {
      if (process.state === 'started') { pid = process.pid; throw new Error('synthetic-process-record-failure'); }
      closed = process.state === 'closed';
    } }), /synthetic-process-record-failure/);
    assert.equal(Number.isSafeInteger(pid), true); assert.equal(closed, true);
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
