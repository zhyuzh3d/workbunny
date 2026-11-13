'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime'),{AgentService}=require('../src/main/agent-service');
const {ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
const {conversationSkill,subjectKey}=require('../src/main/conversation-skill'),{registerConversationTools}=require('../src/main/conversation-tools');
const incoming=text=>({direction:'incoming',kind:'text',text,incomingVerified:true,observedVerified:true});
const until=async check=>{const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw Error('synthetic observation deadline');await new Promise(r=>setTimeout(r,2));}};
async function fixture({busy=false,unknown=false}={}){
 const subject={application:'wechat',recipient:'Synthetic Contact'},records=new Map(),tools=new ToolRegistry(),entered=Promise.withResolvers(),release=Promise.withResolvers();
 let visible=[incoming('visible baseline')],samples=0;const sent=[],calls=[];
 const scene={assertTaskIdentity:async()=>{},invalidate(){},observe:async()=>{samples++;return {headerMatched:true,changed:true,messages:visible,draft:''};}};
 registerConversationTools(tools,{scene,memoryRelated:async()=>({items:[]}),execute:async args=>{
  calls.push(args.operation);assert.equal(args.operation,'send','already visible latest conversation needs no navigation');
  if(args.message==='synthetic opening'){
   entered.resolve();
   if(unknown){await release.promise;return {ok:false,dispatched:true,code:'E_SUBMISSION_UNCERTAIN',inputOutcome:{dispatched:true,completion:'unknown'}};}
   await new Promise((resolve,reject)=>{
    const cancel=()=>reject(Object.assign(Error('synthetic send cancelled before dispatch'),{code:'E_ACTION_SUPERSEDED',dispatched:false}));
    args.signal.addEventListener('abort',cancel,{once:true});if(args.signal.aborted)cancel();
   });
  }
  sent.push(args.message);return {ok:true,verified:true,receipt:{operationId:'synthetic-reply',sentText:args.message,submittedAt:Date.now()}};
 }});
 const skills=new SkillRegistry(tools).register(conversationSkill({canOperate:async()=>!busy,brain:{decide:async()=>({decision:'reply',reply:'synthetic latest reply',summary:'synthetic summary',completed:false,progress:{},unknown:[]})}}));
 const runtime=new AgentRuntime({tools,skills,autoSchedule:false,epoch:()=>1,journal:{put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[],authorized:async()=>true}});
 const watcher={runtime,scene,actionWatchIntervalMs:2,ownMessages:()=>[],getWeChatOwnership:()=> 'owner',observeConversationDelta:AgentService.prototype.observeConversationDelta};
 runtime.observeWhileActive=(task,event,signal)=>AgentService.prototype.startConversationObservation.call(watcher,task,subject,{signal});
 const started=await runtime.start({skill:'conversation.manage',goal:'Ask and keep responding until the goal is resolved',subjects:[subject],parameters:{behavior:'inquiry',openingMessage:'synthetic opening'}},{role:'owner',verified:true,scene:'life',sources:['synthetic-owner']});
 return {runtime,id:started.id,records,entered,release,sent,calls,samples:()=>samples,add:()=>{visible=[...visible,incoming('new verified message')];},subject};
}
test('the visible latest conversation is armed and checkpointed before GUI admission for its first question',async t=>{
 const f=await fixture({busy:true});t.after(()=>f.runtime.close());await f.runtime.tick(f.id);
 const task=f.runtime.tasks.get(f.id),key=subjectKey(f.subject);
 assert.equal(task.state.conversations[key].cursor.ready,true);assert.equal(f.records.get(f.id).state.conversations[key].cursor.ready,true);
 assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});
test('existing read-only observation detects incoming messages during a blocked opening and safely replaces an unsent opening',async t=>{
 const f=await fixture();t.after(()=>f.runtime.close());const opening=f.runtime.tick(f.id);await f.entered.promise;
 const task=f.runtime.tasks.get(f.id),key=subjectKey(f.subject);assert.equal(task.state.conversations[key].cursor.ready,true);
 f.add();await until(()=>task.inbox.some(e=>e.type==='conversation.messages'));await opening;
 assert(f.samples()>1);assert.equal(f.sent.length,0);assert(Object.values(task.operations).some(op=>op.tool==='conversation.send'&&op.status==='not_dispatched'));
 await f.runtime.tick(f.id);assert.deepEqual(f.sent,['synthetic latest reply']);assert.equal(task.inbox.length,0);assert.equal(f.runtime.tasks.size,1);
});
test('observation retains a new message while an opening has an unknown effect and cannot send a competing reply',async t=>{
 const f=await fixture({unknown:true});t.after(()=>f.runtime.close());const opening=f.runtime.tick(f.id);await f.entered.promise;
 const task=f.runtime.tasks.get(f.id);f.add();await until(()=>task.inbox.some(e=>e.type==='conversation.messages'));f.release.resolve();await opening;
 assert.equal(task.status,'needs_attention');assert(Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='intent'));
 await f.runtime.tick(f.id);assert.equal(f.sent.length,0);assert.equal(f.calls.length,1);assert.equal(task.inbox.length,1);
});
