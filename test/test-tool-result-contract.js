'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ToolRegistry}=require('../src/main/agent-tools'),{registerConversationTools}=require('../src/main/conversation-tools');
test('tool result norms survive the actual registry/catalog without becoming task authority or mutable catalog state',()=>{
 const tools=new ToolRegistry();registerConversationTools(tools,{scene:{},execute:async()=>({ok:true})});
 const tool=tools.get('conversation.send'),catalog=tools.catalog(['conversation.send'])[0];
 assert(catalog.resultContract.sourceMark.includes(require('../src/shared/external-message').MARK));
 assert.deepEqual(catalog.resultContract,tool.resultContract);catalog.resultContract.sourceMark='changed planning copy';
 assert.notEqual(tool.resultContract.sourceMark,catalog.resultContract.sourceMark);
 assert.deepEqual(tool.capabilities,['conversation.send']);assert.equal(tool.effect,'write');
});

function deliveryFixture(){
 const tools=new ToolRegistry(),sent=[];
 registerConversationTools(tools,{scene:{},execute:async()=>({ok:true})});
 require('../src/main/result-delivery').registerResultTools(tools,{deliver:async(message,task,signal,index,operationId)=>{sent.push({message,recipient:task.delivery.recipient,index,operationId});return {ok:true,verified:true};}});
 const task={id:'synthetic-delivery',goal:'Collect a result and deliver it to the authorized destination',criteria:'Report the actual result',subjects:[{application:'wechat',recipient:'fixture-contact'}],delivery:{channel:'wechat',recipient:'fixture-report'},capabilities:['conversation.send'],operations:{},authority:{channel:'dialogue'},scene:'life',state:{result:{summary:'Actual collected result'}}};
 return {tools,task,sent};
}
test('delivery catalog declares the actual accepted arguments while the Task retains destination authority',async()=>{
 const {tools,task,sent}=deliveryFixture(),catalog=tools.catalog(['result.deliver','result.attach'],task);
 const uncollected={...task,state:{}};
 assert.deepEqual(tools.catalog(['result.deliver','result.attach'],uncollected),[],'uncollected results cannot be planned as delivery Operations');
 assert.throws(()=>tools.check('result.deliver',{message:'invented result'},uncollected),/未授权/u);
 assert.deepEqual(tools.catalog(['result.deliver','result.attach'],{...task,delivery:{channel:'speech'}}),[]);
 assert.deepEqual(catalog[0].inputSchema.required,['message']);assert.equal(catalog[0].inputSchema.additionalProperties,false);
 assert.deepEqual(Object.keys(catalog[0].inputSchema.properties),['message']);assert.match(catalog[0].description,/Task\.delivery\.recipient/u);
 assert.deepEqual(catalog[1].inputSchema.required,['index']);assert.equal(catalog[1].inputSchema.properties.index.maximum,3);
 const {tool,input}=tools.check('result.deliver',{message:'Actual collected result'},task);
 await tool.execute(input,{task,operationId:'delivery-operation'});
 assert.deepEqual(sent,[{message:'Actual collected result',recipient:'fixture-report',index:undefined,operationId:'delivery-operation'}]);
 for(const args of [{application:'wechat',recipient:'fixture-report',message:'result'},{application:'wechat',recipient:'fixture-report'},{}])assert.throws(()=>tools.check('result.deliver',args,task));
 assert.throws(()=>tools.check('conversation.send',{application:'wechat',recipient:'fixture-report',message:'result'},task),/交办范围/u,'delivery authority does not expand ordinary conversation subjects');
 assert.throws(()=>tools.check('result.attach',{index:4},task));
 assert.throws(()=>tools.check('result.deliver',{message:'result'},{...task,capabilities:[]}),/未授权/u);
});
test('Goal done saves the result before authorized automatic delivery and a retry does not deliver again',async()=>{
 const {tools,task,sent}=deliveryFixture();Object.assign(task,{actionRuns:{},state:{goalPlan:{schema:'bunny.goal-actions/v1',revision:0,observed:true,goalRevision:0}},counters:{}});
 const checkpoints=[];
 let requests=0;const request=async options=>{
  requests++;const payload=JSON.parse(options.messages.at(-1).content[0].text);
  assert.deepEqual(payload.delivery,task.delivery);assert(!payload.tools.some(t=>t.name==='result.deliver'||t.name==='result.attach'));
  assert.match(options.messages[0].content,/只差Task\.delivery指定的最终交付.*done:true/u);
  return {response:{text:JSON.stringify({done:true,summary:'Actual collected result'})}};
 };
 const ctx={task,availableTools:tools.catalog(undefined,task),clock:()=>1000,isLive:()=>true,checkpoint:async()=>checkpoints.push(structuredClone(task.state)),validateCall:(name,args)=>tools.check(name,args,task),call:async op=>{
  assert(checkpoints.some(s=>s.result?.summary==='Actual collected result'),'result is durable before delivery');
  const {tool,input}=tools.check(op.tool,op.args,task);return tool.execute(input,{task,operationId:op.key});
 }};
 const goal=require('../src/main/goal-actions');
 assert.throws(()=>goal.validatePlan({done:false,actions:[{key:'early-delivery',goal:'Deliver',criteria:'Result received',operations:[{key:'send',tool:'result.deliver',args:{message:'result'}}]}]},ctx),error=>error.code==='E_ACTION_PLAN'&&/done:true.*summary/u.test(error.message));
 assert.equal((await goal.plan(ctx,{request})).status,'completed');
 assert.equal(requests,1);assert.equal(sent.length,1);assert.equal(sent[0].recipient,'fixture-report');assert.equal(sent[0].message,task.state.result.summary);assert.equal(task.state.delivery.status,'delivered');
 assert.equal((await goal.plan(ctx,{request})).status,'completed');assert.equal(sent.length,1);assert.equal(requests,1,'a recovered collected result resumes host delivery without replanning');
});

