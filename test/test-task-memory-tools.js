'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {MemoryService}=require('../src/main/memory-service');
const {rememberRequest}=require('../src/main/memory-commands');
const {ToolRegistry}=require('../src/main/agent-tools');
const {registerTaskMemoryTools}=require('../src/main/task-memory-tools');

test('task recall finds owner notebook facts and conversation evidence within the active scene',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-task-recall-'));
 const settings={enabled:true,extract:false,scene:'life',recentRounds:8};
 const memory=new MemoryService({dir:path.join(root,'vault'),bin:path.resolve('bin/vault'),openKey:async()=>Buffer.alloc(32,67),getSettings:()=>settings});
 await memory.init();assert(memory.ready,memory.error);
 t.after(async()=>{await memory.close();fs.rmSync(root,{recursive:true,force:true});});
 const source=await memory.addMessage('user','请记住：月桂朋友的生日是九月十日。');
 const saved=await rememberRequest(memory,{action:'remember',content:'月桂朋友的生日是九月十日',quotes:['月桂朋友的生日是九月十日']},{userRecord:source});assert(saved.ok);
 settings.scene='private';await memory.changeScene('private');await memory.addMessage('user','PrivateTaskRecallSentinel');
 settings.scene='life';await memory.changeScene('life');
 const tools=new ToolRegistry();registerTaskMemoryTools(tools,{memory});
 const task={id:'agent-synthetic',skill:'system.operate',scene:'life',state:{},sources:[source.id],capabilities:['memory.read'],subjects:[{application:'system'}]};
 const find=tools.get('memory.find'),read=tools.get('memory.read'),ctx={task,signal:new AbortController().signal};
 await assert.rejects(read.execute({id:saved.id,offset:0},ctx),/先在当前任务/);
 const found=await find.execute(find.validate({query:'月桂 生日'}),ctx);
 const item=found.results.find(row=>row.id===saved.id);assert(item);assert.equal(item.status,'confirmed');
 const original=await read.execute(read.validate({id:item.id}),ctx);assert.match(original.content,/月桂/);assert(task.sources.includes(saved.id));
 const hidden=await find.execute({query:'PrivateTaskRecallSentinel'},ctx);assert.equal(hidden.results.length,0);
 task.state.goalRevision=1;await assert.rejects(read.execute({id:item.id,offset:0},ctx),/重新检索/);
 assert.equal(find.validate({query:'密码是fixture-only-abcd1234'}).query,'密码是fixture-only-abcd1234');
 assert.throws(()=>tools.check('memory.find',{query:'月桂'}, {...task,capabilities:[]}),/未授权/);

 const {AgentService}=require('../src/main/agent-service');let calls=0;
 const agent=new AgentService({memory,ready:()=>true,epoch:()=>memory.generation,autoSchedule:false,
  scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},request:async options=>{
   const input=JSON.parse(options.messages[1].content[0].text);
   assert(input.tools.some(tool=>tool.name==='memory.find'));
   const decision=calls++===0?{done:false,tool:'memory.find',args:{query:'月桂 生日'}}:
    calls===2?{done:false,tool:'memory.read',args:{id:input.attempts.at(-1).result.results.find(row=>row.id===saved.id).id}}:
    {done:true,summary:'已核对主人记下的生日信息。'};
   return {response:{text:JSON.stringify(decision)}};
  }});
 t.after(()=>agent.close());
 const restricted={role:'owner',verified:true,channel:'dialogue',sources:[source.id],scene:'life',capabilities:['terminal.execute','system.configure']};
 const limited=await agent.start({skill:'system.operate',goal:'执行系统检查',subjects:[{application:'system'}]},restricted);assert(limited.ok,limited.error);
 assert(!agent.runtime.tasks.get(limited.id).capabilities.includes('memory.read'));
 const started=await agent.start({skill:'system.operate',goal:'回忆月桂的生日',subjects:[{application:'system'}]}, {...restricted,capabilities:[...restricted.capabilities,'memory.read']});assert(started.ok,started.error);
 for(let i=0;i<3;i++)await agent.runtime.tick(started.id);
 const resolved=agent.runtime.tasks.get(started.id);assert.equal(resolved.status,'completed',JSON.stringify({note:resolved.note,lastFailure:resolved.state.lastFailure,attempts:resolved.state.attempts,calls}));assert(resolved.sources.includes(saved.id));
 assert.match(resolved.state.attempts[1].result.content,/月桂/);
});
