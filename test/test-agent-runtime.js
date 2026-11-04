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
test('a replan after proven non-dispatch retains the failed attempt and completes the same logical step once',async()=>{
 let attempts=0;const h=setup(async({task,call})=>{try{await call({...send,args:{...send.args,message:task.state.replanned?'new plan':'old plan'}});}catch(error){if(error.dispatched!==false)throw error;task.state.replanned=true;return {status:'waiting',nextCheckAt:0};}return {status:'completed'};});
 const old=h.tools.get('conversation.send');h.tools.tools.set('conversation.send',{...old,execute:async(a,c)=>{attempts++;if(attempts===1)throw Object.assign(Error('known unsent'),{dispatched:false});return old.execute(a,c);}});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);await h.runtime.tick(id);
 const task=h.runtime.tasks.get(id),ops=Object.values(task.operations);assert.equal(task.status,'completed');assert.equal(ops.length,2);assert.equal(ops[0].status,'not_dispatched');assert.equal(ops[1].status,'confirmed');assert.equal(ops[0].replacedBy,ops[1].id);assert.equal(ops[1].supersedes,ops[0].id);assert.equal(h.calls.length,1);assert.equal(h.calls[0].message,'new plan');await h.runtime.close();
});
test('a workflow can continue from its own confirmed receipt after a checkpoint loss without regenerating or repeating the write',async()=>{
 let first=true;const h=setup(async({completedCall,call})=>{const done=completedCall(send.key,send.tool);if(done)return {status:'completed'};await call(send);if(first){first=false;throw Error('workflow checkpoint lost');}return {status:'completed'};});
 h.runtime.diagnoseRepair=null;const created=await h.runtime.start(spec,owner);await h.runtime.tick(created.id);assert.equal(h.calls.length,1);
 await h.runtime.tick(created.id);assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(created.id).status,'completed');await h.runtime.close();
});
test('a no-progress code from an uncertain write remains uncertain and is reported without automatic replay',async()=>{
 const h=setup(async({call})=>{await call({tool:'fixture.unknown',key:'once',args:{}});return {status:'completed'};});let inputs=0,reports=0;
 h.runtime.report=async()=>{reports++;};h.tools.register({name:'fixture.unknown',description:'uncertain fixture',effect:'write',capabilities:['conversation.send'],execute:async()=>{inputs++;return {ok:false,code:'E_NO_PROGRESS',error:'no new verification evidence'};}});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);const task=h.runtime.tasks.get(id);
 assert.equal(task.status,'needs_attention');assert.equal(task.state.lastFailure.code,'E_NO_PROGRESS');assert.equal(Object.values(task.operations)[0].status,'intent');assert.equal(reports,1);
 await h.runtime.tick(id);assert.equal(inputs,1);assert.equal(reports,1);await h.runtime.close();
});
test('GUI contention before dispatch preserves the event and retries promptly without repair or a failure lesson',async()=>{
 let busy=true,diagnoses=0,failures=0;
 const h=setup(async({event,call})=>{if(!event)return {status:'waiting'};if(busy)throw Object.assign(Error('GUI busy'),{code:'E_GUI_BUSY',dispatched:false});await call(send);return {status:'waiting'};});
 h.runtime.diagnoseRepair=async()=>{diagnoses++;return {action:'retry'};};h.runtime.failed=async()=>{failures++;};
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'pending'});await h.runtime.tick(id);
 const task=h.runtime.tasks.get(id);assert.equal(task.nextCheckAt,2000);assert.equal(task.inbox.length,1);assert.equal(task.status,'waiting');assert.equal(diagnoses,0);assert.equal(failures,0);assert.equal(task.state.lastFailure,undefined);
 busy=false;await h.runtime.tick(id);assert.equal(task.inbox.length,0);assert.equal(h.calls.length,1);await h.runtime.close();
});
test('tasks require verified owner provenance and default to low-frequency observation',async()=>{
 const h=setup(async()=>({status:'waiting'}));
 assert.equal((await h.runtime.start(spec,{...owner,role:'contact'})).ok,false);
 assert.equal((await h.runtime.start(spec,{...owner,sources:[]})).ok,false);
 assert.equal(taskSpec(spec).schedule.intervalSeconds,60);
 const started=await h.runtime.start(spec,owner);assert(started.ok);assert.equal(h.calls.length,0);
});
test('visual watching defaults to five-second pixels, while work supervision retains its low-frequency default',()=>{
 const watch=taskSpec({...spec,skill:'conversation.manage'}),work=taskSpec({...spec,skill:'work.delegate'});
 assert.equal(watch.schedule.intervalSeconds,5);assert.equal(watch.schedule.activeIntervalSeconds,3);assert.equal(work.schedule.intervalSeconds,60);
 assert.equal(taskSpec({...spec,schedule:{intervalSeconds:3}}).schedule.intervalSeconds,3);assert.throws(()=>taskSpec({...spec,schedule:{intervalSeconds:2}}));
});
test('changing cadence retains the existing expiry, while explicit unlimited duration clears it',async()=>{
 const h=setup(async()=>({status:'waiting'})),start=await h.runtime.start({...spec,schedule:{durationMinutes:30}},owner),task=h.runtime.tasks.get(start.id),expiry=task.expiresAt;
 assert((await h.runtime.update(start.id,{schedule:{intervalSeconds:5}},owner)).ok);assert.equal(task.expiresAt,expiry);assert.equal(task.schedule.durationMinutes,30);
 assert((await h.runtime.update(start.id,{schedule:{durationMinutes:null}},owner)).ok);assert.equal(task.expiresAt,undefined);assert.equal(task.schedule.durationMinutes,undefined);await h.runtime.close();
});
test('script validates every target before its first effect',async()=>{
 const h=setup(async({script})=>{await script({steps:[send,{...send,key:'wrong',args:{...send.args,recipient:'Bob'}}]});return {status:'completed'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);assert.equal(h.calls.length,0);
 assert.match(h.runtime.tasks.get(id).note,/范围/);
});
test('a task can discover and use an unlisted tool only within its capabilities and target',async()=>{
 let catalog;const h=setup(async({call,availableTools})=>{
  catalog=availableTools;
  await call({tool:'screen.inspect',key:'inspect',args:{application:'wechat',recipient:'Alice'}});
  return {status:'completed'};
 });
 h.tools.register({name:'screen.inspect',description:'inspect allowed target',effect:'read',capabilities:['screen.read'],scope:a=>a,execute:async()=>({ok:true})});
 h.tools.register({name:'private.write',description:'requires another capability',effect:'write',capabilities:['private.write'],execute:async()=>({ok:true,verified:true})});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);const task=h.runtime.tasks.get(id);
 assert.equal(task.status,'completed');assert(catalog.some(item=>item.name==='screen.inspect'));assert(!catalog.some(item=>item.name==='private.write'));
 assert.throws(()=>h.tools.check('screen.inspect',{application:'wechat',recipient:'Bob'},task),/范围/);
 assert.throws(()=>h.tools.check('private.write',{},task),/未授权/);await h.runtime.close();
});
test('unknown write pauses durably and cannot be replayed after restart',async()=>{
 const run=async({call})=>{await call(send);return {status:'completed'};},h=setup(run,{failWrite:true});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);
 assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(id).status,'needs_attention');await h.runtime.close();
 const restored=new AgentRuntime({journal:h.journal,tools:h.tools,skills:h.skills,epoch:()=>1,autoSchedule:false});await restored.restore();
 await restored.tick(id);assert.equal(h.calls.length,1);assert.equal((await restored.control('resume',id)).ok,false);
});
test('incompatible development tasks are ignored on restore rather than replayed',async()=>{
 const h=setup(async()=>({status:'waiting'})),started=await h.runtime.start(spec,owner),old=structuredClone(h.records.get(started.id));
 old.schema='bunny.task/v2';old.status='running';await h.journal.put(old);await h.runtime.close();
 const restored=new AgentRuntime({journal:h.journal,tools:h.tools,skills:h.skills,epoch:()=>1,autoSchedule:false});
 const result=await restored.restore();assert.equal(result.restored,0);assert.equal(restored.tasks.size,0);assert.equal(h.calls.length,0);await restored.close();
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
test('a multi-step goal keeps one durable action identity and links its tool receipts',async()=>{
 let round=0;const h=setup(async({call})=>{if(!round++)return {status:'waiting'};await call(send);return {status:'completed'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.tick(id);const task=h.runtime.tasks.get(id),action=Object.values(task.actionRuns)[0];
 assert.equal(action.status,'waiting');await h.runtime.tick(id);assert.equal(action.status,'completed');
 assert.equal(Object.values(task.operations).find(op=>op.tool==='conversation.send').actionId,action.id);assert.equal(action.attempts,2);await h.runtime.close();
});
test('busy events remain in a durable queue and are consumed once after resuming',async()=>{
 let busy=true;const h=setup(async({event,call})=>{if(!event||busy)return {status:'waiting',consumeEvent:false};await call({...send,key:event.key});return {status:'waiting'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'new-1',text:'hi'});await h.runtime.tick(id);
 assert.equal(h.runtime.tasks.get(id).inbox.length,1);assert.equal(h.calls.length,0);
 await h.runtime.control('pause',id);assert((await h.runtime.enqueue(id,{key:'new-1',text:'hi'})).duplicate);
 busy=false;await h.runtime.control('resume',id);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(id).inbox.length,0);
});
test('different scoped event actions run independently within one task and remain durable',async()=>{
 let enterA,releaseA,enterB;const atA=new Promise(r=>enterA=r),gate=new Promise(r=>releaseA=r),atB=new Promise(r=>enterB=r);
 const h=setup(async({event,signal})=>{
  if(event?.key==='a'){enterA();await gate;assert.equal(signal.aborted,false);}
  if(event?.key==='b')enterB();
  return {status:'waiting'};
 });
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'a',type:'test.event',scope:'alice'});
 const first=h.runtime.tick(id);await atA;await h.runtime.enqueue(id,{key:'b',type:'test.event',scope:'bob'});
 const second=h.runtime.tick(id);await Promise.race([atB,new Promise((_,reject)=>setTimeout(()=>reject(Error('independent action did not start')),500))]);
 await second;assert.equal(h.runtime.tasks.get(id).inbox.some(e=>e.key==='a'),true);
 releaseA();await first;const task=h.runtime.tasks.get(id);
 assert.equal(task.inbox.length,0);assert.equal(Object.values(task.actionRuns).filter(a=>a.status==='completed').length,2);await h.runtime.close();
});
test('a host reconciliation controller is not displaced by another task action',async()=>{
 let started=0;const h=setup(async()=>{started++;return {status:'waiting'};}),{id}=await h.runtime.start(spec,owner),host=new AbortController();
 await h.runtime.enqueue(id,{key:'event',type:'test.event',scope:'alice'});h.runtime.controllers.set(id,host);await h.runtime.tick(id);
 assert.equal(started,0);assert.equal(h.runtime.controllers.get(id),host);h.runtime.controllers.delete(id);await h.runtime.tick(id);assert.equal(started,1);await h.runtime.close();
});
test('same-scoped event actions serialize, while stopping the task cancels its children',async()=>{
 let entered,release;const at=new Promise(r=>entered=r),gate=new Promise(r=>release=r),started=[];
 const h=setup(async({event,signal})=>{started.push(event.key);if(event.key==='a'){entered();await gate;assert(signal.aborted);}return {status:'waiting'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'a',type:'test.event',scope:'alice'});const first=h.runtime.tick(id);await at;
 await h.runtime.enqueue(id,{key:'b',type:'test.event',scope:'alice'});await h.runtime.tick(id);assert.deepEqual(started,['a']);
 assert((await h.runtime.control('stop',id)).ok);release();await first;assert.equal(h.runtime.tasks.get(id).status,'stopped');assert.deepEqual(started,['a']);await h.runtime.close();
});
test('an uncertain write in one event does not cancel a different scoped action',async()=>{
 let entered,release;const at=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const h=setup(async({event,call,signal})=>{
  if(event.key==='a'){entered();await gate;assert.equal(signal.aborted,false);return {status:'waiting'};}
  await call(send);return {status:'waiting'};
 },{failWrite:true});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'a',type:'test.event',scope:'alice'});const first=h.runtime.tick(id);await at;
 await h.runtime.enqueue(id,{key:'b',type:'test.event',scope:'bob'});await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).status,'needs_attention');
 release();await first;const task=h.runtime.tasks.get(id);assert.equal(task.status,'needs_attention');
 assert.equal(Object.values(task.actionRuns).find(a=>a.eventKey==='a').status,'completed');assert.equal(Object.values(task.actionRuns).find(a=>a.eventKey==='b').status,'needs_attention');await h.runtime.close();
});
test('after restart an uncertain action remains blocked while another scope can progress',async()=>{
 const processed=[],h=setup(async({event,call})=>{if(event.key==='a')await call(send);processed.push(event.key);return {status:'waiting'};},{failWrite:true});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'a',type:'test.event',scope:'alice'});await h.runtime.tick(id);
 await h.runtime.enqueue(id,{key:'b',type:'test.event',scope:'bob'});await h.runtime.close();
 const restored=new AgentRuntime({journal:h.journal,tools:h.tools,skills:h.skills,epoch:()=>1,autoSchedule:false});await restored.restore();await restored.tick(id);
 const task=restored.tasks.get(id);assert.deepEqual(processed,['b']);assert.equal(task.status,'needs_attention');
 assert.equal(task.inbox.some(e=>e.key==='a'),true);assert.equal(task.inbox.some(e=>e.key==='b'),false);assert.equal(h.calls.length,1);await restored.close();
});
test('resolving one action permission does not cancel another running action',async()=>{
 let entered,release;const at=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const h=setup(async({event,signal})=>{
  if(event.key==='a'){entered();await gate;assert.equal(signal.aborted,false);return {status:'waiting'};}
  throw Object.assign(Error('permission needed'),{code:'E_PERMISSION_REQUIRED',dispatched:false});
 });
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'a',type:'test.event',scope:'alice'});const first=h.runtime.tick(id);await at;
 await h.runtime.enqueue(id,{key:'b',type:'test.event',scope:'bob'});await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).status,'waiting_permission');
 assert((await h.runtime.control('resume',id)).ok);release();await first;assert.equal(h.runtime.tasks.get(id).inbox.some(e=>e.key==='a'),false);await h.runtime.close();
});
test('resume waits for an aborted worker to settle before starting its replacement',async()=>{
 let entered,release;const at=new Promise(r=>entered=r),gate=new Promise(r=>release=r),starts=[];
 const h=setup(async({event,signal})=>{starts.push(event.key);if(starts.length===1){entered();await gate;assert(signal.aborted);}return {status:'waiting'};});
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'a',type:'test.event',scope:'alice'});const first=h.runtime.tick(id);await at;
 assert((await h.runtime.control('pause',id)).ok);assert((await h.runtime.control('resume',id)).ok);await h.runtime.tick(id);assert.deepEqual(starts,['a']);
 release();await first;await h.runtime.tick(id);assert.deepEqual(starts,['a','a']);await h.runtime.close();
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
test('concurrent admissions retain all requests but only five business tasks can run; freeing a slot never auto-starts',async()=>{
 let ran=0;const h=setup(async()=>{ran++;return {status:'waiting'};});
 const starts=await Promise.all(Array.from({length:8},()=>h.runtime.start({...spec,schedule:{durationMinutes:1}},owner)));
 assert(starts.every(r=>r.ok));assert.deepEqual(h.runtime.capacity(),{limit:5,active:5,queued:3});
 await h.runtime.tick();assert.equal(ran,5);
 const queued=h.runtime.tasks.get(starts[5].id);assert.equal(queued.status,'queued');assert.equal(queued.expiresAt,undefined);
 assert.equal((await h.runtime.control('resume',queued.id)).ok,false);
 await h.runtime.control('stop',starts[0].id);await h.runtime.tick();assert.equal(queued.status,'queued');
 h.advance();assert((await h.runtime.control('resume',queued.id)).ok);assert.equal(queued.expiresAt,121000);assert.equal(h.runtime.capacity().active,5);
 await h.runtime.close();
});
test('restoring preserves manual-start tasks and updates do not accidentally launch a queued task',async()=>{
 const h=setup(async()=>({status:'waiting'}));const starts=await Promise.all(Array.from({length:6},()=>h.runtime.start(spec,owner)));
 const id=starts.at(-1).id;assert((await h.runtime.update(id,{goal:'Revised queued task'},owner)).ok);assert.equal(h.runtime.tasks.get(id).status,'queued');
 await h.runtime.close();const restored=new AgentRuntime({journal:h.journal,tools:h.tools,skills:h.skills,epoch:()=>1,autoSchedule:false});await restored.restore();assert.equal(restored.tasks.get(id).status,'queued');assert.equal(restored.capacity().active,5);await restored.close();
});
test('stop interrupts tools immediately but holds the slot until the external stop is verified',async()=>{
 const h=setup(async()=>({status:'waiting'}));let release,stops=0;const gate=new Promise(r=>release=r);h.runtime.stopTask=async()=>{stops++;await gate;};
 const {id}=await h.runtime.start(spec,owner),stopping=h.runtime.control('stop',id),again=h.runtime.control('stop',id);await new Promise(r=>setImmediate(r));
 assert.equal(h.runtime.tasks.get(id).status,'stopping');assert.equal(h.runtime.capacity().active,1);await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).counters.wakes,0);
 release();assert((await stopping).ok);assert((await again).ok);assert.equal(stops,1);assert.equal(h.runtime.capacity().active,0);
});
test('a failed external stop remains actionable and cannot be presented as stopped',async()=>{
 const h=setup(async()=>({status:'waiting'}));h.runtime.stopTask=async()=>{throw Error('visible stop button unavailable');};const {id}=await h.runtime.start(spec,owner);
 assert.equal((await h.runtime.control('stop',id)).ok,false);assert.equal(h.runtime.tasks.get(id).status,'needs_attention');assert.equal(h.runtime.capacity().active,1);
});
test('an amendment that cannot be persisted leaves the live task and provenance unchanged',async()=>{
 const h=setup(async()=>({status:'waiting'}));const {id}=await h.runtime.start(spec,owner),before=structuredClone(h.runtime.tasks.get(id));
 h.journal.put=async()=>{throw Error('invalid_source');};assert.equal((await h.runtime.update(id,{goal:'new goal'},{...owner,sources:[id,'descendant-report','new-owner-turn'],originSourceId:'new-owner-turn'})).ok,false);assert.deepEqual(h.runtime.tasks.get(id),before);
});
test('model JSON allows an exact fence, rejects duplicate keys and prose, and retries read-only formatting once',async()=>{
 assert.equal(modelJSON('```json\n{"ok":true}\n```').ok,true);
 assert.throws(()=>modelJSON('{"ok":true,"ok":false}'),/重复/);assert.throws(()=>modelJSON('I did it {"ok":true}'));
 let calls=0;const checked=await checkedJSON({messages:[]},v=>{assert.equal(v.ok,true);return v;},{request:async()=>({response:{text:++calls===1?'{"x":.4}':'{"ok":true}'}})});
 assert.equal(checked.attempts,2);assert.equal(calls,2);
});
test('changing only the task cadence does not abort or overwrite an in-flight action',async()=>{
 let entered,release;const at=new Promise(r=>entered=r),gate=new Promise(r=>release=r),h=setup(async({call})=>{await call(send);return {status:'waiting'};});
 const original=h.tools.get('conversation.send');h.tools.tools.set(original.name,{...original,execute:async(...args)=>{entered();await gate;return original.execute(...args);}});
 const {id}=await h.runtime.start(spec,owner),running=h.runtime.tick(id);await at;assert((await h.runtime.update(id,{schedule:{intervalSeconds:5}},owner)).ok);assert.equal(h.runtime.controllers.get(id).signal.aborted,false);release();await running;
 const task=h.runtime.tasks.get(id);assert.equal(task.schedule.intervalSeconds,5);assert.equal(h.calls.length,1);assert.equal(Object.values(task.operations).find(o=>o.tool==='conversation.send').status,'confirmed');await h.runtime.close();
});
test('restart retries only a proven pre-effect automatic reply, while protected drafts remain unresolved',async()=>{
 const h=setup(async()=>({status:'waiting'})),{id}=await h.runtime.start(spec,owner),saved=h.records.get(id);
 saved.status='running';saved.operations={early:{effect:'write',tool:'conversation.send',status:'intent',lifecycle:{policy:'newer-event',phase:'preparing'}}};h.records.set(id,saved);
 const restored=new AgentRuntime({journal:h.journal,tools:h.tools,skills:h.skills,epoch:()=>1,autoSchedule:false});await restored.restore();assert.equal(restored.tasks.get(id).operations.early.status,'not_dispatched');assert.equal(restored.tasks.get(id).status,'waiting');await restored.close();
 saved.operations.early={effect:'write',tool:'conversation.send',status:'intent',lifecycle:{policy:'newer-event',phase:'protected'}};saved.status='running';h.records.set(id,saved);
 const second=new AgentRuntime({journal:h.journal,tools:h.tools,skills:h.skills,epoch:()=>1,autoSchedule:false});await second.restore();assert.equal(second.tasks.get(id).operations.early.status,'intent');assert.equal(second.tasks.get(id).status,'needs_attention');await second.close();await h.runtime.close();
});

