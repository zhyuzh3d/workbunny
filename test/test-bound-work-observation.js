'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {boundWorkObservationQuery,syncBoundWorkObservation,observeWorkBuddy,beginFollowUpDraft}=require('../src/main/workbuddy-observation');
const {bindNotDispatchedProof,draftReviewCandidate}=require('../src/main/submission-draft');
function fixture({draft=false,legacy=false}={}){
 const task={id:'physical',target:'workbuddy',status:'monitoring',goal:'original goal',criteria:'original criteria',sources:['owner'],authority:{verified:true,role:'owner'},
  handoffSent:true,sessionId:'bound',monitorSessionId:'bound',monitorTaskId:1,monitorMessageKey:'stable',monitorStatus:'running',monitorSummary:'earlier progress',submittedAt:10000,followUpRound:0,
  outboundText:'original request',steps:[{action:'workbuddySend',state:'input-sent',at:10000}]};
 if(draft){task.followUpPending=beginFollowUpDraft(task,20000);task.steps.push({action:'workbuddyFill',state:'input-sent',at:20000,submissionRound:1});task.outboundText='unsent supplement';task.status='paused';task.followUpPending.dispatchProof=bindNotDispatchedProof(task,{dispatched:false,code:'E_GUI_POINTER_BLOCKED'},{at:20001});if(legacy)delete task.followUpPending.priorSnapshot;}
 return task;
}
const completed=()=>({sessionId:'bound',taskId:7,messageKey:'stable',status:'ok',summary:'finished result https://fixture.invalid/game',links:[{url:'https://fixture.invalid/game'}],startedAt:10001,updatedAt:19000,model:'fixture',sessionTitle:'original conversation'});
test('a stable bound completed message updates all facts while task counters may reorder',()=>{
 const task=fixture(),before=structuredClone(task),query=boundWorkObservationQuery(task),record=completed();
 const monitor={sessions:new Map([['fixture',{snap:{sessionId:'bound',task:{id:record.taskId,bunnyTaskId:task.id,messageKey:record.messageKey,status:'ok',summary:record.summary,startedAt:record.startedAt,endedAt:record.updatedAt}}}]])};
 assert.equal(observeWorkBuddy(monitor,query).taskId,7);
 const result=syncBoundWorkObservation(task,record);assert.equal(result.ok,true);assert.equal(result.task.monitorStatus,'ok');assert.equal(result.task.monitorTaskId,7);assert.equal(result.task.monitorMessageKey,'stable');assert.equal(result.task.monitorSummary,record.summary);assert.equal(result.task.monitorStartedAt,10001);assert.equal(result.task.monitorUpdatedAt,19000);assert.equal(result.task.monitorModel,'fixture');assert.equal(result.task.sessionTitle,'original conversation');
 for(const key of ['goal','criteria','sources','authority','steps','outboundText','status'])assert.deepEqual(result.task[key],task[key]);assert.deepEqual(task,before);
});
test('prior-result refresh repairs running facts in both snapshot and legacy projections without altering the unsent round',()=>{
 for(const legacy of [false,true]){
  const task=fixture({draft:true,legacy}),before=structuredClone(task);assert.equal(draftReviewCandidate(task).ok,false);
  const query=boundWorkObservationQuery(task,{priorResult:true});assert.equal(query.monitorMessageKey,'stable');assert.equal(query.followUpPending,undefined);assert.equal(query.followUpRound,0);
  const result=syncBoundWorkObservation(task,{...completed(),updatedAt:22000},{priorResult:true});assert.equal(result.ok,true);assert.equal(result.task.followUpPending.state,'draft-unknown');assert.equal(result.task.followUpRound,0);assert.equal(result.task.outboundText,'unsent supplement');assert.deepEqual(result.task.steps,task.steps);assert.deepEqual(result.task.authority,task.authority);
  if(!legacy){assert.equal(result.task.followUpPending.priorSnapshot.fields.monitorStatus,'ok');assert.equal(result.task.followUpPending.priorSnapshot.fields.monitorTaskId,7);}
  assert.equal(draftReviewCandidate(result.task).ok,true);assert.deepEqual(task,before);
 }
});
test('different messages, missing keys, non-completion and invalid times cannot manufacture completion',()=>{
 const task=fixture({draft:true});
 for(const patch of [{sessionId:'other'},{messageKey:'new-supplement'},{messageKey:undefined},{status:'running'},{status:'failed'},{status:'abandoned'},{taskId:undefined},{startedAt:7999},{startedAt:20000},{startedAt:21000},{startedAt:NaN},{startedAt:'10001'},{updatedAt:10000},{updatedAt:Infinity},{summary:' '}])assert.equal(syncBoundWorkObservation(task,{...completed(),...patch},{priorResult:true}).ok,false,JSON.stringify(patch));
 delete task.monitorMessageKey;assert.equal(boundWorkObservationQuery(task,{priorResult:true}),null);
});
test('a pending or uncertain new submission never becomes a prior-result query',()=>{
 for(const mutate of [task=>{task.followUpPending.state='unknown';},task=>{task.followUpPending.submittedAt=21000;},task=>{task.followUpAwaitingMonitor=true;},task=>{task.steps.splice(1,0,{action:'workbuddySend',state:'unknown',at:15000,submissionRound:1});},task=>{task.followUpPending.baselineMessageKey='another';}]){
  const task=fixture({draft:true});mutate(task);assert.equal(boundWorkObservationQuery(task,{priorResult:true}),null);assert.equal(syncBoundWorkObservation(task,completed(),{priorResult:true}).ok,false);
 }
});
