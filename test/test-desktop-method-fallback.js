'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const {DesktopService}=require('../src/main/desktop-service');
const {DesktopNative}=require('../src/main/desktop-native');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const deadline=Date.now()+5000;while(!check()&&Date.now()<deadline)await pause(5);assert(check(),'fixture deadline exceeded');}
function fixture({proofMode='valid',draftConflict=false,unknownSubmit=false,unknownInput=false,holdProof=false,throwLog=false,inspectError=false,proofDraftConflict=false,pauseBeforeSubmit=false}={}){
 const {raster,encode,crop,bitmap,paint}=require('./support/visual-fixture.cjs');
 const calls=[],logs=[],inputs=[];let visualHome=false,draft=draftConflict?'preserved fixture draft':'',submitted=0,releaseProof,proofPending=false,holdSubmit=pauseBeforeSubmit;
 const rect={x:0,y:0,width:1000,height:800},bundleId='com.tencent.workbuddy.mac',diagnostic={operation:'newTask',candidateCount:2,method:'background-ax'};
 const visibleDraft=()=>draft||(proofDraftConflict&&visualHome?'preserved unrelated visual draft':'');
 const native={cancel:async()=>{},close:async()=>{},request:async(op,a={})=>{
  calls.push({op,operation:a.operation,background:a.background});
  if(op==='permissions')return {accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true};
  if(op==='workbuddyCapabilities')return {backgroundAX:true};
  if(op==='activate')throw Error('already active in this fixture');
  if(op==='frontmost')return {application:{bundleId,pid:123,name:'fixture'},windows:[{bundleId,pid:123,windowId:7,layer:0,rect}]};
  if(op==='workbuddyNavigate'){if(a.operation==='inspect')return {homeReady:false,pickerAvailable:false,workspacePicker:{candidateCount:0}};throw Object.assign(Error('fixture localization failure'),{code:'E_GUI_LOCATE_AMBIGUOUS',dispatched:false,diagnostic:{...diagnostic,method:a.background?'background-ax':'foreground-ax'}});}
  if(op==='workbuddyInspect')return {available:true,homeReady:visualHome&&!!draft,scanComplete:true,editorCount:1,draftEmpty:!visibleDraft(),draftMatchesRequest:!!draft&&draft===a.text};
  if(op==='displayCapture'){const image=raster(200,160);paint(image,{x:.2,y:.2,width:.5,height:.2},visualHome?200:90);if(visibleDraft())paint(image,{x:.1,y:.7,width:.8,height:.2},230);return {pngBase64:encode(image).toString('base64'),desktopRect:rect,width:200,height:160,backend:'CGDisplayStream',capturedAt:Date.now()};}
  if(op==='displayInput'){
   if(a.action==='click'){visualHome=true;return {performed:true};}
   if(a.action==='type'){assert(visualHome);assert(!visibleDraft());draft=a.text;inputs.push(a.text);if(unknownInput)throw Object.assign(Error('fixture lost input receipt'),{code:'E_GUI_INPUT_UNKNOWN',dispatched:true});return {performed:true};}
   if(a.action==='key'){assert.equal(a.key,'enter');submitted++;if(unknownSubmit)throw Object.assign(Error('fixture lost send receipt'),{code:'E_GUI_SEND_UNKNOWN',dispatched:true});draft='';return {performed:true};}
  }
  throw Error('unexpected fake native operation '+op);
 }};
 const verificationRequest=async options=>{
  let data;try{data=JSON.parse(options.messages.find(m=>m.role==='user').content[0].text);}catch{}
  if(data?.question){
   if(holdProof&&/输入前提/u.test(data.question)){proofPending=true;await new Promise(r=>{releaseProof=r;});}
   const empty=/输入前提/u.test(data.question);return {response:{text:JSON.stringify({matched:empty?!visibleDraft():draft===data.evidence.expectedText,evidence:visibleDraft()?'actual visible draft':'actual empty composer'})}};
  }
  return {response:{text:JSON.stringify({software:'WorkBuddy',available:true,unique:true,active:true,sameIdentity:true,region:{x:0,y:0,width:1,height:1},mainRegion:{x:0,y:0,width:1,height:1},identityRegion:{x:.1,y:.02,width:.6,height:.1},monitorRegions:[{x:0,y:.15,width:1,height:.8}],focusRegion:{x:.1,y:.7,width:.8,height:.2},focusEvidence:'visible composer caret',evidence:'actual uniquely bound composer',texts:[{text:'DeepSeek-V4.1-Flash',confidence:1,x:.6,y:.5,width:.3,height:.03}]})}};
 };
 let planned=0;
 const service=new DesktopService({native,persist:async()=>{},imageResize:x=>x,imageCrop:crop,bitmap,verificationRequest,log:value=>{logs.push(value);if(throwLog)throw Error('fixture logger unavailable');},planner:async(_goal,_shot,_signal,task)=>{
   planned++;if(!visualHome)return {action:'click',x:.1,y:.1,reason:'open the visible new composer'};
   if(draft)return holdSubmit?{action:'done',completed:false,evidence:'fixture pause with confirmed draft'}:{action:'key',key:'enter',purpose:'submit',reason:'submit this draft once'};
   const required=task.inputPrerequisites;let inputEvidence={observationId:required.observationId,checks:required.checks.map(c=>({id:c.id,observed:c.expected,basis:'fixture screenshot shows '+c.id}))};
   if(proofMode==='missing')inputEvidence=undefined;if(proofMode==='partial')inputEvidence.checks.pop();if(proofMode==='stale')inputEvidence.observationId='0'.repeat(24);if(proofMode==='wrong')inputEvidence.checks[0].observed='other-project';
   return {action:'type',purpose:'task',text:'host replaces this',inputEvidence};
  },observeWorkBuddy:async()=>submitted&&!unknownSubmit?{sessionId:'fixture-session',taskId:1,messageKey:'fixture-message',status:'ok',summary:'fixture actual result'}:null});
 return {service,calls,logs,inputs,submitted:()=>submitted,planned:()=>planned,proofPending:()=>proofPending,releaseProof:()=>releaseProof?.(),allowSubmit:()=>{holdSubmit=false;},draft:visibleDraft};
}
async function start(h){assert((await h.service.start({target:'workbuddy',goal:'private-goal-canary',workModel:'deepseek-v4.1-flash',workContext:{mode:'none'}})).ok);return {id:h.service.task.id,outbound:h.service.task.outboundText,marker:h.service.task.associationMarker};}
test('pre-dispatch AX localization failure changes methods and submits the same task once with current visual evidence',async()=>{
 for(const inspectError of [false,true]){const h=fixture({throwLog:true,inspectError});try{
  const original=await start(h);await until(()=>!h.service.running);
  assert.equal(h.service.task.status,'review');assert.equal(h.service.task.id,original.id);assert.equal(h.service.task.associationMarker,original.marker);
  assert.deepEqual(h.inputs,[original.outbound]);assert.equal(h.submitted(),1);assert.equal(h.planned(),3);
  assert(!h.calls.some(c=>c.op==='activate'));assert(h.calls.some(c=>c.op==='displayCapture'));const firstPixel=h.calls.findIndex(c=>c.op==='displayCapture');assert(!h.calls.slice(firstPixel).some(c=>['frontmost','workbuddyInspect','workbuddyNavigate','recognize','capture'].includes(c.op)),'visual fallback is independent of the preceding structured attempts');
  assert(h.logs.some(e=>e.method==='background-ax'&&e.candidateCount===2));assert(h.logs.some(e=>e.method==='foreground-ax'));
  assert(!JSON.stringify(h.logs).includes('private-goal-canary'));assert(!JSON.stringify(h.logs).includes('fixture localization failure'));
  assert.equal(h.service.task.workRoute.method,'visual');assert.equal(h.service.task.workRoute.inputEvidence.target.mode,'visual');assert(!('windowId'in h.service.task.workRoute.inputEvidence.target));
  assert.equal(h.service.task.progress.version,1);assert(h.service.task.progress.spent.tool>=0);
 }finally{await h.service.close();}}
});
test('unproved, partial, stale or mismatching visual preconditions never allow task input',async()=>{
 for(const proofMode of ['missing','partial','stale','wrong']){
  const h=fixture({proofMode});try{await start(h);await until(()=>!h.service.running);assert.equal(h.inputs.length,0);assert.equal(h.submitted(),0);assert.equal(h.service.task.errorCode,'E_WORKBUDDY_ROUTE_UNVERIFIED');assert(!h.service.task.draftInserted);}finally{await h.service.close();}
 }
});
test('a readable draft conflict stops before fallback navigation and preserves the draft',async()=>{
 const h=fixture({draftConflict:true});try{await start(h);await until(()=>!h.service.running);assert.equal(h.service.task.errorCode,'E_WORKBUDDY_DRAFT_CONFLICT');assert.equal(h.draft(),'preserved fixture draft');assert(!h.calls.some(c=>c.op==='activate'||c.op==='click'||c.op==='type'));}finally{await h.service.close();}
});
test('an actual work-position conflict cannot be overridden by a visual claim',async()=>{
 const h=fixture();try{
  const s=h.service;s.task={id:'conflict',scene:'life',domain:'life',visibilityFloor:1,workContext:{mode:'none'},steps:[]};s.running=true;s.generation=1;s.controller=new AbortController();
  const shot=s.screenshot={at:Date.now(),revision:1,rect:{x:0,y:0,width:1000,height:800},preview:'fixture'};
  s.native.request=async()=>({homeReady:true,pickerAvailable:true,workspace:'different-project',workspacePicker:{candidateCount:1}});
  await assert.rejects(s.verifyWorkBuddyRoute({bundleId:'com.tencent.workbuddy.mac',pid:123,windowId:7},1,{shot,proof:{observationId:'0'.repeat(24),checks:[]}}),{code:'E_WORKBUDDY_ROUTE_UNVERIFIED',dispatched:false});
  assert.equal(s.task.workRoute.prepared,false);
 }finally{await h.service.close();}
});
test('a newly readable draft conflict overrides otherwise complete visual input evidence',async()=>{
 const h=fixture({proofDraftConflict:true});try{await start(h);await until(()=>!h.service.running);assert.equal(h.service.task.errorCode,'E_WORKBUDDY_ROUTE_UNVERIFIED');assert.equal(h.inputs.length,0);assert.equal(h.submitted(),0);}finally{await h.service.close();}
});
test('an unknown submit retains the same task and never submits again on resume',async()=>{
 const h=fixture({unknownSubmit:true});try{
  const original=await start(h);await until(()=>!h.service.running);assert(h.service.task.submitAttemptedAt);assert.equal(require('../src/main/workbuddy-observation').workSubmissionState(h.service.task).phase,'submission-unknown');assert.equal(h.submitted(),1);
  h.service.ensureWorkBuddyMonitor=async()=>{h.service.running=false;return true;};assert((await h.service.resume()).ok);await until(()=>!h.service.running);
  assert.equal(h.submitted(),1);assert.equal(h.inputs.length,1);assert.equal(h.service.task.id,original.id);assert.equal(h.service.task.outboundText,original.outbound);
 }finally{await h.service.close();}
});
test('an unknown input retains its intent and cannot be treated as an empty pre-dispatch failure',async()=>{
 const h=fixture({unknownInput:true});try{
  const original=await start(h);await until(()=>!h.service.running);assert(h.service.task.draftInserted);assert.equal(require('../src/main/workbuddy-observation').workSubmissionState(h.service.task).phase,'input-unknown');assert.equal(h.inputs.length,1);assert.equal(h.submitted(),0);
  assert.equal(h.service.task.steps.find(s=>s.action==='type').state,'intent');
  assert((await h.service.resume()).ok);await until(()=>!h.service.running);assert.equal(h.inputs.length,1);assert.equal(h.submitted(),0);assert.equal(h.service.task.id,original.id);assert.equal(h.service.task.outboundText,original.outbound);
 }finally{await h.service.close();}
});
test('a confirmed input-sent draft can resume and submit once without being rewritten',async()=>{
 const h=fixture({pauseBeforeSubmit:true});try{const original=await start(h);await until(()=>!h.service.running);assert.equal(h.submitted(),0);assert.equal(h.inputs.length,1);assert.equal(require('../src/main/workbuddy-observation').workSubmissionState(h.service.task).phase,'draft-ready');h.allowSubmit();assert((await h.service.resume()).ok);await until(()=>!h.service.running);assert.equal(h.service.task.status,'review');assert.equal(h.submitted(),1);assert.deepEqual(h.inputs,[original.outbound]);assert.equal(h.service.task.id,original.id);}finally{await h.service.close();}
});
test('cancellation while checking input evidence releases ownership and rejects a late callback',async()=>{
 const h=fixture({holdProof:true});try{
  await start(h);await until(h.proofPending);await h.service.stop('fixture stop');assert.equal(h.service.running,false);assert.equal(h.service.guiLeaseHeld,false);
  h.releaseProof();await pause(20);assert.equal(h.inputs.length,0);assert.equal(h.submitted(),0);assert.equal(h.service.task.status,'stopped');
 }finally{h.releaseProof();await h.service.close();}
});
test('JSONL bridge preserves only structural location diagnostics',async()=>{
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let message;
 child.stdin=new Writable({write(chunk,_encoding,done){message=JSON.parse(String(chunk));done();}});child.kill=()=>queueMicrotask(()=>child.emit('close',0));
 const client=new DesktopNative('/fixture/desktop',{spawn:()=>child});try{
  const pending=client.request('workbuddyNavigate');
  child.stdout.write(JSON.stringify({id:message.id,ok:false,code:'E_GUI_LOCATE_MISSING',dispatched:false,error:'fixture',diagnostic:{operation:'newTask',candidateCount:0,method:'background-ax',label:'private-label-canary',goal:'private-goal-canary',guardChecks:{draftMatched:true,sendEnabled:false,privateText:'private-draft-canary'}}})+'\n');
  await assert.rejects(pending,e=>{assert.equal(e.code,'E_GUI_LOCATE_MISSING');assert.equal(e.dispatched,false);assert.deepEqual(e.diagnostic,{operation:'newTask',candidateCount:0,method:'background-ax',guardChecks:{draftMatched:true,sendEnabled:false}});assert(!JSON.stringify(e.diagnostic).includes('private-'));return true;});
 }finally{await client.close();}
});
