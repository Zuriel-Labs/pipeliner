import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, rm, access, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeMCPEntry } from '../desktop/connections/native-entry.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('host-unqualified');
if (process.argv.slice(2).some(value => value !== '--retain-owned-capture')) throw new Error('argument-denied');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), directory = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-54-tool-entry-')));
const helper = join(directory, 'secure-entry'), marker = { issue: 54, owner: 'brimdor', runId: randomUUID(), pid: process.pid }, started = performance.now();
const retain = process.argv.includes('--retain-owned-capture'); let passed = false;
await writeFile(join(directory, 'ownership.json'), JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
try {
  await promisify(execFile)('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', '-mmacosx-version-min=13.0', '-DPIPELINER_QUALIFY', join(root, 'desktop/connections/secure-entry.m'), '-o', helper], { timeout: 30000 });
  const result = await nativeMCPEntry(helper, directory, 'https://example.com/mcp', AbortSignal.timeout(15000), true);
  assert.equal(result.key, 'synthetic-native-entry-only'); assert.equal(result.secureField, true); assert.equal(result.accessibleName, true);
  await access(join(directory, 'mcp-secure-field.png')); passed = true;
  console.log(JSON.stringify({ issue: 54, nativeToolEntry: 'PASS', checks: ['synthetic value returned to host only', 'actual NSSecureTextField', 'native accessibility label'],
    node: process.version, host: process.platform + '/' + process.arch, durationMs: Math.round(performance.now() - started),
    sourceDigest: createHash('sha256').update(await readFile(join(root, 'desktop/connections/secure-entry.m'))).digest('hex'),
    ...(retain ? { retainedDirectory: directory, owner: marker.owner, cleanupTrigger: 'After visual review of the synthetic secure field.' } : {}) }));
} finally {
  if (!retain || !passed) {
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'ownership.json'), 'utf8')), marker);
    const info = await lstat(directory); assert.equal(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid(), true);
    await rm(directory, { recursive: true }); await assert.rejects(access(directory), { code: 'ENOENT' });
    console.log(JSON.stringify({ issue: 54, ownedNativeEntryRootRemoved: true, processesClosed: true }));
  }
}
