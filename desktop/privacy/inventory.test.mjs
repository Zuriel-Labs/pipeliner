import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectManagedData } from './inventory.mjs';

test('installation inventory uses fixed owned metadata, isolates unavailable categories and reads no secrets', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-data-inventory-'))), outside = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-inventory-outside-')));
  try {
    writeFileSync(join(root, 'connections.sqlite'), 'credential-like fixture data never opened', { mode: 0o600 });
    writeFileSync(join(root, 'policy.sqlite'), 'typed settings fixture', { mode: 0o600 });
    mkdirSync(join(root, 'Cache'), { mode: 0o700 }); writeFileSync(join(root, 'Cache', 'asset'), 'synthetic cache', { mode: 0o600 });
    const id = '00000000-0000-4000-8000-000000000001'; writeFileSync(join(root, 'workspaces-v1-' + id + '.pipeliner-backup'), 'synthetic archive metadata fixture', { mode: 0o600 });
    writeFileSync(join(outside, 'unrelated'), 'preserve', { mode: 0o600 }); symlinkSync(join(outside, 'unrelated'), join(root, 'development.sqlite'));
    writeFileSync(join(root, 'unknown.txt'), 'unrelated file omitted', { mode: 0o600 });
    let data = inspectManagedData(root); assert.equal(data.find(row => row.id === 'connections').bytes, 41); assert.equal(data.find(row => row.id === 'development').state, 'unavailable');
    assert.equal(data.find(row => row.id === 'migration').count, 1); assert.equal(data.find(row => row.id === 'cache').bytes, 15);
    assert.equal(JSON.stringify(data).includes('credential-like'), false); assert.equal(JSON.stringify(data).includes(root), false); assert.equal(JSON.stringify(data).includes('unknown.txt'), false);
    assert.equal(readFileSync(join(outside, 'unrelated'), 'utf8'), 'preserve');
    chmodSync(join(root, 'policy.sqlite'), 0o644); data = inspectManagedData(root); assert.equal(data.find(row => row.id === 'policy').state, 'unavailable'); assert.equal(data.find(row => row.id === 'connections').state, 'present');
    assert.throws(() => inspectManagedData(root + '/..')); chmodSync(root, 0o755); assert.throws(() => inspectManagedData(root));
  } finally { chmodSync(root, 0o700); rmSync(root, { recursive: true }); rmSync(outside, { recursive: true }); assert.equal(existsSync(root), false); assert.equal(existsSync(outside), false); }
});
