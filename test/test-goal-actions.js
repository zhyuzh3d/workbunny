'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
const {adaptiveSkill}=require('../src/main/adaptive-task');
const goal=require('../src/main/goal-actions');
async function fixture(decide,{input,observe,initialObservation,skill='software.execute'}={}){
 const records=new Map(),calls=[],requests=[];let now=100000;
 const tools=new ToolRegistry();
 for(const [name,effect,caps] of [['demo.observe','read',['screen.read']],['demo.semantic','read',[]],['demo.input','write',['screen.input']],['demo.alternate','read',[]]])tools.register({name,description:name,effect,capabilities:caps,execute:async(args,ctx)=>{calls.push({name,args,actionId:ctx.task.operations[ctx.operationId].actionId});if(name==='demo.input'&&input)return input(args,ctx);if(name==='demo.observe'&&observe)return observe(args,ctx);return {ok:true,verified:true,changed:false,value:name==='demo.semantic'?'fresh-label':'observed',frameId:'frame-'+calls.length};}});
 const request=async options=>{const parts=options.messages.at(-1).content,payload=JSON.parse(typeof parts==='string'?parts:parts[0].text);requests.push({payload,options});return {response:{text:JSON.stringify(await decide(payload,requests.length-1,options))}};};
 for(const name of ['result.deliver','result.attach'])tools.register({name,description:name,effect:'write',capabilities:[],execute:async()=>({ok:true,verified:true})});
 const skills=new SkillRegistry(tools).register(goal.withGoalActions(adaptiveSkill({id:skill,title:'synthetic goal',description:'synthetic general task',tools:[...tools.tools.keys()],capabilities:['screen.read','screen.input'],request,goalActions:false}),{request,initialObservation}));
 // Result delivery tools are not used by these bounded synthetic runs.
 const runtime=new AgentRuntime({journal:{put:async t=>records.set(t.id,structuredClone(t)),authorized:async()=>true,list:async()=>[...records.values()]},tools,skills,clock:()=>now,epoch:()=>1,autoSchedule:false});
 const start=await runtime.start({skill,goal:'Inspect the board and reach the requested state',criteria:'Verify the resulting state',subjects:[{application:'system'}]},{role:'owner',verified:true,sources:['synthetic'],scene:'life'});
 assert(start.ok,start.error);return {runtime,id:start.id,task:runtime.tasks.get(start.id),records,calls,requests,advance:ms=>now+=ms};
}
test('LLM creates multiple explicit Actions and a later strategy changes actual tools on the same Task',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'inspect',goal:'Find current board state',criteria:'Fresh state available',operations:[{key:'read',tool:'demo.observe',args:{}}]},{key:'correct',goal:'Reach desired state',criteria:'Observe desired state',after:{actionKey:'inspect',operationKey:'read',path:'changed',equals:false}}]}:i===1?{done:true,summary:'Fresh state observed'}:i===2?{done:false,steps:[{key:'meaning',tool:'demo.semantic',args:{}},{key:'change',tool:'demo.input',args:{label:{$result:'meaning.value'}}}]}:{done:true,summary:'Desired state verified'});
 t.after(()=>f.runtime.close());await f.runtime.tick(f.id);const actions=Object.values(f.task.actionRuns).filter(a=>a.goalAction);assert.equal(actions.length,2);assert(actions.every(a=>a.goal&&a.criteria));assert.equal(f.requests[0].options.maxTokens,8192,'initial Goal planning uses the supported output budget without first exhausting 2048');
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.deepEqual(f.calls.map(c=>c.name),['demo.observe','demo.semantic','demo.input']);assert.equal(f.calls.at(-1).args.label,'fresh-label');assert.equal(f.runtime.tasks.size,1);assert.notEqual(f.calls[0].actionId,f.calls[1].actionId);
});
test('persistent readonly timers skip missed ticks without model calls and route changed results to a semantic Action',async t=>{
 let changed=false;
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'watch',goal:'Watch board changes',criteria:'Latest sample recorded',operations:[{key:'pixels',tool:'demo.observe',args:{}}],schedule:{at:100000,intervalSeconds:2}},{key:'understand',goal:'Understand new board state',criteria:'Meaning checked',after:{actionKey:'watch',operationKey:'pixels',path:'changed',equals:true}}]}:{done:false,tool:'demo.semantic',args:{}},{observe:async()=>({ok:true,changed})});
 t.after(()=>f.runtime.close());await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.requests.length,1);assert.equal(f.calls.length,1);f.advance(20000);await f.runtime.tick(f.id);assert.equal(f.calls.length,2);assert.equal(f.requests.length,1);
 const timer=Object.values(f.task.actionRuns).find(a=>a.key==='watch');assert.equal(timer.cycle,2);assert.equal(timer.schedule.at,122000);
 changed=true;f.advance(2000);await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.requests.length,2);assert.equal(f.calls.at(-1).name,'demo.semantic');assert.equal(f.requests.at(-1).payload.action.trigger.results.pixels.changed,true);
 const saved=f.records.get(f.id);await f.runtime.close();assert(saved.actionRuns[timer.id].schedule.at>122000);assert.equal(saved.actionRuns[timer.id].cycle,3);
});
test('a real input uncertainty is not replayed and migration preserves its Task, original goal and receipt',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'change',goal:'Change board state',criteria:'New state verified',operations:[{key:'input',tool:'demo.input',args:{}}]}]}:{done:false,actions:[{key:'reconcile',goal:'Read current state without replay',criteria:'Current state understood',operations:[{key:'read',tool:'demo.observe',args:{}}]}]},{input:async()=>{throw Object.assign(Error('synthetic unknown'),{code:'E_SUBMISSION_UNCERTAIN',dispatched:true,inputOutcome:{dispatched:true,completion:'unknown',reportsSubmitted:3}});}});
 t.after(()=>f.runtime.close());await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.task.status,'needs_attention');const prior=Object.values(f.task.operations).find(o=>o.tool==='demo.input');assert.equal(prior.status,'intent');
 assert((await f.runtime.control('pause',f.id)).ok);assert((await f.runtime.upgradeGoal(f.id)).ok);assert.equal(f.task.operations[prior.id].inputOutcome.reportsSubmitted,3);assert.equal(f.task.goal,'Inspect the board and reach the requested state');assert((await f.runtime.control('resume',f.id)).ok);
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.calls.filter(c=>c.name==='demo.input').length,1);assert(f.calls.some(c=>c.name==='demo.observe'));assert.equal(f.task.operations[prior.id].status,'intent');assert.equal(f.runtime.tasks.size,1);
});
function pendingEffect(f){
 const task=f.runtime.tasks.get(f.id);task.operations['prior-input']={id:'prior-input',key:'prior-input',tool:'demo.input',effect:'write',status:'intent',at:90000,inputOutcome:{dispatched:true,dispatchOutcomeUnknown:true,reportsSubmitted:3,completion:'unknown'}};task.status='needs_attention';
 return task;
}
async function confirmPending(f){
 assert((await f.runtime.confirmReconciled(f.id,'prior-input',{ok:true,verified:true,receipt:{source:'fresh-observation',reviewed:true}})).ok);
 assert((await f.runtime.control('resume',f.id)).ok);
}
test('a real multi-Operation Action reads its prefix under an old unknown and dispatches its new write only after reconciliation',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'recover',goal:'Observe then correct the board',criteria:'Requested result visible',operations:[{key:'read',tool:'demo.observe',args:{}},{key:'new-input',tool:'demo.input',args:{}}]}]}:{done:true,summary:'Requested state reached'});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);const task=pendingEffect(f),run=Object.values(task.actionRuns).find(a=>a.key==='recover');
 await f.runtime.tick(f.id);
 assert.deepEqual(f.calls.map(c=>c.name),['demo.observe']);assert.equal(run.operationIndex,1);assert(run.results.read.frameId);assert.equal(task.operations['prior-input'].status,'intent');assert.equal(task.operations['prior-input'].inputOutcome.reportsSubmitted,3);
 assert(!Object.values(task.operations).some(o=>o.actionId===run.id&&o.effect==='write'),'the new write never reached the ledger or tool');
 await confirmPending(f);await f.runtime.tick(f.id);
 assert.deepEqual(f.calls.map(c=>c.name),['demo.observe','demo.input']);const prior=f.runtime.tasks.get(f.id).operations['prior-input'];assert.equal(prior.status,'confirmed');assert.equal(prior.inputOutcome.completion,'unknown');assert.equal(prior.inputOutcome.reportsSubmitted,3,'business reconciliation preserves the original native uncertainty');assert.equal(run.operationIndex,2);assert.equal(f.calls.filter(c=>c.name==='demo.observe').length,1,'completed read prefix is not replayed');
});
test('completed writes and queued future writes do not block the current persisted adaptive read decision',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'recover',goal:'Correct and observe the board',criteria:'Requested result visible',operations:[{key:'past-input',tool:'demo.input',args:{}}]}]}:{done:true,summary:'Initial correction completed'});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.deepEqual(f.calls.map(c=>c.name),['demo.input']);
 const task=pendingEffect(f),run=Object.values(task.actionRuns).find(a=>a.key==='recover');run.status='waiting';task.state.goalPlan.needsPlanning=false;run.execution={pendingDecision:{key:'current-read',tool:'demo.observe',args:{}}};
 assert.equal(run.operationIndex,1);await f.runtime.tick(f.id);assert.deepEqual(f.calls.map(c=>c.name),['demo.input','demo.observe']);assert(run.results['current-read'].frameId);
 // Resume from a persisted batch checkpoint whose read is complete and whose
 // next step has not yet been dispatched. Do not re-run any past write.
 run.execution.pendingSteps=[{key:'future-input',tool:'demo.input',args:{}}];task.status='needs_attention';const requests=f.requests.length;await f.runtime.tick(f.id);assert.equal(f.requests.length,requests);assert.equal(f.calls.length,2,'the queued write cannot pass the unknown-effect barrier');
 await confirmPending(f);await f.runtime.tick(f.id);assert.deepEqual(f.calls.map(c=>c.name),['demo.input','demo.observe','demo.input']);assert.equal(run.operationIndex,1,'the already completed explicit write is never replayed');
});
test('owner pause retires an in-flight read prefix and prevents its queued write and late continuation',async t=>{
 let entered,release;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const f=await fixture(()=>({done:false,actions:[{key:'recover',goal:'Observe then correct',criteria:'Requested result visible',operations:[{key:'read',tool:'demo.observe',args:{}},{key:'input',tool:'demo.input',args:{}}]}]}),{observe:async()=>{entered();await gate;return {ok:true,frameId:'late-frame'};}});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);pendingEffect(f);const running=f.runtime.tick(f.id);await began;
 assert((await f.runtime.control('pause',f.id)).ok);release();await running;await f.runtime.tick(f.id);
 const task=f.runtime.tasks.get(f.id);assert.equal(task.status,'paused');assert.deepEqual(f.calls.map(c=>c.name),['demo.observe']);assert.equal(task.operations['prior-input'].status,'intent');assert.equal(task.operations['prior-input'].inputOutcome.reportsSubmitted,3);assert.equal(f.requests.length,1);
});
test('pause and goal revision seal a late plan and scheduled callbacks',async t=>{
 let entered,release;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const f=await fixture(async()=>{entered();await gate;return {done:false,actions:[{key:'late',goal:'Late work',criteria:'Never execute',operations:[{key:'write',tool:'demo.input',args:{}}]}]};});t.after(()=>f.runtime.close());
 const work=f.runtime.tick(f.id);await started;await f.runtime.control('pause',f.id);release();await work;assert.equal(f.calls.length,0);assert.equal(f.runtime.tasks.get(f.id).status,'paused');assert(!Object.values(f.task.actionRuns).some(a=>a.key==='late'));
 f.task.state.goalRevision=1;assert.equal(goal.selected(f.task,100000).phase,'goal.plan:1');
});
test('repeat plans reject operations that can input and unsafe result references',()=>{
 const ctx={task:{actionRuns:{}},availableTools:[{name:'demo.open',effect:'read',capabilities:['screen.input']}],validateCall(){}};
 assert.throws(()=>goal.validatePlan({done:false,actions:[{key:'watch',goal:'Watch',criteria:'Observe',operations:[{tool:'demo.open',args:{}}],schedule:{at:1000,intervalSeconds:1}}]},ctx),/只读/);
 assert.throws(()=>goal.resolveArgs({label:{$result:'read.__proto__.value'}},{read:{}}),/路径/);
});
test('the same conditional Action rearms once for each new changed revision and stays quiet on unchanged pixels',async t=>{
 let changed=true;
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'watch',goal:'Watch changes',criteria:'Latest pixels recorded',operations:[{key:'sample',tool:'demo.observe',args:{}}],schedule:{at:100000,intervalSeconds:1}},{key:'react',goal:'Understand each change',criteria:'Change interpreted',after:{actionKey:'watch',operationKey:'sample',path:'changed',equals:true}}]}:i%2?{done:false,steps:[{key:'meaning',tool:'demo.semantic',args:{}}]}:{done:true,summary:'Change understood'},{observe:async()=>({changed,frameId:'synthetic-pixels'})});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.calls.filter(c=>c.name==='demo.semantic').length,1);
 changed=false;f.advance(1000);await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.requests.length,3);
 changed=true;f.advance(1000);await f.runtime.tick(f.id);await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.calls.filter(c=>c.name==='demo.semantic').length,2);assert.equal(f.requests.length,5);
 const callback=Object.values(f.task.actionRuns).find(a=>a.key==='react');assert.equal(callback.status,'waiting');assert.equal(callback.consumedRevision,3);assert.equal(callback.cycle,2);
});
test('a readonly timed Action runs while an independent GUI input waits and owner pause seals both lifecycles',async t=>{
 let entered,release;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const f=await fixture(()=>({done:false,actions:[{key:'change',goal:'Change board',criteria:'State verified',operations:[{key:'input',tool:'demo.input',args:{}}]},{key:'watch',goal:'Keep sensing',criteria:'Fresh pixels',operations:[{key:'sample',tool:'demo.observe',args:{}}],schedule:{at:100000,intervalSeconds:1}}]}),{input:async()=>{entered();await gate;return {ok:true,verified:true};}});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);const pending=f.runtime.tick(f.id);await started;await f.runtime.tick(f.id);assert.equal(f.calls.filter(c=>c.name==='demo.observe').length,1);assert.equal(f.requests.length,1);
 await f.runtime.control('pause',f.id);release();await pending;f.advance(10000);await f.runtime.tick(f.id);assert.equal(f.calls.filter(c=>c.name==='demo.observe').length,1);assert.equal(f.runtime.tasks.get(f.id).status,'paused');
});
test('changed pixels reach the next semantic Action as an image and are not copied into Action result JSON',async t=>{
 const preview='data:image/png;base64,c3ludGhldGlj';
 const f=await fixture((p,i,options)=>i===0?{done:false,actions:[{key:'sense',goal:'Observe board',criteria:'New frame',operations:[{key:'pixels',tool:'demo.observe',args:{}}]},{key:'understand',goal:'Read changed region',criteria:'Meaning checked',after:{actionKey:'sense',operationKey:'pixels',path:'changed',equals:true}}]}:i===1?{done:true,summary:'Frame observed'}:(assert(options.messages[1].content.some(part=>part.type==='image_url')),assert(!options.messages[1].content[0].text.includes('c3ludGhldGlj')),{done:false,tool:'demo.semantic',args:{}}),{observe:async()=>({changed:true,frameId:'synthetic-frame',preview,width:10,height:10,at:100000})});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);await f.runtime.tick(f.id);const sensing=Object.values(f.task.actionRuns).find(a=>a.key==='sense');assert.equal(sensing.results.pixels.preview,undefined);assert.equal(f.task.state.latestImage.preview,preview);assert.equal(f.calls.at(-1).name,'demo.semantic');
});
test('fresh read evidence releases only a navigation barrier and preserves owner pause and original HID history',async t=>{
 const f=await fixture(()=>({done:false,actions:[{key:'later',goal:'Continue goal',criteria:'Actual result'}]}));t.after(()=>f.runtime.close());
 f.task.operations.old={id:'old',tool:'demo.open',effect:'read',status:'intent',at:99000,actionId:'old-run',inputOutcome:{dispatched:true,reportsSubmitted:2,completion:'unknown',inputKinds:['move','click'],inputKindsComplete:true}};
 f.task.actionRuns['old-run']={id:'old-run',status:'needs_attention'};f.task.operations.fresh={id:'fresh',tool:'demo.observe',effect:'read',status:'confirmed',at:99998,finishedAt:99999,observation:{frameId:'fresh'}};
 await f.runtime.control('pause',f.id);const receipt=await f.runtime.reconcileEffect(f.id,{operationId:'old',outcome:'applied',evidenceOperationIds:['fresh'],basis:'Fresh board matches the target navigation state'});assert(receipt.ok);const current=f.runtime.tasks.get(f.id);assert.equal(current.status,'paused');assert.equal(current.operations.old.status,'intent');assert.equal(current.operations.old.inputOutcome.completion,'unknown');assert.equal(current.actionRuns['old-run'].status,'cancelled');assert.equal(current.state.goalPlan.needsPlanning,true);
});
test('Action completion triggers a separate evidence-based Task review rather than automatically completing the Task',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'inspect',goal:'Inspect state',criteria:'Fresh state checked',operations:[{key:'read',tool:'demo.observe',args:{}}]}]}:{done:true,summary:i===1?'Action result checked':'Task goal checked from actual state'});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.task.status,'waiting');assert.equal(f.task.state.goalPlan.needsPlanning,true);assert.equal(f.requests.length,2);await f.runtime.tick(f.id);assert.equal(f.task.status,'completed');assert.equal(f.requests.length,3);assert.equal(f.task.state.result.summary,'Task goal checked from actual state');
});
test('a failed planned Operation gives recovery guidance control over the next actual tool',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'inspect',goal:'Find board state',criteria:'New state',operations:[{key:'old',tool:'demo.observe',args:{}}]}]}:{done:false,tool:'demo.alternate',args:{}},{observe:async()=>{throw Object.assign(Error('synthetic stale target'),{code:'E_VISUAL_TARGET',dispatched:false});}});t.after(()=>f.runtime.close());f.runtime.diagnoseRepair=async()=>({action:'change_method',source:'local'});
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);f.advance(10000);await f.runtime.tick(f.id);assert.deepEqual(f.calls.map(c=>c.name),['demo.observe','demo.alternate']);assert.equal(f.requests.length,2);
});
test('an unfinished Action may replan multiple goals without pretending completion or changing the owner goal',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'inspect',goal:'Initial inspection',criteria:'State known'}]}:i===1?{done:false,replanTask:true,reason:'A different observation method is needed'}:i===2?{done:false,actions:[{key:'inspect',goal:'Inspect through the alternative',criteria:'Fresh state known',strategy:'Use independent alternate evidence',operations:[{key:'alternate',tool:'demo.alternate',args:{}}]}]}:{done:true,summary:'Alternative state checked'});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);const run=Object.values(f.task.actionRuns).find(a=>a.key==='inspect');assert.notEqual(run.status,'completed');assert.equal(f.task.state.goalPlan.needsPlanning,true);
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.deepEqual(f.calls.map(c=>c.name),['demo.alternate']);assert.equal(run.id,Object.values(f.task.actionRuns).find(a=>a.key==='inspect').id);assert.equal(f.task.goal,'Inspect the board and reach the requested state');assert.equal(Object.values(f.task.actionRuns).find(a=>a.key==='inspect').strategyHistory.length,1);
});
test('a timed-out input Action keeps its unknown effect, releases the worker and rejects late continuation',async t=>{
 let release;const gate=new Promise(r=>release=r);
 const f=await fixture(()=>({done:false,actions:[{key:'input',goal:'Reach state',criteria:'Verified state',operations:[{key:'input',tool:'demo.input',args:{}}]}]}),{input:async()=>{await gate;return {ok:true,verified:true};}});t.after(()=>f.runtime.close());f.runtime.stepTimeoutMs=20;
 await f.runtime.tick(f.id);const pending=f.runtime.tick(f.id);await pending;const current=f.runtime.tasks.get(f.id);assert.equal(current.status,'needs_attention');assert.equal(f.runtime.controllers.size,0);assert(Object.values(current.operations).some(o=>o.tool==='demo.input'&&o.status==='intent'));release();await new Promise(r=>setTimeout(r,5));assert.notEqual(current.status,'completed');assert.equal(f.calls.filter(c=>c.name==='demo.input').length,1);
});
test('same-id goal upgrade refreshes current knowledge through prepare while preserving owner goal, cursor, effects and old sources',async t=>{
 const f=await fixture(()=>({done:false,actions:[{key:'inspect',goal:'Inspect',criteria:'Known state'}]}));t.after(()=>f.runtime.close());
 f.task.state.conversations={synthetic:{cursor:{ready:true,recent:[]},introduced:true}};f.task.operations.old={id:'old',effect:'write',status:'confirmed',result:{ok:true,verified:true,receipt:{id:'original'}}};await f.runtime.control('pause',f.id);const original=f.runtime.tasks.get(f.id),sources=[...original.sources];
 f.runtime.prepare=async staged=>{staged.state.operatingKnowledge=[{sourceId:'updated-method',revision:7}];staged.sources.push('updated-method');staged.goal='prepare cannot change the owner goal';staged.operations={};staged.state.conversations={};};
 const upgraded=await f.runtime.upgradeGoal(f.id);assert(upgraded.ok);assert(upgraded.contextRefreshed);const current=f.runtime.tasks.get(f.id);assert.equal(current.id,f.id);assert.equal(current.status,'paused');assert.equal(current.goal,'Inspect the board and reach the requested state');assert.equal(current.state.conversations.synthetic.introduced,true);assert(current.operations.old.result.receipt);assert.deepEqual(current.state.operatingKnowledge,[{sourceId:'updated-method',revision:7}]);assert(sources.every(id=>current.sources.includes(id)));assert(current.sources.includes('updated-method'));
});
test('owner control and cancellation seal asynchronous upgrade knowledge before it can replace current context',async t=>{
 const f=await fixture(()=>({done:false,actions:[{key:'inspect',goal:'Inspect',criteria:'Known state'}]}));t.after(()=>f.runtime.close());await f.runtime.control('pause',f.id);let entered,release;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 f.runtime.prepare=async staged=>{entered();await gate;staged.state.operatingKnowledge=[{sourceId:'late-method'}];};const pending=f.runtime.upgradeGoal(f.id);await started;await f.runtime.control('resume',f.id);release();const result=await pending;assert.equal(result.ok,false);assert.equal(f.runtime.tasks.get(f.id).state.operatingKnowledge,undefined);
 await f.runtime.control('pause',f.id);const controller=new AbortController();let releaseAbort;f.runtime.prepare=async staged=>{await new Promise(r=>releaseAbort=r);staged.state.operatingKnowledge=[{sourceId:'cancelled-method'}];};const aborted=f.runtime.upgradeGoal(f.id,{signal:controller.signal});controller.abort();assert.equal((await aborted).ok,false);releaseAbort();await new Promise(r=>setImmediate(r));assert.equal(f.runtime.tasks.get(f.id).state.operatingKnowledge,undefined);
});
test('the planner receives the actual initial nonready observation, not only an ok ledger placeholder',async t=>{
 const f=await fixture(p=>{assert.equal(p.observations.length,1);assert.equal(p.observations[0].tool,'demo.observe');assert.equal(p.observations[0].result.headerMatched,false);assert.equal(p.observations[0].result.unstable,true);assert(p.observations[0].operationId);return {done:false,actions:[{key:'locate',goal:'Resolve the actual nonready observation',criteria:'Target is observed'}]};},{initialObservation:ctx=>ctx.call({tool:'demo.observe',key:'initial-observation',args:{}}),observe:async()=>({headerMatched:false,unstable:true,latestPending:false,observationId:'actual-frame'})});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);assert.equal(f.requests.length,1);assert.equal(f.records.get(f.id).state.goalPlan.observations[0].result.observationId,'actual-frame');
});
test('busy goal Operations respect durable nextAt across ticks and keep a single pending effect until resources become available',async t=>{
 let busy=true;
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'change',goal:'Change state when admitted',criteria:'New state verified',operations:[{key:'input',tool:'demo.input',args:{}}]}]}:{done:true,summary:'Actual change verified'},{input:async()=>{if(busy)throw Object.assign(Error('synthetic resource in use'),{code:'E_GUI_BUSY',dispatched:false});return {ok:true,verified:true};}});t.after(()=>f.runtime.close());
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);const run=Object.values(f.task.actionRuns).find(a=>a.goalAction);assert.equal(f.calls.length,1);assert.equal(run.resourceWait.nextAt,101000);assert.equal(goal.nextWake(f.task,100000),101000);f.runtime.autoSchedule=true;f.runtime.schedule();assert.equal(f.runtime.wakeAt,101000,'future resource retry must not become a 25ms scheduling loop');f.runtime.autoSchedule=false;clearTimeout(f.runtime.timer);f.runtime.timer=null;
 for(let i=0;i<10;i++)await f.runtime.tick(f.id);assert.equal(f.calls.length,1);assert.equal(run.attempts,1);f.advance(1000);await f.runtime.tick(f.id);assert.equal(f.calls.length,2);assert.equal(run.resourceWait.nextAt,103000);assert.equal(f.requests.length,1);
 busy=false;f.advance(2000);await f.runtime.tick(f.id);assert.equal(f.calls.length,3);assert(run.resourceWait.resolvedAt);assert.equal(run.resourceWait.nextAt,undefined);assert.equal(Object.values(f.task.operations).filter(o=>o.tool==='demo.input').length,1);assert.equal(f.task.counters.writes,1);
});
test('Bunny can complete from sufficient existing context without a forced tool-count prerequisite',async t=>{
 const f=await fixture(()=>({done:true,summary:'The provided state has been summarized'}));t.after(()=>f.runtime.close());f.task.goal='Summarize the state already supplied by the owner';f.task.context='Synthetic owner supplied the current state and asked only for a concise summary';
 await f.runtime.tick(f.id);assert.equal(f.task.status,'completed');assert.equal(f.requests.length,1);assert.equal(f.calls.length,0);assert.equal(f.task.state.result.summary,'The provided state has been summarized');
});
test('the current task brain can finish Action and Task together through normal delivery without an extra planner review',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'inspect',goal:'Read current state',criteria:'State meets the owner goal',operations:[{key:'read',tool:'demo.observe',args:{}}]}]}:(assert.equal(p.goal,f.task.goal),{done:true,taskDone:true,summary:'Current state satisfies the complete owner goal'}));t.after(()=>f.runtime.close());let completions=0;f.runtime.completed=async()=>{completions++;};
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.task.status,'completed');assert.equal(f.calls.length,1);assert.equal(f.requests.length,2);assert.equal(completions,1);assert.equal(f.task.state.delivery.status,'queued');assert(Object.values(f.task.actionRuns).find(a=>a.goalAction).status==='completed');
});
test('an Action may evaluate existing context and finish the overall Task without an artificial fresh Operation',async t=>{
 const f=await fixture((p,i)=>i===0?{done:false,actions:[{key:'assess',goal:'Assess the supplied facts',criteria:'The summary covers the request'}]}:{done:true,taskDone:true,summary:'The supplied facts meet the requested summary'});t.after(()=>f.runtime.close());f.task.context='Synthetic supplied facts already contain everything needed for this summary';
 await f.runtime.tick(f.id);await f.runtime.tick(f.id);assert.equal(f.task.status,'completed');assert.equal(f.calls.length,0);assert.equal(f.requests.length,2);
});
test('a completion assessment cannot erase or deliver past an actual unknown submission',async t=>{
 const f=await fixture(()=>({done:true,summary:'Task brain proposes completion'}));t.after(()=>f.runtime.close());f.task.operations.unknown={id:'unknown',tool:'demo.input',effect:'write',status:'intent',inputOutcome:{dispatched:true,completion:'unknown'}};
 await f.runtime.tick(f.id);assert.equal(f.task.status,'needs_attention');assert.equal(f.task.operations.unknown.status,'intent');assert.equal(f.task.state.result,undefined);assert.equal(f.task.counters.writes,0);assert.equal(f.calls.length,0);
});
