'use strict';
const {randomUUID}=require('node:crypto');
const ended=new Set(['ended','stopped','preserved']);
const protectedApps=new Set(['com.tencent.xinWeChat','cn.haminn.workbunny']);
// Durable identities survive restart. Live closures are stronger ownership
// evidence, but neither a process name nor an old PID alone authorizes a kill.
class TaskResources{
 constructor({getTask,tasks,save,native,lease,handlers={},timeoutMs=30000}){Object.assign(this,{getTask,tasks,save,native,lease,handlers,timeoutMs});this.live=new Map();this.pending=new Map();this.recoveries=new Set();}
 key(taskId,id){return taskId+'#'+id;}
 async record(taskId,descriptor,cleanup){
  const task=this.getTask(taskId);if(!task)throw Error('资源所属任务已不可用');
  task.state.resources??={};const id=descriptor.id||randomUUID(),entry=task.state.resources[id]??={id,createdAt:Date.now(),phase:'starting'};
  const ownership=entry.ownership==='owned'&&descriptor.kind==='application'&&descriptor.ownership==='unknown'||entry.ownership==='owned'&&descriptor.ownership==='shared'&&entry.identity?.pid===descriptor.identity?.pid&&entry.identity?.launchDate===descriptor.identity?.launchDate?'owned':descriptor.ownership;
  Object.assign(entry,structuredClone(descriptor),{id,updatedAt:Date.now()},ownership?{ownership}:{});
  if(cleanup&&!ended.has(entry.phase))this.live.set(this.key(taskId,id),cleanup);
  if(ended.has(entry.phase)||descriptor.liveHandleEnded)this.live.delete(this.key(taskId,id));
  await this.save(task);return entry;
 }
 forTask(task,{signal,isCurrent=()=>this.getTask(task.id)===task&&!task.state.stopRequest}={}){
  return {identifyProcess:async pid=>(await this.native.request('taskProcessIdentity',{pid},3000)).identity,recoverApplication:bundleId=>this.recoverApplication(task,bundleId,{signal,isCurrent}),register:async(descriptor,cleanup)=>{
   if(signal?.aborted||!isCurrent())throw Object.assign(Error('任务已停止，未创建外部资源'),{dispatched:false});
   const entry=await this.record(task.id,descriptor,cleanup);
   if(signal?.aborted||!isCurrent())throw Object.assign(Error('任务已停止，未启动外部资源'),{dispatched:false});
   return {id:entry.id,update:async patch=>{
    const current=this.getTask(task.id);if(!current?.state.resources?.[entry.id])return;
    await this.record(task.id,{...patch,id:entry.id});
    // A late receipt is evidence only; a finished stop never starts another cleanup.
   }};
  }};
 }
 sharedApplication(taskId,entry){return [...this.tasks()].some(task=>task.id!==taskId&&task.status!=='stopped'&&Object.values(task.state.resources||{}).some(other=>other.kind==='application'&&!ended.has(other.phase)&&other.identity?.pid===entry.identity?.pid&&other.identity?.launchDate===entry.identity?.launchDate));}
 async withApplicationLease(owner,signal,run){
  let held=false,cancelled;const cancel=()=>{cancelled=Promise.resolve(this.native.cancel?.()).catch(()=>{});};
  try{await this.lease?.acquire(owner,signal);held=true;if(signal?.aborted)throw Error('任务已停止，未操作软件');signal?.addEventListener('abort',cancel,{once:true});return await run();}
  finally{signal?.removeEventListener('abort',cancel);await cancelled;if(held)this.lease?.release(owner);}
 }
 async recoverApplication(task,bundleId,options){
  if(this.recoveries.has(bundleId))return {ok:false,error:'这个软件正在恢复，保留原任务等待结果',dispatched:false};
  this.recoveries.add(bundleId);try{return await this.withApplicationLease('task-recovery:'+task.id,options.signal,()=>this.performRecovery(task,bundleId,options));}finally{this.recoveries.delete(bundleId);}
 }
 async performRecovery(task,bundleId,{signal,isCurrent}){
  const live=()=>!signal?.aborted&&isCurrent();let reason,receipt,changed=false;
  const step=async(phase,details={})=>{if(!live())throw Error('任务已停止，未继续软件恢复');task.state.recoveryLog??=[];task.state.recoveryLog.push({kind:'application',bundleId,phase,...details,at:Date.now()});task.state.recoveryLog=task.state.recoveryLog.slice(-60);await this.save(task);};
  try{
   if(!live())throw Error('任务已停止，未恢复软件');
   const health=await this.native.request('taskApplicationHealth',{bundleId},5000);
   await step('diagnosed',{responsive:health.responsive,reason:health.reason});
   if(!live())throw Error('任务已停止，未重启软件');
   if(health.responsive===true)return {ok:true,verified:true,recovered:false,reason:'软件已响应，继续原任务即可'};
   if(health.responsive!==false||health.evidence!=='two-bounded-interface-probes')throw Error(health.reason||'缺少明确卡死证据，未重启软件');
   const candidate=[...this.tasks()].flatMap(owner=>Object.values(owner.state.resources||{}).map(entry=>({owner,entry}))).find(({owner,entry})=>(owner.id===task.id||owner.status==='stopped')&&entry.kind==='application'&&entry.ownership==='owned'&&entry.identity?.pid===health.identity?.pid&&entry.identity?.launchDate===health.identity?.launchDate);
   if(!candidate||protectedApps.has(bundleId)||this.sharedApplication(task.id,candidate.entry))throw Error('软件由主人、其它任务或共享会话使用，缺少可独占重启的归属证据；已保留');
   if((task.state.recoveryLog||[]).filter(row=>row.bundleId===bundleId&&row.phase==='restart-intent').length>=2)throw Error('本任务对此软件的恢复次数已达上限，保留现场改用其它方法');
   await this.record(task.id,{id:'application:'+bundleId,kind:'application',label:bundleId,ownership:'owned',identity:health.identity,phase:'running',inheritedFrom:candidate.owner.id});
   if(!live())throw Error('任务已停止，未退出软件');
   await step('restart-intent',{identity:health.identity});changed=true;
   let stopped=await this.native.request('taskApplicationStop',{identity:health.identity},5000);await step('normal-exit',{verified:stopped.verified,reason:stopped.reason});
   if(!stopped.verified){
    if(this.sharedApplication(task.id,candidate.entry))throw Error('软件已被其它任务共享，未强制终止');
    stopped=await this.native.request('taskApplicationForceStop',{identity:health.identity},6500);await step('guarded-force-exit',{verified:stopped.verified,reason:stopped.reason});
    if(!stopped.verified)throw Error(stopped.reason||'无法核实无响应、专属归属或未保存数据，未强制终止');
   }
   if(!live())throw Error('任务已停止，未重新启动软件');
   const opened=await this.native.request('activate',{bundleId},8000);
   await this.record(task.id,{id:'application:'+bundleId,identity:opened.application,phase:'running',ownership:opened.launched===true?'owned':'shared'});
   if(!live())throw Error('任务已停止，重开结果不会继续执行');
   const after=await this.native.request('taskApplicationHealth',{bundleId},5000);
   if(!live())throw Error('任务已停止，未继续软件操作');
   if(after.responsive!==true)throw Error('重开后仍未取得可响应的真实证据');
   reason='已核对专属归属和无响应证据，经正常退出重开后确认软件响应';receipt={identity:after.identity,evidence:health.evidence};
  }catch(error){reason=error.message;}
  const current=this.getTask(task.id);if(current===task&&!task.state.stopRequest){task.state.recoveryLog??=[];task.state.recoveryLog.push({kind:'application',bundleId,verified:!!receipt,reason,at:Date.now()});task.state.recoveryLog=task.state.recoveryLog.slice(-30);await this.save(task);}
  return receipt?{ok:true,verified:true,recovered:true,receipt,reason}:{ok:false,verified:false,error:reason,...(!changed?{dispatched:false}:{})};
 }
 async perform(taskId,entry,signal){
  if(signal.aborted)return {verified:false,reason:'清理总时限已到，未继续操作外部资源'};
  if(entry.kind==='application'&&(entry.ownership==='shared'||protectedApps.has(entry.identity?.bundleId)||this.sharedApplication(taskId,entry)))return {verified:false,preserved:true,reason:'共享或原先已运行的软件已保留；未退出其它任务或主人的应用'};
  const live=this.live.get(this.key(taskId,entry.id));if(live)return live(signal,entry);
  if(entry.ownership!=='owned'||!entry.identity)return {verified:false,reason:'缺少可核验的专属执行句柄，未停止身份不明的资源'};
  if(this.handlers[entry.kind])return this.handlers[entry.kind](entry,signal);
  if(entry.kind==='process')return this.native.request('taskProcessStop',{identity:entry.identity},5000);
  if(entry.kind==='application')return this.withApplicationLease('task-cleanup:'+taskId+':'+entry.id,signal,()=>this.sharedApplication(taskId,entry)?{verified:false,preserved:true,reason:'软件已被其它任务共享，已保留'}:this.native.request('taskApplicationStop',{identity:entry.identity},5000));
  return {verified:false,reason:'此资源尚无可核验的停止接口'};
 }
 cleanupOne(taskId,id,{signal}={}){
  const key=this.key(taskId,id);if(this.pending.has(key))return this.pending.get(key);
  const work=(async()=>{
   let task=this.getTask(taskId),entry=task?.state.resources?.[id];if(!entry||ended.has(entry.phase)||entry.cleanupAttemptedAt)return entry;entry.cleanupAttemptedAt=Date.now();
   const identityBefore=JSON.stringify(entry.identity||null),controller=new AbortController();let timer;
   let abort;const timeout=new Promise(resolve=>{abort=()=>{controller.abort();resolve({verified:false,reason:'停止核对超时，未确认该资源已结束'});};timer=setTimeout(abort,this.timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
   let outcome;try{outcome=await Promise.race([Promise.resolve().then(()=>this.perform(taskId,structuredClone(entry),controller.signal)),timeout]);}catch(error){outcome={verified:false,reason:error.message};}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
   task=this.getTask(taskId);entry=task?.state.resources?.[id];if(!entry)return;
   if(JSON.stringify(entry.identity||null)!==identityBefore)outcome={verified:false,reason:'清理期间执行身份发生变化，未操作未确认的资源；结果已记录'};
   Object.assign(entry,{phase:outcome?.verified?'stopped':outcome?.preserved?'preserved':'unknown',verified:outcome?.verified===true,reason:outcome?.reason||(outcome?.verified?'已核实停止':'停止尚未确认'),checkedAt:Date.now()});
   if(ended.has(entry.phase))this.live.delete(key);
   task.state.cleanupLog??=[];task.state.cleanupLog.push({id,kind:entry.kind,label:entry.label||entry.kind,phase:entry.phase,verified:entry.verified,reason:entry.reason,at:entry.checkedAt});task.state.cleanupLog=task.state.cleanupLog.slice(-100);
   await this.save(task);return structuredClone(entry);
  })().finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;
 }
 async cleanup(taskId,options){
  const entries=Object.values(this.getTask(taskId)?.state.resources||{}),results=await Promise.all(entries.map(entry=>this.cleanupOne(taskId,entry.id,options)));
  return results.filter(entry=>entry&&!entry.verified&&!['ended','preserved'].includes(entry.phase)).map(entry=>(entry.label||entry.kind)+'：'+(entry.reason||'停止未确认'));
 }
}
module.exports={TaskResources,protectedApps};
