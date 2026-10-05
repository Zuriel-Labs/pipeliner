import test from 'node:test';
import { openTestVault } from '../connections/test-vault.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON, developmentTemplate, record } from '../core/settings.mjs';
import { openDevelopmentStore, developmentIssueHash } from './state.mjs';
import { sourceTree } from './source.mjs';
import { starterHash, starterSkills } from './starter.mjs';
import { createDevelopmentEngine } from './engine.mjs';
import { openSkillStore } from '../skills/store.mjs';
import { openToolStore } from '../tools/store.mjs';
import { toolPackage } from '../tools/package.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJSON(value)).digest('hex');
const file = content => ({ path: 'app.mjs', mode: '100644', content: Buffer.from(content).toString('base64') });
async function fixture(extraLimits = {}, fallbackIds = [], hostAuthority = () => true, selectedSkills = false, custom = null, connectMCP = null, customSkill = false) {
  const issue = { number: 1, title: 'Change fixture value to two', body: 'A bounded fixture.' };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-development-engine-'))), source = [file('export const value = 1;\n')], candidate = { sourceCommit: 'a'.repeat(40), gitTree: sourceTree(source) };
  const tools = custom ? openToolStore(root) : null, pack = custom ? tools.install(custom, 0) : null;
  const selectedTools = tools?.capture({ values: { 'tools.extensions': { value: [pack.id] }, 'tools.disabled': { value: [] } } });
  const pipeline = structuredClone(developmentTemplate);
  if (pack) { pipeline.steps[1].kind = 'extension'; pipeline.steps[1].extension = { kind: pack.kind, pin: pack.id, bindings: [{ path: ['title'], source: 'issue.title' }], constants: {} }; }
  if (customSkill) { pipeline.steps[1].kind = 'extension'; pipeline.steps[1].extension = { kind: 'skill', pin: starterSkills[0].id,
    bindings: [{ path: ['title'], source: 'issue.title' }], constants: { audience: 'PM' } }; }
  const run = { id: 'run-one', repository: 'repo-one', issue: 1, dev: 'dev-one', epoch: 1, policyRevision: 1, policyHash: 'b'.repeat(64), createdAt: Date.now(),
    pipelineHash: hash(pipeline), control: 'running', limits: { 'limits.stepTurns': 8, 'limits.issueTurns': 16, 'limits.agentSeconds': 1800, ...extraLimits } };
  const skills = selectedSkills || customSkill ? openSkillStore(root) : null, selected = skills?.capture({ values: { 'skills.bundledEnabled': { value: true }, 'skills.extensions': { value: [] }, 'skills.disabled': { value: [starterSkills[1].id] } } });
  const vault = await openTestVault(root), ledger = openDevelopmentStore(root, { vault }); ledger.create(run, { pipeline, source: candidate, developer: { id: run.dev, connection: 'ollama', model: 'test-model' },
    ...(selectedTools ? { toolManifest: selectedTools.manifest, toolsHash: selectedTools.hash } : {}),
    fallbacks: fallbackIds.map(id => ({ id, connection: 'ollama', model: 'test-model' })), skillsHash: selected?.hash ?? starterHash, ...(selected ? { skillManifest: selected.manifest } : {}), issueHash: developmentIssueHash(issue), checks: [{ name: 'Fixture check', command: 'node --test' }], logBytes: 1048576 });
  let files = [], turns = 0, lease; const operations = [], binding = { runId: run.id, epoch: run.epoch }, permissions = ['provider.turn', 'workspace.read', 'workspace.write', 'worker.exec', ...(pack ? ['extension.invoke'] : [])];
  const makeLease = () => { let closed = false; return { check: () => { if (closed) throw new Error('connection-changed'); }, close: () => { closed = true; }, turn: async input => { turns++; return await next(input, turns); } }; };
  let next = async () => { throw new Error('provider unavailable'); };
  const perform = async (_binding, request) => { assert.deepEqual(_binding, binding); operations.push(request.operation);
    const shapes = { seed: ['files'], list: [], read: ['path'], write: ['path', 'content', 'mode', 'beforeHash'], run: ['command', 'timeoutMs'], export: [] };
    record(request, ['operation', ...shapes[request.operation]], request.operation === 'run' ? ['input'] : []);
    if (request.operation === 'seed') { files = structuredClone(request.files); return { files: files.length }; }
    if (request.operation === 'export') return { files: structuredClone(files) };
    if (request.operation === 'list') return { files: files.map(file => ({ path: file.path, hash: hash(Buffer.from(file.content, 'base64').toString()) })) };
    if (request.operation === 'read') return { path: request.path, content: Buffer.from(files[0].content, 'base64').toString(), hash: hash(Buffer.from(files[0].content, 'base64').toString()) };
    if (request.operation === 'write') { assert.equal(request.beforeHash, hash(Buffer.from(files[0].content, 'base64').toString())); files = [{ path: request.path, mode: request.mode, content: request.content }]; return { path: request.path }; }
    if (request.operation === 'run') { if (request.input) {
      assert.equal(ledger.evidence(binding).at(-1).state, 'dispatched'); assert.equal(ledger.evidence(binding).at(-1).kind, 'extension');
      assert.deepEqual(request.input, { title: issue.title }); return { exitCode: 0, output: 'Typed command completed', truncated: false, timedOut: false }; }
      return { exitCode: pack || Buffer.from(files[0].content, 'base64').toString().includes('= 2') ? 0 : 1, output: 'Fixture check', truncated: false, timedOut: false }; }
    throw new Error('tool denied');
  };
  const supervisor = { tool: async (...args) => args[1].operation === 'read' && args[1].path === 'missing.mjs' ? { ok: false, error: 'tool-denied-or-incomplete' } : ({ ok: true, result: await perform(...args) }) };
  const grant = { dev: run.dev, connections: ['ollama'], capabilities: permissions, bundledSkills: true, extensions: [], deniedExtensions: selected ? [starterSkills[1].id] : [], tools: pack ? [pack.id] : [], deniedTools: [], takeover: fallbackIds.length > 0, fallbacks: fallbackIds };
  const policy = { runtime: { status: () => run }, worker: { authority: () => grant } };
  const connections = { acquireProvider: async (id, model) => { assert.equal(id, 'ollama'); assert.equal(model, 'test-model'); lease = makeLease(); return lease; } };
  return { ledger, source, binding, run, grant, permissions, operations, get lease() { return lease; }, set next(value) { next = value; }, get turns() { return turns; },
    engine: createDevelopmentEngine({ ledger, policy, supervisor, connections, hostAuthority, skills, tools, connectMCP }), context: { issue, source },
    cleanup() { ledger.close(); vault.close(); skills?.close(); tools?.close(); rmSync(root, { recursive: true }); } };
}
const output = (evidence, documents = []) => ({ outcome: 'success', summary: 'Scoped fixture evidence.', evidence, documents, findings: [] });
const call = (f, operation, payload, epoch = f.binding.epoch) => ({ content: '', thinking: '', usage: { input: 10, output: 5 }, tool_calls: [{ function: {
  name: 'pipeliner_tool', arguments: { ...f.binding, epoch, operation, payload } } }] });
