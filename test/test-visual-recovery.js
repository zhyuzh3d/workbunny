'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const {fixture,raster,encode,crop,bitmap,paint}=require('./support/visual-fixture.cjs');
const rect={x:0,y:0,width:1000,height:700};
test('desktop execution reaches its first plan after shared safe visual activation without adding input to capture',async t=>{
 let h;h=fixture({onInput:()=>{h.location.active=true;}});h.location.active=false;h.location.activationRegion={x:.6,y:.12,width:.1,height:.05};h.location.activationEvidence='visible empty title area';
 h.native.close=()=>{};h.native.cancel=()=>{};const service=new DesktopService({native:h.native,imageResize:bytes=>bytes,imageCrop:h.crop,bitmap:h.bitmap});t.after(()=>service.close());
 service.task={id:'fixture-activation',target:'notes',scene:'life',domain:'life',visibilityFloor:1,goal:'fixture goal',steps:[],startedAt:Date.now()};service.running=true;service.generation=1;service.controller=new AbortController();service.visualSessions=new Map([['notes',h.visual]]);
 const reached=Error('first plan reached');service.capture=async()=>{throw reached;};await service.acquireGuiLease();
 await assert.rejects(service.runOwned(1,{...service.task}),e=>e===reached);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
});
test('desktop activation failures preserve owner-required diagnostics and acknowledged input for the task owner',async t=>{
 let h;h=fixture({onInput:()=>{h.location={available:false,unavailableKind:'security',evidence:'synthetic visible security notice',reason:'synthetic security notice'};}});h.location={...h.location,active:false,activationRegion:{x:.6,y:.12,width:.1,height:.05},activationEvidence:'synthetic safe title area'};h.native.close=()=>{};h.native.cancel=()=>{};
 const service=new DesktopService({native:h.native,imageResize:bytes=>bytes,imageCrop:h.crop,bitmap:h.bitmap});t.after(()=>service.close());service.task={id:'fixture-activation-failure',target:'notes',scene:'life',domain:'life',visibilityFloor:1,goal:'fixture goal',steps:[],startedAt:Date.now()};service.running=true;service.generation=1;service.controller=new AbortController();service.visualSessions=new Map([['notes',h.visual]]);
 await assert.rejects(service.run(1,{...service.task}),e=>e.diagnostic.visualState.requiresOwner===true&&e.diagnostic.inputReceipt.inputPerformed===true);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
});
test('the fixed desktop entry consumes one renewed task-brain or main-brain strategy but never a local counter retry',async t=>{
 for(const source of ['local','llm','main-review']){
  const h=fixture();h.native.close=()=>{};h.native.cancel=()=>{};let decision;const stop=Error('activation options captured');h.visual.activate=async options=>{decision=options;throw stop;};
  const service=new DesktopService({native:h.native});t.after(()=>service.close());service.task={id:'fixture-guidance-'+source,target:'notes',scene:'life',domain:'life',visibilityFloor:1,steps:[]};service.running=true;service.generation=1;service.controller=new AbortController();service.visualSessions=new Map([['notes',h.visual]]);service.actionControl={recovery:{action:'change_method',source,guidanceId:'strategy-one'}};
  await assert.rejects(service.run(1,{...service.task}),e=>e===stop);assert.equal(decision.retry,source!=='local');assert.equal(decision.retryKey,source==='local'?undefined:'strategy-one');
 }
});
async function scenario({occupied=false,typeFails=false,sendFails=false,readbackFails=false,nativeFallback=false}={}){
 const calls=[],journal=[],outcomes=[],marker='[workbunny:visual-test]';let draft='',submissions=0,plans=0;
 const row=(text,y,x=.3)=>({text,x,y,width:.5,height:.025,confidence:.99});
 const native={request:async(op,payload={})=>{
  calls.push({op,payload});
  if(op==='frontmost'&&nativeFallback)return {application:{bundleId:'com.tencent.workbuddy.mac',pid:5},windows:[{pid:5,windowId:7,layer:0,rect:{x:1,y:1,width:200,height:140}}]};
  if(op==='workbuddyInspect'&&nativeFallback)throw Object.assign(Error('AX unavailable'),{dispatched:false});
  if(op==='displayCapture'){const image=raster(200,140);if(draft||occupied)paint(image,{x:.1,y:.7,width:.8,height:.2},230);return {pngBase64:encode(image).toString('base64'),desktopRect:rect,width:200,height:140,backend:'CGDisplayStream',capturedAt:Date.now()};}
  if(op==='displayInput'){
   if(payload.action==='type'){draft=payload.text;if(typeFails)throw Error('type acknowledgement lost');}
   if(payload.action==='key'){submissions++;if(sendFails)throw Error('send acknowledgement lost');}
   return {performed:true};
  }
  throw Error('forbidden fixture native op '+op);
 },cancel:async()=>{},close:async()=>{}};
 const verificationRequest=async options=>{
  let data;try{data=JSON.parse(options.messages.find(m=>m.role==='user').content[0].text);}catch{}
  if(data?.question)return {response:{text:JSON.stringify({matched:draft===data.evidence.expectedText&&!readbackFails,evidence:'actual original draft, model and conversation marker are visible'})}};
  return {response:{text:JSON.stringify({software:'WorkBuddy',available:true,unique:true,active:true,sameIdentity:true,region:{x:0,y:0,width:1,height:1},mainRegion:{x:0,y:0,width:1,height:1},identityRegion:{x:.1,y:.02,width:.6,height:.1},monitorRegions:[{x:.1,y:.2,width:.8,height:.65}],focusRegion:{x:.2,y:.7,width:.6,height:.2},focusEvidence:'visible text caret in original composer',evidence:'unique original conversation identity',texts:[row(marker,.3),row('DeepSeek-V4.1-Flash',.1),row(draft?(readbackFails?'unreadable draft':draft):(occupied?'existing draft':'输入消息'),.75)]})}};
 };
 const desktop=new DesktopService({native,imageResize:bytes=>bytes,imageCrop:crop,bitmap,verificationRequest,persist:async task=>journal.push(structuredClone(task)),strategies:{preferVisual:async()=>!nativeFallback,record:async(_,value)=>outcomes.push(value)},planner:async()=>++plans===1?{action:'type',text:'placeholder',focus:{x:.5,y:.8}}:{action:'key',key:'enter',purpose:'submit'},observeWorkBuddy:async()=>({taskId:4,messageKey:'old',sessionId:'s1',status:'ok'})});
 desktop.task={id:'visual-test',target:'workbuddy',goal:'test',scene:'life',domain:'life',visibilityFloor:1,associationMarker:marker,sessionId:'s1',monitorTaskId:4,monitorMessageKey:'old',workModel:'deepseek-v4.1-flash',handoffSent:true,followUpRound:0,status:'review',steps:[],submittedAt:Date.now()-5000};
 desktop.ensureWorkBuddyMonitor=async()=>{desktop.running=false;return true;};
 const result=await desktop.followUp({text:'补充数据'});return {result,desktop,calls,journal,outcomes,submissions,draft};
}
test('forced visual follow-up independently locates pixels and commits the round before exactly one submit',async t=>{
 const h=await scenario();t.after(()=>h.desktop.close());assert.equal(h.result.ok,true,h.result.error);assert.equal(h.submissions,1);assert.equal(h.desktop.task.previousMonitorMessageKey,'old');assert(h.journal.some(task=>task.followUpPending?.state==='unknown'&&task.followUpRound===1));assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));assert.deepEqual(h.outcomes,[]);
 const input=h.calls.find(c=>c.op==='displayInput'&&c.payload.action==='click');assert.equal(input.payload.x,500);assert.equal(input.payload.y,560);assert(!JSON.stringify(input.payload).match(/windowId|bundleId|"pid"|expected/u));
});
test('an explicit structured attempt may fail before independent visual recovery, whose scope does not inherit AX geometry',async t=>{
 const h=await scenario({nativeFallback:true});t.after(()=>h.desktop.close());assert.equal(h.result.ok,true,h.result.error);const first=h.calls.findIndex(c=>c.op==='displayCapture');assert(h.calls.slice(0,first).some(c=>c.op==='workbuddyInspect'));assert(h.calls.slice(first).every(c=>['displayCapture','displayInput'].includes(c.op)));assert.equal(h.calls.find(c=>c.op==='displayInput').payload.x,500);assert.equal(h.submissions,1);assert(h.outcomes.includes('failed'));
});
test('an occupied original draft is preserved without any pointer or text input',async t=>{
 const h=await scenario({occupied:true});t.after(()=>h.desktop.close());assert.equal(h.result.ok,false);assert.equal(h.submissions,0);assert(!h.calls.some(c=>c.op==='displayInput'));
});
test('unreadable draft readback cannot authorize the following submission',async t=>{
 const h=await scenario({readbackFails:true});t.after(()=>h.desktop.close());assert.equal(h.result.ok,false);assert.equal(h.submissions,0);assert.equal(h.desktop.task.followUpPending.state,'draft-unknown');assert(h.draft);
});
test('lost text acknowledgement preserves the intent and never repeats the input or sends',async t=>{
 const h=await scenario({typeFails:true});t.after(()=>h.desktop.close());assert.equal(h.result.ok,false);assert.equal(h.submissions,0);assert.equal(h.desktop.task.followUpPending.state,'draft-unknown');const inputs=h.calls.filter(c=>c.op==='displayInput').length;assert.equal((await h.desktop.followUp({text:'再试一次'})).ok,false);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,inputs);
});
test('lost submit acknowledgement leaves an unknown round and never resubmits on another follow-up',async t=>{
 const h=await scenario({sendFails:true});t.after(()=>h.desktop.close());assert.equal(h.result.ok,false);assert.equal(h.submissions,1);assert.equal(h.desktop.task.followUpPending.state,'unknown');assert.equal((await h.desktop.followUp({text:'再试一次'})).ok,false);assert.equal(h.calls.filter(c=>c.op==='displayInput'&&c.payload.action==='key').length,1);
});
