'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service'),{DesktopService}=require('../src/main/desktop-service'),{ToolRegistry}=require('../src/main/agent-tools');
const effects=require('../src/main/effect-review');
async function fixture(t,{major=false,stale=false}={}){
 const task={id:'canonical',goal:major?'Payment transfer':'Deliver the ordinary collected summary',criteria:'Observe actual delivery',scene:'life',visibilityFloor:1,privacyEpoch:1,status:'needs_attention',authority:{verified:true},capabilities:['conversation.send'],subjects:[{application:'system'}],delivery:{channel:'wechat',recipient:'Report Target'},state:{result:{summary:'Synthetic summary'}},actionRuns:{}};
 const op={id:'old-input',tool:'result.deliver',key:'original-key',effect:'write',status:'intent',args:{message:'Synthetic summary'},inputOutcome:{dispatched:true,reportsSubmitted:145,completion:'unknown'}};task.operations={[op.id]:op};
 const tools=new ToolRegistry();require('../src/main/result-delivery').registerResultTools(tools,{deliver:async()=>{throw Error('Must resume the original physical operation');}});
 const actual=[];let plans=0,resumes=0;
 const desktop=new DesktopService({native:{setInputContext(){},request:async()=>({screenCaptureAllowed:true,sessionLocked:false}),close:async()=>{}},planner:async()=>{
  plans++;if(plans===1)return {action:'click',purpose:'navigation',x:.3,y:.2};
  if(plans===2)return {action:'click',purpose:'submit',x:.8,y:.9,continuationAssessment:{goalNotMet:true,acceptPossibleDuplicate:true,basis:'Fresh visible target has not received the result',strategy:'Use the actual submit control after restoring the authorized view',duplicateImpact:'At most one duplicate ordinary authorized summary'}};
  return {action:'done',completed:true,evidence:'The fresh outgoing result is visible',receipt:{observed:'delivered',basis:'Actual resulting item and empty editor'}};
 }});t.after(()=>desktop.close());
 desktop.task={id:'physical',target:'wechat',operation:'send',goal:task.goal,recipient:'Report Target',message:'Synthetic summary',workModel:'hy3',origin:'agent',sources:[task.id],privacyEpoch:1,scene:'life',domain:'life',visibilityFloor:1,status:'paused',steps:[],submitAttemptedAt:10,submissionAttempts:[{id:'original-attempt',outcome:'unknown'}],proofBefore:{taskId:'physical',preview:'synthetic-before'},startedAt:Date.now()};op.physicalId='physical';
 desktop.assertInputAvailable=()=>{};desktop.visualSessions=new Map([['wechat',{observe:async()=>({}),identity:()=>({mode:'visual',sessionId:'session'})}]]);desktop.capture=async()=>desktop.screenshot={at:Date.now(),frameId:'fresh-'+plans,preview:'data:image/png;base64,c3ludGhldGlj',captureSource:'CGDisplayStream',perceptionSource:'vision-model',ocr:[],rect:{x:0,y:0,width:200,height:100},width:200,height:100};desktop.assertScreenshotCurrent=async()=>{};desktop.act=async action=>{actual.push([action.action,action.purpose]);return {performed:true};};
 const originalResume=desktop.resume.bind(desktop);desktop.resume=async options=>{resumes++;return originalResume(options);};
 const runtime={tasks:new Map([[task.id,task]]),stepTimeoutMs:5000,list:()=>[{id:task.id}],canControl:()=>true,controllers:new Map(),operations:{isRunning:()=>false},publish(){},schedule(){},save:async()=>{},confirmReconciled:async()=>{op.status='confirmed';return {ok:true};}};
 const service={runtime,tools,conversationDesktop:desktop,canOperate:async()=>true,scene:{assertHealthy:async()=>{if(stale)task.state.controlRevision=2;}},serialConversation:run=>run(),reconcileConversation:AgentService.prototype.reconcileConversation,conversationResumeOptions:async()=>({privacyEpoch:1,sources:[task.id],scene:'life'})};
 const free=require('../src/main/workbuddy-free'),prior=free.freeModel;free.freeModel=async()=> 'hy3';t.after(()=>{free.freeModel=prior;});
 return {task,op,tools,desktop,actual,run:()=>AgentService.prototype.reconcile.call(service,task.id),resumes:()=>resumes};
}
test('the actual original delivery resume inherits trusted navigation and a bounded new submit without replaying its old input',async t=>{
 const f=await fixture(t);assert(f.tools.get('result.deliver').continuationPolicy(f.task,f.op.args));assert(f.tools.get('result.attach').continuationPolicy(f.task,{index:0}));
 assert((await f.run()).ok);assert.equal(f.resumes(),1);assert.deepEqual(f.actual,[['click','navigation'],['click','submit']]);assert.equal(f.desktop.task.submissionAttempts.length,2);assert.equal(f.op.inputOutcome.reportsSubmitted,145);assert.equal(f.op.inputOutcome.completion,'unknown');assert.equal(f.op.effectReview.continuation.status,'consumed');
});
for(const variant of ['major','stale'])test('the same resume cannot input under '+variant+' risk or permission state',async t=>{
 const f=await fixture(t,{[variant]:true}),result=await f.run();assert.equal(result.ok,false);assert.deepEqual(f.actual,[]);assert.equal(f.op.status,'intent');assert.equal(f.op.inputOutcome.reportsSubmitted,145);
});
test('an unknown tool name cannot obtain a restored trusted effect context',async t=>{
 const f=await fixture(t);f.op.tool='fixture.forged';const result=await f.run();assert.equal(result.code,'E_TASK_AUTH');assert.equal(f.resumes(),0);assert.deepEqual(f.actual,[]);assert.equal(f.op.status,'intent');
});
