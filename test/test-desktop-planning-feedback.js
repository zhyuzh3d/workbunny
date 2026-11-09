'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service');
const {ToolRegistry}=require('../src/main/agent-tools'),{registerConversationTools}=require('../src/main/conversation-tools');
test('actual model payload keeps repeated-evidence feedback and logical recovery for every desktop target',async()=>{
 for(const target of ['wechat','workbuddy']){
  let payload;
  const feedback={repeats:4,note:'synthetic unchanged evidence; reconsider the method'},recovery={action:'change_method',nextStep:'use the preserved observation'};
  const scope={id:'synthetic-action',target,operation:'open',goal:'Open synthetic target',recipient:'Synthetic Contact',workModel:'hy3',steps:[],operatingKnowledge:[],progressFeedback:feedback};
  const service={task:{id:scope.id,steps:[]},actionControl:{recovery},progress:()=>({snapshot:()=>({elapsedMs:60000,withoutProgressMs:45000,repeatedEvidence:4})}),
   modelRequest:async options=>{payload=JSON.parse(options.messages[1].content[0].text);return {text:JSON.stringify({action:'done',completed:false,evidence:'synthetic read-only result'})};},update:()=>{}};
  await DesktopService.prototype.nextAction.call(service,scope,{ocr:[],preview:'data:image/png;base64,c3ludGhldGlj'},new AbortController().signal);
  assert.deepEqual(payload.progressFeedback,feedback);assert.deepEqual(payload.actionRecovery,recovery);assert.equal(payload.goal,scope.goal);assert.equal(payload.timing.elapsedMs,60000);
 }
});
test('navigation forwards the same Action lifetime and recovery to its nested visual executor',async()=>{
 const tools=new ToolRegistry(),controller=new AbortController(),action={signal:controller.signal,progress:{},recovery:{action:'change_method'}};
 let received,invalidated=0;
 registerConversationTools(tools,{scene:{assertTaskIdentity:async()=>{},assertHealthy:async()=>{},invalidate:()=>invalidated++},execute:async args=>{received=args;return {ok:true};}});
 const task={id:'synthetic-task'},operationId='synthetic-operation';
 await tools.get('conversation.open').execute({application:'wechat',recipient:'Synthetic Contact'},{task,signal:controller.signal,action,operationId});
 assert.equal(received.action,action);assert.equal(received.signal,controller.signal);assert.equal(received.task,task);assert.equal(received.operationId,operationId);assert.equal(invalidated,1);
});
