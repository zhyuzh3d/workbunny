'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TaskKeepalive}=require('../src/main/task-keepalive');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(remind){let now=0,calls=0;const task={id:'task-one',skill:'software.execute',status:'waiting',createdAt:0,state:{goalRevision:2},operations:{},actionRuns:{},inbox:[],goal:'Keep this goal',nextCheckAt:999999,authority:{channel:'dialogue'},scene:'life',domain:'life',privacyEpoch:1};
 const runtime={tasks:new Map([[task.id,task]]),tokens:new Map([[task.id,0]]),actionGroups:new Map(),closed:false,ready:()=>true,current:()=>true,save:async()=>{},schedule:()=>{},report:async()=>{}};
 const keepalive=new TaskKeepalive({clock:()=>now,remind:async args=>{calls++;return remind?remind(args):{action:'continue',nextStep:'Try a useful next step'};}});
 return {task,runtime,keepalive,setTime:t=>now=t,get calls(){return calls;}};
}
test('one minute of real idle triggers one internal continuation without changing goal or operation history',async()=>{
 let release;const f=fixture(()=>new Promise(r=>release=r));f.keepalive.inspect(f.runtime);f.setTime(59999);f.keepalive.inspect(f.runtime);assert.equal(f.calls,0);f.setTime(60000);f.keepalive.inspect(f.runtime);for(let i=0;i<5;i++)f.keepalive.inspect(f.runtime);assert.equal(f.calls,1);release({action:'change_method',nextStep:'Inspect another relevant source'});await flush();assert.equal(f.task.nextCheckAt,60000);assert.equal(f.task.goal,'Keep this goal');assert.equal(f.task.state.goalRevision,2);assert.deepEqual(f.task.operations,{});assert.equal(f.task.state.recoveryGuidance.source,'keepalive');assert.equal(f.keepalive.pending.size,0);
});
test('actual workers, passive listeners, explicit future waits and unknown writes are not idle work to replay',async()=>{
 const f=fixture();f.keepalive.inspect(f.runtime);f.setTime(60000);f.runtime.actionGroups.set(f.task.id,{workers:new Map([['one',{eventKey:undefined}]])});f.keepalive.inspect(f.runtime);assert.equal(f.calls,0);f.runtime.actionGroups.clear();
 f.task.skill='conversation.manage';f.keepalive.inspect(f.runtime);assert.equal(f.calls,0);f.task.skill='software.execute';f.keepalive.state(f.task).wait={reason:'actual external result',until:120000};f.keepalive.inspect(f.runtime);assert.equal(f.calls,0);
 f.setTime(120000);f.task.operations.one={effect:'write',status:'intent'};f.keepalive.inspect(f.runtime);assert.equal(f.calls,0);delete f.task.operations.one;f.keepalive.inspect(f.runtime);await flush();assert.equal(f.calls,1);
});
test('each action retains independent liveness and business progress while unrelated workers run',async()=>{
 const f=fixture();f.task.skill='conversation.manage';f.task.inbox=[{key:'event-a',type:'conversation.messages'}];const run=f.task.actionRuns.a={id:'a',eventKey:'event-a',status:'waiting',keepalive:{lastActivityAt:0},progress:{lastProgressAt:12}};
 f.runtime.actionGroups.set(f.task.id,{workers:new Map([['b',{eventKey:'event-b'}]])});f.setTime(60000);f.keepalive.inspect(f.runtime);await flush();assert.equal(f.calls,1);assert.equal(run.recovery.source,'keepalive');assert.equal(run.progress.lastProgressAt,12);
});
test('pause, cancel and completion prevent late continuation from affecting the old lifecycle',async()=>{
 for(const state of ['paused','stopped','completed','expired','waiting_permission','needs_attention']){const f=fixture();f.keepalive.inspect(f.runtime);f.task.status=state;f.setTime(100000);f.keepalive.inspect(f.runtime);assert.equal(f.calls,0);}
 let release;const f=fixture(()=>new Promise(r=>release=r));f.keepalive.inspect(f.runtime);f.setTime(60000);f.keepalive.inspect(f.runtime);f.keepalive.cancel(f.task.id);release({action:'continue',nextStep:'late result'});await flush();assert.equal(f.task.state.recoveryGuidance,undefined);
});
test('Bunny can choose a named wait and its next check instead of blind periodic re-prompting',async()=>{
 const f=fixture(()=>({action:'wait',nextStep:'Wait for the actual result',waitFor:'report file appears',waitMs:120000}));f.keepalive.inspect(f.runtime);f.setTime(60000);f.keepalive.inspect(f.runtime);await flush();assert.equal(f.task.nextCheckAt,180000);f.setTime(120000);f.keepalive.inspect(f.runtime);assert.equal(f.calls,1);f.setTime(180000);f.keepalive.inspect(f.runtime);await flush();assert.equal(f.calls,2);
});
test('the existing runtime tick dispatches continuation and resumes the original action without another timer',async()=>{
 const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');let now=0,steps=0,nudges=0;
 const tools=new ToolRegistry(),skills=new SkillRegistry(tools).register({id:'fixture.task',version:1,description:'test',tools:[],capabilities:[],run:async({task})=>{steps++;return {status:steps>1?'completed':'waiting',state:task.state,nextCheckAt:1000000};}}),saved=new Map();
 const runtime=new AgentRuntime({tools,skills,clock:()=>now,epoch:()=>1,autoSchedule:false,journal:{put:async t=>saved.set(t.id,structuredClone(t)),list:async()=>[],authorized:async()=>true},remindIdle:async()=>{nudges++;return {action:'continue',nextStep:'Continue the original action'};}});
 const created=await runtime.start({skill:'fixture.task',goal:'finish original work',subjects:[{application:'bunny'}]},{role:'owner',verified:true,channel:'dialogue',scene:'life',sources:['owner-message']});assert(created.ok,created.error);await runtime.tick();now=60000;await runtime.tick();await flush();assert.equal(nudges,1);assert.equal(runtime.tasks.size,1);await runtime.tick();assert.equal(runtime.tasks.get(created.id).status,'completed');assert.equal(steps,2);await runtime.close();
});
test('one unsupported ask-owner decision keeps thinking, while unchanged repeated idle recovery remains bounded',async()=>{
 const f=fixture(()=>({action:'ask_owner',nextStep:'unsupported permanent obstacle'}));f.keepalive.inspect(f.runtime);
 for(let i=1;i<=4;i++){f.setTime(i*60000);f.keepalive.inspect(f.runtime);await flush();if(i===1){assert.equal(f.task.status,'waiting');assert.equal(f.task.state.recoveryGuidance.action,'reobserve');assert(!f.task.state.recoveryGuidance.nextStep.includes('unsupported'));}}
 assert.equal(f.task.status,'needs_attention');assert.equal(f.task.state.recoveryState.status,'exhausted');assert.match(f.task.note,/未取得足够的多角度验证/u);assert.equal(f.task.state.recoveryGuidance.obstacleConfirmed,false);
});
test('a continuation service ignoring its signal cannot hold the worker lane or force an endless waiting entry',async()=>{
 let release;const f=fixture(()=>new Promise(resolve=>release=resolve));f.keepalive.timeoutMs=15;f.keepalive.inspect(f.runtime);f.setTime(60000);f.keepalive.inspect(f.runtime);const entry=[...f.keepalive.pending.values()][0];await entry.work;
 assert.equal(f.keepalive.pending.size,0);assert.equal(f.task.nextCheckAt,60000);assert.equal(f.task.state.recoveryGuidance.source,'keepalive');const guidance=structuredClone(f.task.state.recoveryGuidance);release({action:'ask_owner',nextStep:'late'});await flush();assert.deepEqual(f.task.state.recoveryGuidance,guidance);
});
test('quiet subscriptions, timers and unmet condition routes stay passive while real idle actions still receive attention',async()=>{
 const f=fixture();f.task.state.goalPlan={schema:require('../src/main/goal-actions').SCHEMA,goalRevision:2};
 f.task.actionRuns.watch={id:'watch',subscription:true,status:'waiting',keepalive:{lastActivityAt:0},progress:{lastProgressAt:0,repeats:9}};
 f.task.actionRuns.timer={id:'timer',status:'waiting',keepalive:{lastActivityAt:0,wait:{reason:'timer',until:5000}},progress:{waitReason:'timer'}};
 f.task.actionRuns.condition={id:'condition',goalAction:true,goalRevision:2,key:'condition',status:'waiting',after:{actionKey:'source',path:'changed',equals:true},keepalive:{lastActivityAt:0}};
 for(const at of [0,60000,120000]){f.setTime(at);f.keepalive.inspect(f.runtime);await flush();}
 assert.equal(f.calls,0);assert.equal(f.keepalive.nextWake(f.runtime,f.task,120000),Infinity);assert.equal(f.task.state.recoveryGuidance,undefined);
 const active=f.task.actionRuns.active={id:'active',status:'waiting',keepalive:{lastActivityAt:0},progress:{lastProgressAt:0}};
 f.keepalive.inspect(f.runtime);await flush();assert.equal(f.calls,1);assert.equal(active.recovery.source,'keepalive');assert.equal(f.task.actionRuns.watch.recovery,undefined);
});
