'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture({correctFile=false,gate,limited=false,unknown=false}={}){
 const records=new Map(),calls=[],requests=[],tools=new ToolRegistry();let baseRuns=0,reviews=0;
 tools.register({name:'fixture.write',description:'Write the authorized fixture artifact',effect:'write',capabilities:['fixture.write'],execute:async args=>{calls.push({tool:'write',value:args.value});return {ok:true,verified:true,receipt:{value:args.value}};}});
 tools.register({name:'fixture.inspect',description:'Inspect the current fixture result',effect:'read',capabilities:['fixture.read'],execute:async()=>{calls.push({tool:'read'});return {available:true,verified:true,frameId:'fresh-fixture',value:'current result'};}});
 const skill={id:'fixture.passive',version:1,description:'Wait for one fixture event, process it and finish',tools:['fixture.write','fixture.inspect'],capabilities:['fixture.write'],optionalCapabilities:['fixture.read'],run:async ctx=>{baseRuns++;if(!ctx.event)return {status:'waiting'};await ctx.call({tool:'fixture.write',key:'original-effect',args:{value:'initial'}});return {status:'completed',note:'Initial result'};}};
 const request=async options=>{const input=JSON.parse(options.messages[1].content[0].text);requests.push(input);if(gate){gate.entered.resolve();await gate.answer.promise;}return {response:{text:JSON.stringify(input.action?{done:true,taskDone:true,summary:'Actual remediation satisfies the original goal'}:{done:false,actions:[{key:'remediate',goal:'Check and correct the actual result within the original scope',criteria:'Current facts satisfy the original fixture goal',operations:[{key:'real-step',tool:correctFile||unknown?'fixture.write':'fixture.inspect',args:correctFile||unknown?{value:'corrected'}:{}}]}]})}};};
 const runtime=new AgentRuntime({journal:{put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[],authorized:async()=>true},tools,skills:new SkillRegistry(tools).register(skill),request,autoSchedule:false,epoch:()=>1,reviewTask:async()=>++reviews===1?{type:'continue',rationaleSummary:'Resolve the remaining uncertainty using current facts',sourceRefs:[],guidance:{verificationIdeas:['Inspect the actual result and correct it if necessary']}}:{type:'accept',rationaleSummary:'Current evidence satisfies the original goal',sourceRefs:[],guidance:{}}});
 const start=async()=>{const result=await runtime.start({skill:skill.id,goal:'Process one event into a correct fixture result',subjects:[{application:'system'}],completion:'first_match'},{role:'owner',verified:true,scene:'life',sources:['synthetic-owner'],...(limited?{capabilities:['fixture.write']}:{})});await runtime.tick(result.id);await runtime.enqueue(result.id,{key:'event',type:'fixture.event'});await runtime.tick(result.id);await runtime.tick();await flush();return result.id;};
 return {runtime,calls,requests,start,baseRuns:()=>baseRuns};
}
test('a returned passive Task with no pending event runs active remediation Actions in the existing runtime',async t=>{
 const f=fixture();t.after(()=>f.runtime.close());const id=await f.start(),task=f.runtime.tasks.get(id),authority=structuredClone(task.authority);assert.equal(task.inbox.length,0);assert.equal(task.state.completionProposal.status,'returned');
 await f.runtime.tick(id);assert(Object.values(task.actionRuns).some(run=>run.goalAction&&!run.subscription&&run.status==='waiting'));assert.equal(f.requests.length,1);assert.equal(f.baseRuns(),2);
 await f.runtime.tick(id);assert.deepEqual(f.calls.map(call=>call.tool),['write','read']);assert.equal(task.state.completionProposal.status,'pending');await f.runtime.tick();await flush();assert.equal(task.status,'completed');assert.deepEqual(task.authority,authority);assert.equal(f.runtime.tasks.size,1);assert.equal(f.baseRuns(),2);
});
test('generic remediation keeps a legitimate corrected artifact write instead of forcing every Task read-only',async t=>{
 const f=fixture({correctFile:true});t.after(()=>f.runtime.close());const id=await f.start();await f.runtime.tick(id);await f.runtime.tick(id);assert.deepEqual(f.calls,[{tool:'write',value:'initial'},{tool:'write',value:'corrected'}]);assert.equal(Object.values(f.runtime.tasks.get(id).operations).filter(op=>op.effect==='write'&&op.status==='confirmed').length,2);
});
test('remediation does not expand authority or bypass an unknown existing effect',async t=>{
 for(const options of [{limited:true},{unknown:true}]){
  const f=fixture(options);t.after(()=>f.runtime.close());const id=await f.start(),task=f.runtime.tasks.get(id),capabilities=[...task.capabilities];
  if(options.unknown)task.operations.unknown={id:'unknown',tool:'fixture.write',effect:'write',status:'intent',key:'unknown-original'};
  await f.runtime.tick(id);assert.deepEqual(task.capabilities,capabilities);assert.equal(f.calls.length,1);if(options.unknown)assert.equal(task.operations.unknown.status,'intent');assert.notEqual(task.status,'completed');
 }
});
test('owner stop during universal remediation rejects a late plan without retiring the original receipt',async t=>{
 const gate={entered:Promise.withResolvers(),answer:Promise.withResolvers()},f=fixture({gate});t.after(()=>f.runtime.close());const id=await f.start(),pending=f.runtime.tick(id);await gate.entered.promise;await f.runtime.control('stop',id);gate.answer.resolve();await pending;const task=f.runtime.tasks.get(id);assert.equal(task.status,'stopped');assert.equal(f.calls.length,1);assert(Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='confirmed'));
});
