import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, writeFile, symlink, link, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGuestReport } from './bridge-data.mjs';

test('Guest reports reject stale, foreign, linked, oversized and hostile evidence without a host effect', { skip:process.platform !== 'darwin' || process.arch !== 'arm64' },async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'pipeliner-54-bridge-data-'))); await chmod(root,0o700);
  const nonce='a'.repeat(32), path=join(root,'agent-result.json'), neighbor=join(root,'neighbor');
  const value={nonce,clicked:true,guestLaunchEscapeContained:true};
  try {
    await writeFile(path,JSON.stringify(value),{mode:0o600});
    assert.deepEqual(await readGuestReport(root,'agent-result.json',nonce),value);
    await assert.rejects(readGuestReport(root,'agent-result.json','b'.repeat(32)),/stale/);
    await assert.rejects(readGuestReport(root,'../neighbor',nonce),/context-unqualified/);
    await writeFile(path,JSON.stringify({...value,hostCommand:'unapproved'})); await assert.rejects(readGuestReport(root,'agent-result.json',nonce));
    await writeFile(path,JSON.stringify({...value,clicked:'true'})); await assert.rejects(readGuestReport(root,'agent-result.json',nonce),/type-unqualified/);
    await writeFile(path,JSON.stringify({nonce,clicked:true})); await assert.rejects(readGuestReport(root,'agent-result.json',nonce));
    await writeFile(path,' '.repeat(16385)); await assert.rejects(readGuestReport(root,'agent-result.json',nonce),/file-unqualified/);
    await unlink(path); await writeFile(neighbor,JSON.stringify(value),{mode:0o600}); await symlink(neighbor,path);
    await assert.rejects(readGuestReport(root,'agent-result.json',nonce)); await unlink(path); await link(neighbor,path);
    await assert.rejects(readGuestReport(root,'agent-result.json',nonce),/file-unqualified/);
    await unlink(path); await writeFile(path,JSON.stringify(value),{mode:0o644});
    await assert.rejects(readGuestReport(root,'agent-result.json',nonce),/file-unqualified/);
    await symlink(neighbor,join(root,'returned-link.json'));
    await assert.rejects(readGuestReport(root,'returned-link.json',nonce),{code:'ELOOP'});
    const ready={nonce,pid:2,window:1,buttonX:1023,buttonY:767,neighborReadDenied:true,neighborWriteDenied:true,
      readOnlyWriteDenied:true,escapeLinkReadDenied:true,descendantDenied:true,targetBundle:`/Users/pipeliner/Library/Caches/pipeliner-54-app-${nonce}/Target.app`,signatureVerified:true,actualGuestWindowVerified:true};
    const readyPath=join(root,'agent-ready.json');
    await writeFile(readyPath,JSON.stringify(ready),{mode:0o600});assert.deepEqual(await readGuestReport(root,'agent-ready.json',nonce),ready);
    for(const changes of [{buttonX:1024},{buttonY:-1},{buttonX:null},{pid:2.5},{window:0},{targetBundle:'/Applications/Foreign.app'},{actualGuestWindowVerified:'true'}]) {
      await writeFile(readyPath,JSON.stringify({...ready,...changes}));await assert.rejects(readGuestReport(root,'agent-ready.json',nonce));
    }
  } finally { await rm(root,{recursive:true}); }
});
