'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService,preflightWorkModel}=require('../src/main/desktop-service');
const wb=require('../src/main/workbuddy'),security=require('../src/main/owner-security'),budget=require('../src/main/context-budget');
const FLASH='deepseek-v4.1-flash',pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const deadline=Date.now()+2000;while(!check()&&Date.now()<deadline)await pause(2);assert(check(),'fixture deadline exceeded');}
function model(extra={}){return {id:FLASH,credits:'x0.11',supportsImages:true,supportsReasoning:true,reasoning:{supportedEfforts:['low','high']},...extra};}
function harness(t,initial=model({contextWindow:{defaultLength:300000},maxInputTokens:1000000,maxOutputTokens:4096})){
 const previous={request:wb.request,chat:wb.chat},requests=[],scopes=[];let row=initial,reads=0;
 wb.request=async()=>{reads++;return {body:JSON.stringify({code:0,data:{models:[row]}})};};
 wb.chat=options=>security.withPrinciples(async actual=>{requests.push(actual);const fit=budget.fitRequest({...actual,provider:'workbuddy'});requests.at(-1).fixtureBudget=fit.contextBudget;return {model:actual.model,text:'{"action":"wait","waitMs":1000,"reason":"fixture"}'};},options);
 const native={request:async op=>{assert.equal(op,'permissions');return {accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true};},cancel:async()=>{},close:async()=>{}};
 const service=new DesktopService({native,persist:async()=>{}});
 const shot={revision:1,at:Date.now(),rect:{x:0,y:0,width:1000,height:800},preview:'data:image/jpeg;base64,fixture',ocr:[]};
 service.run=async(gen,scope)=>{scopes.push(scope);service.task.scope={bundleId:'com.tencent.workbuddy.mac',pid:123,windowId:7};await service.nextAction(scope,shot,service.controller.signal);service.assertLive(gen);service.running=false;service.task.status='review';};
 t.after(async()=>{await service.close();Object.assign(wb,previous);});
 return {service,requests,scopes,shot,reads:()=>reads,setModel:value=>{row=value;}};
}
test('preflight preserves the legacy model ID and optionally returns only normalized observed capacity',async t=>{
 const h=harness(t);
 assert.equal(await preflightWorkModel(FLASH),FLASH);
 assert.deepEqual(await preflightWorkModel(FLASH,undefined,{includeCapacity:true}),{model:FLASH,capacity:{contextWindow:300000,maxInputTokens:1000000,maxOutputTokens:4096}});
 h.setModel(model({contextWindow:'not-a-limit',maxInputTokens:-1,maxOutputTokens:0}));
 assert.deepEqual((await preflightWorkModel(FLASH,undefined,{includeCapacity:true})).capacity,{});
});
test('the actual start preflight reaches a multimodal planning request despite an empty global capacity cache',async t=>{
 const h=harness(t);
 assert.equal(budget.limits({provider:'workbuddy',model:FLASH,maxTokens:2048}).context,32768);
 assert((await h.service.start({target:'workbuddy',goal:'制作一个小游戏并发布分享链接',workContext:{mode:'none'},workModel:FLASH})).ok);
 await until(()=>!h.service.running);assert.equal(h.service.task.status,'review');assert.equal(h.reads(),1);
 const request=h.requests[0];assert.equal(request.contextWindow,300000);assert.equal(request.maxInputTokens,1000000);assert.equal(request.fixtureBudget.inputBudget,budget.limits(request).inputBudget);
 assert(request.fixtureBudget.estimate>25088,'this real planning shape includes rules, principles, a short task and one image');
 assert.equal(budget.limits({provider:'workbuddy',model:FLASH,maxTokens:2048}).context,32768,'request evidence does not mutate or depend on global cache');
});
test('resume rechecks capacity and passes the current repair profile and original operating knowledge without rewriting them',async t=>{
 const h=harness(t);await h.service.start({target:'workbuddy',goal:'制作一个小游戏并发布分享链接',workContext:{mode:'none'},workModel:FLASH});await until(()=>!h.service.running);
 h.service.task.repairProfile={contextLevel:0};h.service.task.operatingKnowledge=[{id:'fixture-knowledge',application:'workbuddy',summary:'fixture experience'}];
 const originalId=h.service.task.id,originalOutbound=h.service.task.outboundText;
 h.setModel(model({contextWindow:200000,maxInputTokens:100000,maxOutputTokens:1024}));
 assert((await h.service.resume({repairProfile:{contextLevel:1}})).ok);await until(()=>!h.service.running);
 assert.equal(h.requests.at(-1).contextWindow,200000);assert.equal(h.requests.at(-1).maxInputTokens,100000);assert.equal(h.requests.at(-1).maxTokens,1024);assert.equal(h.reads(),2);
 assert.deepEqual(h.scopes.at(-1).repairProfile,{contextLevel:1});assert.deepEqual(h.scopes.at(-1).operatingKnowledge,h.service.task.operatingKnowledge);assert.deepEqual(h.service.task.repairProfile,{contextLevel:0});
 assert.equal(h.service.task.id,originalId);assert.equal(h.service.task.outboundText,originalOutbound);
 h.service.task.status='paused';assert((await h.service.resume()).ok);await until(()=>!h.service.running);assert.deepEqual(h.scopes.at(-1).repairProfile,{contextLevel:0});
});
test('capacity from a different generation, task or model cannot be reused by planning',async t=>{
 const h=harness(t);await h.service.start({target:'workbuddy',goal:'制作一个小游戏并发布分享链接',workContext:{mode:'none'},workModel:FLASH});await until(()=>!h.service.running);
 const original=h.service.planningCapacity,scope=h.scopes[0];
 for(const patch of [{generation:original.generation-1},{taskId:'different-task'},{model:'hy3'}]){
  h.service.planningCapacity={...original,...patch};
  await assert.rejects(h.service.nextAction(scope,h.shot,new AbortController().signal),{code:'E_CONTEXT_BUDGET'});
  assert.equal(h.requests.at(-1).contextWindow,undefined);assert.equal(h.requests.at(-1).maxInputTokens,undefined);
 }
});
test('a new preflight without capacity does not inherit the previous successful capacity',async t=>{
 const h=harness(t);await h.service.start({target:'workbuddy',goal:'制作一个小游戏并发布分享链接',workContext:{mode:'none'},workModel:FLASH});await until(()=>!h.service.running);
 h.setModel(model());assert((await h.service.resume()).ok);await until(()=>!h.service.running);
 assert.equal(h.service.task.errorCode,'E_CONTEXT_BUDGET');assert.equal(h.requests.at(-1).contextWindow,undefined);assert.deepEqual(h.service.planningCapacity.capacity,{});
});
test('a genuinely smaller observed capacity still rejects an oversized visual request',async t=>{
 const h=harness(t,model({contextWindow:12000,maxInputTokens:11000}));await h.service.start({target:'workbuddy',goal:'制作一个小游戏并发布分享链接',workContext:{mode:'none'},workModel:FLASH});await until(()=>!h.service.running);
 assert.equal(h.service.task.errorCode,'E_CONTEXT_BUDGET');assert.equal(h.requests[0].contextWindow,12000);assert.equal(h.requests[0].maxInputTokens,11000);
});
test('a cancelled late preflight cannot install capacity or start planning',async t=>{
 const h=harness(t);let release,entered=false;
 wb.request=async()=>{entered=true;return new Promise(r=>{release=()=>r({body:JSON.stringify({data:{models:[model({contextWindow:300000})]}})});});};
 const pending=h.service.start({target:'workbuddy',goal:'制作一个小游戏并发布分享链接',workContext:{mode:'none'},workModel:FLASH});await until(()=>entered);
 await h.service.stop('fixture cancellation');release();assert.equal((await pending).ok,false);assert.equal(h.requests.length,0);assert.equal(h.service.planningCapacity,undefined);assert.equal(h.service.guiLeaseHeld,false);
});
