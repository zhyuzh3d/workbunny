'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService,validateAction,validateWechatAction}=require('../src/main/desktop-service');
const {raster,bitmap,crop,encode,paint}=require('./support/visual-fixture.cjs');
function fixture({supersede=false,failSubmit=false}={}){
 const events=[],nativeCalls=[],image=raster(),rect={x:0,y:31,width:800,height:900},composer={x:.2,y:.75,width:.6,height:.2};let models=0,recipient='Alice',draft='';
 const control={superseded:false,protect:async()=>{},assertCurrent(){if(this.superseded)throw Object.assign(Error('same target has a newer message'),{code:'E_ACTION_SUPERSEDED'});},async commit(){this.assertCurrent();}};
 const native={request:async(op,payload)=>{
  nativeCalls.push({op,payload});
  if(op==='displayCapture')return {pngBase64:encode(image).toString('base64'),width:image.width,height:image.height,desktopRect:rect,backend:'CGDisplayStream',capturedAt:Date.now()};
  if(op!=='displayInput')throw Error('Offline visual sequence forbids native operation: '+op);
  events.push({op:payload.action,at:Date.now(),payload});
  if(payload.action==='type'){draft=payload.text;paint(image,composer,230);if(supersede)control.superseded=true;}
  if(payload.action==='key'&&payload.key==='enter'){draft='';paint(image,composer,90);paint(image,{x:.3,y:.4,width:.3,height:.08},200);if(failSubmit)throw Error('submit acknowledgement lost');}
  return {performed:true};
 },close:async()=>{}};
 const verificationRequest=async()=>({response:{text:JSON.stringify({software:'微信',available:true,unique:true,active:true,sameIdentity:true,confidence:1,
  region:{x:0,y:0,width:1,height:1},mainRegion:{x:0,y:0,width:1,height:1},identityRegion:{x:.1,y:.01,width:.6,height:.1},monitorRegions:[{x:.1,y:.15,width:.8,height:.55}],
  focusRegion:composer,focusEvidence:'Synthetic visible composer caret',evidence:'Synthetic account and contact heading are uniquely visible',
  texts:[{text:recipient,confidence:1,x:.4,y:.04,width:.2,height:.04},...(draft?[{text:draft,confidence:1,x:.3,y:.8,width:.3,height:.04}]:[])]})}});
 const service=new DesktopService({native,bitmap,imageCrop:crop,verificationRequest,planner:async()=>{models++;return models===1?{action:'type',text:'hello',purpose:'task',focus:{x:.6,y:.88},then:[{action:'key',key:'enter',purpose:'submit',modifiers:[],afterMs:20}]}:{action:'done',completed:true,evidence:'新消息在实际会话中出现',receipt:{observed:'delivered',basis:'对照前后画面核对本次新增消息'}};}});
 const taskScope={id:'sequence-test',target:'wechat',operation:'send',recipient:'Alice',message:'hello',startedAt:Date.now(),scene:'life',domain:'life',visibilityFloor:1};
 service.task={...taskScope,steps:[]};service.running=true;service.controller=new AbortController();service.actionControl=control;
 service.beforeReplyInput=async()=>events.push({op:'check-incoming'});
 // Track planner observations separately from CG pixel checks and focus proof.
 const capture=service.capture.bind(service);service.capture=async(...args)=>{events.push({op:'capture'});return capture(...args);};
 return {service,events,nativeCalls,taskScope,models:()=>models,showContact(value){recipient=value;paint(image,{x:.1,y:.01,width:.6,height:.1},200);}};
}
test('one planned input/send sequence has no intermediate conversation parsing or replanning, then Bunny reviews the result',async()=>{
 const f=fixture();await f.service.runOwned(f.service.generation,f.taskScope);
 const type=f.events.findIndex(e=>e.op==='type'),submit=f.events.findIndex(e=>e.op==='key');
 assert(type>=0&&submit>type);assert(!f.events.slice(type+1,submit).some(e=>['capture','check-incoming'].includes(e.op)));
 assert(f.events[submit].at-f.events[type].at>=15);assert.equal(f.models(),2,'one decision for the whole sequence, one result judgment');
 assert.equal(f.events.filter(e=>e.op==='capture').length,2);assert.equal(f.service.task.sendState,'confirmed');assert(f.service.task.steps.some(s=>s.continued&&s.purpose==='submit'));await f.service.close();
});
test('an already detected same-target update prevents the planned submit while preserving its original draft',async()=>{
 const f=fixture({supersede:true});await assert.rejects(f.service.runOwned(f.service.generation,f.taskScope),e=>e.code==='E_ACTION_SUPERSEDED');
 assert.equal(f.events.filter(e=>e.op==='type').length,1);assert.equal(f.events.filter(e=>e.op==='key').length,0);assert(f.service.task.draftInserted);assert(!f.service.task.submitAttemptedAt);await f.service.close();
});
test('an uncertain submit in a continuous sequence retains the intent instead of automatically replaying it',async()=>{
 const f=fixture({failSubmit:true});await assert.rejects(f.service.runOwned(f.service.generation,f.taskScope),/acknowledgement/);
 assert.equal(f.events.filter(e=>e.op==='key').length,1);assert(f.service.task.submitAttemptedAt);assert.equal(f.service.task.steps.find(s=>s.purpose==='submit').state,'intent');await f.service.close();
});
test('a planner opinion cannot clear the submit barrier or replay the same Action',async()=>{
 const f=fixture();let planned=0,reviews=0;f.service.actionControl.reconcile=async review=>{reviews++;assert.equal(review.observed,'not_applied');};
 f.service.planner=async()=>{planned++;if(planned===1||planned===3)return {action:'type',text:'hello',purpose:'task',focus:{x:.6,y:.88},then:[{action:'key',key:'enter',purpose:'submit',modifiers:[],afterMs:1}]};if(planned===2)return {action:'done',completed:false,receipt:{observed:'not_applied',draft:'absent',basis:'对照本次前后画面，输入未落入编辑区；当前最新消息区域无本次消息，编辑区为空'}};return {action:'done',completed:true,evidence:'重新定位后本次消息已出现',receipt:{observed:'delivered',basis:'新增本人气泡和实际原文均已核对'}};};
 await assert.rejects(f.service.runOwned(f.service.generation,f.taskScope),{code:'E_SUBMISSION_UNCERTAIN'});assert.equal(reviews,0);assert.equal(f.service.task.effectReviews.length,1);assert.equal(f.service.task.effectReviews[0].verified,false);assert(f.service.task.submitAttemptedAt);assert.equal(f.events.filter(e=>e.op==='key').length,1);assert.equal(f.service.task.steps.filter(s=>s.purpose==='submit').length,1,'the original attempt remains without replay');await f.service.close();
});
test('a different contact frame cannot declare the original submit ineffective',async()=>{
 const f=fixture(),capture=f.service.capture;let frames=0,planned=0;f.service.capture=async(...args)=>{if(++frames>1)f.showContact('Bob');return capture(...args);};
 f.service.planner=async()=>++planned===1?{action:'type',text:'hello',purpose:'task',focus:{x:.6,y:.88},then:[{action:'key',key:'enter',purpose:'submit',modifiers:[],afterMs:1}]}:{action:'done',completed:false,receipt:{observed:'not_applied',draft:'absent',basis:'another frame has no message'}};
 await assert.rejects(f.service.runOwned(f.service.generation,f.taskScope),{code:'E_SUBMISSION_UNCERTAIN'});assert(f.service.task.submitAttemptedAt);assert.equal(f.service.task.effectReviews[0].verified,false);assert.equal(f.events.filter(e=>e.op==='key').length,1);await f.service.close();
});
test('sequence structure cannot hide another input after submit or mislabel a send as navigation',()=>{
 assert.throws(()=>validateAction({action:'type',text:'hello',then:[{action:'key',key:'enter',purpose:'submit'},{action:'type',text:'again'}]}));
 assert.throws(()=>validateWechatAction({action:'key',key:'enter',purpose:'navigation'},{operation:'send',draftInserted:true}));
 assert.equal(validateAction({action:'key',key:'escape',purpose:'关闭遮挡菜单以读取实际结果'}).key,'escape');
 assert.throws(()=>validateAction({action:'key',key:'enter',purpose:'自然语言不能掩盖一次提交'}));
});
test('the shared visual Action can dismiss an obstructing menu and return actual text without sending',async()=>{
 const f=fixture();f.service.actionControl=null;f.service.task.operation=f.taskScope.operation='read';f.taskScope.readRequest={kind:'voice-transcript',sequence:3};f.service.task.readRequest=f.taskScope.readRequest;
 let models=0;f.service.planner=async()=>++models===1?{action:'key',key:'escape',modifiers:[],reason:'取得未被菜单遮挡的实际画面'}:{action:'done',completed:true,evidence:'已在指定语音下方读到完整转写',readText:'明天下午3点开会'};
 await f.service.runOwned(f.service.generation,f.taskScope);
 assert.equal(f.service.task.readText,'明天下午3点开会');assert.equal(f.service.task.status,'review');assert.equal(f.events.filter(e=>e.op==='type').length,0);assert.deepEqual(f.events.filter(e=>e.op==='key').map(e=>e.payload.key),['escape']);await f.service.close();
});
