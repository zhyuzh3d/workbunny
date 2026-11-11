'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AgentService}=require('../src/main/agent-service'),{DesktopService}=require('../src/main/desktop-service');
const {taskGuidance}=require('../src/main/task-presentation');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<500&&!check();i++)await pause(2);assert(check(),'fixture deadline');}
test('restore only reads and logs an unknown work checkpoint; explicit continuation uses the same draft without start or resume',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-draft-stage-')),records=new Map(),logs=[];let recoveries=0,starts=0,resumes=0,idle=false;
 const journal={put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()].map(t=>structuredClone(t)),authorized:async()=>true};
 const physical={id:'physical-draft',target:'workbuddy',status:'paused',scene:'life',domain:'life',visibilityFloor:1,draftInserted:true,draftInsertedAt:1,goal:'private-physical-goal',outboundText:'private-exact-draft',steps:[{action:'type',purpose:'task',state:'input-sent',at:1}]};
 const desktop={task:physical,running:false,publicStatus:()=>({}),emit:()=>{},journal:async()=>{},observeWorkBuddy:async()=>null,stop:async()=>{},start:async()=>{starts++;throw Error('must not start');},resume:async()=>{resumes++;throw Error('must not refill');},recoverWorkBuddySubmission:async options=>{recoveries++;await options.authorize();Object.assign(physical,{handoffSent:true,sessionId:'fixture-session',monitorSessionId:'fixture-session',monitorMessageKey:'fixture-message'});return {ok:true,verified:true,jobId:physical.id,sessionId:physical.sessionId};}};
 const make=()=>new AgentService({desktop,journal,scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},taskDirectory:root,ready:()=>true,epoch:()=>1,canOperate:async()=>idle,autoSchedule:false,log:(...x)=>logs.push(x)});
 let agent=make();try{
  const created=await agent.start({skill:'work.delegate',goal:'fixture work',subjects:[{application:'workbuddy'}]}, {role:'owner',verified:true,sources:['fixture-owner'],scene:'life'},{ownerRequest:'private-owner-canary'});
  let task=agent.runtime.tasks.get(created.id);physical.sources=[task.id];task.state.workOperationId=physical.id;task.status='needs_attention';task.operations.submit={id:'submit',tool:'work.submit',effect:'write',status:'intent',args:{application:'workbuddy'}};await agent.runtime.save(task);await agent.close();
  agent=make();await agent.restore();task=agent.runtime.tasks.get(created.id);assert.equal(task.state.workCheckpoint.phase,'draft-ready');assert(logs.some(x=>JSON.stringify(x).includes('restored-submission-checkpoint')));assert(!JSON.stringify(logs).includes('private-'));
  await agent.recoverPending();assert.equal(recoveries,0);assert.equal(starts,0);assert.equal(resumes,0);assert.equal(task.operations.submit.status,'intent');
  assert((await agent.resolveAttention(task.id)).ok);await until(()=>!agent.recovering);assert.equal(recoveries,0,'active desktop admission remains authoritative');
  idle=true;task.state.reconciliation.submit.at=0;await agent.recoverPending();assert.equal(recoveries,1);assert.equal(starts,0);assert.equal(resumes,0);assert.equal(task.operations.submit.status,'confirmed');assert.equal(task.state.workOperationId,'physical-draft');assert.equal(physical.outboundText,'private-exact-draft');assert.equal(task.state.ownerRequest,'private-owner-canary');
 }finally{await agent.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('a recorded input intent remains uncertain even if a legacy boolean is missing',async()=>{
 const physical={target:'workbuddy',steps:[{action:'type',purpose:'task',state:'intent',at:1}],note:'receipt unavailable'},ctx={desktop:{running:false}};
 const result=await AgentService.prototype.waitForWorkSubmission.call(ctx,physical,new AbortController().signal);assert.equal(result.dispatched,undefined);
 const task={skill:'work.delegate',status:'needs_attention',state:{workCheckpoint:{phase:'draft-ready'}},operations:{submit:{id:'submit',effect:'write',tool:'work.submit',status:'intent'}}};assert.equal(taskGuidance(task).title,'原草稿待继续');task.state.workCheckpoint.phase='input-unknown';assert.equal(taskGuidance(task).title,'草稿写入待核对');
});
test('own interactive regions reject pointer operations before dispatch while keyboard and human UI remain available',async()=>{
 const {fixture}=require('./support/visual-fixture.cjs'),h=fixture(),logs=[];
 h.location={...h.location,software:'WorkBuddy',region:{x:0,y:0,width:1,height:1},mainRegion:{x:0,y:0,width:1,height:1}};
 const nativeRequest=h.native.request;h.native.request=async(...args)=>{const result=await nativeRequest(...args);return args[0]==='displayCapture'?{...result,desktopRect:{x:-100,y:20,width:1000,height:800}}:result;};h.native.close=async()=>{};
 const visualRequest=h.visual.request;h.visual.request=async options=>options.messages[0].content.includes('定位指定软件')?visualRequest(options):{response:{text:'{"matched":true,"evidence":"Synthetic complete task draft and submit conditions are visible"}'}};
 const service=new DesktopService({native:h.native,imageCrop:h.crop,bitmap:h.bitmap,pointerBlocked:p=>p.x===400&&p.y===420,log:x=>logs.push(x)});service.visualSessions=new Map([['workbuddy',h.visual]]);
 service.task={id:'fixture',scene:'life',domain:'life',visibilityFloor:1,target:'workbuddy',outboundText:'fixture'};service.running=true;service.generation=1;service.controller=new AbortController();
 const scope={...h.visual.identity(),target:'workbuddy'},shot=await service.capture(scope,1);
 try{
  await assert.rejects(service.act({action:'click',purpose:'submit',x:.5,y:.5},scope,shot,1),e=>e.code==='E_GUI_POINTER_BLOCKED'&&e.dispatched===false);assert(!h.calls.some(c=>c.op==='displayInput'));
  await assert.rejects(service.act({action:'type',purpose:'task',text:'fixture',focus:{x:.5,y:.5}},scope,shot,1),e=>e.code==='E_GUI_POINTER_BLOCKED'&&e.dispatched===false);assert(!h.calls.some(c=>c.op==='displayInput'));
  await service.act({action:'key',purpose:'submit',key:'enter',modifiers:[]},scope,shot,1);assert.equal(h.calls.filter(c=>c.op==='displayInput'&&c.args.action==='key').length,1);assert(logs.some(x=>x.stage==='pointer-blocked'));assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
 }finally{await service.close();}
});
