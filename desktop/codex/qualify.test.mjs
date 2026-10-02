import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeRequest, brokerWriteMarker, isAllowedAuthUrl, isolatedEnv } from './qualify.mjs';

test('broker permits only the exact current synthetic operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipeliner-d03-broker-'));
  const context = { repo: 'synthetic/repo', issue: 19, run: 'synthetic-run', epoch: 3, markerPath: join(dir, 'marker') };
  const base = { repo: context.repo, issue: context.issue, run: context.run, epoch: context.epoch, operation: 'write-marker' };
  const protectedPath = join(dir, 'policy');
  await writeFile(protectedPath, 'pm-owned\n');
  try {
    for (const denied of [
      { ...base, repo: 'other/repo' },
      { ...base, issue: 20 },
      { ...base, run: 'stale-run' },
      { ...base, epoch: 2 },
      { ...base, operation: 'pm-apply' },
      { ...base, markerPath: protectedPath },
      null,
    ]) {
      assert.equal(authorizeRequest(denied, context), false);
      assert.deepEqual(await brokerWriteMarker(denied, context), { allowed: false });
    }
    assert.equal(await readFile(protectedPath, 'utf8'), 'pm-owned\n');
    assert.deepEqual(await brokerWriteMarker(base, context), { allowed: true });
    assert.equal(await readFile(context.markerPath, 'utf8'), 'worker-ok\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only expected HTTPS login destinations can open', () => {
  assert.equal(isAllowedAuthUrl('https://chatgpt.com/auth?state=synthetic'), true);
  assert.equal(isAllowedAuthUrl('https://auth.openai.com/codex/device'), true);
  assert.equal(isAllowedAuthUrl('http://chatgpt.com/auth'), false);
  assert.equal(isAllowedAuthUrl('https://chatgpt.com.evil.example/auth'), false);
  assert.equal(isAllowedAuthUrl('file:///tmp/auth'), false);
  assert.equal(isAllowedAuthUrl('https://user:password@chatgpt.com/auth'), false);
  assert.equal(isAllowedAuthUrl('https://chatgpt.com:8443/auth'), false);
});

test('provider child isolates Codex home while preserving macOS Keychain lookup', () => {
  const env = isolatedEnv('/tmp/synthetic-codex-home');
  assert.equal(env.CODEX_HOME, '/tmp/synthetic-codex-home');
  assert.equal(env.HOME, homedir());
  assert.notEqual(env.HOME, env.CODEX_HOME);
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(env, 'CODEX_ACCESS_TOKEN'), false);
});
