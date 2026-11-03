'use strict';
const path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function routeName(value={}){return value.mode==='none'?null:value.workspace|| (value.directory?path.basename(value.directory):null);}
function routeMatches(state,value={}){const name=routeName(value);return state.pickerAvailable===true&&state.workspace===(name||'选择工作空间');}
async function prepareWorkBuddyRoute(native,scope,route={},assertLive=()=>{},resolve){
 const payload={expected:{bundleId:scope.bundleId,pid:scope.pid},windowId:scope.windowId};
 const call=async(operation,extra={})=>{assertLive();const result=await native.request('workbuddyNavigate',{...payload,operation,...extra},8000);assertLive();return result;};
 const before=await native.request('workbuddyInspect',payload,8000);
 if(before.draftEmpty===false)throw Error('WorkBuddy 当前有未发送草稿，保留草稿后再交办');
 await call('newTask');await pause(500);
 let state=await call('inspect');
 if(!state.pickerAvailable)return {prepared:false,reason:'工作空间选择器尚未可用'};
 await call('workspaceMenu');await pause(400);state=await call('inspect');
 const candidates=state.workspaces;let wanted=routeName(route);
 if(!wanted&&route.mode!=='none'&&resolve)try{wanted=await resolve(candidates);}catch(error){if(error.name==='AbortError')throw error;wanted=null;}
 if(wanted&&candidates.filter(n=>n===wanted).length!==1)wanted=null;
 if(wanted||state.workspaces.includes('不使用工作空间')||state.workspace!=='选择工作空间'){
  await call('selectWorkspace',{name:wanted||'不使用工作空间'});await pause(500);
 }else{
  // The empty selector offers no "none" item. Close it by its own popup.
  await call('workspaceMenu');await pause(400);
 }
 state=await call('inspect');
 if(!routeMatches(state,wanted?{workspace:wanted}:{mode:'none'}))throw Error('WorkBuddy 工作位置尚未核对，未输入任务');
 return {prepared:true,workspace:wanted,method:'workbuddy-ax',verifiedAt:Date.now()};
}
async function chooseWorkspace(candidates,task){
 const scope=task.workRequest||task;
 const text=[scope.goal,scope.context,task.state?.ownerContext,task.state?.ownerRequest].filter(Boolean).join('\n');
 const exact=candidates.filter(name=>name.length>=3&&text.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
 // A missing match is actionable: use an unscoped task. Execution channels
 // such as "WorkBuddy" do not establish an association with a code project.
 return exact.length===1?exact[0]:null;
}

module.exports={prepareWorkBuddyRoute,routeMatches,routeName,chooseWorkspace};
