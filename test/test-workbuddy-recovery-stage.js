'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AgentService}=require('../src/main/agent-service'),{taskGuidance}=require('../src/main/task-presentation'),repair=require('../src/main/self-repair');
const diagnostic={operation:'newTask',candidateCount:2,method:'ax'};
test('pre-submission failure is not presented as an existing session or result',()=>{
 const task={skill:'work.delegate',status:'needs_attention',state:{},operations:{submit:{tool:'work.submit',effect:'write',status:'not_dispatched'}}};
 assert.equal(taskGuidance(task).title,'交办尚未成功');assert(!taskGuidance(task).detail.includes('已有成果'));assert(!taskGuidance(task).detail.includes('原工作会话'));
 task.state.job={jobId:'physical'};assert.equal(taskGuidance(task).title,'WorkBuddy进度待核对');assert(!taskGuidance(task).detail.includes('已有结果'));
 task.state.result={summary:'actual result'};assert.equal(taskGuidance(task).title,'成果交付待核对');
 delete task.state.result;delete task.state.job;task.operations.submit.status='intent';assert.equal(taskGuidance(task).kind,'work-submit');
});
test('diagnosis preserves only typed method facts and real evidence changes affect its incident',async()=>{
 const clean=repair.diagnostic({...diagnostic,request:'private-original',label:'private-contact'});assert.deepEqual(clean,diagnostic);let supplied;
 await repair.advise({kind:'unexpected',skill:'fixture',code:'E_GUI_TARGET_AMBIGUOUS',attempt:1,diagnostic:{...diagnostic,request:'private-original'},request:async options=>{supplied=JSON.parse(options.messages[1].content);return {response:{text:'{"action":"defer"}'}};}});
 assert.deepEqual(supplied.diagnostic,diagnostic);assert(!JSON.stringify(supplied).includes('private-original'));
 const task={skill:'fixture',inbox:[],state:{}},error={code:'E_GUI_TARGET_AMBIGUOUS',message:'ambiguous',diagnostic};assert.notEqual(repair.incident(task,error),repair.incident(task,{...error,diagnostic:{...diagnostic,candidateCount:3}}));assert.equal(repair.incident(task,error),repair.incident(task,{...error,diagnostic:{...diagnostic,label:'another private label'}}));
});
test('an explicitly resumed unsent task survives restart and uses the same physical operation without creating a duplicate',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-method-recovery-')),records=new Map();let starts=0,resumes=0,ready=false;
 const journal={put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[...records.values()].map(task=>structuredClone(task)),authorized:async()=>true};
 const makeDesktop=physical=>({task:physical,running:false,journal:async()=>{},publicStatus:()=>({}),stop:async()=>{},observeWorkBuddy:async()=>({status:'running'}),start:async function(value){starts++;this.task={...value,id:'same-physical',target:'workbuddy',status:'paused',steps:[],errorCode:'E_GUI_TARGET_AMBIGUOUS',errorDiagnostic:{...diagnostic},note:'navigation target ambiguous'};return {ok:true,id:this.task.id};},resume:async function(){resumes++;if(ready)Object.assign(this.task,{status:'monitoring',handoffSent:true,sessionId:'bound-once',monitorSessionId:'bound-once',monitorMessageKey:'new-message'});return {ok:true};}});
 const make=desktop=>new AgentService({desktop,journal,scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},ready:()=>true,epoch:()=>1,canOperate:async()=>true,autoSchedule:false,taskDirectory:root,request:async()=>({response:{text:'{"action":"retry"}'}})});
 let desktop=makeDesktop(null),agent=make(desktop);try{
  const owner={role:'owner',verified:true,sources:['owner-source'],scene:'life'},created=await agent.start({skill:'work.delegate',goal:'create and publish an educational game',subjects:[{application:'workbuddy'}],workRequest:{goal:'create and publish an educational game',output:'files'}},owner,{ownerRequest:'original wording remains private'});
  for(let i=0;i<3;i++)await agent.runtime.tick(created.id);let task=agent.runtime.tasks.get(created.id);assert.equal(task.status,'needs_attention');assert.equal(starts,1);assert.equal(task.state.workOperationId,'same-physical');assert.deepEqual(task.state.lastFailure.diagnostic,diagnostic);assert.equal(Object.values(task.operations).find(op=>op.tool==='work.submit').status,'not_dispatched');const savedPhysical=structuredClone(desktop.task),beforeOwner=task.state.ownerRequest;await agent.close();
  desktop=makeDesktop(savedPhysical);agent=make(desktop);await agent.restore();task=agent.runtime.tasks.get(created.id);assert.equal(task.status,'needs_attention');assert.equal(starts,1,'restoring must not auto-submit or recreate this attention task');assert.equal(task.state.ownerRequest,beforeOwner);const priorResumes=resumes;
  ready=true;assert.equal((await agent.resolveAttention(created.id)).ok,true);await agent.runtime.tick(created.id);task=agent.runtime.tasks.get(created.id);assert.equal(task.state.job.jobId,'same-physical');assert.equal(task.state.job.sessionId,'bound-once');assert.equal(starts,1);assert.equal(resumes,priorResumes+1);assert.equal(task.state.ownerRequest,beforeOwner);assert.equal(task.id,created.id);
 }finally{await agent.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('an unconfirmed write remains uncertain and cannot take the ordinary resume path',async()=>{
 const context={desktop:{running:false},waitForWorkSubmission:AgentService.prototype.waitForWorkSubmission},physical={id:'pending',target:'workbuddy',draftInserted:true,submitAttemptedAt:1,note:'receipt unknown',errorCode:'E_GUI_TARGET_AMBIGUOUS',errorDiagnostic:diagnostic};
 const result=await context.waitForWorkSubmission(physical,new AbortController().signal);assert.equal(result.dispatched,undefined);assert.deepEqual(result.diagnostic,diagnostic);assert.equal(result.code,'E_GUI_TARGET_AMBIGUOUS');
});
