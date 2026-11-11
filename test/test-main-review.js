'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime');
const {ToolRegistry}=require('../src/main/agent-tools');
const {SkillRegistry}=require('../src/main/agent-skills');
const {taskMonitorFact}=require('../src/main/task-supervision');
const owner={role:'owner',verified:true,sources:['synthetic-owner'],scene:'life'};
const spec={skill:'fixture.review',goal:'finish the authorized goal',subjects:[{application:'system'}]};
const deferred=()=>Promise.withResolvers();
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const plan=(type='replan')=>({type,rationaleSummary:'Recheck the false premise using the retained evidence and an alternate path',sourceRefs:[],guidance:{hypotheses:['initial interpretation can be wrong'],verificationIdeas:['read the independent fixture state'],alternativeStrategies:['use the alternative verified path']}});
function harness(run,{reviewTask=async()=>plan(),...options}={}){
 let now=1000,authorized=true;const records=new Map(),effects=[],reports=[],tools=new ToolRegistry();
 tools.register({name:'fixture.write',description:'synthetic effect',effect:'write',capabilities:['fixture.write'],execute:async()=>{effects.push('once');return {ok:true,verified:true};}});
 const skills=new SkillRegistry(tools).register({id:spec.skill,description:'synthetic review task',version:1,tools:['fixture.write'],capabilities:['fixture.write'],run});
 const journal={put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[...records.values()].map(structuredClone),authorized:async()=>authorized};
 const runtime=new AgentRuntime({journal,tools,skills,autoSchedule:false,clock:()=>now,epoch:()=>1,reviewTask,report:async report=>reports.push(report),...options});
 return {runtime,records,effects,reports,tools,journal,start:()=>runtime.start(spec,owner),time:value=>now=value,revoke:()=>authorized=false};
}
const suspension={assessmentSummary:'The available local paths were checked and cannot currently advance',basisRefs:[],attemptedPaths:['different existing interpretations and a discriminating fixture probe'],remainingUncertainty:'An external condition might change',requestedHelp:'Find a broader path without changing the authorized goal',obstacleConfirmed:true};
test('monitor facts distinguish running deadlines, deliberate waits and budgets from business conclusions',()=>{
 const task={state:{}},run={startedAt:0,progress:{stage:'model',stageStartedAt:0,lastProgressAt:0,repeats:0}};
 assert.equal(taskMonitorFact(task,run,{now:100000,active:true}).reason,'stage-overdue');
 run.keepalive={wait:{until:120000}};assert.equal(taskMonitorFact(task,run,{now:100000,active:true}),null);
 run.recoveryState={status:'exhausted',startedAt:0};assert.deepEqual(taskMonitorFact(task,run,{now:100000}),{reason:'local-budget',at:0,obstacleConfirmed:false});
});
test('self suspension is reviewed and a different strategy completes the same action and effect ledger once',async t=>{
 let calls=0;const contexts=[];
 const h=harness(async ctx=>{contexts.push(ctx.recovery);if(!ctx.recovery?.guidanceId)return {status:'paused',selfSuspension:suspension};await ctx.call({tool:'fixture.write',key:'same-logical-effect',args:{}});return {status:'completed'};},{reviewTask:async args=>{calls++;assert.equal(args.task.status,'paused');assert(args.run.recoveryState.selfSuspension);return plan();}});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.tick(id);let task=h.runtime.tasks.get(id);const actionId=Object.keys(task.actionRuns)[0];assert.equal(task.status,'paused');assert.equal(h.runtime.capacity().active,0);
 await h.runtime.tick();await flush();task=h.runtime.tasks.get(id);assert.equal(calls,1);assert.equal(task.status,'waiting');assert.equal(task.actionRuns[actionId].recoveryState.mainReview.status,'applied');
 await h.runtime.tick(id);assert.equal(task.status,'completed');assert.equal(h.effects.length,1);assert.equal(Object.keys(task.actionRuns).length,1);assert.equal(contexts[1].source,'main-review');assert.equal(contexts[1].planRevision,1);
 assert.equal(h.records.get(id).actionRuns[actionId].recoveryState.strategy.outcome,'progressed');assert.equal(h.records.get(id).actionRuns[actionId].recoveryState.strategy.outcomeRefs.length,1,'actual guidance feedback is durable before completion');
 await h.runtime.mainReviews.apply(id,actionId,task.actionRuns[actionId].recoveryState.mainReview.reviewId);assert.equal(h.effects.length,1);assert.equal(task.status,'completed');
});
test('local budget exhaustion triggers review without fabricating self suspension and grants a bounded new window',async t=>{
 let executions=0;const gate=deferred();const h=harness(async ctx=>{executions++;if(ctx.recovery?.guidanceId){await ctx.call({tool:'fixture.write',key:'effect',args:{}});return {status:'completed'};}throw Object.assign(Error('uncertain local explanation'),{dispatched:false});},{reviewTask:()=>gate.promise,diagnoseRepair:async()=>({action:'change_method'})});t.after(()=>h.runtime.close());
 const {id}=await h.start();for(const at of [1000,2000,3000,6000]){h.time(at);await h.runtime.tick(id);}let task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0];assert.equal(task.status,'paused');assert.equal(run.recoveryState.selfSuspension,undefined);assert.equal(run.recoveryState.mainReview.reason,'local-budget');assert.equal(run.recoveryState.totalAttempts,3);
 await h.runtime.tick();gate.resolve(plan());await flush();task=h.runtime.tasks.get(id);run=Object.values(task.actionRuns)[0];assert.equal(task.status,'waiting');assert.equal(run.recoveryState.totalAttempts,3);assert.equal(run.recoveryState.window.fromTotal,3);
 await h.runtime.tick(id);assert.equal(task.status,'completed');assert.equal(executions,5);assert.equal(h.effects.length,1);
});
test('a pending review holds no worker/admission lane; another task progresses and owner stop rejects late guidance',async t=>{
 const gate=deferred();let calls=0;const h=harness(async ctx=>{if(ctx.task.state.independent)return {status:'completed'};return {status:'paused',selfSuspension:suspension};},{reviewTask:()=>{calls++;return gate.promise;}});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.tick(id);await h.runtime.tick();await flush();assert.equal(calls,1);assert.equal(h.runtime.controllers.size,0);
 const second=await h.start(),independent=h.runtime.tasks.get(second.id);independent.state.independent=true;await h.runtime.tick(second.id);assert.equal(independent.status,'completed');
 assert.equal((await h.runtime.control('stop',id)).ok,true);gate.resolve(plan());await flush();const stopped=h.runtime.tasks.get(id);assert.equal(stopped.status,'stopped');assert.equal(stopped.state.disposition,undefined);assert.equal(h.effects.length,0);
});
test('a scoped suspension preserves another scope and guidance restores only its original action',async t=>{
 const gate=deferred(),events=[];const h=harness(async ctx=>{events.push(ctx.event.key);if(ctx.event.key==='one'&&!ctx.recovery?.guidanceId)return {status:'paused',selfSuspension:suspension};return {status:'waiting'};},{reviewTask:()=>gate.promise});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.enqueue(id,{key:'one',scope:'a'});await h.runtime.enqueue(id,{key:'two',scope:'b'});await h.runtime.tick(id);let task=h.runtime.tasks.get(id);assert.equal(task.status,'waiting');const suspended=Object.values(task.actionRuns)[0];assert.equal(suspended.status,'paused');
 await h.runtime.tick(id);assert.deepEqual(events,['one','two']);assert.equal(task.inbox.length,1);await flush();gate.resolve(plan());await flush();task=h.runtime.tasks.get(id);assert.equal(task.actionRuns[suspended.id].status,'waiting');await h.runtime.tick(id);assert.deepEqual(events,['one','two','one']);
});
test('fresh evidence requests re-evaluation without self-resuming a paused task, and owner pause keeps control',async t=>{
 const gate=deferred();const h=harness(async()=>({status:'paused',selfSuspension:suspension}),{reviewTask:()=>gate.promise});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.enqueue(id,{key:'one',scope:'a'});await h.runtime.tick(id);let task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0],first=run.recoveryState.mainReview.reviewId;
 await h.runtime.enqueue(id,{key:'fresh',scope:'a'},{recoveryEvidence:true});assert.equal(task.status,'paused');assert.equal(run.status,'paused');assert.notEqual(run.recoveryState.mainReview.reviewId,first);assert.equal(run.recoveryState.mainReview.reason,'new-evidence');
 await h.runtime.control('pause',id);task=h.runtime.tasks.get(id);await h.runtime.enqueue(id,{key:'other-fresh',scope:'a'},{recoveryEvidence:true});assert.equal(task.state.pauseSource,'owner');assert.equal(Object.values(task.actionRuns)[0].recoveryState.mainReview.status,'cancelled');
 gate.resolve(plan());
});
test('review timeout is bounded, late output ignored and disabled rollback keeps self-suspension',async t=>{
 const gate=deferred();let enabled=true;const h=harness(async()=>({status:'paused',selfSuspension:suspension}),{reviewTask:()=>gate.promise,mainReviewOptions:{timeoutMs:15,retryMs:500,enabled:()=>enabled}});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.tick(id);await h.runtime.tick();await new Promise(resolve=>setTimeout(resolve,30));let task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0];assert.equal(h.runtime.mainReviews.active,null);assert.equal(run.recoveryState.mainReview.status,'requested');assert.equal(run.recoveryState.mainReview.lastError,'E_MAIN_REVIEW_TIMEOUT');
 enabled=false;gate.resolve(plan());await flush();await h.runtime.tick(id);assert.equal(task.status,'paused');assert(run.recoveryState.selfSuspension);assert.equal(h.effects.length,0);
});
test('unavailable review retains its concrete failure code and reaches the existing safe diagnostic hook',async t=>{
 const diagnostics=[],h=harness(async()=>({status:'paused',selfSuspension:suspension}),{
  reviewTask:async()=>{throw Object.assign(Error('synthetic review context failure'),{code:'E_SELF_CONTEXT_BUDGET'});},
  onRecoveryDiagnostic:(stage,task,error)=>diagnostics.push({stage,id:task.id,code:error.code})
 });t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.tick(id);
 for(const at of [1000,21000,61000]){h.time(at);await h.runtime.tick();await flush();}
 const task=h.runtime.tasks.get(id),record=Object.values(task.actionRuns)[0].recoveryState.mainReview;
 assert.equal(record.unavailable,true);assert.equal(record.lastError,'E_SELF_CONTEXT_BUDGET');assert.equal(record.attempts,3);
 assert.deepEqual(diagnostics,Array.from({length:3},()=>({stage:'main-review',id,code:'E_SELF_CONTEXT_BUDGET'})));
 assert.equal(task.status,'paused');assert.equal(h.effects.length,0);
});
test('review decision cannot apply after authorization loss, a goal update, or an in-flight persistence stop',async t=>{
 const gate=deferred();const h=harness(async()=>({status:'paused',selfSuspension:suspension}),{reviewTask:()=>gate.promise});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.tick(id);await h.runtime.tick();await flush();h.revoke();gate.resolve(plan());await flush();assert.equal(h.runtime.tasks.get(id).status,'paused');assert.equal(h.effects.length,0);
});
test('proactive review retires an overdue worker and isolates its late mutations without clearing receipts',async t=>{
 const gate=deferred(),entered=deferred();let oldContext;const h=harness(async ctx=>{if(ctx.recovery?.guidanceId)return {status:'completed'};oldContext=ctx;entered.resolve();await gate.promise;ctx.task.state.late='must not win';return {status:'completed'};},{reviewTask:async()=>({...plan(),guidance:{...plan().guidance,restartFromCheckpoint:'retire the unresponsive original invocation, retaining all effects'}}),mainReviewOptions:{stageTimeoutMs:20}});t.after(()=>h.runtime.close());
 const {id}=await h.start(),running=h.runtime.tick(id);await entered.promise;h.time(2000);await h.runtime.tick();await flush();let task=h.runtime.tasks.get(id);assert.equal(oldContext.signal.aborted,true);assert.equal(task.status,'waiting');await running;await h.runtime.tick(id);assert.equal(task.status,'completed');gate.resolve();await flush();assert.equal(task.state.late,undefined);
});
test('automatic scheduling supervises a newly started action while its first call is still pending',async t=>{
 const gate=deferred(),entered=deferred(),reviewed=deferred();let context;
 const h=harness(async ctx=>{context=ctx;entered.resolve();await gate.promise;return {status:'waiting'};},{clock:Date.now,autoSchedule:true,
  reviewTask:async()=>{reviewed.resolve();return plan('continue');},mainReviewOptions:{stageTimeoutMs:20,monitorMs:5}});
 t.after(()=>{gate.resolve();h.runtime.close();});
 let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('active action was never supervised by the scheduler')),500);});
 try{await Promise.race([(async()=>{await h.start();await entered.promise;await reviewed.promise;})(),timeout]);}finally{clearTimeout(timer);}
 assert.equal(context.signal.aborted,false,'read-only supervision does not itself cancel a healthy caller');
});
test('continue waits for a safe boundary, tolerates repeated read receipts and never aborts a healthy worker',async t=>{
 const model=deferred(),worker=deferred(),entered=deferred();let context;
 const h=harness(async ctx=>{context=ctx;entered.resolve();await worker.promise;return {status:'waiting'};},{reviewTask:()=>model.promise,mainReviewOptions:{stageTimeoutMs:20}});t.after(()=>h.runtime.close());
 const {id}=await h.start(),running=h.runtime.tick(id);await entered.promise;h.time(2000);await h.runtime.tick();await flush();
 const task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0];
 for(let i=0;i<4;i++){task.operations['read-'+i]={id:'read-'+i,effect:'read',status:'confirmed',actionId:run.id,finishedAt:2000+i};context.progress.observe('fixture.read',{ok:true,status:'same'});}
 model.resolve(plan('continue'));await flush();assert.equal(context.signal.aborted,false);assert.equal(run.recoveryState.mainReview.status,'decided');assert.equal(run.recoveryState.mainReview.awaitingSafeBoundary,true);
 worker.resolve();await running;h.time(4000);await h.runtime.tick();await flush();assert.equal(task.status,'waiting');assert.equal(task.actionRuns[run.id].recoveryState.mainReview.status,'applied');assert.equal(task.actionRuns[run.id].recovery.source,'main-review');assert.equal(context.signal.aborted,false);
});
test('replanning one scope cannot retire another scope with an in-flight write',async t=>{
 const a=deferred(),b=deferred(),atA=deferred(),atB=deferred();let contextA,contextB;
 const h=harness(async ctx=>{if(ctx.event?.key==='a'){contextA=ctx;atA.resolve();await a.promise;return {status:'waiting'};}contextB=ctx;ctx.progress.state.expectedAt=100000;await ctx.call({tool:'fixture.write',key:'b-effect',args:{}});return {status:'waiting'};},{reviewTask:async()=>({...plan(),guidance:{...plan().guidance,restartFromCheckpoint:'replace the stalled invocation'}}),mainReviewOptions:{stageTimeoutMs:20}});t.after(()=>h.runtime.close());
 const tool=h.tools.get('fixture.write');h.tools.tools.set(tool.name,{...tool,execute:async(...args)=>{atB.resolve();await b.promise;return tool.execute(...args);}});
 const {id}=await h.start();await h.runtime.enqueue(id,{key:'a',scope:'one'});await h.runtime.enqueue(id,{key:'b',scope:'two'});const first=h.runtime.tick(id);await atA.promise;const second=h.runtime.tick(id);await atB.promise;
 h.time(2000);await h.runtime.tick();await flush();assert.equal(contextA.signal.aborted,false);assert.equal(contextB.signal.aborted,false);assert.equal(h.effects.length,0);
 b.resolve();await second;assert.equal(contextB.signal.aborted,false);assert.equal(h.effects.length,1);a.resolve();await first;h.time(4000);await h.runtime.tick();await flush();assert.equal(h.effects.length,1);assert.equal(Object.values(h.runtime.tasks.get(id).operations).find(op=>op.effect==='write').status,'confirmed');
});
test('an unresponsive initial review save releases the global review slot and owner stop remains immediate',async t=>{
 const saved=deferred();let blockedId,otherReviews=0;const h=harness(async()=>({status:'paused',selfSuspension:suspension}),{reviewTask:async args=>{if(args.task.id!==blockedId)otherReviews++;return plan();},mainReviewOptions:{timeoutMs:15,retryMs:1000},stopTimeoutMs:15,stopAckTimeoutMs:5});t.after(()=>h.runtime.close());
 const put=h.journal.put;h.journal.put=async task=>{if(task.id===blockedId&&Object.values(task.actionRuns).some(run=>run.recoveryState?.mainReview?.status==='running'))await saved.promise;return put(task);};
 const first=await h.start();blockedId=first.id;await h.runtime.tick(first.id);await h.runtime.tick();await new Promise(resolve=>setTimeout(resolve,25));assert.equal(h.runtime.mainReviews.active,null);
 const second=await h.start();await h.runtime.tick(second.id);await h.runtime.tick();await flush();assert.equal(otherReviews,1);
 const stopping=h.runtime.control('stop',first.id);assert.equal(h.runtime.tasks.get(first.id).status,'stopped');assert.equal((await stopping).localStopped,true);saved.resolve();await flush();assert.equal(h.runtime.tasks.get(first.id).status,'stopped');
});
test('a stalled guidance commit holds only its original save lane and cannot revive an owner-stopped task',async t=>{
 const commit=deferred(),entered=deferred();let blockedId,otherReviews=0;const h=harness(async()=>({status:'paused',selfSuspension:suspension}),{reviewTask:async args=>{if(args.task.id!==blockedId)otherReviews++;return plan();},mainReviewOptions:{timeoutMs:15},stopTimeoutMs:15,stopAckTimeoutMs:5});t.after(()=>h.runtime.close());
 const put=h.journal.put;h.journal.put=async task=>{if(task.id===blockedId&&Object.values(task.actionRuns).some(run=>run.recoveryState?.mainReview?.status==='applied')){entered.resolve();await commit.promise;}return put(task);};
 const first=await h.start();blockedId=first.id;await h.runtime.tick(first.id);await h.runtime.tick();await entered.promise;await flush();assert.equal(h.runtime.mainReviews.active,null);
 const second=await h.start();await h.runtime.tick(second.id);await h.runtime.tick();await flush();assert.equal(otherReviews,1);
 const stopping=h.runtime.control('stop',first.id);assert.equal(h.runtime.tasks.get(first.id).status,'stopped');await new Promise(resolve=>setTimeout(resolve,25));commit.resolve();await stopping;await flush();assert.equal(h.runtime.tasks.get(first.id).status,'stopped');assert.equal(h.records.get(first.id).status,'stopped');assert.equal(h.effects.length,0);
});
test('background saturation is ordinary waiting for task four and five, without recovery or failure learning',async t=>{
 const {ModelAdmission}=require('../src/main/model-admission'),admission=new ModelAdmission(),gate=deferred(),entered=[];let failures=0;
 const h=harness(async ctx=>{await admission.run(async()=>{entered.push(ctx.task.id);await gate.promise;return 'result';},{priority:'background'});return {status:'completed'};},{failed:async()=>failures++});t.after(()=>h.runtime.close());
 const starts=[];for(let i=0;i<5;i++)starts.push(await h.start());const first=starts.slice(0,3).map(({id})=>h.runtime.tick(id));await flush();
 for(const {id}of starts.slice(3))for(let i=0;i<5;i++)await h.runtime.tick(id);
 assert.equal(entered.length,3);assert.equal(failures,0);
 for(const {id}of starts.slice(3)){const task=h.runtime.tasks.get(id);assert.equal(task.status,'waiting');assert.equal(Object.values(task.actionRuns)[0].recoveryState,undefined);}
 gate.resolve();await Promise.all(first);for(const {id}of starts.slice(3))await h.runtime.tick(id);assert.equal(entered.length,5);assert(starts.every(({id})=>h.runtime.tasks.get(id).status==='completed'));
});
test('review model saturation defers without exhausting semantic review budgets',async t=>{
 let busy=true;const h=harness(async()=>({status:'paused',selfSuspension:suspension}),{reviewTask:async()=>{if(busy)throw Object.assign(Error('background capacity'),{code:'E_MODEL_BUSY',dispatched:false});return plan();}});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.tick(id);for(let i=0;i<5;i++){h.time(1000+i*20000);await h.runtime.tick();await flush();}let task=h.runtime.tasks.get(id),state=Object.values(task.actionRuns)[0].recoveryState;
 assert.equal(state.reviewCalls,0);assert.equal(state.mainReview.unavailable,undefined);assert.equal(state.selfSuspension.assessmentSummary,suspension.assessmentSummary);
 busy=false;h.time(200000);await h.runtime.tick();await flush();task=h.runtime.tasks.get(id);assert.equal(Object.values(task.actionRuns)[0].recoveryState.mainReview.status,'applied');
});
test('a new independent scope can enter after another scope self-suspends, without resuming the suspended action',async t=>{
 const gate=deferred(),events=[];const h=harness(async ctx=>{events.push(ctx.event?.key);return ctx.event?.key==='a'?{status:'paused',selfSuspension:suspension}:{status:'waiting'};},{reviewTask:()=>gate.promise});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.enqueue(id,{key:'a',scope:'one'});await h.runtime.tick(id);let task=h.runtime.tasks.get(id);assert.equal(task.status,'paused');
 await h.runtime.enqueue(id,{key:'b',scope:'two'});await h.runtime.tick();await flush();await h.runtime.tick(id);assert.deepEqual(events,['a','b']);task=h.runtime.tasks.get(id);assert.equal(Object.values(task.actionRuns).find(run=>run.eventKey==='a').status,'paused');assert.equal(task.status,'waiting');
});
test('explicit owner continuation opens a real new resource cycle after all internal allowances are spent',async t=>{
 let resumed=false;const h=harness(async ctx=>{if(!resumed)return {status:'paused',selfSuspension:suspension};await ctx.call({tool:'fixture.write',key:'original-effect',args:{}});return {status:'completed'};});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.tick(id);const task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0],episode=run.recoveryState.episodeId;
 Object.assign(run.recoveryState,{totalAttempts:12,reviewCalls:3,status:'exhausted',exhausted:true});run.recoveryState.mainReview.status='applied';run.recoveryState.mainReview.decision={type:'wait'};
 assert.equal((await h.runtime.control('resume',id)).ok,true);resumed=true;await h.runtime.tick(id);
 assert.equal(task.status,'completed');assert.equal(h.effects.length,1);assert.equal(run.recoveryState.episodeId,episode);assert.equal(run.recoveryState.lifetimeAttempts,12);assert.equal(run.recoveryState.lifetimeReviewCalls,3);assert.equal(run.recoveryState.resourceCycle,1);assert.equal(run.recoveryState.totalAttempts,0);assert.equal(run.recoveryState.reviewCalls,0);
});
test('concurrent guidance commits reserve the existing capacity without holding the global admission lane',async t=>{
 const commit=deferred(),entered=deferred();let blockedId;
 const h=harness(async ctx=>ctx.task.state.healthy?{status:'waiting',nextCheckAt:100000}:{status:'paused',selfSuspension:suspension});t.after(()=>h.runtime.close());const put=h.journal.put;
 h.journal.put=async task=>{if(task.id===blockedId&&Object.values(task.actionRuns).some(run=>run.recoveryState?.mainReview?.status==='applied')){entered.resolve();await commit.promise;}return put(task);};
 const first=await h.start();blockedId=first.id;await h.runtime.tick(first.id);const second=await h.start();await h.runtime.tick(second.id);const healthy=[];for(let i=0;i<4;i++){const item=await h.start();healthy.push(item);h.runtime.tasks.get(item.id).state.healthy=true;}
 await h.runtime.tick();await entered.promise;await flush();assert.equal(h.runtime.capacity().active,5);await h.runtime.tick();await flush();assert.equal(h.runtime.tasks.get(second.id).status,'paused');assert.equal(h.runtime.capacity().active,5);
 const queued=await h.start();assert.equal(h.runtime.tasks.get(queued.id).status,'queued','new owner admission remains responsive and respects the same capacity');
 commit.resolve();await flush();assert.equal(h.runtime.capacity().active,5);await h.runtime.control('stop',healthy[0].id);h.time(4000);await h.runtime.tick();await flush();assert.equal(h.runtime.tasks.get(second.id).status,'waiting');assert(h.runtime.capacity().active<=5);
});
