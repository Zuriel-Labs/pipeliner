import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, realpathSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openToolStore, toolManifestHash } from './store.mjs';
import { toolPackage, qualifyToolPackage } from './package.mjs';
import { openSkillStore } from '../skills/store.mjs';
import { skillPackage } from '../skills/package.mjs';

const inputSchema = { type: 'object', properties: { title: { type: 'string', maxLength: 240 } }, required: ['title'], additionalProperties: false };
const command = (script = 'printf done', name = 'beacon') => toolPackage({ name, purpose: 'Check synthetic work', version: '1.0.0', license: 'MIT', dataCategories: ['issue.title'],
  command: { script, timeoutSeconds: 30, inputSchema } });
const mcp = (endpoint = 'https://example.com/mcp') => toolPackage({ name: 'queue', purpose: 'Read synthetic queue', version: 'declared-1', license: 'MIT', dataCategories: ['issue.title'],
  mcp: { endpoint, protocolVersion: '2026-07-28', tool: { name: 'queue_count', inputSchema, annotations: { readOnlyHint: true } } } });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-tools-'))); chmodSync(root, 0o700); let tools;
  const skills = openSkillStore(root, { occupiedNames: () => tools?.names() ?? [] }); tools = openToolStore(root, { occupiedNames: () => skills.names() });
  return { root, tools, skills, close() { tools.close(); skills.close(); rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); } };
}
const view = (selected = [], disabled = []) => ({ values: { 'tools.extensions': { value: selected }, 'tools.disabled': { value: disabled } } });

test('qualified manifest pins declared source, typed data and derived permissions; hostile definitions do not grant access', async () => {
  assert.equal(await qualifyToolPackage(command()), true); assert.equal(await qualifyToolPackage(mcp()), true);
  assert.deepEqual(mcp().permissions, ['extension.invoke']); assert.equal(mcp().sourceIdentity.kind, 'mcp-endpoint-catalog');
  assert.notEqual(mcp().digest, mcp('https://example.org/mcp').digest);
  for (const extra of [{ permissions: ['host.install'] }, { hooks: { install: 'rm anything' } }, { command: { script: 'true', timeoutSeconds: 0, inputSchema } }]) {
    assert.throws(() => toolPackage({ ...command().definition, ...extra }), /Tool /);
  }
  assert.throws(() => toolPackage({ ...mcp().definition, mcp: { ...mcp().definition.mcp, endpoint: 'http://localhost/mcp' } }), /Tool /);
  await assert.rejects(qualifyToolPackage(toolPackage({ ...command().definition, command: { ...command().definition.command, inputSchema: { $ref: '#missing' } } })), /MCP schema/);
});

test('tool inventory is private and atomic; staged pins do not install, exact old content survives updates/restart', () => {
  const f = fixture(); try {
    const staged = f.tools.stage(command(), 0); assert.equal(f.tools.list().length, 0); assert.equal(f.tools.revision(), 1);
    assert.throws(() => f.tools.capture(view([staged.id])), /unavailable/);
    const first = f.tools.install(command(), 1), captured = f.tools.capture(view([first.id]));
    assert.equal(toolManifestHash(captured.manifest), captured.hash); assert.equal(statSync(join(f.root, 'tools.sqlite')).mode & 0o777, 0o600);
    const second = f.tools.install(command('printf updated'), 2); assert.notEqual(second.id, first.id);
    assert.equal(f.tools.get(first.id).definition.command.script, 'printf done'); assert.equal(f.tools.list()[0].id, second.id);
    assert.equal(f.tools.assertCaptured(captured.manifest, captured.hash, { tools: [first.id], deniedTools: [], capabilities: first.permissions })[0].id, first.id);
    assert.throws(() => f.tools.install(command(), 2), /changed/); assert.throws(() => f.tools.install({ ...command(), permissions: ['host.launch'] }, 3), /verified/);
    f.tools.close(); const reopened = openToolStore(f.root, { occupiedNames: () => f.skills.names() });
    try { assert.equal(reopened.get(first.id).digest, first.digest); assert.equal(reopened.revision(), 3); } finally { reopened.close(); }
  } finally { f.close(); }
});

test('skill/tool names share one namespace; removal/disable/reinstall never revives captured authority', () => {
  const f = fixture(); try {
    const first = f.tools.install(command(), 0), captured = f.tools.capture(view([first.id]));
    const pack = skillPackage({ source: { repository: 'fixture/skills', commit: 'a'.repeat(40), path: 'beacon' }, files: [
      { path: 'SKILL.md', content: '---\nname: beacon\ndescription: Scoped synthetic review\nlicense: MIT\n---\nReview evidence.' }, { path: 'LICENSE', content: 'MIT License\nSynthetic fixture.' }] });
    assert.throws(() => f.skills.stage(pack, 0), /name collision/);
    assert.throws(() => f.tools.install(command('true', 'pipeliner-motif'), 1), /name collision/);
    const authority = { tools: [first.id], deniedTools: [], capabilities: first.permissions };
    assert.throws(() => f.tools.assertCaptured(captured.manifest, captured.hash, { ...authority, deniedTools: [first.id] }), /revoked/);
    assert.throws(() => f.tools.assertCaptured(captured.manifest, captured.hash, { ...authority, capabilities: [] }), /revoked/);
    assert.equal(f.tools.capture(view([first.id], [first.id])).manifest.length, 0);
    f.tools.remove('beacon', 1); f.tools.install(command(), 2);
    assert.throws(() => f.tools.assertCaptured(captured.manifest, captured.hash, authority), /revoked/);
    assert.throws(() => f.tools.assertCaptured(captured.manifest, 'f'.repeat(64), authority), /integrity/);
    assert.equal(f.tools.catalog().some(item => item.id === first.id), true);
  } finally { f.close(); }
});
test('MCP capture binds its credential epoch; anonymous, replaced and disconnected credentials cannot change an old run', () => {
  const f = fixture(); let currentEpoch = 0;
  try {
    const pack = f.tools.install(mcp(), 0), epoch = endpoint => { assert.equal(endpoint, pack.definition.mcp.endpoint); return currentEpoch; };
    const selected = f.tools.capture(view([pack.id]), { epoch }), authority = { tools: [pack.id], deniedTools: [], capabilities: pack.permissions };
    assert.equal(selected.manifest[0].connectionEpoch, 0);
    assert.equal(f.tools.assertCaptured(selected.manifest, selected.hash, authority, { epoch })[0].id, pack.id);
    currentEpoch = 1; assert.throws(() => f.tools.assertCaptured(selected.manifest, selected.hash, authority, { epoch }), /connection changed/);
    assert.throws(() => f.tools.assertCaptured(selected.manifest, selected.hash, authority), /connection changed/);
    const next = f.tools.capture(view([pack.id]), { epoch }); currentEpoch = 2;
    assert.throws(() => f.tools.assertCaptured(next.manifest, next.hash, authority, { epoch }), /connection changed/);
  } finally { f.close(); }
});
