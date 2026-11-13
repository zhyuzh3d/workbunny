'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const review=require('../src/main/effect-review'),ledger=require('../src/main/operation-ledger');
const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
function fixture(){
 const old={id:'old',key:'old-key',tool:'fixture.input',effect:'write',status:'intent',at:100,inputOutcome:{inputKinds:['click'],inputKindsComplete:true,dispatched:true,completion:'unknown'}};
 const pixels={id:'pixels',effect:'read',status:'confirmed',finishedAt:200,observation:{observationId:'actual-fresh-observation'}};
 const task={id:'synthetic',goal:'Reach the requested board state',scene:'life',visibilityFloor:1,status:'waiting',state:{},authority:{verified:true},operations:{old,pixels}};
 const call={tool:'fixture.input',key:'new-strategy',args:{method:'alternate'}};
 const args={outcome:'unresolved',basis:'The current actual board has not reached the goal',evidenceOperationIds:['pixels'],continuation:{goalNotMet:true,acceptPossibleDuplicate:true,duplicateImpact:'A repeated small reversible selection is acceptable',strategy:'Use the alternate visible control',next:call}};
 return {task,old,call,args};
}
test('a trusted bounded assessment permits one new Operation, retains old unknown facts, and seals on goal/control changes',()=>{
 const f=fixture(),raw=structuredClone(f.old.inputOutcome),r=review.assess(f.task,f.old,f.args,{at:300,policy:review.boundedPolicy(f.task,{})});
 assert(review.permits(f.task,f.old,{args:{method:'alternate'},key:'new-strategy',tool:'fixture.input'},300));assert(!review.permits(f.task,f.old,{...f.call,key:'old-key'},300));
 review.consume(f.task,f.old,f.call,'new-op',300);assert(!review.permits(f.task,f.old,f.call,300));assert(ledger.hasBlockingEffect(f.task,f.old));
 f.task.operations['new-op']={id:'new-op',status:'confirmed',effect:'write'};assert(!ledger.hasBlockingEffect(f.task,f.old));assert(ledger.hasUncertainEffect(f.old));assert.deepEqual(f.old.inputOutcome,raw);assert.equal(f.old.status,'intent');assert.equal(r.outcome,'unresolved');
 f.task.state.controlRevision=1;assert(ledger.hasBlockingEffect(f.task,f.old));
});
test('fresh evidence and host policy are mandatory, high impact never follows the model low-risk claim, and attempts are bounded',()=>{
 for(const change of ['no-policy','stale','model','hid','funds','secret','unreleased']){
  const f=fixture();let policy=review.boundedPolicy(f.task,{});
  if(change==='no-policy')policy=null;if(change==='stale')f.task.operations.pixels.finishedAt=0;if(change==='model')f.task.operations.pixels.kind='model';if(change==='hid')f.task.operations.pixels.inputOutcome={dispatched:true};
  if(change==='funds')policy=review.boundedPolicy({...f.task,goal:'Transfer bank payment'},{});if(change==='secret')policy=review.boundedPolicy({...f.task,state:{sensitiveContext:true}},{});
  if(change==='unreleased')f.old.inputOutcome.releaseConfirmed=false;
  assert.throws(()=>review.assess(f.task,f.old,f.args,{at:300,policy}),{code:'E_EFFECT_REVIEW'});
 }
 const f=fixture();for(let i=0;i<2;i++)review.assess(f.task,f.old,f.args,{at:300,policy:review.boundedPolicy(f.task,{})});assert.throws(()=>review.assess(f.task,f.old,f.args,{at:300,policy:review.boundedPolicy(f.task,{})}),{code:'E_EFFECT_REVIEW'});
 assert(review.boundedPolicy({...f.task,policy:'禁止重复发送',state:{ownerRequest:'Send the ordinary synthetic note'}},{}),'an interpreter-added defensive template is not a new owner prohibition');
 assert.equal(review.boundedPolicy({...f.task,state:{ownerRequest:'严格幂等，绝不重复发送'}},{}),null,'an actual explicit owner restriction remains authoritative');
});
test('the task brain can assess a bounded GUI effect, choose a new key and complete under terminal review without replaying old input',async t=>{
 let now=1000,inputs=0,completed=0,reviews=0;const tools=new ToolRegistry();
 tools.register({name:'fixture.input',description:'bounded synthetic GUI',effect:'write',capabilities:[],continuationPolicy:(task,args)=>review.boundedPolicy(task,args),execute:async()=>{inputs++;if(inputs===1){require('../src/main/boper-outcome').recorder()({dispatched:true,completion:'unknown',inputKinds:['click'],inputKindsComplete:true});throw Error('first result unavailable');}return {ok:true,verified:true};}});
 tools.register({name:'fixture.observe',description:'fresh actual board',effect:'read',capabilities:[],execute:async()=>({observationId:'fresh-'+now,at:now})});
 let runtime;require('../src/main/goal-actions').registerGoalTools(tools,{reconcile:(id,args,options)=>runtime.reconcileEffect(id,args,options)});
 const skills=new SkillRegistry(tools).register({id:'fixture.task',version:1,description:'autonomous synthetic task',tools:[...tools.tools.keys()],capabilities:[],run:async ctx=>{
  try{await ctx.call({tool:'fixture.input',key:'old-key',args:{method:'original'}});}catch{}
  await ctx.call({tool:'fixture.observe',key:'inspect',args:{}});const ops=Object.values(ctx.task.operations),old=ops.find(op=>op.key==='old-key'),pixels=ops.find(op=>op.key==='inspect');
  const next={tool:'fixture.input',key:'new-strategy',args:{method:'alternate'}};
  await ctx.call({tool:'effect.reconcile',key:'assess',args:{operationId:old.id,outcome:'unresolved',evidenceOperationIds:[pixels.id],basis:'The new actual board is still unchanged',continuation:{goalNotMet:true,acceptPossibleDuplicate:true,duplicateImpact:'A repeated reversible control selection is acceptable',strategy:'Use the alternate visible control',next}}});
  await ctx.call(next);return {status:'completed',note:'The alternate control reached the requested board state; the first effect remains uncertain'};
 }});
 const records=new Map();runtime=new AgentRuntime({tools,skills,clock:()=>++now,epoch:()=>1,autoSchedule:false,journal:{authorized:async()=>true,put:async task=>records.set(task.id,structuredClone(task))},reviewTask:async()=>{reviews++;return {type:'accept',rationaleSummary:'Goal reached with the explicit minor duplicate risk retained',guidance:{}};},completed:async()=>{completed++;}});t.after(()=>runtime.close());
 const {id}=await runtime.start({skill:'fixture.task',goal:'Reach the requested board state',subjects:[{application:'system'}]},{role:'owner',verified:true,scene:'life',sources:['synthetic-owner']});await runtime.tick(id);await runtime.tick();
 const deadline=Date.now()+1000;while(completed!==1&&Date.now()<deadline)await new Promise(r=>setImmediate(r));const task=runtime.tasks.get(id);assert.equal(task.status,'completed');assert.equal(inputs,2);assert.equal(completed,1);assert.equal(reviews,1);const old=Object.values(task.operations).find(op=>op.key==='old-key');assert.equal(old.status,'intent');assert(ledger.hasUncertainEffect(old));assert(!ledger.hasBlockingEffect(task,old));
 await assert.rejects(runtime.operations.execute({task,call:{tool:'fixture.input',key:'old-key',args:{method:'original'}},isCurrent:()=>true}),{code:'E_SUBMISSION_UNCERTAIN'});assert.equal(inputs,2);
});
test('task-level done uses an existing confirmed observation to settle pointer navigation without fabricating a business-write outcome',()=>{
 const f=fixture();f.old.effect='read';f.old.inputOutcome={inputKinds:['move','scroll'],inputKindsComplete:true,dispatched:true,completion:'local-submitted',clipboardChanged:false};
 ledger.reconcileNavigationOnCompletion(f.task,{at:300,basis:'Current observation shows the requested newest board position'});assert(!ledger.hasUncertainEffect(f.old));assert.equal(f.old.status,'intent');assert.equal(f.old.effectReconciliation.navigationOnly,true);
 const business=fixture();ledger.reconcileNavigationOnCompletion(business.task,{at:300});assert(ledger.hasUncertainEffect(business.old));assert.equal(business.old.effectReconciliation,undefined);
});
test('desktop same-round assessment retains the original submit history, changes actual strategy and rejects replay or stale authority',async()=>{
 const {DesktopService,validateAction}=require('../src/main/desktop-service'),f=fixture();let saves=0;
 const action=validateAction({action:'click',purpose:'submit',x:.8,y:.9,continuationAssessment:{goalNotMet:true,acceptPossibleDuplicate:true,basis:'The fresh editor still contains the draft',strategy:'Use the visible submit control instead of Return',duplicateImpact:'At worst one duplicate ordinary authorized note'}});
 const service={task:{id:'desktop-physical',submitAttemptedAt:100,submissionAttempts:[{at:100,outcome:'unknown',actionHash:review.hash({action:'key',key:'return',modifiers:[]})}]},assertLive(){},journal:async()=>{}};
 const ctx={task:f.task,operation:f.old,tool:{continuationPolicy:(task,input)=>review.boundedPolicy(task,input)},input:{message:'synthetic ordinary note'},save:async()=>{saves++;},isCurrent:()=>true};
 const shot={frameId:'fresh-display',at:Date.now(),preview:'synthetic pixels'};
 const recorded=await review.scope(ctx,()=>DesktopService.prototype.assessEffectContinuation.call(service,action,shot,1));assert.equal(saves,1);assert.equal(f.old.status,'intent');assert.equal(service.task.submitAttemptedAt,100);assert.equal(service.task.submissionAttempts[0].outcome,'unknown');assert.equal(recorded.continuation.next.tool,'desktop.input');
 review.consume(f.task,f.old,recorded.continuation.next,f.old.id,Date.now());assert.throws(()=>review.consume(f.task,f.old,recorded.continuation.next,f.old.id,Date.now()),{code:'E_EFFECT_REVIEW'});
 service.task.submissionAttempts.push({actionHash:review.hash({action:'click',x:.8,y:.9})});await assert.rejects(review.scope(ctx,()=>DesktopService.prototype.assessEffectContinuation.call(service,action,shot,1)),{code:'E_EFFECT_REVIEW'});
 f.task.state.controlRevision=1;assert(!review.current(f.task,recorded));
 assert.throws(()=>validateAction({action:'done',completed:true,evidence:{receipt:{observed:'delivered'}}}),/evidence必须是字符串.*同级/);
 assert.equal(validateAction({action:'done',completed:true,evidence:'The actual new outgoing item is visible',receipt:{observed:'delivered',basis:'New visible item after input'}}).receipt.observed,'delivered');
});
function planningFixture(outputs,{major=false}={}){
 const {DesktopService}=require('../src/main/desktop-service'),f=fixture(),requests=[];if(major)f.task.goal='Make a payment';
 const ctx={task:f.task,operation:f.old,tool:{continuationPolicy:review.boundedPolicy},input:{message:'synthetic ordinary note'},save:async()=>{},isCurrent:()=>true};
 const inputReceipt={acknowledged:true,verificationScope:'native-input-only',businessResult:'unresolved',inputOutcome:{inputKinds:['key'],inputKindsComplete:true,dispatched:true,targetVerified:false,releaseConfirmed:true}};
 const physical={id:'physical',target:'wechat',operation:'send',message:'synthetic ordinary note',submitAttemptedAt:100,steps:[{action:'key',purpose:'submit',state:'input-sent',inputIntent:{action:'key',key:'return',modifiers:[]},inputReceipt}],submissionAttempts:[{id:'first-submit',at:100,outcome:'unknown',actionHash:review.hash({action:'key',key:'return',modifiers:[]})}]};
 const service={task:physical,wechatBeforeSubmit:{taskId:physical.id,preview:'data:image/png;base64,YmVmb3Jl'},progress:()=>({snapshot:()=>({})}),update(){},modelRequest:async options=>{requests.push(options);return {text:JSON.stringify(outputs[Math.min(requests.length-1,outputs.length-1)])};}};
 const scope={...physical,goal:'Send the authorized synthetic note once',recipient:'Fixture',workModel:'hy3',submitAttempted:true,useInnateExperience:false,operatingKnowledge:[]},shot={at:Date.now(),preview:'data:image/png;base64,YWZ0ZXI=',ocr:[]};
 return {...f,requests,physical,run:()=>review.scope(ctx,()=>DesktopService.prototype.nextAction.call(service,scope,shot,new AbortController().signal))};
}
test('a missing continuation assessment is repaired in the existing two planning attempts before any input',async()=>{
 const next={action:'click',purpose:'submit',x:.8,y:.9},assessment={goalNotMet:true,acceptPossibleDuplicate:true,basis:'The actual current editor still contains the draft',strategy:'Use the visible submit button instead of the original Return',duplicateImpact:'At worst one duplicate ordinary authorized acknowledgment'};
 const f=planningFixture([next,{...next,continuationAssessment:assessment}]),raw=structuredClone(f.old),action=await f.run();assert.deepEqual(action.continuationAssessment,assessment);assert.equal(f.requests.length,2);assert.deepEqual(f.old,raw,'format repair neither dispatches nor resolves the original unknown input');
 const payload=JSON.parse(f.requests[0].messages.find(m=>m.role==='user').content[0].text);assert.equal(payload.effectContinuation.requiredForNewSubmit,true);assert.equal(payload.effectContinuation.remaining,2);assert.equal(payload.submissionAttempts[0].outcome,'unknown');assert.equal(payload.steps[0].inputReceipt.verificationScope,'native-input-only');assert.equal(payload.steps[0].inputReceipt.inputOutcome.targetVerified,false);assert.equal(payload.steps[0].inputIntent.key,'return');
 assert.equal(f.requests[0].messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').length,2,'the same request has both actual before/after images');
 const repair=f.requests[1].messages.at(-1).content;for(const field of ['continuationAssessment','goalNotMet','acceptPossibleDuplicate','basis','strategy','duplicateImpact'])assert(repair.includes(field),field);assert.match(payload.actionProtocol,/必须附/);const system=f.requests[0].messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert(system.includes('native-input-only'));assert(system.includes('false不能当成视觉失败'));assert(!system.includes('send允许提交一次。'),'business goal and bounded physical continuation use one contract');
});
test('two missing assessments stop within the original format budget while observation remains a one-call choice',async()=>{
 const f=planningFixture([{action:'click',purpose:'submit',x:.8,y:.9}]),raw=structuredClone(f.old);await assert.rejects(f.run(),{code:'E_MODEL_SCHEMA'});assert.equal(f.requests.length,2);assert.deepEqual(f.old,raw);
 const waiting=planningFixture([{action:'wait',reason:'Wait for the existing result',waitMs:1000}]);assert.equal((await waiting.run()).action,'wait');assert.equal(waiting.requests.length,1);
});
test('major-impact tasks do not acquire ordinary continuation permission from a model risk claim',async()=>{
 const f=planningFixture([{action:'wait',waitMs:1000}],{major:true});await f.run();const payload=JSON.parse(f.requests[0].messages.find(m=>m.role==='user').content[0].text);assert.equal(payload.effectContinuation.available,false);assert.equal(payload.effectContinuation.remaining,0);assert.equal(f.old.status,'intent');assert(ledger.hasBlockingEffect(f.task,f.old));
});
test('existing fresh observation and task-brain done settle a completed read navigation in the same runtime turn',async t=>{
 let now=1000;const tools=new ToolRegistry(),skills=new SkillRegistry(tools).register({id:'fixture.navigation',description:'navigation task',version:1,tools:[],capabilities:[],run:async({task})=>{
  task.actionRuns.previousNavigation={id:'previousNavigation',status:'needs_attention'};
  task.actionRuns.laterObserver={id:'laterObserver',status:'needs_attention'};task.state.lastFailure={code:'E_SUBMISSION_UNCERTAIN',actionId:'laterObserver'};
  task.operations.navigation={id:'navigation',key:'open-target',tool:'fixture.open',effect:'read',status:'intent',actionId:'previousNavigation',at:900,inputOutcome:{inputKinds:['move','scroll'],inputKindsComplete:true,dispatched:true,completion:'local-submitted',clipboardChanged:false}};
  task.operations.observation={id:'observation',key:'view-target',tool:'fixture.observe',effect:'read',actionId:'laterObserver',status:'confirmed',finishedAt:1001,observation:{observationId:'the-newest-visible-board'}};
  return {status:'completed',note:'The actual current observation is at the requested newest position'};
 }});
 const runtime=new AgentRuntime({tools,skills,clock:()=>++now,epoch:()=>1,autoSchedule:false,journal:{authorized:async()=>true,put:async()=>{}}});t.after(()=>runtime.close());
 const {id}=await runtime.start({skill:'fixture.navigation',goal:'Reach the newest visible board entries',subjects:[{application:'system'}]},{role:'owner',verified:true,scene:'life',sources:['synthetic']});await runtime.tick(id);const task=runtime.tasks.get(id);assert.equal(task.status,'completed');assert.equal(task.operations.navigation.status,'intent');assert.equal(task.operations.navigation.effectReconciliation.navigationOnly,true);assert.equal(task.actionRuns.previousNavigation.status,'completed');assert.equal(task.actionRuns.laterObserver.status,'completed');assert(task.state.lastFailure.resolvedAt);
});
test('the desktop task brain can submit an authorized existing draft and switch Return to a new click without retyping or upper approval',async t=>{
 const {DesktopService}=require('../src/main/desktop-service'),f=fixture(),actual=[];let plans=0;
 const native={setInputContext(){},close:async()=>{}};
 const service=new DesktopService({native,planner:async()=>{
  plans++;if(plans===1)return {action:'key',key:'return',modifiers:[],purpose:'submit'};
  if(plans===2)return {action:'click',x:.8,y:.9,purpose:'submit',continuationAssessment:{goalNotMet:true,acceptPossibleDuplicate:true,basis:'The current visible editor still contains the draft after Return',strategy:'Choose the visible send control rather than Return',duplicateImpact:'One possible duplicate ordinary note is a minor controllable impact'}};
  return {action:'done',completed:true,evidence:'The actual new outgoing item is now visible',receipt:{observed:'delivered',basis:'New outgoing item after the alternate control'}};
 }});t.after(()=>service.close());
 service.task={id:'synthetic-desktop',goal:'Send the authorized ordinary note',target:'wechat',recipient:'Synthetic Contact',message:'Synthetic note',operation:'send',scene:'life',domain:'life',visibilityFloor:1,steps:[],draftInserted:false,startedAt:Date.now(),workModel:'hy3'};
 service.visualSessions=new Map([['wechat',{observe:async()=>({}),identity:()=>({mode:'visual',sessionId:'synthetic-session'})}]]);service.running=true;service.generation=1;service.controller=new AbortController();
 service.capture=async()=>service.screenshot={at:Date.now(),frameId:'synthetic-current-frame-'+plans,preview:'data:image/png;base64,c3ludGhldGlj',captureSource:'display-pixels',perceptionSource:'vision-model',ocr:[],rect:{x:0,y:0,width:200,height:120},width:200,height:120};
 service.assertScreenshotCurrent=async()=>{};service.act=async action=>{actual.push(action.action);};
 const ctx={task:f.task,operation:f.old,input:{message:'Synthetic note'},tool:{continuationPolicy:(task,input)=>review.boundedPolicy(task,input)},save:async()=>{},isCurrent:()=>true};
 await review.scope(ctx,()=>service.run(1,{...service.task}));
 assert.equal(service.task.status,'review');assert.deepEqual(actual,['key','click']);assert.equal(plans,3);assert.equal(service.task.submissionAttempts.length,2);assert.equal(new Set(service.task.submissionAttempts.map(a=>a.id)).size,2);assert(service.task.submissionAttempts.every(a=>a.outcome==='unknown'));assert.equal(f.old.status,'intent');assert.equal(f.old.effectReview.outcome,'unresolved');assert.equal(f.old.effectReview.continuation.status,'consumed');assert.equal(service.task.steps.filter(s=>s.action==='type').length,0);
});
