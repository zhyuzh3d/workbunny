'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {DesktopService}=require('../src/main/desktop-service'),{AgentService}=require('../src/main/agent-service');
const {beginFollowUpDraft}=require('../src/main/workbuddy-observation');
const {bindNotDispatchedProof,draftReviewCandidate}=require('../src/main/submission-draft');
function desktop(id,save){
 const service=new DesktopService({native:{cancel:async()=>{},close:async()=>{},request:async()=>assert.fail('shutdown and readonly recovery must not operate GUI')},persist:save});
 const task={id,target:'workbuddy',status:'review',scene:'life',domain:'work',visibilityFloor:1,privacyEpoch:1,sources:['owner-task'],goal:'原目标',criteria:'完整成果',outboundText:'原交办',handoffSent:true,sessionId:'bound',monitorSessionId:'bound',monitorMessageKey:'old',monitorTaskId:1,monitorStatus:'ok',monitorSummary:'原成果 https://example.test/result',submittedAt:100,followUpRound:0,steps:[{action:'workbuddySend',state:'input-sent',at:100}]};
 task.followUpPending=beginFollowUpDraft(task,300,{origin:'automatic'});task.steps.push({action:'workbuddyFill',state:'input-sent',at:300,submissionRound:1});task.outboundText='完整未发补充';task.status='paused';task.followUpPending.dispatchProof=bindNotDispatchedProof(task,{dispatched:false,code:'E_GUI_POINTER_BLOCKED'},{at:400});service.task=task;return service;
}
async function invokeRealShutdown(controllers,agent={close:async()=>{},recoveryDiagnostic:()=>{}}){
 const source=fs.readFileSync(require.resolve('../src/main/index.js'),'utf8'),start=source.indexOf('let shutdownStarted = false, shutdownFlushed = false;'),end=source.indexOf("app.on('window-all-closed'",start);
 let handler,quit;const done=new Promise(resolve=>{quit=resolve;}),noop=()=>{},asyncNoop=async()=>{},inputCleanup=[];
 const context={localControl:{close:async()=>{inputCleanup.push('local-control');}},getBoperService:()=>({shutdown:async()=>{inputCleanup.push('boper');}}),operationTrace:{record:noop},operationDiagnostics:{close:async()=>({drained:true})},send:noop,speechDiagnostic:null,app:{on:(_event,callback)=>{handler=callback;},quit},connection:{close:noop},speakerFilter:{cancel:noop},embodiment:{close:noop},avatarDescriptionPending:new Map(),clearInterval,clearTimeout,maintenanceTimer:null,supervisionTimer:null,notificationTimer:null,positionSaveTimer:null,quitting:false,autonomy:{pause:noop,close:asyncNoop},secretary:{close:noop},taskNotifications:{close:asyncNoop},taskReportTimer:null,vaultKeyAbort:null,sessionGate:null,markCleanExit:noop,closePanels:noop,monitor:null,voiceTurns:{reset:noop},asr:null,tts:{shutdown:noop},globalShortcut:{unregisterAll:noop},memory:{close:async()=>{inputCleanup.push('memory');}},desktop:controllers[0],watchDesktop:controllers[1],alertDesktop:controllers[2],agent,log:noop};
 vm.runInNewContext(source.slice(start,end),context);handler({preventDefault:noop});handler({preventDefault:noop});await done;assert(inputCleanup.includes('local-control'));assert.equal(inputCleanup.filter(step=>step==='boper').length,1);assert(inputCleanup.indexOf('boper')<inputCleanup.indexOf('memory'));
}
test('the actual before-quit boundary preserves all controllers, then a restored Task recovers and reports without resubmission',async()=>{
 const physicalRecords=new Map(),records=new Map(),reports=[];let saveCount=0;
 const primary=desktop('physical',async task=>{saveCount++;physicalRecords.set(task.id,structuredClone(task));}),watch=desktop('watch',async task=>physicalRecords.set(task.id,structuredClone(task))),alert=desktop('alert',async task=>physicalRecords.set(task.id,structuredClone(task)));
 const journal={put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[...records.values()].map(task=>structuredClone(task)),authorized:async()=>true};
 const make=current=>new AgentService({desktop:current,journal,scene:{metrics:{},native:{request:async()=>assert.fail('no GUI')},close:async()=>{}},autoSchedule:false,epoch:()=>1,report:async report=>reports.push(report),verify:async()=>({verdict:'pass',report:'原成果已完成。',recoveryAction:'abandon-unsent-supplement',links:[{url:'https://example.test/result'}]})});
 const first=make(primary);let second;
 try{
  const created=await first.start({skill:'work.delegate',goal:'原目标',subjects:[{application:'workbuddy'}]},{role:'owner',verified:true,sources:['fixture-owner'],scene:'life'}),task=first.runtime.tasks.get(created.id);
  primary.task.sources=[task.id];task.state.job={jobId:'physical',sessionId:'bound',submissionRound:0,messageKey:'old'};task.status='needs_attention';await first.runtime.save(task);
  await invokeRealShutdown([primary,watch,alert],first);assert.equal(saveCount,1,'duplicate quit does not perform a second lifecycle write');
  for(const id of ['physical','watch','alert']){const record=physicalRecords.get(id);assert.equal(record.status,'paused');assert.equal(record.controllerLifecycle.intent,'host-suspend');assert.equal(record.followUpPending.state,'draft-unknown');assert.equal(record.steps.length,2);}
  const restored=desktop('unused',async value=>physicalRecords.set(value.id,structuredClone(value)));restored.task=structuredClone(physicalRecords.get('physical'));restored.observeWorkBuddy=async query=>query.followUpPending?null:{sessionId:'bound',taskId:8,messageKey:'old',status:'ok',startedAt:110,updatedAt:250,summary:'原成果 https://example.test/result'};
  second=make(restored);await second.restore();assert.equal(second.runtime.tasks.get(task.id).status,'needs_attention');await second.recoverPending();await second.runtime.tick(task.id);
  const result=second.runtime.tasks.get(task.id);assert.equal(result.status,'completed');assert.equal(result.state.result.source.messageKey,'old');assert.equal(reports.filter(report=>report.text.includes('https://example.test/result')).length,1);assert.equal(restored.task.submissionDraftDisposition.disposition,'abandoned-before-dispatch');
 }finally{await first.close();await second?.close();await Promise.all([primary.close(),watch.close(),alert.close()]);}
});
test('actual quit and reload preserve a true user stop and all unknown submission evidence',async()=>{
 for(const mode of ['user-stop','unknown']){
  const saved=new Map(),service=desktop('physical',async task=>saved.set(task.id,structuredClone(task)));
  try{
   if(mode==='user-stop')await service.stop('用户明确停止');
   else{service.task.followUpPending.state='unknown';service.task.followUpPending.submittedAt=450;service.task.steps.push({action:'workbuddySend',state:'intent',at:450,submissionRound:1});}
   const before=structuredClone(service.task);await invokeRealShutdown([service]);const record=saved.get('physical');assert.deepEqual(record.followUpPending,before.followUpPending);assert.deepEqual(record.steps,before.steps);assert.equal(draftReviewCandidate(record).ok,false);
   if(mode==='user-stop'){assert.equal(record.status,'stopped');assert.equal(record.controllerLifecycle.intent,'user-stop');assert.equal(record.controllerLifecycle.terminal,true);}
  }finally{await service.close();}
 }
});
