'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime');
const {ToolRegistry}=require('../src/main/agent-tools');
const {SkillRegistry}=require('../src/main/agent-skills');
const {taskSpec}=require('../src/main/agent-contract');
const {modelJSON,checkedJSON}=require('../src/main/agent-json');
const spec={skill:'test.task',goal:'照看 Alice',subjects:[{application:'wechat',recipient:'Alice'}]};
const owner={role:'owner',verified:true,sources:['owner-turn'],scene:'life'};
function setup(run,options={}){
  const records=new Map(),calls=[],tools=new ToolRegistry();let now=1000;
  tools.register({name:'screen.read',description:'read pixels',effect:'read',capabilities:['screen.read'],execute:async()=>({ok:true,pngBase64:'private-pixels'})});
  tools.register({name:'conversation.send',description:'send one message',effect:'write',capabilities:['conversation.send'],scope:a=>a,
    execute:async(a,c)=>{assert.equal(records.get(c.task.id).operations[c.operationId].status,'intent','intent must be durable before write');calls.push(a);if(options.failWrite)throw Error('lost receipt');return {ok:true,verified:true,message:a.message};}});
  const skills=new SkillRegistry(tools).register({id:'test.task',version:1,description:'test',tools:['screen.read','conversation.send'],capabilities:['screen.read','conversation.send'],run});
  const journal={put:async t=>{records.set(t.id,structuredClone(t));},list:async()=>[...records.values()].map(t=>structuredClone(t)),authorized:async t=>options.authorized!==false&&records.has(t.id)};
  const runtime=new AgentRuntime({journal,tools,skills,autoSchedule:false,clock:()=>now,epoch:()=>1});
  return {runtime,records,calls,tools,skills,journal,advance:()=>{now+=60000;}};
}
const send={tool:'conversation.send',key:'reply-event-1',args:{application:'wechat',recipient:'Alice',message:'hello'}};
test('tasks require verified owner provenance and default to low-frequency observation',async()=>{
 const h=setup(async()=>({status:'waiting'}));
 assert.equal((await h.runtime.start(spec,{...owner,role:'contact'})).ok,false);
 assert.equal((await h.runtime.start(spec,{...owner,sources:[]})).ok,false);
 assert.equal(taskSpec(spec).schedule.intervalSeconds,60);
 const started=await h.runtime.start(spec,owner);assert(started.ok);assert.equal(h.calls.length,0);
});
test('script validates every target before its first effect',async()=>{
 const h=setup(async({script})=>{await script({steps:[send,{...send,key:'wrong',args:{...send.args,recipient:'Bob'}}]});return {status:'completed'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);assert.equal(h.calls.length,0);
 assert.match(h.runtime.tasks.get(id).note,/范围/);
});
test('unknown write pauses durably and cannot be replayed after restart',async()=>{
 const run=async({call})=>{await call(send);return {status:'completed'};},h=setup(run,{failWrite:true});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);
 assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(id).status,'needs_attention');await h.runtime.close();
 const restored=new AgentRuntime({journal:h.journal,tools:h.tools,skills:h.skills,epoch:()=>1,autoSchedule:false});await restored.restore();
 await restored.tick(id);assert.equal(h.calls.length,1);assert.equal((await restored.control('resume',id)).ok,false);
});
test('host read-only reconciliation records a verified receipt and resumes without another write',async()=>{
 const h=setup(async({call})=>{await call(send);return {status:'completed'};},{failWrite:true}),{id}=await h.runtime.start(spec,owner);
 await h.runtime.tick(id);const op=Object.values(h.runtime.tasks.get(id).operations)[0];
 assert.equal((await h.runtime.confirmReconciled(id,op.id,{ok:true,verified:false})).ok,false);
 assert((await h.runtime.confirmReconciled(id,op.id,{ok:true,verified:true,receipt:{readOnly:true}})).ok);
 assert.equal(h.runtime.tasks.get(id).status,'paused');await h.runtime.control('resume',id);await h.runtime.tick(id);
 assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(id).status,'completed');assert.equal(h.runtime.tasks.get(id).counters.writes,1);
});
test('verified effect is not repeated when a later read/planning step fails',async()=>{
 let round=0;const h=setup(async({call})=>{await call(send);if(!round++)throw Error('read-only planning failed');return {status:'completed'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(id).status,'completed');
});
test('busy events remain in a durable queue and are consumed once after resuming',async()=>{
 let busy=true;const h=setup(async({event,call})=>{if(!event||busy)return {status:'waiting',consumeEvent:false};await call({...send,key:event.key});return {status:'waiting'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'new-1',text:'hi'});await h.runtime.tick(id);
 assert.equal(h.runtime.tasks.get(id).inbox.length,1);assert.equal(h.calls.length,0);
 await h.runtime.control('pause',id);assert((await h.runtime.enqueue(id,{key:'new-1',text:'hi'})).duplicate);
 busy=false;await h.runtime.control('resume',id);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(id).inbox.length,0);
});
test('polling stores bounded receipts without pixel data',async()=>{
 const h=setup(async({task,call})=>{await call({tool:'screen.read',args:{},key:'sample-'+task.counters.wakes});return {status:'waiting'};});
 const {id}=await h.runtime.start(spec,owner);for(let i=0;i<80;i++)await h.runtime.tick(id);
 const t=h.records.get(id);assert(Object.keys(t.operations).length<=32);assert(!JSON.stringify(t).includes('private-pixels'));
});
test('a pause between tools prevents later input',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),atGate=new Promise(r=>entered=r);
 const h=setup(async({call})=>{entered();await gate;await call(send);return {status:'completed'};});
 const {id}=await h.runtime.start(spec,owner);const tick=h.runtime.tick(id);await atGate;await h.runtime.control('pause',id);release();await tick;
 assert.equal(h.calls.length,0);assert.equal(h.runtime.tasks.get(id).status,'paused');
});
test('same write key cannot silently change its arguments',async()=>{
 const h=setup(async({call})=>{await call(send);await call({...send,args:{...send.args,message:'changed'}});return {status:'completed'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);assert.equal(h.calls.length,1);assert.match(h.runtime.tasks.get(id).note,/不同工具或参数/);
});
test('queue capacity keeps the overflowing event and cursor durably until explicit resume',async()=>{
 const h=setup(async()=>({status:'waiting'})),{id}=await h.runtime.start(spec,owner);
 for(let i=0;i<201;i++)assert((await h.runtime.enqueue(id,{key:'event-'+i,text:'pending'})).ok);
 const task=h.runtime.tasks.get(id);assert.equal(task.status,'needs_attention');assert.equal(task.overflowEvent.key,'event-200');
 assert.equal(h.records.get(id).overflowEvent.key,'event-200');assert.equal(h.runtime.list()[0].queuedEvents,201);
 await h.runtime.control('resume',id);await h.runtime.tick(id);
 assert.equal(task.inbox.length,200);assert.equal(task.inbox.at(-1).key,'event-200');assert.equal(task.overflowEvent,undefined);
});
test('a verified write that finishes after pause is recorded without continuing or replaying it',async()=>{
 const h=setup(async({call})=>{await call(send);return {status:'completed'};});let entered,release;
 const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),tool=h.tools.get('conversation.send');
 h.tools.tools.set(tool.name,{...tool,execute:async(...args)=>{entered();await gate;return tool.execute(...args);}});
 const {id}=await h.runtime.start(spec,owner),tick=h.runtime.tick(id);await started;await h.runtime.control('pause',id);release();await tick;
 const task=h.runtime.tasks.get(id);assert.equal(task.status,'paused');assert.equal(task.counters.writes,1);
 assert.equal(Object.values(task.operations)[0].status,'confirmed');assert((await h.runtime.control('resume',id)).ok);
 await h.runtime.tick(id);assert.equal(h.calls.length,1);
});
test('pause all prevents a concurrently admitted task from starting after its journal write',async()=>{
 const h=setup(async()=>({status:'waiting'}));let entered,release;
 const arrived=new Promise(r=>entered=r),gate=new Promise(r=>release=r),put=h.journal.put;
 h.journal.put=async task=>{entered();await gate;return put(task);};
 const starting=h.runtime.start(spec,owner);await arrived;await h.runtime.controlAll('pause');release();const result=await starting;
 assert.equal(result.ok,false);assert.equal(h.runtime.tasks.size,0);assert.equal([...h.records.values()][0].status,'stopped');
});
test('updating a task preserves its identity and queued event while replacing a prepared reply',async()=>{
 const h=setup(async()=>({status:'waiting',consumeEvent:false})),{id}=await h.runtime.start(spec,owner);
 await h.runtime.enqueue(id,{key:'pending',decision:{reply:'old'}});
 assert((await h.runtime.update(id,{goal:'Ask the revised question'},owner)).ok);
 assert.equal(h.runtime.tasks.get(id).inbox[0].decision,undefined);assert.equal(h.runtime.tasks.get(id).goal,'Ask the revised question');
 assert.equal(h.runtime.tasks.get(id).state.goalRevision,1);
});
test('skill learning cannot expand capabilities, and only verified newer knowledge is promoted',()=>{
 const h=setup(async()=>({status:'waiting'}));h.skills.stage({id:'test.task',instructions:'Wait after clicks',source:'owner-guidance',capabilities:['shell.exec']});
 assert.throws(()=>h.skills.promote('test.task',{passed:false,checks:['fixture'],source:'test'}),/验证/);
 assert.equal(h.skills.promote('test.task',{passed:true,checks:['fixture'],source:'test'}),2);
 assert.deepEqual(h.skills.get('test.task').capabilities,['screen.read','conversation.send']);
});
test('model JSON allows an exact fence, rejects duplicate keys and prose, and retries read-only formatting once',async()=>{
 assert.equal(modelJSON('```json\n{"ok":true}\n```').ok,true);
 assert.throws(()=>modelJSON('{"ok":true,"ok":false}'),/重复/);assert.throws(()=>modelJSON('I did it {"ok":true}'));
 let calls=0;const checked=await checkedJSON({messages:[]},v=>{assert.equal(v.ok,true);return v;},{request:async()=>({response:{text:++calls===1?'{"x":.4}':'{"ok":true}'}})});
 assert.equal(checked.attempts,2);assert.equal(calls,2);
});
