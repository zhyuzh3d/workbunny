'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createContextSession,CONTEXT_TOOL}=require('../src/main/context-assembler');
const {chatWithSearch}=require('../src/main/conversation-search');
const configure=(id,modules)=>({id,type:'function',function:{name:CONTEXT_TOOL,arguments:JSON.stringify({modules})}});
test('context modules are lazy, parameterized, replaceable and cannot select undeclared authority',async()=>{
 let loads=0,current=true;
 const session=createContextSession({isCurrent:()=>current,fragments:[{id:'task_status',maxLimit:4,load:async p=>{loads++;return [{query:p.query||'',limit:p.limit,detail:p.detail,state:'actual monitoring fact'}];}}]});
 assert.equal(loads,0);const a=await session.run(CONTEXT_TOOL,{modules:[{id:'task_status',query:'report',limit:2,detail:'summary'}]});assert.equal(loads,1);assert.equal(a.modules.task_status[0].limit,2);
 const same=await session.run(CONTEXT_TOOL,{modules:[{id:'task_status'}]});assert(same.duplicate);assert.equal(loads,1,'same parameters reuse data instead of repeating retrieval');
 const full=await session.run(CONTEXT_TOOL,{modules:[{id:'task_status',detail:'full',limit:50}]});assert.equal(full.modules.task_status[0].limit,4);assert.equal(loads,2);
 const removed=await session.run(CONTEXT_TOOL,{modules:[{id:'task_status',include:false}]});assert.deepEqual(removed.modules,{});
 await assert.rejects(session.run(CONTEXT_TOOL,{modules:[{id:'owner_permissions'}]}),/参数无效/);await assert.rejects(session.run(CONTEXT_TOOL,{modules:[{id:'task_status',maxTokens:999999}]}),/参数无效/);
 current=false;await assert.rejects(session.run(CONTEXT_TOOL,{modules:[{id:'task_status'}]}),{code:'E_ABORTED'});
});
test('multi-round context reassembly changes modules without exposing intermediate output or accumulating old full snapshots',async()=>{
 let rounds=0,taskLoads=0,memoryLoads=0;const visible=[];
 const session=createContextSession({fragments:[{id:'task_status',load:async p=>{taskLoads++;return [{state:p.detail==='full'?'expanded actual result':'brief actual state'}];}},{id:'memory_search',load:async p=>{memoryLoads++;return {query:p.query,matches:['relevant historical evidence']};}}]});
 const result=await chatWithSearch({webSearch:false,contextSession:session,messages:[{role:'user',content:'Compare the task result with my previous request.'}],onDelta:s=>visible.push(s)},{chat:async options=>{
  rounds++;assert.equal(options.onDelta,undefined);
  if(rounds===1)return {toolCalls:[configure('one',[{id:'task_status',detail:'summary'}])]};
  if(rounds===2)return {toolCalls:[configure('two',[{id:'memory_search',query:'previous request'}])]};
  if(rounds===3)return {toolCalls:[configure('three',[{id:'task_status',detail:'full'},{id:'memory_search',include:false}])]};
  const tools=options.messages.filter(m=>m.role==='tool');assert.equal(tools.length,3);assert(tools.slice(0,-1).every(m=>JSON.parse(m.content).superseded));const final=JSON.parse(tools.at(-1).content);assert.equal(final.modules.task_status[0].state,'expanded actual result');assert.equal(final.modules.memory_search,undefined);
  return {text:'Verified final response',raw:'Verified final response'};
 }});
 assert.equal(rounds,4);assert.equal(taskLoads,2);assert.equal(memoryLoads,1);assert.deepEqual(visible,['Verified final response']);assert.equal(result.contextAssembly.calls,3);
});
test('unchanged context requests converge to a final response instead of spending all rounds on the same retrieval',async()=>{
 let rounds=0,loads=0;const session=createContextSession({fragments:[{id:'task_status',load:async()=>{loads++;return ['unchanged'];}}]});
 const result=await chatWithSearch({webSearch:false,contextSession:session,messages:[{role:'user',content:'Progress?'}]},{chat:async o=>{rounds++;const last=o.messages.at(-1);if(last.role==='tool'&&JSON.parse(last.content).duplicate){assert(JSON.parse(last.content).guidance);assert(o.extraBody.tools?.length,'Bunny retains the ability to change parameters');return {raw:'No further progress is visible.',text:'No further progress is visible.'};}return {toolCalls:[configure('r'+rounds,[{id:'task_status'}])]};}});
 assert.equal(loads,1);assert.equal(rounds,3);assert.equal(result.contextAssembly.duplicates,1);
});
test('a permission change while an asynchronous module loads releases no stale module content',async()=>{
 let current=true,release;const session=createContextSession({isCurrent:()=>current,fragments:[{id:'task_status',load:async()=>new Promise(r=>release=r)}]});
 const pending=session.run(CONTEXT_TOOL,{modules:[{id:'task_status'}]});await new Promise(r=>setImmediate(r));current=false;release(['not allowed anymore']);await assert.rejects(pending,{code:'E_ABORTED'});
});
