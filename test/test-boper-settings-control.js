'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DesktopService,INPUT_BACKEND_CHANGE_CAUSE}=require('../src/main/desktop-service');
const {GuiLease}=require('../src/main/gui-lease');
const {changeInputMode}=require('../src/main/boper-settings-control');
function fixture(t){
 const lease=new GuiLease(),events=[],saved=[];
 const controllers=['primary','watch','alerts'].map(owner=>new DesktopService({owner,lease,native:{cancel:async()=>events.push('cancel:'+owner),close:async()=>{},request:async()=>{throw Error('must not send input');}},persist:async task=>saved.push(structuredClone(task))}));
 t.after(async()=>{for(const controller of controllers)await controller.close();});
 const boper={stop:async cause=>{assert.equal(cause,INPUT_BACKEND_CHANGE_CAUSE);events.push('global-stop');},setEnabledIntent:value=>{assert.equal(value,true);events.push('intent');},enable:async()=>{events.push('enable');return {enabled:true,state:'requires-approval'};},openSettings:async()=>{events.push('approval-page');},disable:async()=>{events.push('disable');return {enabled:false};}};
 const ensureDriver=async()=>{assert(lease.isFree());events.push('installer');};
 return {controllers,lease,events,saved,boper,ensureDriver};
}
test('the actual settings enable flow accepts idle real controllers before preparing the driver',async t=>{
 const f=fixture(t),status=await changeInputMode({...f,action:'enable'});
 assert.equal(status.enabled,true);assert.equal(status.state,'requires-approval');assert.match(status.note,/WorkBunny/);assert.deepEqual(f.events,['global-stop','intent','installer','enable','approval-page']);
 for(const controller of f.controllers)assert.equal(controller.running,false);
});
test('changing input backend suspends live controllers without discarding drafts or submission uncertainty',async t=>{
 const f=fixture(t),controller=f.controllers[0];controller.task={id:'fixture',target:'workbuddy',status:'running',goal:'preserve',outboundText:'retained unsent draft',submitAttemptedAt:123,steps:[{action:'workbuddySend',state:'unknown'}]};
 controller.running=true;controller.controller=new AbortController();await controller.acquireGuiLease();
 const before=structuredClone(controller.task);await changeInputMode({...f,action:'enable'});
 assert(controller.controller.signal.aborted);assert(f.lease.isFree());assert.equal(controller.task.status,'paused');
 assert.equal(controller.task.controllerLifecycle.intent,'host-suspend');assert.equal(controller.task.controllerLifecycle.cause,INPUT_BACKEND_CHANGE_CAUSE);assert.equal(controller.task.controllerLifecycle.terminal,false);
 assert.equal(controller.task.outboundText,before.outboundText);assert.equal(controller.task.submitAttemptedAt,123);assert.deepEqual(controller.task.steps,before.steps);assert.equal(f.saved.at(-1).controllerLifecycle.cause,INPUT_BACKEND_CHANGE_CAUSE);
 assert(f.events.indexOf('cancel:primary')<f.events.indexOf('installer'));
});
test('a failed controller pause still attempts global stop but never starts installation or enables input',async t=>{
 const f=fixture(t);f.controllers[1].suspend=async()=>{throw Error('pause failed');};
 await assert.rejects(changeInputMode({...f,action:'enable'}),/pause failed/);
 assert.deepEqual(f.events,['global-stop']);
});
test('disable uses the same recognized suspension path without preparing driver components',async t=>{
 const f=fixture(t),status=await changeInputMode({...f,action:'disable'});assert.equal(status.enabled,false);assert.deepEqual(f.events,['global-stop','disable']);
});
test('unknown suspension causes are still rejected before changing controller state',async t=>{
 const f=fixture(t);await assert.rejects(f.controllers[0].suspend({cause:'unregistered-cause'}),/未知的控制器挂起原因/);assert.equal(f.controllers[0].generation,0);assert.deepEqual(f.events,[]);
});
test('UI and terminal cannot overlap one helper installation, and the guard releases after completion',async t=>{
 const f=fixture(t),pending=Promise.withResolvers();let installs=0;
 f.ensureDriver=async()=>{installs++;await pending.promise;};
 const first=changeInputMode({...f,action:'enable'});await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(changeInputMode({...f,action:'enable'}),{code:'E_BOPER_BUSY'});assert.equal(installs,1);
 pending.resolve();await first;assert.equal((await changeInputMode({...f,action:'disable'})).enabled,false);
});
