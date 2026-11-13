'use strict';
const recovery=require('./action-recovery');
const {createBoundedWait}=require('./bounded-wait');
const {hasUncertainEffect}=require('./operation-ledger');

// Called by the existing scheduler, never by an additional timer. This is
// liveness, not business-progress detection or permission to replay effects.
const REMINDER='请继续推进当前任务或动作。结合目标、已有结果和已耗时间，判断现在最有价值的下一步并采取行动，避免无明确原因的空等和重复检查。遇到困难时，积极分析现有信息，按需补充关键观察、查阅相关经验和可用工具，灵活调整策略或尝试其它方法，不被旧思路困住。确需等待时，明确等待条件和下次检查时机；持续核对实际进展，努力完成目标。经过判断确实需要主人帮助时，再说明具体缺口。';
const INACTIVE=new Set(['queued','paused','stopping','stopped','completed','expired','needs_attention','waiting_permission']);
class TaskKeepalive{
 constructor({clock=Date.now,remind,idleMs=60000,timeoutMs=12000}={}){Object.assign(this,{clock,remind,idleMs,timeoutMs});this.pending=new Map();this.closed=false;}
 key(task,run){return task.id+':'+(run?.id||'task');}
 state(task,run){const state=run?(run.keepalive??={}):(task.state.keepalive??={});if(!Number.isFinite(state.lastActivityAt))state.lastActivityAt=this.clock();return state;}
 touch(task,run,waiting){
  const state=this.state(task,run);state.lastActivityAt=this.clock();
  if(waiting)state.wait=waiting.waitReason&&Number.isFinite(waiting.nextCheckAt)?{reason:waiting.waitReason,until:waiting.nextCheckAt}:null;
 }
 cancel(taskId){for(const value of this.pending.values())if(!taskId||value.taskId===taskId)value.controller.abort();}
 *candidates(runtime, task, now) {
  if (this.closed || !this.remind || INACTIVE.has(task.status) || task.expiresAt && task.expiresAt <= now ||
      !runtime.current(task, runtime.tokens.get(task.id), true)) return;
  const group = runtime.actionGroups.get(task.id);
  if (group?.parent?.signal.aborted || !group && runtime.controllers?.has(task.id)) return;
  const allRuns = Object.values(task.actionRuns), runs = allRuns.filter(run => run.subscription !== true && run.status === 'waiting' &&
    (!run.eventKey || task.inbox.some(event => event.key === run.eventKey)));
  const passive = !task.inbox.length && (['conversation.manage', 'screen.watch'].includes(task.skill) || allRuns.some(run => run.subscription === true));
  const workers = [...(group?.workers.values() || [])];
  const pendingEffects = Object.values(task.operations).filter(hasUncertainEffect);
  for (const run of runs.length ? runs : passive ? [] : [null]) {
    if (run ? workers.some(worker => worker.eventKey === (run.eventKey || undefined)) : workers.length) continue;
    if(recovery.held(run||task.state)||runtime.mainReviews?.active?.taskId===task.id)continue;
    const key = this.key(task, run);
    if (this.pending.has(key) || pendingEffects.some(op => !run || op.actionId === run.id)) continue;
    const state = this.state(task, run);
    if (state.wait?.reason === 'timer' || run?.progress?.waitReason === 'timer') continue;
    if (run?.goalAction && run.after && require('./goal-actions').selected(task, now).id !== run.id) continue;
    yield { run, state, key, at: Math.max(state.lastActivityAt + this.idleMs, state.wait?.until || 0) };
  }
 }
 nextWake(runtime, task, now) {
  let next = Infinity;
  for (const item of this.candidates(runtime, task, now)) next = Math.min(next, item.at);
  return next;
 }
 inspect(runtime){
  if(this.closed||!this.remind||runtime.closed||!runtime.ready())return;
  const now = this.clock();
  for(const task of runtime.tasks.values()){
   for(const { run, state, key, at } of this.candidates(runtime, task, now)){
    if (now < at) continue;
    const controller=new AbortController(),token=runtime.tokens.get(task.id),lastActivityAt=state.lastActivityAt;
    const entry={controller,taskId:task.id};this.pending.set(key,entry);
    state.lastReminderAt=now;state.reminders=(state.reminders||0)+1;
    const work=(async()=>{
     const event=run?.eventKey?task.inbox.find(e=>e.key===run.eventKey):null;
     const wait=createBoundedWait({signal:controller.signal,timeoutMs:this.timeoutMs,code:'E_KEEPALIVE_TIMEOUT',message:'持续思考判断达到时限'});
     let decision;try{decision=await wait.run(signal=>this.remind({task,run,event,signal,reminder:require('./action-progress').GUIDANCE+REMINDER,idleMs:now-lastActivityAt}));}finally{wait.close();}
     if(controller.signal.aborted||this.closed||!runtime.current(task,token,true)||INACTIVE.has(task.status)||state.lastActivityAt!==lastActivityAt)return;
     await this.applyDecision(runtime,task,run,state,key,now,decision);
    })().catch(async error=>{
     if(controller.signal.aborted||this.closed||!runtime.current(task,token,true)||INACTIVE.has(task.status)||state.lastActivityAt!==lastActivityAt)return;
     if(error.code==='E_MODEL_BUSY'){state.lastActivityAt=this.clock();state.wait={reason:'model-capacity',until:this.clock()+15000};await runtime.save(task).catch(()=>{});return;}
     state.lastError=String(error.code||error.name||'E_KEEPALIVE').slice(0,80);
     await this.applyDecision(runtime,task,run,state,key,now,{source:'local'},'E_KEEPALIVE_TIMEOUT').catch(()=>{});
    }).finally(()=>{if(this.pending.get(key)===entry)this.pending.delete(key);runtime.schedule();});
    entry.work=work;
   }
  }
 }
 async applyDecision(runtime,task,run,state,key,now,decision,code='E_IDLE'){
     if(decision?.selfSuspension&&runtime.mainReviews?.request(task,run,{reason:'self-suspended',selfSuspension:decision.selfSuspension,assessment:decision.assessment})){await runtime.save(task);return;}
     const owner=run||task.state,episode=recovery.begin(owner,{progress:run?.progress?{state:run.progress}:null,now:this.clock(),code,policy:runtime.recoveryPolicy});
     const chosen=recovery.decide(episode,decision,{now:this.clock(),policy:runtime.recoveryPolicy});
     const action=chosen.action,guidance={...chosen,source:'keepalive',actionId:run?.id||null};
     if(run)run.recovery=guidance;else task.state.keepaliveGuidance=guidance;
     // The same planning context consumes this advice. No tool is executed here.
     task.state.recoveryGuidance=guidance;state.lastActivityAt=this.clock();
     if(action==='wait'){state.wait={reason:chosen.waitFor,until:chosen.nextCheckAt};task.nextCheckAt=state.wait.until;}
     else {state.wait=null;task.nextCheckAt=this.clock();}
     if(action==='ask_owner'){
      if(runtime.mainReviews?.request(task,run,{reason:'idle-budget'})){await runtime.save(task);return;}
      const note='持续思考的自动恢复预算已到，尚未取得足够的多角度验证，不能认定真实障碍或永久阻塞；已保留原目标和回执，等待新证据或协助后重新评估。';
      if(run){run.status='needs_attention';run.note=note;}
      task.status='needs_attention';task.note=note;
      await runtime.report({taskId:task.id,eventId:'keepalive:'+key+':'+now,text:note,sources:[task.id],scene:task.scene,domain:task.domain,visibilityFloor:task.visibilityFloor,epoch:task.privacyEpoch});
     }
     await runtime.save(task);
 }
 close(){this.closed=true;this.cancel();}
}
module.exports={TaskKeepalive,REMINDER};
