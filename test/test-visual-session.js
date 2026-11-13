'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,paint,raster}=require('./support/visual-fixture.cjs');
test('held planning frames survive background observation churn and estimated region changes with a bounded cache',async()=>{
 const h=fixture(),frame=await h.visual.observe(),release=h.visual.holdFrame(frame.visualFrameId);
 h.location={...h.location,mainRegion:{...h.location.mainRegion,x:.12,width:.78}};
 for(let i=0;i<8;i++)await h.visual.observe({relocate:i===0});
 assert(h.visual.frames.has(frame.visualFrameId));assert(h.visual.frames.size<=5);await h.visual.input(frame.visualFrameId,{action:'click',x:140,y:60});
 release();release();assert.equal(h.visual.frameHolds.size,0);assert(h.visual.frames.size<=4);
 for(let i=0;i<4;i++)await h.visual.observe();assert(!h.visual.frames.has(frame.visualFrameId));
});
test('holding a frame never bypasses actual geometry, identity, cancellation or session invalidation',async()=>{
 for(const change of ['geometry','identity','cancel','reset']){
  const h=fixture(),frame=await h.visual.observe(),release=h.visual.holdFrame(frame.visualFrameId),controller=new AbortController();
  if(change==='identity')paint(h.image,h.location.identityRegion);
  if(change==='geometry'){const request=h.native.request;h.native.request=async(op,...args)=>({...await request(op,...args),...(op==='displayCapture'?{desktopRect:{x:5,y:0,width:200,height:120}}:{})});}
  if(change==='cancel')controller.abort();if(change==='reset')h.visual.reset();
  await assert.rejects(h.visual.input(frame.visualFrameId,{action:'click',x:140,y:60},{signal:controller.signal}),{code:'E_VISUAL_TARGET'});assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0);release();
 }
});
test('visual targeting and input use only display pixels and global input, accepting the default Buffer image contract',async()=>{
 const h=fixture(),shot=await h.visual.observe();assert.equal(shot.identity.mode,'visual');assert.equal(shot.width,160);assert.equal(h.requests.length,1);
 await h.visual.input(shot.visualFrameId,{action:'click',x:100,y:60});assert.deepEqual(h.calls.map(c=>c.op),['displayCapture','displayCapture','displayInput']);
 assert.deepEqual(h.calls[0].args,{output:'base64'});assert.equal(h.calls.at(-1).args.visualEvidence.frameId,shot.visualFrameId);assert(!JSON.stringify(h.calls).match(/windowId|bundleId|"pid"|frontmost|recognize/u));
});
test('input receipt timeout covers bounded HID setup and movement without renewing evidence or retrying a rejected input',async()=>{
 const h=fixture(),request=h.native.request;let dispatched;
 h.native.request=async(op,args,timeoutMs,context)=>{
  if(op!=='displayInput')return request(op,args,timeoutMs,context);
  dispatched={args,timeoutMs};
  throw Object.assign(Error('synthetic expired evidence'),{code:'E_VISUAL_EVIDENCE_EXPIRED',dispatched:false,inputOutcome:{completion:'not-dispatched',reportsSubmitted:0}});
 };
 const frame=await h.visual.observe();
 await assert.rejects(h.visual.input(frame.visualFrameId,{action:'click',x:100,y:60}),e=>e.code==='E_VISUAL_EVIDENCE_EXPIRED'&&e.dispatched===false);
 assert.equal(dispatched.timeoutMs,12000);assert.equal(dispatched.args.visualEvidence.capturedAt,frame.capturedAt);assert.equal(dispatched.args.visualEvidence.frameId,frame.visualFrameId);
 assert.equal(h.calls.filter(c=>c.op==='displayCapture').length,2,'one final fresh preflight, with no automatic input retry');
});
test('a prepared pointer obtains a new CGDisplayStream proof without retimestamping its old observation or adding model calls',async()=>{
 const h=fixture(),request=h.native.request;let initial,fresh,approvals=0;
 h.native.request=async(op,args,timeoutMs,context)=>{if(op!=='displayInput')return request(op,args,timeoutMs,context);initial={...args.visualEvidence};h.advance(4000);fresh=await context.refreshVisualEvidence();assert.equal(args.visualEvidence.capturedAt,initial.capturedAt);return {performed:true,inputOutcome:{moved:true,pointerCommitState:'acknowledged'}};};
 const frame=await h.visual.observe(),result=await h.visual.input(frame.visualFrameId,{action:'click',x:100,y:60},{beforeDispatch:()=>{approvals++;}});
 assert.equal(initial.capturedAt,100000);assert.equal(fresh.capturedAt,104000);assert.equal(fresh.frameId,frame.visualFrameId);assert.equal(approvals,2);assert.equal(result.inputOutcome.pointerCommitState,'acknowledged');assert.equal(h.requests.length,1);assert.equal(h.calls.filter(c=>c.op==='displayCapture').length,3);
});
test('an acknowledged same-plan focus click refreshes actual pixels with stable geometry and no location model before typing',async()=>{
 const h=fixture(),frame=await h.visual.observe();await h.visual.input(frame.visualFrameId,{action:'click',x:80,y:85});assert.equal(h.visual.anchor.needsRelocate,true);
 h.advance(200);const fresh=await h.visual.refreshFrame(frame.visualFrameId,{focusPoint:{x:80,y:85}});assert.notEqual(fresh.visualFrameId,frame.visualFrameId);assert.equal(fresh.capturedAt,100200);assert.deepEqual(fresh.desktopRect,frame.desktopRect);assert.deepEqual(fresh.identity,frame.identity);assert.deepEqual(fresh.mainRegion,frame.mainRegion);assert.equal(h.visual.anchor.needsRelocate,false);
 await h.visual.input(fresh.visualFrameId,{action:'type',text:'synthetic planned text'});assert.equal(h.requests.length,1);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,2);
 await assert.rejects(h.visual.refreshFrame(frame.visualFrameId),{code:'E_VISUAL_TARGET'});
});
test('cheap focus refresh requires the exact acknowledged click and rejects changed identity, geometry or cancelled sessions without another model',async()=>{
 for(const change of ['missing-receipt','uncertain','wrong-point','identity','geometry','cancel','reset']){
  const h=fixture(),controller=new AbortController(),frame=await h.visual.observe();
  if(change!=='missing-receipt'){
   if(change==='uncertain'){const request=h.native.request;h.native.request=async(op,...args)=>op==='displayInput'?{performed:false}:request(op,...args);}
   await h.visual.input(frame.visualFrameId,{action:'click',x:80,y:85});
  }
  if(change==='identity')paint(h.image,h.location.identityRegion);
  if(change==='geometry'){const request=h.native.request;h.native.request=async(op,...args)=>({...await request(op,...args),...(op==='displayCapture'?{desktopRect:{x:5,y:0,width:200,height:120}}:{})});}
  if(change==='cancel')controller.abort();if(change==='reset')h.visual.reset();
  await assert.rejects(h.visual.refreshFrame(frame.visualFrameId,{signal:controller.signal,focusPoint:{x:change==='wrong-point'?90:80,y:85}}),{code:'E_VISUAL_TARGET'});assert.equal(h.requests.length,1);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,change==='missing-receipt'||change==='uncertain'?0:1);
 }
});
test('acknowledged focusing may change editor appearance, while the next keyboard input still needs its fresh pixel baseline',async()=>{
 for(const subsequentChange of [false,true]){
  const h=fixture(),frame=await h.visual.observe();await h.visual.input(frame.visualFrameId,{action:'click',x:80,y:85});
  paint(h.image,h.location.focusRegion);h.advance(200);
  const fresh=await h.visual.refreshFrame(frame.visualFrameId,{focusPoint:{x:80,y:85}});assert.equal(fresh.capturedAt,100200);assert.notEqual(fresh.pngBase64,frame.pngBase64);assert.deepEqual(fresh.desktopRect,frame.desktopRect);
  if(subsequentChange){await h.visual.input(fresh.visualFrameId,{action:'key',key:'tab',modifiers:[]});paint(h.image,h.location.focusRegion,20);await assert.rejects(h.visual.input(fresh.visualFrameId,{action:'type',text:'synthetic planned text'}),e=>e.code==='E_VISUAL_TARGET'&&e.dispatched===false);}
  else assert.equal((await h.visual.input(fresh.visualFrameId,{action:'type',text:'synthetic planned text'})).performed,true);
  assert.equal(h.requests.length,1);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,2);
 }
});
test('an acknowledged focus and select-all/delete chain accepts its own editor appearance changes without another recognition model',async()=>{
 for(const explicitRefresh of [false,true]){
  const h=fixture();h.location.focusRegion=null;h.location.focusEvidence='';const original=await h.visual.observe();await h.visual.input(original.visualFrameId,{action:'click',x:80,y:85});
  const frame=explicitRefresh?await h.visual.refreshFrame(original.visualFrameId,{focusPoint:{x:80,y:85}}):original;
  const patch={x:.35,y:.69,width:.1,height:.03};paint(h.image,patch);
  await h.visual.input(frame.visualFrameId,{action:'key',key:'a',modifiers:['cmd']});paint(h.image,patch,30);
  await h.visual.input(frame.visualFrameId,{action:'key',key:'backspace',modifiers:[]});paint(h.image,patch,200);
  await h.visual.input(frame.visualFrameId,{action:'type',text:'synthetic authorized replacement'});
  assert.equal(h.requests.length,1);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,4);
 }
});
test('editor continuation cannot waive changed identity or an explicit protected region',async()=>{
 for(const changed of ['identity','protected']){
  const h=fixture(),frame=await h.visual.observe();await h.visual.input(frame.visualFrameId,{action:'click',x:80,y:85});
  paint(h.image,changed==='identity'?h.location.identityRegion:{x:.66,y:.66,width:.08,height:.08});
  await assert.rejects(h.visual.input(frame.visualFrameId,{action:'type',text:'synthetic original text'},{regions:changed==='protected'?[{x:.7,y:.7,width:.1,height:.1}]:[]}),{code:'E_VISUAL_TARGET'});assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 }
});
test('planned acknowledged focus can proceed despite a missing or differently estimated locator focus box',async()=>{
 for(const focus of [null,{x:.2,y:.3,width:.2,height:.1}]){
  const h=fixture();h.location.focusRegion=focus;h.location.focusEvidence=focus?'earlier focus estimate':'';
  const frame=await h.visual.observe();await h.visual.input(frame.visualFrameId,{action:'click',x:80,y:85});
  const fresh=await h.visual.refreshFrame(frame.visualFrameId,{focusPoint:{x:80,y:85}});await h.visual.input(fresh.visualFrameId,{action:'type',text:'synthetic planned text'});
  assert.equal(h.requests.length,1);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,2);assert.deepEqual(fresh.desktopRect,frame.desktopRect);
 }
});
test('post-movement visual preflight still rejects changed target pixels, cancelled sessions and changed host approval',async()=>{
 for(const change of ['pixels','cancel','reset','approval']){
  const h=fixture(),request=h.native.request,controller=new AbortController();let approvals=0,commits=0;
  h.native.request=async(op,args,timeoutMs,context)=>{if(op!=='displayInput')return request(op,args,timeoutMs,context);h.advance(4000);if(change==='pixels')paint(h.image,{x:.46,y:.46,width:.08,height:.08});if(change==='cancel')controller.abort();if(change==='reset')h.visual.reset();await context.refreshVisualEvidence();commits++;return {performed:true};};
  const frame=await h.visual.observe();await assert.rejects(h.visual.input(frame.visualFrameId,{action:'click',x:100,y:60},{signal:controller.signal,beforeDispatch:()=>{if(++approvals===2&&change==='approval')throw Error('approval replaced');}}));assert.equal(commits,0);
 }
});
test('small local caret and hover rendering changes allow a prepared pointer without another model call or renewed timestamps',async()=>{
 for(const change of ['caret','hover']){
  const h=fixture(),request=h.native.request;h.image=raster(884,1124);let proof,commits=0;
  h.native.request=async(op,args,timeoutMs,context)=>{
   if(op!=='displayInput')return request(op,args,timeoutMs,context);
   h.advance(4000);
   // 20 changed pixels in the ~50x36 target neighborhood: above the old
   // 0.3% gate, within the established local 1.5% evidence tolerance.
   if(change==='caret')paint(h.image,{x:442/884,y:552/1124,width:1/884,height:20/1124});
   else paint(h.image,{x:432/884,y:562/1124,width:20/884,height:1/1124});
   proof=await context.refreshVisualEvidence();commits++;return {performed:true};
  };
  const frame=await h.visual.observe();assert.equal((await h.visual.input(frame.visualFrameId,{action:'click',x:442,y:562})).performed,true);
  assert.equal(commits,1);assert.equal(proof.capturedAt,104000);assert.equal(frame.capturedAt,100000);assert.equal(h.requests.length,1);assert.equal(h.calls.filter(c=>c.op==='displayCapture').length,3);
 }
});
test('local pointer tolerance still rejects actual covering, displaced controls, identity changes and protected-region changes',async()=>{
 for(const change of ['cover','move','identity','protected']){
  const h=fixture(),request=h.native.request;h.image=raster(884,1124);let commits=0;
  if(change==='move')paint(h.image,{x:420/884,y:554/1124,width:40/884,height:16/1124});
  h.native.request=async(op,args,timeoutMs,context)=>{
   if(op!=='displayInput')return request(op,args,timeoutMs,context);
   if(change==='cover')paint(h.image,{x:425/884,y:549/1124,width:35/884,height:25/1124});
   if(change==='move'){paint(h.image,{x:420/884,y:554/1124,width:40/884,height:16/1124},90);paint(h.image,{x:435/884,y:554/1124,width:40/884,height:16/1124});}
   if(change==='identity')paint(h.image,{x:.2,y:.12,width:.3,height:.15});
   if(change==='protected')paint(h.image,{x:.66,y:.66,width:.08,height:.08});
   await context.refreshVisualEvidence();commits++;return {performed:true};
  };
  const frame=await h.visual.observe();await assert.rejects(h.visual.input(frame.visualFrameId,{action:'click',x:442,y:562},{regions:change==='protected'?[{x:.7,y:.7,width:.1,height:.1}]:[]}),{code:'E_VISUAL_TARGET'});
  assert.equal(commits,0);assert.equal(h.requests.length,1,'a larger real change returns to the existing planner without adding semantic approval');
 }
});
test('the same small-change tolerance covers a caret in a small focused editor while a replaced editor stays blocked',async()=>{
 for(const change of ['caret','replaced-editor']){
  const h=fixture();h.image=raster(884,1124);h.location.focusRegion={x:.49,y:.49,width:.02,height:.03};
  const frame=await h.visual.observe();
  if(change==='caret')paint(h.image,{x:442/884,y:554/1124,width:1/884,height:20/1124});
  else paint(h.image,h.location.focusRegion);
  if(change==='caret')assert.equal((await h.visual.input(frame.visualFrameId,{action:'key',key:'right',modifiers:[]})).performed,true);
  else await assert.rejects(h.visual.input(frame.visualFrameId,{action:'key',key:'right',modifiers:[]}),e=>e.code==='E_VISUAL_TARGET'&&e.dispatched===false);
  assert.equal(h.requests.length,1,'ordinary focused-editor rendering needs no new semantic approval');
 }
});
test('Buffer and resized object previews both locate, while a missing pixel crop fails without another channel',async()=>{
 const h=fixture({imageResize:preview=>({preview,mime:'image/png',width:200,height:120})});assert((await h.visual.observe()).visualFrameId);
 const absent=fixture({imageCrop:undefined});await assert.rejects(absent.visual.observe(),/裁切/);assert(absent.calls.every(c=>c.op==='displayCapture'));
});
test('read-only sampling of inactive visible targets keeps stability checks and does not invent keyboard focus',async()=>{
 const h=fixture();h.location.active=false;h.location.focusRegion=null;h.location.focusEvidence='';
 const first=await h.visual.sample('read-only');assert(first.baseline);h.visual.commitSample('read-only');
 paint(h.image,{x:.6,y:.4,width:.1,height:.05});
 const changed=await h.visual.sample('read-only',{settleMs:0});assert(changed.changed);assert(!changed.unstable);
 assert.equal(h.visual.anchor.active,false);
 await assert.rejects(h.visual.input(changed.visualFrameId,{action:'key',key:'enter',modifiers:[]}),e=>e.code==='E_VISUAL_TARGET'&&e.dispatched===false);
 h.location={available:false,unavailableKind:'security',evidence:'synthetic visible security prompt',reason:'synthetic security prompt'};
 paint(h.image,{x:.6,y:.4,width:.1,height:.05},20);
 await assert.rejects(h.visual.sample('read-only',{reset:true}),e=>e.code==='E_VISUAL_TARGET'&&e.diagnostic.visualState.requiresOwner===true);
 assert(h.calls.every(call=>call.op==='displayCapture'));
});
test('a visible inactive target can receive planned clicks or scrolling without a separate activation region',async()=>{
 for(const action of [{action:'click',x:100,y:60},{action:'scroll',x:100,y:60,deltaY:-80}]){
  const h=fixture(),request=h.native.request;h.location={...h.location,active:false,activationRegion:null,activationEvidence:'',focusRegion:null,focusEvidence:''};let preparedChecks=0;
  h.native.request=async(op,args,timeoutMs,context)=>{if(op==='displayInput'){await context.refreshVisualEvidence();preparedChecks++;}return request(op,args,timeoutMs,context);};
  const frame=await h.visual.observe();assert.equal((await h.visual.input(frame.visualFrameId,action)).performed,true);assert.equal(preparedChecks,1);assert.equal(h.requests.length,1,'ordinary pointing does not add another semantic readiness request');assert.equal(h.visual.anchor.active,false);
 }
});
test('keyboard input follows actual focus evidence despite a negative active flag and still rejects missing focus',async()=>{
 for(const action of [{action:'key',key:'tab',modifiers:[]},{action:'type',text:'synthetic short draft'}])for(const focus of [false,true]){
  const h=fixture();h.location.active=false;if(!focus){h.location.focusRegion=null;h.location.focusEvidence='';}
  const frame=await h.visual.observe({allowInactive:true});
  if(focus){assert.equal((await h.visual.input(frame.visualFrameId,action)).performed,true);assert.equal(h.requests.length,1);}
  else {await assert.rejects(h.visual.input(frame.visualFrameId,action),e=>e.dispatched===false&&/焦点/u.test(e.message));assert(!h.calls.some(c=>c.op==='displayInput'));}
 }
});
test('unrelated screen activity does not block an action but changes at its actual target do',async()=>{
 const h=fixture(),shot=await h.visual.observe();paint(h.image,{x:0,y:.9,width:1,height:.1});await h.visual.input(shot.visualFrameId,{action:'click',x:100,y:60});
 paint(h.image,{x:.46,y:.46,width:.08,height:.08});await assert.rejects(h.visual.input(shot.visualFrameId,{action:'click',x:100,y:60}),e=>e.dispatched===false);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
});
test('a rejected target outside observation monitors forces fresh visual location without relaxing input protection',async()=>{
 const trace=require('../src/main/operation-diagnostics'),recorder=new trace.OperationDiagnostics(),h=fixture();
 const old=await h.visual.observe();
 paint(h.image,{x:.46,y:.72,width:.08,height:.08});
 await assert.rejects(trace.using(recorder,()=>h.visual.input(old.visualFrameId,{action:'scroll',x:100,y:90,deltaY:-100})),e=>e.dispatched===false);
 assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0);
 assert(recorder.events.some(e=>e.stage==='input-preflight'&&e.status==='validation-failed'&&e.matched===false));
 const fresh=await h.visual.observe();
 assert.equal(h.requests.length,2,'the failed target is re-located even though monitored content and identity did not change');
 assert.equal(fresh.identity.sessionId,old.identity.sessionId);
 await h.visual.input(fresh.visualFrameId,{action:'scroll',x:100,y:90,deltaY:-100});
 assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
});
test('a moved target requires visual identity confirmation and invalidates its old input frame',async()=>{
 const h=fixture(),old=await h.visual.observe();paint(h.image,{x:.1,y:.1,width:.8,height:.8},200);
 h.location={...h.location,region:{x:.13,y:.1,width:.8,height:.8},mainRegion:{x:.13,y:.1,width:.8,height:.8},monitorRegions:[{x:.13,y:.1,width:.8,height:.5}]};
 const moved=await h.visual.observe();assert.equal(h.requests.length,2);assert.equal(moved.identity.sessionId,old.identity.sessionId);await assert.rejects(h.visual.input(old.visualFrameId,{action:'click',x:100,y:60}),/不可用/);await h.visual.input(moved.visualFrameId,{action:'click',x:100,y:60});
});
test('small rendering differences are tolerated and a real identity change stops and revokes old frames',async()=>{
 const h=fixture(),old=await h.visual.observe();paint(h.image,{x:.2,y:.12,width:.3,height:.15},100);const same=await h.visual.observe();assert.equal(h.requests.length,1,'color changes below pixel tolerance reuse visual evidence');
 paint(h.image,{x:.2,y:.12,width:.3,height:.15},250);h.location.sameIdentity=false;await assert.rejects(h.visual.observe(),/锚点/);await assert.rejects(h.visual.input(same.visualFrameId,{action:'click',x:100,y:60}),/不可用/);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0);assert.equal(old.identity.sessionId,same.identity.sessionId);
});
test('an unchanged actual visual anchor supports progress despite one negative model continuity flag',async()=>{
 const h=fixture(),old=await h.visual.observe();h.location.sameIdentity=false;
 paint(h.image,{x:.6,y:.4,width:.1,height:.1},250);
 const next=await h.visual.observe();assert.equal(next.identity.sessionId,old.identity.sessionId);assert.equal(h.requests.length,2);
 await h.visual.input(next.visualFrameId,{action:'click',x:100,y:60});assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
});
test('tiny VLM region rounding is tolerated, border click validation is clipped, and display changes stop stale input',async()=>{
 const h=fixture(),old=await h.visual.observe();h.location={...h.location,mainRegion:{...h.location.mainRegion,x:.101,width:.799}};await h.visual.observe({relocate:true});await h.visual.input(old.visualFrameId,{action:'click',x:20.1,y:12.1});
 h.image=raster(201,120);await assert.rejects(h.visual.input(old.visualFrameId,{action:'click',x:100,y:60}),/几何/);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
});
test('focus has to be visible, cancellation before dispatch sends nothing, cancellation after dispatch retains truth',async()=>{
 const h=fixture();h.location.focusRegion=null;h.location.focusEvidence='';const shot=await h.visual.observe();await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'a',modifiers:[]}),/焦点/);
 await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'a',modifiers:[]},{regions:[]}),/焦点/);
 const before=new AbortController();before.abort();await assert.rejects(h.visual.input(shot.visualFrameId,{action:'click',x:100,y:60},{signal:before.signal}),e=>e.dispatched===false);assert(!h.calls.some(c=>c.op==='displayInput'));
 const after=new AbortController(),b=fixture({onInput:()=>after.abort()}),next=await b.visual.observe();const result=await b.visual.input(next.visualFrameId,{action:'key',key:'a',modifiers:[]},{signal:after.signal});assert.equal(result.performed,true);assert.equal(result.cancelledAfterDispatch,true);assert.equal(b.calls.filter(c=>c.op==='displayInput').length,1);
});
test('a location result from before reset cannot adopt the new session or revoke its fresh frames',async()=>{
 const entered=Promise.withResolvers(),delayed=Promise.withResolvers();let models=0;
 const h=fixture({beforeModel:async()=>{if(++models===1){entered.resolve();await delayed.promise;}}});
 const stale=h.visual.observe();await entered.promise;h.visual.reset();
 const fresh=await h.visual.observe(),anchor=h.visual.anchor;
 const rejected=assert.rejects(stale,e=>e.code==='E_VISUAL_TARGET'&&e.dispatched===false);
 delayed.resolve();await rejected;
 assert.equal(h.visual.anchor,anchor);assert(h.visual.frames.has(fresh.visualFrameId));
 assert.equal(h.visual.frames.size,1);assert(h.calls.every(c=>c.op==='displayCapture'));
});
test('a capture started before reset cannot be located or cached in the replacement session',async()=>{
 const entered=Promise.withResolvers(),delayed=Promise.withResolvers();let captures=0;
 const h=fixture({beforeCapture:async()=>{if(++captures===1){entered.resolve();await delayed.promise;}}});
 const stale=h.visual.observe();await entered.promise;h.visual.reset();
 const fresh=await h.visual.observe(),models=h.requests.length;
 const rejected=assert.rejects(stale,e=>e.dispatched===false);delayed.resolve();await rejected;
 assert(h.visual.frames.has(fresh.visualFrameId));assert.equal(h.requests.length,models);
 assert.equal(h.visual.frames.size,1);
});
test('reset at the final dispatch check revokes the old operation before any input',async()=>{
 const h=fixture(),frame=await h.visual.observe();
 await assert.rejects(h.visual.input(frame.visualFrameId,{action:'click',x:100,y:60},{beforeDispatch:()=>h.visual.reset()}),e=>e.dispatched===false);
 assert(h.calls.every(c=>c.op==='displayCapture'));
});
test('an old dispatched input preserves its receipt without changing a replacement session or its typing proof',async()=>{
 const entered=Promise.withResolvers(),delayed=Promise.withResolvers();
 const h=fixture({onInput:async()=>{entered.resolve();await delayed.promise;}}),old=await h.visual.observe();
 const input=h.visual.input(old.visualFrameId,{action:'type',text:'synthetic text'});await entered.promise;
 h.visual.reset();const fresh=await h.visual.observe(),anchor=h.visual.anchor;delayed.resolve();
 const result=await input;assert.equal(result.performed,true);assert.equal(result.cancelledAfterDispatch,true);
 assert.equal(h.visual.anchor,anchor);assert.equal(anchor.needsRelocate,undefined);assert.equal(h.visual.acknowledgedInput,null);
 assert(h.visual.frames.has(fresh.visualFrameId));assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
});
test('ambiguous or security/login screens never dispatch and clear previously reusable input proof',async()=>{
 const h=fixture(),shot=await h.visual.observe();h.location={available:false,reason:'可见安全登录提示'};await assert.rejects(h.visual.observe({relocate:true}),/安全登录/);await assert.rejects(h.visual.input(shot.visualFrameId,{action:'click',x:100,y:60}),/不可用/);assert(!h.calls.some(c=>c.op==='displayInput'));
});
test('the shared activation mechanism uses only a confirmed safe pixel region and reobserves before returning an active frame',async()=>{
 let h;h=fixture({onInput:()=>{h.location.active=true;}});h.location.active=false;h.location.activationRegion={x:.6,y:.12,width:.1,height:.05};h.location.activationEvidence='visible empty title area';
 const activated=await h.visual.activate();assert.equal(activated.activated,true);assert(activated.frame.visualFrameId);assert.equal(activated.receipt.inputPerformed,true);
 const inputs=h.calls.filter(c=>c.op==='displayInput');assert.equal(inputs.length,1);assert.equal(inputs[0].args.x,130);assert.equal(inputs[0].args.y,17.4);assert.equal(h.requests.length,2);
 const again=await h.visual.activate();assert.equal(again.alreadyVisuallyActive,true);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 for(const kind of ['missing-region','missing-evidence','security']){const f=fixture();f.location.active=false;
  if(kind==='missing-evidence')f.location.activationRegion={x:.6,y:.12,width:.1,height:.05};
  if(kind==='security')f.location={available:false,unavailableKind:'security',evidence:'visible login security notice',reason:'security notice'};
  await assert.rejects(f.visual.activate(),e=>e.code==='E_VISUAL_TARGET');assert(f.calls.every(c=>c.op==='displayCapture'));
 }
});
test('a missing safe activation region is reconsidered on the next bounded attempt even when pixels stay unchanged',async()=>{
 let h;h=fixture({onInput:()=>{h.location.active=true;}});h.location.active=false;
 await assert.rejects(h.visual.activate(),e=>e.code==='E_VISUAL_TARGET'&&e.dispatched===false);
 assert.equal(h.requests.length,1);assert(h.calls.every(c=>c.op==='displayCapture'));
 const identity=h.visual.identity();
 h.location={...h.location,activationRegion:{x:.6,y:.12,width:.1,height:.05},activationEvidence:'visible empty title area'};
 const result=await h.visual.activate();
 assert.equal(result.activated,true);assert.equal(result.receipt.inputPerformed,true);
 assert.deepEqual(h.visual.identity(),identity,'reconsideration preserves the existing visual identity');
 assert.equal(h.requests.length,3,'fresh location is followed by actual post-input location');
 assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
});
test('failed activation observation preserves the security finding and input receipt without another automatic click',async()=>{
 let h;h=fixture({onInput:()=>{h.location={available:false,unavailableKind:'security',evidence:'synthetic visible security notice',reason:'synthetic security notice'};}});const original={...h.location,active:false,activationRegion:{x:.6,y:.12,width:.1,height:.05},activationEvidence:'synthetic safe title area'};h.location=original;
 const result=await h.visual.activate();assert.equal(result.activated,false);assert.equal(result.observationError.diagnostic.visualState.requiresOwner,true);assert.equal(result.observationError.diagnostic.inputReceipt.state,'acknowledged');assert.equal(result.receipt.inputPerformed,true);
 h.location=original;const again=await h.visual.activate();assert.equal(again.frame,undefined);assert.equal(again.receipt.inputPerformed,true);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 assert.equal((await h.visual.activate({retry:true,retryKey:'cannot-clear-owner-boundary'})).frame,undefined);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 h.location={...original,active:true};h.visual.anchor.needsRelocate=true;assert.equal((await h.visual.activate()).frame,undefined,'a new active view does not override an owner-required finding');h.visual.reset();assert((await h.visual.activate()).frame);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 const unknown=fixture({onInput:()=>{throw Error('synthetic lost input receipt');}});unknown.location={...unknown.location,active:false,activationRegion:original.activationRegion,activationEvidence:original.activationEvidence};
 await assert.rejects(unknown.visual.activate(),e=>e.diagnostic.inputReceipt.state==='unconfirmed');assert.equal((await unknown.visual.activate()).frame,undefined);assert.equal(unknown.calls.filter(c=>c.op==='displayInput').length,1);
 await assert.rejects(unknown.visual.activate({retry:true,retryKey:'new-fixture-decision'}),e=>e.diagnostic.inputReceipt.state==='unconfirmed');assert.equal(unknown.calls.filter(c=>c.op==='displayInput').length,2);
 assert.equal((await unknown.visual.activate({retry:true,retryKey:'new-fixture-decision'})).frame,undefined);assert.equal(unknown.calls.filter(c=>c.op==='displayInput').length,2,'one renewed decision cannot loop');
});
test('visual geometry failures retain their exact typed field and permit one targeted same-frame correction',async()=>{
 for(const [field,value,expected,type]of [['mainRegion',{x:0,y:0,width:1,height:1},'box-inside-region','object'],['identityRegion',{x:0,y:0,width:1,height:1},'box-inside-region','object'],['region',null,'normalized-box','null'],['monitorRegions',[{x:0,y:0,width:1,height:1}],'box-inside-region','object']]){
  const h=fixture();h.location[field]=value;await assert.rejects(h.visual.observe(),e=>e.diagnostic.schemaAudit.field===(field==='monitorRegions'?'monitorRegions[0]':field)&&e.diagnostic.schemaAudit.expected===expected&&e.diagnostic.schemaAudit.actualType===type);assert(h.calls.every(c=>c.op==='displayCapture'));
 }
 const h=fixture(),valid={...h.location};let calls=0;h.visual.request=async options=>{calls++;if(calls===1)return {response:{text:JSON.stringify({...valid,mainRegion:{x:0,y:0,width:1,height:1}})}};assert.match(options.messages.at(-1).content,/mainRegion/);assert.match(options.messages.at(-1).content,/box-inside-region/);return {response:{text:JSON.stringify(valid)}};};
 assert((await h.visual.observe()).visualFrameId);assert.equal(calls,2);assert.equal(h.calls.filter(c=>c.op==='displayCapture').length,1);
});
test('location output has one full-display coordinate reference and the host alone projects text into the crop',async()=>{
 const h=fixture(),wire={...h.location,texts:[{text:'synthetic-label',x:.26,y:.34,width:.16,height:.08,confidence:.9}]};
 h.visual.request=async options=>{assert.match(options.messages[0].content,/不能使用目标region局部坐标/);return {response:{text:JSON.stringify(wire)}};};
 const frame=await h.visual.observe(),row=frame.texts[0];for(const [key,value]of Object.entries({x:.2,y:.3,width:.2,height:.1}))assert(Math.abs(row[key]-value)<1e-12,key);assert.equal(h.visual.anchor.texts[0].x,.26);assert(h.calls.every(c=>c.op==='displayCapture'));
 const invalid=fixture();invalid.visual.request=async()=>({response:{text:JSON.stringify({...invalid.location,texts:[{text:'synthetic-label',x:.02,y:.04,width:.03,height:.01,confidence:.9}]})}});
 assert.deepEqual((await invalid.visual.observe()).texts,[]);assert(invalid.calls.every(c=>c.op==='displayCapture'));
});
test('invalid optional coarse text rows are filtered once without weakening critical location anchors',async()=>{
 const trace=require('../src/main/operation-diagnostics'),recorder=new trace.OperationDiagnostics(),h=fixture();let calls=0;
 h.visual.request=async()=>{calls++;return {response:{text:JSON.stringify({...h.location,texts:[{text:'valid',x:.26,y:.34,width:.16,height:.08,confidence:.9},{text:'private-filter-canary',x:.01,y:.01,width:.03,height:.01,confidence:.9},null,{text:'invalid-confidence',x:.26,y:.34,width:.16,height:.08,confidence:'0.9'}]})}};};
 const frame=await trace.using(recorder,()=>h.visual.observe());assert.equal(calls,1);assert.deepEqual(frame.texts.map(r=>r.text),['valid']);assert.equal(frame.identity.sessionId,h.visual.sessionId);const audit=recorder.events.find(e=>e.stage==='visual-aux-filter');assert.equal(audit.observedItems,4);assert.equal(audit.retainedItems,1);assert.equal(audit.discardedItems,3);assert.equal(audit.schemaAudit.field,'texts[1]');assert(!JSON.stringify(recorder.events).includes('private-filter-canary'));assert(h.calls.every(c=>c.op==='displayCapture'));
});
test('auxiliary geometry filtering keeps original legal monitors and revokes unusable input premises without rejecting observation',async()=>{
 const h=fixture(),monitor={...h.location.monitorRegions[0]},bad={x:0,y:0,width:1,height:1};h.location={...h.location,monitorRegions:[monitor,bad,null],focusRegion:bad,focusEvidence:'invalid focus canary',activationRegion:bad,activationEvidence:'invalid activation canary'};
 const frame=await h.visual.observe();assert.equal(h.requests.length,1);assert.deepEqual(h.visual.anchor.monitorRegions.map(r=>({...r})),[monitor]);assert.equal(h.visual.anchor.focusRegion,null);assert.equal(h.visual.anchor.focusEvidence,'');assert.equal(h.visual.anchor.activationRegion,null);assert.equal(h.visual.anchor.activationEvidence,'');await assert.rejects(h.visual.input(frame.visualFrameId,{action:'key',key:'enter',modifiers:[]}),e=>e.dispatched===false);assert(h.calls.every(c=>c.op==='displayCapture'));
 const inactive=fixture();inactive.location={...inactive.location,active:false,activationRegion:bad,activationEvidence:'unusable'};assert((await inactive.visual.observe({allowInactive:true})).visualFrameId);await assert.rejects(inactive.visual.activate(),e=>e.dispatched===false);assert(inactive.calls.every(c=>c.op==='displayCapture'));
});
test('empty monitoring and invalid input evidence cannot acquire a usable input proof',async()=>{
 const empty=fixture();empty.location.monitorRegions=[];await assert.rejects(empty.visual.observe(),e=>e.diagnostic.schemaAudit.field==='monitorRegions');assert(empty.calls.every(c=>c.op==='displayCapture'));
 const h=fixture();h.location.focusEvidence=true;h.location.activationRegion={x:.6,y:.12,width:.1,height:.05};h.location.activationEvidence='';await h.visual.observe();assert.equal(h.visual.anchor.focusRegion,null);assert.equal(h.visual.anchor.activationRegion,null);assert.equal(h.requests.length,1);
});
test('generic text refinement reads only retained region pixels and binds complete projected rows to their original frame',async()=>{
 const h=fixture(),frame=await h.visual.observe(),region={x:.25,y:.2,width:.5,height:.4};let reads=0;
 h.visual.request=async options=>{reads++;const body=options.messages.find(m=>m.role==='user').content,system=options.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.equal(JSON.parse(body[0].text).purpose,'visual-text-region');assert(!JSON.stringify(options.messages).includes('expectedLabel'));assert(!/内部证据复核器|不复述证据|依据用简短结论/u.test(system));assert.equal(options.maxTokens,4096);
  assert.equal(body[1].image_url.url,'data:image/png;base64,'+h.visual.crop(frame,region).toString('base64'));return {response:{text:JSON.stringify({complete:true,texts:[{text:'Label',x:.1,y:.2,width:.2,height:.1,confidence:.9},{text:'Label',x:.1,y:.6,width:.2,height:.1,confidence:.9}]})}};};
 const result=await h.visual.readTextRegion(frame.visualFrameId,{region});assert.equal(result.frameId,frame.visualFrameId);assert.deepEqual(result.identity,frame.identity);assert.equal(result.texts.length,2);assert.equal(result.complete,true);assert(Math.abs(result.texts[0].x-(result.region.x+.1*result.region.width))<1e-12);assert.equal(reads,1);assert.deepEqual(h.calls.map(c=>c.op),['displayCapture']);
});
test('focused text refinement independently reads its label and returns every same-label scope position with a compact recovery budget',async()=>{
 const h=fixture(),frame=await h.visual.observe(),region={x:0,y:0,width:.33,height:1},focusRegion={x:.13,y:.22,width:.16,height:.05},budgets=[];
 h.visual.request=async options=>{budgets.push(options.maxTokens);const body=options.messages.find(m=>m.role==='user').content,meta=JSON.parse(body[0].text),images=body.filter(c=>c.type==='image_url');assert(meta.focusInScope);assert.equal(images.length,2);assert.equal(images[0].image_url.url,'data:image/png;base64,'+h.visual.crop(frame,region).toString('base64'));assert.equal(images[1].image_url.url,'data:image/png;base64,'+h.visual.crop(frame,focusRegion).toString('base64'));assert(!JSON.stringify(options.messages).includes('IndependentLabel'));
  if(budgets.length===1)throw Object.assign(Error('synthetic inline cap'),{code:'E_PAYLOAD_TOO_LARGE'});const f=meta.focusInScope;return {response:{text:JSON.stringify({complete:true,label:'IndependentLabel',texts:[{text:'IndependentLabel',x:f.x+f.width*.1,y:f.y+f.height*.2,width:f.width*.8,height:f.height*.4,confidence:.95},{text:'IndependentLabel',x:f.x,y:.6,width:f.width,height:.03,confidence:.95}]})}};};
 const result=await h.visual.readTextRegion(frame.visualFrameId,{region,focusRegion});assert.deepEqual(budgets,[1024,512]);assert.equal(result.label,'IndependentLabel');assert.equal(result.texts.length,2);assert.equal(result.frameId,frame.visualFrameId);assert.deepEqual(h.calls.map(c=>c.op),['displayCapture']);
 let calls=0;await assert.rejects(require('../src/main/wechat-conversation-input').approveInput({action:{action:'click',x:.2,y:.25},task:{operation:'open',recipient:'IndependentLabel'},shot:{...frame,ocr:[],mainRegion:{x:0,y:0,width:1,height:1}},review:async()=>({kind:'contact',box:focusRegion}),refineText:async()=>{calls++;return result;}}),e=>e.code==='E_WECHAT_CONVERSATION_INPUT'&&e.diagnostic.candidateCount===2);assert.equal(calls,1);
});
test('focused refinement rejects a misplaced or inconsistent label and never reads outside its scope',async()=>{
 for(const mismatch of ['outside-focus','different-label']){
  const h=fixture(),frame=await h.visual.observe();h.visual.request=async()=>({response:{text:JSON.stringify({complete:true,label:'Label',texts:[{text:mismatch==='different-label'?'Other':'Label',x:.7,y:.8,width:.1,height:.03,confidence:.9}]})}});
  await assert.rejects(h.visual.readTextRegion(frame.visualFrameId,{region:{x:0,y:0,width:.33,height:1},focusRegion:{x:.13,y:.22,width:.16,height:.05}}),e=>e.diagnostic?.schemaAudit?.field==='label'&&e.dispatched===false);assert(h.calls.every(c=>c.op==='displayCapture'));
 }
 const h=fixture(),frame=await h.visual.observe(),before=h.requests.length;await assert.rejects(h.visual.readTextRegion(frame.visualFrameId,{region:{x:0,y:0,width:.33,height:1},focusRegion:{x:.5,y:.2,width:.2,height:.1}}),e=>e.dispatched===false);assert.equal(h.requests.length,before);
});
test('text refinement cannot return late data after its frame is reset or its caller cancels',async()=>{
 for(const change of ['reset','cancel']){
  const h=fixture(),frame=await h.visual.observe(),controller=new AbortController(),gate=Promise.withResolvers();h.visual.request=()=>gate.promise;
  const work=h.visual.readTextRegion(frame.visualFrameId,{region:{x:0,y:0,width:.33,height:1},signal:controller.signal});await new Promise(r=>setImmediate(r));if(change==='reset')h.visual.reset();else controller.abort();gate.resolve({response:{text:'{"complete":true,"texts":[]}'}});
  await assert.rejects(work,e=>e.dispatched===false);assert.deepEqual(h.calls.map(c=>c.op),['displayCapture']);
 }
});
test('an uncertain small target can be reobserved with a fresh candidate enlargement, which never authorizes input',async()=>{
 const h=fixture(),original={...h.location},candidate={x:.1,y:.1,width:.8,height:.8};h.location={available:false,region:candidate,reason:'整图中文字过小，身份尚不清楚'};
 await assert.rejects(h.visual.observe(),e=>e.code==='E_VISUAL_TARGET'&&e.diagnostic.visualState.kind==='unclear'&&!e.diagnostic.visualState.requiresOwner);
 assert.equal(h.requests[0].messages[1].content.filter(p=>p.type==='image_url').length,1);assert.equal(h.visual.anchor,null);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0);
 h.advance(100);paint(h.image,{x:.3,y:.3,width:.1,height:.1},200);const fresh=h.crop(h.encode(h.image),{x:20,y:12,width:160,height:96});h.location=original;
 const shot=await h.visual.observe(),content=h.requests[1].messages[1].content,images=content.filter(p=>p.type==='image_url');assert.equal(images.length,2);assert.equal(images[1].image_url.url,'data:image/png;base64,'+fresh.toString('base64'));assert.match(content.find(p=>p.text?.includes('候选区域放大图')).text,/仍相对于第一张完整截图/);assert.equal(shot.capturedAt,100100);assert.equal(h.visual.recoveryRegion,null);assert(h.calls.every(c=>c.op==='displayCapture'));
});
test('login and security classifications require explicit visible evidence; no alternative screen backend is accepted',async()=>{
 for(const backend of ['ScreenCaptureKit','AVCaptureScreenInput']){const h=fixture(),request=h.native.request;h.native.request=async(op,args)=>({...await request(op,args),backend});await assert.rejects(h.visual.observe(),/CGDisplayStream/);assert.equal(h.requests.length,0);}
 const h=fixture();h.location={available:false,unavailableKind:'login',reason:'登录状态待核对'};await assert.rejects(h.visual.observe(),e=>!e.diagnostic.visualState.requiresOwner);
 h.location.evidence='原生窗口中可见扫码登录';await assert.rejects(h.visual.observe(),e=>e.diagnostic.visualState.kind==='login'&&e.diagnostic.visualState.requiresOwner);assert(h.calls.every(c=>c.op==='displayCapture'));
});
async function typedFrame(){
 const h=fixture(),shot=await h.visual.observe();
 await h.visual.input(shot.visualFrameId,{action:'type',text:'hello'});paint(h.image,h.location.focusRegion,230);
 return {h,shot};
}
test('confirmed typing can continue from the original frame only after fresh vision confirms the same editor and focus',async()=>{
 const {h,shot}=await typedFrame();
 await h.visual.input(shot.visualFrameId,{action:'key',key:'enter',modifiers:[]});
 const inputs=h.calls.filter(c=>c.op==='displayInput');assert.equal(inputs.length,2);assert.equal(inputs[1].args.action,'key');
 assert.notEqual(inputs[1].args.visualEvidence.frameId,shot.visualFrameId,'the submit uses a newly recognized frame, not the pre-type editor pixels');
 assert.equal(h.requests.length,2,'refreshing focus does not replan the host action');assert.equal(h.visual.acknowledgedInput,null,'one successful type cannot authorize another refresh');
 const refresh=h.requests[1].messages[1].content.find(p=>p.type==='image_url').image_url.url;
 assert.equal(refresh,'data:image/png;base64,'+h.encode(h.image).toString('base64'),'recognition receives the new post-type display pixels');
});
test('a changed editor without a confirmed type receipt cannot be refreshed or submitted',async()=>{
 for(const uncertain of ['not-performed','lost-receipt']){
  const h=fixture(),shot=await h.visual.observe(),request=h.native.request;
  h.native.request=async(op,args)=>{const result=await request(op,args);if(op==='displayInput'&&args.action==='type'){paint(h.image,h.location.focusRegion,230);if(uncertain==='lost-receipt')throw Error('type acknowledgement lost');return {performed:false};}return result;};
  if(uncertain==='lost-receipt')await assert.rejects(h.visual.input(shot.visualFrameId,{action:'type',text:'hello'}),/acknowledgement/);
  else assert.equal((await h.visual.input(shot.visualFrameId,{action:'type',text:'hello'})).performed,false);
  await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'enter'}),e=>e.dispatched===false);
  assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);assert.equal(h.requests.length,1,'uncertain input does not authorize a new focus baseline');
 }
 const h=fixture(),shot=await h.visual.observe();paint(h.image,h.location.focusRegion,230);
 await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'enter'}),e=>e.dispatched===false);assert(!h.calls.some(c=>c.op==='displayInput'));
});
test('typing cannot refresh a changed identity, display geometry or additional protected target',async()=>{
 for(const change of ['identity','geometry','related']){
  const {h,shot}=await typedFrame(),related={x:.55,y:.3,width:.1,height:.1};
  if(change==='identity')paint(h.image,h.location.identityRegion,250);
  if(change==='geometry')h.image=raster(201,120);
  if(change==='related')paint(h.image,related,250);
  await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'enter'},{regions:[related]}),e=>e.dispatched===false);
  assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);assert.equal(h.requests.length,1,'changed protected evidence cannot be rebased by recognition');
 }
});
test('refreshed typing focus rejects moved or invisible editors',async()=>{
 for(const change of ['moved-focus','missing-focus','moved-region']){
  const {h,shot}=await typedFrame();
  if(change==='moved-focus')h.location.focusRegion={x:.3,y:.65,width:.4,height:.15};
  if(change==='missing-focus'){h.location.focusRegion=null;h.location.focusEvidence='';}
  if(change==='moved-region')h.location.region={x:.11,y:.1,width:.8,height:.8};
  await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'enter'}),e=>e.dispatched===false);
  assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);assert.equal(h.visual.frames.size,0,'failed focus renewal revokes all prior input frames');
 }
});
test('typing can proceed with a stable actual anchor and editor despite one negative model continuity flag',async()=>{
 const {h,shot}=await typedFrame();h.location.sameIdentity=false;
 await h.visual.input(shot.visualFrameId,{action:'key',key:'enter'});assert.equal(h.calls.filter(c=>c.op==='displayInput').length,2);
});
test('the existing post-type focus refresh uses the same actual editor when active is uncertain',async()=>{
 const {h,shot}=await typedFrame();h.location.active=false;
 await h.visual.input(shot.visualFrameId,{action:'key',key:'tab',modifiers:[]});
 assert.equal(h.requests.length,2,'only the already-required changed-editor refresh runs');assert.equal(h.calls.filter(c=>c.op==='displayInput').length,2);assert.equal(h.visual.anchor.active,false);assert.equal(h.visual.acknowledgedInput,null);
});
test('a focus change after renewal is bounded and never automatically retries the key',async()=>{
 const {h,shot}=await typedFrame(),request=h.native.request;
 h.native.request=async(op,args)=>{if(op==='displayCapture'&&h.requests.length===2)paint(h.image,h.location.focusRegion,170);return request(op,args);};
 await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'enter'}),e=>e.dispatched===false);
 assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);assert.equal(h.requests.length,2,'there is one bounded focus renewal, not a repeated recovery loop');
});
test('a canceled type receipt and cancellation during focus renewal never continue input',async()=>{
 const controller=new AbortController(),h=fixture({onInput:()=>controller.abort()}),shot=await h.visual.observe();
 assert.equal((await h.visual.input(shot.visualFrameId,{action:'type',text:'hello'},{signal:controller.signal})).cancelledAfterDispatch,true);paint(h.image,h.location.focusRegion,230);
 await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'enter'}),e=>e.dispatched===false);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 const {h:next,shot:original}=await typedFrame(),stop=new AbortController(),request=next.visual.request;
 next.visual.request=async options=>{const result=await request(options);stop.abort();return result;};
 await assert.rejects(next.visual.input(original.visualFrameId,{action:'key',key:'enter'},{signal:stop.signal}),e=>e.dispatched===false);assert.equal(next.calls.filter(c=>c.op==='displayInput').length,1);
});
test('host approval runs after the last pixel check and its rejection proves no input was dispatched',async()=>{
 const {h,shot}=await typedFrame();let guards=0;
 await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'enter'},{beforeDispatch:()=>{
  guards++;assert.equal(h.requests.length,2,'the changed editor was recognized before checking host approval');assert.equal(h.calls.at(-1).op,'displayCapture','the final capture is complete');throw Error('host approval changed');
 }}),e=>e.dispatched===false&&/host approval changed/u.test(e.message));
 assert.equal(guards,1);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1,'only the original type was sent');
});
test('an asynchronous host guard fails closed without an unhandled rejection or native input',async()=>{
 for(const rejected of [false,true]){
  const h=fixture(),shot=await h.visual.observe();
  await assert.rejects(h.visual.input(shot.visualFrameId,{action:'key',key:'enter'},{beforeDispatch:()=>rejected?Promise.reject(Error('late guard failure')):Promise.resolve()}),e=>e.dispatched===false&&/必须同步/u.test(e.message));
  assert(!h.calls.some(c=>c.op==='displayInput'));await new Promise(resolve=>setImmediate(resolve));
 }
});
test('a changed observation context retains an uncommitted baseline until it is processed',async()=>{
 const h=fixture(),first={condition:'first condition',criteria:'first criterion',goalRevision:0},next={condition:'next condition',criteria:'next criterion',goalRevision:1};
 assert((await h.visual.sample('goal',{observationContext:first})).baseline);h.visual.commitSample('goal');
 assert.equal((await h.visual.sample('goal',{observationContext:first})).changed,false);
 assert((await h.visual.sample('goal',{observationContext:next})).baseline);
 assert((await h.visual.sample('goal',{observationContext:next})).baseline,'a failed semantic judgment must not silently reuse the previous goal baseline');
 h.visual.commitSample('goal');assert.equal((await h.visual.sample('goal',{observationContext:next})).changed,false);assert.equal(h.requests.length,2);
});
