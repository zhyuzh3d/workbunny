'use strict';

const { createHash } = require('node:crypto');
const { clone } = require('./agent-contract');
const { ActionLifecycle } = require('./action-lifecycle');
const { ActionProgress } = require('./action-progress');
const { hasNewInput } = require('./conversation-cursor');
const diagnostics = require('./operation-diagnostics');
const inputOutcomes=require('./boper-outcome');
const effectReview=require('./effect-review');

const hash = value => createHash('sha256').update(value).digest('hex');
const beforeDispatch = (message, code) => Object.assign(new Error(message), { dispatched: false, code });
const hasInputEffects = operation => inputOutcomes.hasEffects(operation?.inputOutcome);
const replayProtected = operation => operation?.effect === 'write' || hasInputEffects(operation);
const hasUncertainEffect = operation => replayProtected(operation) && ['intent', 'uncertain', 'unknown'].includes(operation?.status) &&
  !(operation.effect === 'read' && operation.effectReconciliation?.navigationOnly === true && ['applied', 'not_applied'].includes(operation.effectReconciliation.outcome));
const hasBlockingEffect=(task,operation)=>hasUncertainEffect(operation)&&!effectReview.accepted(task,operation);
function reconcileEffect(task, { operationId, outcome, evidenceOperationIds, basis, at = Date.now() } = {}, { ownerReviewed = false, reviewedInputKinds, sourceRefs = [] } = {}) {
  const operation = task?.operations?.[operationId], reject = message => { throw beforeDispatch(message, 'E_EFFECT_RECONCILIATION'); };
  if (!operation || !['applied', 'not_applied', 'unresolved'].includes(outcome) || typeof basis !== 'string' || !basis.trim() || basis.length > 2000 || !Number.isFinite(at)) reject('效果核对缺少原操作、明确判断或可回查依据');
  if (!Array.isArray(evidenceOperationIds) || !evidenceOperationIds.length || evidenceOperationIds.length > 8) reject('效果核对需要本任务的新鲜只读画面');
  const evidence = evidenceOperationIds.map(id => task.operations[id]);
  if (evidence.some(op => !op || op.id === operation.id || op.effect !== 'read' || op.kind === 'model' || op.status !== 'confirmed' || hasInputEffects(op) ||
      !(op.observation?.frameId || op.observation?.observationId || op.result?.frameId || op.result?.observationId) || !Number.isFinite(op.finishedAt) || op.finishedAt <= (operation.at || operation.createdAt || 0) || op.finishedAt > at || at - op.finishedAt > 60000)) reject('核对来源必须是原输入之后、60秒内完成且不含HID的本任务画面观察');
  const native = operation.inputOutcome;
  let kinds = native?.inputKinds, complete = native?.inputKindsComplete === true;
  if (!complete && ownerReviewed === true && Array.isArray(reviewedInputKinds) && reviewedInputKinds.length <= 8 && Array.isArray(sourceRefs) && sourceRefs.length > 0 && sourceRefs.length <= 8 && sourceRefs.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
    // An authenticated local owner may supply reviewed original native refs
    // for legacy receipts. Known dangerous kinds can never be overwritten.
    kinds = [...new Set([...(kinds || []), ...reviewedInputKinds])]; complete = true;
  }
  const navigationOnly = operation.effect === 'read' && hasInputEffects(operation) && complete && Array.isArray(kinds) && kinds.length > 0 && kinds.every(k => ['move', 'click', 'scroll'].includes(k)) && native.clipboardChanged !== true;
  if (outcome !== 'unresolved' && !navigationOnly) reject('业务写入、文字/按键/粘贴或种类未明的输入效果不能由导航核对解除');
  const review = { outcome, navigationOnly, basis, evidenceOperationIds: [...new Set(evidenceOperationIds)], at, trust: ownerReviewed ? 'owner-reviewed' : 'bunny-assessment',
    meaning: 'navigation-state-reviewed-not-proof-of-no-side-effects', ...(ownerReviewed ? { reviewedInputKinds: kinds, sourceRefs: sourceRefs.slice(0, 8) } : {}) };
  operation.effectReconciliation = review; operation.effectReconciliationHistory = [...(operation.effectReconciliationHistory || []), review].slice(-8);
  return clone(review);
}
function reconcileNavigationOnCompletion(task,{at=Date.now(),basis='任务脑依据后发的当前观察自判目标已达到'}={}){
 for(const op of Object.values(task.operations||{})){
  if(!hasUncertainEffect(op)||op.effect!=='read')continue;
  const evidence=Object.values(task.operations).filter(e=>e!==op&&e.effect==='read'&&e.kind!=='model'&&e.status==='confirmed'&&!hasInputEffects(e)&&(e.observation?.frameId||e.observation?.observationId||e.result?.frameId||e.result?.observationId)&&e.finishedAt>op.at&&e.finishedAt<=at&&at-e.finishedAt<=60000).slice(-8).map(e=>e.id);
  if(evidence.length)try{
   reconcileEffect(task,{operationId:op.id,outcome:'applied',basis,evidenceOperationIds:evidence,at});
   const run=task.actionRuns?.[op.actionId];
   if(run&&!Object.values(task.operations).some(entry=>entry.actionId===run.id&&hasBlockingEffect(task,entry))){run.status='completed';run.reconciliationReason='task-assessed-navigation-complete';run.updatedAt=at;}
  }catch{}
 }
 // A later observation can have been marked blocked only because an older
 // navigation effect was pending. Whole-Task done now evaluates that state;
 // do not leave the successful observer itself as another permanent barrier.
 for(const run of Object.values(task.actionRuns||{}))if(run.status==='needs_attention'&&(run.failureCode==='E_SUBMISSION_UNCERTAIN'||task.state?.lastFailure?.actionId===run.id&&task.state.lastFailure.code==='E_SUBMISSION_UNCERTAIN')&&!Object.values(task.operations).some(op=>op.actionId===run.id&&hasBlockingEffect(task,op))){
  run.status='completed';run.reconciliationReason='task-assessed-after-fresh-observation';run.updatedAt=at;
  if(task.state.lastFailure?.actionId===run.id){task.state.lastFailure.resolvedAt=at;task.state.lastFailure.resolution='task-assessed-current-effects';}
 }
}
// A wrapper may report the same native receipt already captured by ALS. Merge
// monotonic facts without counting the identical submitted reports twice.
function retainOutcome(operation, value) {
  const next = inputOutcomes.sanitize(value); if (!next) return;
  const previous = operation.inputOutcome, merged = inputOutcomes.merge(previous, next);
  for (const key of ['reportsSubmitted', 'reportsAttempted']) if (previous?.[key] !== undefined || next[key] !== undefined) merged[key] = Math.max(previous?.[key] || 0, next[key] || 0);
  operation.inputOutcome = merged;
}
function receiptResult(value) {
  if (!value || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return { mediaOmitted: true };
  if (Array.isArray(value)) return value.map(receiptResult);
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !['preview', 'pngBase64', 'screenshot', 'image_url'].includes(key) && !(typeof item === 'string' && /^data:[^,]{0,150};base64,/iu.test(item))).map(([key, item]) => [key, receiptResult(item)]));
}

