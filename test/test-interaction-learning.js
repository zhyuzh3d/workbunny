'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./support/experience-fixture.cjs');
const {AgentService}=require('../src/main/agent-service'),{maintain}=require('../src/main/task-experience-maintenance');
const owner={role:'owner',verified:true,channel:'dialogue',sources:['fixture-owner'],scene:'life'};
async function agentFixture(t,{memory,decide,execute}={}){
 const calls=[],provider={id:'demo-approved',application:'demo',methods:['read'],authorize:async({task})=>{calls.push('authorize:'+task.id);},execute:async a=>{calls.push('execute');return execute?execute(a):{ok:true,verified:true,receipt:{observed:'fixture-result',businessResult:true}};}};
 const scene={metrics:{},native:{request:async op=>{throw Error('No OS/app access in this fixture: '+op);}},close:async()=>{}};
 const records=new Map(),journal=memory?undefined:{put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()],authorized:async()=>true};
 const agent=new AgentService({memory,journal,scene,softwareServices:[provider],autoSchedule:false,report:async()=>{},request:async options=>({response:{text:JSON.stringify(await decide(options))}})});t.after(()=>agent.close());return {agent,calls};
}
test('prepared innate and verified historical evidence reaches the first decision before operation; confirmed result returns through existing Dream into the next task',async t=>{
 const {memory,repo}=await fixture(t);memory.maintenance={allowAutomatic:()=>false,request(){},requestExperience(){},cancel(){},close:async()=>{}};
 const origin=await memory.addMessage('user','示例软件检查的既有验证记录。');
 const prior=await repo.put({instructions:'示例软件 demo 的只读状态在已授权固定服务 read 方法可核验；优先采用该经验，版本不符时复核。',tags:['software:demo'],origin:'owner-teaching',status:'validated',feedback:[{outcome:'task-result-confirmed'}]},{scene:'life',sources:[origin.id]});let phase=0,prepared=false,learnedPayload;
 const h=await agentFixture(t,{memory,decide:options=>{
  if(typeof options.messages.at(-1).content==='string'){learnedPayload=JSON.parse(options.messages.at(-1).content);assert.equal(learnedPayload.outcome,'succeeded');assert.equal(learnedPayload.attempts[0].succeeded,true);return {instructions:'demo 当前授权服务 read 已以实际状态回执核对；同类只读检查可优先复用，接口不可用时分析回执再选其他允许方法。'};}
  const input=JSON.parse(options.messages[1].content[0].text);if(phase++===0){assert(input.knowledge.some(k=>k.sourceId===prior.row.id));assert(input.knowledge.some(k=>k.origin==='innate'));assert(input.interactionChannels[0].experienceReferences.some(k=>k.sourceId===prior.row.id));assert.equal(h.calls.length,0);prepared=true;return {done:false,tool:'software.service',args:{application:'demo',service:'demo-approved',method:'read',input:{}}};}
  assert(prepared);assert.equal(input.confirmedEffects[0].receipt.observed,'fixture-result');return {done:true,summary:'实际服务状态已核对。'};
 },execute:async()=>{assert(prepared);return {ok:true,verified:true,receipt:{observed:'fixture-result',businessResult:true}};}});
 const first=await h.agent.start({skill:'software.execute',goal:'核对 demo 的实际状态',subjects:[{application:'demo'}]},{...owner,sources:[origin.id]});assert(first.ok,first.error);await h.agent.runtime.tick(first.id);await h.agent.runtime.tick(first.id);assert.equal(h.agent.runtime.tasks.get(first.id).status,'completed');
 await maintain(h.agent.learning,'dream');assert(learnedPayload);const saved=(await repo.search({query:'software:demo',scene:'life'})).find(r=>r.value.origin==='task-learning');assert(saved);assert(saved.value.sources.includes(first.id));
 const next={id:'future-fixture',skill:'software.execute',goal:'再次核对 demo 状态',scene:'life',visibilityFloor:1,subjects:[{application:'demo'}],state:{},sources:[]};h.agent.learning.applyPrepared(next,await h.agent.learning.prepare(next));assert(next.state.operatingKnowledge.some(k=>k.instructions.includes('实际状态回执')));
});
test('without software experience the model receives allowed alternatives and may choose an appropriate fixed service without automatic probing',async t=>{
 let choices=0;const h=await agentFixture(t,{decide:options=>{const input=JSON.parse(options.messages[1].content[0].text);assert.equal(input.knowledge.length,0);assert.deepEqual(input.interactionChannels[0].allowedChannels,['service','terminal','structured-ui','visual']);choices++;return {done:false,tool:'software.service',args:{application:'demo',service:'demo-approved',method:'read',input:{}}};}});
 const started=await h.agent.start({skill:'software.execute',goal:'按实际能力检查 demo',subjects:[{application:'demo'}]},owner);assert(started.ok,started.error);await h.agent.runtime.tick(started.id);assert.equal(choices,1);assert.equal(h.calls.filter(c=>c==='execute').length,1);
});
test('unknown service effects stop the action instead of silently switching mode, and raw input receipts never become success learning',async t=>{
 let requests=0;const h=await agentFixture(t,{decide:()=>{requests++;return {done:false,tool:'software.service',args:{application:'demo',service:'demo-approved',method:'read',input:{}}};},execute:async()=>{throw Error('transport lost after request');}});
 const started=await h.agent.start({skill:'software.execute',goal:'核对有未知回执的请求',subjects:[{application:'demo'}]},owner);assert(started.ok,started.error);await h.agent.runtime.tick(started.id);assert.equal(h.agent.runtime.tasks.get(started.id).status,'needs_attention');await h.agent.runtime.tick(started.id);assert.equal(requests,1);assert.equal(h.calls.filter(c=>c==='execute').length,1);
 let extracts=0;const learning=new(require('../src/main/agent-learning').AgentLearning)({memory:{ready:true},request:async()=>{extracts++;throw Error('must not learn success');}});await learning.extractRecovery({id:'input-only',status:'completed',scene:'life',visibilityFloor:1,skill:'software.execute',state:{attempts:[{tool:'screen.action',result:{verified:true,receipt:{inputPerformed:true}}}]}});assert.equal(extracts,0);
});
test('the actual generic planner receives scoped innate visual-only experience while the executor rejects other direct modes',async t=>{
 const {memory}=await fixture(t),origin=await memory.addMessage('user','只读观察指定会话。');let saw=false;
 const h=await agentFixture(t,{memory,decide:options=>{const input=JSON.parse(options.messages[1].content[0].text);assert.deepEqual(input.interactionChannels[0].allowedChannels,['visual']);assert(input.knowledge.some(k=>k.tags?.includes('software:wechat')&&/视觉/u.test(k.instructions)));assert(!options.messages[0].content.includes('微信只能外部画面和模拟键鼠'));assert(!input.tools.some(t=>t.name==='software.service'||t.name==='software.command'||t.name==='software.interface'));saw=true;return {done:false,tool:'conversation.observe',args:{application:'wechat',recipient:'Fixture contact'}};}});
 h.agent.scene.observe=async()=>({headerMatched:true,messages:[],draft:''});h.agent.scene.assertTaskIdentity=async()=>{};
 const started=await h.agent.start({skill:'software.execute',goal:'用截图视觉查看指定会话，禁止剪贴板和软件接口',subjects:[{application:'wechat',recipient:'Fixture contact'}]},{...owner,sources:[origin.id]});assert(started.ok,started.error);await h.agent.runtime.tick(started.id);assert(saw);const task=h.agent.runtime.tasks.get(started.id);assert.throws(()=>h.agent.tools.check('software.command',{application:'wechat',command:'/usr/bin/true',args:[],impact:'read',purpose:'forbidden direct route'},task));await h.agent.close();
});