test('invalid or canceled result delivery is rejected before visual work, and valid delivery retains the exact Task binding',async()=>{
 const {task}=deliveryFixture(),events=[],service={scene:{assertTaskIdentity:async()=>events.push('identity'),observe:async(subject,options)=>{events.push(subject);assert.equal(options.signal,controller.signal);return {headerMatched:true,draft:''};}},executeConversation:async op=>{events.push(op);return {ok:true};}};
 const controller=new AbortController(),deliver=require('../src/main/agent-service').AgentService.prototype.deliverWork.bind(service);
 await assert.rejects(deliver('result',{...task,state:{}},controller.signal),error=>error.code==='E_RESULT_NOT_READY'&&error.dispatched===false&&/done:true/u.test(error.message));
 await assert.rejects(deliver('changed result',task,controller.signal),/交付正文/u);
 await assert.rejects(deliver('Actual collected result',{...task,delivery:{channel:'speech'}},controller.signal),/交付对象/u);
 await assert.rejects(deliver(null,task,controller.signal,0),/成果附件/u);
 assert.deepEqual(events,[]);
 await deliver('Actual collected result',task,controller.signal,undefined,'bound-delivery');
 assert.equal(events.length,3);assert.equal(events[1].recipient,'fixture-report');assert.equal(events[2].recipient,'fixture-report');assert.equal(events[2].task,task);assert.equal(events[2].operationId,'bound-delivery');
 controller.abort();await assert.rejects(deliver('Actual collected result',task,controller.signal),error=>error.code==='ABORT_ERR'&&error.dispatched===false);assert.equal(events.length,3);
});
test('recovery wire retains tool schemas and the separate delivery target without exposing unavailable tools',async()=>{
 const {tools,task}=deliveryFixture();tools.register({name:'fixture.private',description:'unavailable tool',effect:'read',capabilities:['private.read'],execute:async()=>({})});
 let requests=0;
 const result=await require('../src/main/agent-service').AgentService.prototype.continueIdle.call({tools},{task,idleMs:0,failure:{code:'E_MODEL_SCHEMA',message:'成果交付字段不合法'}},async options=>{
  requests++;const payload=JSON.parse(options.messages.at(-1).content);
  assert.deepEqual(payload.core.delivery,task.delivery);assert.deepEqual(payload.core.subjects,task.subjects);
  assert.deepEqual(payload.tools.find(t=>t.name==='result.deliver').inputSchema,tools.get('result.deliver').inputSchema);
  assert.deepEqual(payload.tools.find(t=>t.name==='conversation.send').resultContract,tools.get('conversation.send').resultContract);
  assert(!payload.tools.some(t=>t.name==='fixture.private'));
  return {response:{text:JSON.stringify({action:'change_method',nextStep:'Use result.deliver with message only; retain the original Task delivery destination'})}};
 });
 assert.equal(requests,1);assert.equal(result.action,'change_method');assert.deepEqual(task.subjects,[{application:'wechat',recipient:'fixture-contact'}]);
});
