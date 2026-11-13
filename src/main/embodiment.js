'use strict';
const { randomUUID } = require('node:crypto');
const { performancePlayback } = require('./performance-playback-policy');
const REASONS = new Set(['reply', 'manual', 'touch', 'autonomy', 'thinking', 'idle', 'work', 'performance']);
function actualPlayback(value, expectedMode) {
  if (!value || typeof value !== 'object' || !['once', 'cycle'].includes(value.mode) ||
    (expectedMode && value.mode !== expectedMode) || !Number.isInteger(value.cycles) || value.cycles < 1 || value.cycles > 128 ||
    (value.mode === 'once' && value.cycles !== 1) ||
    ![value.clipDurationMs, value.totalDurationMs].every(duration => Number.isFinite(duration) && duration > 0 && duration <= 300000)) return null;
  const expected = value.cycles * value.clipDurationMs;
  if (Math.abs(value.totalDurationMs - expected) > Math.max(1, expected * 1e-6)) return null;
  return Object.freeze({ mode: value.mode, cycles: value.cycles, clipDurationMs: value.clipDurationMs, totalDurationMs: value.totalDurationMs });
}
class Embodiment {
  constructor({ catalog, avatar, send, persist = async () => {}, clock = Date.now, timeoutMs = 10000, completionTimeoutMs }) {
    Object.assign(this, { catalog, avatar, send, persist, clock, timeoutMs, completionTimeoutMs }); this.recent = []; this.pending = new Map(); this.capabilities = null; this.posture = 'standing'; this.postureAvatar = null;
    this.activePerformance = null; this.lastPerformance = null; this.performanceCompletionTimer = null; this.readyAvatar = null;
  }
  perform(selector, reason = 'reply', options = {}) {
    if (reason === 'manual' || reason === 'touch') this.cancelPerformance(reason);
    if (this.activePerformance && reason !== 'performance') return Promise.resolve({ ok: false, suppressed: true, error: '正在表演' });
    if (options.signal?.aborted) return Promise.resolve({ ok: false, cancelled: true, error: '动作已取消' });
    if (reason === 'performance' && (typeof options.performanceId !== 'string' || !options.performanceId || options.performanceId.length > 160)) return Promise.resolve({ ok: false, error: '表演身份无效' });
    const avatar = this.avatar(), avatarKey = avatar?.key, avatarName = avatar?.name || avatarKey;
    if (this.postureAvatar !== avatarKey) { this.postureAvatar = avatarKey; this.posture = 'standing'; }
    if (reason !== 'performance' && avatar?.kind !== 'avatar-pack' && ((selector === 'hq_world_sit_enter' && this.posture === 'sitting') || (selector === 'hq_world_sit_exit' && this.posture === 'standing'))) return Promise.resolve({ ok: true, alreadyInPosture: true });
    const allowPostureChange = reason === 'manual' || options.allowPostureChange === true;
    const motion = this.catalog.select(selector, { exact: reason === 'performance', posture: this.posture, allowPostureChange, manual: reason === 'manual', autonomous: ['autonomy', 'idle', 'work', 'thinking', 'touch'].includes(reason), reason });
    if (!motion || (reason === 'performance' && (motion.key !== selector || motion.enabled === false || motion.deleted || motion.requiresProp))) return Promise.resolve({ ok: false, error: '动作不存在、已禁用或该分类没有可随机使用的动作' });
    if (reason === 'performance') this.cancelPerformance('replaced');
    const id = randomUUID();
    const performance = reason === 'performance' ? { performanceId: options.performanceId, requestId: id, key: motion.key,
      label: motion.label, avatar: avatarKey, avatarName, phase: 'loading', requestedAt: this.clock(), holdMs: 4000,
      performancePlayback: Object.freeze({ ...performancePlayback(motion) }) } : null;
    if (performance) this.activePerformance = performance;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (performance && this.activePerformance === performance) this.finishPerformance(performance, 'failed', '动作尚未加载完成', { timedOut: true }, true);
        else this.settle(id, { ok: false, error: '动作尚未加载完成' });
      }, this.timeoutMs);
      const onAbort = () => {
        if (performance && this.activePerformance === performance) this.cancelPerformance('aborted');
        else this.settle(id, { ok: false, cancelled: true, error: '动作已取消' });
      };
      this.pending.set(id, { key: motion.key, avatar: avatarKey, avatarName, reason, resolve, timer, signal: options.signal, onAbort });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) { onAbort(); return; }
      try {
        this.send({ key: motion.key, requestId: id, reason, allowPostureChange,
          ...(performance ? { performanceId: performance.performanceId, holdMs: performance.holdMs, performancePlayback: performance.performancePlayback } : {}) });
      } catch (error) {
        if (performance) this.finishPerformance(performance, 'failed', error.message || '动作发送失败');
        else this.settle(id, { ok: false, error: error.message || '动作发送失败' });
      }
    });
  }
  settle(id, result) {
    const request = this.pending.get(id); if (!request) return;
    clearTimeout(request.timer); request.signal?.removeEventListener('abort', request.onAbort);
    this.pending.delete(id); request.resolve(result);
  }
  finishPerformance(performance, phase, error, details = {}, cancelRenderer = false) {
    if (this.activePerformance !== performance) return false;
    clearTimeout(this.performanceCompletionTimer); this.performanceCompletionTimer = null;
    this.activePerformance = null;
    this.lastPerformance = { ...performance, phase, at: this.clock(), ...(error ? { error } : {}), ...details };
    this.persistState();
    this.settle(performance.requestId, { ok: false, ...(phase === 'cancelled' ? { cancelled: true } : {}), ...(error ? { error } : {}), ...details });
    if (cancelRenderer) { try { this.send({ cancelPerformance: performance.performanceId }); } catch {} }
    return true;
  }
  persistState() {
    // Keep the established first argument; callers can optionally persist the
    // terminal outcome separately so routine idle history cannot erase it.
    try { Promise.resolve(this.persist(this.recent.map(row => ({ ...row })), {
      lastPerformance: this.lastPerformance ? { ...this.lastPerformance } : null
    })).catch(() => {}); } catch {}
  }
  watchPerformanceEnd(performance, motion) {
    // Pack durations are validated up to 300s; unmeasured VRMA clips receive
    // that full allowance. A missing renderer end must still release the body.
    let durationMs = Number.isFinite(motion.duration) && motion.duration > 0 ? Math.min(300, motion.duration) * 1000 : 300000;
    if (performance.performancePlayback.mode === 'cycle') durationMs = Math.max(performance.holdMs, durationMs);
    if (performance.playback) durationMs = performance.playback.totalDurationMs;
    const timeout = Number.isFinite(this.completionTimeoutMs) && this.completionTimeoutMs > 0 ? this.completionTimeoutMs : durationMs + 5000;
    performance.completionDeadlineAt = this.clock() + timeout;
    this.performanceCompletionTimer = setTimeout(() => this.finishPerformance(performance, 'failed', '未收到表演结束回执', { timedOut: true }, true), timeout);
    this.performanceCompletionTimer.unref?.();
  }
  cancelPerformance(reason = 'cancelled') {
    if (!this.activePerformance) return false;
    return this.finishPerformance(this.activePerformance, 'cancelled', '表演已取消', { reason }, true);
  }
  report(event) {
    const avatar = this.avatar();
    if (!event || event.avatar !== avatar?.key) return false;
    const phase = event.phase || (event.ok === false ? 'failed' : 'started');
    let reportedPerformance = null;
    if (!['started', 'finished', 'cancelled', 'failed'].includes(phase)) return false;
    if (event.performanceId !== undefined || event.reason === 'performance') {
      const performance = this.activePerformance;
      if (!performance || event.performanceId !== performance.performanceId || event.requestId !== performance.requestId || event.key !== performance.key || event.avatar !== performance.avatar) return false;
      if (phase !== 'started' || event.ok === false) {
        if (phase === 'finished' && performance.phase !== 'started') return false;
        const outcome = event.ok === false && (phase === 'started' || phase === 'finished') ? 'failed' : phase;
        return this.finishPerformance(performance, outcome,
          outcome === 'failed' ? Number.isFinite(performance.startedAt) ? '表演播放未正常结束' : '请求的动作未能实际播放' : outcome === 'cancelled' ? '表演已取消' : undefined);
      }
      if (performance.phase === 'started') return true;
      const motion = this.catalog.catalog().motions.find(m => m.key === event.key && m.enabled !== false && !m.deleted);
      if (!motion) { this.finishPerformance(performance, 'failed', '动作不存在或已禁用', {}, true); return false; }
      const playback = actualPlayback(event.playback, performance.performancePlayback.mode);
      if (playback) performance.playback = playback;
      performance.phase = 'started'; performance.startedAt = this.clock();
      this.watchPerformanceEnd(performance, motion);
      reportedPerformance = performance;
    } else if (phase !== 'started') {
      if (phase === 'failed' || phase === 'cancelled') this.settle(event.requestId, { ok: false, error: '请求的动作未能实际播放' });
      return false;
    }
    const request = this.pending.get(event.requestId), motion = this.catalog.catalog().motions.find(m => m.key === event.key && m.enabled);
    if (request && (request.avatar !== event.avatar || request.key !== event.key || event.ok === false)) {
      this.settle(event.requestId, { ok: false, error: '请求的动作未能实际播放' }); return false;
    }
    if (!motion || event.ok === false) return false;
    const record = { key: motion.key, label: motion.label, category: motion.slot, avatar: event.avatar, avatarName: request?.avatarName || avatar?.name || event.avatar,
      reason: request?.reason || (REASONS.has(event.reason) ? event.reason : 'idle'), at: this.clock(),
      ...(reportedPerformance?.playback ? { playback: reportedPerformance.playback } : {}) };
    const previous = this.recent.at(-1);
    if (request || !previous || previous.avatar !== record.avatar || previous.key !== record.key || record.at - previous.at > 500) {
      this.recent.push(record); this.recent = this.recent.slice(-5); this.persistState();
    }
    if (request) this.settle(event.requestId, { ok: true, motion: record });
    return true;
  }
  setPosture(event) { if (event?.avatar === this.avatar()?.key && ['standing', 'sitting'].includes(event.posture)) { this.postureAvatar = event.avatar; this.posture = event.posture; } }
  setReady(event) {
    const avatar = this.avatar();
    if (!avatar || event?.avatar !== avatar.key) return false;
    this.capabilities = { expressions: (Array.isArray(event.expressions) ? event.expressions : []).filter(k => typeof k === 'string' && k.length < 80).slice(0, 40) };
    this.readyAvatar = { ...avatar }; return true;
  }
  avatarChanged() {
    this.cancelPerformance('avatar');
    for (const id of this.pending.keys()) this.settle(id, { ok: false, error: '形象已切换' });
    this.capabilities = null; this.postureAvatar = null; this.posture = 'standing';
  }
  snapshot() { return { posture: this.posture, avatar: this.avatar(), recentActions: this.recent.map(r => ({ ...r })), capabilities: this.capabilities,
    performance: { active: this.activePerformance ? { ...this.activePerformance } : null, lastOutcome: this.lastPerformance ? { ...this.lastPerformance } : null } }; }
  context() {
    const avatar = this.avatar();
    const visible = this.capabilities ? avatar : this.readyAvatar;
    return { posture: this.posture, appearance: visible || avatar ? { name: visible?.name || null, description: visible?.description || '', ready: !!this.capabilities,
      ...(!this.capabilities && avatar ? { requestedName: avatar.name } : {}) } : null,
      recentActions: this.recent.map(r => ({ action: r.label, avatarName: r.avatarName || r.avatar, secondsAgo: Math.max(0, Math.round((this.clock() - r.at) / 1000)), cause: r.reason,
        ...(r.playback ? { playback: r.playback } : {}) })),
      expressions: this.capabilities?.expressions || [],
      ...(this.activePerformance ? { performance: { action: this.activePerformance.label, avatarName: this.activePerformance.avatarName || this.activePerformance.avatar, phase: this.activePerformance.phase,
        started: Number.isFinite(this.activePerformance.startedAt), ...(this.activePerformance.playback ? { playback: this.activePerformance.playback } : {}) } } : {}),
      ...(this.lastPerformance ? { lastPerformance: { action: this.lastPerformance.label, avatarName: this.lastPerformance.avatarName || this.lastPerformance.avatar, phase: this.lastPerformance.phase,
        started: Number.isFinite(this.lastPerformance.startedAt),
        ...(this.lastPerformance.playback ? { playback: this.lastPerformance.playback } : {}),
        ...(this.lastPerformance.error ? { error: this.lastPerformance.error } : {}),
        ...(this.lastPerformance.reason ? { reason: this.lastPerformance.reason } : {}),
        secondsAgo: Math.max(0, Math.round((this.clock() - this.lastPerformance.at) / 1000)) } } : {}) };
  }
  restore(rows, lastPerformance) {
    this.recent = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r.key === 'string' && Number.isFinite(r.at)).slice(-5)
      .map(row => { const { playback, ...record } = row; const valid = actualPlayback(playback); return { ...record, ...(valid ? { playback: valid } : {}) }; });
    if (lastPerformance && ['finished', 'cancelled', 'failed'].includes(lastPerformance.phase) && typeof lastPerformance.label === 'string' && Number.isFinite(lastPerformance.at) &&
      (!this.lastPerformance || lastPerformance.at > this.lastPerformance.at)) {
      this.lastPerformance = Object.fromEntries(['key', 'label', 'avatar', 'avatarName', 'performanceId', 'requestId', 'phase', 'at', 'startedAt', 'requestedAt', 'error', 'reason', 'timedOut']
        .filter(key => lastPerformance[key] !== undefined).map(key => [key, lastPerformance[key]]));
      const playback = actualPlayback(lastPerformance.playback);
      if (playback) this.lastPerformance.playback = playback;
    }
  }
  close() { this.cancelPerformance('closed'); for (const id of this.pending.keys()) this.settle(id, { ok: false, error: '动作已取消' }); }
}
module.exports = { Embodiment };
