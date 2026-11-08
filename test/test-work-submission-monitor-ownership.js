'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service'),{workSubmissionState}=require('../src/main/workbuddy-observation');
function fixture(origin='agent'){
 let status='running',reads=0;const saved=[];
 const service=new DesktopService({native:{cancel:async()=>{},close:async()=>{},request:async()=>assert.fail('receipt monitoring never operates the desktop')},persist:async task=>saved.push(structuredClone(task)),observeWorkBuddy:async()=>{reads++;return status?{sessionId:'fixture-session',taskId:1,messageKey:'fixture-message',status,startedAt:1,updatedAt:Date.now(),summary:'fixture result'}:null;}});
 service.task={id:'fixture',origin,target:'workbuddy',goal:'fixture business',domain:'life',scene:'life',visibilityFloor:1,submittedAt:1,submitAttemptedAt:1,steps:[{action:'key',purpose:'submit',state:'input-sent',at:1}]};service.running=true;service.generation=1;service.controller=new AbortController();
 return {service,saved,reads:()=>reads,setStatus:value=>{status=value;}};
}
test('Task-owned normal submission releases the desktop runner after its durable receipt while business is still running',async()=>{
 const h=fixture();try{await h.service.acquireGuiLease();assert.equal(await h.service.ensureWorkBuddyMonitor(1,{}),true);assert.equal(h.service.running,false);assert.equal(h.service.guiLeaseHeld,false);assert.equal(h.service.monitorPromise,null);assert.equal(h.reads(),1);assert.equal(h.service.task.status,'monitoring');assert.equal(workSubmissionState(h.service.task).phase,'confirmed');assert(h.saved.some(t=>t.handoffSent&&t.monitorSessionId==='fixture-session'));}finally{await h.service.close();}
});
test('legacy desktop-owned monitoring retains its completion lifetime',async()=>{
 const h=fixture('panel');try{let resolved=false;const work=h.service.ensureWorkBuddyMonitor(1,{}).then(value=>{resolved=true;return value;});await new Promise(r=>setTimeout(r,5));assert.equal(resolved,false);assert.equal(h.service.running,true);h.setStatus('ok');assert.equal(await work,true);assert.equal(h.service.task.status,'review');assert.equal(h.service.running,false);}finally{await h.service.close();}
});
test('unconfirmed Task-owned monitoring ends in a preserved submit barrier without any retry',async()=>{
 const h=fixture(),timer=global.setTimeout;h.setStatus(null);global.setTimeout=(fn,ms,...args)=>timer(fn,ms===1200?0:ms,...args);try{assert.equal(await h.service.ensureWorkBuddyMonitor(1,{}),true);assert.equal(h.service.task.status,'paused');assert.equal(h.service.running,false);assert.equal(workSubmissionState(h.service.task).phase,'submission-unknown');assert.equal(h.service.task.steps.length,1);assert.equal(h.reads(),25);}finally{global.setTimeout=timer;await h.service.close();}
});
for(const status of ['running','ok'])test(`late ${status} receipt persistence cannot stop a newer desktop runner`,async()=>{
 const h=fixture();h.setStatus(status);let release,entered;
 const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),persist=h.service.persist;let first=true;
 h.service.persist=async task=>{if(first){first=false;entered();await gate;}return persist(task);};
 try{
  const work=h.service.ensureWorkBuddyMonitor(1,{});const rejected=assert.rejects(work,/任务已停止/);
  await waiting;await h.service.stop('fixture stop');
  const next={id:'new-fixture',target:'workbuddy',domain:'life',scene:'life',visibilityFloor:1,status:'running',steps:[]};
  h.service.task=next;h.service.generation++;h.service.running=true;h.service.controller=new AbortController();
  release();await rejected;
  assert.equal(h.service.running,true);assert.equal(h.service.task,next);assert.equal(next.status,'running');
 }finally{release?.();await h.service.close();}
});
