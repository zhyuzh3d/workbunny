'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const repair=require('../src/main/self-repair'),{AgentRuntime}=require('../src/main/agent-runtime'),{SkillRegistry}=require('../src/main/agent-skills'),{ToolRegistry}=require('../src/main/agent-tools'),{checkedJSON}=require('../src/main/agent-json');
const owner={role:'owner',verified:true,sources:['owner'],scene:'life'};
function harness(run,diagnoseRepair){
 let now=1000;const records=new Map(),tools=new ToolRegistry(),calls=[];
 tools.register({name:'test.write',description:'write',effect:'write',capabilities:['test.write'],scope:a=>a,execute:async(a)=>{calls.push(a);return {ok:true,verified:true};}});
 const skills=new SkillRegistry(tools).register({id:'test.repair',version:1,description:'test',tools:['test.write'],capabilities:['test.write'],run});
 const journal={put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()],authorized:async t=>records.has(t.id)};
 const runtime=new AgentRuntime({journal,tools,skills,clock:()=>now,autoSchedule:false,epoch:()=>1,diagnoseRepair});
 return {runtime,records,calls,journal,tools,skills,advance:()=>{now+=1000;},start:()=>runtime.start({skill:'test.repair',goal:'private goal',subjects:[{application:'system'}]},owner)};
}
test('compaction is request-scoped and retains owner goals, incoming messages, tools, and original data',()=>{
 const original={goal:'must keep',incoming:[{text:'private incoming'}],conversation:Array.from({length:30},(_,i)=>({text:'history '+i})),memories:Array.from({length:8},(_,i)=>({text:'memory '+i})),tools:[{name:'important'}],confirmedEffects:[{id:'receipt'}]};
 const options={messages:[{role:'system',content:'rules'},{role:'user',content:JSON.stringify(original)}]};const result=repair.applyProfile(options,{contextLevel:1,schemaHint:true,maxTokens:8192}),value=JSON.parse(result.messages.at(-1).content);
 assert.equal(value.goal,original.goal);assert.deepEqual(value.incoming,original.incoming);assert.deepEqual(value.tools,original.tools);assert.deepEqual(value.confirmedEffects,original.confirmedEffects);assert.equal(value.conversation.length,10);assert.equal(value.memories.length,4);assert.equal(JSON.parse(options.messages[1].content).conversation.length,30);assert.match(result.messages[0].content,/schema/);assert.equal(result.maxTokens,8192);
});
test('diagnosis gets only minimal metadata and refuses an unapproved action',async()=>{
 let captured;const result=await repair.advise({kind:'context',skill:'test.repair',code:'E_CONTEXT_WINDOW',attempt:1,request:async options=>{captured=options;return {response:{text:'{"action":"execute_shell"}'}};}});
 assert.deepEqual(result,{action:'compact_context',source:'local'});assert(!JSON.stringify(captured.messages).includes('private goal'));assert.equal(captured.messages.length,2);
});
test('a contextual error is diagnosed, tuned, and retried in the original task with its event intact',async()=>{
 let requests=0,advice=[];const h=harness(async({task,call})=>{
  const result=await checkedJSON({repairProfile:task.state.selfRepair?.profile,messages:[{role:'system',content:'rules'},{role:'user',content:JSON.stringify({goal:'private goal',incoming:[{text:'hello'}],conversation:Array.from({length:30},(_,i)=>({text:String(i)}))})}]},v=>v,{request:async options=>{requests++;if(requests===1)throw Object.assign(Error('context too large'),{code:'E_CONTEXT_WINDOW'});assert.equal(JSON.parse(options.messages[1].content).conversation.length,10);return {response:{text:'{"ready":true}'}};}});
  assert(result.value.ready);await call({tool:'test.write',key:'event-send',args:{application:'system'}});return {status:'completed'};
 },async a=>{advice.push(a);return {action:'compact_context',source:'llm'};});
 const {id}=await h.start();await h.runtime.enqueue(id,{key:'message',text:'secret'});await h.runtime.tick(id);const saved=h.records.get(id);assert.equal(saved.inbox.length,1);assert.equal(saved.state.selfRepair.profile.contextLevel,1);assert.equal(saved.state.selfRepair.status,'retrying');assert(!JSON.stringify(advice).includes('secret'));
 await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).status,'completed');assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(id).state.selfRepair.status,'resumed');await h.runtime.close();
});
test('schema diagnosis adds guidance but never relaxes the original validator',async()=>{
 let requests=0,diagnoses=0;const h=harness(async({task})=>{await checkedJSON({repairProfile:task.state.selfRepair?.profile,messages:[{role:'system',content:'rules'},{role:'user',content:'{}'}]},v=>{if(v.allowed!==true||Object.keys(v).length!==1)throw Error('invalid schema');return v;},{request:async options=>{requests++;if(requests<=2)return {response:{text:'{"allowed":false}'}};assert.match(options.messages[0].content,/schema/);return {response:{text:'{"allowed":true}'}};}});return {status:'completed'};},async()=>{diagnoses++;return {action:'repair_schema',source:'llm'};});
 const {id}=await h.start();await h.runtime.tick(id);assert.equal(h.records.get(id).state.selfRepair.profile.schemaHint,true);await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).status,'completed');assert.equal(diagnoses,1);await h.runtime.close();
});
test('unknown writes never trigger autonomous diagnostic replay',async()=>{
 let diagnostics=0;const h=harness(async({call})=>{await call({tool:'test.write',key:'x',args:{application:'system'}});return {status:'completed'};},async()=>{diagnostics++;return {action:'retry'};});
 const original=h.tools.get('test.write');h.tools.tools.set('test.write',{...original,execute:async()=>{throw Error('unknown receipt');}});const {id}=await h.start();await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).status,'needs_attention');assert.equal(diagnostics,0);await h.runtime.tick(id);assert.equal(diagnostics,0);await h.runtime.close();
});
test('diagnostic attempts are bounded and explicit pause cancels a pending repair',async()=>{
 let diagnostics=0;const h=harness(async()=>{throw Object.assign(Error('bad'),{code:'E_CONTEXT_WINDOW'});},async()=>{diagnostics++;return {action:'compact_context',source:'llm'};});const {id}=await h.start();for(let i=0;i<4;i++)await h.runtime.tick(id);assert.equal(diagnostics,2);assert.equal(h.runtime.tasks.get(id).state.selfRepair.attempts,2);await h.runtime.close();
 let entered,release;const at=new Promise(r=>entered=r),gate=new Promise(r=>release=r),h2=harness(async()=>{throw Object.assign(Error('bad'),{code:'E_MODEL_SCHEMA'});},async()=>{entered();await gate;return {action:'repair_schema',source:'llm'};});const started=await h2.start(),tick=h2.runtime.tick(started.id);await at;await h2.runtime.control('pause',started.id);release();await tick;assert.equal(h2.runtime.tasks.get(started.id).status,'paused');assert.equal(h2.runtime.tasks.get(started.id).state.selfRepair.status,'diagnosing');await h2.runtime.close();
});
test('ordinary dialogue applies the same bounded repair without exposing its original message to diagnosis',async()=>{
 const {requestReply}=require('../src/main/reply-request');let calls=0,diagnostic='';const messages=[{role:'system',content:'rules'},{role:'user',content:JSON.stringify({text:'private user message',conversation:Array.from({length:30},(_,i)=>({text:String(i)}))})}];
 const result=await requestReply({selfRepair:true,request:{messages,timeoutMs:55000},chat:async o=>{calls++;if(calls===1)throw Object.assign(Error('too long'),{code:'E_CONTEXT_BUDGET'});if(calls===2){diagnostic=JSON.stringify(o.messages);return {text:'{"action":"compact_context"}'};}assert.equal(JSON.parse(o.messages.at(-1).content.split('\n\n')[0]).conversation.length,10);return {raw:'{"kind":"chat","text":"hello"}'};}});
 assert.equal(result.reply.text,'hello');assert(result.selfRepaired);assert(!diagnostic.includes('private user message'));assert.equal(calls,3);
});
test('schema audit checks structural consistency without mutating or relaxing contracts',()=>{
 const valid={type:'object',properties:{target:{type:'string'}},required:['target'],additionalProperties:false};const broken={type:'object',properties:{target:{type:'string'}},required:['absent']};
 assert.deepEqual(repair.auditSchemas([{inputSchema:valid},{inputSchema:broken}]),{checked:2,issues:1});assert.deepEqual(broken.required,['absent']);
});
test('a confirmed write stays confirmed across a model repair and is never sent twice',async()=>{
 let n=0;const h=harness(async({call})=>{await call({tool:'test.write',key:'stable',args:{application:'system'}});if(!n++)throw Object.assign(Error('context'),{code:'E_CONTEXT_WINDOW'});return {status:'completed'};},async()=>({action:'compact_context',source:'llm'}));
 const {id}=await h.start();await h.runtime.tick(id);assert.equal(h.calls.length,1);await h.runtime.tick(id);assert.equal(h.calls.length,1);assert.equal(h.runtime.tasks.get(id).status,'completed');await h.runtime.close();
});
test('a stuck diagnostic is bounded and falls back without waiting indefinitely',async()=>{
 const start=Date.now(),result=await repair.advise({kind:'output',skill:'test.repair',code:'E_OUTPUT_LIMIT',attempt:1,timeoutMs:25,request:async()=>new Promise(()=>{})});
 assert(Date.now()-start<1000);assert.deepEqual(result,{action:'increase_output',source:'local'});
});
test('context compaction never truncates a task execution context that is not encoded conversation history',()=>{
 const important=JSON.stringify(Array.from({length:12},(_,i)=>({role:'user',content:'requirement '+i}))),source={goal:'actual',context:important,conversation:Array.from({length:20},(_,i)=>({text:String(i)}))};
 const compact=repair.compactValue(source,1);assert.equal(compact.context,important);assert.equal(compact.conversation.length,10);
 const interpretation=repair.compactValue({currentOwnerRequest:'latest',context:important},1);assert.equal(JSON.parse(interpretation.context).length,6);assert.equal(interpretation.currentOwnerRequest,'latest');
});
test('a task update clears the previous repair profile without altering the owner goal',async()=>{
 const h=harness(async()=>({status:'waiting'}),async()=>({action:'retry'})),{id}=await h.start(),task=h.runtime.tasks.get(id);task.state.selfRepair={profile:{contextLevel:2},status:'recovered'};
 assert((await h.runtime.update(id,{goal:'new actual goal'},owner)).ok);assert.equal(task.goal,'new actual goal');assert.equal(task.state.selfRepair,undefined);await h.runtime.close();
});
test('a restored task keeps its repair profile and resumes the same event',async()=>{
 const h=harness(async({task})=>{if(!task.state.selfRepair?.profile?.schemaHint)throw Object.assign(Error('bad model'),{code:'E_MODEL_SCHEMA'});return {status:'completed'};},async()=>({action:'repair_schema',source:'llm'}));const {id}=await h.start();await h.runtime.enqueue(id,{key:'one',text:'hello'});await h.runtime.tick(id);
 const restored=new AgentRuntime({journal:h.journal,tools:h.tools,skills:h.skills,autoSchedule:false,epoch:()=>1,diagnoseRepair:async()=>{throw Error('should not need another diagnostic');}});await restored.restore();assert.equal(restored.tasks.get(id).inbox.length,1);await restored.tick(id);assert.equal(restored.tasks.get(id).status,'completed');await restored.close();await h.runtime.close();
});
test('local budget overflow reduces optional content without shrinking the usable input ceiling',()=>{
 const local=repair.applyAction({},'compact_context',{code:'E_CONTEXT_BUDGET'}),remote=repair.applyAction({},'compact_context',{code:'E_CONTEXT_WINDOW'});
 assert.equal(local.contextLevel,1);assert.equal(local.budgetScale,undefined);assert.equal(remote.budgetScale,.5);
});

test('broker response caps shrink the request while output truncation can expand it',()=>{
 assert.equal(repair.category({code:'E_PAYLOAD_TOO_LARGE'}),'response');assert.equal(repair.category({code:'E_OUTPUT_LIMIT'}),'output');
 const messages=[{role:'user',content:JSON.stringify({goal:'keep goal',tools:[{name:'keep tool'}],confirmedEffects:[{id:'keep receipt'}]})}],options={messages,thinking:'high',maxTokens:8192};
 const compact=repair.applyProfile(options,repair.applyAction({},'compact_response'));assert.equal(compact.thinking,'low');assert.equal(compact.maxTokens,2048);assert.equal(compact.budgetScale,.5);assert.deepEqual(compact.messages,messages);
 assert.equal(repair.applyProfile(options,repair.applyAction({},'increase_output')).maxTokens,8192);
});
