'use strict';
// Synthetic pixels with a snapshot-bound VLM. These boundary suites never
// inspect a real app, use OCR, or dispatch real desktop input.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {raster,bitmap,crop,encode}=require('./visual-fixture.cjs');
function boundaryVisual({initial={},calls=[],rect={x:10,y:20,width:1000,height:800},onInput=async()=>{},onJudge=async()=>{},beforeCapture=()=>{},nativeRequest}={}){
 const state={software:'WorkBuddy',identity:'synthetic-work-account',available:true,mode:'home',marker:'',model:'deepseek-v4.1-flash',draftText:'',focused:true,complete:true,editors:1,...initial};
 const judgments=[],snapshots=new Map();
 const composer={x:.25,y:.65,width:.7,height:.32};
 function paint(image,r,value){const color=[...crypto.createHash('sha256').update(JSON.stringify(value)).digest().subarray(0,3),255];for(let y=Math.floor(r.y*image.height);y<Math.ceil((r.y+r.height)*image.height);y++)for(let x=Math.floor(r.x*image.width);x<Math.ceil((r.x+r.width)*image.width);x++)image.data.set(color,(y*image.width+x)*4);}
 function capture(){beforeCapture();const visible=structuredClone(state),image=raster();paint(image,{x:.02,y:.02,width:.2,height:.1},visible.identity);paint(image,{x:.02,y:.2,width:.9,height:.4},[visible.mode,visible.marker,visible.model,visible.available,visible.complete,visible.editors]);paint(image,composer,[visible.draftText,visible.focused]);const pngBase64=encode(image).toString('base64');snapshots.set(pngBase64,visible);return {pngBase64,width:image.width,height:image.height,desktopRect:rect,backend:'CGDisplayStream',capturedAt:Date.now()};}
 function scene(options){const parts=options.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]),url=parts.find(p=>p.type==='image_url')?.image_url.url;assert.match(url||'',/^data:image\/png;base64,/u);const visible=snapshots.get(url.slice(url.indexOf(',')+1));assert(visible,'VLM sees only the exact captured display pixels');return visible;}
 const native={cancel:async()=>{},close:async()=>{},request:async(op,payload={})=>{calls.push({op,payload});if(op==='displayCapture')return capture();if(op==='displayInput'){assert(payload.visualEvidence?.frameId);assert.deepEqual(payload.visualEvidence.displayRect,rect);await onInput(payload,state);if(payload.action==='type')state.draftText=payload.text;if(payload.action==='click')state.focused=true;return {performed:true};}if(nativeRequest)return nativeRequest(op,payload);assert.fail('forbidden legacy operation '+op);}};
 const verificationRequest=async options=>{const visible=scene(options);if(options.messages[0].content.includes('定位指定软件'))return {response:{text:JSON.stringify({software:visible.software,available:visible.available,unique:true,active:true,sameIdentity:true,confidence:.99,region:{x:0,y:0,width:1,height:1},mainRegion:{x:0,y:0,width:1,height:1},identityRegion:{x:.02,y:.02,width:.2,height:.1},monitorRegions:[{x:0,y:.2,width:1,height:.8}],focusRegion:visible.focused?composer:null,focusEvidence:visible.focused?'Synthetic editor caret is visible':'',evidence:'Synthetic application and stable work-account identity are visible',texts:[{text:visible.marker||'WorkBuddy',confidence:.99,x:.4,y:.2,width:.4,height:.03},{text:visible.model==='hy3'?'Hy3':'DeepSeek-V4.1-Flash',confidence:.99,x:.4,y:.49,width:.2,height:.02},...(visible.model==='hy3'?[{text:'0.00x',confidence:.99,x:.62,y:.49,width:.08,height:.02}]:[]),{text:visible.draftText||'输入消息',confidence:.99,x:.3,y:.75,width:.65,height:.18}]})}};
  const input=JSON.parse(options.messages[1].content.find(p=>p.type==='text').text),e=input.evidence||{};
  let matched=visible.available&&visible.complete&&visible.editors===1&&(e.expectedText===undefined||e.expectedText===visible.draftText)&&(e.mode===undefined||e.mode===visible.mode)&&(e.marker===undefined||e.marker===visible.marker)&&(e.workModel===undefined||e.workModel===visible.model);
  if(e.checks)matched&&=!visible.draftText&&visible.routeReady!==false;
  judgments.push({input,visible,matched});await onJudge({input,visible,state});return {response:{text:JSON.stringify({matched,evidence:matched?'Captured original draft and complete target conditions match':'Captured draft, target identity or complete input conditions conflict'})}};
 };
 return {state,native,calls,judgments,bitmap,imageCrop:crop,verificationRequest};
}
module.exports={boundaryVisual};
