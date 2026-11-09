'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service');
const owner={role:'owner',verified:true,sources:['synthetic-owner'],scene:'life'};
const suspension={assessmentSummary:'Local interpretation conflicts with retained evidence and existing paths could not resolve it',attemptedPaths:['independent local fixture checks'],remainingUncertainty:'The old premise can be wrong',requestedHelp:'Find an alternate strategy for the same goal'};
const guidance={type:'replan',rationaleSummary:'The initial premise was wrong; use the independent fixture result',sourceRefs:[],guidance:{hypotheses:['The first interpretation was wrong'],alternativeStrategies:['Use the independent fixture path'],verificationIdeas:['Read the alternate result and compare it to the original criterion']}};
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function service(request){
 const records=new Map(),reviews=[],reports=[];
 const agent=new AgentService({request,reviewTask:async args=>{reviews.push(args);return guidance;},autoSchedule:false,ready:()=>true,epoch:()=>1,
  scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},journal:{put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[...records.values()].map(structuredClone),authorized:async()=>true},
  report:async report=>reports.push(report)});
 return {agent,records,reviews,reports};
}
for(const skill of ['software.execute','system.operate'])test(skill+' consumes main guidance through the real task model and completes in the original action',async t=>{
 let phase=0,executions=0,sawGuidance=false;
 const tool=skill==='system.operate'?'terminal.execute':'screen.observe';
 const h=service(async opts=>{const input=JSON.parse(opts.messages[1].content[0].text);
  if(phase++===0)return {response:{text:JSON.stringify({done:false,selfSuspension:suspension})}};
  sawGuidance=input.recoveryGuidance?.source==='main-review';assert(sawGuidance);assert(input.recoveryGuidance.alternativeStrategies.length);
  return {response:{text:JSON.stringify(input.attempts.length?{done:true,summary:'The actual alternate fixture result meets the original criterion'}:
   {done:false,tool,args:tool==='terminal.execute'?{application:'system',command:'/usr/bin/true',args:[],impact:'read',purpose:'synthetic result'}:{application:'workbuddy',force:true}})}};
 });t.after(()=>h.agent.close());
 const definition=h.agent.tools.get(tool);h.agent.tools.tools.set(tool,{...definition,execute:async()=>{executions++;return tool==='terminal.execute'?{ok:true,verified:true,exitCode:0,stdout:'actual alternate fixture'}:{available:true,changed:true,frameId:'synthetic-frame',verified:true};}});
 const started=await h.agent.start({skill,goal:'Confirm the authorized fixture outcome',subjects:[{application:skill==='system.operate'?'system':'workbuddy'}]},owner);assert(started.ok,started.error);
 await h.agent.runtime.tick(started.id);let task=h.agent.runtime.tasks.get(started.id);const actionId=Object.keys(task.actionRuns)[0];assert.equal(task.status,'paused');
 await h.agent.runtime.tick();await flush();await h.agent.runtime.tick(started.id);await h.agent.runtime.tick(started.id);task=h.agent.runtime.tasks.get(started.id);
 assert.equal(task.status,'completed');assert.equal(executions,1);assert.equal(h.reviews.length,1);assert.equal(Object.keys(task.actionRuns)[0],actionId);assert(sawGuidance);assert.equal(h.reports.length,1);
});
test('the conversation model can self-suspend an event, then consume guidance and send one verified reply',async t=>{
 let phase=0,sends=0,sawGuidance=false;
 const h=service(async opts=>{const input=JSON.parse(opts.messages[1].content);sawGuidance ||=input.actionRecovery?.source==='main-review';
  return {response:{text:JSON.stringify(phase++===0?{decision:'notify',reply:'',summary:'local path unavailable',completed:false,progress:{},unknown:[],selfSuspension:suspension}:
   {decision:'reply',reply:'The independently checked answer',summary:'confirmed fixture answer',completed:false,progress:{},unknown:[]})}};
 });t.after(()=>h.agent.close());
 h.agent.scene.observe=async()=>({headerMatched:true,changed:false,messages:[]});
 const send=h.agent.tools.get('conversation.send');h.agent.tools.tools.set(send.name,{...send,execute:async()=>{sends++;return {ok:true,verified:true,receipt:{sentText:'The independently checked answer',submittedAt:Date.now()}};}});
 const started=await h.agent.start({skill:'conversation.manage',goal:'Answer the authorized fixture question',subjects:[{application:'wechat',recipient:'Synthetic contact'}],parameters:{behavior:'reply'},completion:'first_match'},owner);
 const task=h.agent.runtime.tasks.get(started.id);task.state.conversations={'wechat:synthetic contact':{cursor:{ready:true,recent:[]},introduced:true,progress:{},summary:''}};
 await h.agent.runtime.enqueue(started.id,{key:'synthetic-event',subjectKey:require('../src/main/conversation-skill').subjectKey(task.subjects[0]),type:'conversation.messages',messages:[{kind:'text',text:'synthetic question',direction:'incoming',incomingVerified:true}]});
 await h.agent.runtime.tick(started.id);assert.equal(task.status,'paused');assert.equal(sends,0);await h.agent.runtime.tick();await flush();await h.agent.runtime.tick(started.id);
 assert.equal(task.status,'completed');assert.equal(sends,1);assert(sawGuidance);assert.equal(h.reviews.length,1);assert.equal(task.inbox.length,0);
});
test('WorkBuddy monitor signals are routed into the canonical review and do not duplicate outside-task alerts',async t=>{
 const h=service(async()=>{throw Error('no extra task model needed');});t.after(()=>h.agent.close());
 const started=await h.agent.start({skill:'work.delegate',goal:'Follow the original delegated job',subjects:[{application:'workbuddy'}]},owner),task=h.agent.runtime.tasks.get(started.id);task.state.job={jobId:'synthetic-physical'};
 const event={id:'synthetic-stall',kind:'stall',text:'same bound executor has no new result',snapshot:{task:{id:'synthetic-physical'}}};
 assert.equal(await h.agent.observeSupervision(event),true);assert.equal(await h.agent.observeSupervision(event),true);assert.equal(task.state.supervisionSignals.length,1);
 await h.agent.runtime.tick();await flush();assert.equal(h.reviews.length,1);assert.equal(h.reports.length,0);
 assert.equal(await h.agent.observeSupervision({...event,id:'unbound',snapshot:{task:{id:'unrelated-physical'}}}),false);
});
test('dedicated task reflection leaves the ordinary Skill request route unchanged',async t=>{
 let ordinary=0,reflective=0;
 const records=new Map(),agent=new AgentService({autoSchedule:false,ready:()=>true,epoch:()=>1,scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},
  journal:{put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[],authorized:async()=>true},reviewTask:async()=>guidance,
  request:async()=>{ordinary++;return {response:{text:JSON.stringify({done:false,tool:'terminal.execute',args:{application:'system',command:'/usr/bin/true',args:[],impact:'read',purpose:'synthetic check'}})}};},
  reasoningRequest:async()=>{reflective++;return {response:{text:JSON.stringify({action:'self_suspend',nextStep:'Request a broader strategy',selfSuspension:suspension})}};}});t.after(()=>agent.close());
 const terminal=agent.tools.get('terminal.execute');agent.tools.tools.set(terminal.name,{...terminal,execute:async()=>{throw Object.assign(Error('synthetic known non-dispatch'),{dispatched:false});}});
 const start=await agent.start({skill:'system.operate',goal:'Complete the original fixture goal',subjects:[{application:'system'}]},owner);await agent.runtime.tick(start.id);
 assert.equal(ordinary,1);assert.equal(reflective,1);assert.equal(agent.runtime.tasks.get(start.id).status,'paused');
});
