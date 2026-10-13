import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, writeFileSync, readFileSync, realpathSync, symlinkSync, rmSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { writeLeasedRestore } from './desktop-macos-restore.mjs';
import testStorage from '../desktop/test-storage.cjs';

test('Mac qualification refuses foreign ownership and aliases without deleting their contents', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-macos-worker-'))), alias = root + '-alias';
  chmodSync(root, 0o700);
  const marker = join(root, 'preserve.txt'); writeFileSync(marker, 'unrelated synthetic content', { mode: 0o600 });
  const ownership = { root, issue:54, owner:'other-owner', bytes:26637307067, sha256:'2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1' };
  const invoke = path => spawnSync(process.execPath, [fileURLToPath(new URL('./desktop-macos-vm.mjs', import.meta.url)), '--owned-root', path], { encoding:'utf8', timeout:10000 });
  let lease;
  try {
    writeFileSync(join(root,'ownership.json'), JSON.stringify(ownership), { mode:0o600 });
    const foreign = invoke(root);
    assert.equal(foreign.status,1); assert.match(foreign.stderr,/macos-vm-root-unverified/);
    assert.equal(readFileSync(marker,'utf8'),'unrelated synthetic content');
    writeFileSync(join(root,'ownership.json'), JSON.stringify({ ...ownership, owner:'brimdor' }));
    if (process.env.TEST_ARTIFACT_RUN) lease = testStorage.negativeFixtureLease({ kind:'vm-root', root }, import.meta.url);
    symlinkSync(root,alias); lease?.aliasReady();
    const linked = invoke(alias);
    assert.equal(linked.status,1); assert.match(linked.stderr,/macos-vm-root-unverified/);
    assert.equal(readFileSync(marker,'utf8'),'unrelated synthetic content'); assert.equal(existsSync(alias),true);
  } finally { lease?.closing(); rmSync(alias,{force:true}); rmSync(root,{recursive:true}); lease?.release(); }
});

test('Ungated legacy VM setup preserves its supplied root and neighboring data', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-54-macos-worker-')));
  const neighbor = realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-54-macos-neighbor-')));
  chmodSync(root,0o700); chmodSync(neighbor,0o700);
  const marker = join(neighbor,'preserve.txt'); writeFileSync(marker,'synthetic neighbor',{mode:0o600});
  writeFileSync(join(root,'ownership.json'),JSON.stringify({root,issue:54,owner:'brimdor',bytes:26637307067,
    sha256:'2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1'}),{mode:0o600});
  try {
    const result = spawnSync(process.execPath,[fileURLToPath(new URL('./desktop-macos-vm.mjs',import.meta.url)),'--owned-root',root],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,1);
    assert.match(result.stderr,/macos-vm-root-unverified/);
    assert.equal(existsSync(root),true); assert.equal(readFileSync(marker,'utf8'),'synthetic neighbor');
  } finally { rmSync(root,{recursive:true,force:true}); rmSync(neighbor,{recursive:true}); }
});

test('VM producer refuses missing, relative, public and aliased temporary roots before creating resources', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-54-vm-context-'))), alias = root + '-alias';
  chmodSync(root,0o755); writeFileSync(join(root,'preserve.txt'),'synthetic caller data',{mode:0o600});
  try {
    symlinkSync(root,alias);
    for (const temporary of [undefined,'relative-temp',root,alias]) {
      const environment = {...process.env};
      if (temporary === undefined) delete environment.TMPDIR; else environment.TMPDIR = temporary;
      const result = spawnSync(process.execPath,[fileURLToPath(new URL('./desktop-macos-vm.mjs',import.meta.url)),'--bridge'],{env:environment,encoding:'utf8',timeout:10000});
      assert.equal(result.status,1); assert.match(result.stderr,/macos-vm-context-required/); assert.equal(result.stdout,'');
      assert.deepEqual(readdirSync(root),['preserve.txt']); assert.equal(readFileSync(join(root,'preserve.txt'),'utf8'),'synthetic caller data');
      if (temporary === root) chmodSync(root,0o700); // The alias case must fail despite a private destination.
    }
  } finally { rmSync(alias,{force:true}); rmSync(root,{recursive:true}); }
});

test('Leased restore keeps the original inode and refuses oversize, wrong hash and nonempty roles', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-54-restore-input-'))); chmodSync(root,0o700);
  const body = Buffer.from('synthetic restore'), expected = {bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')};
  try {
    for (const [name,bytes,metadata,error] of [
      ['valid',body,expected,null],['oversize',Buffer.concat([body,body]),expected,/macos-restore-size-exceeded/],
      ['hash',body,{...expected,sha256:'0'.repeat(64)},/macos-restore-image-unverified/],
      ['short',body.subarray(1),expected,/macos-restore-image-unverified/],
    ]) {
      const path = join(root,name); writeFileSync(path,'',{mode:0o600});
      const before = lstatSync(path);
      const action = writeLeasedRestore(path,Readable.from([bytes]),metadata,new AbortController().signal);
      if (error) await assert.rejects(action,error); else { const value = await action; assert.equal(value.bytes,body.length); assert.equal(value.inode,before.ino); assert.deepEqual(readFileSync(path),body); }
      const after = lstatSync(path); assert.equal(after.dev,before.dev); assert.equal(after.ino,before.ino);
      if (after.size > 0) await assert.rejects(writeLeasedRestore(path,Readable.from([body]),expected,new AbortController().signal),/macos-restore-role-unverified/);
      else assert.equal(after.size,0);
    }
  } finally { rmSync(root,{recursive:true}); }
});
