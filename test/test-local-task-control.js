'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createLocalTaskControl}=require('../src/main/local-task-control');
function fixture(){
 let scene='life';const calls=[],task={id:'synthetic-task',scene:'life',domain:'life',visibilityFloor:1,skill:'software.execute',status:'paused',state:{},operations:{},actionRuns:{},inbox:[]};
 const memory={ready:true,generation:1,addMessage:async(...args)=>{calls.push(['source',...args]);return {id:'owner-source'};}};
 const agent={runtime:{tasks:new Map([[task.id,task]]),upgradeGoal:async id=>{calls.push(['upgrade',id]);return {ok:true};}},control:async(...args)=>{calls.push(['control',...args]);return {ok:true};},reconcile:async id=>({ok:true,id}),resolveAttention:async id=>({ok:true,id}),command:async(...args)=>{calls.push(['command',...args]);return {ok:true,id:task.id};}};
 return {task,memory,agent,calls,setScene:v=>{scene=v;},controls:createLocalTaskControl({getAgent:()=>agent,getMemory:()=>memory,getScene:()=>scene})};
}
test('status is non-content and control uses the original task ID and UI services',async()=>{
 const f=fixture();f.task.goal='do not expose goal';f.task.state.ownerRequest='do not expose owner';f.task.operations.op={status:'intent',inputOutcome:{moved:true,completion:'unknown'}};
 const status=f.controls.status({id:f.task.id});assert.equal(status.pendingInputCount,1);assert(!JSON.stringify(status).includes('do not expose'));
 await f.controls.control({id:f.task.id,operation:'pause'});assert.deepEqual(f.calls[0].slice(0,3),['control','pause',f.task.id]);await f.controls.control({id:f.task.id,operation:'upgrade'});assert.deepEqual(f.calls[1],['upgrade',f.task.id]);
});
test('command creates one owner source and uses the ordinary interpreter with cancellation and currentness',async()=>{
 const f=fixture(),controller=new AbortController();await f.controls.command({text:'  Synthetic goal  '},{signal:controller.signal});assert.equal(f.calls.length,2);
 const [,text,actor,options]=f.calls[1];assert.equal(text,'Synthetic goal');assert.equal(actor.originSourceId,'owner-source');assert.deepEqual(actor.sources,['owner-source']);assert.equal(actor.scene,'life');assert.equal(options.signal,controller.signal);assert(options.isCurrent());f.memory.generation++;assert(!options.isCurrent());
});
test('private or higher-floor records and non-life caller scenes are refused before effects',async()=>{
 const f=fixture();for(const mutation of [{scene:'private'},{domain:'private'},{visibilityFloor:2}]){
  const old={...f.task};Object.assign(f.task,mutation);assert.throws(()=>f.controls.status({id:f.task.id}),{code:'E_LOCAL_TASK_SCOPE'});await assert.rejects(f.controls.control({id:f.task.id,operation:'resume'}),{code:'E_LOCAL_TASK_SCOPE'});Object.assign(f.task,old);
 }
 for(const scene of ['private','work']){f.setScene(scene);await assert.rejects(f.controls.command({text:'test'}),{code:'E_LOCAL_SCENE'});assert.throws(()=>f.controls.status({id:f.task.id}),{code:'E_LOCAL_SCENE'});}assert.equal(f.calls.length,0);
});
test('generation changes or cancellation after source persistence never admit a late task',async()=>{
 const f=fixture();f.memory.addMessage=async()=>{f.memory.generation++;return {id:'source'};};await assert.rejects(f.controls.command({text:'test'}),{code:'E_LOCAL_STALE'});assert(!f.calls.length);
 const c=new AbortController();c.abort();await assert.rejects(f.controls.control({id:f.task.id,operation:'resume'},{signal:c.signal}),{code:'E_LOCAL_CANCELLED'});assert(!f.calls.length);
});
test('new-task metadata is bounded, non-content and excludes private, old or higher-floor records',()=>{
 const f=fixture();Object.assign(f.task,{createdAt:100,updatedAt:120,goal:'never expose this'});
 Object.defineProperty(f.task,'context',{get(){throw Error('must not read content');}});
 for(const [id,extra]of [['private',{scene:'private'}],['higher',{visibilityFloor:2}],['old',{createdAt:1}]])f.agent.runtime.tasks.set(id,{id,scene:'life',domain:'life',visibilityFloor:1,createdAt:110,...extra});
 const result=f.controls.list({since:90});assert.deepEqual(result.tasks,[{id:f.task.id,scene:'life',skill:f.task.skill,status:'paused',createdAt:100,updatedAt:120}]);assert.equal(result.truncated,false);assert(!JSON.stringify(result).includes('never expose'));
 f.agent.runtime.tasks.set('newer',{...result.tasks[0],id:'newer',domain:'life',visibilityFloor:1,createdAt:130});assert.equal(f.controls.list({since:90,limit:1}).tasks[0].id,'newer');assert.equal(f.controls.list({since:90,limit:1}).truncated,true);assert.equal(f.calls.length,0);
 for(const args of [{},{since:-1},{since:1,limit:21},{since:1.5}])assert.throws(()=>f.controls.list(args),{code:'E_LOCAL_PARAMS'});
 const c=new AbortController();c.abort();assert.throws(()=>f.controls.list({since:0},{signal:c.signal}),{code:'E_LOCAL_CANCELLED'});
 f.setScene('private');assert.throws(()=>f.controls.list({since:0}),{code:'E_LOCAL_SCENE'});
});
