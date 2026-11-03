'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentLearning}=require('../src/main/agent-learning');
test('learned instructions are scoped, versioned and require two verified task proofs without a source cycle',async()=>{
 const records=new Map([['teaching',{id:'teaching',state:'active',value:{}}]]);
 const memory={ready:true,query:async()=>[...records.values()],write:async rows=>{for(const row of rows){for(const id of row.value.sources)assert(records.has(id));records.set(row.id,{...row,state:'active'});}}};
 const learning=new AgentLearning({memory,skills:{get:id=>{assert.equal(id,'conversation.manage');}}});
 const taught=await learning.teach({skill:'conversation.manage',instructions:'Wait at least half a second between logical inputs.'},{task:{id:'teaching',scene:'life',visibilityFloor:1}});
 const task={id:'first',skill:'conversation.manage',scene:'life',visibilityFloor:1,sources:['owner-turn'],state:{},operations:{write:{effect:'write',status:'confirmed',tool:'conversation.send',result:{ok:true,verified:true,receipt:{backend:'CGDisplayStream'}}}}};
 await learning.prepare(task);assert.equal(task.state.operatingKnowledge[0].sourceId,taught.knowledgeId);assert(task.sources.includes(taught.knowledgeId));
 records.set(task.id,{id:task.id,state:'active',value:structuredClone(task)});await learning.completed(task);
 let latest=learning.latest(await learning.rows())[0];assert.equal(latest.value.status,'candidate');assert.deepEqual(latest.value.proofs,['first']);
 const second={...structuredClone(task),id:'second',sources:['owner-turn'],state:{}};await learning.prepare(second);
 assert.equal(second.state.operatingKnowledge[0].sourceId,latest.id);records.set(second.id,{id:second.id,state:'active',value:structuredClone(second)});await learning.completed(second);
 latest=learning.latest(await learning.rows())[0];assert.equal(latest.value.status,'validated');assert.deepEqual(latest.value.proofs,['first','second']);
 await learning.completed(second);assert.equal(learning.latest(await learning.rows())[0].id,latest.id,'same proof is idempotent');
 const other={...structuredClone(task),scene:'work',state:{},sources:['owner-turn']};await learning.prepare(other);assert.equal(other.state.operatingKnowledge.length,0);
 const visit=(id,path=[])=>{assert(!path.includes(id),'source graph must remain acyclic');for(const parent of records.get(id)?.value.sources||[])visit(parent,[...path,id]);};visit(latest.id);
 const before=(await learning.rows()).length;await learning.completed({...task,id:'unverified',operations:{}});assert.equal((await learning.rows()).length,before);
});
test('a failing new method rolls back to earlier verified instructions, while transient waits do not count',async()=>{
 const rows=new Map(),memory={ready:true,query:async()=>[...rows.values()],write:async list=>{for(const r of list)rows.set(r.id,{...r,state:'active'});}};
 const learning=new AgentLearning({memory,skills:{get:()=>({})}}),base={scene:'life',visibilityFloor:1,skill:'software.execute',sources:['owner'],state:{},operations:{}};
 await learning.write({knowledgeId:'method',revision:1,skill:'software.execute',scene:'life',instructions:'verified old method',status:'validated',proofs:['verified-1','verified-2'],sources:['owner']},base);
 await learning.teach({skill:'software.execute',instructions:'new method with regression'},{task:{...base,id:'teaching'}});
 for(const id of ['one','two']){const task={...structuredClone(base),id};await learning.prepare(task);const before=(learning.latest(await learning.rows())[0].value.failedTasks||[]).length;await learning.failed(task,Object.assign(Error('网络超时'),{code:'E_NETWORK'}));assert.equal((learning.latest(await learning.rows())[0].value.failedTasks||[]).length,before);await learning.failed(task,Error('此布局的控件不存在'));}
 const current=learning.latest(await learning.rows())[0].value;assert.equal(current.status,'validated');assert.equal(current.instructions,'verified old method');assert(current.rolledBackFrom);
});
test('a verified recovery extracts candidate knowledge with real task provenance',async()=>{
 const rows=[],memory={ready:true,query:async()=>rows,write:async list=>rows.push(...list.map(r=>({...r,state:'active'})))};
 const learning=new AgentLearning({memory,skills:{get:()=>({})},request:async()=>({response:{text:JSON.stringify({instructions:'工具返回旧定位失效时，重新截图再按新位置操作。'})}})});
 const task={id:'actual-recovery',skill:'software.execute',scene:'life',visibilityFloor:1,goal:'探索新界面',state:{attempts:[{tool:'screen.action',error:'定位失效'},{tool:'screen.action',result:{verified:true}}]},operations:{}};
 await learning.completed(task);assert(task.state.learnedRecovery);assert.equal(rows[0].value.status,'candidate');assert.deepEqual(rows[0].value.sources,['actual-recovery']);
});
