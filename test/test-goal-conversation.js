'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service'),{subjectKey}=require('../src/main/conversation-skill');
const until=async check=>{const end=Date.now()+1500;while(!check()){if(Date.now()>end)throw Error('synthetic deadline');await new Promise(r=>setTimeout(r,2));}};
const incoming=text=>({direction:'incoming',kind:'text',text,incomingVerified:true,observedVerified:true});
function fixture({blockOpening=false,completed=false}={}){
 const subject={application:'wechat',recipient:'Synthetic Contact'},records=new Map(),requests=[],sent=[];let visible=[incoming('latest visible baseline')],samples=0;const entered=Promise.withResolvers();
 const scene={metrics:{},native:{request:async()=>({})},assertTaskIdentity:async()=>{},close:async()=>{},observe:async()=>{samples++;return {headerMatched:true,changed:true,latestPending:false,draft:'',messages:visible,at:Date.now()};}};
 const request=async options=>{const content=options.messages.at(-1).content,p=JSON.parse(typeof content==='string'?content:content[0].text);requests.push(p);let decision;
  if(p.ownerTask)decision={decision:p.phase==='post-send'?'ignore':'reply',reply:p.phase==='post-send'?'':'latest synthetic reply',summary:'New message addressed',completed,progress:{},unknown:[]};
  else if(!p.action){assert(p.conversations[subjectKey(subject)].cursor.ready);assert.equal(p.parameters.behavior,'inquiry');decision={done:false,actions:[{key:'ask',goal:'Ask about the requested topic and keep responding',criteria:'Opening received and replies followed'}]};}
  else decision={done:false,tool:'conversation.send',args:{...subject,message:'synthetic opening'}};
  return {response:{text:JSON.stringify(decision)}};
 };
 const agent=new AgentService({journal:{put:async t=>records.set(t.id,structuredClone(t)),authorized:async()=>true,list:async()=>[...records.values()]},ready:()=>true,epoch:()=>1,scene,request,autoSchedule:false});agent.actionWatchIntervalMs=2;
 agent.tools.tools.set('conversation.send',{...agent.tools.get('conversation.send'),execute:async(args,ctx)=>{
  if(args.message==='synthetic opening'&&blockOpening){entered.resolve();await new Promise((resolve,reject)=>{const cancel=()=>reject(Object.assign(Error('new message before input'),{code:'E_ACTION_SUPERSEDED',dispatched:false}));ctx.signal.addEventListener('abort',cancel,{once:true});if(ctx.signal.aborted)cancel();});}
  sent.push(args.message);visible=[...visible,{direction:'outgoing',kind:'text',text:args.message,observedVerified:true}];return {ok:true,verified:true,receipt:{operationId:'synthetic-'+sent.length,sentText:args.message,submittedAt:Date.now()}};
 }});
 return {agent,subject,records,requests,sent,entered,samples:()=>samples,add:()=>visible=[...visible,incoming('new latest message')]};
}
const owner={role:'owner',verified:true,scene:'life',sources:['synthetic-owner']};
const specification=subject=>({skill:'conversation.manage',goal:'Actively ask, keep watching and responding, then summarize; only latest messages, never scroll old history',criteria:'Requested topic resolved from actual replies',subjects:[subject],parameters:{behavior:'inquiry',questions:['Ask the requested topic']},completion:'goal'});
test('inquiry first observes the actual latest conversation, then the general planner chooses an explicit Action and send Operation',async t=>{
 const f=fixture();t.after(()=>f.agent.close());const {id}=await f.agent.start(specification(f.subject),owner,{ownerRequest:'Synthetic owner inquiry and ongoing response'});
 await f.agent.runtime.tick(id);const task=f.agent.runtime.tasks.get(id);assert.equal(f.sent.length,0);assert(Object.values(task.actionRuns).some(a=>a.goalAction&&a.key==='ask'));assert.equal(task.state.conversations[subjectKey(f.subject)].cursor.ready,true);
 await f.agent.runtime.tick(id);assert.deepEqual(f.sent,['synthetic opening']);assert.equal(task.state.conversations[subjectKey(f.subject)].introduced,true);assert(!Object.values(task.operations).some(o=>o.tool==='conversation.open'));assert.equal(f.requests[1].action.goal,'Ask about the requested topic and keep responding');
});
test('one Task lifecycle observer stays armed between Actions, journals observations, and stops when the owner pauses',async t=>{
 const f=fixture();t.after(()=>f.agent.close());const {id}=await f.agent.start(specification(f.subject),owner);await f.agent.runtime.tick(id);const task=f.agent.runtime.tasks.get(id);assert.equal(f.agent.runtime.controllers.size,0);
 f.add();await until(()=>task.inbox.length>0);assert(Object.values(task.actionRuns).some(a=>a.subscription&&a.subjects[0].recipient===f.subject.recipient));assert(Object.values(task.operations).some(o=>o.tool==='conversation.observe'&&task.actionRuns[o.actionId]?.subscription));assert.equal(f.agent.conversationObservers.size,1);
 await f.agent.control('pause',id);const stoppedSamples=f.samples();await new Promise(r=>setTimeout(r,12));assert.equal(f.agent.conversationObservers.size,0);assert.equal(f.samples(),stoppedSamples);assert.equal(f.agent.runtime.tasks.get(id).status,'paused');
});
test('a newly observed message replaces an unsent general opening, then the original reply handler continues in the same Task',async t=>{
 const f=fixture({blockOpening:true});t.after(()=>f.agent.close());const {id}=await f.agent.start(specification(f.subject),owner);await f.agent.runtime.tick(id);const pending=f.agent.runtime.tick(id);await f.entered.promise;f.add();await pending;
 const task=f.agent.runtime.tasks.get(id);assert(task.inbox.length);assert.equal(f.sent.length,0);await f.agent.runtime.tick(id);assert.deepEqual(f.sent,['latest synthetic reply']);assert.equal(task.inbox.length,0);assert.equal(f.agent.runtime.tasks.size,1);
});
test('a reply that completes the ongoing goal uses the Task host delivery contract for a recipient outside conversation subjects',async t=>{
 const f=fixture({completed:true}),delivered=[];t.after(()=>f.agent.close());f.agent.deliverWork=async(message,task)=>{delivered.push({message,recipient:task.delivery.recipient});return {ok:true,verified:true,receipt:{sentText:message}};};
 const {id}=await f.agent.start({...specification(f.subject),delivery:{channel:'wechat',recipient:'Synthetic Owner Inbox',includeFiles:false}},owner);await f.agent.runtime.tick(id);await f.agent.runtime.tick(id);const task=f.agent.runtime.tasks.get(id);f.add();await until(()=>task.inbox.length>0);await f.agent.runtime.tick(id);
 assert.equal(task.status,'completed');assert.equal(task.state.delivery.status,'delivered');assert.equal(delivered.length,1);assert.equal(delivered[0].recipient,'Synthetic Owner Inbox');assert.match(delivered[0].message,/New message addressed/);assert.deepEqual(f.sent,['synthetic opening','latest synthetic reply']);
});
test('the production service enables the inquiry goal executor when using its default model transport',async t=>{
 const agent=new AgentService({scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},journal:{put:async()=>{},list:async()=>[],authorized:async()=>true},autoSchedule:false,ready:()=>true,epoch:()=>1});t.after(()=>agent.close());
 assert.equal(agent.skills.get('conversation.manage').goalDirected,true);assert.equal(agent.skills.get('software.execute').goalDirected,true);assert.equal(agent.skills.get('system.operate').goalDirected,true);
});
