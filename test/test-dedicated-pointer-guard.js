'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {DesktopService,makeWorkBuddyOutbound}=require('../src/main/desktop-service');
const {workSubmissionState,workSubmissionConfirmed}=require('../src/main/workbuddy-observation');
const {AgentService}=require('../src/main/agent-service');
function fixture({followUp=false,idempotent=false,blocked=false,lateBlock=false,drift=false,unknown=false,oldAttempt}={}){
 const calls=[],logs=[],saved=[],scope={bundleId:'com.tencent.workbuddy.mac',pid:123,windowId:7},rect={x:0,y:0,width:1000,height:800},sendButtonRect={x:850,y:700,width:40,height:30};
 let blockedNow=blocked,draft=followUp?'':'fixture exact draft',posts=0;
 const native={cancel:async()=>{},close:async()=>{},request:async(op,payload={})=>{
  calls.push({op,payload});
  if(op==='frontmost')return {application:scope,windows:[{...scope,layer:0,rect}]};
  if(op==='workbuddyInspect')return {available:true,scanComplete:true,childrenFetchErrors:0,homeReady:!followUp,conversationReady:followUp,associationMarkerPresent:followUp,editorCount:1,selectedModel:'DeepSeek-V4.1-Flash',draftEmpty:!draft,draftMatchesRequest:draft===payload.text,sendEnabled:true,sendButtonRect};
  if(op==='workbuddyFill'){draft=payload.text;return {filled:true};}
  if(op==='workbuddySend'){
   assert.deepEqual(payload.approvedPointer,{point:{x:870,y:715},rect:sendButtonRect});
   if(drift)throw Object.assign(Error('fixture button drift'),{code:'E_GUI_POINTER_CHANGED',dispatched:false});
   posts++;if(unknown)throw Object.assign(Error('fixture missing reply'),{code:'E_GUI_SEND_UNKNOWN',dispatched:true});
   return {pressed:true,method:'foreground-pointer',point:{x:870,y:715},postContextValid:true};
  }
  throw Error('forbidden fixture operation '+op);
 }};
 const service=new DesktopService({native,pointerBlocked:()=>blockedNow,log:r=>logs.push(r),persist:async task=>{saved.push(structuredClone(task));if(lateBlock&&task.steps.at(-1)?.action==='workbuddySend'&&task.steps.at(-1)?.state==='intent')blockedNow=true;},observeWorkBuddy:async()=>({sessionId:'original-session',taskId:1,messageKey:'original-message',status:'ok'})});
 service.capture=async()=>({rect,at:Date.now()});service.assertScreenshotCurrent=async()=>({});service.verifyWorkBuddyRoute=async()=>{};service.ensureSensitiveWorkAttachment=async()=>{};
 service.running=true;service.generation=1;service.controller=new AbortController();
 service.task={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',target:'workbuddy',scene:'life',domain:'life',visibilityFloor:1,goal:'fixture goal',outboundText:draft,workModel:'deepseek-v4.1-flash',associationMarker:'[workbunny:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]',steps:[],status:'review',draftInserted:true,draftInsertedAt:10,
  ...(followUp?{handoffSent:true,sessionId:'original-session',monitorSessionId:'original-session',monitorTaskId:1,monitorMessageKey:'original-message',submittedAt:20,followUpRound:0}:{}),...(oldAttempt?{submitAttemptedAt:oldAttempt,steps:[{action:'workbuddySend',state:'input-sent',at:oldAttempt}]}:{})};
 if(followUp&&idempotent)draft=makeWorkBuddyOutbound(service.task,'fixture follow-up',{followUp:true});
 const run=()=>followUp?service.followUp({text:'fixture follow-up',ownerInitiated:true}):service.tryWorkBuddyHandoff({outboundText:draft},scope,{},1,{requireMatchingDraft:true});
 return {service,calls,logs,saved,run,posts:()=>posts,draft:()=>draft};
}
for(const followUp of [false,true]){
 test((followUp?'follow-up':'initial')+' dedicated pointer is blocked before submit intent',async()=>{
  const h=fixture({followUp,blocked:true});try{if(followUp)assert.equal((await h.run()).ok,false);else await assert.rejects(h.run(),{code:'E_GUI_POINTER_BLOCKED',dispatched:false});assert(!h.calls.some(c=>c.op==='workbuddySend'));assert(!h.service.task.steps.some(s=>s.action==='workbuddySend'));if(followUp){assert.equal(h.service.task.outboundText,h.draft());assert.equal(workSubmissionConfirmed(h.service.task),false);assert.equal(h.service.task.monitorMessageKey,'original-message');assert.equal(h.service.task.submittedAt,20);assert.equal(h.service.task.followUpPending.state,'draft-unknown');}}finally{await h.service.close();}
 });
 for(const mode of ['lateBlock','drift'])test((followUp?'follow-up':'initial')+' '+mode+' records only this send as not dispatched',async()=>{
  const h=fixture({followUp,[mode]:true,...(!followUp?{oldAttempt:5}:{})});try{
   if(followUp)assert.equal((await h.run()).ok,false);else await assert.rejects(h.run(),e=>e.dispatched===false);
   assert.equal(h.posts(),0);assert.equal(h.service.task.steps.at(-1).state,'not-dispatched');
   if(followUp){assert.equal(h.service.task.submittedAt,20);assert.equal(h.service.task.followUpRound,0);assert.equal(h.service.task.monitorMessageKey,'original-message');assert.equal(h.service.task.followUpPending.state,'draft-unknown');assert.equal(h.service.task.outboundText,h.draft());}
   else {assert.equal(h.service.task.submitAttemptedAt,5);assert.equal(h.service.task.steps[0].state,'input-sent');assert.equal(workSubmissionState(h.service.task).phase,'submission-unknown');}
  }finally{await h.service.close();}
 });
 test((followUp?'follow-up':'initial')+' successful native post records numeric receipt without confirming application reception',async()=>{
  const h=fixture({followUp});try{const result=await h.run();assert(followUp?result.ok:result);assert.equal(h.posts(),1);assert.equal(h.service.task.steps.at(-1).state,'input-sent');assert.equal(workSubmissionState(h.service.task).phase,'submission-unknown');assert.deepEqual(h.service.task.steps.at(-1).point,{x:870,y:715});assert.equal(h.service.task.steps.at(-1).postContextValid,true);assert(h.logs.some(r=>r.stage==='pointer-dispatch'&&r.method==='foreground-pointer'));if(followUp){assert.equal((await h.run()).ok,false);assert.equal(h.posts(),1);}}
  finally{await h.service.close();}
 });
}
test('an already matching new draft gets a draft-only barrier before pointer rejection and retains original receipt anchors',async()=>{
 const h=fixture({followUp:true,idempotent:true,blocked:true});try{assert.equal(workSubmissionConfirmed(h.service.task),true);const result=await h.run();assert.equal(result.ok,false);assert(!h.calls.some(c=>['workbuddyFill','workbuddySend'].includes(c.op)));assert.equal(workSubmissionConfirmed(h.service.task),false);assert.equal(h.service.task.followUpPending.state,'draft-unknown');assert.equal(h.service.task.outboundText,h.draft());assert.equal(h.service.task.monitorMessageKey,'original-message');assert.equal(h.service.task.submittedAt,20);
 const receipt=await AgentService.prototype.waitForWorkSubmission.call({desktop:{running:false,task:h.service.task}},h.service.task,new AbortController().signal);assert.equal(receipt.ok,false);assert.equal(receipt.dispatched,undefined);
 }finally{await h.service.close();}
});
test('an uncertain dedicated follow-up post cannot issue another send',async()=>{
 const h=fixture({followUp:true,unknown:true});try{assert.equal((await h.run()).ok,false);assert.equal(h.posts(),1);assert.equal(h.service.task.steps.at(-1).state,'intent');assert.equal((await h.run()).ok,false);assert.equal(h.posts(),1);}finally{await h.service.close();}
});
test('a pre-existing unknown follow-up is retained before all pointer preparation',async()=>{
 const h=fixture({followUp:true,blocked:true});h.service.task.followUpPending={state:'unknown',round:1,submittedAt:25};h.service.task.followUpAwaitingMonitor=true;h.service.task.steps=[{action:'workbuddySend',state:'input-sent',at:25}];
 const before=structuredClone(h.service.task);try{assert.equal((await h.run()).ok,false);assert.equal(h.calls.length,0);assert.deepEqual(h.service.task,before);assert.equal(workSubmissionConfirmed(h.service.task),false);}finally{await h.service.close();}
});
test('native approval fixtures reject drift before any CGEvent creation',t=>{
 const binary=process.env.WORKBUNNY_DESKTOP_TEST_BIN;if(!binary)return t.skip('set native fixture binary');
 const run=spawnSync(binary,['--self-test-pointer-approval'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);const result=JSON.parse(run.stdout);assert.equal(result.rejectedCases,5);assert.equal(result.noInputDispatched,true);
});
