'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareWorkBuddyRoute}=require('../src/main/workbuddy-route');
const scope={bundleId:'com.tencent.workbuddy.mac',pid:123,windowId:1};
function fixture({buddyAppActive=false,generalDraft='',exitWorks=true}={}){
 const calls=[],drafts={buddy:'original application draft with attachment',general:generalDraft};
 const native={request:async(op,args)=>{
  calls.push(op==='workbuddyNavigate'?args.operation:op);
  if(op==='workbuddyInspect')return {available:true,editorCount:1,draftEmpty:buddyAppActive?false:!drafts.general};
  if(args.operation==='exitBuddyApp'&&exitWorks)buddyAppActive=false;
  if(args.operation==='newTask')drafts.general='';
  return {buddyAppActive,homeReady:!buddyAppActive,pickerAvailable:true,workspace:'选择工作空间',workspaces:[]};
 }};
 return {native,calls,drafts};
}
test('leaves a Buddy application before inspecting the general composer, preserving its separate draft',async()=>{
 const h=fixture({buddyAppActive:true}),original=h.drafts.buddy;
 const route=await prepareWorkBuddyRoute(h.native,scope,{mode:'none'});
 assert.equal(route.prepared,true);assert.equal(route.exitedBuddyApp,true);
 assert.deepEqual(h.calls.slice(0,4),['inspect','exitBuddyApp','inspect','workbuddyInspect']);
 assert.equal(h.drafts.buddy,original);
});
test('a general composer draft blocks before new-task navigation can erase it',async()=>{
 const h=fixture({generalDraft:'unsent owner text'});
 await assert.rejects(prepareWorkBuddyRoute(h.native,scope),e=>e.code==='E_WORKBUDDY_DRAFT_CONFLICT'&&e.dispatched===false);
 assert.equal(h.drafts.general,'unsent owner text');assert.deepEqual(h.calls,['inspect','workbuddyInspect']);
});
test('rechecks the general draft after switching applications',async()=>{
 const h=fixture({buddyAppActive:true,generalDraft:'another saved draft'});
 await assert.rejects(prepareWorkBuddyRoute(h.native,scope),{code:'E_WORKBUDDY_DRAFT_CONFLICT'});
 assert.equal(h.drafts.general,'another saved draft');assert(!h.calls.includes('newTask'));
});
test('an unconfirmed application switch never changes a draft or work position',async()=>{
 const h=fixture({buddyAppActive:true,exitWorks:false});
 await assert.rejects(prepareWorkBuddyRoute(h.native,scope),/尚未切回/);
 assert(!h.calls.includes('newTask'));assert(!h.calls.includes('workspaceMenu'));assert(!h.calls.includes('workbuddyInspect'));
});
test('cancellation during inspection prevents further navigation',async()=>{
 const h=fixture();let checks=0;
 await assert.rejects(prepareWorkBuddyRoute(h.native,scope,{},()=>{if(++checks===2)throw Error('cancelled');}),/cancelled/);
 assert.deepEqual(h.calls,['inspect']);
});
test('a missing explicit workspace never silently falls back to an unrelated position',async()=>{
 const h=fixture();
 await assert.rejects(prepareWorkBuddyRoute(h.native,scope,{workspace:'explicit-project'}),e=>e.code==='E_WORKBUDDY_ROUTE_CONFLICT'&&e.dispatched===false);
 assert(!h.calls.includes('selectWorkspace'));
});
test('route acceptance requires the general page, a closed menu, and a unique picker',()=>{
 const {routeMatches}=require('../src/main/workbuddy-route');
 const state={homeReady:true,pickerAvailable:true,workspace:'选择工作空间',workspacePicker:{candidateCount:1}};
 assert(routeMatches(state,{mode:'none'}));
 for(const patch of [{homeReady:false},{buddyAppActive:true},{menuOpen:true},{pickerAvailable:false},{workspacePicker:{candidateCount:2}},{workspace:'other-project'}])assert(!routeMatches({...state,...patch},{mode:'none'}));
 assert(routeMatches({...state,workspace:'selected-project'},{workspace:'selected-project'}));
});
test('an unavailable picker returns actionable structural evidence without opening a menu',async()=>{
 const calls=[],state={homeReady:true,pickerAvailable:false,workspace:'',workspacePicker:{editorCount:1,popupCount:2,candidateCount:0}};
 const native={request:async(op,a)=>{calls.push(a.operation||op);return op==='workbuddyInspect'?{available:true,editorCount:1,draftEmpty:true}:state;}};
 const result=await prepareWorkBuddyRoute(native,scope,{mode:'none'});assert.equal(result.prepared,false);assert.deepEqual(result.observation.workspacePicker,state.workspacePicker);assert.deepEqual(calls,['inspect','workbuddyInspect']);
});
test('navigation never creates a new task over an existing or unreadable conversation draft',async()=>{
 for(const draftEmpty of [false,undefined]){
  const calls=[],native={request:async(op,a)=>{calls.push(a.operation||op);return op==='workbuddyInspect'?{draftEmpty}:{homeReady:false};}};
  await assert.rejects(prepareWorkBuddyRoute(native,scope,{mode:'none'}),e=>e.dispatched===false&&['E_WORKBUDDY_DRAFT_CONFLICT','E_WORKBUDDY_ROUTE_UNVERIFIED'].includes(e.code));
  assert.deepEqual(calls,['inspect','workbuddyInspect']);
 }
});
test('an exact workspace is selected once and reverified for foreground and background paths',async()=>{
 for(const background of [false,true]){
  let workspace='old-project',menuOpen=false;const calls=[];
  const native={request:async(op,a)=>{
   assert.equal(!!a.background,background);calls.push(a.operation||op);
   if(op==='workbuddyInspect')return {available:true,editorCount:1,draftEmpty:true};
   if(a.operation==='workspaceMenu')menuOpen=!menuOpen;
   if(a.operation==='selectWorkspace'){assert.equal(a.name,'new-project');workspace=a.name;menuOpen=false;}
   return {homeReady:true,pickerAvailable:true,workspace,menuOpen,workspaces:menuOpen?['old-project','new-project']:[]};
  }};
  const result=await prepareWorkBuddyRoute(native,scope,{workspace:'new-project'},()=>{},undefined,{background});
  assert.equal(result.prepared,true);assert.equal(result.workspace,'new-project');assert.equal(calls.filter(c=>c==='selectWorkspace').length,1);
 }
});
test('duplicate workspace names do not select an arbitrary match',async()=>{
 let menuOpen=false;const calls=[],native={request:async(op,a)=>{calls.push(a.operation||op);if(op==='workbuddyInspect')return {draftEmpty:true};if(a.operation==='workspaceMenu')menuOpen=!menuOpen;return {homeReady:true,pickerAvailable:true,workspace:'选择工作空间',menuOpen,workspaces:['project','project']};}};
 await assert.rejects(prepareWorkBuddyRoute(native,scope,{workspace:'project'}),{code:'E_WORKBUDDY_ROUTE_CONFLICT',dispatched:false});assert(!calls.includes('selectWorkspace'));assert.equal(menuOpen,false);
});
