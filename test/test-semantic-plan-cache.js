'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planBatch}=require('../src/main/semantic-plan');
const {ContextCompression}=require('../src/main/context-compression');
const actors=require('../src/main/message-identity');

function fixture(){
 const rows=['user','assistant','user','assistant'].map((role,index)=>({id:'fixture-'+index,kind:'message',ts:index+1,ingestionSeq:index+1,
  domain:'work',visibilityFloor:0,value:{role,content:'fixture original text '+index,turnId:'turn-'+Math.floor(index/2),sources:[]}}));
 const watermark={id:'fixture-watermark',kind:'state',ts:0,domain:'work',visibilityFloor:0,value:{watermark:0,sources:[]}};
 const records=new Map([...rows,watermark].map(row=>[row.id,structuredClone(row)]));let now=1000;
 const memory={generation:1,epoch:1,clock:()=>now,records,decode:row=>structuredClone(row),
  db:{request:async(_,{ids})=>({rows:ids.flatMap(id=>records.has(id)?[structuredClone(records.get(id))]:[])})},
  serial:async action=>action(),write:async values=>{for(const row of values){for(const id of row.value.sources)assert(records.has(id));records.set(row.id,structuredClone(row));}},
  blocks:{prepare:async batch=>({status:'done',units:batch.map(actors.inputRow)})}};
 const validateResult=(result,{consumed,sourceRows})=>{
  if(consumed.length)ContextCompression.prototype.validateSummary(result,sourceRows.filter(row=>row.ingestionSeq<=consumed.at(-1).ingestionSeq).map(actors.inputRow));
 };
 return {memory,rows,original:structuredClone([...records.values()]),advance:ms=>{now+=ms;},
  options:{mode:'doze',scope:{domain:'work',visibilityFloor:0},rows,reserveModelCall:async()=>true,validateResult}};
}
const valid=()=>({processedThrough:'fixture-1',content:'fixture navigation',excerpts:[{sourceId:'fixture-0',quote:'original text 0'}]});
const caches=f=>[...f.memory.records.values()].filter(row=>row.value?.origin==='semantic-plan-v1');
function originalsUnchanged(f){for(const row of f.original)assert.deepEqual(f.memory.records.get(row.id),row);}

