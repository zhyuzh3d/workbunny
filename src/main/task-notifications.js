'use strict';

const { createHash } = require('node:crypto');
const { readRecords } = require('./memory-evidence');
const { isOwner } = require('./message-identity');
const { rank, normalizeScene, canRead } = require('./memory-scope');
const { containsSecret } = require('./conversation-input');
const { normalizedName } = require('./contact-directory');
const ABNORMAL = new Set(['paused', 'failed', 'waiting', 'repeated-errors', 'stall', 'overdue', 'abandoned']);
const TTL = 15 * 60000, GAP = 20 * 60000;
const policyId = scene => 'task-notification-policy:' + normalizeScene(scene);
const message = kind => ({
  waiting: 'WorkBuddy 有一项任务需要你的信息或确认，请查看 Bunny 的工作与日常面板。',
  overdue: 'WorkBuddy 有一项任务已超过预计时间，Bunny 正在保留进度，请查看工作与日常面板。',
  stall: 'WorkBuddy 有一项任务较长时间没有新进展，请查看 Bunny 的工作与日常面板。',
})[kind] || 'WorkBuddy 有一项任务遇到阻碍，Bunny 已保留当前状态，请查看工作与日常面板。';

class TaskNotifications {
  constructor({ memory, deliver, canOperate = async () => false, ready = () => false, getScene = () => 'life', clock = Date.now } = {}) {
    Object.assign(this, { memory, deliver, canOperate, ready, getScene, clock });
    this.notes = new Map(); this.note = '尚无新的异常提醒'; this.running = null; this.controller = null; this.closed = false;
  }
  get note() { return this.notes.get(this.getScene()) || '尚无新的异常提醒'; }
  set note(value) { this.notes.set(this.getScene(), value); }
  async policy(scene = this.getScene()) {
    const row = (await readRecords(this.memory, [policyId(scene)], { scene }))[0];
    if (!row || row.state !== 'active' || !canRead(scene, row) || row.value.schema !== 'task-notification-policy/v1')
      return { enabled: true, recipient: '文件传输助手', sources: [] };
    return { enabled: row.value.enabled === true, recipient: row.value.recipient, sources: [row.id] };
  }
  async configure({ enabled = true, recipient }, { sourceId, scene = this.getScene() } = {}) {
    scene = normalizeScene(scene);
    if (!this.memory.ready || typeof sourceId !== 'string' || !sourceId) throw new Error('请先开启记忆，再保存异常通知对象。');
    if (typeof enabled !== 'boolean' || recipient !== undefined && (typeof recipient !== 'string' || !recipient.trim() || recipient.length > 100 || /[\u0000-\u001f\u007f]/u.test(recipient))) throw new Error('通知对象格式不正确，请明确微信显示名');
    const generation = this.memory.generation;
    const source = (await readRecords(this.memory, [sourceId], { scene }))[0];
    if (!source || source.state !== 'active' || source.kind !== 'message' || !isOwner(source.value) || !canRead(scene, source)) throw new Error('需要主人明确的通知设置原文');
    const prior = await this.policy(scene);
    if (recipient && (!normalizedName(source.value.content).includes(normalizedName(recipient)) || containsSecret(recipient))) throw new Error('通知对象必须由主人明确指定微信显示名');
    const instruction = source.value.content;
    if (!/通知|提醒/u.test(instruction) || enabled && (/不要|不必|禁止|不用|不需要|别|不得|不能|[“”「」]/u.test(instruction) || /^(?!我说)[^，。！？]{1,20}(?:说|让我|让你|要求你)/u.test(instruction))) throw new Error('请直接明确指定异常通知对象；否定或转述不会修改设置');
    recipient ||= prior.recipient;
    this.invalidate();
    if (generation !== this.memory.generation) throw new Error('通知设置来源已经变化');
    await this.memory.write([{ id: policyId(scene), kind: 'task', ts: this.clock(), domain: scene, visibilityFloor: rank(scene),
      value: { schema: 'task-notification-policy/v1', taskType: 'notification-policy', enabled, recipient, sources: [sourceId] } }]);
    this.notes.set(scene, '异常通知设置已更新');
    return enabled ? `异常微信提醒发给${recipient}` : '微信异常提醒已关闭，仍保留本地汇报';
  }
  async context(scene = this.getScene()) {
    const p = await this.policy(scene);
    const latest = (await this.memory.query('task', 1, { scene, sort: 'ingestion', requiredMarkers: ['bunny_task_notification_anchor'] }))[0];
    const note = this.notes.get(scene) || ({ pending: '有异常提醒等待空闲时处理', sending: '上次发送尚未确认，不会重发',
      sent: '上次异常提醒已在微信中确认发送', skipped: '上次微信提醒已跳过，保留本地汇报', unknown: '上次微信发送结果不确定，不会重发', cancelled: '上次待发提醒已撤销' })[latest?.value.state] || '尚无新的异常提醒';
    return { text: `异常通知设置（实际已保存）：${p.enabled ? '微信通知' + p.recipient : '微信通知已关闭'}；不推测其他收件人。${note}`,
      display: `${p.enabled ? '异常时微信通知：' + p.recipient : '微信异常提醒已关闭'}。${note}。可通过对话更改或关闭。`, sourceIds: [...p.sources, ...(latest ? [latest.id] : [])] };
  }
  async rows(scene = this.getScene()) {
    const result = []; let beforeSeq;
    for (;;) {
      const rows = await this.memory.query('task', 200, { scene, sort: 'ingestion', requiredMarkers: ['bunny_task_notification_anchor'], ...(beforeSeq ? { beforeSeq } : {}) });
      result.push(...rows.filter(r => r.state === 'active' && r.value.schema === 'task-notification/v1' && canRead(scene, r)));
      if (rows.length < 200) return result;
      beforeSeq = rows.at(-1).ingestionSeq;
    }
  }
  async enqueue(report) {
    if (this.closed || !this.ready() || report.target !== 'workbuddy') return;
    const scene = normalizeScene(report.scene || this.getScene());
    if (scene !== this.getScene() || report.epoch !== this.memory.generation) return;
    const key = report.taskId || report.key || report.eventId;
    if (!key) return;
    if (['accepted', 'done', 'ok', 'resolved', 'stopped', 'cancelled'].includes(report.status)) { await this.cancelTask(key); return; }
    await this.memory.serial(async () => {
      const generation = this.memory.generation, rows = await this.rows(scene), now = this.clock();
      if (!ABNORMAL.has(report.status)) {
        if (['accepted', 'done', 'ok', 'running', 'resolved'].includes(report.status)) {
          const old = rows.filter(r => r.value.key === key && r.value.state === 'pending');
          if (old.length) await this.memory.write(old.map(r => ({ ...r, value: { ...r.value, state: 'cancelled', note: '任务已有新进展' } })));
        }
        return;
      }
      if (rows.some(r => r.value.key === key && (['pending', 'sending', 'unknown'].includes(r.value.state) || now - (r.value.attemptedAt || r.ts) < GAP))) return;
      const p = await this.policy(scene);
      if (!p.enabled || generation !== this.memory.generation || report.epoch !== generation) return;
      const id = 'task-notification:' + createHash('sha256').update(String(key) + ':' + now).digest('hex');
      const sources = [...new Set([...(report.sources || []), ...p.sources])];
      await this.memory.write([{ id, kind: 'task', ts: now, domain: report.domain || scene, visibilityFloor: Math.max(rank(scene), report.visibilityFloor || 0),
        value: { schema: 'task-notification/v1', taskType: 'owner-notification', key, scene, state: 'pending', kind: report.status,
          text: message(report.status), expiresAt: now + TTL, sources } }]);
      this.notes.set(scene, '检测到任务异常，将在空闲时尝试微信提醒');
    });
  }
  tick() {
    if (this.running || this.closed) return this.running;
    this.running = this.run().catch(() => { this.note = '异常微信提醒未完成，请查看本地提示'; })
      .finally(() => { this.running = null; this.controller = null; this.activeKey = null; });
    return this.running;
  }
  async run() {
    if (!this.ready()) return;
    const scene = this.getScene(), generation = this.memory.generation;
    const controller = this.controller = new AbortController();
    const current = () => !this.closed && !controller.signal.aborted && this.ready() && scene === this.getScene() && generation === this.memory.generation;
    const rows = await this.rows(scene);
    for (const row of rows.filter(r => r.value.state === 'sending')) {
      if (!current()) return;
      await this.memory.write([{ ...row, value: { ...row.value, state: 'unknown', note: '上次发送可能已发生，不会重发' } }]);
    }
    const pending = rows.filter(r => r.value.state === 'pending').sort((a, b) => a.ts - b.ts);
    for (const row of pending) {
      if (!current()) return;
      const p = await this.policy(scene);
      const sources = await readRecords(this.memory, row.value.sources || [], { scene });
      if (!p.enabled || this.clock() > row.value.expiresAt || sources.length !== row.value.sources.length) {
        await this.memory.write([{ ...row, value: { ...row.value, state: 'cancelled', note: '提醒过期、已撤销或来源不可用' } }]); continue;
      }
      if (!await this.canOperate() || !current()) return;
      // Re-read after asynchronous idle/permission checks; a completion may
      // have cancelled the pending alert while the owner was still typing.
      const sending = await this.memory.serial(async () => {
        const fresh = (await readRecords(this.memory, [row.id], { scene }))[0], policy = await this.policy(scene);
        const evidence = await readRecords(this.memory, fresh?.value.sources || [], { scene });
        if (fresh?.value.state !== 'pending' || !current() || !policy.enabled || this.clock() > fresh.value.expiresAt ||
            evidence.length !== fresh.value.sources.length || evidence.some(r => r.state !== 'active')) return null;
        const next = { ...fresh, value: { ...fresh.value, state: 'sending', recipient: policy.recipient, attemptedAt: this.clock() } };
        this.activeKey = next.value.key;
        await this.memory.write([next]); return next;
      });
      if (!sending) continue;
      if (!current()) return;
      this.notes.set(scene, '正在通过微信发送异常提醒');
      let result;
      try { result = await this.deliver({ ...sending.value, id: row.id }, controller.signal); }
      catch { result = { state: 'unknown', note: '发送结果不确定，不会重发' }; }
      if (!current()) return;
      const state = ['sent', 'skipped', 'unknown'].includes(result?.state) ? result.state : 'unknown';
      this.note = state === 'sent' ? '异常提醒已在微信目标会话中确认发送' : state === 'skipped' ? '本次微信提醒已跳过，保留本地提示' : '微信发送结果不确定，不会重发';
      await this.memory.write([{ ...sending, value: { ...sending.value, state, note: this.note, finishedAt: this.clock() } }]);
      return;
    }
  }
  async cancelTask(key) {
    if (!key || !this.memory.ready) return;
    if (this.activeKey === key) this.invalidate();
    await this.memory.serial(async () => {
      if (this.activeKey === key) this.invalidate();
      const rows = (await this.rows()).filter(r => r.value.key === key && ['pending', 'sending'].includes(r.value.state));
      if (rows.length) await this.memory.write(rows.map(r => ({ ...r, value: { ...r.value,
        state: r.value.state === 'sending' ? 'unknown' : 'cancelled', note: '任务已暂停、取消或有新结果；不再继续发送此提醒' } })));
    });
  }
  invalidate() { this.controller?.abort(); this.notes.clear(); }
  close() { this.closed = true; this.invalidate(); return this.running; }
}
module.exports = { TaskNotifications, ABNORMAL };