const latestEvidence = input => JSON.parse(input.messages.filter(message => message.role === 'tool').at(-1).content).evidenceId;
const documents = ['research', 'specification', 'design'].map(kind => ({ kind, title: kind, paragraphs: ['Inspect the fixture; change one value; verify its check.'] }));

test('custom skill step uses its exact instruction pin and declared typed input without undeclared Issue or prior-output content', async () => {
  const f = await fixture({}, [], () => true, false, null, null, true);
  try {
    f.next = async (input, turn) => {
      if (turn === 1) return call(f, 'list', {});
      if (turn === 2) return call(f, 'finish', output([latestEvidence(input)], documents));
      const prompt = input.messages[0].content;
      assert.match(prompt, /pipeliner-forge/); assert.doesNotMatch(prompt, /pipeliner-motif|pipeliner-shape|pipeliner-lens|A bounded fixture\.|Inspect the fixture; change one value/);
      assert.deepEqual(JSON.parse(/Captured typed input: ([^\n]+)/.exec(prompt)?.[1] ?? 'null'), { audience: 'PM', title: f.context.issue.title });
      assert.match(prompt, /Recorded plan complete: true/); throw new Error('fixture-stop-after-skill-input');
    };
    await assert.rejects(f.engine.run(f.binding, f.context), /fixture-stop-after-skill-input/);
    assert.equal(f.turns, 3); assert.equal(f.ledger.status(f.run.id).step, 'implement');
  } finally { f.cleanup(); }
});

