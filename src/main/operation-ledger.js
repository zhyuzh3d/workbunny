'use strict';

const { createHash } = require('node:crypto');
const { clone } = require('./agent-contract');
const { ActionLifecycle } = require('./action-lifecycle');
const { ActionProgress } = require('./action-progress');
const { hasNewInput } = require('./conversation-cursor');
const diagnostics = require('./operation-diagnostics');

const hash = value => createHash('sha256').update(value).digest('hex');
const beforeDispatch = (message, code) => Object.assign(new Error(message), { dispatched: false, code });

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
      if (prior?.status === 'confirmed' && tool.effect === 'write') return clone(prior.result);
      if (prior?.status === 'intent' && prior.effect === 'write') throw beforeDispatch('此写入结果不确定，禁止重试');
    }
    let permission = await this.authorize(tool, input, task,{signal,isCurrent});
    if (!isCurrent()) throw beforeDispatch('任务已暂停，未继续调用工具');

    const policy = tool.lifecycle?.(input, { task, call }) || { policy: 'independent' };
    const progress = actionId ? new ActionProgress(task.actionRuns[actionId].progress ??= {}, this.clock) : null;
    const operation = { id, key: call.key, tool: tool.name, effect: tool.effect, args: input, argsHash,
      status: 'intent', at: this.clock(), lifecycle: { phase: 'preparing', policy: policy.policy },
      ...(replaced ? { supersedes: replaced.id } : {}), ...(actionId ? { actionId } : {}) };
    const action = this.lifecycle.start({
      id, taskId: task.id, scope: policy.scope, eventKey: policy.eventKey, policy: policy.policy, parentSignal: signal, progress,
      recovery:actionId?clone(task.actionRuns[actionId].recovery):undefined,
      onPhase: async phase => { operation.lifecycle.phase = phase; await this.save(task); },
    });
    if (replaced) replaced.replacedBy = id;
    task.operations[id] = operation;
    const reads = Object.values(task.operations).filter(op => op.effect === 'read');
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
            return tool.execute(input, { task, signal: action.signal, action, operationId: id, attempt,resources:this.resources?.forTask(task,{signal:action.signal,isCurrent}) });
          };
          result = progress ? await progress.stage('tool').measure('tool', execute) : await execute();
          if (tool.effect === 'write' && (result?.ok !== true || result?.verified !== true)) {
            throw Object.assign(new Error(result?.error || '写入结果尚未核实'), { code: result?.code, dispatched: result?.dispatched,...(result?.diagnostic?{diagnostic:result.diagnostic}:{}) });
          }
          break;
        } catch (error) {
          if (error.dispatched === false) mayHaveDispatched = false;
          if (attempt >= maxAttempts || mayHaveDispatched || !['preparing', 'protected'].includes(action.phase) ||
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
      operation.result = tool.effect === 'write' ? clone(result) : { ok: true };
      operation.status = 'confirmed';
      operation.lifecycle.phase = 'completed';
      operation.finishedAt = this.clock();
      diagnostics.record('operation-receipt',{status:'confirmed',verified:result?.verified===true});
      delete operation.args;
      task.counters[tool.effect === 'write' ? 'writes' : 'reads']++;
      progress?.observe(tool.name, { tool: tool.name, args: input, result },
        { waiting: tool.name === 'work.status' && !result?.completed ? 'external' : undefined });
      await this.save(task);
    } catch (error) {
      diagnostics.record('operation-error',{status:operation.status==='confirmed'?'confirmed':error.dispatched===false||!mayHaveDispatched?'not-dispatched':'uncertain',code:error.code,mayHaveDispatched});
      if(!action.signal.aborted&&operation.status!=='confirmed')diagnostics.bind().annotate(error,'operation-failed',{code:error.code,mayHaveDispatched});
      // A downstream checkpoint or cancellation cannot turn a verified effect
      // back into an unsent operation.
      if (operation.status !== 'confirmed') {
        if (tool.effect === 'read' || !mayHaveDispatched) error.dispatched = false;
        if (error.dispatched === false) operation.status = 'not_dispatched';
        if (action.superseded && action.phase === 'preparing' && error.dispatched === false) error.code = 'E_ACTION_SUPERSEDED';
        operation.lifecycle.phase = operation.status === 'not_dispatched' ? 'cancelled' : 'uncertain';
        if (action.superseded) operation.lifecycle.reason = 'newer-event';
        operation.error = error.message;const diagnostic=require('./self-repair').diagnostic(error.diagnostic);if(diagnostic)operation.errorDiagnostic=diagnostic;
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

module.exports = { OperationLedger };
