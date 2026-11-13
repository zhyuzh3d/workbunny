'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {taskSpec}=require('../src/main/agent-contract'),{ToolRegistry}=require('../src/main/agent-tools'),{AgentInterpreter}=require('../src/main/agent-interpreter');
const policy=require('../src/main/interaction-policy');
const spec={skill:'software.execute',goal:'Inspect a synthetic document',subjects:[{application:'safari'}],workRequest:{goal:'Inspect the synthetic document',output:'text'},delivery:{channel:'speech'}};
test('Task method restrictions validate and persist explicitly while unspecified Tasks retain their default methods',()=>{
 assert.deepEqual(taskSpec({...spec,interactionChannels:['visual']}).interactionChannels,['visual']);assert.equal(taskSpec(spec).interactionChannels,undefined);
 for(const channels of [[],['ax'],['visual','visual'],'visual',null,['visual',1]])assert.throws(()=>taskSpec({...spec,interactionChannels:channels}),e=>e.code==='E_INTERACTION_CHANNEL');
 const explicit=taskSpec({...spec,interactionChannels:['terminal','visual']});assert.deepEqual(policy.context({...explicit,state:{}})[0].allowedChannels,['terminal','visual']);assert.deepEqual(policy.context({...taskSpec(spec),state:{}})[0].allowedChannels,policy.CHANNELS);
 assert.deepEqual(policy.context({subjects:[{application:'wechat'}],interactionChannels:['service','visual'],state:{}})[0].allowedChannels,['visual'],'Task methods cannot widen software authorization');
});
test('catalog and direct calls enforce the same owner method restriction before touching a software interface or command',()=>{
 const registry=new ToolRegistry(),names=['screen.observe','screen.action','software.inspect','software.interface','software.control','software.command','software.service','terminal.execute','system.configure','files.inspect','work.submit','memory.find'];let validations=0;
 for(const name of names)registry.register({name,description:name,effect:name==='screen.action'?'write':'read',capabilities:[],scope:a=>a.application?{application:a.application}:undefined,validate:a=>{validations++;return a;},execute:async()=>{throw Error('no actual execution expected');},...(name==='screen.action'?{continuationPolicy:()=>({})}:{})});
 const t={...taskSpec({...spec,interactionChannels:['visual']}),capabilities:[],state:{}};assert.deepEqual(registry.catalog(undefined,t).map(t=>t.name),['screen.observe','screen.action','memory.find']);assert(registry.catalog(undefined,t).find(t=>t.name==='screen.action').effectContinuation);
 for(const name of names.filter(n=>!['screen.observe','screen.action','memory.find'].includes(n)))assert.throws(()=>registry.check(name,{application:'safari'},t),e=>e.code==='E_INTERACTION_CHANNEL'&&e.dispatched===false);assert.equal(validations,0);
 assert.equal(registry.check('screen.observe',{application:'safari'},t).tool.name,'screen.observe');delete t.interactionChannels;assert(registry.catalog(undefined,t).some(t=>t.name==='software.interface'));assert.doesNotThrow(()=>registry.check('software.interface',{application:'safari'},t));
});
test('the normal interpreter emits the structural owner method limit and leaves it absent when no limit was given',async()=>{
 for(const limited of [true,false]){
  let sawPrompt=false;const interpreter=new AgentInterpreter({skills:{catalog:()=>[],get:()=>({id:'software.execute'})},request:async options=>{sawPrompt=options.messages[0].content.includes('task.interactionChannels')&&options.messages[0].content.includes('不得只放在policy文字里');return {response:{text:JSON.stringify({kind:'task',task:{...spec,...(limited?{interactionChannels:['visual']}:{})}})}};}});
  const result=await interpreter.interpret(limited?'只用截图和BOPER，不能命令或脚本，检查合成文档':'检查合成文档');assert(sawPrompt);assert.deepEqual(result.task.interactionChannels,limited?['visual']:undefined);
 }
});
test('the explicit method field survives admission, persistence and an unrelated owner goal update',async t=>{
 const {AgentRuntime}=require('../src/main/agent-runtime'),{SkillRegistry}=require('../src/main/agent-skills'),records=new Map(),tools=new ToolRegistry(),skills=new SkillRegistry(tools).register({id:'software.execute',version:1,description:'synthetic method scope',tools:[],capabilities:[],run:async()=>({status:'waiting'})});
 const runtime=new AgentRuntime({tools,skills,journal:{put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[...records.values()],authorized:async()=>true},ready:()=>true,epoch:()=>1,autoSchedule:false});t.after(()=>runtime.close());const owner={role:'owner',verified:true,sources:['synthetic-owner'],scene:'life'};
 const started=await runtime.start({...spec,interactionChannels:['visual']},owner);assert(started.ok);assert.deepEqual(records.get(started.id).interactionChannels,['visual']);assert((await runtime.update(started.id,{goal:'Updated synthetic document goal'},owner)).ok);assert.deepEqual(runtime.tasks.get(started.id).interactionChannels,['visual']);assert.deepEqual(records.get(started.id).interactionChannels,['visual']);
});
