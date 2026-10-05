import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVault } from '../connections/vault.mjs';
import { createToolConnections, toolCredentialId } from './connections.mjs';

const endpoint = 'https://example.com/mcp', other = 'https://example.org/mcp';
const pack = { definition: { mcp: { endpoint } } };
// Synthetic protection/client only. Actual native secure field and OS protection have a separate Mac suite.
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-tool-vault-'))), values = [], protection = { available: async () => true,
    encrypt: async value => Buffer.from(value.split('').reverse().join('')), decrypt: async value => ({ result: value.toString().split('').reverse().join('') }) };
  const vault = await openVault(root, protection); let entry = async () => ({ key: 'synthetic-mcp-key' });
  const connections = createToolConnections({ vault, entry: (...args) => entry(...args), client(options) {
    values.push(options); return { endpoint: options.endpoint, protocolVersion: '2026-07-28', async list() { options.authorize(); return { tools: [] }; },
      async call() { options.authorize(); return { content: [] }; }, async close() { await new Promise(resolve => setTimeout(resolve, 5)); values.push('closed'); } }; } });
  return { root, vault, connections, values, set entry(value) { entry = value; }, async close() { await connections.close(); vault.close(); rmSync(root, { recursive: true }); } };
}
test('native MCP entry stores only endpoint-bound encrypted credentials; cancellation and untrusted entry preserve the old configuration', async () => {
  const f = await fixture();
  try {
    assert.notEqual(toolCredentialId(endpoint), toolCredentialId(other));
    for (const value of ['http://localhost/mcp', 'https://user:secret@example.com/mcp', endpoint + '?token=secret']) assert.throws(() => toolCredentialId(value));
    assert.equal(f.connections.epoch(endpoint), 0);
    await f.connections.configure(endpoint, { authorize() {} }); assert.equal(f.connections.epoch(endpoint), 1);
    assert.deepEqual(f.connections.status(endpoint), { hasCredential: true, epoch: 1 });
    assert.equal(JSON.stringify(f.connections.status(endpoint)).includes('synthetic-mcp-key'), false);
    assert.equal(readFileSync(join(f.root, 'connections.sqlite')).includes('synthetic-mcp-key'), false);
    const lease = await f.connections.lease(pack, { authorize() {} }); assert.equal(f.values[0].credential, 'synthetic-mcp-key');
    await lease.list(); await lease.close();
    f.entry = async () => { throw Error('native-entry-cancelled'); };
    await assert.rejects(f.connections.configure(endpoint, { authorize() {} }), /Tool credential entry cancelled/);
    assert.equal(f.connections.epoch(endpoint), 1);
    f.entry = async () => ({ key: 'bad\r\nheader' }); await assert.rejects(f.connections.configure(endpoint, { authorize() {} }), /Tool credential entry failed/);
    assert.equal(f.connections.epoch(endpoint), 1);
    await assert.rejects(f.connections.configure(endpoint, { authorize: () => false }), /Tool connection authority/);
    const id = toolCredentialId(endpoint), epoch = f.vault.begin(id); f.vault.save(id, epoch, { kind: 'mcp-bearer', endpoint: other, credential: 'synthetic-key' });
    await assert.rejects(f.connections.lease(pack, { authorize() {} }), /Tool credential destination/);
  } finally { await f.close(); }
});
test('credential replacement/disconnection awaits endpoint leases and permanently fences old anonymous and authenticated clients', async () => {
  const f = await fixture();
  try {
    const anonymous = await f.connections.lease(pack, { authorize() {} }); assert.equal(f.values[0].credential, null);
    await f.connections.configure(endpoint, { authorize() {} }); assert.equal(f.values.at(-1), 'closed');
    await assert.rejects(anonymous.list(), /Tool connection changed/);
    const active = await f.connections.lease(pack, { authorize() {} });
    await f.connections.disconnect(endpoint, { authorize() {} }); assert.equal(f.values.at(-1), 'closed');
    assert.deepEqual(f.connections.status(endpoint), { hasCredential: false, epoch: 2 });
    await assert.rejects(active.call({}, {}), /Tool connection changed/);
    await f.connections.configure(endpoint, { authorize() {} }); await assert.rejects(active.list(), /Tool connection changed/);
    assert.equal(f.connections.epoch(endpoint), 3);
  } finally { await f.close(); }
});
