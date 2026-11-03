'use strict';
const {fields}=require('./agent-contract');
function registerWorkTools(tools,{submit,status,deliver}){
 tools.register({name:'work.submit',description:'把主人正式工作交给WorkBuddy，确认真实绑定会话后返回回执；不在Bunny聊天中冒充交付。',effect:'write',capabilities:['work.delegate'],scope:a=>({application:a.application}),
  validate:v=>{fields(v,['application','goal','criteria','context','workContext'],'工作委派');for(const key of ['goal','criteria','context'])if(v[key]!==undefined&&(typeof v[key]!=='string'||v[key].length>(key==='context'?12000:3000)))throw Error('工作步骤内容不合法');if(v.workContext!==undefined)require('./agent-contract').taskSpec({skill:'work.delegate',goal:'scope',subjects:[{application:'workbuddy'}],workContext:v.workContext});if(v.application!=='workbuddy')throw new Error('尚未支持此工作执行者');return v;},execute:(a,c)=>submit(c.task,c.signal,a)});
 tools.register({name:'work.status',description:'读取本任务已绑定的WorkBuddy实际进展，并在交付后核验结果。',effect:'read',capabilities:['work.read'],scope:a=>({application:a.application}),
  validate:v=>{fields(v,['application','jobId'],'工作进展');if(v.application!=='workbuddy'||typeof v.jobId!=='string')throw new Error('缺少已绑定工作ID');return v;},execute:(a,c)=>status(a.jobId,c.task,c.signal)});

}
const workDelegationSkill={id:'work.delegate',title:'工作委派',version:1,subjectApplications:['workbuddy'],description:'委派WorkBuddy制作正式成果，持续跟进、核验并向主人回报。',
 parameters:{sourceTaskId:'程序绑定原任务时使用；对话中的续办统一用kind=update和原任务id，不在这里另建工作。独立新工作parameters为空；制作内容放task.workRequest，工作位置放task.workContext，交付放task.delivery。'},
 tools:['work.submit','work.status','result.deliver','result.attach'],capabilities:['work.delegate','work.read','conversation.send','screen.input'],requiredCapabilities:['work.delegate','work.read'],
 capabilitiesFor:spec=>['work.delegate','work.read',...(spec.delivery?.channel==='wechat'?['conversation.send','screen.input']:[])],
 validate:spec=>{fields(spec.parameters,['sourceTaskId'],'工作参数');if(spec.parameters.sourceTaskId!==undefined&&typeof spec.parameters.sourceTaskId!=='string')throw Error('原任务ID无效');if(spec.subjects.length!==1||spec.subjects[0].application!=='workbuddy')throw new Error('请指定WorkBuddy作为工作执行者');if(spec.goal.length>3000||spec.criteria.length>2000)throw new Error('工作交办请控制在3000字、验收条件2000字以内');},
 async run({task,call,report,checkpoint,now}){
  if(!task.state.job){task.state.job=await call({tool:'work.submit',key:'submit-work',args:{application:'workbuddy'}});}
  const result=task.state.result?{completed:true,verified:true,report:task.state.result.summary,result:task.state.result}:await call({tool:'work.status',key:'work-status:'+task.counters.wakes,args:{application:'workbuddy',jobId:task.state.job.jobId}});
  if(result.completed&&result.verified){
   task.state.result=result.result||{schema:'bunny.result/v1',revision:1,summary:result.report||'工作已完成，结果已保存。'};
   await require('./result-delivery').deliverResult({task,call,checkpoint,report});
   return {status:'completed',note:task.delivery?.channel==='wechat'?'结果已通过微信发送':task.state.result.summary,state:task.state};
  }
  if(result.needsAttention){await report(result.report||'WorkBuddy任务需要处理','work-attention');return {status:'needs_attention',note:result.report||'工作需要核对',state:task.state};}
  return {status:'waiting',note:result.report||'WorkBuddy正在执行，等待真实进展',state:task.state,nextCheckAt:now+task.schedule.intervalSeconds*1000};
 }
};
module.exports={registerWorkTools,workDelegationSkill};
