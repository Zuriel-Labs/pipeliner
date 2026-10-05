import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openVault} from '../connections/vault.mjs';
import {openPrivacyStore} from './store.mjs';

// Synthetic OS wrapper only; native Electron testing supplies actual Keychain evidence.
const protection={available:async()=>true,encrypt:async text=>Buffer.from(text.split('').reverse().join('')),decrypt:async bytes=>({result:bytes.toString().split('').reverse().join(''),shouldReEncrypt:false})};
async function fixture(options={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-privacy-test-')));let vault,store;
  const {wrapVault,...controls}=options;
  function close(){try{store?.close();}finally{try{vault?.close();}finally{rmSync(root,{recursive:true});assert.equal(existsSync(root),false);}}}
  try{vault=await openVault(root,protection);store=openPrivacyStore(root,{vault:wrapVault?wrapVault(vault):vault,...controls});}
  catch(error){close();throw error;}
  return {root,vault,get store(){return store;},reopen(){store.close();store=openPrivacyStore(root,{vault:wrapVault?wrapVault(vault):vault,...controls});},close};
}
const day=86400000;
test('private payloads persist encrypted, scope reads and reject substituted metadata/ciphertext',async()=>{
  const f=await fixture({clock:()=>1000});
  try{
    const first=f.store.append({repository:'first',category:'conversation',value:{role:'pm',text:'private first conversation'},completedAt:1000});
    const second=f.store.append({repository:'second',category:'conversation',value:{role:'pm',text:'private other conversation'},completedAt:1000});
    for(const suffix of ['', '-wal'])if(existsSync(join(f.root,'privacy.sqlite'+suffix)))assert.equal(readFileSync(join(f.root,'privacy.sqlite'+suffix)).includes('private first conversation'),false);
    f.reopen();assert.equal(f.store.list('first','conversation')[0].value.text,'private first conversation');assert.equal(f.store.list('second','conversation')[0].id,second.id);
    const db=new DatabaseSync(join(f.root,'privacy.sqlite'));db.prepare('UPDATE privacy_records SET payload=(SELECT payload FROM privacy_records WHERE id=?) WHERE id=?').run(first.id,second.id);db.close();
    assert.throws(()=>f.store.list('second','conversation'),/protected-payload-invalid/);
    assert.equal(f.store.list('first','conversation')[0].id,first.id);assert.throws(()=>f.store.list('first','conversation',{limit:101}),/Privacy page/);
  }finally{f.close();}
});
test('retention uses category limits, completion and current recovery holds while preserving other data',async()=>{
  let clock=1000;const f=await fixture({clock:()=>clock,held:(repo,run)=>repo==='first'&&run==='active'});
  try{
    writeFileSync(join(f.root,'neighbor.txt'),'preserve');
    f.store.append({repository:'first',category:'conversation',value:'expired conversation',completedAt:clock});
    f.store.append({repository:'first',category:'log',runId:'active',value:'held log',completedAt:clock});
    f.store.append({repository:'first',category:'log',runId:'complete',value:'expired log',completedAt:clock});
    f.store.append({repository:'first',category:'audit',value:'longer audit',completedAt:clock});
    f.store.append({repository:'second',category:'conversation',value:'unresolved conversation'});
    clock+=91*day;const result=f.store.expire();assert.equal(result.deleted,2);assert.equal(result.retainedRecovery,1);
    assert.equal(f.store.list('first','log')[0].value,'held log');assert.equal(f.store.list('first','audit').length,1);assert.equal(f.store.list('second','conversation').length,1);
    assert.equal(readFileSync(join(f.root,'neighbor.txt'),'utf8'),'preserve');
  }finally{f.close();}
});
test('scoped deletion needs exact unchanged preview, excludes recovery and applies once',async()=>{
  let clock=1000,held=false;const f=await fixture({clock:()=>clock,held:repo=>held&&repo==='first'});
  try{
    f.store.append({repository:'first',category:'conversation',value:'first'});f.store.append({repository:'second',category:'conversation',value:'second'});
    const stale=f.store.previewDeletion('first',['conversation']);f.store.append({repository:'first',category:'audit',value:'new'});
    assert.throws(()=>f.store.delete(stale),/Privacy preview changed/);assert.equal(f.store.list('first','conversation').length,1);
    const changingHold=f.store.previewDeletion('first',['conversation']);held=true;assert.throws(()=>f.store.delete(changingHold),/Privacy preview changed/);
    const protectedPreview=f.store.previewDeletion('first',['conversation']);assert.equal(protectedPreview.retainedRecovery,1);assert.equal(protectedPreview.count,0);
    held=false;const p=f.store.previewDeletion('first',['conversation']);assert.throws(()=>f.store.delete({...p,count:999}),/Privacy preview changed/);
    assert.equal(f.store.delete(p).deleted,1);assert.equal(f.store.delete(p).applied,false);assert.equal(f.store.list('second','conversation').length,1);
    const expired=f.store.previewDeletion('first',['audit']);clock+=900001;assert.throws(()=>f.store.delete(expired),/Privacy preview expired/);
    clock=0;assert.throws(()=>f.store.append({repository:'first',category:'audit',value:'bad clock'}),/Privacy clock/);
  }finally{f.close();}
});
test('verbose allocation rotates only completed unprotected logs and rolls back an allocation blocked by recovery',async()=>{
  const limits=()=>({conversationDays:90,logDays:30,auditDays:365,runLogBytes:500,totalLogBytes:900});let clock=1;
  const f=await fixture({clock:()=>clock++,limits,held:(repo,run)=>run==='active'});
  try{
    const first=f.store.append({repository:'first',category:'log',runId:'done',value:'a'.repeat(100),completedAt:1});
    f.store.append({repository:'first',category:'log',runId:'done',value:'b'.repeat(100),completedAt:1});
    assert.equal(f.store.list('first','log').some(row=>row.id===first.id),false);
    f.store.append({repository:'second',category:'log',runId:'active',value:'c'.repeat(100),completedAt:1});
    const before=f.store.inventory();assert.throws(()=>f.store.append({repository:'second',category:'log',runId:'active',value:'d'.repeat(100),completedAt:1}),/Protected recovery/);
    assert.deepEqual(f.store.inventory(),before);assert.equal(f.store.list('second','log')[0].value,'c'.repeat(100));
  }finally{f.close();}
});
test('unavailable protection does not create a plaintext privacy database',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'pipeliner-privacy-unavailable-')));
  try{assert.throws(()=>openPrivacyStore(root,{}),/Privacy protection unavailable/);assert.equal(existsSync(join(root,'privacy.sqlite')),false);}finally{rmSync(root,{recursive:true});}
});