test('failed quote validation is typed, does not cache or change sources/watermark, and a later retry regenerates',async()=>{
 for(const [sourceId,quote,code] of [['not-in-input','fixture quote','E_CONTEXT_QUOTE_SOURCE_MISSING'],['fixture-0','not original text','E_CONTEXT_QUOTE_MISMATCH']]){
  const f=fixture();let calls=0;
  await assert.rejects(planBatch(f.memory,{...f.options,generate:async()=>{calls++;return {...valid(),excerpts:[{sourceId,quote}]};}}),error=>{
   assert.equal(error.code,code);assert(!error.message.includes(sourceId));assert(!error.message.includes(quote));return true;
  });
  assert.equal(caches(f).length,0);originalsUnchanged(f);
  const result=await planBatch(f.memory,{...f.options,generate:async()=>{calls++;return valid();}});
  assert.equal(calls,2);assert.equal(result.status,'done');assert.deepEqual(result.consumed.map(row=>row.id),['fixture-0','fixture-1']);assert.equal(caches(f).length,1);originalsUnchanged(f);
 }
});
test('a legacy invalid cache is regenerated and safely replaced, then the valid result is reused',async()=>{
 const f=fixture();let calls=0;
 const legacy=await planBatch(f.memory,{...f.options,validateResult:undefined,generate:async()=>({ ...valid(),excerpts:[{sourceId:'fixture-0',quote:'fabricated quote'}] })});
 assert.equal(caches(f).length,1);
 const repaired=await planBatch(f.memory,{...f.options,generate:async()=>{calls++;return valid();}});
 assert.equal(calls,1);assert.equal(repaired.cacheId,legacy.cacheId);assert.deepEqual(caches(f)[0].value.result,valid());
 assert.deepEqual(caches(f)[0].value.sources,f.rows.map(row=>row.id));assert.equal(caches(f)[0].domain,'work');assert.equal(caches(f)[0].visibilityFloor,0);
 const reused=await planBatch(f.memory,{...f.options,generate:async()=>assert.fail('validated result must be reused')});
 assert.deepEqual(reused.result,repaired.result);assert.deepEqual(reused.consumed,repaired.consumed);originalsUnchanged(f);
});
test('a bad legacy cache cannot poison subsequent retries when regeneration also fails',async()=>{
 const f=fixture(),bad={...valid(),excerpts:[{sourceId:'missing','quote':'fixture quote'}]};let calls=0;
 await planBatch(f.memory,{...f.options,validateResult:undefined,generate:async()=>bad});
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(planBatch(f.memory,{...f.options,generate:async()=>{calls++;return bad;}}),{code:'E_CONTEXT_QUOTE_SOURCE_MISSING'});
 assert.equal(calls,2,'each retry must generate again rather than return the rejected cache');originalsUnchanged(f);
});
test('quotes into the unconsumed suffix are rejected before cache admission',async()=>{
 const f=fixture();await assert.rejects(planBatch(f.memory,{...f.options,generate:async()=>({...valid(),excerpts:[{sourceId:'fixture-2',quote:'original text 2'}]})}),{code:'E_CONTEXT_QUOTE_SOURCE_MISSING'});
 assert.equal(caches(f).length,0);originalsUnchanged(f);
});
test('the actual Doze caller validates its consumed-prefix quotes before any plan or head is committed',async()=>{
 const f=fixture();f.memory.query=async()=>[];let commits=0;
 const worker=new ContextCompression({memory:f.memory,recentMessages:20,summarize:async()=>({...valid(),excerpts:[{sourceId:'fixture-3',quote:'original text 3'}]})});
 worker.inspectState=async()=>({invalid:false,head:null});worker.recentCutoff=async()=>4;
 worker.readNextBatch=async()=>({rows:f.rows,turns:2,skippedSecretRounds:0});
 worker.commitBatch=async()=>{commits++;return true;};
 await assert.rejects(worker.run(),{code:'E_CONTEXT_QUOTE_SOURCE_MISSING'});
 assert.equal(commits,0);assert.equal(caches(f).length,0);originalsUnchanged(f);
});
test('domain validation is retained when a deferred plan is forced after its grace period',async()=>{
 const f=fixture();await planBatch(f.memory,{...f.options,generate:async()=>({processedThrough:null})});f.advance(10*60_000);
 await assert.rejects(planBatch(f.memory,{...f.options,generate:async(_,{force})=>{assert.equal(force,true);return {...valid(),excerpts:[{sourceId:'missing','quote':'fixture quote'}]};}}),{code:'E_CONTEXT_QUOTE_SOURCE_MISSING'});
 assert.equal(caches(f).length,1,'only the valid deferred plan remains');originalsUnchanged(f);
});
test('source changes during async cache validation pause reuse without regeneration or watermark changes',async()=>{
 const f=fixture();await planBatch(f.memory,{...f.options,generate:async()=>valid()});
 const result=await planBatch(f.memory,{...f.options,validateResult:async(...args)=>{f.options.validateResult(...args);f.memory.records.get('fixture-0').value.content='updated fixture source';},generate:async()=>assert.fail('changed evidence must pause')});
 assert.equal(result.status,'paused');assert.deepEqual(f.memory.records.get('fixture-watermark'),f.original.at(-1));
});
test('cancellation during validation never admits or regenerates a cached result',async()=>{
 const f=fixture();await planBatch(f.memory,{...f.options,generate:async()=>valid()});const controller=new AbortController();let calls=0;
 const result=await planBatch(f.memory,{...f.options,signal:controller.signal,validateResult:async()=>{controller.abort();throw Error('cancelled fixture');},generate:async()=>{calls++;return valid();}});
 assert.equal(result.status,'paused');assert.equal(calls,0);originalsUnchanged(f);
 for(const change of ['abort','generation']){
  const raced=fixture();await planBatch(raced.memory,{...raced.options,generate:async()=>valid()});
  const pending=new AbortController(),request=raced.memory.db.request;let sourceReads=0;
  raced.memory.db.request=async(...args)=>{
   const result=await request(...args);
   if(args[1].ids.includes('fixture-0')&&++sourceReads===2){if(change==='abort')pending.abort();else raced.memory.generation++;}
   return result;
  };
  const outcome=await planBatch(raced.memory,{...raced.options,signal:pending.signal,generate:async()=>assert.fail('late cancellation must not regenerate')});
  assert.equal(sourceReads,2);assert.equal(outcome.status,'paused');originalsUnchanged(raced);
 }
});