class OperationLedger {
  constructor({ tools, authorize, save, clock }) {
    Object.assign(this, { tools, authorize, save, clock });
    this.lifecycle = new ActionLifecycle();
    this.inFlight = new Map();
  }

  supersede(task, event) {
    if (event.type === 'conversation.messages' && typeof event.subjectKey === 'string' && hasNewInput(event)) {
      this.lifecycle.supersede({ taskId: task.id, scope: task.id + ':' + task.scene + ':' + event.subjectKey, eventKey: event.key });
    }
  }

  isRunning(task, operation) {
    return this.inFlight.has(hash(task.id + '\0' + operation.key));
  }

  retire(task) {
    // A detached caller has its own task object. Release local reservations,
    // while durable write intents remain uncertain in the replacement task.
    // Identity checks in finally keep a late old completion from releasing a
    // newer reservation with the same logical key.
    for(const [id,entry] of this.inFlight)if(entry.task===task)this.inFlight.delete(id);
    for(const [id,entry] of this.lifecycle.active)if(entry.taskId===task.id){entry.controller.abort();this.lifecycle.active.delete(id);}
  }

  async execute({ task, call, signal, actionId, isCurrent }) {
    if (!isCurrent()) throw beforeDispatch('任务已停止或权限已变化');
    let checked;
    try { checked = this.tools.check(call.tool, call.args, task); }
    catch (error) { error.dispatched = false; throw error; }
    if (typeof call.key !== 'string' || !call.key || call.key.length > 200) throw beforeDispatch('工具调用缺少稳定操作标识');

    const logicalId = hash(task.id + '\0' + call.key);
    if (this.inFlight.has(logicalId)) throw beforeDispatch('同一操作正在等待回执', 'E_OPERATION_BUSY');
    // Reserve the logical key before any await, including authorization and
    // recovery. All attempts for this key share the reservation.
    const reservation={task};this.inFlight.set(logicalId,reservation);
    try {
      return await diagnostics.scope({taskId:task.id,actionId,operationId:logicalId,tool:checked.tool.name,mode:require('./interaction-policy').channelForTool(checked.tool.name)},()=>this.attempt(logicalId, checked, { task, call, signal, actionId, isCurrent }));
    } finally {
      if(this.inFlight.get(logicalId)===reservation)this.inFlight.delete(logicalId);
    }
  }

