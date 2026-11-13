'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,paint}=require('./support/visual-fixture.cjs');
const review=require('../src/main/effect-review'),ledger=require('../src/main/operation-ledger');
const task=()=>({id:'ordinary-task',goal:'Enter the authorized synthetic reply',scene:'life',domain:'life',visibilityFloor:1,status:'running',state:{},authority:{verified:true},capabilities:['screen.input'],operations:{}});

test('ordinary focus and typing use delayed activation pixels as feedback and continue the same plan without another model',async t=>{
 const {DesktopService}=require('../src/main/desktop-service'),h=fixture();h.native.close=async()=>{};h.native.cancel=async()=>{};h.location.focusRegion=null;h.location.focusEvidence='';let clicked=false,postFocusCaptures=0;
 const request=h.native.request;h.native.request=async(op,args,...rest)=>{
  if(op==='displayCapture'&&clicked&&++postFocusCaptures===2){h.advance(415);paint(h.image,h.location.identityRegion,250);paint(h.image,{x:.35,y:.7,width:.4,height:.15},230);}
  const result=await request(op,args,...rest);if(op==='displayInput'&&args.action==='click')clicked=true;return result;
 };
 const service=new DesktopService({native:h.native,imageResize:b=>b,imageCrop:h.crop,bitmap:h.bitmap});t.after(()=>service.close());service.visualSessions=new Map([['demo',h.visual]]);service.task={...task(),target:'demo',steps:[],startedAt:Date.now()};service.running=true;service.generation=1;service.controller=new AbortController();
 const scope={...h.visual.identity(),target:'demo'},shot=await service.captureVisual(scope,1);
 const typed=await service.actVisual({action:'type',purpose:'task',text:'authorized synthetic reply',focus:{x:.5,y:.8}},scope,shot,1);
 assert(typed.visualFeedback.checks.some(check=>check.identityChanged));assert(typed.visualFeedback.checks.some(check=>check.targetChanged));assert(typed.visualFeedback.checks.every(check=>check.captureId&&Number.isFinite(check.capturedAt)));
 paint(h.image,{x:.35,y:.7,width:.4,height:.15},180);await service.actVisual({action:'key',key:'return',modifiers:[]},scope,typed.visualShot,1,{continuation:true});
 assert.deepEqual(h.calls.filter(c=>c.op==='displayInput').map(c=>c.args.action),['click','type','key']);assert.equal(h.requests.length,1,'appearance changes do not require an extra location verdict');
});

test('a trusted ordinary input reports changed identity and pointer hover while explicit protections and host control remain hard',async()=>{
 const h=fixture(),owner=task(),frame=await h.visual.observe(),context=review.visualContext(owner),request=h.native.request;
 h.native.request=async(op,args,timeout,options)=>{if(op!=='displayInput')return request(op,args,timeout,options);paint(h.image,h.location.identityRegion,240);paint(h.image,{x:.58,y:.48,width:.04,height:.04},240);const proof=await options.refreshVisualEvidence();assert.equal(proof.capturedAt,100000);return {performed:true,inputOutcome:{dispatched:true,inputKinds:['move','click'],inputKindsComplete:true,pointerCommitState:'acknowledged',releaseConfirmed:true}};};
 const result=await h.visual.input(frame.visualFrameId,{action:'click',x:120,y:60},{executionContext:context});assert(result.visualFeedback.checks.at(-1).identityChanged);assert(result.visualFeedback.checks.at(-1).targetChanged);assert.equal(result.inputOutcome.pointerCommitState,'acknowledged');assert.equal(h.requests.length,1);
 for(const change of ['geometry','protected','cancel','reset','permission','stale-native']){
  const f=fixture(),authority=task(),before=await f.visual.observe(),signal=new AbortController(),executionContext=review.visualContext(authority),protectedRegion={x:.05,y:.4,width:.1,height:.1};let beforeDispatch;
  if(change==='geometry'){const native=f.native.request;f.native.request=async(op,...args)=>({...await native(op,...args),...(op==='displayCapture'?{desktopRect:{x:5,y:0,width:200,height:120}}:{})});}
  if(change==='protected')paint(f.image,{x:.14,y:.42,width:.08,height:.08},240);
  if(change==='cancel')signal.abort();if(change==='reset')f.visual.reset();if(change==='permission')beforeDispatch=()=>{authority.state.controlRevision=1;};
  if(change==='stale-native'){const native=f.native.request;f.native.request=async(op,...args)=>{if(op==='displayInput')throw Object.assign(Error('expired native evidence'),{code:'E_VISUAL_EVIDENCE_EXPIRED',dispatched:false});return native(op,...args);};}
  await assert.rejects(f.visual.input(before.visualFrameId,{action:'click',x:120,y:60},{executionContext,signal:signal.signal,regions:change==='protected'?[protectedRegion]:[],beforeDispatch}));assert.equal(f.calls.filter(c=>c.op==='displayInput').length,0,change);
 }
});

