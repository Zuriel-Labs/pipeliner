import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readdirSync, readFileSync, lstatSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireExecutionOwner } from './execution.mjs';

test('cold inspection requires the existing execution owner and retains its actual exclusive lease', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-cold-owner-'))), path = join(directory, 'owner.sqlite');
  let owner, contender;
  const snapshot = () => {
    const value = lstatSync(path, { bigint: true });
    return { bytes: readFileSync(path), identity: ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => value[key].toString()) };
  };
  try {
    assert.throws(() => { owner = acquireExecutionOwner(directory, { existingOnly: true }); });
    assert.deepEqual(readdirSync(directory), []);
    assert.throws(() => { owner = acquireExecutionOwner(directory, { existingOnly: 'yes' }); });
    assert.deepEqual(readdirSync(directory), []);
    owner = acquireExecutionOwner(directory); owner.close(); owner = undefined;
    const before = snapshot();
    owner = acquireExecutionOwner(directory, { existingOnly: true });
    assert.throws(() => { contender = acquireExecutionOwner(directory, { existingOnly: true }); }, /Execution owner unavailable/);
    assert.throws(() => { contender = acquireExecutionOwner(directory); }, /Execution owner unavailable/);
    assert.deepEqual(snapshot(), before);
    owner.close(); owner.close(); owner = undefined;
    assert.deepEqual(snapshot(), before); assert.deepEqual(readdirSync(directory), ['owner.sqlite']);
    owner = acquireExecutionOwner(directory, { existingOnly: true }); owner.close(); owner = undefined;
    chmodSync(path, 0o640); const changed = snapshot();
    assert.throws(() => { owner = acquireExecutionOwner(directory, { existingOnly: true }); }, /Invalid protected file/);
    assert.deepEqual(snapshot(), changed);
  } finally {
    try { contender?.close(); } finally { try { owner?.close(); } finally { rmSync(directory, { recursive: true }); assert.equal(existsSync(directory), false); } }
  }
});
