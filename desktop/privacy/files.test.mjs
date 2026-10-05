import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, symlinkSync, linkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConfigurationExport } from './model.mjs';
import { writeExportFile, readConfigurationFile } from './files.mjs';

const configuration = () => createConfigurationExport({ scope: 'repository', target: 'first', revision: 1, hash: 'a'.repeat(64), settings: { 'privacy.logDays': 12 } }, 1000);
const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-privacy-files-')));
const cleanup = root => { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); };
test('exclusive local export reads back exact bytes, private mode and scoped configuration', async () => {
  const root = fixture(), path = join(root, 'Project settings.json'), envelope = configuration();
  try {
    writeFileSync(join(root, 'neighbor.txt'), 'preserve');
    const result = await writeExportFile(path, envelope);
    assert.equal(result.sha256, createHash('sha256').update(readFileSync(path)).digest('hex')); assert.equal(result.bytes, statSync(path).size);
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.deepEqual(await readConfigurationFile(path, { scope: 'repository', target: 'first' }), envelope);
    await assert.rejects(readConfigurationFile(path, { scope: 'repository', target: 'second' }), /Privacy import/);
    await assert.rejects(writeExportFile(path, envelope), /Privacy export/); assert.deepEqual(JSON.parse(readFileSync(path)), envelope);
    assert.equal(readFileSync(join(root, 'neighbor.txt'), 'utf8'), 'preserve');
  } finally { cleanup(root); }
});
test('aliases, linked input and app-managed destinations are denied while preserving existing contents', async () => {
  const root = fixture(), path = join(root, 'original.json');
  try {
    await writeExportFile(path, configuration()); symlinkSync(path, join(root, 'alias.json')); linkSync(path, join(root, 'linked.json'));
    for (const name of ['alias.json', 'linked.json']) await assert.rejects(readConfigurationFile(join(root, name), { scope: 'repository', target: 'first' }), /Privacy import/);
    await assert.rejects(writeExportFile(join(root, 'alias.json'), configuration()), /Privacy export/);
    mkdirSync(join(root, 'managed'), { mode: 0o700 });
    await assert.rejects(writeExportFile(join(root, 'managed', 'new.json'), configuration(), { protectedPaths: [join(root, 'managed')] }), /Privacy export/);
    symlinkSync(join(root, 'managed'), join(root, 'directory-alias'));
    await assert.rejects(writeExportFile(join(root, 'directory-alias', 'new.json'), configuration()), /Privacy export/);
    assert.equal(existsSync(join(root, 'managed', 'new.json')), false); assert.deepEqual(JSON.parse(readFileSync(path)), configuration());
  } finally { cleanup(root); }
});
test('malformed, oversized or raw diagnostic content cannot create an export or enter restore', async () => {
  const root = fixture(), path = join(root, 'invalid.json');
  try {
    await assert.rejects(writeExportFile(path, { ...configuration(), rawLog: 'synthetic-secret' }), /Privacy export/); assert.equal(existsSync(path), false);
    writeFileSync(path, '{"credential":"synthetic-secret"}'); await assert.rejects(readConfigurationFile(path, { scope: 'repository', target: 'first' }), /Privacy import/);
    writeFileSync(path, Buffer.alloc(2 * 1024 ** 2 + 1)); await assert.rejects(readConfigurationFile(path, { scope: 'repository', target: 'first' }), /Privacy import/);
    assert.equal(statSync(path).size, 2 * 1024 ** 2 + 1);
  } finally { cleanup(root); }
});
test('cancelled native operation creates no file', async () => {
  const root = fixture(), path = join(root, 'cancelled.json');
  try {
    const signal = AbortSignal.abort('cancelled'); await assert.rejects(writeExportFile(path, configuration(), { signal }), /Privacy export cancelled/);
    assert.equal(existsSync(path), false);
  } finally { cleanup(root); }
});
