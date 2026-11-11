'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {MemoryService}=require('../src/main/memory-service');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function memory(request){
  const service=Object.create(MemoryService.prototype);
  Object.assign(service,{generation:1,epoch:1,recent:[],scene:()=> 'life',clock:()=>1000,
    serial:fn=>Promise.resolve().then(fn),decode:row=>row,encode:row=>row,notifyChange:async()=>{},scheduleExtraction(){},db:{request}});
  return service;
}
test('a generated answer waiting in the memory serial lane is cancelled before it reads or writes',async()=>{
  const gate=deferred(),controller=new AbortController();let calls=0;
  const service=memory(async()=>{calls++;return {rows:[]};});service.serial=fn=>gate.promise.then(fn);
  const result=service.addMessageOnce('reply:fixture','assistant','obsolete answer',{delivery:'generated',signal:controller.signal});
  controller.abort();gate.resolve();await assert.rejects(result,{code:'ABORT_ERR'});assert.equal(calls,0);
});
test('cancellation during final source checks prevents a late generated record from reaching the database',async()=>{
  const gate=deferred(),entered=deferred();let reads=0,writes=0,current=true;
  const parent={id:'owner:fixture',kind:'message',domain:'life',visibilityFloor:1,value:{role:'user',characterId:'owner',content:'fixture question'}};
  const service=memory(async(name,args)=>{
    if(name==='write'){writes++;return {epoch:2};}
    reads++;if(reads===3){entered.resolve();await gate.promise;}
    return {rows:args.ids.includes(parent.id)?[parent]:[]};
  });
  const result=service.addMessageOnce('reply:fixture','assistant','obsolete answer',{delivery:'generated',sources:[parent.id],isCurrent:()=>current});
  await entered.promise;current=false;gate.resolve();await assert.rejects(result,{code:'ABORT_ERR'});assert.equal(writes,0);assert.equal(service.recent.length,0);
});
