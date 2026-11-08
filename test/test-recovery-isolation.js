'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service');
const secret='private-canary@example.invalid /private/canary-file';
const task=id=>({id,skill:'work.delegate',status:'needs_attention',state:{job:{jobId:'physical-'+id}},operations:{}});
test('one unreadable physical record cannot abort restoration of other work receipts and logs exclude private errors',async()=>{
 const tasks=[task('bad'),task('good')],reads=[],logs=[],context={runtime:{tasks:new Map(tasks.map(t=>[t.id,t]))},log:(...args)=>logs.push(args),workOperation:async t=>{reads.push(t.id);if(t.id==='bad')throw Error(secret);return {status:'accepted'};}};
 await AgentService.prototype.repairLegacyWorkReceipts.call(context);assert.deepEqual(reads,['bad','good']);assert.equal(logs[0][1].stage,'restore-work-receipts');assert.equal(logs[0][1].taskId,'bad');assert(!JSON.stringify(logs).includes(secret));assert(!JSON.stringify(logs).includes('canary'));
});
test('a broken maintenance task and a throwing diagnostic logger do not block the next task or reset',async()=>{
 const bad=task('bad'),good=task('good'),resumed=[];Object.defineProperty(bad,'operations',{get(){throw Error(secret);}});good.operations={submit:{id:'submit',tool:'work.submit',effect:'write',status:'intent'}};let checkpoint=false;
 const context={ready:()=>true,log:()=>{throw Error('logger unavailable');},runtime:{tasks:new Map([['bad',bad],['good',good]]),save:async()=>{}},workRecoveryRequests:new Set(),reconcile:async()=>({ok:true}),control:async(action,id)=>resumed.push(id),refreshPriorResultCheckpoints:async()=>{checkpoint=true;}};
 await AgentService.prototype.recoverPending.call(context);assert.deepEqual(resumed,['good']);assert.equal(checkpoint,true);assert.equal(context.recovering,false);
});
test('runtime restoration skips one malformed task while preserving its stored data and restoring the next',async()=>{
 const records=new Map(),logs=[],service=new AgentService({journal:{put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()].map(t=>structuredClone(t)),authorized:async()=>true},scene:{native:{request:async()=>assert.fail('no native calls')},metrics:{},close:async()=>{}},epoch:()=>1,autoSchedule:false,log:(...args)=>logs.push(args)});
 try{
  for(let i=0;i<2;i++)await service.start({skill:'work.delegate',goal:'offline '+i,subjects:[{application:'workbuddy'}]},{role:'owner',verified:true,sources:['fixture-owner'],scene:'life'});
  const ids=[...records.keys()],bad=records.get(ids[0]);bad.operations=null;records.set(ids[0],bad);
  const result=await service.runtime.restore();assert.equal(result.restored,1);assert.equal(result.skipped,1);assert.equal(service.runtime.tasks.has(ids[1]),true);assert.equal(records.get(ids[0]).operations,null);assert(logs.some(row=>row[1]?.stage==='restore-task-record'));assert(!JSON.stringify(logs).includes('canary'));
 }finally{await service.close();}
});
test('an old host cancellation promise cannot replace a genuine business stop',async()=>{
 const value={id:'logical',state:{stopRequest:{}},operations:{}},physical={id:'physical',target:'wechat',sources:['logical']};let stops=0;const handlers=[];
 const desktop={task:physical,actionStopPromise:Promise.resolve({suspended:true}),actionStopKind:'host-suspend',actionStopJobId:'physical',stop:async(_reason,{cause})=>{stops++;physical.controllerLifecycle={terminal:true,intent:cause};}};
 const context={desktop,resources:{record:async(_id,entry,handler)=>{value.state.resources[entry.id]=entry;handlers.push(handler);},cleanup:async()=>{for(const handler of handlers)await handler();return [];}}};
 await AgentService.prototype.stopTask.call(context,value);assert.equal(stops,1);assert.equal(physical.controllerLifecycle.intent,'business-stop');assert.equal(desktop.actionStopKind,'business-stop');
 await AgentService.prototype.stopTask.call(context,value);assert.equal(stops,1,'only the matching terminal stop receipt is reusable');
});
