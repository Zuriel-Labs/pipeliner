import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, writeFileSync, readFileSync, realpathSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('Mac qualification refuses foreign ownership and aliases without deleting their contents', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-macos-worker-'))), alias = root + '-alias';
  chmodSync(root, 0o700);
  const marker = join(root, 'preserve.txt'); writeFileSync(marker, 'unrelated synthetic content', { mode: 0o600 });
  const ownership = { root, issue:54, owner:'other-owner', bytes:26637307067, sha256:'2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1' };
  const invoke = path => spawnSync(process.execPath, [fileURLToPath(new URL('./desktop-macos-vm.mjs', import.meta.url)), '--owned-root', path], { encoding:'utf8', timeout:10000 });
  try {
    writeFileSync(join(root,'ownership.json'), JSON.stringify(ownership), { mode:0o600 });
    const foreign = invoke(root);
    assert.equal(foreign.status,1); assert.match(foreign.stderr,/macos-vm-root-unverified/);
    assert.equal(readFileSync(marker,'utf8'),'unrelated synthetic content');
    writeFileSync(join(root,'ownership.json'), JSON.stringify({ ...ownership, owner:'brimdor' }));
    symlinkSync(root,alias);
    const linked = invoke(alias);
    assert.equal(linked.status,1); assert.match(linked.stderr,/macos-vm-root-unverified/);
    assert.equal(readFileSync(marker,'utf8'),'unrelated synthetic content'); assert.equal(existsSync(alias),true);
  } finally { rmSync(alias,{force:true}); rmSync(root,{recursive:true}); }
});

test('Failed owned VM setup removes only its recorded root and preserves neighboring data', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-54-macos-worker-')));
  const neighbor = realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-54-macos-neighbor-')));
  chmodSync(root,0o700); chmodSync(neighbor,0o700);
  const marker = join(neighbor,'preserve.txt'); writeFileSync(marker,'synthetic neighbor',{mode:0o600});
  writeFileSync(join(root,'ownership.json'),JSON.stringify({root,issue:54,owner:'brimdor',bytes:26637307067,
    sha256:'2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1'}),{mode:0o600});
  try {
    const result = spawnSync(process.execPath,[fileURLToPath(new URL('./desktop-macos-vm.mjs',import.meta.url)),'--owned-root',root],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,1);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.exactOwnedVMRootRemoved,true); assert.equal(report.ownedProcessClosed,true);
    assert.equal(existsSync(root),false); assert.equal(readFileSync(marker,'utf8'),'synthetic neighbor');
  } finally { rmSync(root,{recursive:true,force:true}); rmSync(neighbor,{recursive:true}); }
});
