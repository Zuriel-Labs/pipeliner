import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { embedIntegrityDigest } from './integrity.mjs';

test('Framework integrity slot binds the exact archive metadata and preserves neighboring bytes',()=>{
  const sentinel=Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A'),before=Buffer.from('before'),after=Buffer.from('after');
  const source=Buffer.concat([before,sentinel,Buffer.alloc(34),after]),header='ab'.repeat(32);
  const patched=embedIntegrityDigest(source,header);
  const expected=createHash('sha256').update('Resources/app.asar').update('SHA256').update(header).digest();
  const slot=before.length+sentinel.length;
  assert.deepEqual(patched.subarray(slot,slot+34),Buffer.concat([Buffer.from([1,1]),expected]));
  assert.equal(patched.subarray(0,before.length).toString(),'before');assert.equal(patched.subarray(-5).toString(),'after');assert.equal(source[slot],0);
  for(const bytes of [Buffer.from('absent'),Buffer.concat([sentinel,Buffer.alloc(33)]),Buffer.concat([source,source])])assert.throws(()=>embedIntegrityDigest(bytes,header),/package-integrity/);
  const unsupported=Buffer.from(source);unsupported[slot+1]=2;assert.throws(()=>embedIntegrityDigest(unsupported,header),/package-integrity/);
  for(const hash of ['',header+'00','not a hash'])assert.throws(()=>embedIntegrityDigest(source,hash),/package-integrity/);
});
