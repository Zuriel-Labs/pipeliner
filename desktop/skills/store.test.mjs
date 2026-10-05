import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSkillStore, skillManifestHash } from './store.mjs';
import { skillPackage } from './package.mjs';
import { starterSkills } from '../development/starter.mjs';

const pack = (commit = 'a', body = 'Use scoped evidence.') => skillPackage({ source: { repository: 'fixture/skills', commit: commit.repeat(40), path: 'beacon' },
  files: [{ path: 'SKILL.md', content: '---\nname: beacon\ndescription: Review scoped work\nlicense: MIT\n---\n' + body }, { path: 'LICENSE', content: 'MIT License\nSynthetic fixture.' }] });
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-skills-'))); chmodSync(root, 0o700); const store = openSkillStore(root);
  return { root, store, close() { store.close(); rmSync(root, { recursive: true, force: true }); } }; }
const view = (extensions = [], disabled = []) => ({ values: { 'skills.bundledEnabled': { value: true }, 'skills.extensions': { value: extensions }, 'skills.disabled': { value: disabled } } });

test('atomic installation reads back exact pins, preserves old versions and rejects name substitution', () => {
  const f = fixture(); try {
    const first = f.store.install(pack(), 0); assert.equal(f.store.revision(), 1); assert.equal(f.store.get(first.id).digest, pack().digest);
    assert.equal(statSync(join(f.root, 'skills.sqlite')).mode & 0o777, 0o600);
    const captured = f.store.capture(view([first.id])); assert.equal(skillManifestHash(captured.manifest), captured.hash);
    const second = f.store.install(pack('b', 'Updated future instructions.'), 1); assert.notEqual(second.id, first.id);
    assert.equal(f.store.get(first.id).instructions, 'Use scoped evidence.'); assert.equal(f.store.list().find(item => item.name === 'beacon').id, second.id);
    assert.throws(() => f.store.install(pack('c'), 1), /changed/);
    const unrelated = pack(); assert.throws(() => f.store.install({ ...unrelated, source: { ...unrelated.source, repository: 'other/skills' } }, 2), /verified|collision/);
    assert.throws(() => f.store.install({ ...pack(), permissions: ['worker.exec'] }, 2), /verified/);
    assert.equal(f.store.revision(), 2);
    f.store.close(); const reopened = openSkillStore(f.root); try { assert.equal(reopened.get(first.id).digest, first.digest); assert.equal(reopened.revision(), 2); } finally { reopened.close(); }
  } finally { f.close(); }
});

test('captured selection cannot silently update, invoke a disabled pin or load removed content', () => {
  const f = fixture(); try {
    const first = f.store.install(pack(), 0), capture = f.store.capture(view([first.id]));
    const authority = { bundledSkills: true, extensions: [first.id], deniedExtensions: [] };
    assert.match(f.store.prompt(capture.manifest, capture.hash, authority), /Use scoped evidence/);
    f.store.install(pack('b', 'New future body.'), 1);
    assert.doesNotMatch(f.store.prompt(capture.manifest, capture.hash, authority), /New future body/);
    assert.throws(() => f.store.prompt(capture.manifest, capture.hash, { ...authority, extensions: [] }), /revoked/);
    assert.throws(() => f.store.prompt(capture.manifest, capture.hash, { ...authority, deniedExtensions: [starterSkills[1].id] }), /revoked/);
    assert.equal(f.store.capture(view([], [starterSkills[1].id])).manifest.some(item => item.id === starterSkills[1].id), false);
    assert.throws(() => f.store.capture(view([], starterSkills.map(item => item.id))), /Selected skill set is empty.*Enable/);
    f.store.remove('beacon', 2); assert.equal(f.store.list().some(item => item.name === 'beacon'), false);
    assert.throws(() => f.store.prompt(capture.manifest, capture.hash, authority), /revoked|unavailable/);
    f.store.install(pack(), 3); assert.throws(() => f.store.prompt(capture.manifest, capture.hash, authority), /revoked/);
    assert.throws(() => f.store.prompt(capture.manifest, 'f'.repeat(64), authority), /integrity/);
    assert.equal(f.store.catalog().some(item => item.id === first.id), true, 'retain immutable metadata for policy/recovery');
  } finally { f.close(); }
});
