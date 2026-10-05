import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLocal } from './local.mjs';
import { inspectWorkspace, workspaceData } from '../core/identity.mjs';

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-54-inspect-')));
  const git = (...args) => execFileSync('/usr/bin/git', ['-c','core.hooksPath=/dev/null','-C',directory,...args], { env:{ PATH:'/usr/bin:/bin', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null' }, stdio:'pipe' });
  git('init'); git('remote','add','origin','https://github.com/Example/Fixture.git');
  await writeFile(join(directory,'tracked'),'original'); git('add','tracked'); git('-c','user.name=Synthetic','-c','user.email=fixture@example.invalid','commit','-m','fixture');
  return { directory, git, remote:{ repository:'fixture',owner:'Example',name:'Fixture' } };
}

test('Asynchronous inspection preserves canonical identity, working changes and remote denial', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory,'tracked'),'changed'); await writeFile(join(f.directory,'neighbor'),'preserve');
    const result = await inspectLocal(f.directory,f.remote);
    assert.deepEqual(result.identity, workspaceData(inspectWorkspace(f.directory,f.remote)));
    assert.equal(result.slug,'example/fixture'); assert.deepEqual(result.changes,{ tracked:1,untracked:1 });
    await assert.rejects(inspectLocal(f.directory,{...f.remote,name:'Other'}),/local-identity-invalid/);
    f.git('config','remote.origin.pushurl','https://github.com/Example/Other.git');
    await assert.rejects(inspectLocal(f.directory,f.remote),/local-identity-invalid/);
    f.git('config','--unset','remote.origin.pushurl'); f.git('config','--add','remote.origin.url','https://github.com/Example/Other.git');
    await assert.rejects(inspectLocal(f.directory,f.remote),/local-identity-invalid/);
    assert.equal(await readFile(join(f.directory,'neighbor'),'utf8'),'preserve');
  } finally { await rm(f.directory,{recursive:true}); }
});

test('Cancellation closes the actual owned Git group before inspection rejects', async () => {
  const f = await fixture(), controller = new AbortController(), events = [];
  try {
    await assert.rejects(inspectLocal(f.directory,f.remote,controller.signal,{ onProcess:event=>{events.push(event);if(event.state==='started')controller.abort();} }));
    assert.equal(events.length,2); assert.equal(events[0].state,'started'); assert.equal(events[1].state,'closed');
    assert.equal(events[0].pid,events[1].pid); assert.ok(Number.isSafeInteger(events[0].pid));
    const rows=execFileSync('/bin/ps',['-axo','pid=,pgid='],{encoding:'utf8'}).split('\n');
    assert.equal(rows.some(line=>line.trim().split(/\s+/)[1]===String(events[0].pid)),false);
    assert.equal(await readFile(join(f.directory,'tracked'),'utf8'),'original');
  } finally { await rm(f.directory,{recursive:true}); }
});
