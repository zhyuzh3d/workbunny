'use strict';
const path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function routeName(value={}){return value.mode==='none'?null:value.workspace|| (value.directory?path.basename(value.directory):null);}
function routeMatches(state,value={}){const name=routeName(value);return state.homeReady===true&&state.buddyAppActive!==true&&state.menuOpen!==true&&state.pickerAvailable===true&&(!state.workspacePicker||state.workspacePicker.candidateCount===1)&&state.workspace===(name||'选择工作空间');}
function routeObservation(state={}){return {homeReady:state.homeReady===true,buddyAppActive:state.buddyAppActive===true,pickerAvailable:state.pickerAvailable===true,menuOpen:state.menuOpen===true,workspace:state.workspace||'',...(state.workspacePicker?{workspacePicker:state.workspacePicker}:{})};}
function routeUnverified(state,route){return Object.assign(Error('WorkBuddy 工作位置尚未核对；请依据选择器及编辑器诊断补充证据或调整界面后继续，未输入任务'),{code:'E_WORKBUDDY_ROUTE_UNVERIFIED',dispatched:false,observation:routeObservation(state),expectedWorkspace:routeName(route)||'选择工作空间',diagnostic:{operation:'inspect',...(Number.isSafeInteger(state?.workspacePicker?.candidateCount)?{candidateCount:state.workspacePicker.candidateCount}:{})}});}
function routeConflict(state,route){return state?.homeReady===true&&state?.pickerAvailable===true&&(!state.workspacePicker||state.workspacePicker.candidateCount===1)&&typeof state.workspace==='string'&&state.workspace!==(routeName(route)||'选择工作空间');}
function canChangeMethod(error){return error?.dispatched===false&&['E_BACKGROUND_UNSUPPORTED','E_GUI_LOCATE_MISSING','E_GUI_LOCATE_AMBIGUOUS','E_GUI_LOCATE_UNAVAILABLE','E_WORKBUDDY_ROUTE_UNVERIFIED'].includes(error.code);}
function inputPrerequisites(route={}){return [
 {id:'work-position',expected:routeName(route)||'none',description:'当前新任务编辑器实际工作位置与请求一致；none表示未关联空间或项目'},
 {id:'composer',expected:'new-task',description:'当前为本轮独立新任务的通用编辑器，不是旧会话或其它应用'},
 {id:'draft',expected:'empty',description:'实际编辑器为空，没有需要保留的正文或附件'},
 {id:'input-ready',expected:'ready',description:'当前模式、模型和任务所需前置条件已满足，可输入本轮整理说明'}
];}
async function prepareWorkBuddyRoute(native,scope,route={},assertLive=()=>{},resolve,{background=false}={}){
 if(route.buddyApp)return {prepared:false,reason:'按本轮任务选择指定 Buddy 应用：'+route.buddyApp};
 const payload={expected:{bundleId:scope.bundleId,pid:scope.pid},windowId:scope.windowId,...(background?{background:true}:{})};
 const call=async(operation,extra={})=>{assertLive();const result=await native.request('workbuddyNavigate',{...payload,operation,...extra},8000);assertLive();return result;};
 // Buddy applications own separate home drafts and placeholders. Return to
 // the general task composer before inspecting or changing its work position.
 // Switching applications preserves their drafts; "new task" can clear one.
 let state=await call('inspect');
 const exitedBuddyApp=state.buddyAppActive===true;
 if(exitedBuddyApp){
  await call('exitBuddyApp');await pause(500);state=await call('inspect');
  if(state.buddyAppActive||!state.homeReady)throw Error('尚未切回 WorkBuddy 通用任务页，未输入任务');
 }
 if(!state.homeReady){
  // New-task navigation may discard an existing conversation composer too.
  assertLive();const draft=await native.request('workbuddyInspect',payload,8000);assertLive();
  if(draft.draftEmpty!==true)throw Object.assign(Error('WorkBuddy 当前页草稿为空尚未核实，保留原页面；未新建任务'),{code:draft.draftEmpty===false?'E_WORKBUDDY_DRAFT_CONFLICT':'E_WORKBUDDY_ROUTE_UNVERIFIED',dispatched:false});
  await call('newTask');await pause(500);state=await call('inspect');
 }
 if(!state.homeReady)throw Error('尚未核对 WorkBuddy 通用新任务页，未输入任务');
 assertLive();const before=await native.request('workbuddyInspect',payload,8000);assertLive();
 if(before.draftEmpty!==true){
  const conflict=before.available===true&&before.editorCount===1&&before.draftEmpty===false;
  throw Object.assign(Error(conflict?'WorkBuddy 通用任务页有未发送草稿，已保留；请先保存或处理草稿后继续原任务':'尚不能核实 WorkBuddy 草稿状态，保留当前页面稍后重试'),{...(conflict?{code:'E_WORKBUDDY_DRAFT_CONFLICT'}:{}),dispatched:false});
 }
 if(!state.pickerAvailable)return {prepared:false,reason:'工作空间选择器尚未可用，需依据编辑器和候选数量重新定位',observation:routeObservation(state)};
 if(!routeName(route)&&routeMatches(state,{mode:'none'}))return {prepared:true,workspace:null,method:'workbuddy-ax',...(exitedBuddyApp?{exitedBuddyApp:true}:{}),verifiedAt:Date.now()};
 await call('workspaceMenu');await pause(400);state=await call('inspect');
 const candidates=state.workspaces;let wanted=routeName(route);
 if(!wanted&&route.mode!=='none'&&resolve)try{wanted=await resolve(candidates);}catch(error){if(error.name==='AbortError')throw error;wanted=null;}
 if(wanted&&candidates.filter(n=>n===wanted).length!==1){
  await call('workspaceMenu');
  throw Object.assign(Error('指定的 WorkBuddy 工作空间不存在或不唯一，已保留页面；请核对工作位置'),{code:'E_WORKBUDDY_ROUTE_CONFLICT',dispatched:false});
 }
 if(wanted||state.workspaces.includes('不使用工作空间')||state.workspace!=='选择工作空间'){
  await call('selectWorkspace',{name:wanted||'不使用工作空间'});await pause(500);
 }else{
  // The empty selector offers no "none" item. Close it by its own popup.
  await call('workspaceMenu');await pause(400);
 }
 state=await call('inspect');
 if(!routeMatches(state,wanted?{workspace:wanted}:{mode:'none'}))throw routeUnverified(state,wanted?{workspace:wanted}:{mode:'none'});
 return {prepared:true,workspace:wanted,method:'workbuddy-ax',...(exitedBuddyApp?{exitedBuddyApp:true}:{}),verifiedAt:Date.now()};
}
async function chooseWorkspace(candidates,task){
 const route=task.workContext||{};
 if(route.mode==='none')return null;
 const wanted=routeName(route);
 // Selection belongs to Bunny's task planning, with explicit context/reason.
 // Mentioning a project in historical text does not associate new work with it.
 return wanted&&candidates.filter(name=>name===wanted).length===1?wanted:null;
}

module.exports={prepareWorkBuddyRoute,routeMatches,routeName,chooseWorkspace,routeObservation,routeUnverified,routeConflict,canChangeMethod,inputPrerequisites};
