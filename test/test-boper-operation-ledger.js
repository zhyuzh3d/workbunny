'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {OperationLedger}=require('../src/main/operation-ledger');
const outcomes=require('../src/main/boper-outcome');
function fixture(execute){let calls=0,recoveries=0;const tool={name:'fixture.input',effect:'write',execute:async(...args)=>{calls++;return execute(...args);},lifecycle:()=>({policy:'independent',maxAttempts:2,shouldRetry:()=>true,recover:async()=>{recoveries++;}})};
 const task={id:'task',scene:'life',state:{},inbox:[],operations:{},counters:{reads:0,writes:0}};const ledger=new OperationLedger({tools:{check:(_name,input)=>({tool,input})},clock:Date.now,authorize:async()=>{},save:async()=>{}});
 const run=(args={})=>ledger.execute({task,call:{tool:tool.name,key:'stable-operation',args},isCurrent:()=>true});return {task,run,get calls(){return calls;},get recoveries(){return recoveries;}};
}
for(const inputOutcome of [{clipboardChanged:true,dispatched:false,reportsSubmitted:0},{moved:true,dispatched:false,reportsSubmitted:0},{completion:'unknown',dispatched:false,dispatchOutcomeUnknown:true}])test('a partial local side effect is saved and cannot be replayed even when dispatched is false: '+Object.keys(inputOutcome)[0],async()=>{
 const f=fixture(async()=>{throw Object.assign(Error('local effect needs observation'),{code:'E_FIXTURE',dispatched:false,inputOutcome:{...inputOutcome,text:'private-body',clipboard:'private-old-content'}});});
 await assert.rejects(f.run(),error=>error.dispatched===false&&outcomes.hasEffects(error.inputOutcome));assert.equal(f.calls,1);assert.equal(f.recoveries,0);const operation=Object.values(f.task.operations)[0];assert.equal(operation.status,'intent');assert.equal(operation.lifecycle.phase,'uncertain');assert.deepEqual(operation.inputOutcome,inputOutcome);assert.deepEqual(operation.errorDiagnostic.inputOutcome,inputOutcome);assert(!JSON.stringify(f.task).includes('private-body'));assert(!JSON.stringify(f.task).includes('private-old-content'));
 await assert.rejects(f.run(),/不确定/);assert.equal(f.calls,1);await assert.rejects(f.run({changed:true}),/既有写入须先核对/);assert.equal(f.calls,1);
});
test('the existing Operation collects native effects when a higher tool wrapper summarizes the response',async()=>{
 let operationId;const f=fixture(async()=>{operationId=outcomes.operationId();const record=outcomes.recorder();await new Promise(resolve=>setImmediate(()=>{record({backend:'virtual-hid',reportsSubmitted:4,dispatched:true,clipboardChanged:true,text:'private-body'});record({reportsSubmitted:1,moved:true,completion:'local-submitted'});record({releaseConfirmed:true});resolve();}));return {ok:true,verified:true,receipt:{inputPerformed:true}};});
 const result=await f.run();assert.equal(result.inputOutcome,undefined);const operation=Object.values(f.task.operations)[0];assert.equal(operationId,operation.id);assert.equal(operation.status,'confirmed');assert.equal(operation.inputOutcome.reportsSubmitted,5);assert.equal(operation.inputOutcome.clipboardChanged,true);assert.equal(operation.inputOutcome.releaseConfirmed,true);assert(!JSON.stringify(operation).includes('private-body'));await f.run();assert.equal(f.calls,1);
});
test('a proven rejection with no input effects still permits the existing bounded pre-dispatch recovery',async()=>{
 let first=true;const f=fixture(async()=>{if(first){first=false;throw Object.assign(Error('safe rejection'),{dispatched:false,inputOutcome:{dispatched:false,clipboardChanged:false,reportsSubmitted:0,completion:'not-dispatched'}});}return {ok:true,verified:true};});await f.run();assert.equal(f.calls,2);assert.equal(f.recoveries,1);assert.equal(Object.values(f.task.operations)[0].status,'confirmed');
});
test('autonomous diagnostic replay is disabled for unknown input outcomes and diagnostics contain metadata only',()=>{
 const repair=require('../src/main/self-repair'),value={inputOutcome:{clipboardChanged:true,text:'private-body',clipboardChangeCount:3,completion:'unknown'},candidateCount:1};assert.equal(repair.category({code:'E_FIXTURE',inputOutcome:value.inputOutcome}),null);assert.deepEqual(repair.diagnostic(value),{candidateCount:1,inputOutcome:{clipboardChanged:true,clipboardChangeCount:3,completion:'unknown'}});
});
