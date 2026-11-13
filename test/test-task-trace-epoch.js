'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {VaultDB}=require('../src/main/vault-db'),{MemoryService}=require('../src/main/memory-service'),{createAgentJournal}=require('../src/main/agent-journal');
const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
const traces=require('../src/main/task-model-trace'),{checkedJSON}=require('../src/main/agent-json');
test('native trace shrink/eviction preserves epoch, subsequent Task/model checkpoints, and source revocation',async t=>{
 const bin=path.resolve(__dirname,'../bin/vault');
 try{await fs.access(bin);}catch{t.skip('Build the native vault before this offline integration test');return;}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bunny-trace-epoch-')),db=new VaultDB({bin,file:path.join(dir,'synthetic.sqlite3')});
 const initial=await db.init();
 const memory=Object.assign(Object.create(MemoryService.prototype),{db,key:crypto.randomBytes(32),closed:false,ready:true,tail:Promise.resolve(),epoch:initial.epoch,generation:1,scene:()=> 'life'});
 const tools=new ToolRegistry(),skills=new SkillRegistry(tools).register({id:'fixture.route',description:'synthetic routing',version:1,internal:true,tools:[],capabilities:[],run:async ctx=>{
  const result=await checkedJSON({messages:[{role:'user',content:'synthetic task routing fixture'}]},v=>v,{request:async options=>{
   const wire=traces.wire({messages:options.messages,model:'synthetic'}),response={text:'{"adopted":true}'};wire.complete(response);return {response};
  }});assert.equal(result.value.adopted,true);await ctx.checkpoint();return {status:'waiting',nextCheckAt:Date.now()+60000};
 }});
 const runtime=new AgentRuntime({journal:createAgentJournal(memory),tools,skills,epoch:()=>1,autoSchedule:false});
 const recorder=new traces.TaskModelTrace({memory,getScene:()=> 'life',maxEntries:1});runtime.modelTrace=recorder;
 t.after(async()=>{await runtime.close();recorder.closed=true;await memory.tail;await db.close();await fs.rm(dir,{recursive:true,force:true});});
 await memory.serial(()=>memory.write([{id:'synthetic-owner',kind:'message',ts:1,domain:'life',visibilityFloor:1,value:{role:'user',content:'synthetic authorization',sources:[]}}],memory.epoch,{notify:false}));
 const start=await runtime.start({skill:'fixture.route',goal:'synthetic task goal',subjects:[{application:'system'}]},{role:'owner',verified:true,channel:'dialogue',scene:'life',sources:['synthetic-owner']});assert.equal(start.ok,true);
 const scope=runtime.modelTraceScope(runtime.tasks.get(start.id),null);
 const entry={schema:traces.SCHEMA,traceId:'large-fixture',taskId:start.id,scene:'life',visibilityFloor:1,startedAt:Date.now(),assembled:{messages:[{role:'user',content:'synthetic '.repeat(100000)}]},status:'requested',coverage:{assembled:true}};
 recorder.record(entry,scope);await recorder.flush({timeoutMs:10000});assert.equal(recorder.status().gaps.length,0);assert((await db.request('get',{ids:['large-fixture:trace:2']})).rows.length);
 entry.assembled.messages[0].content='small final fixture';recorder.record(entry,scope);await recorder.flush({timeoutMs:10000});assert(memory.epoch>initial.epoch);assert.equal(memory.epoch,(await db.request('stats')).epoch);
 await runtime.tick(start.id);await recorder.flush({timeoutMs:10000});await Promise.allSettled(runtime.pendingSaves.values());
 const task=runtime.tasks.get(start.id);assert.equal(task.counters.wakes,1);assert.equal(task.state.lastFailure,undefined);assert.equal(task.state.storageWait,undefined);assert(Object.values(task.operations).some(op=>op.kind==='model'&&op.status==='confirmed'));
 assert.equal(memory.epoch,(await db.request('stats')).epoch);assert.equal(recorder.status().gaps.filter(g=>g.code==='storage-failed'||g.code==='operation-checkpoint-failed').length,0);
 const raw=await recorder.read({taskId:task.id},{authorize:()=>true,isCurrent:()=>true,scene:'life'});assert.equal(raw.traces.length,1);assert.equal(raw.traces[0].coverage.actualWire,true);assert.equal(raw.traces[0].status,'validated');
 await memory.removeRecord('synthetic-owner');assert.equal(await runtime.journal.authorized(task),false);assert.equal((await db.request('get',{ids:[task.id]})).rows.length,0);assert.equal(memory.epoch,(await db.request('stats')).epoch);
 await assert.rejects(memory.write([{id:'revoked-derived',kind:'state',ts:2,domain:'life',visibilityFloor:1,value:{sources:['synthetic-owner']}}],memory.epoch,{notify:false,strictSources:true}),/来源/);
});
