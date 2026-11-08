'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const bundleId='com.tencent.workbuddy.mac',marker='[workbunny:bcf0b2af-d420-4fb4-8fa3-98effc9246c9]';
const text='Complete current request\n'+marker,scope={bundleId,pid:123,windowId:7},rect={x:10,y:20,width:1000,height:800};
function fixture({state={},bundle=bundleId,inspectError,changeOnInspect=false}={}){
 const calls=[];
 const native={close:async()=>{},cancel:async()=>{},request:async(op,payload)=>{
  calls.push({op,payload});
  if(op==='frontmost')return {application:{bundleId:bundle,pid:123},windows:[{pid:123,windowId:7,rect}]};
  if(op==='workbuddyInspect'){
   if(inspectError)throw inspectError;
   if(changeOnInspect)service.task.outboundText+='changed';
   return {available:false,scanComplete:true,editorCount:1,homeReady:true,conversationReady:true,associationMarkerPresent:true,draftEmpty:false,draftMatchesRequest:true,...state};
  }
  return {performed:true};
 }};
 const service=new DesktopService({native,persist:async()=>{},sensitivePolicy:{check:async()=>{}}});
 service.running=true;service.generation=1;
 service.task={id:'fixture',target:bundle===bundleId?'workbuddy':'wechat',scene:'life',domain:'life',visibilityFloor:1,outboundText:text,associationMarker:marker,steps:[],draftInserted:true};
 const shot=service.screenshot={at:Date.now(),revision:1,rect,preview:'fixture'};
 return {service,calls,shot,scope:{...scope,bundleId:bundle}};
}
const key={action:'key',key:'enter',modifiers:[],purpose:'submit'};
for(const action of [key,{action:'click',x:.8,y:.9,purpose:'submit'}])test(action.action+' submits only the complete host text and preserves the selected method',async()=>{
 const h=fixture();try{
  await h.service.act({...action,expectedSubmissionText:'model-forged',expectedSubmissionMode:'conversation'},h.scope,h.shot,1);
  const submitted=h.calls.filter(c=>['click','key'].includes(c.op));assert.equal(submitted.length,1);assert.equal(submitted[0].op,action.action);
  assert.equal(submitted[0].payload.expectedSubmissionText,text);assert.equal(submitted[0].payload.expectedSubmissionMode,'home');assert.equal(submitted[0].payload.expectedSubmissionMarker,marker);
  assert(h.calls.findIndex(c=>c.op==='workbuddyInspect')<h.calls.findIndex(c=>c.op===action.action));
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
 const h=fixture({state});try{
  h.service.task.steps=[{action:'workbuddyFill',state:'intent',at:1}];const before=structuredClone(h.service.task);
  await assert.rejects(h.service.act(key,h.scope,h.shot,1),e=>e.code===code&&e.dispatched===false);
  assert(!h.calls.some(c=>['click','key','type','workbuddyFill','workbuddySend'].includes(c.op)));assert.deepEqual(h.service.task,before);
 }finally{await h.service.close();}
});
test('a lost inspection receipt or changed task blocks raw submit',async()=>{
 for(const options of [{inspectError:Error('fixture unavailable')},{changeOnInspect:true}]){
  const h=fixture(options);try{await assert.rejects(h.service.act(key,h.scope,h.shot,1),e=>e.code==='E_GUI_DRAFT_UNVERIFIED'&&e.dispatched===false);assert(!h.calls.some(c=>c.op==='key'));}finally{await h.service.close();}
 }
});
test('bound follow-up submits its host marker and fails if the original conversation is absent',async()=>{
 for(const present of [true,false]){
  const h=fixture({state:{associationMarkerPresent:present}});try{
   const run=h.service.act(key,h.scope,h.shot,1,{workBuddySubmission:{text,mode:'conversation',marker}});
   if(present){await run;const sent=h.calls.find(c=>c.op==='key');assert.equal(sent.payload.expectedSubmissionMode,'conversation');assert.equal(sent.payload.expectedSubmissionMarker,marker);}
   else{await assert.rejects(run,{code:'E_GUI_DRAFT_UNVERIFIED',dispatched:false});assert(!h.calls.some(c=>c.op==='key'));}
  }finally{await h.service.close();}
 }
});
test('non-submit navigation and other applications never invoke WorkBuddy inspection',async()=>{
 for(const bundle of [bundleId,'fixture.other']){
  const h=fixture({bundle});try{await h.service.act({action:'key',key:'escape',modifiers:[],purpose:'navigation',expectedSubmissionText:'model-forged'},h.scope,h.shot,1);assert(!h.calls.some(c=>c.op==='workbuddyInspect'));assert.equal(h.calls.find(c=>c.op==='key').payload.expectedSubmissionText,undefined);}finally{await h.service.close();}
 }
});
