'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createTaskEvidenceInspection}=require('../src/main/task-evidence-inspection'),{ref}=require('../src/main/operation-diagnostics');
const id='agent-synthetic-evidence',session='00000000-0000-4000-8000-000000000001',incidentId='a'.repeat(32),captureId='b'.repeat(32),region={x:10,y:20,width:200,height:80};
const png=(width,height)=>{const bytes=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;};
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bunny-crop-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));let scene='life';const calls=[],task={id,scene:'life',visibilityFloor:1,privacyEpoch:3,createdAt:10,goal:'synthetic-private-goal',operations:{op:{id:'synthetic-operation',status:'intent'}}},row={id,kind:'task',domain:'life',visibilityFloor:1,state:'active'};
 const event={stage:'evidence-retained',session,incidentId,captureId,taskId:ref(id),operationId:ref('synthetic-operation'),at:20,seq:4};
 const memory={ready:true,generation:3,decodeCalls:0,db:{request:async(op,args)=>{calls.push({op,args});return {rows:[row]};}},decode:()=>{memory.decodeCalls++;return {value:task};}};
 const source=png(1024,800),frame={session,incidentId,captureId,width:1024,height:800,imageKind:'visual-region'},diagnostic={root:path.join(root,'diagnostics'),reads:0,readEvidence:async(request,options)=>{diagnostic.reads++;assert.deepEqual(request,{session,incidentId,captureId});assert.equal(options.authorize()(),true);return {available:true,frame,pngBase64:source.toString('base64')};}};
 const outputDirectory=path.join(root,'exports'),cropCalls=[];const make=options=>createTaskEvidenceInspection({memory,getScene:()=>scene,outputDirectory,operationDiagnostics:diagnostic,clock:()=>30,readTimeline:async(_root,range)=>{assert.deepEqual(range,{from:10,to:30,limit:512,session,incidentId,captureId});return {events:[event]};},imageCrop:async(bytes,r)=>{cropCalls.push(r);assert.deepEqual(bytes,source);return png(r.width,r.height);},...options});
 return {root,outputDirectory,task,row,event,memory,diagnostic,frame,source,calls,cropCalls,make,setScene:v=>scene=v,params:{id,session,incidentId,captureId,region}};
}
test('exact-task retained evidence is ownership-checked before decryption and exports only a private local PNG crop reference',async t=>{
 const f=await fixture(t),result=await f.make()(f.params);assert.deepEqual(f.calls,[{op:'get',args:{ids:[id]}}]);assert.equal(f.memory.decodeCalls,1);assert.equal(f.diagnostic.reads,1);assert.deepEqual(f.cropCalls,[region]);
 assert.equal((await fs.stat(f.outputDirectory)).mode&0o777,0o700);assert.equal((await fs.stat(result.artifact.path)).mode&0o777,0o600);assert.equal(result.artifact.mimeType,'image/png');assert.deepEqual(await fs.readFile(result.artifact.path),png(200,80));
 const output=JSON.stringify(result);assert(!output.includes('synthetic-private'));assert(!output.includes('pngBase64'));assert(!output.includes(f.source.toString('base64')));assert.equal(result.metadata.operationRef,ref('synthetic-operation'));assert.deepEqual(result.metadata.region,region);
});
test('non-life or wrong task metadata is refused before decode or evidence access',async t=>{
 for(const patch of [{domain:'private'},{kind:'message'},{visibilityFloor:2},{state:'deleted'}]){const f=await fixture(t);Object.assign(f.row,patch);await assert.rejects(f.make()(f.params),{code:'E_TASK_EVIDENCE_SCOPE'});assert.equal(f.memory.decodeCalls,0);assert.equal(f.diagnostic.reads,0);}
 for(const change of [f=>f.setScene('private'),f=>f.setScene('work'),f=>{f.memory.ready=false;}]){const f=await fixture(t);change(f);await assert.rejects(f.make()(f.params));assert.equal(f.calls.length,0);}
 for(const patch of [{scene:'private'},{privacyEpoch:2},{visibilityFloor:2}]){const f=await fixture(t);Object.assign(f.task,patch);await assert.rejects(f.make()(f.params),{code:'E_TASK_EVIDENCE_SCOPE'});assert.equal(f.diagnostic.reads,0);}
});
test('mismatched retained session, incident, capture, task or operation cannot reach decryption',async t=>{
 for(const patch of [{stage:'evidence-pending'},{session:'00000000-0000-4000-8000-000000000002'},{incidentId:'c'.repeat(32)},{captureId:'c'.repeat(32)},{taskId:ref('other-task')},{operationId:ref('other-operation')}]){const f=await fixture(t);Object.assign(f.event,patch);await assert.rejects(f.make()(f.params),{code:'E_TASK_EVIDENCE_OWNERSHIP'});assert.equal(f.diagnostic.reads,0);assert.equal(f.cropCalls.length,0);}
});
test('region is mandatory and bounded, relative to actual pixels, and cannot export an entire frame',async t=>{
 for(const invalid of [undefined,{x:0,y:0,width:513,height:513},{x:0,y:0,width:2000,height:101},{x:-1,y:0,width:2,height:2},{x:.1,y:0,width:20,height:20}]){const f=await fixture(t);await assert.rejects(f.make()({...f.params,region:invalid}),{code:'E_TASK_EVIDENCE_REGION'});assert.equal(f.calls.length,0);}
 const f=await fixture(t);await assert.rejects(f.make()({...f.params,path:'/outside'}),{code:'E_TASK_EVIDENCE_PARAMS'});assert.equal(f.calls.length,0);
 for(const r of [{x:1000,y:0,width:30,height:10},{x:0,y:0,width:200,height:80}]){const g=await fixture(t);if(r.width===200){g.frame.width=200;g.frame.height=80;g.diagnostic.readEvidence=async()=>({available:true,frame:g.frame,pngBase64:png(200,80).toString('base64')});}await assert.rejects(g.make()({...g.params,region:r}),{code:'E_TASK_EVIDENCE_REGION'});assert.equal(g.cropCalls.length,0);}
 const narrow=await fixture(t);const result=await narrow.make()({...narrow.params,region:{x:0,y:0,width:1000,height:100}});assert.equal(result.metadata.width,1000);
});
test('scene, epoch and cancellation changes seal asynchronous timeline, evidence and crop results',async t=>{
 for(const phase of ['timeline','evidence','crop'])for(const change of ['scene','generation','abort']){
  const f=await fixture(t),controller=new AbortController(),entered=Promise.withResolvers(),release=Promise.withResolvers();const mutate=()=>{if(change==='scene')f.setScene('private');else if(change==='generation')f.memory.generation++;else controller.abort();};const options={};
  if(phase==='timeline')options.readTimeline=async()=>{entered.resolve();await release.promise;return {events:[f.event]};};
  if(phase==='evidence')f.diagnostic.readEvidence=async()=>{entered.resolve();await release.promise;return {available:true,frame:f.frame,pngBase64:f.source.toString('base64')};};
  if(phase==='crop')options.imageCrop=async()=>{entered.resolve();await release.promise;return png(200,80);};
  const pending=f.make(options)(f.params,{signal:controller.signal});await entered.promise;mutate();if(change==='abort')await assert.rejects(pending,{code:'E_TASK_EVIDENCE_ABORTED'});release.resolve();if(change!=='abort')await assert.rejects(pending);await new Promise(r=>setImmediate(r));await assert.rejects(fs.stat(f.outputDirectory),{code:'ENOENT'});
 }
});
test('symlink export paths, image mismatch and unsafe decoder errors never publish files or content',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await fs.mkdir(outside,{mode:0o700});await fs.symlink(outside,f.outputDirectory);await assert.rejects(f.make()(f.params));assert.deepEqual(await fs.readdir(outside),[]);
 const g=await fixture(t);g.frame.width=1023;await assert.rejects(g.make()(g.params),{code:'E_TASK_EVIDENCE_REGION'});assert.equal(g.cropCalls.length,0);
 const h=await fixture(t);h.memory.decode=()=>{throw Error('synthetic-private-decoder-error');};await assert.rejects(h.make()(h.params),e=>e.code==='E_TASK_EVIDENCE_UNAVAILABLE'&&!e.message.includes('private-decoder'));
});
test('retained native child scopes require a saved parent-child ID and the canonical Task operation reference together',async t=>{
 for(const relation of ['physicalId','outboundMessage','conversationOperation']){
  const f=await fixture(t),childId='synthetic-physical-'+relation;f.task.state={};
  if(relation==='physicalId')f.task.operations.op.physicalId=childId;
  if(relation==='outboundMessage')f.task.state.outboundMessages=[{id:childId,message:'synthetic-private-body'}];
  if(relation==='conversationOperation')f.task.state.conversationOperationId=childId;
  f.event.taskId=ref(childId);const result=await f.make()(f.params);assert.equal(result.ok,true);assert.equal(f.diagnostic.reads,1);assert.equal(result.metadata.operationRef,ref('synthetic-operation'));assert.equal(f.calls.length,1,'child records must not be queried');
 }
 const foreign=await fixture(t);foreign.event.taskId=ref('unrecorded-controller');await assert.rejects(foreign.make()(foreign.params),{code:'E_TASK_EVIDENCE_OWNERSHIP'});assert.equal(foreign.diagnostic.reads,0);
 const wrongOperation=await fixture(t);wrongOperation.task.operations.op.physicalId='saved-controller';wrongOperation.event.taskId=ref('saved-controller');wrongOperation.event.operationId=ref('different-canonical-operation');await assert.rejects(wrongOperation.make()(wrongOperation.params),{code:'E_TASK_EVIDENCE_OWNERSHIP'});assert.equal(wrongOperation.diagnostic.reads,0);
});
