'use strict';
// Task-only model evidence. Raw material goes exclusively through the existing
// encrypted vault; ordinary diagnostics receive gap metadata, never content.
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID, createHash } = require('node:crypto');
const { canRead } = require('./memory-scope');
const context = new AsyncLocalStorage();
const SCHEMA = 'bunny.task-model-trace/v1', INDEX = 'bunny-task-model-trace-index-v1';
const digest = text => createHash('sha256').update(text).digest('hex');
const safeError = e => ({ name: String(e?.name || 'Error').slice(0, 80), code: String(e?.code || '').slice(0, 80), message: String(e?.message || '').slice(0, 4000) });
const allowed = s => !!s && ['life', 'work'].includes(s.scene) && Number.isInteger(s.visibilityFloor) && s.visibilityFloor >= (s.scene === 'life' ? 1 : 0) && s.visibilityFloor <= 1;
const live = s => !s.signal?.aborted && (!s.isCurrent || s.isCurrent());
const copy = value => JSON.parse(JSON.stringify(value));
const visibleCalls = calls => calls.map(call => ({ ...Object.fromEntries(['id', 'type'].filter(k => call[k] !== undefined).map(k => [k, copy(call[k])])),
  ...(call.function ? { function: Object.fromEntries(['name', 'arguments'].filter(k => call.function[k] !== undefined).map(k => [k, copy(call.function[k])])) } : {}) }));
