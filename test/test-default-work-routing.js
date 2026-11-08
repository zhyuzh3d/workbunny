'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentLearning}=require('../src/main/agent-learning'),{AgentInterpreter,AGENT_INSTRUCTION}=require('../src/main/agent-interpreter'),{loadSoftwarePackages}=require('../src/main/software-skill-package');
test('default routing includes WorkBuddy web delivery experience, excludes unrelated runbooks, and states authorization exceptions',async()=>{
 const learning=new AgentLearning({packages:loadSoftwarePackages()}),knowledge=await learning.routingContext({id:'task',goal:'做一个网页小游戏',state:{},scene:'life'});
 assert(knowledge.some(k=>k.packageId==='workbuddy'));assert(!knowledge.some(k=>k.packageId==='wechat'));
 const guide=knowledge.find(k=>k.packageId==='workbuddy').instructions;assert.match(guide,/公开(?:网站|网址)/);assert.match(guide,/实际可访问/);
 const full=loadSoftwarePackages().find(p=>p.id==='workbuddy').instructions;for(const condition of ['必要上下文','不发布','权限','本地文件','本机运行'])assert(full.includes(condition));
 let input;const interpreter=new AgentInterpreter({skills:{catalog:()=>[],get:()=>({id:'work.delegate'})},request:async options=>{input=JSON.parse(options.messages[1].content);return {response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:'制作可分享的网页小游戏',subjects:[{application:'workbuddy'}],workRequest:{goal:'制作并发布网页小游戏',criteria:'真实公开链接可访问',output:'files'}}})}};}});
 const result=await interpreter.interpret('做个网页小游戏',{operatingKnowledge:knowledge});assert.equal(result.task.skill,'work.delegate');assert.equal(input.routingPolicy.defaultApplication,'workbuddy');assert.deepEqual(input.operatingKnowledge,knowledge);assert.match(AGENT_INSTRUCTION,/例外不限于主人点名软件/);
});
test('applicable learned evidence remains available for choosing a better method without loading its full bundled guide',async()=>{
 const memory={ready:true,innateExperiences:{enabled:()=>true},experienceRepository:{search:async()=>[{id:'real-method-evidence',value:{origin:'task-learning',status:'verified',tags:['software:system'],instructions:'这个本机只读诊断在当前环境用已验证CLI更直接，保留真实输出。'}}]}};
 const knowledge=await new AgentLearning({memory,packages:loadSoftwarePackages()}).routingContext({id:'task',goal:'诊断本机状态',state:{},scene:'life'});assert(knowledge.some(k=>k.sourceId==='real-method-evidence'));
 const interpreter=new AgentInterpreter({skills:{catalog:()=>[],get:()=>({id:'system.operate'})},request:async options=>{const input=JSON.parse(options.messages[1].content);assert(input.operatingKnowledge.some(k=>k.sourceId==='real-method-evidence'));return {response:{text:JSON.stringify({kind:'task',task:{skill:'system.operate',goal:'诊断本机状态',context:'依据real-method-evidence采用现有CLI',subjects:[{application:'system'}],workRequest:{goal:'读取并核对本机状态',output:'text'},delivery:{channel:'speech'}}})}};}});
 const result=await interpreter.interpret('诊断本机状态',{operatingKnowledge:knowledge});assert.equal(result.task.skill,'system.operate');
});
test('execution preparation excludes other software guides before persisting task knowledge or source scope',async()=>{
 const rows=[{id:'wx-source',value:{origin:'innate',tags:['software:wechat'],instructions:'微信操作'}},{id:'wb-source',value:{origin:'innate',tags:['software:workbuddy'],instructions:'WorkBuddy操作'}}];
 const memory={ready:true,innateExperiences:{enabled:()=>true,search:async()=>rows},experienceRepository:{search:async()=>[]}};
 const learning=new AgentLearning({memory,packages:[]});learning.seed=async()=>{};const task={id:'task',skill:'work.delegate',goal:'制作网页',subjects:[{application:'workbuddy'}],state:{},sources:['owner'],scene:'life'};learning.applyPrepared(task,await learning.prepare(task));
 assert.deepEqual(task.state.operatingKnowledge.map(k=>k.sourceId),['wb-source']);assert(!task.sources.includes('wx-source'));
});
test('an explicit local-only result is preserved and the envelope never injects a public deployment instruction',async()=>{
 const interpreter=new AgentInterpreter({skills:{catalog:()=>[],get:()=>({id:'work.delegate'})},request:async()=>({response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:'只制作本地网页原型，不要发布',subjects:[{application:'workbuddy'}],workRequest:{goal:'只制作本地网页原型，不要发布',criteria:'本地可打开',output:'files'}}})}})});
 const result=await interpreter.interpret('只做本地网页原型，不要发布');const body=require('../src/main/work-order').workMessage({goal:result.task.workRequest.goal,criteria:result.task.workRequest.criteria});assert(body.includes('不要发布'));assert(!body.includes('公开网站'));
});
