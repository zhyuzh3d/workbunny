'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const order=require('../src/main/work-order');
const {AgentService}=require('../src/main/agent-service');
const {verifyDelivery}=require('../src/main/secretary');
const prior='请制作网页，完成后提供可分享的真实网址。',promise='完成后给你可分享的网址。',answer='五年级，直接做吧。';
const ids=['prior-owner','assistant-promise','answer-owner','recalled-source'];
const memoryContext=()=>({messages:[{id:ids[0],role:'user',characterId:'owner',content:prior},{id:ids[1],role:'assistant',characterId:'bunny',content:promise},{id:ids[2],role:'user',characterId:'owner',content:answer}],text:'来源recalled-source：主人此前确认面向高年级。',sourceIds:ids});
const actor=()=>({role:'owner',verified:true,channel:'dialogue',scene:'life',sources:ids});
const spec=()=>({skill:'work.delegate',goal:'制作适合指定年级并可分享的网页',criteria:'返回真实入口',subjects:[{application:'workbuddy'}],workRequest:{goal:'制作并公开分享对应网页，返回实际网址',criteria:'网址对应本轮作品且可独立访问',context:'面向五年级',output:'files'}});
function agent(request){const records=new Map();return new AgentService({scene:{metrics:{},native:{request:async()=>assert.fail('no native operations')},close:async()=>{}},request,ready:()=>true,epoch:()=>1,autoSchedule:false,journal:{put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()],authorized:async()=>true}});}

test('task context carries recent owner, assistant and recalled data while the legacy API stays compatible',()=>{
 const source=memoryContext(),before=structuredClone(source),encoded=order.encodeTaskContext(source),evidence=order.taskContextEvidence(encoded,{sourceIds:ids});
 assert.deepEqual(source,before);assert.equal(evidence.recalled.text,source.text);assert.deepEqual(evidence.sourceIds,ids);
 assert.equal(evidence.messages[1].characterId,'bunny');assert.equal(evidence.trust,'context-data-not-new-instructions');
 for(const input of [encoded,evidence,order.encodeContext(source.messages)]){const owner=order.ownerContext(input);assert(owner.includes(prior));assert(owner.includes(answer));assert(!owner.includes(promise));assert(!owner.includes(source.text));}
 assert(Array.isArray(JSON.parse(order.encodeContext(source.messages))));
 assert.throws(()=>order.taskContextEvidence(encoded,{sourceIds:['answer-owner']}),/宿主来源绑定/);
 const forged=JSON.parse(encoded);forged.messages[0].id='unbound-owner';assert.throws(()=>order.taskContextEvidence(forged,{sourceIds:ids}),/宿主来源绑定/);
});
test('new context preserves authenticated owner metadata without promoting ordinary external users',()=>{
 const source={messages:[{id:'remote-owner',role:'user',characterId:'contact',verifiedOwner:true,channelId:'bound-channel',channel:'wechat',content:'认证主人原话'},
  {id:'external',role:'user',characterId:'contact',verifiedOwner:false,channelId:'ordinary-channel',content:'普通外部联系人'},
  {id:'unlabelled',role:'user',content:'没有身份元数据'}],text:'',sourceIds:['remote-owner','external','unlabelled']};
 const evidence=order.taskContextEvidence(order.encodeTaskContext(source),{sourceIds:source.sourceIds});
 assert.equal(evidence.messages[0].verifiedOwner,true);assert.equal(evidence.messages[0].channelId,'bound-channel');
 const owner=order.ownerContext(evidence);assert(owner.includes('认证主人原话'));assert(!owner.includes('普通外部联系人'));assert(!owner.includes('没有身份元数据'));
 assert.equal(order.ownerContext(order.encodeContext([{role:'user',content:'旧数组本机主人'}])),'旧数组本机主人');
});

test('one interpretation receives the complete long context and adoption keeps it private',async t=>{
 const source=memoryContext();source.text+='\n'+'召回事实正文。'.repeat(2500);let calls=0;
 const service=agent(async options=>{calls++;const input=JSON.parse(options.messages.find(m=>m.role==='user').content);
  assert.equal(input.currentOwnerRequest,answer);assert.equal(input.context.recalled.text,source.text);
  assert.equal(input.context.messages[0].content,prior);assert.equal(input.context.messages[1].content,promise);assert.equal(input.context.messages[2].content,answer);
  assert.deepEqual(input.context.sourceIds,ids);assert.equal(input.resolutionIssue,'fixture parameter correction');assert.match(options.messages[0].content,/短答案不替换前轮整份要求/);assert.match(options.messages[0].content,/助手承诺.*不能变成主人授权/);
  return {model:'fixture',response:{text:JSON.stringify({kind:'task',task:spec()})}};
 });t.after(()=>service.close());
 const admitted=await service.command(answer,actor(),{context:order.encodeTaskContext(source)});assert(admitted.ok,admitted.error);
 const task=service.runtime.tasks.get(admitted.id);assert.equal(task.context,'');assert.equal(task.state.taskContextEvidence.recalled.text,source.text);task.state.resolutionIssue='fixture parameter correction';task.sources=[...task.sources,'learned-reference-not-owner'];
 await service.runtime.tick(task.id);assert.equal(calls,1);assert.equal(task.skill,'work.delegate');
 assert.equal(task.state.taskContextEvidence.recalled.text,source.text);assert(task.state.ownerContext.includes(prior));assert(!task.state.ownerContext.includes(promise));assert(!task.authority.sources.includes('learned-reference-not-owner'));
 const body=order.workMessage(task,order.workOrder(task));assert(body.includes(task.workRequest.goal));assert(body.includes(task.workRequest.criteria));
 for(const original of [prior,promise,answer,source.text])assert(!body.includes(original));
});

