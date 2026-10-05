import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeInputs, readPackageInput, packagedCodexPath } from './inputs.mjs';

test('Packaged host modules contain their complete repository-owned static import closure',async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const files=runtimeInputs(execFileSync('/usr/bin/git',['-C',root,'ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean)),selected=new Set(files);
  for(const file of files.filter(v=>v.endsWith('.mjs')&&!v.startsWith('desktop/app/'))){
    const source=await readFile(join(root,file),'utf8');
    for(const match of source.matchAll(/(?:from\s+|\bimport\s*\()\s*['"]([^'"]+)['"]/g)){
      if(!match[1].startsWith('.'))continue;
      const target=posix.normalize(posix.join(posix.dirname(file),match[1]));assert.ok(selected.has(target),file+' requires '+target);
    }
  }
});

test('Package selection requires its runtime entry and excludes roadmap, fixtures, tests and developer assets', () => {
  const minimum = ['desktop/app/main.cjs', 'desktop/app/preload.cjs', 'desktop/app/index.html', 'desktop/prototype/style.css', 'desktop/development/starter.mjs', 'desktop/authority/Dockerfile', 'LICENSE'];
  const source = [...minimum, 'docs/pipeliner-desktop-implementation-roadmap.html', 'desktop/app/qualify.cjs', 'desktop/app/startup.test.mjs', 'desktop/codex/qualify.mjs', 'desktop/ollama/qualify.mjs', '.agents/skills/local/SKILL.md', 'desktop/shell/main.cjs', 'desktop/prototype/main.cjs'];
  assert.deepEqual(runtimeInputs(source), minimum.sort());
  for (const value of ['../outside', '/absolute', 'desktop/app/../main.cjs', 'desktop\\app\\main.cjs', 'desktop/app/main.cjs\0extra']) assert.throws(() => runtimeInputs([...minimum,value]), /package-input/);
  assert.throws(() => runtimeInputs(minimum.filter(path => path !== 'desktop/app/preload.cjs')), /package-runtime-missing/);
  assert.throws(() => runtimeInputs([...minimum,minimum[0]]), /package-input/);
});

test('Package input reads refuse linked and altered source while preserving neighboring data', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'pipeliner-54-package-input-')));
  try {
    await mkdir(join(root,'desktop')); await mkdir(join(root,'desktop/app'));
    const file = join(root,'desktop/app/main.cjs'), neighbor = join(root,'preserve');
    await writeFile(file,'reviewed bytes'); await writeFile(neighbor,'synthetic unrelated bytes');
    assert.equal((await readPackageInput(root,'desktop/app/main.cjs',Buffer.from('reviewed bytes'))).toString(),'reviewed bytes');
    await assert.rejects(readPackageInput(root,'desktop/app/main.cjs',Buffer.from('other candidate')),/package-input/);
    await rm(file); await symlink(neighbor,file);
    await assert.rejects(readPackageInput(root,'desktop/app/main.cjs',Buffer.from('synthetic unrelated bytes')),/package-input/);
    await rm(file); await rm(join(root,'desktop/app'),{recursive:true}); await symlink(root,join(root,'desktop/app'));
    await assert.rejects(readPackageInput(root,'desktop/app/preserve',Buffer.from('synthetic unrelated bytes')),/package-input/);
    assert.equal(await readFile(neighbor,'utf8'),'synthetic unrelated bytes');
  } finally { await rm(root,{recursive:true}); }
});

test('Packaged Codex executable uses the bundled helper; source mode keeps its qualified development CLI', () => {
  assert.equal(packagedCodexPath({packaged:true,resourcesPath:'/private/owned/Pipeliner.app/Contents/Resources'}),'/private/owned/Pipeliner.app/Contents/Resources/helpers/codex');
  assert.equal(packagedCodexPath({packaged:false}),'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  for(const resourcesPath of [undefined,'relative','/private/owned/../other','/private/owned\0extra']) assert.throws(()=>packagedCodexPath({packaged:true,resourcesPath}),/package-provider-path/);
});