test('concurrent action checkpoints persist in invocation order without holding a model or GUI lock',async()=>{
 const h=setup(async()=>({status:'waiting'})),{id}=await h.runtime.start(spec,owner),task=h.runtime.tasks.get(id);
 const writes=[];let release,entered;
 const enteredPromise=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 h.journal.put=async value=>{writes.push(value.state.revision);if(value.state.revision===1){entered();await gate;}h.records.set(id,structuredClone(value));};
 task.state.revision=1;const first=h.runtime.save(task);await enteredPromise;
 task.state.revision=2;const second=h.runtime.save(task);await Promise.resolve();assert.deepEqual(writes,[1]);
 release();await Promise.all([first,second]);assert.deepEqual(writes,[1,2]);assert.equal(h.records.get(id).state.revision,2);await h.runtime.close();
});

test('a repeating action keeps its event and timing while Bunny decides recovery and when owner help is needed',async()=>{
 const h=setup(async({task,event,call})=>{await call({tool:'screen.read',key:'sample:'+task.counters.wakes,args:{}});return {status:'waiting',note:'waiting for conversion',consumeEvent:false,nextCheckAt:1000,state:task.state};});
 const diagnoses=[];h.runtime.diagnoseRepair=async info=>{diagnoses.push(info);return {action:diagnoses.length===1?'reobserve':diagnoses.length===2?'change_method':'ask_owner',nextStep:'核查方法无新证据，需要主人补充信息',source:'llm'};};
 const {id}=await h.runtime.start(spec,owner);await h.runtime.enqueue(id,{key:'one-event',type:'fixture',scope:'one'});
 for(let i=0;i<6;i++){await h.runtime.tick(id);h.advance();}
 const task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0];
 assert.equal(diagnoses.length,3);assert.equal(diagnoses[0].kind,'stall');assert(diagnoses[0].progress.elapsedMs>=120000);assert.equal(task.inbox[0].key,'one-event');
 assert.equal(task.status,'needs_attention');assert.equal(run.recovery.action,'ask_owner');assert.equal(task.state.recoveryGuidance.eventKey,'one-event');assert.match(task.note,/需要主人补充/);assert.equal(run.startedAt,run.createdAt,'retries keep the original start time');
 await h.runtime.close();
});
