'use strict';

const { randomUUID } = require('crypto');
const { checkDesktopScope } = require('./desktop-scope');
const ACTIVE = new Set(['active', 'waiting', 'needs_window']);
const MESSAGE_KIND_LABEL = { image: '图片', voice: '语音', file: '文件', other: '非文本' };

// Match the end of the old visible conversation, rather than treating every
// changed pixel, unread badge or newly revealed old bubble as a new message.
function incomingDelta(previous, current, baselineReady = false) {
  if (!baselineReady) return { messages: [], baseline: true };
  if (!previous.length) return { messages: current.filter(m => m.direction === 'incoming'), baseline: false };
  for (let length = Math.min(previous.length, current.length); length > 0; length--) {
    const suffix = previous.slice(-length), ends = [];
    for (let start = 0; start + length <= current.length; start++) {
      if (suffix.every((key, i) => key === current[start + i].key)) ends.push(start + length);
    }
    if (ends.length > 1) return { messages: [], uncertain: true };
    if (ends.length === 1) return { messages: current.slice(ends[0]).filter(m => m.direction === 'incoming') };
  }
  return { messages: [], uncertain: true };
}

class WatchService {
  constructor({ journal, sensor, inspect, execute, propose, report, epoch, ready, canOperate = async () => true, emit = () => {}, clock = Date.now, autoSchedule = true }) {
    Object.assign(this, { journal, sensor, inspect, execute, propose, report, epoch, ready, canOperate, emit, clock, autoSchedule });
    this.items = new Map(); this.controllers = new Map(); this.runTokens = new Map();
    this.timer = null; this.checking = false; this.closed = false; this.restoreRevision = 0;
  }
  list() { return [...this.items.values()].map(w => ({ ...w, baseline: undefined, sources: undefined, privacyEpoch: undefined,
    pendingSend: undefined, pendingEventIds: undefined, pendingReports: undefined })); }
  publish() { this.emit(this.list()); }
  owns(w, signal, token) {
    return !this.closed && !signal?.aborted && this.items.get(w.id) === w &&
      (token === undefined || this.runTokens.get(w.id) === token) && w.privacyEpoch === this.epoch() && this.ready();
  }
  current(w, signal, token) { return this.owns(w, signal, token) && ACTIVE.has(w.status); }
  async save(w, guard = () => this.owns(w)) {
    if (!guard()) return false;
    w.updatedAt = this.clock();
    await this.journal.saveWatch(w);
    if (!guard()) return false;
    this.publish(); return true;
  }
  async restore() {
    const revision = ++this.restoreRevision, epoch = this.epoch();
    const watches = await this.journal.listWatches();
    if (this.closed || revision !== this.restoreRevision || epoch !== this.epoch() || !this.ready()) return;
    for (const value of watches) {
      if (this.closed || revision !== this.restoreRevision || epoch !== this.epoch() || !this.ready()) return;
      const w = { ...value, privacyEpoch: epoch, baseline: [], baselineReady: false, bound: false,
        pendingEventIds: Array.isArray(value.pendingEventIds) ? [...value.pendingEventIds] : [],
        pendingReports: Array.isArray(value.pendingReports) ? [...value.pendingReports] : [],
        status: value.userInterventionAt && ['stopped', 'paused'].includes(value.status) ? value.status
          : value.pendingSend ? 'paused' : value.expiresAt !== undefined && this.clock() >= value.expiresAt ? 'expired'
          : ['stopped', 'expired'].includes(value.status) ? value.status : 'paused',
        note: value.userInterventionAt ? value.note
          : value.pendingSend ? '应用已重启；上次发送结果不确定，已暂停且不会重发。请先核对微信。'
          : value.expiresAt !== undefined && this.clock() >= value.expiresAt ? '已达到交办时长'
          : ['stopped', 'expired'].includes(value.status) ? value.note : '应用已重启；恢复后重新建立基线，不自动回复离线期间的消息。' };
      this.items.set(w.id, w); this.runTokens.set(w.id, 0);
      await this.save(w, () => this.owns(w, undefined, 0) && revision === this.restoreRevision);
      if (!this.owns(w, undefined, 0) || revision !== this.restoreRevision) return;
      if (w.pendingSend && !w.pendingSendReported && !w.userInterventionAt) {
        const event = await this.journal.getEvent(w.pendingSend);
        if (!this.owns(w, undefined, 0) || revision !== this.restoreRevision) return;
        if (event) await this.reportEvent(w, event, event.reportText || `${w.recipient} 的自动回复结果不确定；应用已重启并暂停关注，请先核对微信。`, undefined, 0);
      } else if (!w.userInterventionAt) {
        for (const eventId of [...w.pendingReports, ...w.pendingEventIds]) {
          const event = await this.journal.getEvent(eventId);
          if (!this.owns(w, undefined, 0) || revision !== this.restoreRevision) return;
          if (!event) {
            w.pendingReports = w.pendingReports.filter(id => id !== eventId);
            w.pendingEventIds = w.pendingEventIds.filter(id => id !== eventId);
            await this.save(w, () => this.owns(w, undefined, 0) && revision === this.restoreRevision);
            if (!this.owns(w, undefined, 0) || revision !== this.restoreRevision) return;
            continue;
          }
          if (['send_pending', 'send_unknown'].includes(event.phase)) {
            w.pendingSend = event.id; w.status = 'paused'; w.note = '应用已重启；发现发送意图但结果不确定，已暂停且不会重发。请先核对微信。';
            await this.save(w, () => this.owns(w, undefined, 0) && revision === this.restoreRevision);
            if (!this.owns(w, undefined, 0) || revision !== this.restoreRevision) return;
            await this.reportEvent(w, event, event.reportText || `${w.recipient} 的自动回复结果不确定；应用已重启并暂停关注，请先核对微信。`, undefined, 0);
            break;
          }
          const text = event.reportText || `${w.recipient} 有一条新消息（${String(event.message || '').slice(0, 500)}）；应用重启后没有自动回复，请核对。`;
          await this.reportEvent(w, event, text, undefined, 0);
          if (!this.owns(w, undefined, 0) || revision !== this.restoreRevision) return;
          if (w.status === 'expired') break;
        }
      }
    }
    this.schedule();
  }
  async start({ recipient, recipientAliases = [], goal, criteria, watch, sources = [] }) {
    if (!this.ready()) return { ok: false, error: '请先解锁本地记忆' };
    if (!Array.isArray(sources) || !sources.length || sources.length > 200 || sources.some(id => typeof id !== 'string' || !id || id.length > 256) ||
        !recipient || !watch || !['notify', 'reply'].includes(watch.mode)) return { ok: false, error: '持续关注需要本轮交办来源和明确会话、规则' };
    if (watch.intervalSeconds !== undefined && (!Number.isSafeInteger(watch.intervalSeconds) || watch.intervalSeconds < 10 || watch.intervalSeconds > 300)) {
      return { ok: false, error: '检查间隔需在 10 到 300 秒之间' };
    }
    if (watch.durationMinutes !== undefined && (!Number.isSafeInteger(watch.durationMinutes) || watch.durationMinutes < 1 || watch.durationMinutes > 10080)) {
      return { ok: false, error: '持续时长需在 1 到 10080 分钟之间' };
    }
    if (watch.completion !== undefined && !['manual', 'first_match'].includes(watch.completion)) return { ok: false, error: '关注结束条件不合法' };
    const scopeError = checkDesktopScope('wechat', goal + '\n' + watch.policy);
    if (scopeError) return { ok: false, error: scopeError };
    if ([...this.items.values()].filter(w => !['stopped', 'expired'].includes(w.status)).length >= 4) return { ok: false, error: '最多同时保留四项持续关注，请先停止一项' };
    if ([...this.items.values()].some(w => w.recipient === recipient && !['stopped', 'expired'].includes(w.status))) return { ok: false, error: '已有关联该会话的持续关注，可暂停、恢复或停止后重新交代' };
    const now = this.clock();
    const w = { id: randomUUID(), target: 'wechat', recipient, recipientAliases, goal, criteria, mode: watch.mode, policy: watch.policy, completion: watch.completion || 'manual',
      intervalSeconds: watch.intervalSeconds ?? 10, ...(watch.durationMinutes === undefined ? {} : { expiresAt: now + watch.durationMinutes * 60000 }),
      status: 'waiting', note: '等待空闲时打开指定会话并建立基线', sources, privacyEpoch: this.epoch(), startedAt: now,
      eventCount: 0, baseline: [], baselineReady: false, pendingEventIds: [], pendingReports: [], nextCheckAt: now };
    this.items.set(w.id, w);
    this.runTokens.set(w.id, 0);
    try { await this.save(w, () => this.owns(w, undefined, 0)); } catch (e) { this.items.delete(w.id); this.runTokens.delete(w.id); return { ok: false, error: e.message }; }
    this.schedule(50); return { ok: true, id: w.id };
  }
  find({ id, recipient } = {}) {
    const rows = [...this.items.values()].filter(w => id ? w.id === id : recipient ? [w.recipient, ...(w.recipientAliases || [])].some(n => n.toLowerCase() === recipient.toLowerCase()) : !['stopped', 'expired'].includes(w.status));
    return rows.length === 1 ? rows[0] : null;
  }
  async control(action, selector) {
    if (!['status', 'resume', 'pause', 'stop'].includes(action)) return { ok: false, error: '不支持的持续关注操作' };
    const w = this.find(selector);
    if (!w) return { ok: false, error: '请明确要控制哪一项持续关注' };
    if (action === 'status') return { ok: true, watch: this.list().find(x => x.id === w.id) };
    if (action === 'resume' && w.pendingSend) return { ok: false, error: '上次发送结果不确定，请先核对微信；停止该关注后重新交代，不会自动重发' };
    const controlToken = (this.runTokens.get(w.id) || 0) + 1;
    this.runTokens.set(w.id, controlToken);
    this.controllers.get(w.id)?.abort();
    w.status = action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : 'waiting';
    w.note = w.pendingSend ? '上次自动回复结果不确定；已暂停且不会重发，请先核对微信。'
      : action === 'stop' ? '已停止关注' : action === 'pause' ? '已暂停；不会查看或回复新消息' : '重新建立当前基线；不补发历史消息';
    w.userInterventionAt = this.clock();
    if (action === 'resume') delete w.userInterventionAt;
    w.baseline = []; w.baselineReady = false; w.bound = false; w.nextCheckAt = this.clock();
    await this.sensor.forget(w).catch(() => {});
    if (!this.owns(w, undefined, controlToken)) return { ok: false, error: '持续关注状态已变化' };
    await this.save(w, () => this.owns(w, undefined, controlToken));
    if (!this.owns(w, undefined, controlToken)) return { ok: false, error: '持续关注状态已变化' };
    if (this.owns(w, undefined, controlToken) && ACTIVE.has(w.status)) this.schedule(50);
    return { ok: true };
  }
  schedule(delay = 1000) {
    if (!this.autoSchedule || this.closed) return;
    clearTimeout(this.timer); this.timer = setTimeout(() => this.tick().catch(() => {}).finally(() => this.schedule()), delay); this.timer.unref?.();
  }
  async tick(id) {
    if (this.closed || this.checking || !this.ready()) return { ok: false, error: '暂时不可检查' };
    this.checking = true;
    try {
      const candidates = [...this.items.values()].filter(w => ACTIVE.has(w.status) && (!id || w.id === id) && (id || this.clock() >= (w.nextCheckAt || 0)));
      for (const w of candidates) await this.check(w);
      return { ok: true };
    } finally { this.checking = false; }
  }
  async check(w) {
    const token = (this.runTokens.get(w.id) || 0) + 1; this.runTokens.set(w.id, token);
    const controller = new AbortController(); this.controllers.set(w.id, controller); const signal = controller.signal;
    const owned = () => this.owns(w, signal, token), valid = () => this.current(w, signal, token);
    let baselineBefore = [...(w.baseline || [])], baselineReadyBefore = !!w.baselineReady;
    let baselineSaved = false, pendingSendEvent = null, activeEvent = null;
    try {
      if (!valid()) return;
      if (w.pendingSend) {
        w.status = 'paused'; w.note = '自动回复结果不确定，已暂停且不会重发'; await this.save(w, owned);
        if (!owned()) return;
        const event = await this.journal.getEvent(w.pendingSend);
        if (!owned()) return;
        if (event) await this.reportEvent(w, event, event.reportText || `${w.recipient} 的自动回复结果不确定，已暂停且不会重发，请先核对微信。`, signal, token);
        return;
      }
      for (const eventId of [...(w.pendingReports || [])]) {
        if (!valid()) return;
        const event = await this.journal.getEvent(eventId);
        if (!valid()) return;
        if (!event) {
          w.pendingReports = w.pendingReports.filter(id => id !== eventId);
          w.pendingEventIds = (w.pendingEventIds || []).filter(id => id !== eventId);
          await this.save(w, owned);
          if (!valid()) return;
          continue;
        }
        const text = event.reportText || `${w.recipient} 有一条新消息；上次汇报未完成，请核对微信。`;
        await this.reportEvent(w, event, text, signal, token);
        if (!valid()) return;
      }
      if (w.expiresAt !== undefined && this.clock() >= w.expiresAt) {
        w.status = 'expired'; w.note = '已达到交办时长'; await this.save(w, owned); return;
      }
      if (!w.bound) {
        const mayOperate = await this.canOperate();
        if (!valid()) return;
        if (!mayOperate) { w.note = '等你停止输入后再打开会话'; return; }
        if (!valid()) return;
        const opened = await this.execute(w, { operation: 'open', signal });
        if (!valid()) return;
        if (!opened.ok) throw new Error(opened.error || '未能定位指定会话');
        w.bound = true;
      }
      const frame = await this.sensor.sample(w, { reset: !w.baselineReady, signal });
      if (!valid()) return;
      w.lastCheckedAt = this.clock();
      if (frame.unstable) { w.status = 'active'; w.note = '画面仍在变化，稍后再检查'; this.publish(); return; }
      if (!frame.changed && !frame.baseline && !frame.geometryChanged && !frame.windowChanged) { w.status = 'active'; w.quietChecks = (w.quietChecks || 0) + 1; w.note = '画面未变；未调用识别或模型'; this.publish(); return; }
      if (frame.windowChanged || frame.geometryChanged) {
        w.baseline = []; w.baselineReady = false;
        if (frame.windowChanged) { w.bound = false; w.status = 'waiting'; w.note = '目标窗口改变，重新绑定会话并建立基线'; }
        else { w.status = 'active'; w.note = '窗口布局改变，重新建立基线；本轮不判断新消息'; }
        await this.save(w, owned);
        if (!valid()) return;
        await this.sensor.commit(w);
        if (!valid()) return;
        return;
      }
      w.note = w.baselineReady ? '画面发生变化，正在核对新消息' : '正在建立当前会话基线';
      w.visionChecks = (w.visionChecks || 0) + 1; this.publish();
      const view = await this.inspect(w, frame, signal);
      if (!valid()) return;
      if (!view.headerMatched) {
        if (!valid()) return;
        await this.sensor.commit(w); // Sidebar changes are now consumed, not polled through the LLM again.
        if (!valid()) return;
        const mayOpenRecipient = view.recipientUnread ? await this.canOperate() : false;
        if (!valid()) return;
        if (view.recipientUnread && mayOpenRecipient) { w.bound = false; w.note = '指定会话出现未读提示，等待打开核对'; }
        else { w.note = '观察会话列表；指定会话出现可见未读提示时再核对'; }
        w.status = 'active'; await this.save(w, owned); return;
      }
      const messages = [];
      for (const m of view.messages) {
        const kind = ['text', 'image', 'voice', 'file', 'other'].includes(m.kind) ? m.kind : 'text';
        messages.push({ ...m, kind, key: this.journal.eventId(w.id, JSON.stringify([m.direction, kind, m.text, m.time || ''])) });
      }
      const delta = incomingDelta(w.baseline || [], messages, !!w.baselineReady);
      w.baseline = messages.map(m => m.key).slice(-16); w.baselineReady = true;
      w.status = 'active'; w.note = delta.baseline ? '已建立基线，只处理此后出现的新消息' : '正在关注新消息';
      if (delta.uncertain) {
        const identityString = JSON.stringify(['uncertain', w.baseline]);
        const event = { id: this.journal.eventId(w.id, identityString), identityString, phase: 'observed',
          text: '会话画面变化较大，无法可靠区分新旧消息；已重新建立基线，没有自动回复。', at: this.clock() };
        const existing = await this.journal.getEvent(event.id);
        if (!valid()) return;
        if (!existing) {
          w.pendingEventIds = [...new Set([...(w.pendingEventIds || []), event.id])];
          if (!await this.save(w, owned) || !valid()) return;
          baselineSaved = true;
          await this.journal.saveEvent(w, event);
          if (!valid()) return;
        }
        await this.reportEvent(w, existing || event, event.text, signal, token);
        if (!owned()) return;
      }
      if (delta.baseline) {
        if (!await this.save(w, owned) || !valid()) return;
        baselineSaved = true;
        await this.sensor.commit(w);
        if (!valid()) return;
        return;
      }
      for (const m of delta.messages) {
        if (!valid()) return;
        const identityString = JSON.stringify(['incoming-message', m.key]);
        const event = { id: this.journal.eventId(w.id, identityString), identityString, phase: 'observed',
          message: m.text, messageTime: m.time || null, at: this.clock() };
        let prior = await this.journal.getEvent(event.id);
        if (!valid()) return;
        if (prior) {
          if (prior.reportStatus === 'pending' && prior.reportText) {
            await this.reportEvent(w, { ...prior, identityString }, prior.reportText, signal, token);
            if (!valid()) return;
          } else if (['send_pending', 'send_unknown'].includes(prior.phase)) {
            w.pendingSend = event.id; w.status = 'paused'; w.note = '已发现发送意图记录；结果不确定，暂停且不会重发';
            await this.save(w, owned);
            if (!owned()) return;
            await this.reportEvent(w, prior, prior.reportText || `${w.recipient} 的自动回复结果不确定，已暂停且不会重发，请先核对微信。`, signal, token);
            return;
          }
          continue;
        }
        activeEvent = event;
        w.pendingEventIds = [...new Set([...(w.pendingEventIds || []), event.id])];
        if (!await this.save(w, owned) || !valid()) return;
        baselineSaved = true;
        await this.journal.saveEvent(w, event);
        if (!valid()) return;
        w.eventCount++; w.lastEventAt = this.clock();
        if (m.kind !== 'text') {
          await this.reportEvent(w, event, `${w.recipient} 发来一条${MESSAGE_KIND_LABEL[m.kind] || '非文本'}消息；没有自动回复，请查看微信。`, signal, token);
          if (!valid()) return; activeEvent = null; continue;
        }
        const decision = await this.propose(w, m, signal);
        if (!valid()) return;
        if (decision?.notify === false) {
          event.phase = 'filtered'; event.note = typeof decision.note === 'string' ? decision.note.slice(0, 300) : '';
          await this.journal.saveEvent(w, event);
          if (!valid()) return;
          w.pendingEventIds = (w.pendingEventIds || []).filter(id => id !== event.id);
          await this.save(w, owned);
          if (!valid()) return;
          activeEvent = null; continue;
        }
        const deliver = async text => {
          if (w.completion === 'first_match' && decision?.complete === true) {
            event.completeAfterReport = true; w.pendingCompletionEventId = event.id;
            if (!await this.save(w, owned) || !valid()) return { aborted: true, completed: false };
          }
          const reported = await this.reportEvent(w, event, text, signal, token);
          if (!owned() || !reported) return { aborted: true, completed: false };
          activeEvent = null;
          if (w.status === 'expired') {
            await this.sensor.commit(w);
            if (!owned()) return { aborted: true, completed: false };
            return { aborted: false, completed: true };
          }
          return { aborted: false, completed: false };
        };
        if (w.mode === 'notify') {
          const result = await deliver(`${w.recipient} 发来消息：${m.text}${decision?.note ? `。${String(decision.note).slice(0, 300)}` : ''}`);
          if (result.aborted || result.completed) return;
          continue;
        }
        const reply = typeof decision?.reply === 'string' ? decision.reply.trim() : '';
        if (!reply || reply.length > 3500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reply)) {
          const result = await deliver(`${w.recipient} 发来消息：${m.text}。${typeof decision?.note === 'string' && decision.note ? decision.note.slice(0, 300) : '需要你来决定如何回复。'}`);
          if (result.aborted || result.completed) return;
          continue;
        }
        const times = (w.replyTimes || []).filter(t => this.clock() - t < 3600000);
        const blockedByRate = (times.length && this.clock() - times.at(-1) < 60000) || times.length >= 10;
        const maySend = !blockedByRate && !view.draft && await this.canOperate();
        if (!valid()) return;
        if (!maySend) {
          const reason = view.draft ? '输入框已有草稿，交给你处理。' : blockedByRate ? '回复频率限制已触发，本次只汇报。' : '你正在操作电脑，本次没有自动回复。';
          const result = await deliver(`${w.recipient} 发来消息：${m.text}。${reason}`);
          if (result.aborted || result.completed) return;
          continue;
        }
        // Durable pre-send marker. Any interruption past here remains unknown;
        // no timer, restart or resume is allowed to replay this response.
        event.phase = 'send_pending'; event.reply = reply; w.pendingSend = event.id; delete w.pendingSendReported;
        await this.journal.saveEvent(w, event);
        if (!valid()) return;
        await this.save(w, owned);
        if (!valid()) return;
        pendingSendEvent = event;
        const sent = await this.execute(w, { operation: 'send', message: reply, signal });
        if (!valid()) return;
        if (!sent.ok) {
          event.phase = 'send_unknown'; w.status = 'paused'; w.note = '自动回复结果尚未确认，已暂停且不会重发';
          await this.journal.saveEvent(w, event);
          if (!owned()) return;
          await this.save(w, owned);
          if (!owned()) return;
          await this.reportEvent(w, event, event.reportText || `${w.recipient} 的自动回复结果不确定，已暂停关注，请查看微信。`, signal, token);
          return;
        }
        event.phase = 'sent_confirmed'; delete w.pendingSend; delete w.pendingSendReported; w.replyTimes = [...times, this.clock()];
        await this.journal.saveEvent(w, event);
        if (!valid()) return;
        await this.save(w, owned);
        if (!valid()) return;
        if (w.completion === 'first_match' && decision?.complete === true) {
          event.completeAfterReport = true; w.pendingCompletionEventId = event.id;
          await this.save(w, owned);
          if (!valid()) return;
        }
        const delivered = await this.reportEvent(w, event, `已按规则回复 ${w.recipient}：${reply}`, signal, token);
        if (!owned() || !delivered) return;
        pendingSendEvent = null; activeEvent = null;
        if (w.status === 'expired') {
          await this.sensor.commit(w);
          if (!owned()) return;
          return;
        }
      }
      if (!valid()) return;
      if (!await this.save(w, owned) || !valid()) return;
      baselineSaved = true;
      await this.sensor.commit(w);
      if (!valid()) return;
    } catch (error) {
      if (owned() && w.status !== 'expired') {
        if (!baselineSaved) { w.baseline = baselineBefore; w.baselineReady = baselineReadyBefore; }
        if (w.pendingSend) {
          w.status = 'paused'; w.note = '自动回复中断，结果不确定；已暂停且不会重发';
          if (pendingSendEvent) {
            pendingSendEvent.phase = 'send_unknown';
            await this.journal.saveEvent(w, pendingSendEvent).catch(() => {});
          }
        } else {
          w.status = 'needs_window'; w.note = String(error.message || '窗口暂不可用').slice(0, 180);
        }
        await this.save(w, owned).catch(() => {});
        if (owned() && w.pendingSend) {
          const event = pendingSendEvent || await this.journal.getEvent(w.pendingSend).catch(() => null);
          if (owned() && event) await this.reportEvent(w, event,
            event.reportText || `${w.recipient} 的自动回复结果不确定，已暂停且不会重发，请先核对微信。`, signal, token).catch(() => {});
        } else if (owned() && activeEvent) {
          await this.reportEvent(w, activeEvent,
            `${w.recipient} 发来消息，但本次关注中断，没有自动回复；请核对微信。`, signal, token).catch(() => {});
        }
      }
    } finally {
      if (this.controllers.get(w.id) === controller) this.controllers.delete(w.id);
      if (this.runTokens.get(w.id) === token && this.owns(w, undefined, token)) {
        if (ACTIVE.has(w.status)) w.nextCheckAt = this.clock() + (w.status === 'needs_window' ? Math.min(60, w.intervalSeconds * 3) : w.intervalSeconds) * 1000;
        this.publish();
      }
    }
  }
  async reportEvent(w, event, text, signal, token) {
    const owned = () => this.owns(w, signal, token) && !w.userInterventionAt;
    if (!owned() || !event?.id) return false;
    text = event.reportText || text;
    event.reportText = text; event.reportStatus = 'pending';
    if (event.identityString) await this.journal.saveEvent(w, event);
    if (!owned()) return false;
    w.pendingReports = [...new Set([...(w.pendingReports || []), event.id])];
    w.pendingEventIds = [...new Set([...(w.pendingEventIds || []), event.id])];
    if (!await this.save(w, owned) || !owned()) return false;
    const receipt = await this.journal.receipt(event, text);
    if (!owned()) return false;
    // The receiver deduplicates this stable eventId across a crash between
    // delivery and clearing the outbox entry.
    if (receipt.inserted) await this.report({ text, eventId: event.id, epoch: w.privacyEpoch, sources: [event.id], persisted: true });
    if (!owned()) return false;
    if (w.pendingSend === event.id) w.pendingSendReported = true;
    if (event.identityString) { event.reportStatus = 'reported'; await this.journal.saveEvent(w, event); }
    if (!owned()) return false;
    if (w.pendingCompletionEventId === event.id) {
      w.status = 'expired'; w.note = '已满足本次关注的完成条件'; delete w.pendingCompletionEventId;
    }
    w.pendingReports = (w.pendingReports || []).filter(id => id !== event.id);
    w.pendingEventIds = (w.pendingEventIds || []).filter(id => id !== event.id);
    await this.save(w, owned);
    return owned();
  }
  invalidate() {
    this.restoreRevision++;
    for (const [id, c] of this.controllers) { this.runTokens.set(id, (this.runTokens.get(id) || 0) + 1); c.abort(); }
    for (const w of this.items.values()) {
      w.status = 'paused'; w.note = '本地记忆或锁定状态发生变化，关注已暂停'; w.baseline = []; w.baselineReady = false; w.bound = false;
    }
    if ([...this.items.values()].some(w => w.privacyEpoch !== this.epoch())) this.items.clear();
    this.publish();
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.invalidate(); await this.sensor.close?.(); }
}

module.exports = { WatchService, incomingDelta };
