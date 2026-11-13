'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createTaskTraceInspection}=require('../src/main/task-trace-inspection');
async function fixture(t){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'trace-export-')),root=await fs.realpath(temporary);t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let scene='life';const memory={ready:true,generation:1},task={id:'synthetic',scene:'life',domain:'life',visibilityFloor:1},runtime={tasks:new Map([['synthetic',task]])};let reads=0;
 runtime.modelTrace={flush:async()=>{},read:async(input,options)=>{reads++;assert.equal(input.taskId,task.id);assert(options.authorize());assert(options.isCurrent());return {traces:[{traceId:'trace-one',request:{messages:[{role:'user',content:'synthetic raw context'}]}}],gaps:[],pending:0,omitted:0};}};
 const inspect=createTaskTraceInspection({getRuntime:()=>runtime,getMemory:()=>memory,getScene:()=>scene,outputDirectory:path.join(root,'private')});
 return {root,memory,task,runtime,inspect,setScene:v=>{scene=v;},get reads(){return reads;}};
}
test('trace export keeps raw model context in a private file and returns only a reference',async t=>{
 const f=await fixture(t),result=await f.inspect({id:'synthetic'});assert.equal(result.traceCount,1);assert(!JSON.stringify(result).includes('synthetic raw context'));
 assert.equal((await fs.stat(result.artifact.path)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(result.artifact.path))).mode&0o777,0o700);
 const content=JSON.parse(await fs.readFile(result.artifact.path,'utf8'));assert.equal(content.traces[0].request.messages[0].content,'synthetic raw context');
});
test('private scope and higher-floor records are refused before querying the trace store',async t=>{
 const f=await fixture(t);f.setScene('private');await assert.rejects(f.inspect({id:'synthetic'}),{code:'E_TASK_TRACE_SCOPE'});f.setScene('life');f.task.visibilityFloor=2;await assert.rejects(f.inspect({id:'synthetic'}),{code:'E_TASK_TRACE_SCOPE'});assert.equal(f.reads,0);
});
test('a late result after generation changes is not exported and unknown IDs never enumerate records',async t=>{
 const f=await fixture(t);await assert.rejects(f.inspect({id:'unknown'}),{code:'E_TASK_TRACE_SCOPE'});assert.equal(f.reads,0);
 f.runtime.modelTrace.read=async()=>{f.memory.generation++;return {traces:[]};};await assert.rejects(f.inspect({id:'synthetic'}),{code:'E_TASK_TRACE_SCOPE'});assert.deepEqual(await fs.readdir(f.root),[]);
});
