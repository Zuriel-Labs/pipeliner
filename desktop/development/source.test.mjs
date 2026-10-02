import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectWorkspace } from '../core/identity.mjs';
import { sourcePath, checkedFiles, sourceTree, snapshotWorkspace } from './source.mjs';

const file = (path, content, mode = '100644') => ({ path, mode, content: Buffer.from(content).toString('base64') });
test('source boundary rejects traversal, secrets, metadata, alternate encodings and mutable policy export', () => {
  for (const path of ['../outside', '/etc/passwd', 'src/../../outside', '.git/config', 'src/.git/config', '.env', '.ssh/id_rsa', 'x\\y', 'x\0y', 'bad//file', 'node_modules/package/index.js']) assert.equal(sourcePath(path), false, path);
  assert.equal(sourcePath('src/example.mjs'), true);
  assert.equal(sourcePath('pipeliner.config.json'), true);
  assert.equal(sourcePath('pipeliner.config.json', true), false);
  assert.equal(sourcePath('.github/workflows/test.yml', true), false);
  assert.throws(() => checkedFiles([file('x', 'one'), file('x', 'two')]), /duplicate/i);
  assert.throws(() => checkedFiles([{ ...file('x', 'one'), mode: '120000' }]), /regular/i);
  assert.throws(() => checkedFiles([{ ...file('x', 'one'), content: 'b25l\n' }]), /encoding/i);
});

test('immutable Git snapshot preserves local edits; computed nested tree matches actual Git objects', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-source-')));
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Pipeliner fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    git(['remote', 'add', 'origin', 'https://github.com/example/development-fixture.git']);
    writeFileSync(join(directory, 'app.mjs'), 'export const value = 1;\n'); writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(directory, 'folder')); writeFileSync(join(directory, 'folder', 'file.mjs'), 'a'); writeFileSync(join(directory, 'folder-file.mjs'), 'b'); chmodSync(join(directory, 'folder', 'file.mjs'), 0o755);
    git(['add', '--', 'app.mjs', 'package.json', 'folder/file.mjs', 'folder-file.mjs']); git(['commit', '-m', 'Fixture source']);
    writeFileSync(join(directory, 'app.mjs'), 'User edit must survive.\n'); writeFileSync(join(directory, 'notes.txt'), 'Untracked user note.\n');
    const before = git(['status', '--porcelain=v1']), identity = inspectWorkspace(directory, { repository: 'repo-fixture', owner: 'example', name: 'development-fixture' });
    const snapshot = snapshotWorkspace(identity);
    assert.equal(sourceTree(snapshot.files), git(['rev-parse', 'HEAD^{tree}']));
    assert.equal(Buffer.from(snapshot.files.find(file => file.path === 'app.mjs').content, 'base64').toString(), 'export const value = 1;\n');
    assert.ok(!snapshot.files.some(file => file.path === 'notes.txt'));
    assert.equal(git(['status', '--porcelain=v1']), before);
    assert.equal(snapshot.files.find(file => file.path === 'folder/file.mjs').mode, '100755');
  } finally { rmSync(directory, { recursive: true }); }
});