test('captured custom command step records intent before the exact restricted effect and advances through real ledger evidence', async () => {
  const pack = toolPackage({ name: 'check', purpose: 'Check scoped work', version: '1', license: 'MIT', dataCategories: ['issue.title'],
    command: { script: 'printf done', timeoutSeconds: 30, inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } } });
  const f = await fixture({}, [], () => true, false, pack);
  try {
    f.next = async (input, turn) => { if (turn === 1) return call(f, 'list', {}); if (turn === 2) return call(f, 'finish', output([latestEvidence(input)], documents)); throw new Error('fixture-stop-after-custom-command'); };
    await assert.rejects(f.engine.run(f.binding, f.context), /fixture-stop/);
    const evidence = f.ledger.evidence(f.binding).find(row => row.kind === 'extension'); assert.equal(evidence.state, 'verified');
    assert.equal(evidence.payload.pin, f.ledger.captured(f.run.id).toolManifest[0].id); assert.equal(evidence.result.result.structuredContent.exitCode, 0);
    assert.deepEqual(f.operations.slice(0, 5), ['seed', 'export', 'list', 'run', 'export']); assert.equal(f.ledger.outputs(f.run.id)[1].step, 'implement');
    f.ledger.suspend(f.binding); f.ledger.rebind(f.run.id, 2); f.binding.epoch = 2; f.run.epoch = 2;
    await assert.rejects(f.engine.run(f.binding, f.context), /fixture-stop/); assert.equal(f.operations.filter(operation => operation === 'run').length, 2, 'completed custom step never repeats; subsequent repository check accounts for the second command');
  } finally { f.cleanup(); }
});