test('changing plaintext completion or run metadata cannot release protected retention',async()=>{
  let clock=1000;const f=await fixture({clock:()=>clock,held:(_repo,run)=>run==='active'});
  try{
    const row=f.store.append({repository:'first',category:'log',runId:'active',completedAt:1000,value:'recovery evidence'});
    const db=new DatabaseSync(join(f.root,'privacy.sqlite'));db.prepare('UPDATE privacy_records SET run_id=NULL,completed_at=0 WHERE id=?').run(row.id);db.close();
    clock+=366*day;assert.throws(()=>f.store.expire(),/protected-payload-invalid/);
    assert.throws(()=>f.store.previewDeletion('first',['log']),/protected-payload-invalid/);
    assert.equal(f.store.inventory().categories[0].count,1);
  }finally{f.close();}
});
test('failed global allocation restores logs already reclaimed for its per-run limit',async()=>{
  let clock=1,totalLogBytes=1500;
  const f=await fixture({clock:()=>clock++,limits:()=>({conversationDays:90,logDays:30,auditDays:365,runLogBytes:500,totalLogBytes}),held:(_repo,run)=>run?.startsWith('active')??false});
  try{
    const old=f.store.append({repository:'first',category:'log',runId:'done',value:'a'.repeat(100),completedAt:1});
    for(const runId of ['active-one','active-two'])f.store.append({repository:'second',category:'log',runId,value:'b'.repeat(100),completedAt:1});
    const before=f.store.inventory();totalLogBytes=before.categories.reduce((sum,row)=>sum+row.bytes,0)-1;
    assert.throws(()=>f.store.append({repository:'first',category:'log',runId:'done',value:'c'.repeat(100),completedAt:1}),/Protected recovery/);
    assert.deepEqual(f.store.inventory(),before);assert.equal(f.store.list('first','log')[0].id,old.id);
  }finally{f.close();}
});
test('retention uses current limits and the exact completion boundary, with restart and closed protection denial',async()=>{
  let clock=1000,days=2;const f=await fixture({clock:()=>clock,limits:()=>({conversationDays:days,logDays:30,auditDays:365,runLogBytes:500,totalLogBytes:900})});
  try{
    f.store.append({repository:'first',category:'conversation',value:'completed',completedAt:clock});f.reopen();
    clock+=day-1;days=1;assert.equal(f.store.expire().deleted,0);clock++;assert.equal(f.store.expire().deleted,1);
    f.store.close();f.vault.close();assert.throws(()=>openPrivacyStore(f.root,{vault:f.vault}),/Privacy protection unavailable/);
  }finally{f.close();}
});
test('bounded deletion pages advance past held records and leave the other repository untouched',async()=>{
  const f=await fixture({clock:()=>1000,held:(_repo,run)=>run==='held'});
  try{
    for(let index=0;index<6;index++)f.store.append({repository:'first',category:'audit',runId:index===2?'held':'done',value:index});
    f.store.append({repository:'second',category:'audit',value:'preserve'});
    let after=null,deleted=0,retained=0;
    for(let page=0;page<3;page++){
      const preview=f.store.previewDeletion('first',['audit'],{after,limit:2});
      assert.ok(preview.count+preview.retainedRecovery<=2);deleted+=f.store.delete(preview).deleted;retained+=preview.retainedRecovery;after=preview.next;
      assert.equal(preview.more,page<2);
    }
    assert.equal(deleted,5);assert.equal(retained,1);assert.equal(f.store.list('first','audit').length,1);assert.equal(f.store.list('second','audit')[0].value,'preserve');
  }finally{f.close();}
});
test('read pages bound total bytes and resume without skipping large payloads',async()=>{
  let clock=1000;const f=await fixture({clock:()=>clock++});
  try{
    for(let index=0;index<5;index++)f.store.append({repository:'first',category:'conversation',value:{index,text:'x'.repeat(500000)}});
    const page=f.store.list('first','conversation',{limit:100});assert.equal(page.length,4);
    const next=f.store.list('first','conversation',{limit:100,before:page.at(-1).id});assert.equal(next.length,1);
    assert.equal(new Set([...page,...next].map(row=>row.value.index)).size,5);
  }finally{f.close();}
});
test('conversation receipts apply once and encrypted scoped drafts never become authority or log history',async()=>{
  const f=await fixture({clock:()=>1000});
  try{
    const input={id:'receipt-one',repository:'first',category:'conversation',runId:'messages',value:{role:'pm',text:'show privacy'},completedAt:1000};
    assert.equal(f.store.append(input).applied,true);assert.equal(f.store.append(input).applied,false);
    assert.throws(()=>f.store.append({...input,repository:'second'}),/Privacy record conflict/);
    f.store.saveDraft('first','unfinished private draft');f.store.saveDraft('second','other draft');f.reopen();
    assert.equal(f.store.draft('first'),'unfinished private draft');assert.equal(f.store.draft('second'),'other draft');
    assert.equal(f.store.list('first','conversation',{runId:'messages'}).length,1);
    assert.equal(readFileSync(join(f.root,'privacy.sqlite')).includes('unfinished private draft'),false);
    f.store.saveDraft('first','');assert.equal(f.store.draft('first'),'');assert.equal(f.store.draft('second'),'other draft');
    assert.equal(f.store.list('first','conversation',{runId:'messages'})[0].value.role,'pm');assert.equal(f.store.apply,undefined);
  }finally{f.close();}
});
test('deletion and its minimal encrypted receipt commit together or preserve the original records',async()=>{
  let failReceipt=true;
  const f=await fixture({clock:()=>1000,wrapVault:vault=>({openPayload:(...args)=>vault.openPayload(...args),sealPayload:(binding,...args)=>{
    if(failReceipt&&binding.id.startsWith('delete-'))throw new Error('synthetic receipt failure');return vault.sealPayload(binding,...args);
  }})});
  try{
    f.store.append({repository:'first',category:'conversation',value:'private conversation'});
    f.store.append({repository:'second',category:'audit',value:'other repository'});
    const before=f.store.inventory(),preview=f.store.previewDeletion('first',['conversation']);
    assert.throws(()=>f.store.delete(preview),/synthetic receipt failure/);assert.deepEqual(f.store.inventory(),before);
    assert.equal(f.store.list('first','conversation')[0].value,'private conversation');
    failReceipt=false;assert.equal(f.store.delete(preview).deleted,1);assert.equal(f.store.list('first','conversation').length,0);
    const receipt=f.store.list(null,'audit')[0];assert.equal(receipt.value.operation,'delete');assert.equal(receipt.value.deleted,1);
    assert.equal(JSON.stringify(receipt.value).includes('first'),false);assert.equal(JSON.stringify(receipt.value).includes('private conversation'),false);
    assert.equal(f.store.list('second','audit')[0].value,'other repository');
    assert.equal(readFileSync(join(f.root,'privacy.sqlite')).includes('private conversation'),false);
  }finally{f.close();}
});
