'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function fixture({sendError}={}){
 let draft='',sent=0;const calls=[],inputs=[],native={cancel:async()=>{},close:async()=>{},request:async(op,a={})=>{
  calls.push(op);
  if(op==='permissions')return {accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true};
  if(op==='workbuddyCapabilities')return {backgroundAX:true};
  if(op==='frontmost')return {application:{bundleId:'com.example.user-app',pid:456},windows:[{bundleId:'com.tencent.workbuddy.mac',pid:123,windowId:7,layer:0,rect:{x:0,y:0,width:1000,height:800}}]};
  if(op==='workbuddyNavigate')return {homeReady:true,pickerAvailable:true,workspace:'选择工作空间',buddyAppActive:false};
  if(op==='workbuddyInspect')return {available:true,editorCount:1,homeReady:true,selectedModel:'DeepSeek-V4.1-Flash',draftEmpty:!draft,draftMatchesRequest:draft===a.text};
  if(op==='workbuddyFill'){inputs.push(a.text);draft=a.text;return {filled:true};}
  if(op==='workbuddySend'){if(sendError)throw sendError;assert.equal(a.text,draft);sent++;draft='';return {pressed:true};}
  throw Error('foreground operation attempted: '+op);
 }};
 const service=new DesktopService({native,pointerBlocked:()=>{throw Error('background AX must not consult the pointer gate');},planner:async()=>{throw Error('visual planner must not run');},persist:async()=>{},observeWorkBuddy:async()=>sent?{sessionId:'visible-session',taskId:1,messageKey:'message-1',status:'ok',summary:'actual fixture result'}:null});
 return {service,calls,inputs,sent:()=>sent};
}
test('a new visible WorkBuddy task binds without activation, capture, mouse or global keyboard',async()=>{
 const h=fixture();try{assert((await h.service.start({target:'workbuddy',goal:'isolated fixture task',userRequest:'private-raw-initial-canary',historicalContext:'private-dialogue-history-canary',authorizationContext:'private-authorization-canary',workModel:'deepseek-v4.1-flash',workContext:{mode:'none'}})).ok);const deadline=Date.now()+3000;while(h.service.running&&Date.now()<deadline)await pause(10);
 assert.equal(h.service.task.status,'review');assert.equal(h.service.task.monitorSessionId,'visible-session');assert.equal(h.service.task.handoffSent,true);assert.equal(h.sent(),1);assert.equal(h.inputs.length,1);assert(h.inputs[0].includes('isolated fixture task'));for(const secret of ['private-raw-initial-canary','private-dialogue-history-canary','private-authorization-canary'])assert(!h.inputs[0].includes(secret));assert.equal(h.service.task.userRequest,'private-raw-initial-canary');assert.equal(h.service.task.historicalContext,'private-dialogue-history-canary');
 assert(!h.calls.some(op=>['activate','capture','click','type','key'].includes(op)));assert.equal(h.service.task.workRoute.workspace,null);
 }finally{await h.service.close();}
});
test('an uncertain background submit is preserved and never replayed',async()=>{
 const h=fixture({sendError:Object.assign(Error('lost submit receipt'),{code:'E_GUI_SEND_UNKNOWN',dispatched:true})});try{await h.service.start({target:'workbuddy',goal:'fixture task',workModel:'deepseek-v4.1-flash',workContext:{mode:'none'}});while(h.service.running)await pause(10);
 assert(h.service.task.submitAttemptedAt);await h.service.resume();await pause(20);assert.equal(h.calls.filter(op=>op==='workbuddySend').length,1);
 }finally{await h.service.close();}
});