test('captured MCP effect preserves uncertainty on reply loss and cannot resume or replay without verified recovery', async () => {
  const pack = toolPackage({ name: 'queue', purpose: 'Read scoped queue', version: '1', license: 'MIT', dataCategories: ['issue.title'], mcp: {
    endpoint: 'https://example.com/mcp', protocolVersion: '2026-07-28', tool: { name: 'queue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } } } });
  let f, calls = 0, closed = 0;
  f = await fixture({}, [], () => true, false, pack, async installed => ({ endpoint: installed.definition.mcp.endpoint, protocolVersion: '2026-07-28',
    async list() { return { tools: [installed.definition.mcp.tool] }; },
    async call(_tool, input) { calls++; assert.deepEqual(input, { title: f.context.issue.title }); assert.equal(f.ledger.evidence(f.binding).at(-1).state, 'dispatched'); throw Object.assign(new Error('private-provider-detail'), { dispatched: true }); },
    close() { closed++; } }));
  try {
    f.next = async (input, turn) => turn === 1 ? call(f, 'list', {}) : call(f, 'finish', output([latestEvidence(input)], documents));
    await assert.rejects(f.engine.run(f.binding, f.context), /Tool execution failed/);
    const evidence = f.ledger.evidence(f.binding).find(row => row.kind === 'extension'); assert.equal(evidence.state, 'uncertain'); assert.equal(calls, 1); assert.equal(closed, 1);
    assert.equal(JSON.stringify(evidence).includes('private-provider-detail'), false);
    f.ledger.suspend(f.binding); assert.throws(() => f.ledger.rebind(f.run.id, 2), /recovery unresolved/);
    await assert.rejects(f.engine.run(f.binding, f.context), /pending outcome needs recovery/); assert.equal(calls, 1); assert.equal(f.ledger.status(f.run.id).qa, undefined);
  } finally { f.cleanup(); }
});

test('captured skill selection excludes disabled instructions and tightening fences the returned tool before dispatch', async () => {
  const f = await fixture({}, [], () => true, true);
  try {
    f.next = async input => {
      assert.match(input.messages[0].content, /pipeliner-forge/); assert.doesNotMatch(input.messages[0].content, /pipeliner-motif/);
      f.grant.deniedExtensions.push(starterSkills[0].id); return call(f, 'list', {});
    };
    await assert.rejects(f.engine.run(f.binding, f.context), /skill authority revoked/);
    assert.equal(f.turns, 1); assert.deepEqual(f.operations, ['seed', 'export']); assert.equal(f.ledger.status(f.run.id).turns, 1);
  } finally { f.cleanup(); }
});

test('host revocation fences the next provider or workspace effect without resetting captured usage', async () => {
  for (const before of [true, false]) {
    let allowed = !before; const f = await fixture({}, [], () => allowed);
    try {
      f.next = async () => { allowed = false; return call(f, 'list', {}); };
      await assert.rejects(f.engine.run(f.binding, f.context), /host execution/);
      assert.equal(f.turns, before ? 0 : 1); assert.deepEqual(f.operations, before ? [] : ['seed', 'export']);
      assert.equal(f.ledger.status(f.run.id).turns, before ? 0 : 1);
    } finally { f.cleanup(); }
  }
});

test('classified provider failure retries inside the same operation and records unavailable charged usage', async () => {
  const f = await fixture();
  try {
    f.next = async (input, turn) => {
      if (turn === 1) throw new Error('http-503');
      if (turn === 2) return call(f, 'list', {});
      if (turn === 3) return call(f, 'finish', output([latestEvidence(input)], documents));
      throw new Error('fixture-stop-after-transient-recovery');
    };
    await assert.rejects(f.engine.run(f.binding, f.context), /fixture-stop/);
    const state = f.ledger.status(f.run.id); assert.equal(state.attempts['provider-1-1'].count, 2);
    assert.equal(state.turns, 4); assert.equal(state.usage.unavailable, true); assert.equal(state.usage.input, 20);
    assert.equal(f.ledger.outputs(f.run.id)[0].step, 'research'); assert.equal(f.operations.includes('write'), false);
  } finally { f.cleanup(); }
});

test('exhausted provider attempts cannot restart through a new epoch', async () => {
  const f = await fixture({ 'limits.transientAttempts': 1 });
  try {
    f.next = async () => { throw new Error('http-503'); };
    await assert.rejects(f.engine.run(f.binding, f.context), /attempts exhausted/); assert.equal(f.turns, 1);
    f.ledger.suspend(f.binding); f.ledger.rebind(f.run.id, 2); f.binding.epoch = 2; f.run.epoch = 2;
    await assert.rejects(f.engine.run(f.binding, f.context), /attempts exhausted/); assert.equal(f.turns, 1);
    assert.equal(f.ledger.status(f.run.id).turns, 1); assert.equal(f.ledger.status(f.run.id).usage.unavailable, true);
  } finally { f.cleanup(); }
});

test('turn exhaustion denies a new tool from the last allowed model response', async () => {
  for (const limit of ['limits.issueTurns', 'limits.stepTurns']) {
    const f = await fixture({ [limit]: 1 });
    try {
      f.next = async () => call(f, 'list', {});
      await assert.rejects(f.engine.run(f.binding, f.context), /turn limit/);
      assert.equal(f.turns, 1); assert.deepEqual(f.operations, ['seed', 'export']);
      assert.equal(f.ledger.status(f.run.id).turns, 1);
    } finally { f.cleanup(); }
  }
});

test('only a later configured Dev triggers takeover; the last Dev retains bounded transient retry', async () => {
  for (const last of [false, true]) {
    const f = await fixture({}, ['dev-two', 'dev-three']);
    try {
      if (last) {
        const candidate = f.ledger.status(f.run.id).candidate;
        f.ledger.rebind(f.run.id, 2, { developer: 'dev-two', candidate }); f.ledger.rebind(f.run.id, 3, { developer: 'dev-three', candidate });
        f.run.dev = 'dev-three'; f.run.epoch = f.binding.epoch = 3;
      }
      f.next = async (_input, turn) => { throw Error(turn === 1 ? 'http-503' : 'fixture-stop'); };
      await assert.rejects(f.engine.run(f.binding, f.context), last ? /fixture-stop/ : error => error.code === 'development-provider-transient');
      assert.equal(f.turns, last ? 2 : 1); assert.equal(f.ledger.status(f.run.id).attempts['provider-1-1'].count, last ? 2 : 1);
    } finally { f.cleanup(); }
  }
});

test('core steps bind broker evidence, deny a stale tool and stop before PM testing', async () => {
  const f = await fixture();
  try {
    f.next = async (input, turn) => {
      assert.equal(input.maxOutput, 4096);
      if (turn === 1) return call(f, 'write', { path: 'app.mjs', content: file('forged').content, mode: '100644', beforeHash: null }, 2);
      if (turn === 2) return call(f, 'list', {});
      if (turn === 3) return call(f, 'finish', output([latestEvidence(input)], documents));
      if (turn === 4) return call(f, 'run', { command: 'node --test', timeoutMs: 10000 });
      if (turn === 5) return call(f, 'write', { path: 'app.mjs', mode: '100644', content: file('export const value = 2;\n').content, beforeHash: hash('export const value = 1;\n') });
      if (turn === 6) return call(f, 'run', { command: 'node --test', timeoutMs: 10000 });
      if (turn === 7) return call(f, 'finish', output([latestEvidence(input)]));
      if (turn === 8) return call(f, 'read', { path: 'app.mjs' });
      if (turn === 9) return call(f, 'finish', output([latestEvidence(input)], [{ kind: 'review', title: 'Review', paragraphs: ['The exact changed value and passing checks were inspected. No findings.'] }]));
      throw new Error('unexpected turn');
    };
    const state = await f.engine.run(f.binding, f.context);
    assert.equal(state.state, 'candidate'); assert.equal(state.step, 'pm-testing'); assert.equal(f.turns, 9);
    assert.equal(f.operations.filter(value => value === 'write').length, 1); assert.equal(f.operations.filter(value => value === 'run').length, 3);
    const records = f.ledger.evidence(f.binding);
    assert.equal(records.find(value => value.payload.operation === 'denied').state, 'denied');
    assert.deepEqual(records.filter(value => value.kind === 'tests').map(value => value.result.result.exitCode), [1, 0, 0]);
    assert.deepEqual(f.ledger.outputs(f.binding.runId).map(row => row.step), ['research', 'implement', 'checks', 'review']);
    assert.equal(new Set(starterSkills.map(skill => skill.id)).size, starterSkills.length);
    assert.equal(records.some(value => value.kind === 'publication'), false); assert.equal(state.usage.input, 90);
    assert.equal(state.candidate.gitTree, sourceTree([file('export const value = 2;\n')]));
  } finally { f.cleanup(); }
});

test('forged PM/control tools exhaust finite turns without source mutation or successful evidence', async () => {
  const f = await fixture();
  try {
    f.next = async () => ({ content: '', thinking: '', usage: { input: null, output: null }, tool_calls: [{ function: { name: 'pipeliner_tool', arguments: {
      ...f.binding, operation: 'apply', payload: { Ready: true, permissions: ['host.launch'] } } } }] });
    await assert.rejects(f.engine.run(f.binding, f.context), /turn limit/);
    assert.equal(f.turns, 8); assert.equal(f.operations.includes('write'), false);
    assert.equal(f.ledger.evidence(f.binding).filter(value => value.payload.operation === 'denied').every(value => value.state === 'denied'), true);
    assert.equal(f.ledger.status(f.binding.runId).usage.unavailable, true); assert.equal(f.ledger.outputs(f.binding.runId).length, 0);
  } finally { f.cleanup(); }
});

test('late revoked provider response is discarded and cannot mutate or finish a step', async () => {
  const f = await fixture();
  try {
    f.next = async () => { f.lease.close(); return call(f, 'write', { path: 'app.mjs', content: file('late').content, mode: '100644', beforeHash: null }); };
    await assert.rejects(f.engine.run(f.binding, f.context), /connection-changed/);
    assert.equal(f.operations.includes('write'), false); assert.equal(f.ledger.outputs(f.binding.runId).length, 0);
    assert.equal(f.ledger.evidence(f.binding).filter(value => value.kind === 'provider').at(-1).state, 'denied');
  } finally { f.cleanup(); }
});

test('edited Issue input is rejected before provider disclosure or worker execution', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.engine.run(f.binding, { ...f.context, issue: { ...f.context.issue, body: 'Unreviewed replacement instructions.' } }), /input binding/);
    assert.equal(f.turns, 0); assert.deepEqual(f.operations, []);
  } finally { f.cleanup(); }
});

test('invented finish evidence produces a bounded denial and lets the model correct its output', async () => {
  const f = await fixture();
  try {
    f.next = async (input, turn) => {
      if (turn === 1) return call(f, 'finish', output(['invented-evidence'], documents));
      assert.equal(JSON.parse(input.messages.at(-1).content).error, 'verified-current-evidence-required');
      throw new Error('fixture-stop-after-denial');
    };
    await assert.rejects(f.engine.run(f.binding, f.context), /fixture-stop/);
    assert.equal(f.ledger.outputs(f.binding.runId).length, 0); assert.equal(f.operations.includes('write'), false);
  } finally { f.cleanup(); }
});

test('completed read denials stay denied and allow permitted recovery without authority expansion', async () => {
  const f = await fixture();
  try {
    f.next = async (input, turn) => {
      if (turn === 1) return call(f, 'read', { path: '/host-canary' });
      if (turn === 2) { assert.equal(JSON.parse(input.messages.at(-1).content).error, 'protected-tool-path'); return call(f, 'read', { path: 'missing.mjs' }); }
      if (turn === 3) { const denied = JSON.parse(input.messages.at(-1).content); assert.equal(denied.state, 'denied'); assert.equal(denied.allowed, false); return call(f, 'list', {}); }
      if (turn === 4) return call(f, 'finish', output([latestEvidence(input)], documents));
      throw Error('fixture-stop-after-recovered-research');
    };
    await assert.rejects(f.engine.run(f.binding, f.context), /fixture-stop/);
    assert.equal(f.ledger.outputs(f.binding.runId)[0].step, 'research');
    assert.equal(f.ledger.evidence(f.binding).filter(row => row.kind === 'source' && row.state === 'denied').length, 2);
    assert.equal(f.operations.includes('write'), false); assert.equal(f.turns, 5);
  } finally { f.cleanup(); }
});

test('invalid tool binding and payload receive the exact contract and recover inside the same captured authority', async () => {
  const f = await fixture();
  try {
    f.next = async (input, turn) => {
      if (turn === 1) { const value = call(f, 'list', {}); delete value.tool_calls[0].function.arguments.runId; return value; }
      if (turn === 2) { const denied = JSON.parse(input.messages.at(-1).content); assert.equal(denied.error, 'tool-argument-shape-denied'); return call(f, 'list', {}, 99); }
      if (turn === 3) { const denied = JSON.parse(input.messages.at(-1).content);
        assert.equal(denied.error, 'tool-run-or-epoch-denied'); assert.deepEqual([denied.contract.runId, denied.contract.epoch], [f.binding.runId, f.binding.epoch]);
        return call(f, 'list', { permissions: ['host.launch'] }); }
      if (turn === 4) { const denied = JSON.parse(input.messages.at(-1).content);
        assert.equal(denied.error, 'tool-payload-shape-denied'); assert.deepEqual(denied.contract.payloads.list, []); return call(f, 'list', {}); }
      if (turn === 5) return call(f, 'finish', output([latestEvidence(input)], [...documents, documents[0]]));
      if (turn === 6) { const denied = JSON.parse(input.messages.at(-1).content); assert.equal(denied.error, 'duplicate-development-document');
        assert.deepEqual(denied.contract.output.uniqueDocumentKinds, ['research', 'specification', 'design', 'review']); return call(f, 'finish', output(denied.verifiedEvidence, documents)); }
      throw Error('fixture-stop-after-contract-recovery');
    };
    await assert.rejects(f.engine.run(f.binding, f.context), /fixture-stop/);
    assert.equal(f.ledger.outputs(f.binding.runId)[0].step, 'research'); assert.equal(f.operations.includes('write'), false);
    const denied = f.ledger.evidence(f.binding).filter(row => row.kind === 'source' && row.state === 'denied');
    assert.equal(denied.length, 4); assert.equal(denied[0].result.result.contract.runId, f.binding.runId);
  } finally { f.cleanup(); }
});
