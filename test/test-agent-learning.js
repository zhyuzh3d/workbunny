'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentLearning}=require('../src/main/agent-learning');
const {fixture}=require('./support/experience-fixture.cjs');
async function save(memory,task){await memory.write([{id:task.id,kind:'task',ts:Date.now(),domain:task.scene,visibilityFloor:task.visibilityFloor,value:task}]);}
const task=id=>({id,skill:'software.execute',scene:'life',visibilityFloor:1,goal:'处理微信对话',subjects:[{application:'wechat'}],sources:[],state:{},operations:{}});
test('teaching and runtime experience use the same scoped current-head repository, with no fixed validation votes',async t=>{
 const {memory,repo}=await fixture(t),learning=new AgentLearning({memory,skills:{get:()=>({})}}),source=task('teaching');await save(memory,source);
 const taught=await learning.teach({instructions:'按目标安排检查，必要时重新观察。'},{task:source});const next=task('one');await save(memory,next);learning.applyPrepared(next,await learning.prepare(next));assert(next.sources.includes(taught.knowledgeId));
 await learning.validateUsed(next,[{effect:'write',status:'confirmed',result:{verified:true}}]);await learning.failed(next,Error('此环境定位失效'));
 let rows=await repo.search({query:'software:wechat'});assert.equal(rows.length,1);assert.equal(rows[0].value.status,'candidate');assert.equal(rows[0].value.feedback.length,2);assert.equal(rows[0].value.revision,1,'feedback does not append body revisions');
 learning.applyPrepared(source,await learning.prepare(source));assert.equal(source.state.operatingKnowledge.length,0,'source task does not depend on its own lesson');
 const work={...task('work'),scene:'work',visibilityFloor:0};learning.applyPrepared(work,await learning.prepare(work));assert.equal(work.state.operatingKnowledge.length,0);
});
test('small failures remain evidence for Bunny; repeated errors never trigger automatic quarantine or rollback',async t=>{
 const {memory,repo}=await fixture(t),learning=new AgentLearning({memory,skills:{get:()=>({})}}),teacher=task('teacher');await save(memory,teacher);await learning.teach({instructions:'先观察再调整。'},{task:teacher});
 for(const id of ['first','second','third']){const next=task(id);await save(memory,next);learning.applyPrepared(next,await learning.prepare(next));await learning.failed(next,Error('控件没有出现'));}
 const row=(await repo.search({query:'software:wechat'}))[0];assert.equal(row.value.status,'candidate');assert.equal(row.value.feedback.length,3);
});
test('recovery extraction preserves real task provenance and never treats an input receipt as proof',async t=>{
 const {memory,repo}=await fixture(t),learning=new AgentLearning({memory,skills:{get:()=>({})},request:async()=>({response:{text:JSON.stringify({instructions:'旧定位失效时结合新画面重新选择方法。'})}})}),source=task('recovered');source.state.attempts=[{tool:'screen.action',error:'旧定位失效'},{tool:'screen.action',result:{verified:true}}];await save(memory,source);await learning.extractRecovery(source);
 const row=(await repo.search({query:'software:wechat'}))[0];assert.equal(row.value.origin,'task-learning');assert.deepEqual(row.value.sources,[source.id]);const next=task('reader');learning.applyPrepared(next,await learning.prepare(next));await learning.validateUsed(next,[{effect:'write',status:'confirmed',result:{verified:true,receipt:{inputPerformed:true}}}]);assert.deepEqual((await repo.search({query:'software:wechat'}))[0].value.feedback,[]);
});
test('bundled and learned experience compete in one query, and imported knowledge can be read across task executors',async t=>{
 const {memory}=await fixture(t),learning=new AgentLearning({memory,skills:{get:()=>({})},packages:require('../src/main/software-skill-package').loadSoftwarePackages()}),teacher=task('teacher');await save(memory,teacher);const taught=await learning.teach({instructions:'语音转写需要客观处理时间，依据结果继续。'},{task:teacher});
 const next=task('new');learning.applyPrepared(next,await learning.prepare(next));assert(next.state.operatingKnowledge.some(r=>r.sourceId===taught.knowledgeId));assert(next.state.operatingKnowledge.every(r=>r.sourceId&&!r.packageId));assert.equal(next.state.softwarePackages.length,0);
 const count=(await memory.query('state',80,{requiredMarkers:['bunny_experience_head_experience']})).length;await learning.prepare(task('another'));assert.equal((await memory.query('state',80,{requiredMarkers:['bunny_experience_head_experience']})).length,count,'built-in seeds are idempotent');
});
