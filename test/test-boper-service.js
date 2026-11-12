'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {BoperService}=require('../src/main/boper-service');
function fixture({enabled=false,execute,stop,begin}={}){
 const messages=[],authorizations=[],revocations=[];let child;
 const control={status:async()=>({ready:true,state:'ready'}),register:async()=>({}),recover:async()=>({ready:true,releaseConfirmed:true,sessionActive:false,recovered:true}),authorizeRuntime:async value=>{authorizations.push(value);return {delegationToken:'private-test-token'};},renewSession:async()=>({}),revokeSession:async value=>{revocations.push(value);return {};}};
 const service=new BoperService({enabled,control,spawn:(_file,_args,options)=>{
  assert.deepEqual(options.stdio,['pipe','pipe','pipe','pipe']);
  child=new EventEmitter();child.pid=101;child.stdout=new PassThrough();child.stderr=new PassThrough();
  const processChild=child;
  const write=controlPath=>new Writable({write(bytes,_enc,done){const request=JSON.parse(bytes);messages.push({...request,controlPath});queueMicrotask(async()=>{let reply;try{if(request.action==='execute')reply=execute?await execute(request):{reportsSubmitted:4,dispatched:true,clipboardChanged:request.operation.action==='typeText',completion:'local-submitted'};else if(request.action==='beginSession'&&begin)reply=await begin(request);else if(request.action==='stop')reply=stop?await stop(request):{releaseConfirmed:true};else reply={};if(reply===null)return;processChild.stdout.write(JSON.stringify({id:request.id,ok:true,result:reply})+'\n');}catch(error){processChild.stdout.write(JSON.stringify({id:request.id,ok:false,error:{code:error.code||'E_FIXTURE',message:error.message},result:error.result||{dispatched:false}})+'\n');}});done();}});
  child.stdin=write(false);child.stdio=[child.stdin,child.stdout,child.stderr,write(true)];child.kill=()=>queueMicrotask(()=>child.emit('close',0));return child;
 }});
 const context={ownerId:'owner-a',application:'editor',displayBounds:[{x:0,y:0,width:100,height:100}],validate:()=>true};
 return {service,messages,control,context,authorizations,revocations,get child(){return child;}};
}
test('one host input scope serializes native intents and releases on its independent control pipe',async()=>{
 const f=fixture();let checks=0;f.context.validate=()=>{checks++;return true;};
 const first=await f.service.execute({action:'typeText',params:{text:'中文，A\nB'}},f.context,{scopeId:'scope-a',operationId:'operation-a'});
 assert.equal(first.clipboardChanged,true);assert.equal(first.dispatched,true);assert.equal(first.completion,'local-submitted');
 await f.service.execute({action:'key',params:{key:'return'}},f.context,{scopeId:'scope-a',operationId:'operation-b'});
 assert.equal(f.messages.filter(m=>m.action==='beginSession').length,1);assert.equal(f.messages.find(m=>m.action==='beginSession').backend,'cg-event');assert.equal(f.authorizations.length,0);assert(checks>=4);
 await f.service.endScope('owner-a','scope-a');assert.equal(f.messages.at(-1).action,'stop');assert.equal(f.messages.at(-1).controlPath,true);await f.service.shutdown();
});
test('software declarations require VirtualHID for aliases without querying application metadata',async()=>{
 for(const application of ['wechat','微信','com.tencent.xinWeChat','WeChat']){
  const f=fixture();await assert.rejects(f.service.execute({action:'key',params:{key:'a'}},{...f.context,application},{scopeId:'wechat-scope'}),{code:'E_INPUT_BACKEND_REQUIRED'});assert.equal(f.messages.length,0);await f.service.shutdown();
 }
});
test('VirtualHID is exclusive for ordinary software and refuses directed input before any text side effect',async()=>{
 const f=fixture({enabled:true});await f.service.refreshStatus();
 await assert.rejects(f.service.execute({action:'typeText',params:{text:'private',targetPid:123}},f.context,{scopeId:'directed'}),{code:'E_BACKGROUND_UNSUPPORTED'});assert.equal(f.messages.length,0);
 await f.service.execute({action:'key',params:{key:'v',modifiers:['command']}},f.context,{scopeId:'foreground'});
 const begin=f.messages.find(m=>m.action==='beginSession');assert.equal(begin.backend,'virtual-hid');assert.equal(begin.delegationToken,'private-test-token');assert.equal(f.authorizations.length,1);
 await f.service.endScope('owner-a','foreground');assert.equal(f.revocations.length,1);await f.service.shutdown();
});
test('missing or expired host ownership cannot dispatch; cancelling another client leaves the active owner alone',async()=>{
 const f=fixture();await assert.rejects(f.service.execute({action:'key',params:{key:'a'}},{ownerId:'script'},{scopeId:'bad'}),{code:'E_BOPER_CONTEXT'});
 await assert.rejects(f.service.execute({action:'key',params:{key:'a'}},{...f.context,validate:()=>false},{scopeId:'stale'}),{code:'E_BOPER_CONTEXT'});
 await f.service.execute({action:'move',params:{x:5,y:5}},f.context,{scopeId:'first'});
 const count=f.messages.length;assert.equal((await f.service.cancelOwner('other-owner')).unrelatedOwner,true);assert.equal(f.messages.length,count);
 await assert.rejects(f.service.execute({action:'key',params:{key:'a'}},{...f.context,ownerId:'owner-b'},{scopeId:'other'}),{code:'E_BOPER_BUSY'});
 await f.service.shutdown();
});
test('partial clipboard and input effects survive failure, and an unconfirmed release faults further input',async()=>{
 const f=fixture({execute:async()=>{throw Object.assign(Error('paste result unknown'),{code:'E_PASTE_OUTCOME_UNKNOWN',result:{dispatched:true,reportsSubmitted:2,clipboardChanged:true,clipboardChangeCount:8,completion:'unknown'}});},stop:async()=>({releaseConfirmed:false})});
 await assert.rejects(f.service.execute({action:'typeText',params:{text:'private'}},f.context,{scopeId:'uncertain'}),error=>error.dispatched===true&&error.inputOutcome.clipboardChanged===true&&error.inputOutcome.reportsSubmitted===2);
 assert.equal(f.service.status().state,'fault');assert.equal(f.messages.filter(m=>m.action==='execute').length,1);
 await assert.rejects(f.service.execute({action:'key',params:{key:'a'}},f.context,{scopeId:'new'}),{code:'E_BOPER_FAULT'});await f.service.shutdown();
});
test('enabling intent is persistent and fails closed while installation or approval remains incomplete',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'boper-config-'));try{
  const f=fixture();f.service.configure({stateFile:path.join(root,'boper.json')});const status=f.service.setEnabledIntent(true);assert.equal(status.enabled,true);assert.equal(status.state,'unavailable');assert.equal(JSON.parse(fs.readFileSync(path.join(root,'boper.json'))).enabled,true);
  await assert.rejects(f.service.execute({action:'key',params:{key:'a'}},f.context,{scopeId:'pending'}),{code:'E_VIRTUAL_HID_UNAVAILABLE'});assert.equal(f.messages.length,0);
  const restored=new BoperService();restored.configure({stateFile:path.join(root,'boper.json')});assert.equal(restored.status().enabled,true);await restored.shutdown();await f.service.shutdown();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('cancellation during delegation never opens a late session or faults a session that emitted no input',async()=>{
 const f=fixture({enabled:true}),authorization=Promise.withResolvers();f.control.authorizeRuntime=()=>authorization.promise;await f.service.refreshStatus();
 const running=f.service.execute({action:'key',params:{key:'a'}},f.context,{scopeId:'cancel-authorizing'}),rejected=assert.rejects(running,{code:'E_ABORTED'});const stopped=f.service.cancelOwner('owner-a');authorization.resolve({delegationToken:'late-token'});assert.equal((await stopped).releaseConfirmed,true);await rejected;
 assert.equal(f.messages.some(m=>['beginSession','execute','stop'].includes(m.action)),false);assert.equal(f.service.active,null);assert.equal(f.service.status().state,'ready');assert(f.revocations.length>=1);await f.service.shutdown();
});
test('cancellation while beginSession is pending reaps that executor, ignores its late reply and permits a new scope',async()=>{
 const opening=Promise.withResolvers();let first=true;const f=fixture({begin:async()=>{if(first){first=false;return opening.promise;}return {};}});
 const running=f.service.execute({action:'key',params:{key:'a'}},f.context,{scopeId:'cancel-opening'}),rejected=assert.rejects(running,{code:'E_ABORTED'});await new Promise(r=>setImmediate(r));assert(f.messages.some(m=>m.action==='beginSession'));
 assert.equal((await f.service.cancelOwner('owner-a')).releaseConfirmed,true);await rejected;opening.resolve({inputSessionId:'late-open'});await new Promise(r=>setImmediate(r));assert.equal(f.messages.some(m=>m.action==='execute'),false);assert.equal(f.service.status().state,'ready');
 await f.service.execute({action:'key',params:{key:'b'}},f.context,{scopeId:'new-scope'});assert.equal(f.messages.filter(m=>m.action==='execute').length,1);await f.service.shutdown();
});
test('healthy readiness refresh clears a probe error but cannot clear an unconfirmed input release',async()=>{
 const f=fixture({enabled:true});let first=true;f.control.status=async()=>{if(first){first=false;throw Error('approval pending');}return {ready:true,state:'ready'};};await f.service.refreshStatus();assert.equal(f.service.status().state,'fault');await f.service.refreshStatus();assert.equal(f.service.status().state,'ready');await f.service.shutdown();
 const uncertain=fixture({enabled:true,stop:async()=>({releaseConfirmed:false})});await uncertain.service.refreshStatus();await uncertain.service.execute({action:'key',params:{key:'a'}},uncertain.context,{scopeId:'failed-release'});await assert.rejects(uncertain.service.endScope('owner-a','failed-release'));await uncertain.service.refreshStatus();assert.equal(uncertain.service.status().state,'fault');await assert.rejects(uncertain.service.disable(),{code:'E_BOPER_RELEASE_UNKNOWN'});await uncertain.service.shutdown();
});
test('registered pending approval replaces a stale probe failure without admitting input',async()=>{
 const f=fixture({enabled:true});
 f.control.status=async()=>{throw Object.assign(Error('Operation not permitted'),{code:'E_SERVICE_MANAGEMENT'});};
 await f.service.refreshStatus();assert.equal(f.service.status().state,'fault');
 f.control.status=async()=>({ready:false,state:'requires-approval',serviceStatus:'requires-approval'});
 const waiting=await f.service.refreshStatus();assert.equal(waiting.state,'requires-approval');assert.equal(waiting.error,undefined);
 await assert.rejects(f.service.execute({action:'key',params:{key:'a'}},f.context,{scopeId:'waiting'}),{code:'E_VIRTUAL_HID_UNAVAILABLE'});
 assert.equal(f.messages.length,0);await f.service.shutdown();
});
test('explicit enable waits within a bound for its newly started devices, with no input or fallback',async()=>{
 const f=fixture();let reads=0;
 f.control.status=async()=>++reads===1?{ready:false,state:'faulted',serviceStatus:'enabled',connected:true}:{ready:true,state:'ready',serviceStatus:'enabled'};
 const ready=await f.service.enable();assert.equal(ready.backend,'virtual-hid');assert.equal(ready.state,'ready');assert.equal(reads,2);assert.equal(f.messages.length,0);
 await f.service.shutdown();
});
test('explicit own-device recovery reaps the old runtime, requires release/readiness receipts and never replays input',async()=>{
 const f=fixture({enabled:true,stop:async()=>({releaseConfirmed:false})});await f.service.refreshStatus();await f.service.execute({action:'key',params:{key:'a'}},f.context,{scopeId:'failed'});await assert.rejects(f.service.endScope('owner-a','failed'));const before=f.messages.filter(m=>m.action==='execute').length;
 let recovered=false;f.control.recover=async()=>{assert.equal(f.service.proc,null);recovered=true;return {ready:true,releaseConfirmed:true,sessionActive:false};};const status=await f.service.recover();assert(recovered);assert.equal(status.state,'ready');assert.equal(f.messages.filter(m=>m.action==='execute').length,before);await f.service.shutdown();
 const g=fixture({enabled:true,stop:async()=>({releaseConfirmed:false})});await g.service.refreshStatus();await g.service.execute({action:'key',params:{key:'a'}},g.context,{scopeId:'failed'});await assert.rejects(g.service.endScope('owner-a','failed'));g.control.recover=async()=>({ready:true,releaseConfirmed:false});await assert.rejects(g.service.recover(),{code:'E_BOPER_RECOVERY_UNCONFIRMED'});assert.equal(g.service.status().state,'fault');await g.service.shutdown();
});
test('a late renewal failure from a released session cannot fault or stop its replacement',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=fixture({enabled:true}),renewal=Promise.withResolvers();
 f.control.renewSession=()=>renewal.promise;
 await f.service.refreshStatus();
 await f.service.execute({action:'key',params:{key:'a'}},f.context,{scopeId:'old-scope'});
 t.mock.timers.tick(500);await new Promise(r=>setImmediate(r));
 await f.service.endScope('owner-a','old-scope');
 await f.service.execute({action:'key',params:{key:'b'}},{...f.context,ownerId:'owner-b'},{scopeId:'new-scope'});
 const replacement=f.service.active,stops=f.messages.filter(m=>m.action==='stop').length;
 renewal.reject(Object.assign(Error('old lease no longer exists'),{code:'E_EXPIRED_SESSION'}));
 await new Promise(r=>setImmediate(r));
 try{
  assert.equal(f.service.active,replacement);
  assert.equal(f.service.status().state,'ready');
  assert.equal(f.messages.filter(m=>m.action==='stop').length,stops);
 }finally{await f.service.shutdown();}
});
test('failure of the current lease still stops its exact session and faults further input',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=fixture({enabled:true});f.control.renewSession=async()=>{throw Object.assign(Error('current lease expired'),{code:'E_EXPIRED_SESSION'});};
 await f.service.refreshStatus();await f.service.execute({action:'key',params:{key:'a'}},f.context,{scopeId:'current-scope'});
 t.mock.timers.tick(500);await new Promise(r=>setImmediate(r));
 try{assert.equal(f.service.active,null);assert.equal(f.service.status().state,'fault');assert.equal(f.messages.filter(m=>m.action==='stop').length,1);
  await assert.rejects(f.service.execute({action:'key',params:{key:'b'}},f.context,{scopeId:'refused'}),{code:'E_BOPER_FAULT'});
 }finally{await f.service.shutdown();}
});
