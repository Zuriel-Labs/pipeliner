import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { credentialReply } from './git.mjs';
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
