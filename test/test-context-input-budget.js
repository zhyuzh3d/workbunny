'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const assembler=require('../src/main/context-assembler'),budget=require('../src/main/context-budget');
const {chatWithSearch}=require('../src/main/conversation-search'),{requestVerification}=require('../src/main/verification-transport');
const {adaptiveSkill}=require('../src/main/adaptive-task'),{ConversationBrain}=require('../src/main/conversation-brain');
const MAX=budget.MAX_INPUT_TOKENS;
test('unconfigured fragments retrieve a small default rather than filling the request ceiling',async()=>{
 let parameters;const result=await assembler.assembleContext({fragments:[{id:'optional',load:async p=>{parameters=p;return ['brief fixture'];}}]});
 assert.equal(parameters.limit,6);assert.equal(parameters.maxTokens,1800);assert.equal(result.metadata.budget,16000);assert.equal(result.metadata.inputBudgetTokens,MAX);assert(result.metadata.estimatedTokens<100);
 const configured=await assembler.assembleContext({configuration:{budget:{inputBudgetTokens:60000,maxTokens:32000},optional:{limit:50,maxTokens:30000}},fragments:[{id:'optional',maxLimit:12,load:async p=>{parameters=p;return ['fixture'];}}]});
 assert.equal(parameters.limit,12);assert.equal(parameters.maxTokens,30000);assert.equal(configured.metadata.budget,32000);assert.equal(configured.metadata.inputBudgetTokens,60000);
 const clamp=await assembler.assembleContext({maxTokens:MAX*2,inputBudgetTokens:MAX*2,fragments:[{id:'optional',load:async()=>[]}]});assert.equal(clamp.metadata.budget,MAX);assert.equal(clamp.metadata.inputBudgetTokens,MAX);
 assert(budget.limits({model:'unknown-fixture',inputBudgetTokens:configured.metadata.inputBudgetTokens,maxTokens:2048}).inputBudget<60000,'the final model gate clamps the requested ceiling');
});
test('task budget adjustments expand and shrink context only, reject no changes and retain task authority',()=>{
 const task={goal:'unchanged goal',capabilities:['read'],operations:{confirmed:{status:'confirmed'}},state:{}};const authority=JSON.stringify({goal:task.goal,capabilities:task.capabilities,operations:task.operations});
 assert.throws(()=>assembler.applyContextAdjustment(task,{fragment:'budget',inputBudgetTokens:MAX}),/没有变化/);
 assembler.applyContextAdjustment(task,{fragment:'budget',inputBudgetTokens:60000,maxTokens:32000});
 assert.deepEqual(task.state.contextTuning.budget,{inputBudgetTokens:60000,maxTokens:32000});
 assembler.applyContextAdjustment(task,{fragment:'budget',inputBudgetTokens:12000,maxTokens:3000});
 assert.throws(()=>assembler.applyContextAdjustment(task,{fragment:'budget',maxTokens:3000}),/没有变化/);
 for(const value of [{fragment:'budget',inputBudgetTokens:MAX+1},{fragment:'budget',maxTokens:511},{fragment:'budget',include:false},{fragment:'core',maxTokens:3000}])assert.throws(()=>assembler.applyContextAdjustment(task,value));
 assert.equal(JSON.stringify({goal:task.goal,capabilities:task.capabilities,operations:task.operations}),authority);
});
test('a conversation can adjust ceilings without loading data and explicitly expand or shrink module retrieval',async()=>{
 const parameters=[];const session=assembler.createContextSession({fragments:[{id:'records',load:async p=>{parameters.push(p);return ['fixture'];}}]});
 const initial=await session.run(assembler.CONTEXT_TOOL,{inputBudgetTokens:60000});assert.equal(initial.assembly.budget,6000);assert.equal(parameters.length,0);
 const same=await session.run(assembler.CONTEXT_TOOL,{inputBudgetTokens:60000});assert.equal(same.rejected,true);assert.equal(same.duplicate,true);assert.equal(parameters.length,0);
 const expanded=await session.run(assembler.CONTEXT_TOOL,{maxTokens:40000,modules:[{id:'records',limit:12,maxTokens:30000}]});assert.equal(expanded.assembly.inputBudgetTokens,60000);assert.equal(parameters[0].maxTokens,30000);assert.equal(parameters[0].limit,12);
 const reduced=await session.run(assembler.CONTEXT_TOOL,{inputBudgetTokens:12000,maxTokens:3000});assert.equal(reduced.assembly.budget,3000);assert.equal(parameters.at(-1).maxTokens,3000);
 await assert.rejects(session.run(assembler.CONTEXT_TOOL,{inputBudgetTokens:MAX+1}));await assert.rejects(session.run(assembler.CONTEXT_TOOL,{modules:[{id:'records',maxTokens:MAX+1}]}));
 const budgetOnly=assembler.createContextSession();assert.equal((await budgetOnly.run(assembler.CONTEXT_TOOL,{inputBudgetTokens:12000})).assembly.inputBudgetTokens,12000);
});
test('context tool budget choices reach the next actual search-loop request and can shrink again',async()=>{
 const session=assembler.createContextSession({fragments:[{id:'unused',load:async()=>{throw Error('must remain lazy');}}]}),seen=[];
 const result=await chatWithSearch({webSearch:false,contextSession:session,inputBudgetTokens:20000,messages:[{role:'user',content:'fixture question'}]},{chat:async o=>{
  seen.push(o.inputBudgetTokens);const n=seen.length;
  if(n<3)return {toolCalls:[{id:'budget-'+n,type:'function',function:{name:assembler.CONTEXT_TOOL,arguments:JSON.stringify({inputBudgetTokens:n===1?60000:12000,maxTokens:n===1?10000:3000})}}]};
  return {text:'fixture final',raw:'fixture final'};
 }});
 assert.deepEqual(seen,[20000,60000,12000]);assert.equal(result.contextAssembly.calls,2);
});
test('adaptive reassembly changes the next request ceiling and explicit content choices survive a legacy compact profile',async()=>{
 const requests=[],decisions=[{done:false,reassemble:{fragment:'budget',inputBudgetTokens:60000,maxTokens:32000}},
  {done:false,reassemble:{fragment:'knowledge',limit:4,maxTokens:6000}},
  {done:false,tool:'fixture.read',args:{}}];let executions=0;
 const skill=adaptiveSkill({id:'fixture',title:'fixture',tools:['fixture.read'],capabilities:[],validate:v=>v,request:async options=>{requests.push(options);return {response:{text:JSON.stringify(decisions[requests.length-1])}};}});
 const task={id:'fixture-task',goal:'preserved goal',criteria:'preserved criteria',policy:'preserved policy',subjects:[],capabilities:[],operations:{confirmed:{id:'prior',tool:'fixture.write',effect:'write',status:'confirmed',result:{receipt:{verified:true}}}},state:{selfRepair:{profile:{contextLevel:2,schemaHint:true,responseLevel:1}},operatingKnowledge:Array.from({length:4},(_,i)=>({sourceId:'experience-'+i,instructions:'fixture experience '+i}))},counters:{wakes:0}};
 const context={task,availableTools:[{name:'fixture.read',capabilities:[]}],checkpoint:async()=>{},clock:()=>1000,call:async()=>{executions++;return {ok:true,verified:true};}};
 await skill.run(context);assert.equal(executions,0);await skill.run(context);assert.equal(executions,0);await skill.run(context);
 assert.equal(requests[0].inputBudgetTokens,MAX);assert.equal(requests[1].inputBudgetTokens,60000);assert.equal(requests[2].inputBudgetTokens,MAX);assert.equal(task.state.contextTuning.budget.inputBudgetTokens,undefined);assert.equal(executions,1);
 const payload=JSON.parse(requests[2].messages.find(m=>m.role==='user').content[0].text);
 assert.equal(payload.goal,'preserved goal');assert.equal(payload.policy,'preserved policy');assert.equal(payload.criteria,'preserved criteria');assert.equal(payload.confirmedEffects[0].operationId,'prior');assert.equal(payload.knowledge.length,4);assert.equal(payload.contextAssembly.selected.find(s=>s.id==='knowledge').parameters.limit,4);assert.equal(payload.contextAssembly.budget,32000);
 assert(requests[2].messages[0].content.includes('schema'));assert.equal(requests[2].maxTokens,2048);assert.equal(task.state.selfRepair.profile.contextLevel,2,'a current choice does not rewrite historical recovery state');
});
test('conversation core sends its assembled ceiling and actual selected count without a second legacy trim',async()=>{
 let request;const brain=new ConversationBrain({request:async options=>{request=options;return {response:{text:JSON.stringify({decision:'reply',reply:'fixture reply',summary:'fixture summary',completed:false,progress:{},unknown:[]})}};}});
 await brain.decide({task:{goal:'preserved owner goal',criteria:'preserved acceptance',policy:'preserved permission',parameters:{behavior:'reply'},state:{selfRepair:{profile:{contextLevel:2,schemaHint:true}},contextTuning:{budget:{inputBudgetTokens:40000,maxTokens:12000},conversation:{limit:8,maxTokens:6000}}}},subject:{application:'wechat',recipient:'fixture person'},conversation:{cursor:{recent:Array.from({length:12},(_,i)=>({direction:'incoming',text:'fixture '+i}))}},incoming:[{kind:'text',text:'actual current fixture message',incomingVerified:true}]});
 const payload=JSON.parse(request.messages.find(m=>m.role==='user').content);
 assert.equal(request.inputBudgetTokens,40000);assert.equal(payload.conversation.length,8);assert.equal(payload.contextAssembly.selected.find(s=>s.id==='conversation').parameters.limit,8);assert.equal(payload.ownerTask.goal,'preserved owner goal');assert.equal(payload.ownerTask.policy,'preserved permission');assert.equal(payload.incoming[0].text,'actual current fixture message');
});
test('verification preserves the requested input ceiling on the primary and read-only fallback',async()=>{
 const calls=[];await requestVerification({inputBudgetTokens:60000,messages:[{role:'user',content:'fixture evidence'}]},{chat:async o=>{calls.push(o);if(calls.length===1)throw Object.assign(Error('fixture cap'),{code:'E_PAYLOAD_TOO_LARGE'});return {model:o.model,text:'fixture'};},selectFree:async()=> 'hy3'});
 assert.deepEqual(calls.map(c=>c.inputBudgetTokens),[60000,60000]);assert.equal(calls[0].messages,calls[1].messages);
});
test('an infeasible conversation reduction or oversized tool result keeps the previous effective ceiling and configuration',async()=>{
 let loads=0,round=0;const seen=[],session=assembler.createContextSession({fragments:[{id:'records',load:async()=>{loads++;return 'x'.repeat(25000);}}]});
 await chatWithSearch({webSearch:false,contextSession:session,inputBudgetTokens:20000,messages:[{role:'user',content:'fixture question'}]},{chat:async o=>{
  seen.push(o.inputBudgetTokens);round++;
  if(round===2||round===3){const error=JSON.parse(o.messages.at(-1).content);assert(error.error.includes('配置未提交'));assert(error.minimumInputBudgetTokens>512);}
  if(round===4){const result=JSON.parse(o.messages.at(-1).content);assert.equal(result.modules.records.length,25000);return {raw:'fixture final',text:'fixture final'};}
  const args=round===1?{inputBudgetTokens:512}:{inputBudgetTokens:round===2?12000:60000,maxTokens:40000,modules:[{id:'records',maxTokens:30000}]};
  return {toolCalls:[{id:'floor-'+round,type:'function',function:{name:assembler.CONTEXT_TOOL,arguments:JSON.stringify(args)}}]};
 }});
 assert.deepEqual(seen,[20000,20000,20000,60000]);assert.equal(loads,2,'a rejected staged retrieval never commits its cache or choices');
});
test('a task cannot commit an infeasible next-request ceiling and consumes a feasible one after its next successful model request',async()=>{
 const seen=[];const skill=adaptiveSkill({id:'fixture',title:'fixture',tools:['fixture.read'],capabilities:[],validate:v=>v,request:async o=>{
  seen.push(o.inputBudgetTokens);const value=seen.length===1?{done:false,reassemble:{fragment:'budget',inputBudgetTokens:512}}:seen.length===2?{done:false,reassemble:{fragment:'budget',inputBudgetTokens:60000}}:{done:false,tool:'fixture.read',args:{}};return {response:{text:JSON.stringify(value)}};
 }});
 const task={id:'fixture-budget-task',goal:'preserved goal',criteria:'actual evidence',policy:'read only',subjects:[],capabilities:[],operations:{},state:{},counters:{wakes:0}},context={task,availableTools:[{name:'fixture.read',capabilities:[]}],checkpoint:async()=>{},clock:()=>1000,call:async()=>({ok:true,verified:true})};
 await skill.run(context);assert.deepEqual(seen,[MAX,MAX]);assert.equal(task.state.contextTuning.budget.inputBudgetTokens,60000);
 await skill.run(context);assert.equal(seen[2],60000);assert.equal(task.state.contextTuning.budget.inputBudgetTokens,undefined);
 await skill.run(context);assert.equal(seen[3],MAX);assert.equal(task.goal,'preserved goal');
});
test('optional emoji experience uses a token-safe prefix rather than a fixed character conversion',()=>{
 const result=assembler.selectExperience([{sourceId:'emoji',instructions:'😀'.repeat(200)}],{maxTokens:100});assert.equal(result.length,1);assert(budget.textTokens(result[0].instructions)<=100);assert.equal(result[0].instructions.includes('\ufffd'),false);
});
