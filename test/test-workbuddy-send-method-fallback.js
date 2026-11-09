'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const {workSubmissionState}=require('../src/main/workbuddy-observation');
const {boundaryVisual}=require('./support/workbuddy-boundary-visual-fixture.cjs');
function fixture({unavailableControls=false,unknownSend=false,mixedDraft=false}={}){
 const calls=[],logs=[],rect={x:0,y:0,width:1000,height:800},marker='[workbunny:bcf0b2af-d420-4fb4-8fa3-98effc9246c9]',text='Complete existing draft\n'+marker;let sent=0,plans=0;
 const structuredNative={cancel:async()=>{},close:async()=>{},request:async(op,payload={})=>{
  if(op==='frontmost')return {application:{bundleId:'com.tencent.workbuddy.mac',pid:123},windows:[{pid:123,windowId:7,layer:0,rect}]};
  if(op==='activate')return {activated:true};
  if(op==='workbuddyInspect')return {available:!unavailableControls,scanComplete:true,childrenFetchErrors:0,homeReady:true,editorCount:1,draftEmpty:false,draftMatchesRequest:!mixedDraft,selectedModel:'DeepSeek-V4.1-Flash',sendEnabled:false,sendButtonRect:{x:850,y:700,width:40,height:30}};
  if(op==='workbuddySend')throw Object.assign(Error('fixture native send preflight'),{code:unknownSend?'E_GUI_SEND_UNKNOWN':'E_GUI_BEFORE_DISPATCH',dispatched:unknownSend,diagnostic:{operation:'submit',method:'foreground-ax',candidateCount:1,guardChecks:{scanComplete:true,childrenReadable:true,editorUnique:true,targetReady:true,modelMatched:true,draftMatched:true,sendButtonUnique:true,sendEnabled:false}}});
  throw Error('forbidden fixture operation '+op);
 }};
 const visual=boundaryVisual({calls,rect,initial:{marker,draftText:mixedDraft?'unrelated protected draft':text},nativeRequest:structuredNative.request,onInput:async action=>{assert.equal(action.action,'key');assert.equal(action.key,'enter');const proof=visual.judgments.at(-1).input.evidence;assert.equal(proof.expectedText,text);assert.equal(proof.mode,'home');assert.equal(proof.marker,marker);sent++;}});
 const service=new DesktopService({...visual,persist:async()=>{},imageResize:x=>x,log:x=>logs.push(x),planner:async()=>{plans++;return {action:'key',key:'enter',modifiers:[],purpose:'submit',reason:'fixture independently reviewed current screenshot and existing draft'};},observeWorkBuddy:async()=>sent?{sessionId:'fixture-session',taskId:1,messageKey:'fixture-message',status:'ok',updatedAt:Date.now()}:null});
 service.verifyWorkBuddyRoute=async()=>{};service.running=true;service.generation=1;service.controller=new AbortController();
 service.task={id:'fixture-existing-draft',scene:'life',domain:'life',visibilityFloor:1,target:'workbuddy',goal:'fixture same existing work',workModel:'deepseek-v4.1-flash',associationMarker:marker,outboundText:text,startedAt:Date.now(),draftInserted:true,draftInsertedAt:1,backgroundUnsupportedAt:Date.now(),steps:[{action:'workbuddyFill',state:'input-sent',at:1}]};
 return {service,calls,logs,sent:()=>sent,plans:()=>plans,run:()=>service.runOwned(1,Object.freeze({...service.task,draftInserted:true,resumeRequireMatchingDraft:true}))};
}
for(const unavailableControls of [false,true])test((unavailableControls?'missing native controls':'known pre-dispatch native rejection')+' retains the same confirmed draft and permits one independently planned submit',async()=>{
 const h=fixture({unavailableControls});try{const original=h.service.task.outboundText;await h.run();assert.equal(h.sent(),1);assert.equal(h.plans(),1);assert(!h.calls.some(c=>['type','workbuddyFill','workbuddyNavigate'].includes(c.op)));assert.equal(h.service.task.outboundText,original);assert.equal(h.service.task.status,'review');assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);assert.equal(workSubmissionState(h.service.task).phase,'confirmed');if(!unavailableControls)assert(h.service.task.steps.some(s=>s.action==='workbuddySend'&&s.state==='not-dispatched'));}finally{await h.service.close();}
});
test('uncertain native dispatch never switches to another submit method',async()=>{
 const h=fixture({unknownSend:true});try{await assert.rejects(h.run(),{code:'E_GUI_SEND_UNKNOWN'});assert.equal(h.sent(),0);assert(!h.calls.some(c=>c.op==='displayInput'));assert.equal(h.plans(),0);assert.equal(workSubmissionState(h.service.task).phase,'submission-unknown');assert.equal(h.service.task.steps.at(-1).state,'intent');}finally{await h.service.close();}
});
test('a different existing draft cannot be overwritten or submitted through a fallback',async()=>{
 const h=fixture({mixedDraft:true});try{await assert.rejects(h.run());assert.equal(h.sent(),0);assert(!h.calls.some(c=>c.op==='displayInput'));assert.equal(h.plans(),0);assert(!h.calls.some(c=>['type','workbuddyFill','workbuddySend','key'].includes(c.op)));}finally{await h.service.close();}
});
