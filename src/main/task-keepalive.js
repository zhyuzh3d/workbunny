'use strict';

// Called by the existing scheduler, never by an additional timer. This is
// liveness, not business-progress detection or permission to replay effects.
const REMINDER='请继续推进当前任务或动作。结合目标、已有结果和已耗时间，判断现在最有价值的下一步并采取行动，避免无明确原因的空等和重复检查。遇到困难时，积极分析现有信息，按需补充关键观察、查阅相关经验和可用工具，灵活调整策略或尝试其它方法，不被旧思路困住。确需等待时，明确等待条件和下次检查时机；持续核对实际进展，努力完成目标。经过判断确实需要主人帮助时，再说明具体缺口。';
const INACTIVE=new Set(['queued','paused','stopping','stopped','completed','expired','needs_attention','waiting_permission']);
class TaskKeepalive{
 constructor({clock=Date.now,remind,idleMs=60000}={}){Object.assign(this,{clock,remind,idleMs});this.pending=new Map();this.closed=false;}
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
  const runs = Object.values(task.actionRuns).filter(run => run.status === 'waiting' &&
    (!run.eventKey || task.inbox.some(event => event.key === run.eventKey)));
  const passive = ['conversation.manage', 'screen.watch'].includes(task.skill) && !task.inbox.length;
  const workers = [...(group?.workers.values() || [])];
  const pendingEffects = Object.values(task.operations).filter(op => op.effect === 'write' && op.status === 'intent');
  for (const run of runs.length ? runs : passive ? [] : [null]) {
    if (run ? workers.some(worker => worker.eventKey === (run.eventKey || undefined)) : workers.length) continue;
    const key = this.key(task, run);
    if (this.pending.has(key) || pendingEffects.some(op => !run || op.actionId === run.id)) continue;
    const state = this.state(task, run);
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
     const decision=await this.remind({task,run,event,signal:controller.signal,reminder:REMINDER,idleMs:now-lastActivityAt});
     if(controller.signal.aborted||this.closed||!runtime.current(task,token,true)||INACTIVE.has(task.status)||state.lastActivityAt!==lastActivityAt)return;
     const action=decision?.action||'continue',guidance={source:'keepalive',action,at:this.clock(),nextStep:decision?.nextStep||REMINDER,actionId:run?.id||null};
     if(run)run.recovery=guidance;else task.state.keepaliveGuidance=guidance;
     // The same planning context consumes this advice. No tool is executed here.
     task.state.recoveryGuidance=guidance;state.lastActivityAt=this.clock();
     if(action==='wait'&&decision.waitFor&&Number.isFinite(decision.waitMs)&&decision.waitMs>0){state.wait={reason:decision.waitFor,until:this.clock()+Math.min(3600000,decision.waitMs)};task.nextCheckAt=state.wait.until;}
     else {state.wait=null;task.nextCheckAt=this.clock();}
     if(action==='ask_owner'){
      if(run){run.status='needs_attention';run.note=guidance.nextStep;}
      task.status='needs_attention';task.note=guidance.nextStep;
      await runtime.report({taskId:task.id,eventId:'keepalive:'+key+':'+now,text:guidance.nextStep,sources:[task.id],scene:task.scene,domain:task.domain,visibilityFloor:task.visibilityFloor,epoch:task.privacyEpoch});
     }
     await runtime.save(task);
    })().catch(async error=>{
     if(controller.signal.aborted||this.closed||!runtime.current(task,token,true)||INACTIVE.has(task.status))return;
     state.lastActivityAt=this.clock();state.lastError=String(error.code||error.name||'E_KEEPALIVE').slice(0,80);await runtime.save(task).catch(()=>{});
    }).finally(()=>{if(this.pending.get(key)===entry)this.pending.delete(key);runtime.schedule();});
    entry.work=work;
   }
  }
 }
 close(){this.closed=true;this.cancel();}
}
module.exports={TaskKeepalive,REMINDER};
