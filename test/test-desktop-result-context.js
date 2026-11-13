'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService,validateAction,validateWechatAction}=require('../src/main/desktop-service');
const {ToolRegistry}=require('../src/main/agent-tools');
const {registerConversationTools}=require('../src/main/conversation-tools');
const preview='data:image/png;base64,c3ludGhldGlj';
test('the actual result request independently reads pixels without the full expected answer or positive comparison captions',async()=>{
 for(const target of ['wechat','workbuddy']){
  const expected='SYNTHETIC_EXPECTED_BODY_9f1',parent={taskId:'parent',goal:'Send '+expected,criteria:'Deliver '+expected,policy:'Only the authorized recipient',ownerRequest:'Send '+expected};
  const scope={id:'physical',target,operation:'send',goal:'Deliver '+expected,taskText:expected,message:expected,outboundText:expected,recipient:'Fixture Contact',submitAttempted:true,draftInserted:true,workModel:'hy3',parentTaskContext:parent};
  const original=structuredClone(scope),requests=[],facts={visibleFacts:'An outgoing item is visible and the editor is empty',inference:'The visible result supports completion',uncertainty:'Part of the body is not readable'};
  const service={task:{id:scope.id,parentTaskContext:parent,steps:[{action:'type',text:expected,inputIntent:{action:'type',text:expected},state:'input-sent'}],submitAttemptedAt:10},wechatBeforeSubmit:{taskId:scope.id,preview},progress:()=>({snapshot:()=>({})}),update(){},modelRequest:async options=>{requests.push(options);return {text:JSON.stringify({action:'done',visualObservation:facts,completed:true,evidence:'The visible outgoing result and empty editor support completion',receipt:{observed:'delivered',basis:'Current visible result after the attempt',observedText:null}})};}};
  const action=await DesktopService.prototype.nextAction.call(service,scope,{ocr:[],preview,at:20},new AbortController().signal);
  assert.equal(requests.length,1,'readback and assessment use the existing one request');assert(!JSON.stringify(requests[0]).includes(expected));assert.deepEqual(scope,original,'authorization and the original expected content are preserved on the host');
  const user=requests[0].messages.find(m=>m.role==='user'),payload=JSON.parse(user.content[0].text);
  assert.equal(payload.message,undefined);assert.equal(payload.outboundText,undefined);assert.equal(payload.draftInserted,undefined);assert.equal(payload.draftInputAttempted,true);assert.equal(payload.verificationContext.expectedContentWithheld,true);assert.equal(payload.parentTaskContext.policy,parent.policy);assert.equal(payload.recipient,'Fixture Contact');
  const captions=user.content.filter(p=>p.type==='text').slice(1).map(p=>p.text).join('\n');assert(!captions.includes('确认新增气泡'));assert(!captions.includes('旧气泡与待发草稿'));
  assert.deepEqual(action.visualObservation,facts);assert.equal(action.completed,true,'partial text does not impose a new literal-completion gate');assert.equal(action.receipt.observedText,null);
 }
});
test('normal action planning keeps its authorized body while the protocol supplies no fixed click or focus coordinates',async()=>{
 const message='SYNTHETIC_ORIGINAL_INPUT',requests=[],scope={id:'physical',target:'wechat',operation:'send',goal:'Send the original input',message,recipient:'Fixture Contact',workModel:'hy3'};
 const service={task:{id:scope.id,steps:[]},progress:()=>({snapshot:()=>({})}),update(){},modelRequest:async options=>{requests.push(options);return {text:JSON.stringify({action:'wait',reason:'Inspect current control'})};}};
 await DesktopService.prototype.nextAction.call(service,scope,{ocr:[],preview},new AbortController().signal);
 assert.equal(JSON.parse(requests[0].messages.find(m=>m.role==='user').content[0].text).message,message);
 const system=requests[0].messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert(!system.includes('"x":0.6'));assert(!system.includes('"x":0.9'));assert(system.includes('依据当前实际截图'));
});
test('the original pending submit can cancel an obstruction with Escape without retyping, resubmitting or erasing its receipt',async t=>{
 const review=require('../src/main/effect-review'),original={id:'old-input',key:'original-key',effect:'write',tool:'fixture.input',status:'intent',inputOutcome:{dispatched:true,reportsSubmitted:3,completion:'unknown'}},task={id:'canonical',goal:'Send one ordinary note',state:{},operations:{'old-input':original},scene:'life',visibilityFloor:1,authority:{verified:true}};
 const native={setInputContext(){},close:async()=>{}},actual=[];let plans=0;
 const facts={visibleFacts:'The temporary obstruction is gone; the result area is visible',inference:'The original result is now visible',uncertainty:'The full body is not read back'};
 const service=new DesktopService({native,planner:async()=>++plans===1?{action:'key',key:'escape',modifiers:[],purpose:'navigation'}:plans===2?{action:'click',x:.3,y:.2,purpose:'navigation'}:{action:'done',completed:true,evidence:'The original outgoing result is now visible',visualObservation:facts,receipt:{observed:'delivered',basis:'Current visible result',observedText:null}}});t.after(()=>service.close());
 service.task={id:'physical',goal:task.goal,target:'wechat',recipient:'Fixture Contact',message:'Authorized note',operation:'send',scene:'life',domain:'life',visibilityFloor:1,steps:[],draftInserted:true,submitAttemptedAt:10,submissionAttempts:[{id:'original-attempt',outcome:'unknown'}],startedAt:Date.now(),workModel:'hy3'};
 service.wechatBeforeSubmit={taskId:'physical',preview};service.visualSessions=new Map([['wechat',{observe:async()=>({}),identity:()=>({mode:'visual',sessionId:'session'})}]]);service.running=true;service.generation=1;service.controller=new AbortController();
 service.capture=async()=>service.screenshot={at:Date.now(),frameId:'fresh-'+plans,preview,captureSource:'CGDisplayStream',perceptionSource:'vision-model',ocr:[],rect:{x:0,y:0,width:200,height:120},width:200,height:120};service.assertScreenshotCurrent=async()=>{};service.act=async action=>{actual.push(action);return {performed:true};};
 await review.scope({task,operation:original,input:{message:'Authorized note'},tool:{continuationPolicy:(t,a)=>review.boundedPolicy(t,a)},save:async()=>{},isCurrent:()=>true},()=>service.run(1,{...service.task}));
 assert.equal(plans,3);assert.deepEqual(actual.map(a=>[a.action,a.key,a.purpose]),[['key','escape','navigation'],['click',undefined,'navigation']]);assert.equal(service.task.submissionAttempts.length,1);assert.equal(service.task.submitAttemptedAt,10);assert.equal(original.status,'intent');assert.equal(original.inputOutcome.reportsSubmitted,3);assert.equal(original.effectReview,undefined);assert.deepEqual(service.task.deliveryAssessment.visualObservation,facts);assert.equal(service.task.deliveryAssessment.receipt.observedText,null);
 for(const action of [{action:'key',key:'escape',modifiers:['cmd'],purpose:'navigation'},{action:'type',text:'Do not type again'},{action:'key',key:'return',modifiers:[],purpose:'submit'}])assert.throws(()=>validateWechatAction(validateAction(action),{operation:'send',message:'Authorized note',submitAttemptedAt:10}));
});
test('the real conversation contract distinguishes visual judgments from independent receipt facts without demanding external verification',()=>{
 const tools=new ToolRegistry();registerConversationTools(tools,{scene:{},execute:async()=>({})});const contract=tools.catalog(['conversation.send'])[0].resultContract;
 assert(contract.verification.includes('综合视觉判断'));assert(contract.verification.includes('desiredText一致本身不增加'));assert(contract.verification.includes('不要求手机'));assert(contract.verification.includes('新反例')||contract.verification.includes('后续实际画面'));
});
test('recovery clicks require the original trusted bounded context and stop, control changes or sensitive goals revoke it',()=>{
 const review=require('../src/main/effect-review'),action=validateAction({action:'click',purpose:'navigation',x:.25,y:.3}),scope={operation:'send',message:'Ordinary note',submitAttemptedAt:10};
 assert.throws(()=>validateWechatAction(action,{...scope,navigationRecoveryContext:{impact:'bounded'}}),'a model cannot supply its own navigation permission');
 for(const change of [task=>task.state.stopRequest={at:20},task=>task.state.controlRevision=2,task=>task.state.sensitiveContext=true]){
  const task={id:'canonical',goal:'Send an ordinary note',state:{},status:'waiting',scene:'life',visibilityFloor:1},context=review.visualContext(task,{message:'Ordinary note'});
  assert(context);assert.doesNotThrow(()=>validateWechatAction(action,{...scope,navigationRecoveryContext:context}));change(task);
  assert.throws(()=>validateWechatAction(action,{...scope,navigationRecoveryContext:context}),{code:'E_EFFECT_REVIEW'});
 }
 assert.equal(review.visualContext({id:'major',goal:'Payment transfer',state:{},scene:'life',visibilityFloor:1},{}),null);
});
