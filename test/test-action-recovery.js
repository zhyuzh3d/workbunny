'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime');
const {ToolRegistry}=require('../src/main/agent-tools');
const {SkillRegistry}=require('../src/main/agent-skills');
const {GUIDANCE}=require('../src/main/action-progress');
const owner={role:'owner',verified:true,sources:['fixture-owner'],scene:'life'};
const spec={skill:'fixture.resilience',goal:'finish the original goal',subjects:[{application:'system'}]};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(run,options={}){
 let now=1000;const records=new Map(),tools=new ToolRegistry(),effects=[],reports=[];
 tools.register({name:'fixture.read',description:'read actual evidence',effect:'read',capabilities:['fixture.read'],execute:async()=>({ok:true,status:'unchanged'})});
 tools.register({name:'fixture.write',description:'one authorized effect',effect:'write',capabilities:['fixture.write'],execute:async()=>{effects.push('effect');return {ok:true,verified:true,receipt:{written:true}};}});
 const skills=new SkillRegistry(tools).register({id:spec.skill,version:1,description:'offline resilience',tools:['fixture.read','fixture.write'],capabilities:['fixture.read','fixture.write'],run});
 const journal={put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[...records.values()].map(task=>structuredClone(task)),authorized:async()=>true};
 const runtime=new AgentRuntime({journal,tools,skills,clock:()=>now,autoSchedule:false,epoch:()=>1,report:async report=>reports.push(report),...options});
 return {runtime,records,tools,skills,journal,effects,reports,setTime:value=>now=value,start:()=>runtime.start(spec,owner)};
}
test('action and system prompts distinguish cross-checking the obstacle from reviewing and repairing earlier mistakes',()=>{
 for(const prompt of [GUIDANCE,require('../src/main/bunny-principles')]){
  assert.match(prompt,/不同.*角度|另一个.*角度/u);assert.match(prompt,/确认.*(?:障碍|卡点).*回(?:顾|想)|确认.*障碍后.*反思/u);
  assert.match(prompt,/副作用.*(?:禁止重放|不重放)|未知.*副作用.*重放/u);
 }
 assert.match(GUIDANCE,/history仅是先前恢复建议/u);
});
test('changing the error text, code and workflow key does not renew recovery; a single ask-owner opinion is not final evidence',async t=>{
 let executions=0;const seen=[];
 const h=harness(async({task,recovery})=>{seen.push(recovery);task.state.stepSequence=++executions;throw Object.assign(Error('different wording '+executions),{code:'E_FAILURE_'+executions,dispatched:false});},{diagnoseRepair:async()=>({action:'ask_owner',source:'llm',nextStep:'one unsupported opinion'})});t.after(()=>h.runtime.close());
 const {id}=await h.start();for(let i=0;i<3;i++){h.setTime(1000+i*1000);await h.runtime.tick(id);}
 let task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0];assert.equal(task.status,'waiting');assert.equal(run.recoveryState.attempts,3);assert.equal(run.recovery.action,'wait');assert.equal(h.runtime.controllers.size,0);assert.equal(h.runtime.actionGroups.size,0);
 assert.equal(seen[1].action,'reobserve');assert.equal(seen[2].action,'change_method');assert.equal(run.recovery.history.length,2);
 await h.runtime.tick(id);assert.equal(executions,3,'an explicit tick cannot bypass the delayed recovery');h.setTime(run.recoveryState.nextAt);await h.runtime.tick(id);
 task=h.runtime.tasks.get(id);assert.equal(executions,4);assert.equal(task.status,'needs_attention');assert.match(task.note,/未取得足够的多角度验证/u);assert.match(task.note,/不能认定真实障碍或永久阻塞/u);assert.equal(run.recovery.obstacleConfirmed,false);assert.equal(run.recovery.exhaustionReason,'recovery-budget');assert.equal(h.reports.length,1);
});
test('a delayed action resumes after restart while a new event in another scope runs immediately',async t=>{
 const events=[];const h=harness(async({event})=>{events.push(event?.key);if(event?.key==='old')throw Object.assign(Error('still unavailable'),{code:'E_VISUAL_TARGET',dispatched:false});return {status:'waiting'};},{diagnoseRepair:async()=>({action:'wait',waitFor:'external condition changes',waitMs:9000})});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.enqueue(id,{key:'old',scope:'first'});await h.runtime.tick(id);const before=h.runtime.tasks.get(id),due=Object.values(before.actionRuns)[0].recoveryState.nextAt;
 await h.runtime.restore();assert.equal(h.runtime.tasks.get(id).nextCheckAt,due);await h.runtime.tick(id);assert.deepEqual(events,['old']);
 await h.runtime.enqueue(id,{key:'new',scope:'second'});await h.runtime.tick(id);assert.deepEqual(events,['old','new']);assert.equal(h.runtime.tasks.get(id).inbox[0].key,'old');
 h.setTime(due);await h.runtime.tick();assert.deepEqual(events,['old','new','old'],'the ordinary scheduler honors the action deadline after another event changes the task cadence');
});
test('new external evidence permits a fresh recovery decision, while failed operation variants do not',async t=>{
 let phase=0;const h=harness(async({task,progress,call})=>{if(phase)await call({tool:'fixture.read',key:'actual-evidence',args:{}});progress.observe('failed variant',{error:'E_BAD_'+task.counters.wakes});throw Error('same unresolved obstacle');},{diagnoseRepair:async()=>({action:'retry'})});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.tick(id);await h.runtime.tick(id);let run=Object.values(h.runtime.tasks.get(id).actionRuns)[0];assert.equal(run.recoveryState.attempts,2);
 phase=1;await h.runtime.tick(id);run=Object.values(h.runtime.tasks.get(id).actionRuns)[0];assert.equal(run.recoveryState.attempts,1);assert.equal(run.recovery.observations[0].tool,'fixture.read');
});
test('a hung invocation is retired and its late mutations, calls, reports and events cannot affect the replacement',async t=>{
 let release,entered;const at=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let oldCall,late;
 const h=harness(async context=>{if(context.task.state.ready)return {status:'completed'};oldCall=context;entered();await gate;context.task.state.late='old';context.task.status='completed';await context.report('late result','late');late=await context.enqueue({key:'late'});await assert.rejects(context.call({tool:'fixture.write',key:'late',args:{}}));return {status:'completed'};},{stepTimeoutMs:20});t.after(()=>h.runtime.close());
 const {id}=await h.start(),running=h.runtime.tick(id);await at;const old=h.runtime.tasks.get(id);await running;const current=h.runtime.tasks.get(id);assert.notEqual(current,old);assert.equal(h.runtime.controllers.size,0);assert.equal(h.runtime.actionGroups.size,0);assert.equal(oldCall.signal.aborted,true);
 current.state.ready=true;await h.runtime.tick(id);assert.equal(current.status,'completed');release();await flush();assert.equal(current.state.late,undefined);assert.equal(current.inbox.length,0);assert.equal(late.ok,false);assert.equal(h.effects.length,0);assert.equal(h.reports.length,0);
});
test('timeout keeps unknown writes blocked, and a late verified receipt merges only evidence without replay or revival',async t=>{
 let release,entered;const at=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let calls=0;
 const h=harness(async({task,call})=>{await call({tool:'fixture.write',key:'stable-effect',args:{}});task.state.late='old';return {status:'completed'};},{stepTimeoutMs:20});t.after(()=>h.runtime.close());
 const tool=h.tools.get('fixture.write');h.tools.tools.set(tool.name,{...tool,execute:async()=>{calls++;entered();await gate;return {ok:true,verified:true,receipt:{written:true}};}});
 const {id}=await h.start(),running=h.runtime.tick(id);await at;await running;const current=h.runtime.tasks.get(id);assert.equal(current.status,'needs_attention');assert.equal(Object.values(current.operations)[0].status,'intent');assert.equal((await h.runtime.control('resume',id)).ok,false);await h.runtime.tick(id);assert.equal(calls,1);
 release();await flush();await flush();assert.equal(current.status,'needs_attention');assert.equal(current.state.late,undefined);assert.equal(Object.values(current.operations)[0].status,'confirmed');assert.equal(current.counters.writes,1);
 assert((await h.runtime.control('resume',id)).ok);await h.runtime.tick(id);assert.equal(calls,1);assert.equal(current.status,'completed');
});
test('pause isolates old state immediately and does not wait for a hung skill before a safe resume',async t=>{
 let release,entered,calls=0;const gate=new Promise(resolve=>release=resolve),at=new Promise(resolve=>entered=resolve);
 const h=harness(async({task})=>{if(++calls===1){entered();await gate;task.state.old='late';}return {status:'waiting'};});t.after(()=>h.runtime.close());
 const {id}=await h.start(),running=h.runtime.tick(id);await at;const old=h.runtime.tasks.get(id);await h.runtime.control('pause',id);await running;const current=h.runtime.tasks.get(id);assert.notEqual(current,old);assert((await h.runtime.control('resume',id)).ok);await h.runtime.tick(id);assert.equal(calls,2);release();await flush();assert.equal(current.state.old,undefined);
});
test('a diagnostic ignoring cancellation is bounded, its late opinion is ignored and stop survives restart',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve);const h=harness(async()=>{throw Error('temporary failure');},{recoveryTimeoutMs:15,diagnoseRepair:async()=>gate});t.after(()=>h.runtime.close());
 const {id}=await h.start(),started=Date.now();await h.runtime.tick(id);assert(Date.now()-started<1000);assert.equal(h.runtime.controllers.size,0);const guidance=h.runtime.tasks.get(id).state.recoveryGuidance;
 await h.runtime.control('stop',id);release({action:'retry',source:'llm'});await flush();await h.runtime.restore();await h.runtime.tick(id);const current=h.runtime.tasks.get(id);assert.equal(current.status,'stopped');assert.deepEqual(current.state.recoveryGuidance,guidance);assert.equal(current.counters.wakes,1);
});
test('a late old read cannot release the replacement operation reservation or publish its old evidence',async t=>{
 const gates=[],entered=[];let calls=0;
 const h=harness(async({task,call})=>{const result=await call({tool:'fixture.read',key:'stable-read',args:{}});task.state.observed=result.version;return {status:'waiting'};},{stepTimeoutMs:30});t.after(()=>h.runtime.close());
 const tool=h.tools.get('fixture.read');h.tools.tools.set(tool.name,{...tool,execute:async()=>{const version=++calls;entered[version]?.();await new Promise(resolve=>gates[version]=resolve);return {ok:true,version};}});
 const {id}=await h.start();await h.runtime.tick(id);const current=h.runtime.tasks.get(id);const second=h.runtime.tick(id);while(!gates[2])await flush();gates[1]();await flush();
 assert.equal(h.runtime.operations.inFlight.size,1);assert.equal(current.state.observed,undefined);assert.equal(h.runtime.operations.lifecycle.active.size,1);
 gates[2]();await second;assert.equal(current.state.observed,2);assert.equal(h.runtime.operations.inFlight.size,0);assert.equal(h.runtime.operations.lifecycle.active.size,0);
});
test('another event cannot complete a task while an earlier action has an unknown effect',async t=>{
 let completions=0;const h=harness(async({event,call})=>{if(event.key==='uncertain')await call({tool:'fixture.write',key:'once',args:{}});return {status:'completed'};},{completed:async()=>{completions++;}});t.after(()=>h.runtime.close());
 const tool=h.tools.get('fixture.write');h.tools.tools.set(tool.name,{...tool,execute:async()=>{throw Error('lost receipt');}});
 const {id}=await h.start();await h.runtime.enqueue(id,{key:'uncertain',scope:'first'});await h.runtime.tick(id);await h.runtime.enqueue(id,{key:'independent',scope:'second'});await h.runtime.tick(id);
 const task=h.runtime.tasks.get(id);assert.equal(task.status,'needs_attention');assert.equal(Object.values(task.operations)[0].status,'intent');assert.equal(completions,0);assert.equal(task.inbox.length,1);
});
test('a goal amendment fences an unfinished old skill without losing the revised goal or its next execution',async t=>{
 let release,entered,calls=0;const gate=new Promise(resolve=>release=resolve),at=new Promise(resolve=>entered=resolve);
 const h=harness(async({task})=>{if(++calls===1){entered();await gate;task.goal='old rewritten goal';task.state.oldPlan=true;}return {status:'waiting'};});t.after(()=>h.runtime.close());
 const {id}=await h.start(),running=h.runtime.tick(id);await at;const old=h.runtime.tasks.get(id);assert((await h.runtime.update(id,{goal:'revised authorized goal'},owner)).ok);await running;const current=h.runtime.tasks.get(id);assert.notEqual(current,old);await h.runtime.tick(id);release();await flush();
 assert.equal(calls,2);assert.equal(current.goal,'revised authorized goal');assert.equal(current.state.oldPlan,undefined);assert.equal(h.records.get(id).goal,'revised authorized goal');
});
test('unexecuted recovery advice does not prove an obstacle; new trusted observation evidence can autonomously reopen assessment',async t=>{
 let attempts=0,recovered=false;const h=harness(async({event,recovery})=>{attempts++;if(!recovered)throw Error('unverified obstacle');assert.equal(recovery.action,'reobserve');return {status:'waiting'};},{diagnoseRepair:async()=>({action:'ask_owner',source:'llm',nextStep:'this advice has never executed'})});t.after(()=>h.runtime.close());
 const {id}=await h.start();await h.runtime.enqueue(id,{key:'original',scope:'one'});for(const now of [1000,2000,3000,6000]){h.setTime(now);await h.runtime.tick(id);}
 const task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0];assert.equal(task.status,'needs_attention');assert.equal(run.recovery.obstacleConfirmed,false);assert.equal(run.recoveryState.observations.length,0,'three advice records are not three actual observations');
 await h.runtime.enqueue(id,{key:'unproven-new-key',scope:'one'});await h.runtime.tick(id);assert.equal(attempts,4,'an arbitrary new event key is not new evidence');
 recovered=true;await h.runtime.enqueue(id,{key:'actual-observation',scope:'one',type:'fixture.actual-observation'},{recoveryEvidence:true});assert.equal(task.status,'waiting');assert.equal(run.recoveryState.status,'rearmed');assert.equal(run.recovery.source,'new-evidence');assert.equal(run.recovery.obstacleConfirmed,false);
 await h.runtime.tick(id);assert.equal(attempts,5);assert.equal(run.status,'completed');assert.equal(task.inbox.some(event=>event.key==='original'),false);assert.equal(h.effects.length,0);
});
