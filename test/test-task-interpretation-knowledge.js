'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentLearning}=require('../src/main/agent-learning');
const {AgentInterpreter}=require('../src/main/agent-interpreter');
const {interpretationKnowledge,loadSoftwarePackages}=require('../src/main/software-skill-package');
const example={id:'example',application:'example',version:2,interpretationSections:['Task meaning'],instructions:'# Guide\n\n## Task meaning\n\nDiscuss combines initiating contact and responding to new messages within the assigned goal.\n\n## Execution\n\nSECRET_RUNBOOK_MARKER'};
test('declared meanings reach interpretation before task selection without exposing execution sections or granting capabilities',async()=>{
 const knowledge=await new AgentLearning({packages:[example]}).routingContext({id:'source',goal:'discuss',state:{},scene:'life'});
 assert.equal(knowledge.length,1);assert.equal(knowledge[0].purpose,'task-interpretation-not-authorization');assert(!JSON.stringify(knowledge).includes('SECRET_RUNBOOK_MARKER'));
 let input;const interpreter=new AgentInterpreter({skills:{catalog:()=>[],get:()=>({id:'conversation.manage'})},request:async options=>{input=JSON.parse(options.messages[1].content);return {response:{text:JSON.stringify({kind:'chat',text:'Which contact should I discuss this with?'})}};}});
 await interpreter.interpret('discuss',{operatingKnowledge:knowledge});assert.deepEqual(input.operatingKnowledge,knowledge);assert.equal(input.routingPolicy.defaultApplication,'workbuddy');assert.equal(knowledge[0].capabilities,undefined);
});
test('disabling innate experience also disables interpretation meanings without suppressing learned evidence',async()=>{
 const memory={ready:true,innateExperiences:{enabled:()=>false},experienceRepository:{search:async()=>[{id:'learned',value:{origin:'task-learning',status:'verified',instructions:'Previously confirmed method.'}}]}};
 const knowledge=await new AgentLearning({memory,packages:[example]}).routingContext({id:'source',goal:'discuss',state:{},scene:'life'});
 assert.deepEqual(knowledge.map(k=>k.sourceId),['learned']);
});
test('invalid declarations fail closed and packages without declarations remain compatible',()=>{
 assert.deepEqual(interpretationKnowledge([{...example,interpretationSections:undefined}]),[]);
 for(const interpretationSections of [[],['Missing'],['Task meaning','Task meaning']])assert.throws(()=>interpretationKnowledge([{...example,interpretationSections}]),/任务含义章节/);
 assert.throws(()=>interpretationKnowledge([{...example,instructions:example.instructions+'\n\n## Task meaning\n\nAmbiguous.'}]),/缺失或重复/);
 const declared=interpretationKnowledge(loadSoftwarePackages());assert(declared.some(p=>p.application==='common'));assert(declared.some(p=>p.application==='wechat'));
});