  async attempt(id, { tool, input }, { task, call, signal, actionId, isCurrent }) {
    const argsHash = hash(JSON.stringify(input));
    let prior = task.operations[id], replaced;
    while (prior?.replacedBy && task.operations[prior.replacedBy]) {
      id = prior.replacedBy;
      prior = task.operations[id];
    }
    if (prior && (prior.tool !== tool.name || prior.argsHash !== argsHash)) {
      if (prior.status !== 'not_dispatched') throw beforeDispatch('同一操作标识不能对应不同工具或参数；既有写入须先核对');
      replaced = prior;
      id = hash(id + '\0' + tool.name + '\0' + argsHash);
    } else {
      if (prior?.status === 'confirmed' && replayProtected(prior)) return clone(prior.result);
      if (hasUncertainEffect(prior)) throw beforeDispatch('此操作的业务或输入效果仍不确定，禁止重试', 'E_SUBMISSION_UNCERTAIN');
      if (prior && hasInputEffects(prior) && prior.status !== 'not_dispatched') throw beforeDispatch('原输入Operation保留原回执，核对后也不会重放；请按新画面选择新的操作', 'E_OPERATION_REPLAY');
    }
    if(prior?.status==='not_dispatched'&&prior.preparationOnly===true&&hasInputEffects(prior)&&!replaced){
      // Retain the actual motion receipt. A new attempt gets a new physical
      // Operation; following the logical key never replays the old input.
      replaced=prior;id=hash(prior.id+'\0pointer-preparation-retry');
    }
    let permission = await this.authorize(tool, input, task,{signal,isCurrent});
    if (!isCurrent()) throw beforeDispatch('任务已暂停，未继续调用工具');

    const policy = tool.lifecycle?.(input, { task, call }) || { policy: 'independent' };
    const progress = actionId ? new ActionProgress(task.actionRuns[actionId].progress ??= {}, this.clock) : null;
    const operation = { id, key: call.key, tool: tool.name, effect: tool.effect, args: input, argsHash,
      status: 'intent', at: this.clock(), lifecycle: { phase: 'preparing', policy: policy.policy },
      ...(replaced ? { supersedes: replaced.id } : {}), ...(actionId ? { actionId } : {}) };
    const continuedFrom=Object.values(task.operations).filter(op=>hasBlockingEffect(task,op)&&effectReview.permits(task,op,call,this.clock()));
    if(continuedFrom.length)operation.continuedFrom=continuedFrom.map(op=>({operationId:op.id,reviewId:effectReview.consume(task,op,call,id,this.clock())}));
    const action = this.lifecycle.start({
      id, taskId: task.id, scope: policy.scope, eventKey: policy.eventKey, policy: policy.policy, parentSignal: signal, progress,
      recovery:actionId?clone(task.actionRuns[actionId].recovery):undefined,
      onPhase: async phase => { operation.lifecycle.phase = phase; await this.save(task); },
    });
    if (replaced) replaced.replacedBy = id;
    task.operations[id] = operation;
    const reads = Object.values(task.operations).filter(op => op.effect === 'read' && !hasInputEffects(op) && (op.status !== 'intent' || op.id === id));
    for (const old of reads.slice(0, Math.max(0, reads.length - 32))) delete task.operations[old.id];

    const assertCanDispatch = () => {
      if (action.signal.aborted || !isCurrent()) {
        throw beforeDispatch('动作在执行前已停止', action.superseded ? 'E_ACTION_SUPERSEDED' : undefined);
      }
    };
    let result, mayHaveDispatched = false;
    try {
      if (policy.policy === 'newer-event') {
        const index = task.inbox.findIndex(event => event.key === policy.eventKey);
        if (index >= 0) {
          const fresh = task.inbox.slice(index + 1).find(event => event.type === 'conversation.messages' &&
            task.id + ':' + task.scene + ':' + event.subjectKey === policy.scope && hasNewInput(event));
          if (fresh) this.supersede(task, fresh);
        }
      }
      // Save the intent and its initial phase together before calling the tool.
      await this.save(task);
      diagnostics.record('operation-intent',{status:'intent'});
      const maxAttempts = Math.max(1, Math.min(2, Number(policy.maxAttempts) || 1));
      for (let attempt = 1; ; attempt++) {
        assertCanDispatch();
        try {
          const execute = () => {
            assertCanDispatch();
            if (typeof permission === 'function') permission();
            mayHaveDispatched = true;
            diagnostics.record('operation-dispatch',{status:'requested',attempt});
            return require('./task-model-trace').scope({operationId:id},()=>effectReview.scope({task,operation,tool,input,save:()=>this.save(task),isCurrent,signal:action.signal,clock:this.clock},()=>inputOutcomes.collect(operation,()=>tool.execute(input, { task, signal: action.signal, action, operationId: id, attempt,resources:this.resources?.forTask(task,{signal:action.signal,isCurrent}) }))));
          };
          result = progress ? await progress.stage('tool').measure('tool', execute) : await execute();
          if (tool.effect === 'write' && (result?.ok !== true || result?.verified !== true)) {
            throw Object.assign(new Error(result?.error || '写入结果尚未核实'), { code: result?.code, dispatched: result?.dispatched,...(result?.visualFeedback?{visualFeedback:result.visualFeedback}:{}),...(result?.inputOutcome?{inputOutcome:result.inputOutcome}:{}),...(result?.diagnostic?{diagnostic:result.diagnostic}:{}) });
          }
          break;
        } catch (error) {
          retainOutcome(operation,error.inputOutcome||error.diagnostic?.inputOutcome);
          if (error.dispatched === false) mayHaveDispatched = false;
          if (attempt >= maxAttempts || mayHaveDispatched || inputOutcomes.hasEffects(operation.inputOutcome) || !['preparing', 'protected'].includes(action.phase) ||
              action.signal.aborted || !policy.shouldRetry?.(error)) throw error;
          operation.status = 'not_dispatched';
          diagnostics.record('operation-retry',{status:'not-dispatched',attempt,code:error.code});
          Object.assign(operation.lifecycle, { phase: 'recovering', attempt });
          await this.save(task);
          if (action.phase === 'protected') await action.retryBeforeEffect();
          await policy.recover?.({ error, task, input, signal: action.signal, attempt });
          assertCanDispatch();
          permission = await this.authorize(tool, input, task,{signal,isCurrent});
          assertCanDispatch();
          operation.status = 'intent';
          Object.assign(operation.lifecycle, { phase: 'preparing', attempt: attempt + 1 });
          await this.save(task);
        }
      }
      retainOutcome(operation,result?.inputOutcome);
      operation.result = tool.effect === 'write' ? clone(result) : hasInputEffects(operation) ? receiptResult(result) : { ok: true };
      operation.status = 'confirmed';
      if (tool.effect === 'read' && !hasInputEffects(operation) && (result?.frameId || result?.observationId)) operation.observation = Object.fromEntries(['frameId', 'observationId', 'at', 'perceptionSource'].filter(key => result[key] !== undefined).map(key => [key, result[key]]));
      operation.lifecycle.phase = 'completed';
      operation.finishedAt = this.clock();
      diagnostics.record('operation-receipt',{status:'confirmed',verified:result?.verified===true});
      delete operation.args;
      task.counters[tool.effect === 'write' ? 'writes' : 'reads']++;
      progress?.observe(tool.name, { tool: tool.name, args: input, result },
        { waiting: tool.name === 'work.status' && !result?.completed ? 'external' : undefined });
      await this.save(task);
    } catch (error) {
      if(error.visualFeedback)operation.visualFeedback=receiptResult(error.visualFeedback);
      const inputMayHaveDispatched=inputOutcomes.hasEffects(operation.inputOutcome);
      const preparationOnly=error.dispatched===false&&inputOutcomes.pointerPreparationOnly(operation.inputOutcome);
      diagnostics.record('operation-error',{status:operation.status==='confirmed'?'confirmed':preparationOnly?'not-dispatched':inputMayHaveDispatched?'uncertain':error.dispatched===false||!mayHaveDispatched?'not-dispatched':'uncertain',code:error.code,mayHaveDispatched:mayHaveDispatched||inputMayHaveDispatched,...(operation.inputOutcome?{inputOutcome:operation.inputOutcome}:{})});
      if(!action.signal.aborted&&operation.status!=='confirmed')diagnostics.bind().annotate(error,'operation-failed',{code:error.code,mayHaveDispatched});
      // A downstream checkpoint or cancellation cannot turn a verified effect
      // back into an unsent operation.
      if (operation.status !== 'confirmed') {
        const input = operation.inputOutcome;
        if (preparationOnly){operation.status='not_dispatched';operation.preparationOnly=true;}
        else if (input && (input.dispatched === true || input.dispatchOutcomeUnknown === true || input.reportsSubmitted > 0 || input.moved === true || ['unknown', 'partial'].includes(input.completion))) error.dispatched = true;
        else if (!inputMayHaveDispatched && (tool.effect === 'read' || !mayHaveDispatched)) error.dispatched = false;
        if (error.dispatched === false&&!inputOutcomes.hasEffects(operation.inputOutcome)) operation.status = 'not_dispatched';
        if (action.superseded && action.phase === 'preparing' && error.dispatched === false) error.code = 'E_ACTION_SUPERSEDED';
        operation.lifecycle.phase = operation.status === 'not_dispatched' ? 'cancelled' : 'uncertain';
        if (action.superseded) operation.lifecycle.reason = 'newer-event';
        if(operation.inputOutcome)error.inputOutcome={...operation.inputOutcome};
        operation.error = error.message;const diagnostic=require('./self-repair').diagnostic({...error.diagnostic,...(operation.inputOutcome?{inputOutcome:operation.inputOutcome}:{})});if(diagnostic)operation.errorDiagnostic=diagnostic;
        progress?.observe(tool.name, { tool: tool.name, args: input, error: error.code || error.name },
          { waiting: error.code === 'E_GUI_BUSY' ? 'gui' : error.code === 'E_CAPTURE_BUSY' ? 'capture' : undefined });
        await this.save(task);
      }
      throw error;
    } finally {
      action.finish();
    }
    if (!isCurrent()) throw new Error('实际结果已核实并保存；任务已暂停，没有继续后续操作');
    return clone(result ?? {});
  }
}

module.exports = { OperationLedger, hasInputEffects, hasUncertainEffect, hasBlockingEffect, replayProtected, reconcileEffect,reconcileNavigationOnCompletion };
