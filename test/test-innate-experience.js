'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./support/experience-fixture.cjs');
const {loadSoftwarePackages}=require('../src/main/software-skill-package');
const {AgentLearning}=require('../src/main/agent-learning');
const {ToolRegistry}=require('../src/main/agent-tools');
test('a fresh vault receives all packaged knowledge before a task, isolated from mutable experience',async t=>{
 const {memory,repo}=await fixture(t),learning=new AgentLearning({memory,packages:loadSoftwarePackages()});
 await learning.seed();const native=await memory.innateExperiences.rows({scene:'life'});
 assert(native.some(r=>r.value.tags.includes('software:wechat')));assert(native.some(r=>r.value.tags.includes('software:workbuddy')));
 assert.equal((await repo.search({limit:80})).length,0);assert(native.every(r=>r.value.origin==='innate'));
 const listed=await memory.list({kind:'knowledge',category:'innate'});assert.equal(listed.rows.length,native.length);assert(listed.rows.every(r=>r.readOnly));
 assert(!(await memory.list({kind:'knowledge',category:'all'})).rows.some(r=>r.origin==='innate'),'the editable/imported collection does not include packaged entries');
 assert(!(await memory.list({kind:'knowledge',category:'experience'})).rows.some(r=>r.origin==='innate'));
 await assert.rejects(memory.remove(native[0].id),/先天经验/);await assert.rejects(memory.updateMemory(native[0].id,'changed'),/先天经验/);
 await learning.seed();assert.deepEqual((await memory.innateExperiences.rows({scene:'life'})).map(r=>r.id),native.map(r=>r.id));
});
test('an upgrade replaces the active innate edition and retains learned knowledge and older provenance',async t=>{
 const {memory,repo}=await fixture(t),packages=loadSoftwarePackages();await memory.innateExperiences.install(packages);
 const original=await memory.innateExperiences.rows({scene:'life'}),learned=await repo.put({instructions:'保留本机习得的替代方法',tags:['software:workbuddy']},{scene:'work'});
 const next=structuredClone(packages);next[0].version++;next[0].instructions+='\n\n## 新版本条件\n按当前版本复查接口。';
 await memory.innateExperiences.install(next);const current=await memory.innateExperiences.rows({scene:'life'});
 assert(current.some(r=>r.value.instructions.includes('新版本条件')));assert(current.some(r=>!original.some(old=>old.id===r.id)));
 const found=(await memory.db.request('get',{ids:[original[0].id]})).rows;assert.equal(found.length,1,'referenced old editions remain as provenance');
 assert.equal((await repo.search({query:'software:workbuddy'}))[0].id,learned.row.id);
});
test('the switch affects retrieval only, and clearing personal memory retains the active innate edition',async t=>{
 const {memory}=await fixture(t),get=memory.getSettings.bind(memory);let enabled=true;
 memory.getSettings=()=>({...get(),useInnateExperience:enabled});await memory.innateExperiences.install(loadSoftwarePackages());
 const before=await memory.innateExperiences.rows({scene:'life'});enabled=false;
 assert.equal((await memory.innateExperiences.search({query:'software:wechat'})).length,0);assert.equal((await memory.innateExperiences.list()).length,before.length);
 await memory.clear();enabled=true;assert.deepEqual((await memory.innateExperiences.rows({scene:'life'})).map(r=>r.id),before.map(r=>r.id));
});
test('an inapplicable innate method gets a learned correction without changing its read-only source',async t=>{
 const {memory,repo}=await fixture(t),learning=new AgentLearning({memory,packages:loadSoftwarePackages()}),tools=new ToolRegistry();
 require('../src/main/agent-learning').registerLearning(tools,{register:()=>{}},learning);await learning.seed();
 const original=(await memory.innateExperiences.search({query:'software:workbuddy'}))[0],before=original.value.instructions;
 const task={id:'method-review-fixture',skill:'software.execute',goal:'检查 WorkBuddy 方法',scene:'life',visibilityFloor:1,subjects:[{application:'workbuddy'}],sources:[],state:{operatingKnowledge:[{sourceId:original.id,origin:'innate',tags:original.value.tags,instructions:before}]},operations:{failure:{tool:'software.control',status:'not_dispatched',finishedAt:Date.now(),error:'本版本控件不支持此动作'}}};
 await memory.write([{id:task.id,kind:'task',ts:Date.now(),domain:'life',visibilityFloor:1,value:task}]);
 const review=tools.get('experience.review');await review.execute({sourceId:original.id,reason:'本版本此控件不支持该动作，需要改用其它已验证通道。',operationIds:['failure']},{task});
 assert(task.state.excludedExperienceIds.includes(original.id));assert.equal((await memory.innateExperiences.search({query:'software:workbuddy'}))[0].value.instructions,before);
 const learned=await repo.search({query:'software:workbuddy'});assert.equal(learned.length,1);assert(learned[0].value.sources.includes(original.id));
 assert.equal(require('../src/main/context-assembler').experienceContext(task).length,0);
 await assert.rejects(review.execute({sourceId:original.id,reason:'not evidenced',operationIds:['foreign']},{task}),/不属于/);
});