test('ordinary feedback contexts cannot be forged, expanded to major impact, or release an unknown effect for replay',async()=>{
 for(const alteration of ['forged','payment','private']){
  const h=fixture(),owner=task(),frame=await h.visual.observe();paint(h.image,h.location.identityRegion,240);
  if(alteration==='payment')owner.goal='Make a payment';if(alteration==='private'){owner.scene='private';owner.visibilityFloor=2;}
  const executionContext=alteration==='forged'?{assertCurrent(){}}:review.visualContext(owner);if(alteration!=='forged')assert.equal(executionContext,null);
  await assert.rejects(h.visual.input(frame.visualFrameId,{action:'click',x:120,y:60},{executionContext}));assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0);
 }
 const owner=task(),unknown={id:'unknown',key:'previous-submit',effect:'write',status:'intent',inputOutcome:{dispatched:true,inputKinds:['key'],inputKindsComplete:true,dispatchOutcomeUnknown:true,releaseConfirmed:true}},raw=structuredClone(unknown);owner.operations.unknown=unknown;
 assert(review.checkVisualContext(review.visualContext(owner)));assert(ledger.hasBlockingEffect(owner,unknown));assert.deepEqual(unknown,raw,'an ordinary visual context neither edits history nor issues a replay permit');
});
test('visual feedback survives the agent tool, durable ledger and actual task-brain prompt, including unknown input without replay',async()=>{
 const {ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills'),{AgentRuntime}=require('../src/main/agent-runtime'),{registerConversationTools}=require('../src/main/conversation-tools'),{ConversationBrain}=require('../src/main/conversation-brain');
 for(const uncertain of [false,true]){
  const feedback={schema:'bunny.visual-feedback/v1',checks:[{captureId:'b'.repeat(32),baselineCaptureId:'a'.repeat(32),capturedAt:1000,identityChanged:true,targetChanged:true,advisory:true}]},tools=new ToolRegistry();let dispatched=0,payload;
  registerConversationTools(tools,{scene:{assertTaskIdentity:async()=>{},invalidate(){}},execute:async()=>{dispatched++;return uncertain?{ok:false,dispatched:true,error:'native commit receipt lost',inputOutcome:{dispatched:true,inputKinds:['key'],inputKindsComplete:true,dispatchOutcomeUnknown:true,releaseConfirmed:true},visualFeedback:feedback}:{ok:true,receipt:{verified:true},visualFeedback:feedback};}});
  const brain=new ConversationBrain({request:async options=>{payload=JSON.parse(options.messages.find(m=>m.role==='user').content);return {response:{text:JSON.stringify({decision:'ignore',reply:'',summary:'Preserved visual observations',completed:false,progress:{},unknown:[]})}};}});
  const call={tool:'conversation.send',key:'one-submit',args:{application:'wechat',recipient:'Fixture',message:'synthetic authorized reply'}};
  const skills=new SkillRegistry(tools).register({id:'fixture.reply',version:1,description:'fixture',tools:['conversation.send'],capabilities:['conversation.send'],run:async ctx=>{
   if(uncertain){await assert.rejects(ctx.call(call),error=>{assert.deepEqual(error.visualFeedback,feedback);return true;});await assert.rejects(ctx.call(call),{code:'E_SUBMISSION_UNCERTAIN'});}
   else assert.deepEqual((await ctx.call(call)).visualFeedback,feedback);
   await brain.decide({task:ctx.task,subject:{application:'wechat',recipient:'Fixture'},conversation:{},incoming:[]});return {status:'waiting',nextCheckAt:2000};
  }});
  const records=new Map(),runtime=new AgentRuntime({tools,skills,autoSchedule:false,epoch:()=>1,clock:()=>1000,journal:{put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[],authorized:async()=>true}});
  const started=await runtime.start({skill:'fixture.reply',goal:'Reply to the authorized synthetic conversation',subjects:[{application:'wechat',recipient:'Fixture'}],parameters:{behavior:'reply'}},{role:'owner',verified:true,sources:['fixture-owner'],scene:'life'});assert(started.ok,started.error);await runtime.tick(started.id);
  assert.equal(dispatched,1);assert.deepEqual(payload.recentInputFeedback[0].visualFeedback,feedback);const stored=Object.values(records.get(started.id).operations).find(op=>op.tool==='conversation.send');assert.deepEqual(stored.result?.visualFeedback||stored.visualFeedback,feedback);if(uncertain){assert.equal(stored.status,'intent');assert(ledger.hasUncertainEffect(stored));}await runtime.close();
 }
});
