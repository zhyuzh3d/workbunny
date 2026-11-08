'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service');
const {DesktopService}=require('../src/main/desktop-service');
const {observeWorkBuddy,workSubmissionState,workSubmissionConfirmed,beginFollowUpDraft}=require('../src/main/workbuddy-observation');
function fixture(){
 const physical={id:'physical',target:'workbuddy',status:'paused',sources:['logical'],handoffSent:true,sessionId:'bound',monitorSessionId:'bound',monitorTaskId:1,monitorMessageKey:'old',submittedAt:100,followUpRound:0,draftInserted:true,draftInsertedAt:90,
  steps:[{action:'workbuddyFill',state:'input-sent',at:90},{action:'workbuddySend',state:'input-sent',at:100}]};
 physical.followUpPending=beginFollowUpDraft(physical,300);physical.outboundText='existing follow-up draft';physical.steps.push({action:'workbuddyFill',state:'input-sent',at:300,submissionRound:1});
 const old={id:1,bunnyTaskId:'physical',messageKey:'old',startedAt:100,endedAt:200,status:'ok',summary:'original completed result'};
 const entry={snap:{sessionId:'bound',task:old}},monitor={sessions:new Map([['fixture',entry]])};
 return {physical,old,entry,monitor};
}
function reconciliation(physical,observe){
 const task={id:'logical',status:'needs_attention',scene:'life',state:{}},op={id:'pending'};let confirmations=0;
 const desktop={task:physical,running:false,observeWorkBuddy:observe,journal:async()=>{}};
 const context={desktop,workOperation:async()=>physical,waitForWorkSubmission:AgentService.prototype.waitForWorkSubmission,runtime:{tasks:new Map([[task.id,task]]),controllers:new Map(),canControl:()=>true,journal:{authorized:async()=>true},save:async()=>{},confirmReconciled:async(_id,_op,result)=>{confirmations++;return result;},publish(){},schedule(){}}};
 return {run:()=>AgentService.prototype.reconcileWork.call(context,task,op),confirmations:()=>confirmations};
}
test('a new filled round retains its prior positive receipt without claiming another submission',()=>{
 const h=fixture(),before=structuredClone(h.physical),state=workSubmissionState(h.physical);
 assert.equal(state.phase,'draft-ready');assert.equal(state.submissionRound,1);assert.equal(state.submitAttempted,false);assert.equal(state.handoffSent,false);assert.equal(state.submittedAt,null);assert.equal(state.draftInsertedAt,300);
 assert.deepEqual(state.priorSubmission,{submissionRound:0,handoffSent:true,submittedAt:100,messageKey:'old'});
 assert.equal(workSubmissionConfirmed(h.physical),false);assert.equal(observeWorkBuddy(h.monitor,h.physical),null);assert.deepEqual(h.physical,before);
 h.physical.steps.at(-1).state='intent';assert.equal(workSubmissionState(h.physical).phase,'input-unknown');
});
test('real observation and read-only reconciliation cannot promote an old record into a new draft receipt',async()=>{
 for(const injected of [false,true]){
  const h=fixture(),old={sessionId:'bound',taskId:1,messageKey:'old',startedAt:100,updatedAt:200,status:'ok'};
  const r=reconciliation(h.physical,async()=>injected?old:observeWorkBuddy(h.monitor,h.physical));
  const result=await r.run();assert.equal(result.ok,false);assert.equal(r.confirmations(),0);assert.equal(h.physical.followUpPending.state,'draft-unknown');assert.equal(h.physical.followUpRound,0);
 }
});
test('after a new send, only its new message key can confirm the same bound round',async()=>{
 const h=fixture();Object.assign(h.physical,{followUpRound:1,submittedAt:400,previousMonitorMessageKey:'old',previousMonitorTaskId:1,monitorMessageKey:null,monitorTaskId:null,followUpAwaitingMonitor:true});
 Object.assign(h.physical.followUpPending,{state:'sent',submittedAt:400});h.physical.steps.push({action:'workbuddySend',state:'input-sent',at:400,submissionRound:1});
 assert.equal(observeWorkBuddy(h.monitor,h.physical),null);
 h.entry.snap.history=[h.old];h.entry.snap.task={...h.old,id:2,messageKey:'new',startedAt:401,endedAt:500};
 const r=reconciliation(h.physical,async p=>observeWorkBuddy(h.monitor,p)),result=await r.run();
 assert.equal(result.ok,true);assert.equal(result.submissionRound,1);assert.equal(result.messageKey,'new');assert.equal(r.confirmations(),1);assert.equal(workSubmissionConfirmed(h.physical),true);
});
test('physical draft recovery ignores even an injected old proof before any GUI or model request',async()=>{
 const h=fixture();let nativeCalls=0,modelCalls=0;
 const service=new DesktopService({native:{close(){},cancel(){},request:async()=>{nativeCalls++;throw Error('must not operate');}},persist:async()=>{},
  inspectWorkBuddySubmission:async()=>({complete:false,record:{sessionId:'bound',taskId:1,messageKey:'old',status:'ok',startedAt:100,updatedAt:200}}),
  modelRequest:async()=>{modelCalls++;throw Error('must not request');}});
 service.task=h.physical;
 try{const result=await service.recoverWorkBuddySubmission();assert.equal(result.ok,false);assert.equal(nativeCalls,0);assert.equal(modelCalls,0);assert.equal(h.physical.followUpPending.state,'draft-unknown');}
 finally{await service.close();}
});
test('restoration preserves the real original receipt while reopening only false continuation receipts',async()=>{
 for(const stamped of [false,true]){
  const h=fixture(),receipt={ok:true,verified:true,jobId:'physical',sessionId:'bound',...(stamped?{submissionRound:0,messageKey:'old'}:{})};
  const task={id:'logical',skill:'work.delegate',status:'needs_attention',state:{job:structuredClone(receipt)},operations:{submit:{tool:'work.submit',status:'confirmed',result:structuredClone(receipt)}}};let saves=0;
  await AgentService.prototype.repairLegacyWorkReceipts.call({runtime:{tasks:new Map([[task.id,task]]),save:async()=>{saves++;}},workOperation:async()=>h.physical});
  assert.equal(task.operations.submit.status,'confirmed');assert.deepEqual(task.operations.submit.result,receipt);assert.deepEqual(task.state.job,receipt);assert.equal(saves,0);
 }
 const h=fixture();h.physical.continuationOf={round:0};h.physical.followUpPending={state:'sent',round:1};h.physical.followUpAwaitingMonitor=true;
 const task={id:'logical',skill:'work.delegate',status:'waiting',state:{job:{jobId:'physical'}},operations:{submit:{tool:'work.submit',status:'confirmed',result:{jobId:'physical',sessionId:'bound'}}}};
 await AgentService.prototype.repairLegacyWorkReceipts.call({runtime:{tasks:new Map([[task.id,task]]),save:async()=>{}},workOperation:async()=>h.physical});
 assert.equal(task.operations.submit.status,'intent');assert.equal(task.state.job,undefined);assert.equal(task.operations.submit.legacyReceipt.sessionId,'bound');
});
test('only explicit resume recovers a later draft while retaining the original confirmed operation',async()=>{
 for(const requested of [false,true]){
  const h=fixture(),receipt={ok:true,verified:true,jobId:'physical',sessionId:'bound',submissionRound:0,messageKey:'old'};
  const task={id:'logical',skill:'work.delegate',status:'waiting',state:{job:structuredClone(receipt)},operations:{submit:{status:'confirmed',result:structuredClone(receipt)}}};let recovered=0,authorized=0;
  const desktop={task:h.physical,running:false,recoverWorkBuddySubmission:async options=>{recovered++;await options.authorize();Object.assign(h.physical,{followUpRound:1,monitorMessageKey:'new',monitorTaskId:2,monitorStartedAt:401,monitorUpdatedAt:500,status:'review'});Object.assign(h.physical.followUpPending,{state:'observed',submittedAt:400,messageKey:'new'});return {ok:true};}};
  const context={desktop,workRecoveryRequests:new Set(requested?[task.id]:[]),canOperate:async()=>true,tools:{get:()=>({})},runtime:{tasks:new Map([[task.id,task]]),save:async()=>{},authorize:async()=>{authorized++;}},verify:async()=>{throw Error('must await the next work.status round');}};
  const result=await AgentService.prototype.workStatus.call(context,'physical',task,new AbortController().signal);
  assert.equal(recovered,requested?1:0);assert.equal(authorized,requested?1:0);assert.equal(result.completed,false);assert.deepEqual(task.operations.submit.result,receipt);assert.equal(task.operations.submit.status,'confirmed');
 }
});
