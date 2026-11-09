'use strict';
// Individual actions have their own cancellation signal and declared policy.
// Other actions and unrelated events never cancel them implicitly.
class ActionLifecycle {
 constructor(){this.active=new Map();}
 start({id,taskId,scope,eventKey,policy='independent',parentSignal,progress,recovery,onPhase=async()=>{}}){
  if(this.active.has(id))throw Error('同一动作正在执行');
  const controller=new AbortController(),entry={id,taskId,scope,eventKey,policy,controller,phase:'preparing',superseded:false,onPhase};
  const cancel=()=>controller.abort(parentSignal?.reason);parentSignal?.addEventListener('abort',cancel,{once:true});if(parentSignal?.aborted)cancel();
  this.active.set(id,entry);
  const assertCurrent=()=>{if(entry.superseded&&entry.phase!=='committed')throw Object.assign(Error('同一目标有新事件，已保留原事件并重新规划'),{code:'E_ACTION_SUPERSEDED',dispatched:false});};
  return {
   progress,
   recovery,
   signal:controller.signal,
   get superseded(){return entry.superseded;},
   get phase(){return entry.phase;},
   get policy(){return entry.policy;},
   assertCurrent,
   protect:async()=>{assertCurrent();entry.phase='protected';await entry.onPhase(entry.phase);assertCurrent();},
   retryBeforeEffect:async()=>{assertCurrent();if(entry.phase!=='protected')throw Error('只有确认未发令的保护阶段可重新准备');entry.phase='preparing';await entry.onPhase(entry.phase);assertCurrent();},
   commit:async()=>{assertCurrent();entry.phase='committed';await entry.onPhase(entry.phase);},
   // A narrative assessment cannot reopen a committed write. Only an actual
   // before-effect rejection can use retryBeforeEffect; external receipts are
   // reconciled by the operation ledger without replaying the action.
   finish:()=>{parentSignal?.removeEventListener('abort',cancel);if(this.active.get(id)===entry)this.active.delete(id);}
  };
 }
 supersede({taskId,scope,eventKey}){
  if(!taskId)return 0;let count=0;for(const entry of this.active.values()){
   if(entry.taskId!==taskId||entry.policy!=='newer-event'||!scope||entry.scope!==scope||entry.eventKey===eventKey)continue;
   entry.superseded=true;count++;
   // Before any draft or side effect, cancellation is known to be safe. Once
   // protected, the executor stops at the next safe checkpoint; committed
   // operations finish or reconcile and are never replayed.
   if(entry.phase==='preparing')entry.controller.abort(Object.assign(Error('同一目标收到新事件'),{code:'E_ACTION_SUPERSEDED'}));
  }return count;
 }
}
module.exports={ActionLifecycle};
