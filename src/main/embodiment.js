'use strict';
const { randomUUID } = require('node:crypto');
const REASONS = new Set(['reply', 'manual', 'touch', 'autonomy', 'thinking', 'idle', 'work']);
class Embodiment {
  constructor({ catalog, avatar, send, persist = async () => {}, clock = Date.now, timeoutMs = 10000 }) {
    Object.assign(this, { catalog, avatar, send, persist, clock, timeoutMs }); this.recent = []; this.pending = new Map(); this.capabilities = null; this.posture = 'standing'; this.postureAvatar = null;
  }
  perform(selector, reason = 'reply', options = {}) {
    const avatarKey = this.avatar()?.key;
    if (this.postureAvatar !== avatarKey) { this.postureAvatar = avatarKey; this.posture = 'standing'; }
    if (this.avatar()?.kind !== 'avatar-pack' && ((selector === 'hq_world_sit_enter' && this.posture === 'sitting') || (selector === 'hq_world_sit_exit' && this.posture === 'standing'))) return Promise.resolve({ ok: true, alreadyInPosture: true });
    const allowPostureChange = reason === 'manual' || options.allowPostureChange === true;
    const motion = this.catalog.select(selector, { posture: this.posture, allowPostureChange, manual: reason === 'manual', autonomous: ['autonomy', 'idle', 'work', 'thinking', 'touch'].includes(reason), reason }); if (!motion) return Promise.resolve({ ok: false, error: '动作不存在、已禁用或该分类没有可随机使用的动作' });
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: '动作尚未加载完成' }); }, this.timeoutMs);
      this.pending.set(id, { key: motion.key, avatar: this.avatar()?.key, reason, resolve, timer });
      this.send({ key: motion.key, requestId: id, reason, allowPostureChange });
    });
  }
  report(event) {
    if (!event || event.avatar !== this.avatar()?.key) return false;
    const request = this.pending.get(event.requestId), motion = this.catalog.catalog().motions.find(m => m.key === event.key && m.enabled);
    if (request && (request.avatar !== event.avatar || request.key !== event.key || event.ok === false)) {
      clearTimeout(request.timer); this.pending.delete(event.requestId); request.resolve({ ok: false, error: '请求的动作未能实际播放' }); return false;
    }
    if (!motion || event.ok === false) return false;
    const record = { key: motion.key, label: motion.label, category: motion.slot, avatar: event.avatar,
      reason: request?.reason || (REASONS.has(event.reason) ? event.reason : 'idle'), at: this.clock() };
    const previous = this.recent.at(-1);
    if (request || !previous || previous.avatar !== record.avatar || previous.key !== record.key || record.at - previous.at > 500) {
      this.recent.push(record); this.recent = this.recent.slice(-5); Promise.resolve(this.persist(this.recent)).catch(() => {});
    }
    if (request) { clearTimeout(request.timer); this.pending.delete(event.requestId); request.resolve({ ok: true, motion: record }); }
    return true;
  }
  setPosture(event) { if (event?.avatar === this.avatar()?.key && ['standing', 'sitting'].includes(event.posture)) { this.postureAvatar = event.avatar; this.posture = event.posture; } }
  avatarChanged() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: '形象已切换' }); }
    this.pending.clear(); this.capabilities = null; this.postureAvatar = null; this.posture = 'standing';
  }
  snapshot() { return { posture: this.posture, avatar: this.avatar(), recentActions: this.recent.map(r => ({ ...r })), capabilities: this.capabilities }; }
  context() {
    const avatar = this.avatar();
    return { posture: this.posture, appearance: avatar ? { name: avatar.name, description: avatar.description } : null,
      recentActions: this.recent.map(r => ({ action: r.label, secondsAgo: Math.max(0, Math.round((this.clock() - r.at) / 1000)), cause: r.reason })),
      expressions: this.capabilities?.expressions || [] };
  }
  restore(rows) { this.recent = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r.key === 'string' && Number.isFinite(r.at)).slice(-5); }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: '动作已取消' }); } this.pending.clear(); }
}
module.exports = { Embodiment };
