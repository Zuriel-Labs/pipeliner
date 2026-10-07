import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

test('Developer receipt reads stop at their byte bound and reject changed custody', () => {
  const require = createRequire(import.meta.url), file = '/synthetic/owned-receipt';
  const source = fs.readFileSync(new URL('./desktop-test-process.cjs', import.meta.url), 'utf8');
  const initial = { dev:7n, ino:42n, uid:BigInt(process.getuid()), mode:0o100600n,
    nlink:1n, size:4n, mtimeNs:1n, ctimeNs:1n, isFile:()=>true };
  let bytes = Buffer.from('safe'), changed = {}, before = initial, offset = 0, closed = 0, reads = 0;
  const io = { ...fs, realpathSync:path=>path===file?file:fs.realpathSync(path), openSync:()=>99,
    fstatSync:()=>before, lstatSync:()=>({...before,...changed}), closeSync:()=>closed++,
    readFileSync:()=>{ throw Error('unbounded-read'); },
    readSync:(_fd, buffer, start, length)=>{
      reads++; const count=Math.min(length,bytes.length-offset);
      bytes.copy(buffer,start,offset,offset+count);offset+=count;return count;
    } };
  const context = { require:name=>name==='node:fs'?io:require(name), exports:{},
    __dirname:new URL('.', import.meta.url).pathname, process, Buffer, Atomics, Int32Array, SharedArrayBuffer };
  runInNewContext(source+'\nexports.readReceiptForCheck = owned;',context);
  const read = context.exports.readReceiptForCheck;
  assert.equal(read(file,8).toString(),'safe');assert.equal(closed,1);
  offset=0;bytes=Buffer.alloc(128);assert.throws(()=>read(file,8),/test-process-file-unverified/);
  assert.equal(offset,9);assert.equal(closed,2);
  offset=0;bytes=Buffer.from('safe');changed={nlink:2n};assert.throws(()=>read(file,8),/test-process-file-unverified/);
  offset=0;changed={mode:0o100622n};assert.throws(()=>read(file,8),/test-process-file-unverified/);
  changed={};before={...initial,isFile:()=>false};reads=0;
  assert.throws(()=>read(file,8),/test-process-file-unverified/);assert.equal(reads,0);assert.equal(closed,5);
});
