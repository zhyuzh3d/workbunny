'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createLocalDialogueControl}=require('../src/main/local-dialogue-control');
const {ownerMethods}=require('../src/main/local-control');
function fixture(){
 let scene='life',scope='epoch:1:life',ready=true,completion;
 const calls=[],controls=createLocalDialogueControl({getScene:()=>scene,getScope:()=>scope,isReady:()=>ready,submit:async(text,{onComplete})=>{calls.push(text);completion=Promise.withResolvers();onComplete(completion.promise);return {ok:true};}});
 return {controls,calls,setScene:s=>{scene=s;},setScope:s=>{scope=s;},setReady:v=>{ready=v;},complete:r=>completion.resolve(r)};
}
test('owner text admission returns immediately; its own reply and task receipt can be checked without history access',async()=>{
 const f=fixture();assert.equal((await f.controls.send({text:'hello',requestId:'owner-1'})).status,'pending');
 f.complete({text:'received',actionReceipt:{taskId:'new-task'},hidden:'never expose transport'});await Promise.resolve();
 assert.deepEqual(f.controls.status({id:'owner-1'}).reply,'received');assert.equal(f.controls.status({id:'owner-1'}).taskId,'new-task');assert(!JSON.stringify(f.controls.status({id:'owner-1'})).includes('hidden'));
});
test('same request ID never resubmits an accepted message; different text is refused',async()=>{
 const f=fixture();await f.controls.send({text:'hello',requestId:'owner-1'});await f.controls.send({text:'hello',requestId:'owner-1'});assert.deepEqual(f.calls,['hello']);
 await assert.rejects(f.controls.send({text:'different',requestId:'owner-1'}),{code:'E_LOCAL_PARAMS'});
 f.complete(null);await Promise.resolve();assert.equal(f.controls.status({id:'owner-1'}).status,'interrupted');
});
test('a submitted dialogue exposes only its actual avatar readiness receipt alongside its reply',async()=>{
 const f=fixture(),avatar={key:'synthetic-avatar',name:'合成形象',changed:true,ready:true};
 await f.controls.send({text:'换个形象',requestId:'avatar-receipt'});
 f.complete({text:'换好啦。',actionReceipt:{ok:true,avatar},internal:'never expose transport'});await Promise.resolve();
 const result=f.controls.status({id:'avatar-receipt'});
 assert.equal(result.status,'completed');assert.equal(result.reply,'换好啦。');assert.deepEqual(result.avatar,avatar);assert.equal(result.taskId,undefined);
 assert(!JSON.stringify(result).includes('never expose transport'));
});
test('private, locked, cancelled or stale receipt scopes do not submit or reveal messages',async()=>{
 const f=fixture();for(const scene of ['work','private']){f.setScene(scene);await assert.rejects(f.controls.send({text:'hello'}),{code:'E_LOCAL_SCENE'});assert.throws(()=>f.controls.status({id:'owner-1'}),{code:'E_LOCAL_SCENE'});}
 assert.equal(f.calls.length,0);f.setScene('life');f.setReady(false);await assert.rejects(f.controls.send({text:'hello'}),{code:'E_LOCAL_UNAVAILABLE'});f.setReady(true);
 const c=new AbortController();c.abort();await assert.rejects(f.controls.send({text:'hello'},{signal:c.signal}),{code:'E_LOCAL_CANCELLED'});assert.equal(f.calls.length,0);
 await f.controls.send({text:'hello',requestId:'owner-1'});f.setScope('epoch:2:life');f.complete({text:'old reply'});await Promise.resolve();assert.throws(()=>f.controls.status({id:'owner-1'}),{code:'E_LOCAL_RECEIPT'});
});
test('unaccepted text reports rejection; new requests can still interrupt a pending normal conversation',async()=>{
 const f=fixture();await f.controls.send({text:'old',requestId:'old'});await f.controls.send({text:'stop',requestId:'stop'});assert.deepEqual(f.calls,['old','stop']);
 const controls=createLocalDialogueControl({getScene:()=> 'life',getScope:()=> '1',isReady:()=>true,submit:async()=>({ok:false,error:'model unavailable'})});
 const result=await controls.send({text:'hello'});assert.equal(result.status,'rejected');assert.equal(result.error,'model unavailable');
});
test('shared MCP registry exposes only send and exact current-process receipt queries',async()=>{
 const f=fixture(),methods=ownerMethods({getScene:()=> 'life',setScene:()=>{},boperControl:()=>({}),dialogueControls:f.controls});
 const call=(name,args)=>methods['tools.call'].execute({name,arguments:args},{signal:new AbortController().signal});
 const sent=await call('dialogue_send',{text:'hello',requestId:'owner-1'});assert.equal(sent.structuredContent.status,'pending');
 assert.equal((await call('dialogue_status',{id:'owner-1'})).structuredContent.status,'pending');
 for(const args of [{text:'hello',scene:'private'},{text:'hello',internal:true},{text:'hello',requestId:'../escape'}])assert.equal((await call('dialogue_send',args)).structuredContent.error.code,'E_LOCAL_PARAMS');
 assert.equal((await call('dialogue_status',{id:'history'})).structuredContent.error.code,'E_LOCAL_RECEIPT');
});
