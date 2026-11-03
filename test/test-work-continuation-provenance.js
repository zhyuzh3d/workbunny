'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {MemoryService}=require('../src/main/memory-service'),{AgentService}=require('../src/main/agent-service'),{createTaskJournal}=require('../src/main/task-journal');
test('continuing a result-derived owner conversation creates an acyclic round receipt in the real encrypted vault',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-continuation-vault-')),key=crypto.randomBytes(32);
 const memory=new MemoryService({dir,bin:path.resolve('bin/vault'),openKey:async()=>Buffer.from(key),getSettings:()=>({enabled:true,extract:false,scene:'life'})});let agent;
 try{
  await memory.init();assert(memory.ready,memory.error);const persist=createTaskJournal(memory);let followed=0;
  const desktop={running:false,task:null,journal(){return persist(this.task);},async followUp(){followed++;this.task.status='monitoring';await this.journal();return {ok:true};}};
  agent=new AgentService({desktop,memory,scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},epoch:()=>memory.generation,ready:()=>true,autoSchedule:false});
  const source=await memory.addMessage('user','制作 Cedar 文件',{scene:'life'}),actor={role:'owner',verified:true,sources:[source.id],scene:'life'};
  const first=await agent.start({skill:'work.delegate',goal:'制作 Cedar 文件',subjects:[{application:'workbuddy'}]},actor);assert(first.ok,first.error);
  const old=agent.runtime.tasks.get(first.id);old.status='completed';old.state.job={jobId:'physical-first',sessionId:'same-session'};old.state.result={summary:'已生成',revision:1,artifacts:[]};await agent.runtime.save(old);
  desktop.task={id:'physical-first',bunnyTaskId:'physical-first',target:'workbuddy',status:'accepted',startedAt:Date.now()-5000,submittedAt:Date.now()-5000,sessionId:'same-session',monitorSessionId:'same-session',handoffSent:true,associationMarker:'[workbunny:physical-first]',outboundText:'old [workbunny:physical-first]',followUpRound:0,steps:[],goal:'制作 Cedar 文件',sources:[old.id],scene:'life',domain:'work',visibilityFloor:1,privacyEpoch:memory.generation};await desktop.journal();
  const report=await memory.addMessage('assistant','Cedar 文件已完成',{sources:['physical-first'],scene:'life'}),nextOwner=await memory.addMessage('user','再加一行',{scene:'life'});
  const next=await agent.start({skill:'work.delegate',goal:'给 Cedar 文件追加一行',subjects:[{application:'workbuddy'}],parameters:{sourceTaskId:old.id}},{...actor,sources:[nextOwner.id,report.id]});assert(next.ok,next.error);await agent.runtime.tick(next.id);
  const task=agent.runtime.tasks.get(next.id);assert.equal(followed,1);assert.equal(task.status,'waiting',task.note);assert.notEqual(task.state.job.jobId,'physical-first');assert.equal(task.state.job.sessionId,'same-session');assert.equal(task.state.resultRevision,2);
  const rows=(await memory.db.request('get',{ids:['physical-first',task.state.job.jobId]})).rows.map(r=>memory.decode(r));
  assert.deepEqual(rows.find(r=>r.id==='physical-first').value.sources,[old.id]);assert.deepEqual(rows.find(r=>r.id===task.state.job.jobId).value.sources,[next.id]);assert.equal(rows.find(r=>r.id===task.state.job.jobId).value.continuationOf.id,'physical-first');
  const updateReport=await memory.addMessage('assistant','继续执行中',{sources:[task.id],scene:'life'}),updateOwner=await memory.addMessage('user','改为每5秒检查',{scene:'life'});
  const amended=await agent.runtime.update(task.id,{schedule:{intervalSeconds:5}},{...actor,sources:[task.id,updateReport.id,updateOwner.id],originSourceId:updateOwner.id});
  assert(amended.ok,amended.error);assert(task.sources.includes(updateOwner.id));assert(!task.sources.includes(updateReport.id));assert(!task.sources.includes(task.id));
  await agent.runtime.save(task);assert(await agent.runtime.journal.authorized(task));
 }finally{await agent?.close();await memory.close();key.fill(0);fs.rmSync(dir,{recursive:true,force:true});}
});
