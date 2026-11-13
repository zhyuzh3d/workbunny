'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
async function until(check){const deadline=Date.now()+1000;while(!check()){if(Date.now()>=deadline)throw Error('Expected completion lifecycle did not settle');await new Promise(resolve=>setImmediate(resolve));}}
const accept=()=>({type:'accept',rationaleSummary:'The actual result satisfies the original goal',sourceRefs:[],guidance:{}});
function fixture({run,review=async()=>accept(),internal=false,...options}={}){
 let now=1000,runs=0,writes=0,callbacks=0;const records=new Map(),reviews=[],reports=[],tools=new ToolRegistry();
 tools.register({name:'fixture.write',description:'synthetic effect',effect:'write',capabilities:['fixture.write'],execute:async()=>{writes++;return {ok:true,verified:true,receipt:{effectId:'retained-effect'}};}});
 const skills=new SkillRegistry(tools).register({id:'fixture.finish',description:'synthetic task completion',version:1,internal,tools:['fixture.write'],capabilities:['fixture.write'],run:async ctx=>{runs++;if(run)return run(ctx,runs);await ctx.call({tool:'fixture.write',key:'one-effect',args:{}});ctx.task.state.result={revision:1,summary:'Actual synthetic result',collectedAt:1000};return {status:'completed',note:'Actual synthetic result'};}});
 const journal={put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()].map(t=>structuredClone(t)),authorized:async()=>true};
 const runtime=new AgentRuntime({journal,tools,skills,clock:()=>now,epoch:()=>1,autoSchedule:false,reviewTask:async args=>{reviews.push(args);return review(args);},completed:async()=>{callbacks++;},report:async r=>reports.push(r),...options});
 const start=goal=>runtime.start({skill:'fixture.finish',goal:goal||'Complete the synthetic goal',subjects:[{application:'system'}]},{role:'owner',verified:true,channel:'dialogue',scene:'life',sources:['synthetic-owner']});
 return {runtime,records,journal,tools,skills,reviews,reports,start,time:t=>{now=t;},get runs(){return runs;},get writes(){return writes;},get callbacks(){return callbacks;}};
}
test('a fresh success proposal is reviewed once before completion state and callback, without intervening in running work',async t=>{
 const f=fixture({run:async(ctx,n)=>{if(n===1)return {status:'waiting',nextCheckAt:1000};await ctx.call({tool:'fixture.write',key:'one-effect',args:{}});ctx.task.state.result={revision:1,summary:'Actual result'};return {status:'completed',note:'Actual result'};}});t.after(()=>f.runtime.close());
 const {id}=await f.start();await f.runtime.tick(id);assert.equal(f.reviews.length,0);await f.runtime.tick(id);let task=f.runtime.tasks.get(id);assert.equal(task.status,'paused');assert.equal(task.state.completionProposal.status,'pending');assert.equal(f.callbacks,0);const proposalId=task.state.completionProposal.id;
 await f.runtime.tick();await flush();task=f.runtime.tasks.get(id);assert.equal(task.status,'completed');assert.equal(task.state.completionProposal.id,proposalId);assert.equal(task.state.completionProposal.status,'accepted');assert.equal(f.callbacks,1);assert.equal(f.reviews.length,1);assert.equal(f.writes,1);
 await f.runtime.tick();await f.runtime.notifyCompleted(task);await f.runtime.mainReviews.apply(id,null,task.state.recoveryState.mainReview.reviewId);assert.equal(f.callbacks,1);assert.equal(f.reviews.length,1);
});
test('disabled supervision keeps the existing direct completion path',async t=>{
 const f=fixture({mainReviewOptions:{enabled:false}});t.after(()=>f.runtime.close());const {id}=await f.start();await f.runtime.tick(id);assert.equal(f.runtime.tasks.get(id).status,'completed');assert.equal(f.runtime.tasks.get(id).state.completionProposal,undefined);assert.equal(f.callbacks,1);assert.equal(f.reviews.length,0);
});
test('an internal routing or owner-control skill finishes directly without an additional task-result approval',async t=>{
 const f=fixture({internal:true,run:async()=>({status:'completed',note:'Owner control already applied'})});t.after(()=>f.runtime.close());
 const {id}=await f.start();await f.runtime.tick(id);await f.runtime.tick();await flush();assert.equal(f.runtime.tasks.get(id).status,'completed');assert.equal(f.runtime.tasks.get(id).state.completionProposal,undefined);assert.equal(f.reviews.length,0);assert.equal(f.writes,0);
});
test('turning review off releases only the current pending completion and ignores its late model answer',async t=>{
 let enabled=true;const entered=Promise.withResolvers(),answer=Promise.withResolvers();
 const f=fixture({mainReviewOptions:{enabled:()=>enabled},review:async()=>{entered.resolve();return answer.promise;}});t.after(()=>f.runtime.close());
 const {id}=await f.start();await f.runtime.tick(id);await f.runtime.tick();await entered.promise;enabled=false;f.runtime.mainReviews.inspect();
 await until(()=>f.callbacks===1);const task=f.runtime.tasks.get(id);assert.equal(task.status,'completed');assert.equal(task.state.completionProposal.status,'bypassed');assert.equal(f.writes,1);
 answer.resolve({type:'replan',rationaleSummary:'Late obsolete advice',guidance:{}});await flush();await f.runtime.notifyCompleted(task);assert.equal(f.callbacks,1);assert.equal(task.status,'completed');
});
test('returned success results are revised by the same task brain and each new proposal gets one review without replaying effects',async t=>{
 let decisions=0,plans=0;const f=fixture({review:async()=>++decisions<3?{type:decisions===1?'continue':'replan',rationaleSummary:'Add the missing actual result evidence',sourceRefs:[],guidance:{verificationIdeas:['Check the retained effect and improve the result']}}:accept(),request:async options=>{const input=JSON.parse(options.messages[1].content[0].text);assert(input.recoveryGuidance.reviewedResult);assert(input.effectFacts.some(op=>op.status==='confirmed'));return {response:{text:JSON.stringify({done:true,summary:'Result version '+(++plans+1)})}};},run:async(ctx,n)=>{await ctx.call({tool:'fixture.write',key:'one-effect',args:{}});ctx.task.state.result={revision:n,summary:'Result version '+n,collectedAt:n};return {status:'completed',note:'Result version '+n};}});t.after(()=>f.runtime.close());
 const {id}=await f.start(),proposalIds=[];
 for(let n=1;n<=3;n++){await f.runtime.tick(id);const task=f.runtime.tasks.get(id);assert.equal(task.status,'paused');proposalIds.push(task.state.completionProposal.id);await f.runtime.tick();await flush();}
 const task=f.runtime.tasks.get(id);assert.equal(task.status,'completed');assert.equal(task.goal,'Complete the synthetic goal');assert.equal(new Set(proposalIds).size,3);assert.equal(f.reviews.length,3);assert.equal(f.runs,1);assert.equal(plans,2);assert.equal(f.writes,1);assert.equal(f.callbacks,1);assert.equal(task.state.previousCompletionResults.length,2);assert(Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='confirmed'));
});
test('pending completion survives restart without rerunning business operations or reviewing historical terminal tasks',async t=>{
 const f=fixture();const {id}=await f.start();await f.runtime.tick(id);const original=f.runtime.tasks.get(id),proposalId=original.state.completionProposal.id;
 for(const status of ['completed','stopped']){const past=structuredClone(original);past.id='historic-'+status;past.status=status;delete past.state.completionProposal;delete past.state.recoveryState;f.records.set(past.id,past);}
 await f.runtime.close();let callbacks=0,reviewed=0;const restored=new AgentRuntime({journal:f.journal,tools:f.tools,skills:f.skills,epoch:()=>1,autoSchedule:false,reviewTask:async args=>{reviewed++;assert.equal(args.completionProposal.id,proposalId);return accept();},completed:async()=>{callbacks++;}});t.after(()=>restored.close());
 await restored.restore();await restored.tick();await flush();assert.equal(restored.tasks.get(id).status,'completed');assert.equal(callbacks,1);assert.equal(reviewed,1);assert.equal(f.runs,1);assert.equal(f.writes,1);
});
test('owner stop, pause or goal change invalidates an in-flight success review',async t=>{
 for(const action of ['stop','pause','update']){
  const gate=Promise.withResolvers(),entered=Promise.withResolvers();const f=fixture({review:async()=>{entered.resolve();return gate.promise;}});t.after(()=>f.runtime.close());const {id}=await f.start();await f.runtime.tick(id);await f.runtime.tick();await entered.promise;
  if(action==='update')await f.runtime.update(id,{goal:'New owner goal'},{role:'owner',verified:true,channel:'dialogue',scene:'life',sources:['new-owner']});else await f.runtime.control(action,id);
  gate.resolve(accept());await flush();assert.notEqual(f.runtime.tasks.get(id).status,'completed');assert.equal(f.callbacks,0);assert.equal(f.writes,1);
  if(action==='update'){assert.equal(f.runtime.tasks.get(id).state.result,undefined);assert.equal(f.runtime.tasks.get(id).state.previousCompletionResults.length,1);}
 }
});
test('a reasonable failure suspension gets a final failure judgment without a success proposal or completion callback',async t=>{
 const f=fixture({run:async()=>({status:'paused',selfSuspension:{assessmentSummary:'The existing authorized alternatives cannot advance',attemptedPaths:['independent synthetic paths'],requestedHelp:'Check whether another overall strategy remains'}}),review:async()=>({type:'fail',rationaleSummary:'The actual required condition is unavailable after considering the alternatives',sourceRefs:[],guidance:{},obstacleConfirmed:true})});t.after(()=>f.runtime.close());
 const {id}=await f.start();await f.runtime.tick(id);await f.runtime.tick();await until(()=>f.runtime.tasks.get(id).status==='stopped');const task=f.runtime.tasks.get(id);
 assert.equal(task.state.completionProposal,undefined);assert.equal(f.reviews.length,1);assert.equal(f.callbacks,0);assert.equal(task.state.disposition.type,'fail');assert.equal(f.writes,0);
});
test('restart resumes an accepted but unclaimed callback once and never repeats a claimed callback',async t=>{
 const f=fixture();const {id}=await f.start();await f.runtime.tick(id);await f.runtime.close();
 const record=f.records.get(id);record.status='completed';record.state.completionProposal.status='accepted';record.state.recoveryState.mainReview.status='applied';
 let callbacks=0;const make=()=>new AgentRuntime({journal:f.journal,tools:f.tools,skills:f.skills,epoch:()=>1,autoSchedule:false,completed:async()=>{callbacks++;}});
 const first=make();await first.restore();await until(()=>callbacks===1&&f.records.get(id).state.completionProposal.callbackState==='completed');await first.close();
 const second=make();t.after(()=>second.close());await second.restore();await flush();assert.equal(callbacks,1);assert.equal(f.runs,1);assert.equal(f.writes,1);
});
test('unavailable completion review is bounded and leaves a durable proposal while other task work remains responsive',async t=>{
 const gate=Promise.withResolvers(),f=fixture({review:()=>gate.promise,mainReviewOptions:{timeoutMs:15,maxReviews:1},run:async ctx=>ctx.task.goal==='Other work'?{status:'waiting',nextCheckAt:100000}:{status:'completed',note:'Actual result'}});t.after(()=>f.runtime.close());
 const {id}=await f.start();await f.runtime.tick(id);await f.runtime.tick();const active=f.runtime.mainReviews.active;await active.work;const task=f.runtime.tasks.get(id);assert.equal(task.status,'paused');assert.equal(task.state.completionProposal.status,'pending');assert.equal(task.state.recoveryState.mainReview.unavailable,true);assert.equal(f.callbacks,0);
 const other=await f.start('Other work');await f.runtime.tick(other.id);assert.equal(f.runtime.tasks.get(other.id).status,'waiting');assert.equal(f.reviews.length,1);await f.runtime.control('stop',id);gate.resolve(accept());await flush();assert.equal(f.runtime.tasks.get(id).status,'stopped');assert.equal(f.callbacks,0);
});
