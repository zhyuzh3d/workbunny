'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime'),{AgentService}=require('../src/main/agent-service');
const {ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
const {ConversationCursor,adjudicatedAlignment}=require('../src/main/conversation-cursor'),{ConversationBrain}=require('../src/main/conversation-brain'),{subjectKey}=require('../src/main/conversation-skill');
const msg=(text,direction='incoming')=>({text,direction,kind:'text',incomingVerified:false,observedVerified:false});
const before=[msg('Earlier context'),msg('Render-one earlier reply','outgoing'),msg('Known update'),msg('Render-one acknowledgement','outgoing'),msg('Last known incoming'),msg('Render-one closing','outgoing'),msg('Render-one current question about plans','outgoing')];
const incoming='Projects are progressing; tomorrow ten oclock review; prepare materials; no extra help.';
const view=variant=>({headerMatched:true,observationId:'capture-'+variant,messages:[...before.slice(1).map(m=>({...m,text:m.text.replaceAll('Render-one',variant)})),msg(incoming)],draft:''});
const accepted={uncertain:false,matches:[{previousIndex:5,currentIndex:4},{previousIndex:6,currentIndex:5}],reason:'The final outgoing question and preceding closing are the same ordered occurrences despite visual transcription differences'};
async function fixture(t,decide=()=>accepted){
 const records=new Map(),tools=new ToolRegistry(),skills=new SkillRegistry(tools).register({id:'fixture.alignment',version:1,description:'Synthetic observation only',tools:[],capabilities:[],run:async()=>({status:'waiting'})});
 const runtime=new AgentRuntime({tools,skills,autoSchedule:false,epoch:()=>1,journal:{put:async value=>records.set(value.id,structuredClone(value)),list:async()=>[],authorized:async()=>true}});t.after(()=>runtime.close());
 const subject={application:'wechat',recipient:'Synthetic Contact'},start=await runtime.start({skill:'fixture.alignment',goal:'Read the new reply in order',subjects:[subject],parameters:{behavior:'inquiry'}},{role:'owner',verified:true,sources:['synthetic-owner'],scene:'life'});assert(start.ok);
 const task=runtime.tasks.get(start.id),cursor=new ConversationCursor();cursor.observe(before);task.status='waiting';task.state.conversations={[subjectKey(subject)]:{subject,cursor:cursor.snapshot()}};
 let requests=0;
 const service=Object.assign(Object.create(AgentService.prototype),{runtime,scene:{captureGeneration:1},getWeChatOwnership:()=> 'owner',ownMessages:()=>[],brain:new ConversationBrain({request:async options=>{requests++;const payload=JSON.parse(options.messages.at(-1).content);assert.equal(options.maxTokens,8192);return {response:{text:JSON.stringify(await decide(payload,requests,options))}};}})});
 return {task,runtime,service,subject,requests:()=>requests,observe:v=>service.observeConversationDelta(task,subject,undefined,{view:v})};
}
test('the first accurate ambiguous observation becomes one original event and later rendered variants do not duplicate it',async t=>{
 const f=await fixture(t);assert.equal(new ConversationCursor(Object.values(f.task.state.conversations)[0].cursor).observe(view('Render-two').messages).uncertain,true);
 await f.observe(view('Render-two'));assert.equal(f.requests(),1);assert.equal(f.task.inbox.length,1);assert.equal(f.task.counters.events,1);
 const message=f.task.inbox[0].messages[0];assert.equal(message.text,incoming);assert.equal(message.direction,'incoming');assert.equal(message.sequence,1);assert.equal(message.incomingVerified,false);assert.equal(message.observedVerified,false);assert.equal(message.alignment.source,'task-brain');assert.equal(f.task.inbox[0].ownerChannel,false);
 await f.observe(view('Render-three'));await f.observe(view('Render-one'));assert.equal(f.requests(),1);assert.equal(f.task.inbox.length,1);assert.equal(f.task.counters.events,1);
});
test('same-view concurrent callbacks share one judgment and keep repeated independent incoming messages in order',async t=>{
 let entered,release;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r),f=await fixture(t,async()=>{entered();await gate;return accepted;});
 const observed=view('Render-two');observed.messages.push(msg(incoming));const a=f.observe(observed);await began;const b=f.observe({...observed,observationId:'different-capture-same-facts'});release();await Promise.all([a,b]);
 assert.equal(f.requests(),1);assert.equal(f.task.inbox.length,1);assert.deepEqual(f.task.inbox[0].messages.map(m=>[m.text,m.sequence]),[[incoming,1],[incoming,2]]);
});
test('an uncertain judgment preserves the original cursor and repeated evidence does not call the model again',async t=>{
 const f=await fixture(t,()=>({uncertain:true,reason:'The repeated last question cannot be uniquely located'})),original=structuredClone(Object.values(f.task.state.conversations)[0].cursor);
 await f.observe(view('Render-two'));await f.observe({...view('Render-two'),observationId:'new-id-same-content'});assert.equal(f.requests(),1);assert.equal(f.task.inbox.length,0);assert.equal(f.task.state.result,undefined);assert.deepEqual(Object.values(f.task.state.conversations)[0].cursor,original);
});
for(const change of ['stop','goal','channel'])test('a late alignment cannot enqueue after '+change+' changes its original scope',async t=>{
 let entered,release;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r),f=await fixture(t,async()=>{entered();await gate;return accepted;});
 let revision=1;
 if(change==='channel')f.service.channels={channels:new Map([['fixture',{id:'fixture'}]]),descriptor:()=>({id:'fixture'}),snapshot:()=>({owner:false,revision})};
 const pending=f.observe(view('Render-two'));await began;
 if(change==='stop'){assert((await f.runtime.control('stop',f.task.id)).ok);assert.equal(f.runtime.tasks.get(f.task.id).status,'stopped');}else if(change==='goal')f.task.state.goalRevision=1;else revision++;
 release();await pending;assert.equal(f.runtime.tasks.get(f.task.id).inbox.length,0);
});
test('owner-channel ambiguity cannot be promoted by a model alignment into a new owner command',async t=>{
 const f=await fixture(t);f.task.parameters.behavior='owner';await f.observe(view('Render-two'));assert.equal(f.requests(),0);assert.equal(f.task.inbox.length,0);
 const context=new ConversationCursor(Object.values(f.task.state.conversations)[0].cursor).alignmentContext(view('Render-two').messages);
 for(const decision of [{...accepted,owner:true},{...accepted,matches:[{previousIndex:6,currentIndex:6}]},{...accepted,matches:[{previousIndex:6,currentIndex:5,text:'rewritten'}]}])assert.throws(()=>adjudicatedAlignment(context,decision),{code:'E_CONVERSATION_ALIGNMENT'});
});
test('a valid alignment waiting to enter the original event queue cannot outlive a changed goal',async t=>{
 const f=await fixture(t),enqueue=f.runtime.enqueue.bind(f.runtime);let entered,release;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.runtime.enqueue=async(...args)=>{entered();await gate;return enqueue(...args);};
 const pending=f.observe(view('Render-two'));await began;f.task.state.goalRevision=1;release();await pending;
 assert.equal(f.requests(),1);assert.equal(f.task.inbox.length,0);assert.equal(f.task.counters.events,0);assert.equal(Object.values(f.task.state.conversations)[0].cursor.sequence,0);
});
