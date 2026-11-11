'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const {raster,bitmap,crop,encode}=require('./support/visual-fixture.cjs');
function fixture({target='workbuddy',history=[],positive=false,cancelAfterSubmit=false,rejectSubmit=false}={}){
 let clicks=0,plans=0,reconcileAccess=0;const rect={x:0,y:0,width:1000,height:800};
 const interpretation={action:'done',completed:false,receipt:{observed:'not_applied',basis:'unchanged screenshot and original draft still present',draft:'present'}};
 const actions=history.some(s=>['intent','input-sent'].includes(s.state))?[{action:'click',purpose:'submit',x:.9,y:.9},interpretation]:[{action:'type',purpose:'task',text:'fixture exact draft'}, {action:'click',purpose:'submit',x:.9,y:.9},interpretation,{action:'click',purpose:'submit',x:.9,y:.9},interpretation,{action:'click',purpose:'submit',x:.9,y:.9}];
 const image=raster(),native={close:async()=>{},cancel:async()=>{},request:async op=>{assert.equal(op,'displayCapture','activation uses display pixels only');return {pngBase64:encode(image).toString('base64'),width:image.width,height:image.height,desktopRect:rect,backend:'CGDisplayStream',capturedAt:Date.now()};}};
 const verificationRequest=async options=>({response:{text:JSON.stringify(options.messages[0].content.includes('定位指定软件')?{software:target==='wechat'?'微信':'WorkBuddy',available:true,unique:true,active:true,sameIdentity:true,region:{x:0,y:0,width:1,height:1},mainRegion:{x:0,y:0,width:1,height:1},identityRegion:{x:.1,y:.02,width:.3,height:.1},monitorRegions:[{x:0,y:.1,width:1,height:.8}],focusRegion:{x:.3,y:.7,width:.6,height:.2},focusEvidence:'Synthetic editor caret',evidence:'Synthetic unique task heading',texts:[{text:'DeepSeek-V4.1-Flash',confidence:1,x:.6,y:.8,width:.3,height:.03}]}:{matched:true,evidence:'Synthetic screenshot confirms the empty task editor and input prerequisites'})}});
 let service;service=new DesktopService({native,bitmap,imageCrop:crop,verificationRequest,persist:async()=>{},planner:async(_goal,_shot,_signal,task)=>{const action=actions[plans++];if(cancelAfterSubmit&&clicks)await service.stop('fixture cancellation');return action?.action==='type'?{...action,inputEvidence:{observationId:task.inputPrerequisites.observationId,checks:task.inputPrerequisites.checks.map(check=>({id:check.id,observed:check.expected,basis:'Synthetic screenshot shows '+check.id+': '+check.expected}))}}:action;}});
 service.generation=1;service.running=true;service.controller=new AbortController();const now=Date.now();
 service.task={id:'fixture',target,scene:'life',domain:'work',visibilityFloor:1,workModel:'deepseek-v4.1-flash',goal:'fixture',outboundText:'fixture exact draft',startedAt:now,steps:structuredClone(history),draftInserted:history.some(s=>['intent','input-sent'].includes(s.state))};
 service.actionControl={};Object.defineProperty(service.actionControl,'reconcile',{get(){reconcileAccess++;throw Error('planner must not access an effect-reset API');}});
 // Exercise the generic planner's durable effect barrier, independently of
 // the optional structured WorkBuddy adapter.
 service.tryBackgroundWorkBuddy=async()=>false;service.tryForegroundWorkBuddy=async()=>false;service.tryWorkBuddyHandoff=async()=>false;service.activateForTask=async()=>{};
 service.tryBindVisualWorkBuddyMonitor=async()=>{if(positive&&plans>=3){service.task.handoffSent=true;service.task.monitorSessionId='fixture-session';return true;}return false;};
 service.ensureWorkBuddyMonitor=async()=>{service.running=false;return true;};
 service.act=async action=>{if(action.purpose==='submit'){if(rejectSubmit)throw Object.assign(Error('fixture foreground refusal'),{code:'E_GUI_FOCUS_CHANGED',dispatched:false});clicks++;}else assert.equal(action.action,'type');};
 const scope={id:'fixture',target,operation:'send',recipient:'fixture person',workModel:'deepseek-v4.1-flash',goal:'fixture',outboundText:service.task.outboundText,startedAt:now,attemptStartedAt:now};
 return {service,scope,clicks:()=>clicks,plans:()=>plans,reconcileAccess:()=>reconcileAccess,interpretation,run:()=>service.runOwned(service.generation,scope)};
}
test('the three-click planner shape stops after its first dispatched click and retains the original effect barrier',async()=>{
 const h=fixture();try{
  await assert.rejects(h.run(),{code:'E_SUBMISSION_UNCERTAIN'});assert.equal(h.clicks(),1);assert.equal(h.plans(),3);
  assert(h.service.task.submitAttemptedAt);assert(h.service.task.proofBefore);assert.equal(h.service.task.steps.filter(s=>s.purpose==='submit').length,1);assert.equal(h.service.task.steps.at(-1).state,'input-sent');
  const review=h.service.task.effectReviews[0];assert.equal(review.source,'planner');assert.equal(review.verified,false);assert.equal(review.trust,'interpretation-not-authorization');assert.equal(review.attemptAt,h.service.task.submitAttemptedAt);assert.equal(h.reconcileAccess(),0);
 }finally{await h.service.close();}
});
for(const state of ['intent','input-sent'])test('a durable '+state+' submit restores a missing temporary barrier and prohibits another click',async()=>{
 const h=fixture({history:[{action:'click',purpose:'submit',state,at:123}]});try{await assert.rejects(h.run(),/禁止|只允许|不得/);assert.equal(h.clicks(),0);assert.equal(h.service.task.submitAttemptedAt,123);}finally{await h.service.close();}
});
test('a truly not-dispatched historical attempt does not prevent the first actual submit',async()=>{
 const h=fixture({history:[{action:'click',purpose:'submit',state:'not-dispatched',at:123}]});try{await assert.rejects(h.run(),{code:'E_SUBMISSION_UNCERTAIN'});assert.equal(h.clicks(),1);assert.notEqual(h.service.task.submitAttemptedAt,123);}finally{await h.service.close();}
});
test('a positive exact Monitor receipt confirms the existing submit without a second click',async()=>{
 const h=fixture({positive:true});try{await h.run();assert.equal(h.clicks(),1);assert.equal(h.service.task.handoffSent,true);assert.equal(h.service.task.monitorSessionId,'fixture-session');assert.equal(h.reconcileAccess(),0);}finally{await h.service.close();}
});
test('the generic WeChat planner opinion cannot undo a persisted submit or clear its before-image',async()=>{
 const h=fixture({target:'wechat',history:[{action:'click',purpose:'submit',state:'input-sent',at:123}]});try{
  h.service.task.submitAttemptedAt=123;h.service.task.submittedAt=124;const before=h.service.task.proofBefore={taskId:'fixture',preview:'original-before'};
  h.service.planner=async()=>h.interpretation;await assert.rejects(h.run(),{code:'E_SUBMISSION_UNCERTAIN'});
  assert.equal(h.clicks(),0);assert.equal(h.service.task.submitAttemptedAt,123);assert.equal(h.service.task.submittedAt,124);assert.equal(h.service.task.proofBefore,before);assert.equal(h.reconcileAccess(),0);
 }finally{await h.service.close();}
});
test('cancellation after a dispatched click cannot authorize another action',async()=>{
 const h=fixture({cancelAfterSubmit:true});try{await assert.rejects(h.run(),/停止|取消/);assert.equal(h.clicks(),1);assert(h.service.task.submitAttemptedAt);assert.equal(h.reconcileAccess(),0);}finally{await h.service.close();}
});
test('a current before-dispatch refusal clears only its own unissued submit intent',async()=>{
 const h=fixture({rejectSubmit:true});try{await assert.rejects(h.run(),{code:'E_GUI_FOCUS_CHANGED',dispatched:false});assert.equal(h.clicks(),0);assert.equal(h.service.task.submitAttemptedAt,undefined);assert.equal(h.service.task.steps.at(-1).state,'not-dispatched');assert.equal(h.reconcileAccess(),0);}finally{await h.service.close();}
});
