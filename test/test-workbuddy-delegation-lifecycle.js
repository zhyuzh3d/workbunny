'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service');
function continuation({observed=false}={}){
 const prior={id:'old-operation',sessionId:'bound-session',monitorSessionId:'bound-session',monitorTaskId:1,monitorMessageKey:'old-message',handoffSent:true,status:'accepted',target:'workbuddy',followUpRound:0,goal:'create a page',criteria:'save files',sources:['original-task']};
 const task={id:'new-task',goal:'发布已有网站并给真实链接',criteria:'真实网址可以访问',state:{priorJob:{jobId:prior.id},ownerRequest:'发布已有网站并给真实链接'},parameters:{sourceTaskId:'original-task'},scene:'life',privacyEpoch:1,sources:['owner-turn']};
 let bindingObserved=false;
 const desktop={task:prior,running:false,journal:async()=>{},async followUp(){
  Object.assign(this.task,{followUpRound:1,followUpAwaitingMonitor:true,followUpPending:{state:'sent'},status:'monitoring'});
  this.running=observed;
  if(observed)setTimeout(()=>{bindingObserved=true;Object.assign(this.task,{followUpAwaitingMonitor:false,followUpPending:{state:'observed'},monitorMessageKey:'new-message'});},15);
  return {ok:true};
 }};
 const context={desktop,runtime:{tasks:new Map([[task.id,task]]),save:async()=>{}},waitForWorkSubmission:AgentService.prototype.waitForWorkSubmission};
 return {context,task,observed:()=>bindingObserved};
}
test('owner continuation does not confirm the inherited old session when the new message was not observed',async()=>{
 const h=continuation();const result=await AgentService.prototype.continueWork.call(h.context,h.task,new AbortController().signal);
 assert.equal(result.ok,false);assert.equal(result.verified,undefined);assert(!h.context.desktop.task.outboundText.includes('不得操作通讯软件'));assert.equal(h.context.desktop.task.followUpPending.state,'sent');
});
test('owner continuation confirms only after the new round has an external message receipt',async()=>{
 const h=continuation({observed:true});const result=await AgentService.prototype.continueWork.call(h.context,h.task,new AbortController().signal);
 assert.equal(h.observed(),true);assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.sessionId,'bound-session');
});
test('initial, owner-continued and automatic work messages share a channel-independent boundary',()=>{
 const {makeWorkBuddyOutbound,WECHAT_RULE}=require('../src/main/desktop-service');
 const task={goal:'发布既有网页',criteria:'真实链接可访问',recipient:'文件传输助手',delivery:{channel:'wechat',recipient:'Alice'},associationMarker:'[workbunny:round-marker]'};
 for(const options of [undefined,{followUp:true}]){
  const text='发布既有网页；保留项目文件和访问条件',outbound=makeWorkBuddyOutbound(task,text,options);
  assert(outbound.startsWith(text));assert(outbound.includes(task.criteria));assert(outbound.endsWith(task.associationMarker));assert(!outbound.includes('不得操作通讯软件'));assert(!outbound.includes(WECHAT_RULE));assert(!/微信|文件传输助手|Alice/.test(outbound));
 }
 const quoted='请审查旧规则文本“微信操作只允许截图视觉识别与键盘鼠标。”';
 assert(makeWorkBuddyOutbound(task,quoted,{followUp:true}).startsWith(quoted),'necessary quoted output data is preserved rather than scrubbed by keywords');
});
test('new-round readiness excludes inherited, pending and stale observed receipts',()=>{
 const {workSubmissionConfirmed}=require('../src/main/workbuddy-observation');
 const base={handoffSent:true,sessionId:'same-session',monitorMessageKey:'old',followUpRound:0};assert(workSubmissionConfirmed(base));
 assert(!workSubmissionConfirmed({...base,continuationOf:{round:0}}));
 assert(!workSubmissionConfirmed({...base,followUpRound:1,followUpAwaitingMonitor:true}));
 assert(!workSubmissionConfirmed({...base,followUpPending:{state:'draft-unknown'}}));
 assert(!workSubmissionConfirmed({...base,followUpPending:{state:'sent'}}));
 assert(!workSubmissionConfirmed({...base,previousMonitorMessageKey:'old',followUpPending:{state:'observed'}}));
 assert(workSubmissionConfirmed({...base,followUpRound:1,continuationOf:{round:0},previousMonitorMessageKey:'old',monitorMessageKey:'new',followUpPending:{state:'observed'}}));
});
test('a pending new round is presented as checking submission even when an old job exists',async()=>{
 const {taskPresentation}=require('../src/main/task-presentation');
 const task={skill:'work.delegate',goal:'publish page',status:'waiting',state:{job:{jobId:'old'},workPhase:'submitting'}};
 assert.equal(taskPresentation(task).statusLabel,'核对交办结果');
 let verified=0;const physical={id:'new',target:'workbuddy',status:'review',sources:['owner-task'],handoffSent:true,sessionId:'same',followUpAwaitingMonitor:true,followUpPending:{state:'sent'},monitorSummary:'old reply'};
 const context={desktop:{task:physical},runtime:{save:async()=>{}},verify:async()=>{verified++;throw Error('must not verify old round');}};
 const result=await AgentService.prototype.workStatus.call(context,'new',{id:'owner-task',state:{}},new AbortController().signal);
 assert.equal(result.completed,false);assert.equal(verified,0);
});
test('read-only reconciliation requires the new-round record and never resumes or resends an unknown follow-up',async()=>{
 for(const observed of [false,true]){
  const physical={id:'new-operation',target:'workbuddy',status:'paused',handoffSent:true,sessionId:'same-session',monitorSessionId:'same-session',submitAttemptedAt:1,submittedAt:2,followUpRound:1,continuationOf:{round:0},followUpAwaitingMonitor:true,followUpPending:{state:'unknown'},previousMonitorMessageKey:'old',monitorMessageKey:null};
  const task={id:'owner-task',status:'needs_attention',state:{workOperationId:physical.id},scene:'life'},op={id:'operation-intent'};let resumed=0,confirmed=0;
  const desktop={task:physical,running:false,observeWorkBuddy:async()=>observed?{sessionId:'same-session',taskId:2,messageKey:'new',startedAt:2,updatedAt:3}:null,journal:async()=>{},resume:async()=>{resumed++;throw Error('must not resend');}};
  const context={desktop,workOperation:async()=>physical,waitForWorkSubmission:AgentService.prototype.waitForWorkSubmission,runtime:{tasks:new Map([[task.id,task]]),controllers:new Map(),save:async()=>{},canControl:()=>true,journal:{authorized:async()=>true},confirmReconciled:async(_id,_op,result)=>{confirmed++;return result;},publish(){},schedule(){}}};
  const result=await AgentService.prototype.reconcileWork.call(context,task,op);
  assert.equal(resumed,0);assert.equal(result.ok,observed);assert.equal(confirmed,observed?1:0);assert.equal(physical.followUpPending.state,observed?'observed':'unknown');
 }
});
test('automatic revision enters the same awaiting-submission phase as owner continuation',async()=>{
 const physical={id:'job',sources:['owner-task'],status:'review',handoffSent:true,sessionId:'session',monitorSummary:'prior actual result'};
 const task={id:'owner-task',skill:'work.delegate',goal:'complete page',status:'waiting',state:{job:{jobId:'job'}}};
 const context={learning:{reviewContext:async()=>({knowledge:[],sourceIds:[],availability:'fixture',isCurrent:async()=>true})},desktop:{task:physical,publicStatus:()=>({}),followUp:async()=>{physical.followUpPending={state:'sent'};physical.followUpAwaitingMonitor=true;return {ok:true,submission:'pending'};}},runtime:{save:async()=>{},journal:{authorized:async()=>true}},verify:async()=>({verdict:'revise',followUp:'补充真实网址',report:'缺少网址'})};
 const result=await AgentService.prototype.workStatus.call(context,'job',task,new AbortController().signal);
 assert.equal(result.completed,false);assert.equal(task.state.workPhase,'submitting');assert.equal(require('../src/main/task-presentation').taskPresentation(task).statusLabel,'核对交办结果');
});
test('restoration reopens an old false-confirmed continuation receipt without discarding provenance or sending again',async()=>{
 const physical={id:'physical-round',target:'workbuddy',status:'paused',handoffSent:true,sessionId:'old-session',monitorSessionId:'old-session',followUpAwaitingMonitor:true,followUpPending:{state:'sent'},sources:['task']};
 const receipt={ok:true,verified:true,jobId:physical.id,sessionId:'old-session'};
 const task={id:'task',skill:'work.delegate',status:'waiting',state:{job:{...receipt}},operations:{submit:{tool:'work.submit',effect:'write',status:'confirmed',result:{...receipt}}}};
 let saves=0;const context={runtime:{tasks:new Map([[task.id,task]]),save:async()=>{saves++;}},workOperation:async()=>physical};
 await AgentService.prototype.repairLegacyWorkReceipts.call(context);
 assert.equal(task.status,'needs_attention');assert.equal(task.operations.submit.status,'intent');assert.deepEqual(task.operations.submit.legacyReceipt,receipt);assert.equal(task.state.job,undefined);assert.equal(task.state.workOperationId,physical.id);assert.equal(task.state.workPhase,'submitting');assert.deepEqual(physical.sources,['task']);assert.equal(saves,1);
});
