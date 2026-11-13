'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {OperationLedger,hasUncertainEffect,hasInputEffects,reconcileEffect}=require('../src/main/operation-ledger');
const outcomes=require('../src/main/boper-outcome');
function fixture(execute,effect='write'){let calls=0,recoveries=0;const tool={name:'fixture.input',effect,execute:async(...args)=>{calls++;return execute(...args);},lifecycle:()=>({policy:'independent',maxAttempts:2,shouldRetry:()=>true,recover:async()=>{recoveries++;}})};
 const task={id:'task',scene:'life',state:{},inbox:[],operations:{},counters:{reads:0,writes:0}};const ledger=new OperationLedger({tools:{check:(_name,input)=>({tool,input})},clock:Date.now,authorize:async()=>{},save:async()=>{}});
 const run=(args={})=>ledger.execute({task,call:{tool:tool.name,key:'stable-operation',args},isCurrent:()=>true});return {task,run,get calls(){return calls;},get recoveries(){return recoveries;}};
}
for(const inputOutcome of [{clipboardChanged:true,dispatched:false,reportsSubmitted:0},{moved:true,dispatched:false,reportsSubmitted:0},{completion:'unknown',dispatched:false,dispatchOutcomeUnknown:true}])test('a partial local side effect is saved and cannot be replayed even when dispatched is false: '+Object.keys(inputOutcome)[0],async()=>{
 const f=fixture(async()=>{throw Object.assign(Error('local effect needs observation'),{code:'E_FIXTURE',dispatched:false,inputOutcome:{...inputOutcome,text:'private-body',clipboard:'private-old-content'}});});
 await assert.rejects(f.run(),error=>error.dispatched===(inputOutcome.moved===true||inputOutcome.dispatchOutcomeUnknown===true)&&outcomes.hasEffects(error.inputOutcome));assert.equal(f.calls,1);assert.equal(f.recoveries,0);const operation=Object.values(f.task.operations)[0];assert.equal(operation.status,'intent');assert.equal(operation.lifecycle.phase,'uncertain');assert.deepEqual(operation.inputOutcome,inputOutcome);assert.deepEqual(operation.errorDiagnostic.inputOutcome,inputOutcome);assert(!JSON.stringify(f.task).includes('private-body'));assert(!JSON.stringify(f.task).includes('private-old-content'));
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
test('a declared read with issued HID cannot erase its native effect or repeat after a wrapper failure',async()=>{
 const f=fixture(async()=>{outcomes.recorder()({backend:'virtual-hid',dispatched:true,reportsSubmitted:3,completion:'local-submitted'});throw Object.assign(Error('visible result unavailable'),{dispatched:false});},'read');
 await assert.rejects(f.run(),e=>e.dispatched===true&&e.inputOutcome.reportsSubmitted===3);const op=Object.values(f.task.operations)[0];
 assert.equal(op.effect,'read');assert.equal(op.status,'intent');assert(hasInputEffects(op));assert(hasUncertainEffect(op));assert.equal(f.recoveries,0);
 await assert.rejects(f.run(),{code:'E_SUBMISSION_UNCERTAIN'});assert.equal(f.calls,1);
});
test('a confirmed read with HID reuses its real observation result while a pure read stays repeatable',async()=>{
 const f=fixture(async()=>{outcomes.recorder()({dispatched:true,reportsSubmitted:1});return {headerMatched:true,frameId:'synthetic-frame',preview:'data:image/png;base64,synthetic-pixel-canary'};},'read');
 assert.equal((await f.run()).frameId,'synthetic-frame');assert.equal((await f.run()).frameId,'synthetic-frame');assert.equal(f.calls,1);assert(!hasUncertainEffect(Object.values(f.task.operations)[0]));assert(!JSON.stringify(f.task.operations).includes('synthetic-pixel-canary'));
 const pure=fixture(async()=>({available:true}),'read');await pure.run();await pure.run();assert.equal(pure.calls,2);
});
test('an outer outcome summary cannot erase an earlier unknown receipt or double-count captured reports',async()=>{
 const f=fixture(async()=>{outcomes.recorder()({dispatched:true,dispatchOutcomeUnknown:true,reportsSubmitted:2,completion:'unknown'});throw Object.assign(Error('summary'),{dispatched:false,inputOutcome:{dispatched:false,reportsSubmitted:2,completion:'not-dispatched'}});},'read');
 await assert.rejects(f.run(),e=>e.dispatched===true&&e.inputOutcome.completion==='unknown');const op=Object.values(f.task.operations)[0];assert.equal(op.inputOutcome.reportsSubmitted,2);assert(hasUncertainEffect(op));
});
test('fresh read-only pixels can reconcile a pointer navigation without erasing its receipt or replaying its key',async()=>{
 const f=fixture(async()=>{outcomes.recorder()({inputKinds:['click'],inputKindsComplete:true,dispatched:true,completion:'unknown'});throw Object.assign(Error('navigation image unavailable'),{dispatched:false});},'read');
 await assert.rejects(f.run());const op=Object.values(f.task.operations)[0],original=structuredClone(op.inputOutcome),at=op.at+100;
 f.task.operations.pixels={id:'pixels',effect:'read',status:'confirmed',finishedAt:at,observation:{frameId:'fresh-display'}};
 const review=reconcileEffect(f.task,{operationId:op.id,outcome:'applied',evidenceOperationIds:['pixels'],basis:'当前像素显示预期目标，后续须按该画面新决策',at});
 assert(review.navigationOnly);assert(!hasUncertainEffect(op));assert.equal(op.status,'intent');assert.deepEqual(op.inputOutcome,original);assert.equal(op.effectReconciliationHistory.length,1);
 await assert.rejects(f.run(),{code:'E_OPERATION_REPLAY'});assert.equal(f.calls,1);
});
test('navigation reconciliation rejects stale, model-only and HID evidence and never clears write/type/key/paste uncertainty',()=>{
 const at=100000,base={id:'old',effect:'read',status:'intent',at:1000,inputOutcome:{completion:'unknown',inputKinds:['click'],inputKindsComplete:true}};
 const pixel={id:'pixels',effect:'read',status:'confirmed',finishedAt:at,observation:{frameId:'fresh'}};
 const attempt=(old,evidence=pixel,options)=>{const task={operations:{old:structuredClone(old),pixels:evidence}};return reconcileEffect(task,{operationId:'old',outcome:'not_applied',evidenceOperationIds:['pixels'],basis:'synthetic visual assessment',at},options);};
 for(const changed of [{...pixel,finishedAt:1001},{...pixel,kind:'model'},{...pixel,inputOutcome:{dispatched:true}},{...pixel,observation:{}}])assert.throws(()=>attempt(base,changed),{code:'E_EFFECT_RECONCILIATION'});
 for(const changed of [{...base,effect:'write'},...['type','key','paste','other'].map(kind=>({...base,inputOutcome:{...base.inputOutcome,inputKinds:[kind]}}))])assert.throws(()=>attempt(changed),{code:'E_EFFECT_RECONCILIATION'});
});
test('legacy input kinds require an explicit authenticated owner review of original native refs and current pixels',()=>{
 const task={operations:{old:{id:'old',effect:'read',status:'intent',at:1000,inputOutcome:{completion:'unknown',dispatched:true}},pixels:{id:'pixels',effect:'read',status:'confirmed',finishedAt:2000,observation:{frameId:'fresh'}}}};
 const args={operationId:'old',outcome:'applied',evidenceOperationIds:['pixels'],basis:'Owner reviewed original native click receipt and current target pixels',at:2000};
 assert.throws(()=>reconcileEffect(task,args),{code:'E_EFFECT_RECONCILIATION'});
 reconcileEffect(task,args,{ownerReviewed:true,reviewedInputKinds:['click'],sourceRefs:['original-native-record-ref']});assert(!hasUncertainEffect(task.operations.old));assert.equal(task.operations.old.inputOutcome.inputKinds,undefined);
 task.operations.old.inputOutcome.inputKinds=['key'];assert.throws(()=>reconcileEffect(task,args,{ownerReviewed:true,reviewedInputKinds:['click'],sourceRefs:['original-native-record-ref']}),{code:'E_EFFECT_RECONCILIATION'});
});
test('pointer commit phases merge monotonically and unknown commitment cannot be hidden by old preparation metadata',()=>{
 let result=outcomes.merge(undefined,{pointerCommitState:'not-requested',inputKinds:['move'],inputKindsComplete:true,moved:true,reportsSubmitted:46});
 result=outcomes.merge(result,{pointerCommitState:'requested'});result=outcomes.merge(result,{pointerCommitState:'acknowledged'});result=outcomes.merge(result,{pointerCommitState:'not-requested'});assert.equal(result.pointerCommitState,'acknowledged');
 result=outcomes.merge(result,{pointerCommitState:'unknown',completion:'unknown'});result=outcomes.merge(result,{pointerCommitState:'acknowledged',completion:'local-submitted'});result=outcomes.merge(result,{pointerCommitState:'not-requested',dispatched:false});assert.equal(result.pointerCommitState,'unknown');assert.equal(result.completion,'unknown');assert.equal(result.reportsSubmitted,46);assert.equal(result.moved,true);assert(outcomes.hasEffects({pointerCommitState:'unknown',dispatched:false}));assert.equal(outcomes.sanitize({pointerCommitState:'untrusted-value'}),undefined);
});
const preparation={inputKinds:['move'],inputKindsComplete:true,pointerCommitState:'not-requested',dispatched:true,dispatchOutcomeUnknown:false,clipboardChanged:false,moved:true,reportsSubmitted:7,reportsAttempted:7,releaseConfirmed:true,backend:'virtual-hid',completion:'local-submitted'};
test('a known pointer preparation rejection preserves motion while allowing a fresh business attempt',async()=>{
 let fail=true;const f=fixture(async()=>{if(fail){outcomes.recorder()(preparation);throw Object.assign(Error('target changed before click commitment'),{dispatched:false});}return {ok:true,verified:true,receipt:{businessCompleted:true}};});
 await assert.rejects(f.run(),e=>e.dispatched===false&&e.inputOutcome.dispatched===true);const old=Object.values(f.task.operations)[0];
 assert.equal(old.status,'not_dispatched');assert.equal(old.preparationOnly,true);assert(hasInputEffects(old));assert(!hasUncertainEffect(old));assert.deepEqual(old.inputOutcome,preparation);assert.equal(f.calls,1);assert.equal(f.recoveries,0);
 fail=false;await f.run();const next=f.task.operations[old.replacedBy];assert(next);assert.notEqual(next.id,old.id);assert.equal(next.supersedes,old.id);assert.equal(next.status,'confirmed');assert.equal(old.status,'not_dispatched');assert.deepEqual(old.inputOutcome,preparation);
 await f.run();assert.equal(f.calls,2);
});
test('pointer preparation metadata cannot clear a requested commitment, text, clipboard or incomplete receipt',async()=>{
 for(const changed of [{pointerCommitState:'requested'},{pointerCommitState:'unknown'},{inputKinds:['move','click']},{inputKinds:['move','key']},{inputKindsComplete:false},{clipboardChanged:true},{dispatchOutcomeUnknown:true},{releaseConfirmed:false},{completion:'unknown'}]){
  const f=fixture(async()=>{outcomes.recorder()({...preparation,...changed});throw Object.assign(Error('cannot assume preparation only'),{dispatched:false});});await assert.rejects(f.run());const op=Object.values(f.task.operations)[0];assert(hasUncertainEffect(op));assert.notEqual(op.preparationOnly,true);await assert.rejects(f.run(),{code:'E_SUBMISSION_UNCERTAIN'});assert.equal(f.calls,1);
 }
});
test('pointer movement alone does not overrule a tool that cannot rule out its own business effect',async()=>{
 const f=fixture(async()=>{outcomes.recorder()(preparation);throw Error('business result unknown');});await assert.rejects(f.run());const op=Object.values(f.task.operations)[0];assert(hasUncertainEffect(op));assert.notEqual(op.preparationOnly,true);
});
