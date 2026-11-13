'use strict';
// Local owner controls share the UI's task services. They never enumerate or
// read private tasks and never create a second task admission/execution path.
const fail=(code,message)=>Object.assign(Error(message),{code});
const idValid=id=>typeof id==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/u.test(id);
function createLocalTaskControl({getAgent,getMemory,getScene,runControl=(_operation,_id,execute)=>execute()}={}){
 const ready=signal=>{const memory=getMemory(),agent=getAgent();if(signal?.aborted)throw fail('E_LOCAL_CANCELLED','任务控制已取消');if(getScene()!=='life')throw fail('E_LOCAL_SCENE','任务开发控制仅允许生活场景');if(!memory?.ready||!agent?.runtime)throw fail('E_LOCAL_UNAVAILABLE','任务服务或资料尚未就绪');return {memory,agent,generation:memory.generation};};
 const target=(id,signal)=>{if(!idValid(id))throw fail('E_LOCAL_PARAMS','需要明确任务ID');const context=ready(signal),task=context.agent.runtime.tasks.get(id);if(!task||task.id!==id||task.scene!=='life'||task.domain!=='life'||task.visibilityFloor!==1)throw fail('E_LOCAL_TASK_SCOPE','指定记录不是允许的生活任务');return {...context,task};};
 return {
  list({since,limit=20},{signal}={}){
   if(!Number.isSafeInteger(since)||since<0||!Number.isSafeInteger(limit)||limit<1||limit>20)throw fail('E_LOCAL_PARAMS','需要起始时间与1至20条的数量');
   const {agent}=ready(signal),rows=[];
   for(const task of agent.runtime.tasks.values()){
    if(task.scene!=='life'||task.domain!=='life'||task.visibilityFloor!==1||!Number.isFinite(task.createdAt)||task.createdAt<since||!idValid(task.id))continue;
    rows.push({id:task.id,scene:'life',skill:task.skill,status:task.status,createdAt:task.createdAt,updatedAt:task.updatedAt});
   }
   rows.sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
   return {ok:true,tasks:rows.slice(0,limit),truncated:rows.length>limit};
  },
  status({id},{signal}={}){
   const {task}=target(id,signal),operations=Object.values(task.operations||{});
   return {ok:true,id,scene:'life',skill:task.skill,status:task.status,updatedAt:task.updatedAt,counters:task.counters,
    actions:Object.values(task.actionRuns||{}).map(a=>({id:a.id,status:a.status,activePhase:a.activePhase,eventType:a.eventType,attempts:a.attempts})),
    operationCount:operations.length,inboxCount:task.inbox?.length||0,lastCheckedAt:task.state?.lastCheckedAt,
    lastFailureCode:task.state?.lastFailure?.code||null,pendingInputCount:operations.filter(op=>require('./operation-ledger').hasUncertainEffect(op)).length};
  },
  async control({id,operation},{signal}={}){
   const {agent}=target(id,signal);if(!['pause','resume','stop','resolve','check','upgrade'].includes(operation))throw fail('E_LOCAL_PARAMS','任务控制操作无效');
   return runControl(operation,id,async()=>{
    target(id,signal);
    if(operation==='upgrade'){if(typeof agent.runtime.upgradeGoal!=='function')throw fail('E_LOCAL_UNAVAILABLE','通用目标编排尚未就绪');return agent.runtime.upgradeGoal(id,{signal});}
    if(operation==='resolve')return agent.resolveAttention(id);
    if(operation==='check')return agent.reconcile(id);
    return agent.control(operation,id,{signal});
   });
  },
  async effectReview({id,operationId,outcome,evidenceOperationIds,basis,reviewedInputKinds,sourceRefs},{signal}={}){
   const {agent}=target(id,signal);
   if(typeof agent.runtime.reconcileEffect!=='function')throw fail('E_LOCAL_UNAVAILABLE','操作效果核对尚未就绪');
   return agent.runtime.reconcileEffect(id,{operationId,outcome,evidenceOperationIds,basis,at:Date.now()},{signal,ownerReviewed:true,reviewedInputKinds,sourceRefs});
  },
  async command({text},{signal}={}){
   if(typeof text!=='string'||!text.trim()||text.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))throw fail('E_LOCAL_PARAMS','需要1至12000字的明确交办');
   const context=ready(signal),source=await context.memory.addMessage('user',text.trim(),{scene:'life',characterId:'owner',channel:'dialogue',inputSource:'text'});
   const current=ready(signal);if(current.memory!==context.memory||current.agent!==context.agent||current.generation!==context.generation)throw fail('E_LOCAL_STALE','资料已变化，未创建任务');
   return context.agent.command(text.trim(),{role:'owner',verified:true,channel:'dialogue',originSourceId:source.id,sources:[source.id],scene:'life'}, {signal,isCurrent:()=>getScene()==='life'&&getMemory()===context.memory&&context.memory.ready&&context.memory.generation===context.generation});
  },
 };
}
module.exports={createLocalTaskControl};
