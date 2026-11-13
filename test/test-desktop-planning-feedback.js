'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const {ToolRegistry}=require('../src/main/agent-tools'),{registerConversationTools}=require('../src/main/conversation-tools');
test('channel authority does not select a workflow when binding or resuming ordinary operations',async()=>{
 const {AgentService}=require('../src/main/agent-service'),{stagedConversationRead}=require('../src/main/desktop-service'),permission={channelId:'fixture',scene:'life',owner:false};let checked=0;
 const service={channels:{ensure:async()=>({}),assert:snapshot=>{assert.equal(snapshot,permission);checked++;}},scene:{}},task={id:'owner-task',skill:'conversation.manage',scene:'life',privacyEpoch:1};
 for(const [operation,kind,expected]of [['open',undefined,false],['send',undefined,false],['read','voice-transcript',true],['read','attachment-save',true]]){
  const physical={target:'wechat',operation,...(kind?{readRequest:{kind}}:{}),channelConversation:true,channelAuthorization:permission,recipient:'Fixture',sources:[task.id]};
  await AgentService.prototype.conversationResumeOptions.call(service,task,physical);assert.equal(physical.channelConversation,expected);assert.equal(stagedConversationRead(physical),expected);assert.equal(physical.channelAuthorization,permission);
 }
 assert.equal(checked,4);
});
test('an authorized existing draft may submit without a prior type step while missing text or non-send scope still refuses',()=>{
 const {validateAction,validateWechatAction}=require('../src/main/desktop-service'),action=validateAction({action:'click',purpose:'submit',x:.8,y:.9});
 assert.doesNotThrow(()=>validateWechatAction(action,{operation:'send',message:'synthetic authorized existing draft',draftInserted:false}));
 assert.throws(()=>validateWechatAction(action,{operation:'send',draftInserted:false}),/message/);
 for(const operation of ['draft','read','open'])assert.throws(()=>validateWechatAction(action,{operation,message:'synthetic authorized existing draft',draftInserted:false}));
});
test('desktop planning timeout aborts its model signal with the original generic error code',async()=>{
 let signal;const service={guiLeaseHeld:false,lease:{revision:0},controller:new AbortController(),progress:()=>({stage(){return this;},measure:async(kind,invoke)=>invoke()}),nextAction:async(scope,shot,s)=>{signal=s;return new Promise(()=>{});},assertLive(){}};
 await assert.rejects(DesktopService.prototype.planWithoutGui.call(service,{id:'synthetic',target:'demo'}, {},1,15),{code:'E_MODEL_TIMEOUT'});assert.equal(signal.aborted,true);
});
test('a visible inactive software reaches its task planner and can be tried without a compulsory activation workflow',async t=>{
 const {fixture}=require('./support/visual-fixture.cjs');let clicked=false,plans=0;
 const h=fixture({onInput:()=>{clicked=true;}});h.native.close=async()=>{};h.native.cancel=async()=>{};
 h.location={...h.location,software:'Demo',active:false,activationRegion:null,activationEvidence:''};
 const service=new DesktopService({native:h.native,imageResize:b=>b,imageCrop:h.crop,bitmap:h.bitmap,planner:async()=>{
  plans++;if(!clicked){assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0,'planning precedes any optional activation input');return {action:'click',x:.6,y:.4};}
  return {action:'done',completed:true,evidence:'The synthetic action reached its requested control'};
 }});t.after(()=>service.close());service.visualSessions=new Map([['demo',h.visual]]);
 service.task={id:'synthetic-autonomous-attempt',target:'demo',goal:'Try the current control',scene:'life',domain:'life',visibilityFloor:1,steps:[],startedAt:Date.now()};service.running=true;service.generation=1;service.controller=new AbortController();
 await service.run(1,{...service.task});assert.equal(service.task.status,'review');assert.equal(plans,2);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
 assert.equal(service.task.steps[0].inputReceipt.acknowledged,true);assert.equal(service.task.steps[0].inputReceipt.verificationScope,'native-input-only');assert.equal(service.task.steps[0].inputReceipt.businessResult,'unresolved');assert.deepEqual(service.task.steps[0].inputIntent,{action:'click',x:.6,y:.4});
});
test('actual model payload keeps repeated-evidence feedback and logical recovery for every desktop target',async()=>{
 for(const target of ['wechat','workbuddy']){
  let payload;
  const feedback={repeats:4,note:'synthetic unchanged evidence; reconsider the method'},recovery={action:'change_method',nextStep:'use the preserved observation'};
  const parentTaskContext={taskId:'original-task',goal:'Inspect the newest visible entries',policy:'Do not navigate into older entries',ownerRequest:'Keep existing drafts unchanged'};
  const scope={id:'synthetic-action',target,operation:'open',goal:'Open synthetic target',recipient:'Synthetic Contact',workModel:'hy3',steps:[],operatingKnowledge:[],progressFeedback:feedback};
  const service={task:{id:scope.id,steps:[],parentTaskContext},actionControl:{recovery},progress:()=>({snapshot:()=>({elapsedMs:60000,withoutProgressMs:45000,repeatedEvidence:4})}),
   modelRequest:async options=>{payload=JSON.parse(options.messages[1].content[0].text);return {text:JSON.stringify({action:'done',completed:false,evidence:'synthetic read-only result'})};},update:()=>{}};
  await DesktopService.prototype.nextAction.call(service,scope,{ocr:[],preview:'data:image/png;base64,c3ludGhldGlj'},new AbortController().signal);
  assert.deepEqual(payload.progressFeedback,feedback);for(const [key,value]of Object.entries(recovery))assert.deepEqual(payload.actionRecovery[key],value);assert.equal(payload.actionRecovery.currentInvocation.submitAttempted,false);assert.equal(payload.goal,scope.goal);assert.equal(payload.timing.elapsedMs,60000);
  assert.deepEqual(payload.parentTaskContext,parentTaskContext);assert.equal(payload.operation,'open');
 }
});
test('nested conversation navigation preserves original task restrictions without carrying unrelated history',async()=>{
 const {AgentService}=require('../src/main/agent-service');let received;
 const task={id:'synthetic-parent',skill:'conversation.manage',goal:'Ask about the latest update',criteria:'Summarize the reply',policy:'Do not navigate into older entries',context:'Inspect only the newest visible items',scene:'life',visibilityFloor:1,state:{ownerRequest:'Keep drafts unchanged',ownerContext:'unrelated-private-history',taskContextEvidence:{recalled:{text:'unrelated-recalled-material'}}}};
 const service={getWeChatOwnership:()=> 'owner',serialConversation:run=>run(),scene:{assertHealthy:async()=>{}},canOperateForTask:async()=>true,
  conversationDesktop:{start:async options=>{received=options;return {ok:false,dispatched:false,error:'synthetic preflight stop'};}}};
 const result=await AgentService.prototype.executeConversation.call(service,{task,application:'wechat',recipient:'Synthetic Contact',operation:'open',signal:new AbortController().signal});
 assert.equal(result.ok,false);assert.equal(received.operation,'open');const {actionId,now,goalRevision,controlRevision,observationSources,executionFeedback,...parent}=received.parentTaskContext;assert.deepEqual(parent,{taskId:task.id,goal:task.goal,criteria:task.criteria,policy:task.policy,context:task.context,ownerRequest:task.state.ownerRequest});assert.equal(actionId,null);assert(Number.isFinite(now));assert.equal(observationSources,null);assert.equal(executionFeedback,null);assert.equal(goalRevision,0);assert.equal(controlRevision,0);
 assert(!JSON.stringify(received).includes('unrelated-private-history'));assert(!JSON.stringify(received).includes('unrelated-recalled-material'));
 task.state.outcomeFeedback=[{kind:'target-mismatch',expected:{application:'wechat',target:'Synthetic Contact'},observed:{target:'Different fixture',matched:false},execution:{claimedCompleted:true,evidence:'Earlier completion claim'},observationId:'actual-observation'}];
 await AgentService.prototype.executeConversation.call(service,{task,application:'wechat',recipient:'Synthetic Contact',operation:'open',signal:new AbortController().signal});assert(received.parentTaskContext.context.includes(task.context));assert(received.parentTaskContext.context.includes('Different fixture'));assert.equal(received.recipient,'Synthetic Contact');
 let payload;const scope={...received,id:'synthetic-correction'},execution={task:{id:scope.id,steps:[],parentTaskContext:received.parentTaskContext},progress:()=>({snapshot:()=>({})}),modelRequest:async options=>{payload=JSON.parse(options.messages[1].content[0].text);return {text:JSON.stringify({action:'done',completed:false,evidence:'The target still needs correction'})};},update(){}};
 await DesktopService.prototype.nextAction.call(execution,scope,{ocr:[],preview:'data:image/png;base64,c3ludGhldGlj'},new AbortController().signal);assert(payload.parentTaskContext.context.includes('Different fixture'));assert(payload.parentTaskContext.context.includes('claimedCompleted'));assert.equal(payload.recipient,'Synthetic Contact');assert.equal(payload.parentTaskContext.goal,task.goal);
});
test('navigation forwards the same Action lifetime and recovery to its nested visual executor',async()=>{
 const tools=new ToolRegistry(),controller=new AbortController(),action={signal:controller.signal,progress:{},recovery:{action:'change_method'}};
 let received,invalidated=0;
 registerConversationTools(tools,{scene:{assertTaskIdentity:async()=>{},assertHealthy:async()=>{},invalidate:()=>invalidated++},execute:async args=>{received=args;return {ok:true};}});
 const task={id:'synthetic-task'},operationId='synthetic-operation';
 await tools.get('conversation.open').execute({application:'wechat',recipient:'Synthetic Contact'},{task,signal:controller.signal,action,operationId});
 assert.equal(received.action,action);assert.equal(received.signal,controller.signal);assert.equal(received.task,task);assert.equal(received.operationId,operationId);assert.equal(invalidated,1);
});
test('a combined focus and type operation refreshes pixels without a second location model',async t=>{
 const {fixture}=require('./support/visual-fixture.cjs');const h=fixture();h.native.close=async()=>{};h.native.cancel=async()=>{};
 const service=new DesktopService({native:h.native,imageResize:b=>b,imageCrop:h.crop,bitmap:h.bitmap});t.after(()=>service.close());service.visualSessions=new Map([['demo',h.visual]]);
 service.task={id:'synthetic-focus-batch',target:'demo',goal:'Enter the authorized synthetic text',scene:'life',domain:'life',visibilityFloor:1,steps:[],startedAt:Date.now()};service.running=true;service.generation=1;service.controller=new AbortController();
 await h.visual.observe();const scope={...h.visual.identity(),target:'demo'},shot=await service.captureVisual(scope,1);
 await service.actVisual({action:'type',purpose:'task',text:'synthetic authorized text',focus:{x:.5,y:.8}},scope,shot,1);
 assert.deepEqual(h.calls.filter(c=>c.op==='displayInput').map(c=>c.args.action),['click','type']);assert.equal(h.requests.length,1,'acknowledged editor focus does not require another full-screen location verdict');
 assert(h.calls.filter(c=>c.op==='displayCapture').length>=3,'input still receives fresh display pixels');
});
test('focus and type passes its actual refreshed frame to a planned submit while background observation keeps running',async t=>{
 const {fixture,paint}=require('./support/visual-fixture.cjs'),h=fixture();h.native.close=async()=>{};h.native.cancel=async()=>{};let planned=0,typedFrame,submitFrame;
 const service=new DesktopService({native:h.native,imageResize:b=>b,imageCrop:h.crop,bitmap:h.bitmap,planner:async()=>{
  if(++planned===1){for(let i=0;i<6;i++)await h.visual.observe();return {action:'key',key:'a',modifiers:['cmd'],then:[{action:'type',purpose:'task',text:'synthetic authorized text',focus:{x:.5,y:.8}},{action:'click',purpose:'submit',x:.8,y:.4}]};}
  return {action:'done',completed:true,evidence:'The synthetic input and submit both have native acknowledgments'};
 }});t.after(()=>service.close());service.visualSessions=new Map([['demo',h.visual]]);
 service.task={id:'synthetic-frame-chain',target:'demo',goal:'Type and submit the authorized synthetic text',scene:'life',domain:'life',visibilityFloor:1,steps:[],startedAt:Date.now()};service.running=true;service.generation=1;service.controller=new AbortController();
 const act=service.act.bind(service);service.act=async(action,...args)=>{const result=await act(action,...args);if(action.action==='type'){
  typedFrame=result.visualShot.visualFrameId;assert(!Object.keys(result).includes('visualShot'),'local pixels are not part of the native receipt');paint(h.image,h.location.focusRegion,230);h.location={...h.location,mainRegion:{...h.location.mainRegion,x:.12,width:.78}};
  for(let i=0;i<6;i++)await h.visual.observe({relocate:i===0});assert(h.visual.frames.has(typedFrame));
 }else if(action.purpose==='submit')submitFrame=result.visualShot.visualFrameId;return result;};
 await service.run(1,{...service.task});assert.equal(service.task.status,'review');assert.equal(typedFrame,submitFrame);assert.deepEqual(h.calls.filter(c=>c.op==='displayInput').map(c=>c.args.action),['key','click','type','click']);assert.equal(h.visual.frameHolds.size,0,'finishing the Action releases its planning frame');assert(h.visual.frames.size<=4);
});
