'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const {beginFollowUpDraft}=require('../src/main/workbuddy-observation');
const {bindNotDispatchedProof,draftReviewCandidate}=require('../src/main/submission-draft');
function fixture(){
 const writes=[],logs=[];let nativeRequests=0;
 const service=new DesktopService({native:{cancel(){},close(){},request:async()=>{nativeRequests++;throw Error('must not operate');}},persist:async task=>writes.push(structuredClone(task)),log:value=>logs.push(structuredClone(value))});
 const task={id:'fixture',target:'workbuddy',status:'review',scene:'life',domain:'work',visibilityFloor:1,outboundText:'original request',goal:'goal',handoffSent:true,sessionId:'bound',monitorSessionId:'bound',monitorTaskId:1,monitorMessageKey:'old',monitorStatus:'ok',monitorSummary:'completed result',submittedAt:100,followUpRound:0,steps:[{action:'workbuddySend',state:'input-sent',at:100}]};
 task.followUpPending=beginFollowUpDraft(task,300);task.steps.push({action:'workbuddyFill',state:'input-sent',at:300,submissionRound:1});task.outboundText='private unsent draft';task.followUpPending.dispatchProof=bindNotDispatchedProof(task,{dispatched:false,code:'E_GUI_POINTER_BLOCKED'},{at:301});task.status='paused';service.task=task;
 return {service,writes,logs,nativeRequests:()=>nativeRequests};
}
test('process suspension releases the controller while preserving business status, draft and proof',async()=>{
 const h=fixture(),before=structuredClone(h.service.task);try{
  await h.service.journal();const count=h.logs.length;await h.service.suspend({cause:'process-exit'});
  assert.equal(h.service.task.status,'paused');assert.deepEqual(h.service.task.followUpPending,before.followUpPending);assert.deepEqual(h.service.task.steps,before.steps);assert.equal(h.service.task.outboundText,before.outboundText);assert.equal(h.service.task.controllerLifecycle.intent,'host-suspend');assert.equal(h.service.task.controllerLifecycle.terminal,false);
  assert.equal(draftReviewCandidate(h.service.task).requiresExplicit,false);assert.equal(h.writes.at(-1).status,'paused');assert.equal(h.logs.length,count+1,'lifecycle changes produce a new checkpoint');assert.equal(h.logs.at(-1).status,'paused');assert.equal(JSON.stringify(h.logs).includes('private unsent draft'),false);assert.equal(h.nativeRequests(),0);
 }finally{await h.service.close();}
});
test('a genuine typed stop survives later suspension and blocks every old GUI recovery entry point',async()=>{
 for(const cause of ['user-stop','business-stop']){
  const h=fixture();try{
   await h.service.journal();const count=h.logs.length;await h.service.stop('stop requested',{cause});assert.equal(h.service.task.status,'stopped');assert.equal(h.service.task.controllerLifecycle.intent,cause);assert.equal(h.logs.length,count+1);
   const lifecycle=structuredClone(h.service.task.controllerLifecycle);await h.service.suspend({cause:'process-exit'});assert.deepEqual(h.service.task.controllerLifecycle,lifecycle);assert.equal(draftReviewCandidate(h.service.task).ok,false);
   assert.equal((await h.service.resume()).code,'E_TASK_TERMINAL');assert.equal((await h.service.followUp({text:'do not send'})).code,'E_TASK_TERMINAL');assert.equal((await h.service.recoverWorkBuddySubmission()).code,'E_TASK_TERMINAL');assert.equal(h.nativeRequests(),0);
  }finally{await h.service.close();}
 }
});
test('host suspension never upgrades old untyped stopped records or changes uncertain sends',async()=>{
 const h=fixture();try{
  h.service.task.status='stopped';await h.service.suspend({cause:'process-exit'});assert.equal(h.service.task.status,'stopped');assert.equal(draftReviewCandidate(h.service.task).requiresExplicit,true);
  h.service.task.followUpPending.state='unknown';h.service.task.followUpPending.submittedAt=400;h.service.task.steps.push({action:'workbuddySend',state:'intent',at:400,submissionRound:1});const pending=structuredClone(h.service.task.followUpPending),steps=structuredClone(h.service.task.steps);
  await h.service.suspend({cause:'process-exit'});assert.deepEqual(h.service.task.followUpPending,pending);assert.deepEqual(h.service.task.steps,steps);assert.equal(draftReviewCandidate(h.service.task).ok,false);
 }finally{await h.service.close();}
});
test('host causes pause active business states while process exit preserves resumable states and privacy gates',async()=>{
 for(const cause of ['process-exit','task-pause','action-cancel','action-timeout','source-change','scene-change','screen-lock','storage-migration','connection-change']){
  const h=fixture();try{
   Object.assign(h.service.task,{status:'monitoring',workModel:'deepseek-v4.1-flash',origin:'dialogue',privacyEpoch:1});
   const pending=structuredClone(h.service.task.followUpPending),steps=structuredClone(h.service.task.steps);
   await h.service.suspend({cause,reason:'host pause'});assert.equal(h.service.task.status,cause==='process-exit'?'monitoring':'paused');assert.equal(h.service.task.controllerLifecycle.previousStatus,'monitoring');assert.equal(h.service.task.controllerLifecycle.cause,cause);assert.deepEqual(h.service.task.followUpPending,pending);assert.deepEqual(h.service.task.steps,steps);
   const resume=await h.service.resume({privacyEpoch:2});assert.equal(resume.ok,false);assert.match(resume.error,/隐私版本已变化/);assert.equal(h.nativeRequests(),0);
  }finally{await h.service.close();}
 }
});
test('duplicate pending host suspensions share persistence and preserve their timestamp and generation',async()=>{
 const h=fixture();let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let writes=0;
 h.service.persist=async()=>{writes++;enter();await gate;};
 try{
  h.service.task.status='monitoring';const first=h.service.suspend({cause:'task-pause'});await entered;const lifecycle=structuredClone(h.service.task.controllerLifecycle),generation=h.service.generation;
  const second=h.service.suspend({cause:'task-pause'});assert.equal(writes,1);assert.equal(h.service.generation,generation);release();assert.equal((await first).ok,true);assert.equal((await second).ok,true);
  assert.equal((await h.service.suspend({cause:'task-pause'})).alreadySuspended,true);assert.equal(writes,1);assert.deepEqual(h.service.task.controllerLifecycle,lifecycle);assert.equal(h.service.generation,generation);
  h.service.followUpInProgress=true;h.service.followUpController=new AbortController();await h.service.suspend({cause:'task-pause'});assert.equal(h.service.followUpController.signal.aborted,true);assert.equal(h.service.generation,generation+1);assert.equal(writes,2);h.service.followUpInProgress=false;
 }finally{release();await h.service.close();}
});
test('failed host suspension persistence cannot claim a durable lifecycle or a successful pause',async()=>{
 const h=fixture(),before=structuredClone(h.service.task);h.service.persist=async()=>{throw Error('fixture persistence failure');};
 try{
  await assert.rejects(h.service.suspend({cause:'screen-lock'}),error=>error.message==='fixture persistence failure'&&error.persistenceVerified===false&&error.localSuspended===true);
  assert.deepEqual(h.service.task,before);assert.equal(h.service.running,false);assert.equal(h.logs.length,0);
 }finally{await h.service.close();}
});
test('a stop racing a delayed host suspension remains the final canonical and durable terminal state',async()=>{
 const h=fixture();let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),writes=[];
 h.service.persist=async value=>{if(value.controllerLifecycle?.intent==='host-suspend'){enter();await gate;}writes.push(structuredClone(value));};
 try{
  h.service.task.status='monitoring';const suspended=h.service.suspend({cause:'task-pause'});await entered;const stopped=h.service.stop('explicit owner stop');assert.equal(h.service.task.controllerLifecycle.terminal,true);
  await h.service.suspend({cause:'screen-lock'});release();assert.equal((await suspended).superseded,true);assert.equal((await stopped).ok,true);
  assert.equal(h.service.task.status,'stopped');assert.equal(h.service.task.controllerLifecycle.intent,'user-stop');assert.equal(writes.at(-1).status,'stopped');assert.equal(writes.at(-1).controllerLifecycle.intent,'user-stop');
 }finally{release();await h.service.close();}
});
test('late cancellation cleanup cannot clear a newer task or release its GUI lease',async()=>{
 for(const operation of ['suspend','stop']){
  const h=fixture();let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  h.service.native.cancel=async()=>{entered();await gate;};
  try{
   const pending=operation==='suspend'?h.service.suspend({cause:'task-pause'}):h.service.stop('owner stop');await ready;
   const next={id:'new-task',target:'workbuddy',status:'running',scene:'life',domain:'work',visibilityFloor:1,steps:[]};h.service.task=next;h.service.generation++;h.service.running=true;const shot={preview:'new-shot'},monitor=Promise.resolve('new-monitor');h.service.screenshot=shot;h.service.monitorPromise=monitor;await h.service.acquireGuiLease();
   release();assert.equal((await pending).superseded,true);assert.equal(h.service.task,next);assert.equal(h.service.guiLeaseHeld,true);assert.equal(h.service.screenshot,shot);assert.equal(h.service.monitorPromise,monitor);
  }finally{release();await h.service.close();}
 }
});
test('cancelling a pending start records host cancellation rather than a user stop',async()=>{
 const {DesktopService}=require('../src/main/desktop-service');let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),records=[];
 const native={cancel:async()=>{},close:async()=>{},request:async op=>{assert.equal(op,'permissions');entered();await gate;return {accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true};}};
 const service=new DesktopService({native,persist:async value=>records.push(structuredClone(value))}),controller=new AbortController();
 try{
  const pending=service.start({target:'workbuddy',goal:'offline cancellation',scene:'life',visibilityFloor:1,sources:[],requestSignal:controller.signal});await ready;controller.abort();release();await pending;await service.suspensionWork?.promise;
  assert.equal(service.task.status,'paused');assert.equal(service.task.controllerLifecycle.intent,'host-suspend');assert.equal(service.task.controllerLifecycle.terminal,false);assert.equal(records.at(-1).controllerLifecycle.cause,'action-cancel');
 }finally{release();await service.close();}
});
