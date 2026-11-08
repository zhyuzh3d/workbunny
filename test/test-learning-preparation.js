'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentLearning}=require('../src/main/agent-learning');
const {AgentRuntime}=require('../src/main/agent-runtime');
const {AgentService}=require('../src/main/agent-service');
const {TASK_SCHEMA}=require('../src/main/agent-contract');
const task=()=>({schema:TASK_SCHEMA,id:'preparation-task',skill:'software.execute',goal:'offline preparation',subjects:[{application:'demo'}],scene:'life',domain:'life',visibilityFloor:1,privacyEpoch:1,status:'needs_attention',createdAt:1,updatedAt:1,sources:['owner-source','old-evidence'],state:{operatingKnowledge:[{sourceId:'old-evidence',instructions:'old guidance'}],ownerRequest:'full original owner request'},operations:{},actionRuns:{},inbox:[],eventKeys:[],reports:[],counters:{}});
const patch=id=>({state:{useInnateExperience:true,operatingKnowledge:[{sourceId:id,instructions:'new guidance'}],softwarePackages:[]},sourceIds:[id]});
function memoryFixture(){
 const rows=[{id:'new-experience',value:{origin:'bunny',tags:['software:demo'],instructions:'synthetic current guidance',status:'candidate',revision:1}}];
 Object.defineProperty(rows,'availability',{value:{status:'partial',reasonCodes:['missing-source']}});
 return {ready:true,generation:1,innateExperiences:{enabled:()=>true,search:async()=>[]},experienceRepository:{search:async()=>rows}};
}
function harness(learning,{put}={}){
 const records=new Map(),logs=[],value=task(),runtime=new AgentRuntime({journal:{put:put|| (async row=>records.set(row.id,structuredClone(row)))},epoch:()=>1,autoSchedule:false});
 runtime.tasks.set(value.id,value);records.set(value.id,structuredClone(value));learning.rows=async()=>[];
 const service={runtime,learning,memory:learning.memory,emit:()=>{},status:()=>({}),log:(...args)=>logs.push(args)};
 return {service,runtime,value,records,logs,refresh:()=>AgentService.prototype.refreshExperiencePolicy.call(service)};
}
test('preparation has no live Task or catalog side effects; adoption preserves every old source',async()=>{
 const memory=memoryFixture(),learning=new AgentLearning({memory}),value=task(),before=structuredClone(value),inventory=[{id:'catalog'}];learning.inventory=inventory;
 const prepared=await learning.prepare(value);assert.deepEqual(value,before);assert.equal(learning.inventory,inventory);assert.equal(prepared.state.operatingKnowledgeAvailability[0].status,'partial');
 value.sources.push('late-authority');learning.applyPrepared(value,prepared);learning.applyPrepared(value,prepared);
 assert.deepEqual(value.sources,['owner-source','old-evidence','late-authority','new-experience']);assert.equal(value.state.ownerRequest,before.state.ownerRequest);
 let calls=0;memory.experienceRepository.search=async()=>{if(++calls===2)throw Error('synthetic read failure');return [];};const after=structuredClone(value);
 await assert.rejects(learning.prepare(value),/synthetic read failure/);assert.deepEqual(value,after);assert.equal(learning.inventory,inventory);
});
test('a rejected durable preparation leaves both the live Task and old stored version intact; other tasks still refresh',async()=>{
 const learning=new AgentLearning({memory:memoryFixture()}),h=harness(learning),before=structuredClone(h.value),good={...task(),id:'independent-task'};h.runtime.tasks.set(good.id,good);
 h.runtime.journal.put=async row=>{if(row.id===h.value.id)throw Object.assign(Error('synthetic rejected write'),{nativeCode:'invalid_source'});h.records.set(row.id,structuredClone(row));};
 await h.refresh();assert.deepEqual(h.value,before);assert.deepEqual(h.records.get(h.value.id),before);assert(good.sources.includes('new-experience'));assert(h.logs.some(row=>row[1].stage==='restore-experience-policy'));
});
test('slow preparation is discarded after changed goal, owner pause/stop, privacy epoch or newer preparation',async()=>{
 for(const change of ['goal','pause','stop','epoch','newer']){
  let release,entered;const started=new Promise(resolve=>{entered=resolve;}),learning=new AgentLearning({memory:memoryFixture()}),h=harness(learning);let calls=0;
  learning.prepare=async()=>{if(++calls>1)return patch('newer-experience');entered();return new Promise(resolve=>{release=resolve;});};
  const pending=h.refresh();await started;
  if(change==='goal')h.value.goal='new owner goal';
  if(change==='pause'){h.runtime.controlRequests.set(h.value.id,1);h.value.status='paused';}
  if(change==='stop'){h.runtime.controlRequests.set(h.value.id,1);h.value.state.stopRequest={at:2};h.value.status='stopping';}
  if(change==='epoch')h.value.privacyEpoch=2;
  if(change==='newer')await h.refresh();
  release(patch('late-experience'));await pending;
  assert(!h.value.sources.includes('late-experience'),change);assert(!h.records.get(h.value.id).sources.includes('late-experience'),change);
  if(change==='newer')assert(h.value.sources.includes('newer-experience'));
 }
});
test('a stop arriving during a durable write is retained and no prepared patch is adopted late',async()=>{
 let release,entered;const started=new Promise(resolve=>{entered=resolve;}),learning=new AgentLearning({memory:memoryFixture()}),h=harness(learning,{put:async()=>{entered();await new Promise(resolve=>{release=resolve;});}});
 const pending=h.refresh();await started;assert.deepEqual(h.value.sources,['owner-source','old-evidence']);assert.equal(h.value.state.operatingKnowledge[0].sourceId,'old-evidence');h.runtime.controlRequests.set(h.value.id,1);h.value.status='stopping';h.value.state.stopRequest={at:2};release();await pending;
 assert.equal(h.value.status,'stopping');assert.deepEqual(h.value.state.stopRequest,{at:2});assert.deepEqual(h.value.sources,['owner-source','old-evidence']);assert.equal(h.value.state.operatingKnowledge[0].sourceId,'old-evidence');
});
test('native prospective-cycle rejection never pollutes live preparation or deletes old provenance',async t=>{
 const {fixture}=require('./support/experience-fixture.cjs'),{memory}=await fixture(t),{createAgentJournal}=require('../src/main/agent-journal');
 const learning=new AgentLearning({memory}),h=harness(learning),journal=createAgentJournal(memory);h.value.privacyEpoch=memory.generation;h.runtime.epoch=()=>memory.generation;h.runtime.journal=journal;
 await memory.write(['owner-source','old-evidence'].map(id=>({id,kind:'state',ts:1,domain:'life',visibilityFloor:1,value:{sources:[]}})));await journal.put(h.value);
 await memory.write([{id:'derived-proof',kind:'state',ts:2,domain:'life',visibilityFloor:1,value:{sources:[h.value.id]}}]);
 // Deliberately bypass repository filtering to exercise the final native guard.
 learning.prepare=async()=>patch('derived-proof');const before=structuredClone(h.value);await h.refresh();
 assert.deepEqual(h.value,before);const disk=(await memory.db.request('get',{ids:[h.value.id]})).rows.map(row=>memory.decode(row))[0];assert.deepEqual(disk.value.sources,before.sources);
 assert(h.logs.some(row=>row[1].vault?.nativeCode==='invalid_source'));assert.deepEqual((await memory.experienceRepository.get('derived-proof')).value.sources,[h.value.id]);
});
test('initial admission with prepared experience is never published when its first journal write fails',async()=>{
 const {ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills'),tools=new ToolRegistry(),skills=new SkillRegistry(tools).register({id:'test.prepare',version:1,description:'offline',tools:[],capabilities:[],run:async()=>({status:'waiting'})}),learning=new AgentLearning({memory:memoryFixture()});
 const runtime=new AgentRuntime({tools,skills,autoSchedule:false,epoch:()=>1,journal:{put:async()=>{throw Error('synthetic failed initial save');}},prepare:async value=>learning.applyPrepared(value,await learning.prepare(value))});
 const result=await runtime.start({skill:'test.prepare',goal:'offline preparation',subjects:[{application:'demo'}]},{role:'owner',verified:true,sources:['owner-source'],scene:'life'});
 assert.equal(result.ok,false);assert.equal(runtime.tasks.size,0);assert.equal(learning.inventory,undefined);
});
