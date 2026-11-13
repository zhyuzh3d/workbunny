'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const trace=require('../src/main/operation-diagnostics');
const {fixture,paint}=require('./support/visual-fixture.cjs');
async function temporary(t){const parent=await fs.mkdtemp(path.join(os.tmpdir(),'bunny-operation-evidence-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));return path.join(parent,'diagnostics');}
test('exact retained metadata is filtered before the timeline limit without expanding storage or ownership scope',async t=>{
 const root=await temporary(t),session=crypto.randomUUID(),incidentId='a'.repeat(32),captureId='b'.repeat(32),target={schema:'bunny.operation-diagnostic/v1',session,seq:1,at:10,monoUs:10,stage:'evidence-retained',incidentId,captureId,taskId:trace.ref('fixture-task'),operationId:trace.ref('fixture-operation')};
 const later=Array.from({length:700},(_,i)=>({...target,seq:i+2,at:i+11,monoUs:i+11,stage:'operation-receipt',captureId:'c'.repeat(32)}));await fs.mkdir(root,{mode:0o700});await fs.writeFile(path.join(root,'events-'+crypto.randomUUID()+'.ndjson'),[target,...later].map(e=>JSON.stringify(e)).join('\n'),{mode:0o600});
 assert(!(await trace.readTimeline(root,{limit:512})).events.some(e=>e.seq===1));
 const exact=await trace.readTimeline(root,{from:0,to:1000,limit:1,session,incidentId,captureId});assert.equal(exact.events.length,1);assert.equal(exact.events[0].seq,1);assert.equal(exact.events[0].taskId,target.taskId);assert.equal(exact.events[0].operationId,target.operationId);
 assert.equal((await trace.readTimeline(root,{session,incidentId,captureId:'d'.repeat(32)})).events.length,0);assert.equal((await trace.readTimeline(root,{from:11,session,incidentId,captureId})).events.length,0);await assert.rejects(trace.readTimeline(root,{session:'invalid'}));
});
test('actual visual sequence links capture, VLM, frame, preflight and one acknowledged input without private content',async()=>{
 const recorder=new trace.OperationDiagnostics(),h=fixture();
 await trace.using(recorder,()=>trace.scope({taskId:'task-private-name',operationId:'operation-one'},async()=>{
  const shot=await h.visual.observe();await h.visual.input(shot.visualFrameId,{action:'type',text:'private-chat-and-password'});
 }));
 const {events}=recorder.snapshot(),stages=events.map(e=>e.stage);
 for(const stage of ['capture-start','capture-end','pixel-frame','visual-recognition','visual-location','visual-observation','input-intent','input-preflight','input-dispatch','input-receipt'])assert(stages.includes(stage),stage);
 assert.equal(events.filter(e=>e.stage==='input-dispatch').length,1);assert.equal(events.find(e=>e.stage==='input-receipt').nativeAcknowledged,true);
 const observation=events.find(e=>e.stage==='visual-observation');assert(events.some(e=>e.stage==='pixel-frame'&&e.captureId===observation.captureId));
 assert(events.every(e=>e.taskId===trace.ref('task-private-name')&&e.operationId===trace.ref('operation-one')));
 assert(!JSON.stringify(events).match(/private-chat|password|task-private-name|可见输入光标|目标文档标题/));
 assert.deepEqual(h.calls.map(c=>c.op),['displayCapture','displayCapture','displayInput'],'diagnostics add no capture or target interface calls');
 assert.equal(trace.summarizeTimeline(events).recentInputs.at(-1).outcome,'input-acknowledged');
});
test('normalized visual replies record format drift and typed diagnostics without retaining model prose',async()=>{
 const recorder=new trace.OperationDiagnostics(),h=fixture();h.visual.request=async()=>({response:{text:JSON.stringify(h.location)+'\nprivate-model-prose-canary'}});
 await trace.using(recorder,()=>h.visual.observe());const event=recorder.events.find(e=>e.stage==='visual-recognition'&&e.normalized);
 assert(event.discardedChars>0);assert(!JSON.stringify(recorder.events).includes('private-model-prose-canary'));
 recorder.record('visual-recognition',{status:'validation-failed',schemaAudit:{protocol:'structured-json',field:'response',expected:'valid-json',text:'private-schema-canary'},completion:{model:'fixture-model',finishReason:'stop',text:'private-answer-canary'}});
 const diagnostic=recorder.events.at(-1);assert.equal(diagnostic.schemaAudit.protocol,'structured-json');assert.equal(diagnostic.completion.finishReason,'stop');assert(!JSON.stringify(diagnostic).includes('private-'));
});
test('a visible security state is recorded only when actually observed and never supplies an exit time or cause',async()=>{
 let at=1000,mono=0n;const recorder=new trace.OperationDiagnostics({clock:()=>at,monotonic:()=>mono}),h=fixture();
 await trace.using(recorder,async()=>{await h.visual.observe();at=900;mono+=1000000n;h.location={available:false,unavailableKind:'security',reason:'private-contact visible security warning'};await assert.rejects(h.visual.observe({relocate:true}));});
 const events=recorder.snapshot().events,location=events.find(e=>e.stage==='visual-location'&&e.available===false);
 assert.equal(location.at,900);assert.equal(location.unavailableKind,'security');assert(events.at(-1).monoUs>=events[0].monoUs);
 assert(!events.some(e=>e.stage==='input-dispatch'));assert(!JSON.stringify(events).match(/private-contact|exitAt|cause/));
 const report=trace.summarizeTimeline(events);assert.equal(report.coverage.absenceProof,false);assert.equal(report.causality,'temporal-association-only');
});
test('cancellation before dispatch, cancellation after acknowledgement and missing receipts retain distinct outcomes',async()=>{
 const beforeRecorder=new trace.OperationDiagnostics(),h=fixture(),cancel=new AbortController();
 await trace.using(beforeRecorder,async()=>{const frame=await h.visual.observe();cancel.abort();await assert.rejects(h.visual.input(frame.visualFrameId,{action:'click',x:100,y:60},{signal:cancel.signal}));});
 assert.equal(trace.summarizeTimeline(beforeRecorder.events).recentInputs.at(-1).outcome,'not-dispatched');
 const afterRecorder=new trace.OperationDiagnostics(),after=new AbortController(),b=fixture({onInput:()=>after.abort()});
 await trace.using(afterRecorder,async()=>{const frame=await b.visual.observe();const result=await b.visual.input(frame.visualFrameId,{action:'key',key:'Right',modifiers:[]},{signal:after.signal});assert.equal(result.cancelledAfterDispatch,true);});
 const state=trace.summarizeTimeline(afterRecorder.events).recentInputs.at(-1);assert.equal(state.outcome,'input-acknowledged');assert.equal(state.cancellationRequested,true);
 const missing=new trace.OperationDiagnostics();missing.record('input-intent',{spanId:'one'});missing.record('input-dispatch',{spanId:'one'});missing.record('input-cancel',{spanId:'one',mayHaveDispatched:true});assert.equal(trace.summarizeTimeline(missing.events).recentInputs[0].outcome,'unconfirmed');
});
test('pixel and display changes are evidence of change, not a fabricated outside actor or app crash',async()=>{
 const recorder=new trace.OperationDiagnostics(),h=fixture();await trace.using(recorder,async()=>{await h.visual.observe();paint(h.image,{x:.4,y:.3,width:.1,height:.1});await h.visual.observe();});
 assert(recorder.events.some(e=>e.stage==='visual-change'&&e.pixelsChanged));assert(!JSON.stringify(recorder.events).match(/frontmost|windowId|bundleId|"pid"|crashed|causedBy/));
});
test('incident pixels are local encrypted evidence, and the persisted metadata reconstructs after restart',async t=>{
 const root=await temporary(t),key=crypto.randomBytes(32),recorder=new trace.OperationDiagnostics({root,getKey:()=>key});
 const pixels=Buffer.from('synthetic-pixels-with-private-contact-and-password');recorder.frame({pngBase64:pixels.toString('base64'),width:20,height:10,capturedAt:Date.now()},{captureId:'capture-one',visualSessionId:'visual-one'});
 recorder.record('input-dispatch',{spanId:'input-one',operation:'key',key:'F2',modifiers:['ctrl']});recorder.incident('visual-unavailable',{visualSessionId:'visual-one'});assert.equal(await recorder.flush(1000),true);
 const names=await fs.readdir(root),imageName=names.find(n=>n.startsWith('evidence-'));assert(imageName);
 const encrypted=await fs.readFile(path.join(root,imageName)),split=encrypted.indexOf(10),header=JSON.parse(encrypted.subarray(0,split)),body=encrypted.subarray(split+1);
 assert.equal((await fs.stat(path.join(root,imageName))).mode&0o077,0);assert(!encrypted.includes(pixels));
 const derived=crypto.createHmac('sha256',key).update('bunny.operation-evidence/v1').digest(),imported=await crypto.webcrypto.subtle.importKey('raw',derived,'AES-GCM',false,['decrypt']);
 const clear=Buffer.from(await crypto.webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(header.nonce,'base64'),additionalData:encrypted.subarray(0,split)},imported,body));assert.deepEqual(clear,pixels);
 const report=await trace.readTimeline(root);assert(report.events.some(e=>e.stage==='evidence-retained'));assert.equal(report.recentInputs.at(-1).outcome,'unconfirmed');assert.equal(report.coverage.absenceProof,false);
 const scope={session:header.session,incidentId:header.incidentId,captureId:header.captureId};
 assert.equal((await recorder.readEvidence(scope)).code,'E_DIAGNOSTIC_AUTH');
 const retrieved=await recorder.readEvidence(scope,{authorize:given=>{assert.deepEqual(given,scope);return true;}});assert.equal(retrieved.available,true);assert.deepEqual(Buffer.from(retrieved.pngBase64,'base64'),pixels);assert(!Object.keys(retrieved).some(k=>/key|path/i.test(k)));
 const locked=new trace.OperationDiagnostics({root});assert.equal((await locked.readEvidence(scope,{authorize:()=>true})).code,'E_DIAGNOSTIC_LOCKED');
 assert.equal((await recorder.readEvidence({...scope,captureId:'a'.repeat(32)},{authorize:()=>true})).code,'E_DIAGNOSTIC_MISSING');
 const tampered=Buffer.from(encrypted);tampered[tampered.length-1]^=1;await fs.writeFile(path.join(root,imageName),tampered);assert.equal((await recorder.readEvidence(scope,{authorize:()=>true})).code,'E_DIAGNOSTIC_INTEGRITY');
 for(const name of names.filter(n=>n.endsWith('.ndjson')))assert(!/private-contact|password/.test(await fs.readFile(path.join(root,name),'utf8')));
 await recorder.close();
});
test('an oversized display retains the already-produced sharp visual crop with dimensions and no extra sampling',async()=>{
 const {raster}=require('./support/visual-fixture.cjs'),recorder=new trace.OperationDiagnostics(),h=fixture();h.image=raster(800,600);
 h.location={...h.location,region:{x:.1,y:.1,width:.4,height:.4},mainRegion:{x:.1,y:.1,width:.4,height:.4},identityRegion:{x:.12,y:.12,width:.1,height:.05},monitorRegions:[{x:.1,y:.2,width:.4,height:.1}],focusRegion:{x:.12,y:.3,width:.2,height:.05}};
 await trace.using(recorder,()=>h.visual.observe());assert.equal(h.calls.length,1);assert(recorder.events.some(e=>e.reason==='frame-limit'&&e.imageKind==='display'));
 const image=recorder.frames.at(-1);assert.equal(image.fields.imageKind,'visual-region');assert.equal(image.fields.sourceWidth,800);assert.equal(image.fields.sourceHeight,600);assert.equal(image.fields.width,320);assert.equal(image.fields.height,240);assert(image.pixels.length<4*1024*1024);
 const actual=h.bitmap(image.pixels);assert.equal(actual.width,320);assert.equal(actual.height,240);assert.equal(recorder.frames.length,1,'one capture has one preferred bounded evidence image');
});
test('read deadlines and revoked scope cannot cause late plaintext delivery or use a key after timeout',async()=>{
 let release,keyReads=0;const recorder=new trace.OperationDiagnostics({root:'/unused',getKey:()=>{keyReads++;return crypto.randomBytes(32);}}),scope={session:crypto.randomUUID(),incidentId:'a'.repeat(32),captureId:'b'.repeat(32)};
 const result=await recorder.readEvidence(scope,{timeoutMs:5,authorize:()=>new Promise(r=>{release=r;})});assert.equal(result.code,'E_DIAGNOSTIC_TIMEOUT');release(true);await new Promise(r=>setImmediate(r));assert.equal(keyReads,0);
 assert.equal((await recorder.readEvidence(scope,{authorize:()=>()=>false})).code,'E_DIAGNOSTIC_AUTH_OR_STORAGE');assert.equal(keyReads,0);
});
test('diagnostic references never renew recovery budgets and only fixed provenance is forwarded',()=>{
 const repair=require('../src/main/self-repair'),task={skill:'software.execute',state:{},inbox:[]},recorder=new trace.OperationDiagnostics();
 const first={code:'E_FAKE',message:'same failure',diagnostic:{operationTrace:recorder.link('first')}};recorder.record('host-state',{state:'wake'});
 const second={...first,diagnostic:{operationTrace:recorder.link('second')}};assert.equal(repair.incident(task,first),repair.incident(task,second));
 const safe=repair.diagnostic({operationTrace:{...second.diagnostic.operationTrace,text:'private-chat',key:'private-key'}});assert(safe.operationTrace.incidentId);assert(!JSON.stringify(safe).includes('private-'));
});
test('locked key and oversized pixels produce explicit gaps with no plaintext fallback',async t=>{
 const root=await temporary(t),recorder=new trace.OperationDiagnostics({root,maxFrameBytes:16});
 recorder.frame({pngBase64:Buffer.alloc(64).toString('base64')},{captureId:'large'});
 recorder.frame({pngBase64:Buffer.from('private').toString('base64'),capturedAt:1,width:1,height:1},{captureId:'small'});recorder.incident('capture-failed');await recorder.flush();
 assert(recorder.events.some(e=>e.reason==='frame-limit'));assert(recorder.events.some(e=>e.reason==='key-unavailable'));assert(!(await fs.readdir(root)).some(n=>n.endsWith('.bin')));await recorder.close();
});
test('the latest anomalous frame and its preceding frame both fit the bounded encrypted writer',async t=>{
 const root=await temporary(t),recorder=new trace.OperationDiagnostics({root,getKey:()=>Buffer.alloc(32,3)});
 for(const [captureId,value]of [['before','previous-screen'],['now','current-warning']])recorder.frame({pngBase64:Buffer.from(value).toString('base64'),width:10,height:10,capturedAt:Date.now()},{captureId,visualSessionId:'one'});
 recorder.incident('visual-unavailable',{visualSessionId:'one'});assert(recorder.evidencePending<=2);assert(await recorder.flush(1000));
 assert.equal((await fs.readdir(root)).filter(n=>n.endsWith('.bin')).length,2);assert.equal(recorder.events.filter(e=>e.stage==='evidence-retained').length,2);await recorder.close();
});
test('blocked storage and saturated queues cannot delay visual work or conceal their loss',async t=>{
 const root=await temporary(t),recorder=new trace.OperationDiagnostics({root,maxPendingBytes:2000,maxEvents:30,writeTimeoutMs:10,io:{...fs,open:()=>new Promise(()=>{})}}),h=fixture();
 const began=Date.now();await trace.using(recorder,async()=>{const frame=await h.visual.observe();await h.visual.input(frame.visualFrameId,{action:'click',x:100,y:60});});
 for(let i=0;i<50;i++)recorder.record('host-state',{state:'sleep'});
 assert(Date.now()-began<500);assert(recorder.pendingBytes<=2000);assert.equal(recorder.events.length,30);assert(recorder.dropped>0);
 await new Promise(r=>setTimeout(r,20));assert(recorder.events.some(e=>e.stage==='diagnostic-gap'&&e.reason==='storage-timeout'));
 const closed=await recorder.close(15);assert.equal(closed.drained,false);assert.equal(closed.storageFailed,true);assert(Date.now()-began<600);
});
test('rotation bounds metadata and recovery reports malformed tails, missing sequences and truncated windows',async t=>{
 const root=await temporary(t),recorder=new trace.OperationDiagnostics({root,maxFileBytes:550,maxFiles:2});
 for(let i=0;i<12;i++){recorder.record('host-state',{state:'wake'});assert(await recorder.flush());}
 assert((await fs.readdir(root)).filter(n=>n.endsWith('.ndjson')).length<=2);
 const file=(await fs.readdir(root)).find(n=>n.endsWith('.ndjson'));await fs.appendFile(path.join(root,file),'broken-last-line');
 const report=await trace.readTimeline(root,{limit:1});assert(report.coverage.incomplete);assert(report.coverage.truncated);assert.equal(report.coverage.absenceProof,false);
 const gaps=trace.summarizeTimeline([{session:'a',seq:1},{session:'a',seq:3,droppedBefore:1}]);assert.equal(gaps.coverage.sequenceGaps,1);assert.equal(gaps.coverage.dropped,1);await recorder.close();
});
test('untrusted diagnostics root is rejected without following a symlink',async t=>{
 const root=await temporary(t),external=root+'-outside';await fs.mkdir(external,{mode:0o700});await fs.symlink(external,root);const recorder=new trace.OperationDiagnostics({root});recorder.record('host-state',{state:'startup'});assert.equal(await recorder.flush(),false);assert.deepEqual(await fs.readdir(external),[]);assert.equal(recorder.snapshot().storageFailed,true);await recorder.close();
});
test('real operation ledger scopes propagate into the native request and failure without writing arguments',async()=>{
 const {OperationLedger}=require('../src/main/operation-ledger'),{ToolRegistry}=require('../src/main/agent-tools');
 const {DesktopNative}=require('../src/main/desktop-native'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
 let child;const native=new DesktopNative('/fake/native',{spawn:()=>{child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(chunk,_encoding,callback){const message=JSON.parse(chunk);callback();queueMicrotask(()=>child.stdout.write(JSON.stringify({id:message.id,ok:false,code:'E_FAKE_NATIVE',dispatched:true,error:'private-error-body'})+'\n'));}});child.kill=()=>queueMicrotask(()=>child.emit('close',0));return child;}});
 const tools=new ToolRegistry().register({name:'fixture.direct',description:'fake direct operation',effect:'write',capabilities:[],execute:()=>native.request('displayInput',{action:'key',key:'F2',modifiers:['ctrl'],text:'private-input-body'},1000)});
 const task={id:'private-task-goal',scene:'life',state:{},subjects:[],capabilities:[],operations:{},counters:{reads:0,writes:0}},recorder=new trace.OperationDiagnostics(),ledger=new OperationLedger({tools,clock:Date.now,authorize:async()=>{},save:async()=>{}});
 await trace.using(recorder,()=>assert.rejects(ledger.execute({task,call:{tool:'fixture.direct',key:'once',args:{}},isCurrent:()=>true}),/private-error-body/));
 const events=recorder.events;for(const stage of ['operation-intent','operation-dispatch','native-dispatch','native-error','operation-error','incident'])assert(events.some(e=>e.stage===stage),stage);
 assert(events.every(e=>e.taskId===trace.ref(task.id)&&e.operationId));assert.equal(events.find(e=>e.stage==='native-error').status,'uncertain');assert(!JSON.stringify(events).match(/private-error-body|private-input-body|private-task-goal/));assert.equal(Object.values(task.operations)[0].status,'intent');await native.close();
});
test('native outcome diagnostics retain bounded effect counts without input or target contents',()=>{
 const recorder=new trace.OperationDiagnostics();
 recorder.record('native-error',{code:'E_NATIVE_TIMEOUT',inputOutcome:{dispatched:true,moved:true,reportsSubmitted:3,reportsAttempted:4,completion:'unknown',text:'private-canary',recipient:'private-canary',clipboard:'private-canary'}});
 assert.deepEqual(recorder.events[0].inputOutcome,{dispatched:true,moved:true,reportsSubmitted:3,reportsAttempted:4,completion:'unknown'});
 assert(!JSON.stringify(recorder.events).includes('private-canary'));
});
