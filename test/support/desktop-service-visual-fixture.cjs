'use strict';
const crypto=require('node:crypto');
const {raster,bitmap,crop,encode}=require('./visual-fixture.cjs');
const rows=native=>native.visibleRows().map(row=>({width:.12,height:.02,...row}));

function pixels(native){
 const image=raster(),visible=rows(native);
 const digest=crypto.createHash('sha256').update(native.capturePNG).update(JSON.stringify(visible)).digest();
 for(let i=0;i<image.data.length;i+=4)image.data.set([digest[0],digest[1],digest[2],255],i);
 return {image,rows:visible,png:encode(image)};
}
function location(native){
 return {software:native.visualSoftware||({
  'com.tencent.xinWeChat':'微信','com.tencent.workbuddy.mac':'WorkBuddy','com.apple.Notes':'Notes',
  'com.apple.Terminal':'Terminal','com.github.Electron':'Electron','com.openai.codex':'Codex'
 }[native.app.bundleId]||'Fixture'),available:native.visualAvailable!==false,unique:true,active:true,sameIdentity:true,confidence:.99,
  region:{x:0,y:0,width:1,height:1},mainRegion:{x:0,y:0,width:1,height:1},
  identityRegion:{x:.02,y:.02,width:.2,height:.12},monitorRegions:[{x:0,y:0,width:1,height:.7}],
  focusRegion:{x:.25,y:.7,width:.7,height:.28},focusEvidence:'Synthetic editor caret is visible in the designated composer',
  evidence:'Synthetic application heading and stable account/document identity are uniquely visible',texts:rows(native),
  ...(native.visualLocation||{})};
}
function verification(native){return async options=>{
 native.verifications??=[];native.verifications.push(options);
 const system=options.messages?.[0]?.content||'';
 if(system.includes('定位指定软件')){if(native.locateGate)await native.locateGate.promise;return {response:{text:JSON.stringify(location(native))}};}
 let input;try{input=JSON.parse(options.messages?.[1]?.content?.[0]?.text||'{}');}catch{}
 const state=native.workBuddyInspection||{},expected=input?.evidence?.expectedText;
 let matched=expected!==undefined?native.typedWorkBuddyText===expected||state.draftMatchesRequest===true:!native.typedWorkBuddyText&&state.draftEmpty!==false;
 if(native.visualJudgment!==undefined)matched=typeof native.visualJudgment==='function'?native.visualJudgment(input):native.visualJudgment;
 return {response:{text:JSON.stringify({matched,evidence:matched?'Synthetic visible editor and requested conditions match':'Synthetic editor contains a conflicting or unverified draft'})}};
};}
function inputEvidence(native,action,task){
 if(action?.action!=='type'||action.purpose==='navigation'||!task.inputPrerequisites||action.inputEvidence)return action;
 const observed={'work-position':native.workspace||'none',composer:'new-task',draft:native.typedWorkBuddyText||native.workBuddyInspection?.draftEmpty===false?'occupied':'empty','input-ready':'ready'};
 return {...action,inputEvidence:{observationId:task.inputPrerequisites.observationId,checks:task.inputPrerequisites.checks.map(c=>({id:c.id,observed:observed[c.id],basis:'Synthetic screenshot shows '+c.id+': '+observed[c.id]}))}};
}
function draftVerifier(native,expected){return async options=>{
 native.draftReviews??=[];native.draftReviews.push(options);
 const matched=native.visibleRows().some(row=>row.y>=.65&&row.text===expected);
 return {text:JSON.stringify({matched,composer:{x:.3,y:.7,width:.65,height:.25},nextAction:null})};
};}
module.exports={bitmap,crop,pixels,location,verification,inputEvidence,draftVerifier};