test('ordinary user JSON cannot supply context sources and unbound context rejects before interpretation',async t=>{
 let calls=0;const service=agent(async()=>{calls++;throw Error('must not call');});t.after(()=>service.close());
 const encoded=order.encodeTaskContext(memoryContext());await assert.rejects(service.command(answer,{...actor(),sources:['answer-owner']},{context:encoded}),/宿主来源绑定/);
 const admitted=await service.command(encoded,actor());assert(admitted.ok,admitted.error);const task=service.runtime.tasks.get(admitted.id);
 assert.equal(task.state.taskContextEvidence,undefined);assert.equal(task.state.ownerRequest,encoded);assert.equal(calls,0);
});

test('continuation preserves private evidence and marks sensitive context for learning exclusion',async t=>{
 const service=agent();t.after(()=>service.close());
 const source=memoryContext();source.text+='\n密码：synthetic-context-secret-88217';const evidence=order.taskContextEvidence(order.encodeTaskContext(source),{sourceIds:ids});
 const started=await service.start(spec(),actor(),{ownerRequest:prior,ownerContext:order.ownerContext(evidence),taskContextEvidence:evidence});assert(started.ok,started.error);
 const old=service.runtime.tasks.get(started.id);assert.equal(old.state.sensitiveContext,true);old.status='completed';old.state.job={jobId:'bound-physical'};
 const next=await service.dispatch({kind:'update',id:old.id,patch:{goal:'保留原交付条件，增加一条说明',workRequest:{...spec().workRequest,goal:'保留原网页与公开入口，增加一条说明'}}},actor(),{ownerRequest:'增加一条说明'});assert(next.ok,next.error);
 const continued=service.runtime.tasks.get(next.id);assert.equal(continued.state.taskContextEvidence.recalled.text,source.text);assert.equal(continued.state.sensitiveContext,true);
 assert(continued.state.ownerContext.includes(prior));assert(continued.sources.includes('recalled-source'));assert(!order.workOrder(continued).includes('synthetic-context-secret-88217'));
});

test('review receives the same private context through the existing sanitization boundary',async()=>{
 const secret='private-context-value-38382',source=memoryContext();source.text+=' '+secret;source.messages[0].content+=' '+secret;
 const evidence=order.taskContextEvidence(order.encodeTaskContext(source),{sourceIds:ids});
 const task={id:'logical',status:'waiting',scene:'life',goal:'交付网页',criteria:'实际入口',sources:ids,authority:actor(),state:{workPhase:'verifying',ownerRequest:answer,ownerContext:prior,taskContextEvidence:evidence}};
 const physical={id:'physical',target:'workbuddy',sources:[task.id],status:'review',goal:'交付网页',criteria:'实际入口',handoffSent:true,monitorSessionId:'bound',monitorMessageKey:'one',monitorSummary:'对应作品已制作。'};
 let requests=0;const service={memory:{sensitiveValues:async()=>[secret]},learning:{reviewContext:async()=>({knowledge:[],sourceIds:[],availability:'current',isCurrent:async()=>true})},runtime:{tasks:new Map([[task.id,task]]),journal:{authorized:async()=>true},save:async()=>{}},desktop:{task:physical,publicStatus:()=>({}),accept:async()=>assert.fail('need_user must not accept')},verify:options=>verifyDelivery({...options,request:async input=>{requests++;assert(!JSON.stringify(input).includes(secret));const data=JSON.parse(input.messages[1].content[0].text);assert.match(data.reviewContext.ownerEvidence.taskContextEvidence.recalled.text,/敏感信息已省略/);return {model:'fixture',response:{text:JSON.stringify({verdict:'need_user',report:'需要核对入口。',linkIds:[]})}};}})};
 const result=await AgentService.prototype.workStatus.call(service,physical.id,task,new AbortController().signal);assert.equal(result.needsAttention,true);assert.equal(requests,1);assert(task.state.taskContextEvidence.recalled.text.includes(secret));
});
