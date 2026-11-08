'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const budget=require('../src/main/context-budget'),repair=require('../src/main/self-repair');
const {withPrinciples}=require('../src/main/owner-security');
const {DesktopService}=require('../src/main/desktop-service');

test('the real visual planner and principles wrapper expose an internal budget failure without GUI dispatch',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-planning-budget-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 require('../src/main/model-catalog').setPath(path.join(dir,'missing-catalog.json'));
 const logs=[];let transports=0;
 const service=new DesktopService({log:entry=>logs.push(entry),modelRequest:options=>withPrinciples(opts=>{
   budget.fitRequest({...opts,provider:'workbuddy'});transports++;throw Error('fixture must fail before transport');
 },options)});
 const scope={id:'fixture-request',goal:'制作一个教学游戏并交付链接',taskText:'制作一个教学游戏并交付链接',agentGoal:'恢复同一任务；尚未输入正文',target:'workbuddy',workModel:'deepseek-v4.1-flash',associationMarker:'[workbunny:fixture-request]',outboundText:'制作一个教学游戏并交付链接\n[workbunny:fixture-request]',startedAt:Date.now()};
 service.task={...scope,steps:[],scope:{bundleId:'fixture',pid:123,windowId:7},workContext:{mode:'none'},workRoute:{prepared:false,reason:'fixture missing locator'}};
 service.running=true;service.generation=1;service.controller=new AbortController();
 const shot={at:Date.now(),revision:1,rect:{x:0,y:0,width:1000,height:800},preview:'data:image/png;base64,AAAA',ocr:[]};
 try{
  await assert.rejects(service.planWithoutGui(scope,shot,1,1000),e=>{
   assert.equal(e.code,'E_CONTEXT_BUDGET');assert.equal(e.budget.context,32768);
   assert.equal(e.budget.imageCount,1);assert(e.budget.estimate>e.budget.inputBudget);
   assert.equal(e.budget.estimate,e.budget.textEstimate+e.budget.imageEstimate);
   assert(!e.message.includes('分段发送'));assert(!JSON.stringify(e.diagnostic).includes(scope.goal));return true;
  });
  assert.equal(transports,0);assert.equal(logs.length,1);assert.equal(logs[0].draftInserted,false);assert.equal(logs[0].submitAttempted,false);
  assert.equal(logs[0].diagnostic.budget.imageCount,1);assert(!service.task.draftInserted);assert(!service.task.submitAttemptedAt);
 }finally{await service.close();}
});

test('image bytes are accounted once as a multimodal part and never as opaque prompt text',()=>{
 const make=size=>({contextWindow:300000,maxTokens:2048,messages:[{role:'system',content:'fixture rules'},{role:'user',content:[{type:'text',text:'short owner request'},{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(size)}}]}]});
 const small=budget.fitRequest(make(10)),large=budget.fitRequest(make(100000));
 assert.equal(small.contextBudget.estimate,large.contextBudget.estimate);
 assert.equal(large.contextBudget.inputBudget,budget.limits(make(100000)).inputBudget);assert(large.messages[1].content[1].image_url.url.endsWith('A'.repeat(100000)));
});

test('budget diagnostics retain numeric facts across repair and do not renew recovery for size drift',async()=>{
 const task={skill:'fixture',inbox:[],state:{}},base={code:'E_CONTEXT_BUDGET',message:'same internal budget',diagnostic:{operation:'model-request',method:'context-budget',model:'fixture-model',budget:{context:32768,output:2048,inputBudget:25088,imageCount:1,estimate:27000,requestBytes:60000,privateGoal:'private-canary'}}};
 let context;
 await repair.advise({kind:'context',skill:'fixture',code:base.code,attempt:1,diagnostic:base.diagnostic,request:async options=>{context=JSON.parse(options.messages[1].content);return {response:{text:'{"action":"compact_context"}'}};}});
 assert.equal(context.diagnostic.budget.estimate,27000);assert(!JSON.stringify(context).includes('private-canary'));
 const drift={...base,diagnostic:{...base.diagnostic,budget:{...base.diagnostic.budget,estimate:27123,requestBytes:60456}}};
 assert.equal(repair.incident(task,base),repair.incident(task,drift));
 assert.notEqual(repair.incident(task,base),repair.incident(task,{...base,diagnostic:{...base.diagnostic,budget:{...base.diagnostic.budget,context:300000,inputBudget:64000}}}));
 assert.deepEqual(budget.diagnostic({context:Infinity,estimate:-1,requestBytes:'secret',imageCount:1}),{imageCount:1});
});
