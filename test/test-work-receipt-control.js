'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {AgentService}=require('../src/main/agent-service');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const aborted=error=>error.code==='ABORT_ERR'&&error.dispatched===false;
function statusFixture(){
 const task={id:'owner-task',status:'waiting',state:{workPhase:'executing'}},physical={id:'physical',target:'workbuddy',sources:[task.id],status:'awaiting',handoffSent:true,sessionId:'bound',monitorSessionId:'bound',monitorMessageKey:'message',monitorTaskId:1,submittedAt:100,monitorStatus:'running'};
 const saved=[],accepted=[],followed=[],controller=new AbortController();let observation={status:'running'};
 const context={runtime:{tasks:new Map([[task.id,task]]),save:async()=>{},journal:{authorized:async()=>true}},learning:{reviewContext:async()=>({knowledge:[],sourceIds:[],availability:'fixture',isCurrent:async()=>true})},desktop:{task:physical,running:false,observeWorkBuddy:async()=>observation,publicStatus:()=>({screenshot:null}),journal:async()=>saved.push(structuredClone(physical)),persist:async value=>saved.push(structuredClone(value)),accept:async value=>{accepted.push(value);physical.status='accepted';},followUp:async value=>{followed.push(value);return {ok:true};}},verify:async()=>({verdict:'pass',report:'Verified fixture result',links:[]})};
 return {task,physical,context,saved,accepted,followed,controller,setObservation:value=>{observation={sessionId:'bound',taskId:1,messageKey:'message',startedAt:101,updatedAt:200,...value};},run:()=>AgentService.prototype.workStatus.call(context,physical.id,task,controller.signal)};
}
test('Task work.status follows and verifies a bound receipt while the desktop runner is idle',async()=>{
 const h=statusFixture();assert.equal((await h.run()).completed,false);assert.equal(h.physical.status,'monitoring');assert.equal(h.context.desktop.running,false);
 h.setObservation({status:'ok',summary:'Actual fixture output'});const result=await h.run();assert.equal(result.completed,true);assert.equal(result.verified,true);assert.equal(result.result.text,'Actual fixture output');assert.equal(h.accepted.length,1);
});
test('a resumed Task reads its already bound externally running job after a local runner pause',async()=>{
 const h=statusFixture();h.physical.status='stopped';h.physical.monitorStatus='running';h.context.workRecoveryRequests=new Set([h.task.id]);const result=await h.run();assert.equal(result.completed,false);assert.equal(h.physical.status,'monitoring');assert.equal(h.followed.length,0);assert.equal(h.accepted.length,0);
 h.physical.status='stopped';h.physical.monitorStatus='stopped';assert.equal((await h.run()).needsAttention,true);assert.equal(h.physical.status,'stopped');
});
test('an older bound work is observed and persisted without touching the new desktop task',async()=>{
 const h=statusFixture(),newTask={id:'other-physical',status:'running',goal:'unrelated fixture'};h.context.desktop.task=newTask;
 h.context.memory={ready:true,sensitiveValues:async()=>[],db:{request:async()=>({rows:[{state:'active',value:h.physical}]})},decode:row=>row};
 h.context.desktop.accept=async()=>{throw Error('must not accept the new desktop task');};h.context.desktop.followUp=async()=>{throw Error('must not revise the new desktop task');};
 assert.equal((await h.run()).completed,false);assert.equal(h.saved.at(-1).id,h.physical.id);
 h.setObservation({status:'ok',summary:'Older exact result'});const result=await h.run();assert.equal(result.completed,true);assert.equal(h.saved.at(-1).id,h.physical.id);assert.equal(h.saved.at(-1).status,'accepted');assert.deepEqual(newTask,{id:'other-physical',status:'running',goal:'unrelated fixture'});
});
for(const phase of ['monitor','verify'])for(const status of ['paused','stopped'])for(const verdict of ['pass','revise'])test(`${status} during ${phase} prevents a late ${verdict} from accepting, revising or reviving work`,async()=>{
 const h=statusFixture(),wait=deferred();
 if(phase==='monitor')h.context.desktop.observeWorkBuddy=()=>wait.promise;
 else{h.physical.status='review';h.physical.monitorStatus='ok';h.context.verify=()=>wait.promise;}
 const pending=h.run();await flush();h.task.status=status;if(status==='stopped')h.task.state.stopRequest={phase:'confirmed'};h.physical.status=status;
 wait.resolve(phase==='monitor'?{status:'ok',summary:'Late fixture output'}:{verdict,report:'Late fixture verification',followUp:'Must not send'});
 await assert.rejects(pending,aborted);assert.equal(h.accepted.length,0);assert.equal(h.followed.length,0);assert.equal(h.physical.status,status);
});
test('replacement, signal cancellation and a late persistence completion cannot continue work',async()=>{
 for(const kind of ['replacement','signal','persist']){
  const h=statusFixture(),wait=deferred();if(kind==='persist')h.context.desktop.journal=()=>wait.promise;else h.context.desktop.observeWorkBuddy=()=>wait.promise;
  const pending=h.run();await flush();if(kind==='replacement')h.context.runtime.tasks.set(h.task.id,{...h.task});else if(kind==='signal')h.controller.abort();else{h.task.status='paused';h.physical.status='paused';}
  wait.resolve({status:'ok',summary:'Late fixture'});await assert.rejects(pending,aborted);assert.equal(h.accepted.length,0);assert.equal(h.followed.length,0);
 }
});
test('cancellation after an actual accept does not roll back the completed acceptance',async()=>{
 const h=statusFixture(),wait=deferred();h.physical.status='review';h.physical.monitorStatus='ok';h.context.desktop.accept=async()=>{h.accepted.push(true);h.physical.status='accepted';await wait.promise;};
 const pending=h.run();await flush();assert.equal(h.accepted.length,1);h.controller.abort();wait.resolve();await assert.rejects(pending,aborted);assert.equal(h.physical.status,'accepted');
});
function receiptFixture(){
 const records=new Map(),physicalRecords=new Map();let recoveries=0,observations=0,accepted=0;
 const physical={id:'physical-receipt',target:'workbuddy',scene:'life',domain:'life',visibilityFloor:1,status:'paused',draftInserted:true,draftInsertedAt:1,steps:[{action:'type',purpose:'task',state:'input-sent',at:1}],outboundText:'unchanged fixture brief',startedAt:1};
 const desktop={task:physical,running:false,publicStatus:()=>({screenshot:null}),emit:()=>{},journal:async()=>physicalRecords.set(physical.id,structuredClone(physical)),observeWorkBuddy:async()=>{observations++;return {sessionId:'bound-receipt',taskId:1,messageKey:'exact-message',status:'running'};},start:async()=>{throw Error('must not start or resend');},resume:async()=>{throw Error('must not refill');},stop:async()=>{},recoverWorkBuddySubmission:async()=>{recoveries++;Object.assign(physical,{handoffSent:true,sessionId:'bound-receipt',monitorSessionId:'bound-receipt',monitorTaskId:1,monitorMessageKey:'exact-message',status:'monitoring'});await desktop.journal();return {ok:true,verified:true,jobId:physical.id,sessionId:physical.sessionId};},accept:async()=>{accepted++;physical.status='accepted';},persist:async value=>physicalRecords.set(value.id,structuredClone(value))};
 const agent=new AgentService({desktop,journal:{put:async value=>records.set(value.id,structuredClone(value)),list:async()=>[...records.values()].map(value=>structuredClone(value)),authorized:async()=>true},scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},ready:()=>true,epoch:()=>1,canOperate:async()=>true,autoSchedule:false,verify:async()=>({verdict:'pass',report:'Verified fixture result',links:[]}),report:async()=>{}});
 async function prepare(){
  const created=await agent.start({skill:'work.delegate',goal:'Follow the original fixture work',subjects:[{application:'workbuddy'}]}, {role:'owner',verified:true,channel:'dialogue',sources:['fixture-owner'],scene:'life'});
  const task=agent.runtime.tasks.get(created.id),hash=value=>crypto.createHash('sha256').update(value).digest('hex'),id=hash(task.id+'\0submit-work');
  physical.sources=[task.id];task.status='needs_attention';task.state.workOperationId=physical.id;task.state.workPhase='submitting';task.operations[id]={id,key:'submit-work',tool:'work.submit',effect:'write',status:'intent',args:{application:'workbuddy'},argsHash:hash(JSON.stringify({application:'workbuddy'}))};await agent.runtime.save(task);return {task,operation:task.operations[id]};
 }
 return {agent,desktop,physical,records,physicalRecords,prepare,recoveries:()=>recoveries,observations:()=>observations,accepted:()=>accepted};
}
test('resume returns the persisted receipt before business completion, then the production Task path polls without resubmitting',async()=>{
 const h=receiptFixture();try{const {task,operation}=await h.prepare(),result=await h.agent.control('resume',task.id);
  assert.equal(result.ok,true,result.error);assert.equal(result.message,'WorkBuddy已接收，Bunny正在跟进原会话');assert.equal(h.recoveries(),1);assert.equal(h.observations(),0);assert.equal(h.physicalRecords.get(h.physical.id).handoffSent,true);assert.equal(h.records.get(task.id).operations[operation.id].status,'confirmed');assert.equal(h.agent.runtime.controllers.has(task.id),false);
  await h.agent.runtime.tick(task.id);assert.equal(task.state.job.jobId,h.physical.id);assert.equal(task.status,'waiting');assert.equal(h.observations(),1);assert.equal(h.recoveries(),1);assert.equal(h.desktop.running,false);
 }finally{await h.agent.close();}
});
for(const operation of ['pause','stop'])test(`a newer ${operation} supersedes resume while receipt reconciliation is awaiting`,async()=>{
 const h=receiptFixture(),wait=deferred();try{const {task}=await h.prepare();h.agent.reconcile=async()=>{await wait.promise;task.state.workCheckpoint={phase:'confirmed'};return {ok:true};};
  const pending=h.agent.control('resume',task.id);await flush();await h.agent.runtime.control(operation,task.id);const canonical=h.agent.runtime.tasks.get(task.id),terminalStatus=canonical.status;wait.resolve();const result=await pending;assert.equal(result.ok,false);assert.equal(result.superseded,true);assert.equal(canonical.status,terminalStatus);assert.equal(canonical.status,operation==='pause'?'paused':'stopped');
 }finally{await h.agent.close();}
});
