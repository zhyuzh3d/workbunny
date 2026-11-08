'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service');
const {beginFollowUpDraft,workSubmissionConfirmed}=require('../src/main/workbuddy-observation');
const {bindNotDispatchedProof}=require('../src/main/submission-draft');
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:v=>resolve(v)};};
function fixture(){
 const physical={id:'physical',target:'workbuddy',status:'review',sources:['logical'],goal:'原目标',criteria:[],outboundText:'原交办',handoffSent:true,sessionId:'bound',monitorSessionId:'bound',monitorMessageKey:'old',monitorTaskId:1,monitorStatus:'ok',monitorSummary:'保留的实际成果 https://example.test/result',monitorLinks:[{url:'https://example.test/result'}],submittedAt:100,submitAttemptedAt:100,followUpRound:0,steps:[{action:'workbuddyFill',state:'input-sent',at:90},{action:'workbuddySend',state:'input-sent',at:100}]};
 physical.followUpPending=beginFollowUpDraft(physical,300,{origin:'automatic'});physical.steps.push({action:'workbuddyFill',state:'input-sent',at:300,submissionRound:1});physical.outboundText='完整补充稿';physical.status='paused';
 physical.followUpPending.dispatchProof=bindNotDispatchedProof(physical,{dispatched:false,code:'E_GUI_POINTER_BLOCKED'},{at:400});
 const receipt={ok:true,verified:true,jobId:'physical',sessionId:'bound',messageKey:'old',submissionRound:0};
 const task={id:'logical',skill:'work.delegate',status:'waiting',goal:'原目标',sources:['owner'],authority:{verified:true,role:'owner'},state:{job:structuredClone(receipt),ownerRequest:'完整主人要求',ownerContext:'完整必要背景'},operations:{submit:{id:'submit',tool:'work.submit',effect:'write',status:'confirmed',result:structuredClone(receipt)}}};
 const saves=[],accepted=[],followed=[],requests=[];let revision=0;
 const service=Object.create(AgentService.prototype);
 Object.assign(service,{ready:()=>true,readSubmissionEvidence:async()=>'',workRecoveryRequests:new Set(),priorResultReviewAuthorizations:new Map(),learning:{reviewContext:async()=>({knowledge:[],sourceIds:['new-delivery-knowledge'],availability:'fixture',isCurrent:async()=>true})},
  runtime:{tasks:new Map([[task.id,task]]),controllers:new Map(),canControl:t=>t===task&&!task.state.stopRequest,controlRevision:()=>revision,save:async()=>{},journal:{authorized:async()=>true},control:async(action,id,options)=>{requests.push({action,id,options});if(options?.expectedRevision!==revision)return {ok:false,superseded:true};revision++;task.status=action==='resume'?'waiting':'paused';return {ok:true};}},
  desktop:{task:physical,running:false,generation:1,publicStatus:()=>({}),emit(){},observeWorkBuddy:async()=>null,persist:async value=>saves.push(structuredClone(value)),accept:async value=>{accepted.push(value);service.desktop.task.status='accepted';},followUp:async value=>{followed.push(value);throw Error('must not submit');}},
  verify:async options=>({verdict:'pass',report:'原成果已完成。',recoveryAction:'abandon-unsent-supplement',links:[{url:'https://example.test/result'}]})});
 return {service,task,physical,saves,accepted,followed,requests,revision:()=>revision,bump:()=>{revision++;},run:()=>service.workStatus('physical',task,new AbortController().signal)};
}
test('autonomous recovery archives only the proven unsent draft and accepts the original receipt without sending',async()=>{
 const h=fixture(),before=structuredClone(h.physical),receipt=structuredClone(h.task.operations.submit.result);
 h.service.verify=async ({task,reviewContext})=>{
  assert.equal(task.outboundText,'原交办');assert.equal(task.monitorMessageKey,'old');
  assert.equal(reviewContext.ownerEvidence.request,'完整主人要求');assert.equal(reviewContext.ownerEvidence.context,'完整必要背景');
  assert.equal(reviewContext.submissionRecovery.draftText,'完整补充稿');assert.equal(reviewContext.submissionRecovery.dispatch,'not-dispatched');
  return {verdict:'pass',report:'原成果已完成。',recoveryAction:'abandon-unsent-supplement',links:[{url:'https://example.test/result'}]};
 };
 const result=await h.run();assert.equal(result.completed,true);assert.equal(result.result.source.messageKey,'old');assert.equal(h.accepted.length,1);assert.equal(h.followed.length,0);
 assert.deepEqual(h.task.operations.submit.result,receipt);assert.equal(h.task.operations.submit.status,'confirmed');
 const restored=h.service.desktop.task;assert.equal(restored.submissionDraftDisposition.disposition,'abandoned-before-dispatch');
 assert.equal(restored.submissionDraftArchives[0].current.outboundText,'完整补充稿');assert.deepEqual(restored.submissionDraftArchives[0].steps,before.steps);
 assert.equal(restored.monitorMessageKey,'old');assert.equal(restored.followUpRound,0);assert.equal(workSubmissionConfirmed(restored),true);
 assert.deepEqual(h.physical,before,'original object is not rewritten before durable archive');assert.equal(h.saves[0].submissionDraftArchives.length,1);
});
for(const verdict of ['revise','need_user','pass'])test(`${verdict} without an abandonment choice retains the draft and suppresses repeated automatic review`,async()=>{
 const h=fixture(),before=structuredClone(h.physical);let calls=0;
 h.service.verify=async()=>{calls++;return {verdict,report:'保留补充，证据仍需核实。',followUp:'不要发送',recoveryAction:'retain-draft'};};
 assert.equal((await h.run()).needsAttention,true);assert.equal(h.task.state.priorResultReview.status,'retained');assert.deepEqual(h.physical,before);assert.equal(h.accepted.length,0);assert.equal(h.followed.length,0);assert.equal(h.saves.length,0);
 assert.equal((await h.run()).completed,false);assert.equal(calls,1);
});
test('genuine unknown, incomplete proof and a positive new receipt cannot enter prior-result review',async()=>{
 for(const mode of ['sent','intent','missing-proof','new-receipt']){
  const h=fixture();let calls=0;h.service.verify=async()=>{calls++;throw Error('must not review');};
  if(mode==='sent'){h.physical.followUpPending.state='sent';h.physical.followUpPending.submittedAt=410;}
  if(mode==='intent')h.physical.steps.push({action:'workbuddySend',state:'intent',at:410,submissionRound:1});
  if(mode==='missing-proof')delete h.physical.followUpPending.dispatchProof;
  if(mode==='new-receipt')h.service.desktop.observeWorkBuddy=async()=>({sessionId:'bound',messageKey:'new',startedAt:410});
  const before=structuredClone(h.physical);assert.equal((await h.run()).completed,false);assert.equal(calls,0);assert.equal(h.saves.length,0);assert.equal(h.accepted.length,0);assert.deepEqual(h.physical,before);
 }
});
test('pause, stop, changed intent, changed draft and new control revision supersede a slow review',async()=>{
 for(const mode of ['pause','stop','intent','draft','revision']){
  const h=fixture(),entered=deferred(),wait=deferred();h.service.verify=async()=>{entered.resolve();return wait.promise;};
  const pending=h.run();await entered.promise;
  if(mode==='pause')h.task.status='paused';
  if(mode==='stop'){h.task.status='stopped';h.task.state.stopRequest={phase:'confirmed'};}
  if(mode==='intent')h.task.state.ownerRequest='新的不可丢弃要求';
  if(mode==='draft')h.physical.outboundText='已变化的补充稿';
  if(mode==='revision')h.bump();
  wait.resolve({verdict:'pass',report:'迟到验收',recoveryAction:'abandon-unsent-supplement'});
  await assert.rejects(pending,error=>['ABORT_ERR','E_EVIDENCE_CHANGED'].includes(error.code));assert.equal(h.saves.length,0);assert.equal(h.accepted.length,0);assert.equal(h.followed.length,0);
 }
});
test('a failed archive write never clears the pending draft or accepts the result',async()=>{
 const h=fixture(),before=structuredClone(h.physical);h.service.desktop.persist=async()=>{throw Error('fixture write failure');};
 await assert.rejects(h.run(),/fixture write failure/);assert.deepEqual(h.physical,before);assert.equal(h.accepted.length,0);
});
test('a legacy running result is hydrated only from its exact completed message before strict recovery',async()=>{
 const h=fixture();h.physical.monitorStatus='running';h.physical.followUpPending.priorSnapshot.fields.monitorStatus='running';
 const before=structuredClone(h.physical);
 h.service.desktop.observeWorkBuddy=async query=>query.followUpPending?null:{sessionId:'bound',taskId:9,messageKey:'old',status:'ok',startedAt:110,updatedAt:350,summary:before.monitorSummary};
 const candidate=await h.service.priorResultCandidate(h.physical,h.task);assert.equal(candidate.ok,true);assert.equal(candidate.priorTask.monitorStatus,'ok');assert.equal(candidate.priorTask.monitorTaskId,9);assert.deepEqual(h.physical,before);assert.equal(h.saves.length,0);
 const result=await h.run();assert.equal(result.completed,true);assert.equal(h.service.desktop.task.monitorStatus,'ok');assert.equal(h.service.desktop.task.monitorTaskId,9);assert.equal(h.service.desktop.task.submissionDraftArchives[0].current.outboundText,'完整补充稿');
});
test('missing, unrelated, non-final or malformed old observations do not upgrade a stale running result',async()=>{
 for(const patch of [null,{sessionId:'other'},{messageKey:'new'},{status:'running'},{status:'failed'},{status:'stopped'},{startedAt:301},{updatedAt:100},{summary:''}]){
  const h=fixture();h.physical.monitorStatus='running';h.physical.followUpPending.priorSnapshot.fields.monitorStatus='running';const before=structuredClone(h.physical);
  h.service.desktop.observeWorkBuddy=async query=>query.followUpPending||patch===null?null:{sessionId:'bound',taskId:1,messageKey:'old',status:'ok',startedAt:110,updatedAt:350,summary:'实际完成正文',...patch};
  const candidate=await h.service.priorResultCandidate(h.physical,h.task);assert.equal(candidate.ok,false,JSON.stringify(patch));assert.deepEqual(h.physical,before);assert.equal(h.saves.length,0);assert.equal(h.accepted.length,0);
 }
});
test('late archive persistence cannot revive a paused Task or replace a changed desktop generation',async()=>{
 for(const mode of ['pause','generation']){
  const h=fixture(),before=structuredClone(h.physical);
  h.service.desktop.persist=async value=>{h.saves.push(structuredClone(value));if(mode==='pause')h.task.status='paused';else h.service.desktop.generation++;};
  await assert.rejects(h.run(),error=>['ABORT_ERR','E_EVIDENCE_CHANGED'].includes(error.code));assert.deepEqual(h.physical,before);assert.equal(h.service.desktop.task,h.physical);assert.equal(h.accepted.length,0);
 }
});
test('explicit review grants only result review; automatic maintenance respects pause and runs once per evidence key',async()=>{
 const h=fixture();h.task.status='paused';
 assert.equal((await h.service.requestPriorResultReview(h.task.id)).ok,true);assert.equal(h.requests.length,1);assert.equal(h.service.workRecoveryRequests.size,0);assert.equal(h.task.state.priorResultReview.mode,'explicit');
 h.task.status='paused';h.requests.length=0;delete h.task.state.priorResultReview;
 await h.service.refreshPriorResultCheckpoints({schedule:true});assert.equal(h.requests.length,0);assert.equal(h.task.state.workCheckpoint.capabilities.reviewPriorResult.available,true);
 h.task.status='needs_attention';await h.service.refreshPriorResultCheckpoints({schedule:true});assert.equal(h.requests.length,1);assert.equal(h.task.state.priorResultReview.mode,'automatic');
 h.task.status='needs_attention';await h.service.refreshPriorResultCheckpoints({schedule:true});assert.equal(h.requests.length,1);
});
test('an untyped old stop exposes a manual-only review and never resumes automatically or from a persisted flag',async()=>{
 const h=fixture();h.physical.status='stopped';h.task.status='needs_attention';const before=structuredClone(h.physical);
 await h.service.refreshPriorResultCheckpoints({schedule:true});assert.equal(h.requests.length,0);assert.equal(h.task.state.workCheckpoint.capabilities.reviewPriorResult.requiresExplicit,true);
 h.task.status='waiting';assert.equal((await h.run()).needsAttention,true);assert.equal(h.accepted.length,0);assert.deepEqual(h.physical,before);
 h.task.status='needs_attention';assert.equal((await h.service.requestPriorResultReview(h.task.id)).ok,true);assert.equal(h.service.workRecoveryRequests.size,0);
 const saved=structuredClone(h.task.state.priorResultReview);h.service.priorResultReviewAuthorizations.clear();assert.equal((await h.run()).needsAttention,true);assert.equal(h.accepted.length,0,'persisted explicit flag is not current-process permission');
 h.task.status='needs_attention';assert.equal((await h.service.requestPriorResultReview(h.task.id)).ok,true);assert.notEqual(h.task.state.priorResultReview.requestId,saved.requestId);
 assert.equal((await h.run()).completed,true);assert.equal(h.accepted.length,1);assert.equal(h.followed.length,0);assert.equal(h.service.priorResultReviewAuthorizations.size,0);assert.equal(h.service.desktop.task.submissionDraftArchives[0].recoveryAuthorization.kind,'review-prior-result');
});
test('typed user stop cannot be overridden by the new safe-review operation',async()=>{
 const h=fixture();h.physical.status='stopped';h.physical.controllerLifecycle={schema:'bunny.controller-lifecycle/v1',state:'stopped',intent:'user-stop',terminal:true};h.task.status='needs_attention';
 await h.service.refreshPriorResultCheckpoints({schedule:true});assert.equal(h.task.state.workCheckpoint.capabilities,undefined);assert.equal((await h.service.requestPriorResultReview(h.task.id)).ok,false);assert.equal(h.requests.length,0);
 h.task.status='waiting';assert.equal((await h.run()).needsAttention,true);assert.equal(h.accepted.length,0);assert.equal(h.saves.length,0);
});
test('the real Task lifecycle reports the retained original result and never re-submits either draft',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-prior-result-'));
 const h=fixture(),records=new Map(),reports=[];let submits=0;
 const desktop=h.service.desktop;desktop.start=async()=>{submits++;throw Error('must not start');};
 const service=new AgentService({desktop,journal:{put:async value=>records.set(value.id,structuredClone(value)),list:async()=>[],authorized:async()=>true},scene:{native:{request:async()=>assert.fail('no native calls')},metrics:{},close:async()=>{}},taskDirectory:root,report:async value=>reports.push(value),verify:h.service.verify,epoch:()=>1,autoSchedule:false});
 try{
  const created=await service.start({skill:'work.delegate',goal:'原目标',subjects:[{application:'workbuddy'}]}, {role:'owner',verified:true,sources:['fixture-owner'],scene:'life'}, {ownerRequest:'完整主人要求'});
  const task=service.runtime.tasks.get(created.id);desktop.task.sources=[task.id];task.state.job=structuredClone(h.task.state.job);task.operations=structuredClone(h.task.operations);task.state.ownerContext='完整必要背景';
  task.status='needs_attention';await service.runtime.save(task);await service.recoverPending();assert.equal(task.state.priorResultReview.mode,'automatic');await service.runtime.tick(task.id);
  assert.equal(task.status,'completed');assert.equal(task.state.result.source.messageKey,'old');assert.equal(submits,0);assert.equal(h.followed.length,0);assert.equal(reports.length,1);assert.match(reports[0].text,/https:\/\/example.test\/result/);assert.equal(records.get(task.id).state.result.source.messageKey,'old');
 }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('the real lifecycle synchronizes running to ok before a refused supplement, then recovers and reports once',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-result-facts-'));
 const h=fixture(),records=new Map(),reports=[];let reviews=0,supplements=0;
 const desktop=h.service.desktop;desktop.task=structuredClone(h.physical.followUpPending.priorSnapshot.fields);
 Object.assign(desktop.task,{id:'physical',target:'workbuddy',status:'monitoring',monitorStatus:'running',sources:[],steps:structuredClone(h.physical.steps.slice(0,2))});
 desktop.observeWorkBuddy=async query=>query.followUpPending?null:{sessionId:'bound',taskId:7,messageKey:'old',status:'ok',startedAt:110,updatedAt:250,summary:'实际成果 https://example.test/result'};
 desktop.followUp=async()=>{supplements++;const current=desktop.task;assert.equal(current.monitorStatus,'ok');assert(h.saves.some(record=>record.monitorStatus==='ok'));
  current.followUpPending=beginFollowUpDraft(current,300,{origin:'automatic'});assert.equal(current.followUpPending.priorSnapshot.fields.monitorStatus,'ok');
  current.outboundText='保留的未发补充';current.steps.push({action:'workbuddyFill',state:'input-sent',at:300,submissionRound:1});current.followUpPending.dispatchProof=bindNotDispatchedProof(current,{dispatched:false,code:'E_GUI_POINTER_BLOCKED'},{at:400});current.status='paused';return {ok:false,error:'本次指针操作未发出'};
 };
 const service=new AgentService({desktop,journal:{put:async value=>records.set(value.id,structuredClone(value)),list:async()=>[],authorized:async()=>true},scene:{native:{request:async()=>assert.fail('no native calls')},metrics:{},close:async()=>{}},taskDirectory:root,report:async value=>reports.push(value),verify:async()=>++reviews===1?{verdict:'revise',report:'需补充核实。',followUp:'补充检查'}:{verdict:'pass',report:'原成果已完成。',recoveryAction:'abandon-unsent-supplement',links:[{url:'https://example.test/result'}]},epoch:()=>1,autoSchedule:false});
 try{
  const created=await service.start({skill:'work.delegate',goal:'原目标',subjects:[{application:'workbuddy'}]}, {role:'owner',verified:true,sources:['fixture-owner'],scene:'life'}, {ownerRequest:'完整主人要求'});
  const task=service.runtime.tasks.get(created.id);desktop.task.sources=[task.id];task.state.job=structuredClone(h.task.state.job);task.operations=structuredClone(h.task.operations);await service.runtime.save(task);
  await service.runtime.tick(task.id);assert.equal(task.status,'needs_attention');assert.equal(desktop.task.monitorStatus,'ok');assert.equal(supplements,1);
  await service.recoverPending();await service.runtime.tick(task.id);assert.equal(task.status,'completed');assert.equal(reviews,2);assert.equal(supplements,1);assert.equal(desktop.task.submissionDraftDisposition.disposition,'abandoned-before-dispatch');assert.equal(task.state.result.source.messageKey,'old');assert.equal(reports.filter(report=>report.text.includes('https://example.test/result')).length,1);
 }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});
