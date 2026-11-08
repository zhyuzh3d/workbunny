'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
async function fixture(){
 const records=new Map(),tools=new ToolRegistry();let entered,release;
 const atResume=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const skills=new SkillRegistry(tools).register({id:'fixture.task',version:1,description:'fixture',tools:[],capabilities:[],run:async()=>({status:'waiting'}),resume:async()=>{entered();await gate;}});
 const runtime=new AgentRuntime({tools,skills,journal:{put:async task=>records.set(task.id,structuredClone(task)),authorized:async()=>true,list:async()=>[]},autoSchedule:false,epoch:()=>1});
 const started=await runtime.start({skill:'fixture.task',goal:'fixture original task',subjects:[{application:'system'}]},{role:'owner',verified:true,scene:'life',sources:['fixture-owner']});const task=runtime.tasks.get(started.id);task.status='paused';await runtime.save(task);
 return {runtime,task,records,atResume,release};
}
for(const interrupt of ['pause','stop'])test('a late resume hook cannot override a newer '+interrupt,async()=>{
 const h=await fixture();try{const first=h.runtime.control('resume',h.task.id);await h.atResume;const newer=h.runtime.control(interrupt,h.task.id);if(interrupt==='stop')assert.equal((await newer).ok,true,'stop does not wait for the old resume hook');h.release();const old=await first;assert.equal(old.ok,false);assert.equal(old.superseded,true);assert.equal((await newer).ok,true);const current=h.runtime.tasks.get(h.task.id);assert.equal(current.status,interrupt==='stop'?'stopped':'paused');assert.equal(h.records.get(current.id).status,current.status);}finally{h.release();await h.runtime.close();}
});
test('resume preparation cannot commit after any newer explicit task control',async()=>{
 const h=await fixture();try{const revision=h.runtime.controlRevision(h.task.id);assert.equal((await h.runtime.control('pause',h.task.id)).ok,true);const result=await h.runtime.control('resume',h.task.id,{expectedRevision:revision});assert.equal(result.ok,false);assert.equal(result.superseded,true);assert.equal(h.task.status,'paused');const version=h.runtime.controlRevision(h.task.id);assert.equal((await h.runtime.control('status',h.task.id)).ok,true);assert.equal((await h.runtime.control('unsupported',h.task.id)).ok,false);assert.equal(h.runtime.controlRevision(h.task.id),version);}finally{h.release();await h.runtime.close();}
});
