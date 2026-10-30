'use strict';
const crypto = require('node:crypto');
const MINUTE = 60000;
function explicitEstimate(text) {
  const match = String(text || '').match(/(?:预计|预期|大约需要|大概需要|还需|还要|预计还需|estimated?\s*(?:time)?[:\s]*|about)\s*(\d+(?:\.\d+)?)\s*(分钟|小时|秒|minutes?|mins?|hours?|hrs?|seconds?|secs?)/i);
  if (!match) return null;
  const unit = match[2].toLowerCase(), factor = /小时|hour|hr/.test(unit) ? 60 * MINUTE : /分钟|min/.test(unit) ? MINUTE : 1000;
  const ms = Number(match[1]) * factor;
  return ms >= 10000 && ms <= 8 * 60 * MINUTE ? { ms, remaining: /还需|还要/.test(match[0]), source: '明确估计' } : null;
}
function estimateTask(text, defaultMinutes = 12) {
  const explicit = explicitEstimate(text); if (explicit) return explicit;
  let minutes = Math.max(3, Math.min(120, Number(defaultMinutes) || 12));
  if (/全面|重构|迁移|全部|从零|完整.*(?:系统|项目)|架构/.test(text)) minutes = Math.max(minutes, 30);
  else if (/修复|调试|实现|开发|安装|部署|研究/.test(text)) minutes = Math.max(minutes, 15);
  else if (/简单|一句话|翻译|查一下|确认一下/.test(text)) minutes = Math.min(minutes, 5);
  return { ms: minutes * MINUTE, source: '本地参考估计' };
}
class TaskSupervision {
  constructor({ clock = Date.now, bootAt, defaultMinutes = () => 12, persist = async () => {} } = {}) {
    this.clock = clock; this.bootAt = bootAt ?? clock(); this.defaultMinutes = defaultMinutes; this.persist = persist;
    this.tasks = new Map(); this.pending = []; this.delivered = new Map();
  }
  key(snapshot) { const task = snapshot?.task; return task && snapshot.sessionId ? `${snapshot.sessionId}:${task.bunnyTaskId || task.messageKey || task.id + ':' + task.startedAt}` : null; }
  restore(entries) { this.delivered = new Map((Array.isArray(entries) ? entries : []).filter(x => Array.isArray(x) && typeof x[0] === 'string' && Number.isFinite(x[1])).slice(-96)); }
  observe(snapshots) {
    const now = this.clock(), present = new Set();
    for (const snapshot of snapshots.slice(0, 8)) {
      const key = this.key(snapshot), task = snapshot?.task;
      if (!key || !Number.isFinite(task.startedAt)) continue;
      present.add(key);
      let state = this.tasks.get(key);
      if (!state) {
        const estimate = estimateTask(task.userText || '', this.defaultMinutes());
        state = { key, firstSeen: now, snapshot, expectedAt: task.startedAt + estimate.ms, estimate, summaryHash: '' }; this.tasks.set(key, state);
      }
      state.snapshot = snapshot;
      const summary = String(task.summary || '').slice(0, 2500), hash = crypto.createHash('sha256').update(summary).digest('hex');
      if (hash !== state.summaryHash) {
        state.summaryHash = hash;
        const remaining = explicitEstimate(summary);
        if (remaining) { state.estimate = { ...remaining, source: 'WorkBuddy自述估计' }; state.expectedAt = (remaining.remaining ? snapshot.lastEventAt : task.startedAt) + remaining.ms; }
      }
      const running = task.status === 'running';
      this.pending = this.pending.filter(event => event.key !== key || event.kind === 'done' || event.kind === 'failed' || running);
      if (!running) {
        this.pending = this.pending.filter(event => event.key !== key || ['done','failed','abandoned'].includes(event.kind));
        if (!task.bunnyTaskId && task.endedAt >= this.bootAt) {
          this.enqueue(state, task.status === 'ok' ? 'done' : task.status === 'failed' ? 'failed' : 'abandoned');
        }
        continue;
      }
      const last = snapshot.lastEventAt || task.startedAt, idle = now - last;
      this.pending = this.pending.filter(event => event.key !== key || event.kind !== 'stall' || idle >= 3 * MINUTE);
      this.pending = this.pending.filter(event => event.key !== key ||
        (event.kind !== 'waiting' || task.waitingForUser) &&
        (event.kind !== 'repeated-errors' || task.consecutiveFailures >= 3) &&
        (event.kind !== 'overdue' || now > state.expectedAt));
      if (now - this.bootAt < 12000 || now - state.firstSeen < 10000) continue;
      if (task.waitingForUser) this.enqueue(state, 'waiting');
      else if (task.consecutiveFailures >= 3) this.enqueue(state, 'repeated-errors');
      else if (idle >= 5 * MINUTE) this.enqueue(state, 'stall');
      else if (now > state.expectedAt + (state.estimate.source === '本地参考估计' ? MINUTE : 15000)) this.enqueue(state, 'overdue');
    }
    this.pending = this.pending.filter(event => present.has(event.key) && now - event.at < (event.priority >= 4 ? 10 : 3) * MINUTE);
    this.activeKeys = present;
    for (const [key, state] of this.tasks) if (!present.has(key) && now - state.firstSeen > 60 * MINUTE) this.tasks.delete(key);
    while (this.tasks.size > 64) this.tasks.delete(this.tasks.keys().next().value);
  }
  enqueue(state, kind) {
    const id = state.key + ':' + kind, now = this.clock(), recent = this.delivered.get(id);
    if (this.pending.some(event => event.id === id) || recent && now - recent < 20 * MINUTE) return;
    const priorities = { done: 4, failed: 5, waiting: 5, abandoned: 4, 'repeated-errors': 3, stall: 3, overdue: 2 };
    this.pending = this.pending.filter(event => event.key !== state.key);
    this.pending.push({ id, key: state.key, kind, at: now, priority: priorities[kind] });
    this.pending.sort((a,b) => b.priority-a.priority || a.at-b.at); this.pending = this.pending.slice(0, 12);
  }
  take() {
    const event = this.pending.shift(); if (!event) return null;
    const state = this.tasks.get(event.key); if (!state) return null;
    const task = state.snapshot.task, rawTitle = String(task.title || task.userText || '这项任务').replace(/[<>`]/g, '').replace(/\s+/g, ' ').slice(0, 80);
    const title = /\/Users\/|\/home\/|[a-z]:\\|```|Bearer\s/i.test(rawTitle) ? '你交办的任务' : rawTitle.slice(0, 48);
    const elapsed = Math.max(1, Math.round((this.clock() - task.startedAt) / MINUTE));
    const minutes = Math.max(1, Math.round(state.estimate.ms / MINUTE));
    const phrases = {
      done: `WorkBuddy的“${title}”这一轮已有答复，请留意结果；还没有经过我独立验收。`,
      failed: `WorkBuddy报告“${title}”这项任务没有完成，建议看一下当前答复再决定下一步。`,
      abandoned: `“${title}”已经较长时间没有动静，也没有确认交付，建议检查WorkBuddy当前状态。`,
      waiting: `“${title}”正在等你提供信息或确认，可以看看WorkBuddy的问题。`,
      'repeated-errors': `“${title}”连续几次操作都没有成功，目前还没确认任务失败，建议看一下是否需要调整方向。`,
      stall: `“${title}”已超过五分钟没有新进展，我还不能确认原因，建议看一眼。`,
      overdue: `“${title}”已经进行了约${elapsed}分钟，超过${state.estimate.source === '本地参考估计' ? '参考预计' : '先前预计'}的约${minutes}分钟，目前仍在运行。`,
    };
    return { ...event, text: phrases[event.kind], snapshot: state.snapshot };
  }
  acknowledge(event) {
    this.delivered.set(event.id, this.clock());
    while (this.delivered.size > 96) this.delivered.delete(this.delivered.keys().next().value);
    Promise.resolve(this.persist([...this.delivered])).catch(() => {});
  }
  context(allowedKeys = this.activeKeys || new Set()) {
    return [...this.tasks.values()].filter(s => allowedKeys.has(s.key) && s.snapshot.task.status === 'running').slice(0, 6).map(s => {
      const elapsed = Math.max(0, Math.round((this.clock() - s.snapshot.task.startedAt) / MINUTE));
      return `${String(s.snapshot.task.title || s.snapshot.task.userText || '任务').slice(0,60)}：运行${elapsed}分钟，${s.estimate.source}约${Math.round(s.estimate.ms / MINUTE)}分钟${s.snapshot.task.waitingForUser ? '；等待用户' : ''}。`;
    }).join('\n');
  }
}
module.exports = { TaskSupervision, explicitEstimate, estimateTask };
