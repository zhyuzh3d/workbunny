'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const {boundaryVisual}=require('./support/workbuddy-boundary-visual-fixture.cjs');
const bundleId='com.tencent.workbuddy.mac',marker='[workbunny:bcf0b2af-d420-4fb4-8fa3-98effc9246c9]';
const text='Complete current request\n'+marker,structuredScope={bundleId,pid:123,windowId:7};
async function fixture({state={},bundle=bundleId,inspectError,changeOnInspect=false}={}){
 let service;
 const complete=state.scanComplete!==false&&!state.childrenFetchErrors&&(!Object.hasOwn(state,'draftMatchesRequest')||typeof state.draftMatchesRequest==='boolean');
 const inspect=()=>{if(inspectError)throw inspectError;if(changeOnInspect)service.task.outboundText+='changed';return {available:false,scanComplete:true,editorCount:1,homeReady:true,conversationReady:true,associationMarkerPresent:true,draftEmpty:false,draftMatchesRequest:true,...state};};
 const visual=boundaryVisual({initial:{software:bundle===bundleId?'WorkBuddy':'Fixture',marker:state.associationMarkerPresent===false?'another-task':marker,draftText:state.draftEmpty?'':state.draftMatchesRequest===false?'another protected draft':text,complete,editors:state.editorCount??1,mode:state.homeReady===false?'another-page':'home'},onJudge:()=>{if(inspectError)throw inspectError;if(changeOnInspect)service.task.outboundText+='changed';},nativeRequest:async op=>{assert.equal(op,'workbuddyInspect');return inspect();}});
 service=new DesktopService({...visual,persist:async()=>{},sensitivePolicy:{check:async()=>{}}});service.running=true;service.generation=1;service.controller=new AbortController();
 service.task={id:'fixture',target:bundle===bundleId?'workbuddy':'current',scene:'life',domain:'life',visibilityFloor:1,outboundText:text,associationMarker:marker,steps:[],draftInserted:true};
 const scope={...service.visualSession.identity(),target:service.task.target},shot=await service.capture(scope,1);
 return {service,calls:visual.calls,shot,scope,visual,structuredScope};
}
const key={action:'key',key:'enter',modifiers:[],purpose:'submit'};
const inputs=h=>h.calls.filter(c=>c.op==='displayInput');
for(const action of [key,{action:'click',x:.8,y:.9,purpose:'submit'}])test(action.action+' submits only the complete host text and preserves the selected method',async()=>{
 const h=await fixture();try{
  await h.service.act({...action,expectedSubmissionText:'model-forged',expectedSubmissionMode:'conversation'},h.scope,h.shot,1);
  const submitted=inputs(h);assert.equal(submitted.length,1);assert.equal(submitted[0].payload.action,action.action);
  const proof=h.visual.judgments.at(-1).input.evidence;assert.equal(proof.expectedText,text);assert.equal(proof.mode,'home');assert.equal(proof.marker,marker);
  assert(submitted[0].payload.visualEvidence.frameId);assert(!h.calls.some(c=>c.op==='workbuddyInspect'));
  if(action.action==='click'){assert.equal(submitted[0].payload.x,810);assert.equal(submitted[0].payload.y,740);}
 }finally{await h.service.close();}
});
for(const [name,state,code]of [
 ['mixed draft',{draftMatchesRequest:false},'E_WORKBUDDY_DRAFT_CONFLICT'],
 ['empty composer',{draftEmpty:true,draftMatchesRequest:false},'E_WORKBUDDY_DRAFT_CONFLICT'],
 ['partial scan',{scanComplete:false},'E_GUI_DRAFT_UNVERIFIED'],
 ['missing subtree',{childrenFetchErrors:1},'E_GUI_DRAFT_UNVERIFIED'],
 ['multiple editors',{editorCount:2},'E_GUI_DRAFT_UNVERIFIED'],
 ['unreadable draft',{draftMatchesRequest:undefined},'E_GUI_DRAFT_UNVERIFIED'],
 ['wrong page',{homeReady:false},'E_GUI_DRAFT_UNVERIFIED']
])test(name+' cannot reach raw submit or mutate an unknown input record',async()=>{
 const h=await fixture({state});try{
  h.service.task.steps=[{action:'workbuddyFill',state:'intent',at:1}];const before=structuredClone(h.service.task);
  // Preserve the structured adapter's exact error contract as well as the
  // equivalent visible conflict at the production visual dispatch boundary.
  await assert.rejects(h.service.verifyWorkBuddySubmission(h.structuredScope,1),e=>e.code===code&&e.dispatched===false);
  await assert.rejects(h.service.act(key,h.scope,h.shot,1),{code:'E_GUI_DRAFT_UNVERIFIED',dispatched:false});
  assert.equal(inputs(h).length,0);assert.deepEqual(h.service.task,before);
 }finally{await h.service.close();}
});
test('a lost inspection receipt or changed task blocks raw submit',async()=>{
 for(const options of [{inspectError:Error('fixture unavailable')},{changeOnInspect:true}]){
  const h=await fixture(options);try{
   await assert.rejects(h.service.verifyWorkBuddySubmission(h.structuredScope,1),{code:'E_GUI_DRAFT_UNVERIFIED',dispatched:false});
   h.service.task.outboundText=text;await assert.rejects(h.service.act(key,h.scope,h.shot,1),{code:'E_GUI_DRAFT_UNVERIFIED',dispatched:false});assert.equal(inputs(h).length,0);
  }finally{await h.service.close();}
 }
});
test('bound follow-up submits its host marker and fails if the original conversation is absent',async()=>{
 for(const present of [true,false]){
  const h=await fixture({state:{associationMarkerPresent:present}});try{
   h.visual.state.mode='conversation';h.shot=await h.service.capture(h.scope,1);
   const run=h.service.act(key,h.scope,h.shot,1,{workBuddySubmission:{text,mode:'conversation',marker}});
   if(present){await run;const proof=h.visual.judgments.at(-1).input.evidence;assert.equal(proof.mode,'conversation');assert.equal(proof.marker,marker);assert.equal(inputs(h).length,1);}
   else{await assert.rejects(run,{code:'E_GUI_DRAFT_UNVERIFIED',dispatched:false});assert.equal(inputs(h).length,0);}
  }finally{await h.service.close();}
 }
});
test('non-submit navigation and other applications never invoke WorkBuddy inspection',async()=>{
 for(const bundle of [bundleId,'fixture.other']){
  const h=await fixture({bundle});try{await h.service.act({action:'key',key:'escape',modifiers:[],purpose:'navigation',expectedSubmissionText:'model-forged'},h.scope,h.shot,1);assert(!h.calls.some(c=>c.op==='workbuddyInspect'));assert.equal(h.visual.judgments.length,0);assert.equal(inputs(h)[0].payload.expectedSubmissionText,undefined);}finally{await h.service.close();}
 }
});
test('the last capture cannot replace approved host content, identity, round or operation version before dispatch',async()=>{
 for(const mutate of [t=>t.outboundText+='changed',t=>t.sessionId='another-session',t=>t.followUpRound=2,t=>t.steps.push({action:'key',state:'intent',at:2})]){
  const h=await fixture();try{const native=h.visual.native.request;let reviewed=false;h.visual.native.request=async(op,args)=>{if(op==='displayCapture'&&reviewed)mutate(h.service.task);return native(op,args);};const request=h.service.verificationRequest;h.service.visualSession.request=async options=>{const result=await request(options);if(options.messages[0].content.includes('只根据实际截图核对'))reviewed=true;return result;};await assert.rejects(h.service.act(key,h.scope,h.shot,1),{code:'E_GUI_DRAFT_UNVERIFIED',dispatched:false});assert.equal(inputs(h).length,0);}finally{await h.service.close();}
 }
});
test('a click cannot submit if protected draft pixels change after the visual judgment',async()=>{
 const h=await fixture();try{const request=h.service.visualSession.request;h.service.visualSession.request=async options=>{const result=await request(options);if(options.messages[0].content.includes('只根据实际截图核对'))h.visual.state.draftText='different protected draft';return result;};await assert.rejects(h.service.act({action:'click',purpose:'submit',x:.8,y:.9},h.scope,h.shot,1),{dispatched:false});assert.equal(inputs(h).length,0);}finally{await h.service.close();}
});
test('all visual input rechecks liveness and authorization after its final asynchronous capture',async()=>{
 for(const kind of ['generation','scene','revoked-channel','channel-version','execution-authorization','content','focus-click']){
  const h=await fixture({bundle:'fixture.other'});let revoked=false;try{
   if(kind!=='scene')h.service.task.channelAuthorization={account:require('../src/main/visual-session').visualAccount(h.scope),scene:'life',revision:1};
   h.service.sensitivePolicy.checkChannel=()=>{if(revoked)throw Error('fixture channel authorization revoked');};
   const native=h.visual.native.request;let captures=0;
   h.visual.native.request=async(op,args)=>{if(op==='displayCapture'&&++captures===2){
    if(kind==='generation'||kind==='focus-click')h.service.generation++;
    if(kind==='scene')h.service.getScene=()=> 'work';
    if(kind==='revoked-channel')revoked=true;
    if(kind==='channel-version')h.service.task.channelAuthorization.revision++;
    if(kind==='execution-authorization')h.service.task.executionAuthorization={scene:'private',revision:2};
    if(kind==='content')h.service.task.message='a replacement message';
   }return native(op,args);};
   const action=kind==='focus-click'?{action:'type',purpose:'task',text:'approved input',focus:{x:.5,y:.75}}:{action:'key',key:'escape',modifiers:[],purpose:'navigation'};
   await assert.rejects(h.service.act(action,h.scope,h.shot,1),e=>e.dispatched===false,kind);assert.equal(inputs(h).length,0,kind);
  }finally{await h.service.close();}
 }
});
