'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ToolRegistry}=require('../src/main/agent-tools'),{registerScreenTools}=require('../src/main/screen-watch-skill'),{GuiLease}=require('../src/main/gui-lease');
const {fixture}=require('./support/visual-fixture.cjs');
function setup(){
 const h=fixture();h.advance(Date.now()-100000);const tools=new ToolRegistry(),lease=new GuiLease();let beforeModel=async()=>{};
 registerScreenTools(tools,{native:h.native,bitmap:h.bitmap,imageCrop:h.crop,lease,request:async()=>{await beforeModel();return {response:{text:JSON.stringify(h.location)}};}});
 const task={id:'synthetic-reset-task',skill:'software.execute',goal:'Inspect the requested document',subjects:[{application:'demo'}],capabilities:['screen.read','screen.input'],authority:{source:'synthetic-owner'},state:{},operations:{pending:{id:'pending',effect:'write',status:'intent',inputOutcome:{completion:'unknown'}}}};
 const run=async(name,args={},signal)=>{const checked=tools.check(name,{application:'demo',...args},task);return checked.tool.execute(checked.input,{task,signal,operationId:'synthetic-'+name});};
 return {h,tools,task,lease,run,setBeforeModel:fn=>beforeModel=fn};
}
test('Bunny can discard a disproved visual anchor and locate fresh pixels without changing goal, authority or unknown receipts',async()=>{
 const f=setup(),first=await f.run('screen.observe'),old=f.task.state.screenAnchors.demo.sessionId,operations=structuredClone(f.task.operations),authority=structuredClone(f.task.authority);f.h.paint(f.h.image,f.h.location.identityRegion);f.h.location={...f.h.location,sameIdentity:false};
 await assert.rejects(f.run('screen.observe',{force:true}),/锚点已变化/);f.task.state.screenCommitted={demo:first.frameId};f.task.state.screenSamples={[f.task.id+':demo:sample']:{frameId:first.frameId}};f.task.state.latestImage={application:'demo',frameId:first.frameId};const captures=f.h.calls.length;
 const result=await f.run('screen.reset');assert(result.reset);assert(result.requiresObservation);assert.equal(f.h.calls.length,captures,'reset must not capture or input');assert.equal(f.task.state.screenAnchors.demo,undefined);assert.equal(f.task.state.screenCommitted.demo,undefined);assert.deepEqual(f.task.state.screenSamples,{});assert.equal(f.task.state.latestImage,undefined);assert.deepEqual(f.task.operations,operations);assert.deepEqual(f.task.authority,authority);assert.equal(f.task.goal,'Inspect the requested document');
 const fresh=await f.run('screen.observe');assert(fresh.available);assert.notEqual(f.task.state.screenAnchors.demo.sessionId,old);assert(f.h.calls.every(c=>c.op==='displayCapture'));assert(f.tools.catalog(undefined,f.task).find(t=>t.name==='screen.reset').inputSchema.required.includes('application'));
});
test('reset refuses to invalidate another Task input lease and respects cancellation',async()=>{
 const f=setup();await f.run('screen.observe');const old=f.task.state.screenAnchors.demo.sessionId;await f.lease.acquire('other-task-input');await assert.rejects(f.run('screen.reset'),e=>e.code==='E_GUI_BUSY'&&e.dispatched===false);assert.equal(f.task.state.screenAnchors.demo.sessionId,old);f.lease.release('other-task-input');
 const c=new AbortController();c.abort();await assert.rejects(f.run('screen.reset',{},c.signal),e=>e.code==='ABORT_ERR');assert.equal(f.task.state.screenAnchors.demo.sessionId,old);assert(f.lease.isFree());
});
test('a late location response from the reset session cannot restore an old anchor',async()=>{
 const f=setup();await f.run('screen.observe');const entered=Promise.withResolvers(),release=Promise.withResolvers();f.setBeforeModel(async()=>{entered.resolve();await release.promise;});const late=f.run('screen.observe',{force:true});await entered.promise;await f.run('screen.reset');release.resolve();await assert.rejects(late,e=>e.code==='E_VISUAL_TARGET');assert.equal(f.task.state.screenAnchors.demo,undefined);f.setBeforeModel(async()=>{});assert((await f.run('screen.observe')).available);
});
