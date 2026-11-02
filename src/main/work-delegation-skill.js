'use strict';
const {fields}=require('./agent-contract');
function registerWorkTools(tools,{submit,status}){
 tools.register({name:'work.submit',description:'把主人正式工作交给WorkBuddy，确认真实绑定会话后返回回执；不在Bunny聊天中冒充交付。',effect:'write',capabilities:['work.delegate'],scope:a=>({application:a.application}),
  validate:v=>{fields(v,['application'],'工作委派');if(v.application!=='workbuddy')throw new Error('尚未支持此工作执行者');return v;},execute:(a,c)=>submit(c.task,c.signal)});
 tools.register({name:'work.status',description:'读取本任务已绑定的WorkBuddy实际进展，并在交付后核验结果。',effect:'read',capabilities:['work.read'],scope:a=>({application:a.application}),
  validate:v=>{fields(v,['application','jobId'],'工作进展');if(v.application!=='workbuddy'||typeof v.jobId!=='string')throw new Error('缺少已绑定工作ID');return v;},execute:(a,c)=>status(a.jobId,c.task,c.signal)});
}
const workDelegationSkill={id:'work.delegate',title:'工作委派',version:1,description:'委派WorkBuddy制作正式成果，持续跟进、核验并向主人回报。',
 tools:['work.submit','work.status'],capabilities:['work.delegate','work.read'],requiredCapabilities:['work.delegate','work.read'],
 validate:spec=>{if(spec.subjects.length!==1||spec.subjects[0].application!=='workbuddy')throw new Error('请指定WorkBuddy作为工作执行者');if(spec.goal.length>3000||spec.criteria.length>2000)throw new Error('工作交办请控制在3000字、验收条件2000字以内');},
 async run({task,call,report,now}){
  if(!task.state.job){task.state.job=await call({tool:'work.submit',key:'submit-work',args:{application:'workbuddy'}});}
  const result=await call({tool:'work.status',key:'work-status:'+task.counters.wakes,args:{application:'workbuddy',jobId:task.state.job.jobId}});
  if(result.completed&&result.verified){await report(result.report||'WorkBuddy任务已完成并通过核验','work-completed');return {status:'completed',note:result.report||'已完成并核验',state:task.state};}
  if(result.needsAttention){await report(result.report||'WorkBuddy任务需要处理','work-attention');return {status:'needs_attention',note:result.report||'工作需要核对',state:task.state};}
  return {status:'waiting',note:result.report||'WorkBuddy正在执行，等待真实进展',state:task.state,nextCheckAt:now+task.schedule.intervalSeconds*1000};
 }
};
module.exports={registerWorkTools,workDelegationSkill};
