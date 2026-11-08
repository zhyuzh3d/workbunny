'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {taskGuidance,taskPresentation}=require('../src/main/task-presentation');
const {workSubmissionState}=require('../src/main/workbuddy-observation');

function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function fixture(physical,{lastError,status='needs_attention',operationStatus='intent'}={}){
 const task={id:'task-fixture',skill:'work.delegate',goal:'fixture work',status,note:'操作结果不确定，已停止重发；保留原提交记录',
  operations:{submit:{id:'submit',tool:'work.submit',effect:'write',status:operationStatus,args:{application:'workbuddy'}}},
  state:{workCheckpoint:workSubmissionState(physical),reconciliation:{submit:{phase:'needs_evidence',checkpointPhase:workSubmissionState(physical).phase,...(lastError?{lastError}:{})}}}};
 return {physical,task};
}
function presentWithoutMutation(data){
 const before=structuredClone(data);freeze(data);
 const view=taskPresentation(data.task);assert.deepEqual(data,before,'presentation must preserve phase, flags, steps and operation ledger');return view;
}
function sentPhysical(){return {id:'physical-fixture',draftInserted:true,draftInsertedAt:100,submitAttemptedAt:200,submittedAt:300,handoffSent:true,sessionId:'original-session',monitorSessionId:'original-session',
  followUpAwaitingMonitor:true,followUpPending:{round:2,state:'sent',submittedAt:300},steps:[
   {action:'workbuddyFill',purpose:'task',state:'input-sent',at:100},
   {action:'workbuddySend',purpose:'submit',state:'input-sent',at:300},
   {action:'key',purpose:'submit',state:'not-dispatched',at:400,recoveryOf:300}]};}

test('a recovery pre-dispatch refusal cannot replace the original unknown submission fact',()=>{
 const lastError='提交位置或原编辑器焦点未核实，未发送',data=fixture(sentPhysical(),{lastError});
 assert.equal(data.task.state.workCheckpoint.phase,'submission-unknown');
 const {guidance}=presentWithoutMutation(data);
 assert.equal(guidance.title,'交办还需补证');
 assert.equal(guidance.detail,'原提交结果仍待核对，不重复发送。最近恢复检查：'+lastError);
 assert.equal(guidance.primaryLabel,'核对并继续');
 assert.equal(data.task.operations.submit.status,'intent');
 assert.equal(data.physical.followUpPending.state,'sent');
});

test('unknown recovery errors retain their own wording without being classified as undispatched',()=>{
 const lastError='恢复提交仍待本轮消息确认，保留记录且不重发',data=fixture(sentPhysical(),{lastError});
 const {guidance}=presentWithoutMutation(data);
 assert(guidance.detail.startsWith('原提交结果仍待核对，不重复发送。'));
 assert(guidance.detail.endsWith('最近恢复检查：'+lastError));
 assert(!guidance.detail.includes('本次未发送'));
});

test('unknown submission without a recovery error still preserves the barrier in its summary',()=>{
 const {guidance}=presentWithoutMutation(fixture(sentPhysical()));
 assert.equal(guidance.detail,'原提交结果仍待核对，不重复发送。原任务、草稿和提交记录已保留。');
});

test('only a draft-ready checkpoint describes a draft with no submission action',()=>{
 const physical={draftInserted:true,draftInsertedAt:100,steps:[{action:'workbuddyFill',purpose:'task',state:'input-sent',at:100}]};
 const ready=presentWithoutMutation(fixture(physical));
 assert.equal(ready.guidance.title,'原草稿待继续');
 assert.match(ready.guidance.detail,/尚无提交动作/);
 const uncertain=fixture({steps:[{action:'workbuddyFill',purpose:'task',state:'intent',at:100}]});
 assert.equal(uncertain.task.state.workCheckpoint.phase,'input-unknown');
 assert.doesNotMatch(presentWithoutMutation(uncertain).guidance.detail,/尚无提交动作|尚未提交/);
});

test('a confirmed receipt and ledger follow the original work without resurfacing an old recovery refusal',()=>{
 const physical=sentPhysical();physical.followUpAwaitingMonitor=false;physical.followUpPending.state='observed';
 Object.assign(physical,{followUpRound:2,previousMonitorMessageKey:'previous-round',monitorMessageKey:'current-round',monitorStartedAt:300,monitorUpdatedAt:450});
 const data=fixture(physical,{status:'waiting',operationStatus:'confirmed',lastError:'提交位置或原编辑器焦点未核实，未发送'});
 data.task.state.job={jobId:physical.id};
 assert.equal(data.task.state.workCheckpoint.phase,'confirmed');
 const view=presentWithoutMutation(data);
 assert.equal(view.statusLabel,'WorkBuddy执行中');assert.equal(view.guidance,undefined);
 assert.equal(taskGuidance(data.task),null);
});
