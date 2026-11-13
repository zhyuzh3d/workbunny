'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills'),{createSendOnceSkill}=require('../src/main/conversation-once-skills');
const owner={role:'owner',verified:true,scene:'life',sources:['synthetic-owner']},subject={application:'wechat',recipient:'Synthetic Contact'};
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture({request}={}){
 const tools=new ToolRegistry(),records=new Map(),calls=[],requests=[];let reviews=0;
 tools.register({name:'conversation.send',description:'Authorized one-time effect',resultContract:{body:'Payload and host envelope have separate meanings'},effect:'write',capabilities:['conversation.send'],scope:a=>a,execute:async args=>{calls.push('send');return {ok:true,verified:true,receipt:{operationId:'confirmed-effect',recipient:args.recipient,sentText:args.message,verifiedAt:1000}};}});
 tools.register({name:'conversation.observe',description:'Read the current target and latest result',effect:'read',capabilities:['conversation.read'],scope:a=>a,execute:async()=>{calls.push('observe');return {headerMatched:true,messages:[{direction:'outgoing',text:'synthetic body'}],observationId:'fresh-result',at:2000};}});
 const model=async options=>{const input=JSON.parse(options.messages[1].content[0].text);requests.push(input);if(request)return request(input,options);assert(!input.tools.some(tool=>tool.effect==='write'));return {response:{text:JSON.stringify(input.action?{done:true,taskDone:true,summary:'Fresh read confirms the original effect satisfies the goal'}:{done:false,actions:[{key:'inspect-result',goal:'Resolve the reviewer uncertainty using existing effects',criteria:'Actual result is checked',operations:[{key:'read',tool:'conversation.observe',args:subject}]}]})}};};
 const skills=new SkillRegistry(tools).register(createSendOnceSkill());
 const journal={put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[],authorized:async()=>true};
 const runtime=new AgentRuntime({tools,skills,journal,request:model,autoSchedule:false,epoch:()=>1,reviewTask:async()=>++reviews===1?{type:'replan',rationaleSummary:'Check the already completed effect from new read-only evidence',sourceRefs:[],guidance:{verificationIdeas:['Read the current target and recent result'],restartFromCheckpoint:'Retain the confirmed effect; do not send it again'}}:{type:'accept',rationaleSummary:'The actual checked result meets the original goal',sourceRefs:[],guidance:{}}});
 return {runtime,calls,requests,start:(actor=owner)=>runtime.start({skill:'conversation.send',goal:'Send one synthetic body, then report',criteria:'One authorized effect verified',subjects:[subject],parameters:{message:'synthetic body'},completion:'first_match'},actor),reviews:()=>reviews};
}
test('a returned fixed one-shot result uses real goal planning and observation before resubmission, without another write',async t=>{
 const f=fixture();t.after(()=>f.runtime.close());const {id}=await f.start();await f.runtime.tick(id);const task=f.runtime.tasks.get(id),originalGoal=task.goal,authority=structuredClone(task.authority);
 assert.equal(task.state.completionProposal.status,'pending');await f.runtime.tick();await flush();assert(task.state.recoveryGuidance.reviewedResult);
 await f.runtime.tick(id);assert.equal(f.calls.filter(v=>v==='send').length,1);assert.equal(f.requests.length,1);assert(f.requests[0].recoveryGuidance.reviewedResult);assert.equal(f.requests[0].resultContracts[0].name,'conversation.send');assert(Object.values(task.actionRuns).some(run=>run.goalAction));
 await f.runtime.tick(id);assert.deepEqual(f.calls,['send','observe']);assert.equal(f.requests.length,2);assert.equal(task.state.completionProposal.status,'pending');await f.runtime.tick();await flush();
 assert.equal(task.status,'completed');assert.equal(f.reviews(),2);assert.equal(task.goal,originalGoal);assert.deepEqual(task.authority,authority);assert.equal(f.runtime.tasks.size,1);
});
test('optional review reads use the original actor authority and do not silently expand a restricted task',async t=>{
 const f=fixture();t.after(()=>f.runtime.close());const {id}=await f.start({...owner,capabilities:['conversation.send']});const task=f.runtime.tasks.get(id);assert.deepEqual(task.capabilities,['conversation.send']);await f.runtime.tick(id);assert.deepEqual(f.calls,['send']);assert.deepEqual(task.capabilities,['conversation.send']);
});
test('owner stop seals a late remediation plan and cannot replay the confirmed write',async t=>{
 const entered=Promise.withResolvers(),late=Promise.withResolvers(),f=fixture({request:async()=>{entered.resolve();return late.promise;}});t.after(()=>f.runtime.close());const {id}=await f.start();await f.runtime.tick(id);await f.runtime.tick();await flush();
 const pending=f.runtime.tick(id);await entered.promise;await f.runtime.control('stop',id);late.resolve({response:{text:JSON.stringify({done:true,summary:'Obsolete judgment'})}});await pending;
 assert.equal(f.runtime.tasks.get(id).status,'stopped');assert.deepEqual(f.calls,['send']);
});
test('a mistaken remediation plan cannot spend the consumed one-shot write authorization',async t=>{
 const f=fixture({request:async()=>({response:{text:JSON.stringify({done:false,actions:[{key:'duplicate',goal:'Repeat the effect',criteria:'Another send',operations:[{key:'again',tool:'conversation.send',args:{...subject,message:'synthetic body'}}]}]})}})});t.after(()=>f.runtime.close());
 const {id}=await f.start();await f.runtime.tick(id);await f.runtime.tick();await flush();await f.runtime.tick(id);assert.deepEqual(f.calls,['send']);assert.notEqual(f.runtime.tasks.get(id).status,'completed');
});
