'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createTaskInspection}=require('../src/main/task-inspection');
const id='agent-synthetic-task';
async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'bunny-task-inspection-')),root=await fs.realpath(temp);t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let scene='life';const calls=[],row={id,kind:'task',domain:'life',visibilityFloor:1,state:'active',ts:10,updatedAt:30,ingestionSeq:7,body:'synthetic-ciphertext'},value={id,scene:'life',status:'paused',createdAt:10,goal:'synthetic-private-goal',policy:'synthetic-private-policy',context:'synthetic-private-context',state:{ownerRequest:'synthetic-owner-request'},actionRuns:{action:{id:'action',status:'paused'}},operations:{write:{effect:'write',status:'intent',args:{text:'synthetic-private-body'}}},steps:[{action:'click',reason:'synthetic-private-reason'}],preview:'data:image/png;base64,c3ludGhldGlj'};
 const memory={ready:true,generation:3,db:{request:async(op,args)=>{calls.push({op,args});return {rows:[row]};}},decodeCalls:0,decode:r=>{memory.decodeCalls++;assert.equal(r,row);return {...r,value};}};
 const outputDirectory=path.join(root,'exports'),make=options=>createTaskInspection({memory,getScene:()=>scene,outputDirectory,clock:()=>40,...options});
 return {root,outputDirectory,row,value,memory,calls,make,setScene:v=>{scene=v;}};
}
test('exact-id export validates scope before decrypting and returns only a private artifact and non-content metadata',async t=>{
 const f=await fixture(t),result=await f.make()({id});
 assert.deepEqual(f.calls,[{op:'get',args:{ids:[id]}}]);assert.equal(f.memory.decodeCalls,1);
 assert.equal(result.scene,'life');assert.equal(result.metadata.status,'paused');assert.equal(result.metadata.actionCount,1);assert.equal(result.metadata.operationCount,1);assert.equal(result.metadata.unknownWriteCount,1);
 assert(!JSON.stringify(result).includes('synthetic-private'));assert(!JSON.stringify(result).includes('synthetic-owner-request'));
 assert.equal((await fs.stat(f.outputDirectory)).mode&0o777,0o700);assert.equal((await fs.stat(result.artifact.path)).mode&0o777,0o600);
 const bytes=await fs.readFile(result.artifact.path),snapshot=JSON.parse(bytes);
 assert.equal(bytes.length,result.artifact.size);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),result.artifact.sha256);
 assert.equal(snapshot.task.goal,f.value.goal);assert.equal(snapshot.task.policy,f.value.policy);assert.deepEqual(snapshot.task.operations,f.value.operations);assert.deepEqual(snapshot.task.steps,f.value.steps);
 assert.equal(snapshot.task.preview,'[pixel attachment omitted]');assert.equal(snapshot.omissions.pixelAttachmentsRemoved,1);assert.equal(snapshot.omissions.otherTaskFieldsRemoved,false);
 assert.equal(f.value.preview,'data:image/png;base64,c3ludGhldGlj','export must not mutate the live task');assert.equal(snapshot.note,'当前快照，非逐次历史或未保存的模型请求');
 assert.deepEqual(await fs.readdir(f.outputDirectory),[path.basename(result.artifact.path)]);
});
test('non-life metadata and non-task records never reach decode or filesystem export',async t=>{
 for(const patch of [{kind:'message'},{domain:'private'},{domain:'work'},{visibilityFloor:2},{visibilityFloor:0},{state:'deleted'}]){
  const f=await fixture(t);Object.assign(f.row,patch);
  await assert.rejects(f.make()({id}),{code:'E_TASK_INSPECTION_SCOPE'});assert.equal(f.memory.decodeCalls,0);
  await assert.rejects(fs.stat(f.outputDirectory),{code:'ENOENT'});
 }
});
test('missing, extra, or mismatched exact-id results are rejected without decrypting',async t=>{
 for(const rows of [[],[{id:'different'}],[{id},{id:'different'}]]){
  const f=await fixture(t);f.memory.db.request=async(op,args)=>{assert.equal(op,'get');assert.deepEqual(args,{ids:[id]});return {rows};};
  await assert.rejects(f.make()({id}),{code:'E_TASK_INSPECTION_NOT_FOUND'});assert.equal(f.memory.decodeCalls,0);
 }
});
test('decoded scene and id are checked again and decoder failures cannot expose raw content',async t=>{
 for(const patch of [{scene:'private'},{scene:'work'},{id:'different'}]){
  const f=await fixture(t);Object.assign(f.value,patch);await assert.rejects(f.make()({id}),{code:'E_TASK_INSPECTION_SCOPE'});
 }
 const f=await fixture(t);f.memory.decode=()=>{throw Error('synthetic-private-decode-content');};
 await assert.rejects(f.make()({id}),e=>e.code==='E_TASK_INSPECTION_UNAVAILABLE'&&!e.message.includes('synthetic-private'));
});
test('current scene and readiness reject before any database read',async t=>{
 for(const change of [f=>f.setScene('private'),f=>f.setScene('work'),f=>{f.memory.ready=false;}]){
  const f=await fixture(t);change(f);await assert.rejects(f.make()({id}));assert.equal(f.calls.length,0);assert.equal(f.memory.decodeCalls,0);
 }
 const f=await fixture(t);await assert.rejects(f.make()({id,path:'/forbidden'}),{code:'E_TASK_INSPECTION_PARAMS'});assert.equal(f.calls.length,0);
});
test('scene and generation changes during an exact read seal late content before decode',async t=>{
 for(const change of [f=>f.setScene('private'),f=>{f.memory.generation++;},f=>{f.memory.ready=false;}]){
  const f=await fixture(t),entered=Promise.withResolvers(),late=Promise.withResolvers();
  f.memory.db.request=async()=>{entered.resolve();return late.promise;};const pending=f.make()({id});await entered.promise;change(f);late.resolve({rows:[f.row]});
  await assert.rejects(pending);assert.equal(f.memory.decodeCalls,0);await assert.rejects(fs.stat(f.outputDirectory),{code:'ENOENT'});
 }
});
test('cancellation is prompt and late storage completion cannot decode or export',async t=>{
 const f=await fixture(t),controller=new AbortController(),entered=Promise.withResolvers(),late=Promise.withResolvers();
 f.memory.db.request=async()=>{entered.resolve();return late.promise;};const pending=f.make()({id},{signal:controller.signal});await entered.promise;controller.abort();
 await assert.rejects(pending,{code:'E_TASK_INSPECTION_ABORTED'});late.resolve({rows:[f.row]});await new Promise(r=>setImmediate(r));assert.equal(f.memory.decodeCalls,0);
 await assert.rejects(fs.stat(f.outputDirectory),{code:'ENOENT'});
 const before=await fixture(t),aborted=new AbortController();aborted.abort();await assert.rejects(before.make()({id},{signal:aborted.signal}),{code:'E_TASK_INSPECTION_ABORTED'});assert.equal(before.calls.length,0);
});
test('generation changes inside decode or snapshot preparation are sealed before writing',async t=>{
 const f=await fixture(t),decode=f.memory.decode;f.memory.decode=row=>{const value=decode(row);f.memory.generation++;return value;};
 await assert.rejects(f.make()({id}),{code:'E_TASK_INSPECTION_STALE'});await assert.rejects(fs.stat(f.outputDirectory),{code:'ENOENT'});
 const other=await fixture(t);await assert.rejects(other.make({clock:()=>{other.memory.generation++;return 40;}})({id}),{code:'E_TASK_INSPECTION_STALE'});
});
test('symbolic output paths and non-private existing directories are rejected without changing their permissions',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await fs.mkdir(outside,{mode:0o700});await fs.symlink(outside,f.outputDirectory);
 await assert.rejects(f.make()({id}),{code:'E_TASK_INSPECTION_PATH'});assert.deepEqual(await fs.readdir(outside),[]);
 const other=await fixture(t);await fs.mkdir(other.outputDirectory,{mode:0o755});await fs.chmod(other.outputDirectory,0o755);
 await assert.rejects(other.make()({id}),{code:'E_TASK_INSPECTION_PATH'});assert.equal((await fs.stat(other.outputDirectory)).mode&0o777,0o755);assert.deepEqual(await fs.readdir(other.outputDirectory),[]);
});
test('oversized task contents fail without truncating original context or exposing it',async t=>{
 const f=await fixture(t);f.value.context='x'.repeat(2*1024*1024);
 await assert.rejects(f.make()({id}),{code:'E_TASK_INSPECTION_LIMIT'});await assert.rejects(fs.stat(f.outputDirectory),{code:'ENOENT'});
});
test('concurrent exports publish distinct complete files exclusively',async t=>{
 const f=await fixture(t),inspect=f.make(),results=await Promise.all([inspect({id}),inspect({id})]);
 assert.notEqual(results[0].artifact.path,results[1].artifact.path);
 for(const result of results){assert.equal(JSON.parse(await fs.readFile(result.artifact.path,'utf8')).task.id,id);assert.equal((await fs.stat(result.artifact.path)).mode&0o777,0o600);}
 assert.equal((await fs.readdir(f.outputDirectory)).length,2);
});
