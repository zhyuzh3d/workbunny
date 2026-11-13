'use strict';
// Current effect facts are not a recency sample. Model calls and passive reads
// must never crowd a confirmed write or a real native input out of a judgment.
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
function withoutPixels(value){
 if(Array.isArray(value))return value.map(withoutPixels);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['preview','pngBase64','imageBase64','base64'].includes(key)).map(([key,item])=>[key,withoutPixels(item)]));
 if(typeof value==='string'&&/^data:image\/[^;,]+;base64,/u.test(value))return '[pixel attachment omitted]';
 return value;
}
function effectFacts(operations){
 return Object.entries(operations||{}).map(([id,op])=>({id,...op})).filter(op=>op.effect==='write'||require('./operation-ledger').hasInputEffects(op)).map(op=>({
  ...pick(op,['id','actionId','tool','effect','key','status','at','finishedAt','errorCode']),
  ...(op.error?{error:{message:String(op.error).slice(0,240),partial:String(op.error).length>240,retrieval:'original-task-operation-id'}}:{}),
  ...(op.inputOutcome?{inputOutcome:require('./boper-outcome').sanitize(op.inputOutcome)}:{}),
  ...(op.result?{resultFacts:{...pick(op.result,['ok','verified','outcomeUnknown']),...withoutPixels(pick(op.result,['receipt','deliveryAssessment','visualFeedback']))}}:{}),
  ...(op.effectReconciliation?{effectReconciliation:pick(op.effectReconciliation,['outcome','evidenceOperationIds','at','trust','meaning'])}:{})
 }));
}
function taskTiming(task,now=Date.now()){return {...pick(task,['createdAt','startedAt','updatedAt']),now};}
function conversationSources(task){
 if(!Object.keys(task.state?.conversations||{}).length&&!(task.inbox||[]).some(e=>e.type==='conversation.messages')&&!Object.values(task.actionRuns||{}).some(a=>a.eventType==='conversation.messages'))return null;
 const message=m=>pick(m,['key','sequence','origin','direction','kind','time','observedAt']);
 return {meaning:'visible-history是初次可见背景，observedAt为本次感知时间，不证明背景消息发生于本Task；screen来源的游标新项与conversation.messages事件保留原sequence/at；bunny记录不是独立对方回复。这些是可修订感知来源，不按时间硬判业务完成。',
  conversations:Object.values(task.state?.conversations||{}).slice(-8).map(state=>({subject:state.subject,ready:state.cursor?.ready===true,sequence:state.cursor?.sequence||0,recent:(state.cursor?.recent||[]).slice(-12).map(message)})),
  pendingEvents:(task.inbox||[]).filter(e=>e.type==='conversation.messages').slice(-8).map(e=>({...pick(e,['key','type','subjectKey','at']),messages:(e.messages||[]).slice(-12).map(message)})),
  eventActions:Object.values(task.actionRuns||{}).filter(a=>a.eventType==='conversation.messages').slice(-8).map(a=>pick(a,['id','eventKey','eventType','status','createdAt','startedAt','updatedAt']))};
}
function guiFailure(task,operationId){
 const current=task.operations?.[operationId],failure=task.state?.lastFailure;if(!current||!failure||task.state?.stopRequest||['stopped','stopping','cancelled'].includes(task.status)||Number.isFinite(failure.resolvedAt)||(failure.actionId||null)!==(current.actionId||null)||(failure.goalRevision||0)!==(task.state?.goalRevision||0)||(failure.controlRevision||0)!==(task.state?.controlRevision||0))return null;
 const previous=failure.operationId&&task.operations?.[failure.operationId],feedback=previous?.executionFeedback;
 const scoped=feedback&&feedback.taskId===task.id&&(feedback.actionId||null)===(current.actionId||null)&&(feedback.goalRevision||0)===(task.state?.goalRevision||0)&&(feedback.controlRevision||0)===(task.state?.controlRevision||0);
 if(feedback&&!scoped)return null;
 return {taskId:task.id,actionId:current.actionId||null,trust:'host-rejection-and-native-facts-not-business-verdict',failure:pick(failure,['code','message','at','operationId','unknown']),
  ...(previous?{previousOperation:pick(previous,['id','tool','status','at','finishedAt']),...(previous.inputOutcome?{inputOutcome:require('./boper-outcome').sanitize(previous.inputOutcome)}:{})}:{}),
  ...(scoped?{rejectedDecision:feedback.rejectedDecision,submissionFacts:feedback.submissionFacts}:{}),meaning:'具体失败说明此前判断或操作未被接受；不把错误码当作外部业务终局。结合原回执、当前画面与原目标换路，不能把旧画面或未派发操作当成本Task已完成。'};
}
module.exports={effectFacts,taskTiming,conversationSources,guiFailure};
