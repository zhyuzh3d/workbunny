'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const {boundaryVisual}=require('./support/workbuddy-boundary-visual-fixture.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('an unverified work position keeps structural evidence and error code across start and resume without typing',async()=>{
 const calls=[],rect={x:0,y:0,width:961,height:1280},bundleId='com.tencent.workbuddy.mac';
 const structuredNative={cancel(){},close(){},request:async(op,a={})=>{
  if(op==='permissions')return {accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true};
  if(op==='workbuddyCapabilities')return {backgroundAX:false};
  if(op==='activate')return {activated:true};
  if(op==='frontmost')return {application:{pid:123,bundleId,name:'WorkBuddy'},windows:[{windowId:7,pid:123,bundleId,layer:0,rect}]};
  if(op==='workbuddyNavigate')return {homeReady:true,pickerAvailable:false,workspace:'',workspacePicker:{editorCount:1,popupCount:2,candidateCount:0}};
  if(op==='workbuddyInspect')return {available:true,editorCount:1,draftEmpty:true};
  throw Error('unexpected operation: '+op);
 }};
 const visual=boundaryVisual({calls,rect,initial:{routeReady:false},nativeRequest:structuredNative.request});
 const service=new DesktopService({...visual,planner:async()=>({action:'type',purpose:'task',text:'fixture'}),persist:async()=>{},imageResize:x=>x,imageCrop:x=>x});
 try{
  assert((await service.start({target:'workbuddy',goal:'pure website fixture',workModel:'deepseek-v4.1-flash',workContext:{mode:'none'}})).ok);
  for(const resumed of [false,true]){
   if(resumed)assert((await service.resume()).ok);
   const deadline=Date.now()+5000;while(service.running&&Date.now()<deadline)await sleep(10);
   assert.equal(service.running,false);assert.equal(service.task.status,'paused');assert.equal(service.task.errorCode,'E_WORKBUDDY_ROUTE_UNVERIFIED');
   assert.deepEqual(service.task.workRoute.observation.workspacePicker,{editorCount:1,popupCount:2,candidateCount:0});
   assert(!service.task.draftInserted);assert(!service.task.submitAttemptedAt);
  }
  assert(!calls.some(c=>['displayInput','type','workbuddyFill','workbuddySend','key','click'].includes(c.op)));
 }finally{await service.close();}
});

test('a previously prepared route is rechecked before handoff when the work position changes',async()=>{
 for(const background of [false,true]){
  const calls=[],native={cancel(){},close(){},request:async(op,a)=>{calls.push({op,a});return {homeReady:true,pickerAvailable:true,workspace:'different-project',workspacePicker:{candidateCount:1}};}};
  const service=new DesktopService({native,persist:async()=>{}});service.generation=1;service.running=true;service.controller=new AbortController();service.task={id:'fixture',scene:'life',domain:'life',visibilityFloor:1,workContext:{mode:'none'},workRoute:{prepared:true,workspace:null},steps:[]};
  try{await assert.rejects(service.verifyWorkBuddyRoute({bundleId:'com.tencent.workbuddy.mac',pid:123,windowId:7},1,{background}),{code:'E_WORKBUDDY_ROUTE_UNVERIFIED',dispatched:false});assert.equal(service.task.workRoute.prepared,false);assert.equal(service.task.workRoute.observation.workspace,'different-project');assert.equal(!!calls[0].a.background,background);}
  finally{service.running=false;await service.close();}
 }
});