function scope(fields, invoke) { return context.run({ ...context.getStore(), ...fields }, invoke); }
function visible(response = {}) {
  const value = response.response || response;
  return { ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(value.toolCalls || value.tool_calls ? { toolCalls: visibleCalls(value.toolCalls || value.tool_calls) } : {}),
    ...Object.fromEntries(['model', 'provider', 'finishReason', 'usage', 'contextBudget'].filter(k => value[k] !== undefined).map(k => [k, copy(value[k])])) };
}
function requestView(options = {}) {
  // Explicit allowlist: never endpoint, credentials, headers, callbacks, raw
  // provider replies or hidden reasoning fields. Visible message content stays exact.
  const messages = (options.messages || []).map(m => Object.fromEntries(['role', 'content', 'name', 'tool_calls', 'tool_call_id'].filter(k => m[k] !== undefined).map(k => [k, k === 'tool_calls' ? visibleCalls(m[k]) : copy(m[k])])));
  return { messages, ...((options.messages || []).some(m => m.reasoning_content !== undefined || m.reasoning !== undefined) ? { hiddenReasoningOmitted: true } : {}),
    ...Object.fromEntries(['model', 'provider', 'maxTokens', 'max_tokens', 'max_completion_tokens', 'inputBudgetTokens', 'contextBudget', 'timeoutMs', 'temperature', 'top_p', 'stream', 'reasoning_effort'].filter(k => options[k] !== undefined).map(k => [k, copy(options[k])])) };
}
const noop = { run: invoke => invoke(), validated() {}, failed() {} };
async function begin(options, { attempt = 1, purpose = 'structured-json', knowledgeRefs, parentGoal } = {}) {
  const inherited = context.getStore();
  if (inherited?.taskId && !live(inherited)) throw Object.assign(Error('模型请求前任务已停止'), { code: 'ABORT_ERR', dispatched: false });
  if (!inherited?.recorder || !allowed(inherited) || !inherited.recorder.accepts(inherited)) return noop;
  const base = { ...inherited, memoryGeneration: inherited.recorder.memory.generation };
  const requestId = randomUUID(), at = base.recorder.clock();
  let operationId = base.operationId;
  if (base.registerModelOperation) {
    const registered = await base.registerModelOperation({ requestId, purpose, attempt, at, parentOperationId: base.operationId });
    operationId = typeof registered === 'string' ? registered : registered?.operationId || registered?.id || operationId;
  }
  if (!live(base)) throw Object.assign(Error('模型请求前任务已停止'), { code: 'ABORT_ERR', dispatched: false });
  const entry = { schema: SCHEMA, traceId: requestId, requestId, taskId: base.taskId, actionId: base.actionId || null,
    operationId: operationId || null, parentOperationId: base.operationId || null, generation: base.generation,
    scene: base.scene, visibilityFloor: base.visibilityFloor, parentGoal: parentGoal ?? base.parentGoal,
    knowledgeRefs: knowledgeRefs ?? base.knowledgeRefs ?? [], purpose, attempt, startedAt: at,
    assembled: requestView(options), wire: [], status: 'requested', coverage: { assembled: true, actualWire: false, visibleResponse: false, validation: false } };
  const state = { ...base, call: entry };
  const save = () => base.recorder.record(entry, base);
  save();
  let completed = false;
  const finish = (status, validation, failure) => {
    if (completed) return; completed = true;
    Object.assign(entry, { status, finishedAt: base.recorder.clock(), late: !live(base), ...(validation ? { validation } : {}), ...(failure ? { error: safeError(failure) } : {}) });
    entry.coverage.validation = !!validation;
    if (!entry.coverage.actualWire) base.recorder.gap('actual-wire-missing', entry);
    save();
    // This callback updates the original model Operation only. Its owner must
    // reject retired generations; trace recording cannot revive execution.
    try { Promise.resolve(base.completeModelOperation?.({ operationId, requestId, status: status === 'validated' ? 'completed' : status, validation, error: failure ? safeError(failure) : undefined, late: entry.late })).catch(() => base.recorder.gap('operation-checkpoint-failed', entry)); }
    catch { base.recorder.gap('operation-checkpoint-failed', entry); }
  };
  return { run: invoke => context.run(state, async () => { try { const response = await invoke(); entry.response = visible(response); entry.coverage.visibleResponse = typeof entry.response.text === 'string' || !!entry.response.toolCalls; save(); return response; } catch (e) { finish('failed', undefined, e); throw e; } }),
    validated: details => finish('validated', { ok: true, ...details }),
    failed: (e, details) => finish('validation-failed', { ok: false, ...details }, e) };
}
function wire(options) {
  const inherited = context.getStore();
  if (!inherited?.recorder || !allowed(inherited) || !live(inherited) || !inherited.recorder.accepts(inherited)) return { complete() {}, failed() {} };
  const active = { ...inherited, memoryGeneration: inherited.memoryGeneration ?? inherited.recorder.memory.generation };
  // Raw transports not using begin remain distinguishable from assembled calls.
  const entry = active.call || { schema: SCHEMA, traceId: randomUUID(), taskId: active.taskId, actionId: active.actionId || null,
    operationId: active.operationId || null, generation: active.generation, scene: active.scene, visibilityFloor: active.visibilityFloor,
    parentGoal: active.parentGoal, knowledgeRefs: active.knowledgeRefs || [], purpose: 'transport-only', startedAt: active.recorder.clock(), wire: [],
    coverage: { assembled: false, actualWire: true, visibleResponse: false, validation: false }, status: 'requested' };
  const transport = { attempt: entry.wire.length + 1, at: active.recorder.clock(), request: requestView(options), status: 'requested' };
  entry.wire.push(transport); entry.coverage.actualWire = true; active.recorder.record(entry, active);
  if (!active.call) active.recorder.gap('model-operation-scope-missing', entry);
  return { complete: response => { transport.response = visible(response); transport.status = 'completed'; transport.finishedAt = active.recorder.clock(); entry.coverage.visibleResponse = true; if (!active.call) entry.status = 'completed'; active.recorder.record(entry, active); },
    failed: e => { transport.error = safeError(e); transport.status = 'failed'; transport.finishedAt = active.recorder.clock(); if (!active.call) entry.status = 'failed'; active.recorder.record(entry, active); } };
}
class TaskModelTrace {
  constructor({ memory, getScene = () => memory?.scene?.() || 'private', clock = Date.now, onGap = () => {}, maxEntries = 64,
    maxBytes = 32 * 1024 * 1024, maxEntryBytes = 16 * 1024 * 1024, maxPendingBytes = 24 * 1024 * 1024, retentionMs = 7 * 86400000, writeTimeoutMs = 1500 } = {}) {
    Object.assign(this, { memory, getScene, clock, onGap, maxEntries, maxBytes, maxEntryBytes, maxPendingBytes, retentionMs, writeTimeoutMs });
    this.pending = new Map(); this.gaps = []; this.index = null; this.closed = false; this.generation = memory?.generation;
  }
  accepts(fields) { return !this.closed && allowed(fields) && ['life', 'work'].includes(this.getScene()) && !!this.memory && (fields.memoryGeneration === undefined || fields.memoryGeneration === this.memory.generation); }
  gap(code, fields = {}) {
    const gap = { code, at: this.clock(), ...(fields.taskId ? { taskId: fields.taskId } : {}), ...(fields.traceId ? { traceId: fields.traceId } : {}) };
    this.gaps.push(gap); this.gaps = this.gaps.slice(-128); try { this.onGap(copy(gap)); } catch {} return gap;
  }
  record(entry, owner) {
    if (!this.accepts(owner)) { this.gap('scope-or-key-stale', entry); return; }
    let json;
    try { json = JSON.stringify(entry); } catch { this.gap('serialization-failed', entry); return; }
    let bytes = Buffer.byteLength(json);
    if (bytes > this.maxEntryBytes) {
      this.gap('entry-limit', entry);
      json = JSON.stringify({ ...entry, assembled: undefined, wire: undefined, response: undefined,
        coverage: { ...entry.coverage, rawOmitted: true }, omitted: { reason: 'entry-limit', bytes, sha256: digest(json) } }); bytes = Buffer.byteLength(json);
    }
    const queued = [...this.pending.values()].reduce((n, item) => n + item.bytes, 0) - (this.pending.get(entry.traceId)?.bytes || 0);
    if (queued + bytes > this.maxPendingBytes) { this.gap('queue-limit', entry); return; }
    this.pending.set(entry.traceId, { json, bytes, owner: { ...owner, memoryGeneration: this.memory.generation }, metadata: { traceId: entry.traceId, taskId: entry.taskId, scene: entry.scene, visibilityFloor: entry.visibilityFloor, at: entry.startedAt, bytes } });
    this.schedule();
  }
  schedule() { if (!this.draining && !this.closed) this.draining = Promise.resolve().then(() => this.drain()).finally(() => { this.draining = null; if (this.pending.size) this.schedule(); }); }
  assertStorage(owner) { if (!this.accepts(owner)) throw Error('trace scope or encryption key changed'); this.memory.check?.(); }
  async loadIndex(owner) {
    this.assertStorage(owner); if (this.index && this.generation === this.memory.generation) return;
    const raw = (await this.memory.db.request('get', { ids: [INDEX] })).rows[0]; this.assertStorage(owner);
    const value = raw ? this.memory.decode(raw).value : null;
    this.index = value?.schema === SCHEMA && value.type === 'index' ? { entries: value.entries || [], gaps: value.gaps || [] } : { entries: [], gaps: [] }; this.generation = this.memory.generation;
  }
  async persist(item, guard) {
    const check = () => { if (!guard.live) throw Error('trace storage timed out'); this.assertStorage(item.owner); };
    await this.loadIndex(item.owner); check();
    const now = this.clock(), size = 384 * 1024, chunks = [];
    // Slice UTF-8 bytes, then base64 each chunk; JSON Unicode stays lossless.
    const data = Buffer.from(item.json), count = Math.ceil(data.length / size);
    for (let i = 0; i < count; i++) chunks.push({ id: item.metadata.traceId + ':trace:' + i, kind: 'state', ts: item.metadata.at, updatedAt: now,
      domain: item.metadata.scene, visibilityFloor: item.metadata.visibilityFloor, expiresAt: item.metadata.at + this.retentionMs, searchText: '',
      value: { schema: SCHEMA, type: 'chunk', taskId: item.metadata.taskId, traceId: item.metadata.traceId, index: i, count, data: data.subarray(i * size, (i + 1) * size).toString('base64'), sources: [item.metadata.taskId] } });
    const previous = this.index.entries.find(e => e.traceId === item.metadata.traceId);
    let entries = this.index.entries.filter(e => e.traceId !== item.metadata.traceId); entries.push({ ...item.metadata, count }); entries.sort((a, b) => a.at - b.at);
    const removed = []; let total = entries.reduce((n, e) => n + e.bytes, 0);
    while (entries.length && (entries.length > this.maxEntries || total > this.maxBytes || now - entries[0].at > this.retentionMs)) { const old = entries.shift(); removed.push(old); total -= old.bytes; }
    const gaps = [...this.index.gaps, ...this.gaps, ...removed.map(e => ({ code: 'retention-limit', at: now, taskId: e.taskId, traceId: e.traceId }))].slice(-128);
    const index = { id: INDEX, kind: 'state', ts: 0, updatedAt: now, domain: 'life', visibilityFloor: 1, searchText: '', value: { schema: SCHEMA, type: 'index', entries, gaps, sources: [] } };
    check();
    // Own queue, never memory.serial: a slow evidence write must not hold the
    // shared journal/context queue. Encryption and source checks stay canonical.
    await this.memory.write([...chunks, index], this.memory.epoch, { notify: false, strictSources: true, assertCurrent: check }); check();
    this.index = { entries, gaps };
    // Only the short destructive cleanup shares the canonical mutation lane.
    // Native remove advances epoch even for trace chunks; the memory owner
    // must adopt its receipt before a later journal write prepares its epoch.
    for (let i = count; i < (previous?.count || 0); i++) { check(); await this.memory.removeRecord(item.metadata.traceId + ':trace:' + i, { assertCurrent: check }); }
    for (const old of removed) for (let i = 0; i < old.count; i++) { check(); await this.memory.removeRecord(old.traceId + ':trace:' + i, { assertCurrent: check }); }
  }
  async drain() {
    while (this.pending.size && !this.closed) {
      const [id, item] = this.pending.entries().next().value; this.pending.delete(id);
      const guard = { live: true }; let timer;
      try { await Promise.race([this.persist(item, guard), new Promise((_, reject) => { timer = setTimeout(() => { guard.live = false; reject(Error('trace write timeout')); }, this.writeTimeoutMs); })]); }
      catch { this.gap(guard.live ? 'storage-failed' : 'storage-timeout', item.metadata); if (!guard.live) { this.closed = true; for (const queued of this.pending.values()) this.gap('storage-unavailable', queued.metadata); this.pending.clear(); } }
      finally { clearTimeout(timer); }
    }
  }
  status(taskId) { return { pending: [...this.pending.values()].filter(e => !taskId || e.metadata.taskId === taskId).length + (this.draining ? 1 : 0),
    gaps: [...(this.index?.gaps || []), ...this.gaps].filter(e => !taskId || e.taskId === taskId).slice(-32), unavailable: this.closed }; }
  async flush({ timeoutMs = 1000 } = {}) {
    let timer; try { await Promise.race([(async()=>{while(this.draining)await this.draining;})(), new Promise(resolve => { timer = setTimeout(resolve, Math.min(10000, Math.max(1, timeoutMs))); })]); } finally { clearTimeout(timer); }
    return this.status();
  }
  async read({ taskId, traceIds, limit = 20 } = {}, { authorize = () => false, isCurrent = () => true, scene = this.getScene() } = {}) {
    if (!['life', 'work'].includes(scene) || !['life', 'work'].includes(this.getScene()) || typeof taskId !== 'string' || !taskId || !await authorize({ taskId })) throw Object.assign(Error('原始模型记录仅供已授权生活/工作任务核验'), { code: 'E_TASK_TRACE_SCOPE' });
    const owner = { scene, visibilityFloor: scene === 'life' ? 1 : 0, memoryGeneration: this.memory.generation };
    const check = () => { if (!isCurrent()) throw Error('任务记录读取已失效'); this.assertStorage(owner); };
    check(); await this.flush(); await this.loadIndex(owner); check();
    if (traceIds !== undefined && (!Array.isArray(traceIds) || traceIds.length > 64 || traceIds.some(id => typeof id !== 'string'))) throw Error('模型记录ID无效');
    const all = this.index.entries.filter(e => e.taskId === taskId && this.clock() - e.at <= this.retentionMs && e.visibilityFloor <= 1 && canRead(scene, { domain: e.scene, visibilityFloor: e.visibilityFloor }) && (!traceIds || traceIds.includes(e.traceId)));
    const selected = all.slice(-Math.max(1, Math.min(64, Number(limit) || 20))), traces = [], missing = [];
    for (const entry of selected) {
      const parts = [];
      for (let i = 0; i < entry.count; i++) {
        check(); const raw = (await this.memory.db.request('get', { ids: [entry.traceId + ':trace:' + i] })).rows[0]; check();
        const row = raw && this.memory.decode(raw);
        if (!row || row.visibilityFloor > 1 || !canRead(scene, row) || row.value.schema !== SCHEMA || row.value.taskId !== taskId || row.value.traceId !== entry.traceId || row.value.index !== i || row.value.count !== entry.count) { parts.length = 0; break; }
        parts.push(Buffer.from(row.value.data, 'base64'));
      }
      if (!parts.length) { missing.push({ code: 'stored-chunk-missing', taskId, traceId: entry.traceId }); continue; }
      const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (value.taskId !== taskId || value.traceId !== entry.traceId || value.visibilityFloor > 1 || !allowed(value)) throw Error('模型记录范围不匹配');
      traces.push(value);
    }
    return { traces, ...this.status(taskId), gaps: [...this.status(taskId).gaps, ...missing], omitted: all.length - selected.length };
  }
}
module.exports = { TaskModelTrace, scope, begin, wire };
