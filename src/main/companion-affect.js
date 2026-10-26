'use strict';

// Small deterministic affect state. serialize() contains private event IDs and
// scope metadata: persist it only in the encrypted private/2 state record.
// snapshot() is internal numeric state; only project() is prompt-safe output.
const { timeContext } = require('./companion-time');

const VERSION = 2;
const MAX_EVENTS = 32;
const MAX_TOTAL_EVENTS = MAX_EVENTS * 3;
const HALF_LIFE_MS = 90 * 60_000;
const MAX_EVENT_AGE_MS = 12 * 60 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_BUDGET = 0.55;
const MAX_SIGNAL = 0.65;
const SCENE_RANK = Object.freeze({ work: 0, life: 1, private: 2 });
const SIGNALS = Object.freeze({
  gentle: { valence: -0.12, arousal: -0.10, energy: -0.08 },
  uplift: { valence: 0.18, arousal: 0.10, energy: 0.08 },
  'task-pass': { valence: 0.16, arousal: 0.07, energy: 0.05 },
  'task-fail': { valence: -0.10, arousal: 0.04, energy: -0.07 },
});

function finiteTime(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function cleanId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : ''; }
function cleanEventId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : ''; }

function normalizeScope(source) {
  const scope = source && typeof source === 'object' ? source : {};
  const domain = scope.domain;
  const visibilityFloor = Number(scope.visibilityFloor);
  if (!Object.hasOwn(SCENE_RANK, domain) || !Number.isInteger(visibilityFloor) ||
      visibilityFloor < SCENE_RANK[domain] || visibilityFloor > 2) return null;
  const sourceId = cleanId(scope.sourceId || scope.id || scope.taskId);
  const ts = finiteTime(scope.ts, null);
  if (!sourceId || ts === null) return null;
  return { sourceId, domain, visibilityFloor, ts };
}

function normalizedEvent(event) {
  if (!event || typeof event !== 'object' || !Object.hasOwn(SIGNALS, event.kind)) return null;
  const sourceId = cleanId(event.sourceId), id = cleanEventId(event.id);
  const ts = finiteTime(event.ts, null);
  const visibilityFloor = Number(event.visibilityFloor);
  if (!id || !sourceId || ts === null || !Object.hasOwn(SCENE_RANK, event.domain) ||
      !Number.isInteger(visibilityFloor) || visibilityFloor < SCENE_RANK[event.domain] || visibilityFloor > 2 ||
      typeof event.intensity !== 'number' || !Number.isFinite(event.intensity) || event.intensity < 0 || event.intensity > 1) return null;
  return { id, sourceId, domain: event.domain, visibilityFloor, ts, kind: event.kind, intensity: event.intensity };
}

/**
 * API contract:
 * - observeMessage(text, sourceRecord) where sourceRecord is {id,ts,domain,visibilityFloor}
 * - observeTask({verified:true, verdict:'pass'|'fail'}, taskScope) with the same source fields
 * - forget(sourceIds), serialize(now), hydrate(state), snapshot(now), project(scene,now,{sourceIds})
 * snapshot is internal only; pass only project(...).prompt into a model context.
 */
class CompanionAffect {
  constructor({ clock = Date.now, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, state } = {}) {
    this.clock = clock;
    this.timezone = typeof timezone === 'string' && timezone ? timezone : 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: this.timezone }); } catch { this.timezone = 'UTC'; }
    this.events = [];
    this.lastNow = finiteTime(clock(), 0);
    this.rateByFloor = Object.fromEntries([0, 1, 2].map(floor => [floor, { windowStart: this.lastNow, used: 0 }]));
    if (state) this.hydrate(state);
  }

  logicalNow(now = this.clock()) {
    const candidate = finiteTime(now, this.lastNow);
    this.lastNow = Math.max(this.lastNow, candidate);
    return this.lastNow;
  }

  record(kind, source, requestedIntensity, suffix = '') {
    if (!Object.hasOwn(SIGNALS, kind)) return false;
    const scope = normalizeScope(source);
    if (!scope) return false;
    const now = this.logicalNow();
    const id = `${suffix ? 'verified-task-result' : kind}:${scope.sourceId}`;
    if (this.events.some(event => event.sourceId === scope.sourceId)) return false;

    const budget = this.rateByFloor[scope.visibilityFloor];
    if (now - budget.windowStart >= RATE_WINDOW_MS) {
      budget.windowStart = now;
      budget.used = 0;
    }
    const requested = clamp(Number(requestedIntensity) || 0, 0, 1);
    const intensity = Math.min(requested, RATE_BUDGET - budget.used);
    budget.used += intensity;
    const event = { id, sourceId: scope.sourceId, domain: scope.domain, visibilityFloor: scope.visibilityFloor,
      ts: Math.min(scope.ts, now), kind, intensity: clamp(intensity, 0, 1) };
    this.events.push(event);
    const floorEvents = this.events.filter(item => item.visibilityFloor === scope.visibilityFloor);
    if (floorEvents.length > MAX_EVENTS) {
      const drop = new Set(floorEvents.slice(0, floorEvents.length - MAX_EVENTS).map(item => item.id));
      this.events = this.events.filter(item => !drop.has(item.id));
    }
    return true;
  }

  observeMessage(text, source) {
    if (typeof text !== 'string' || !text.trim()) return false;
    // These cues only shape Bunny's expression. They do not classify or store
    // the user's emotional state, and no source text is retained here.
    if (/(?:谢谢|感谢|太好了|开心|顺利|成功|喜欢你|轻松多了)/u.test(text)) return this.record('uplift', source, 0.7);
    if (/(?:难过|伤心|焦虑|压力很大|烦死|疲惫|累了|受挫|不顺)/u.test(text)) return this.record('gentle', source, 0.7);
    return false;
  }

  observeTask(verifiedResult, scope) {
    if (!verifiedResult || verifiedResult.verified !== true) return false;
    const verdict = verifiedResult.verdict;
    if (verdict !== 'pass' && verdict !== 'fail') return false;
    return this.record(verdict === 'pass' ? 'task-pass' : 'task-fail', scope, 0.65, ':verified-result');
  }

  forget(sourceIds) {
    const forget = new Set((Array.isArray(sourceIds) ? sourceIds : []).filter(cleanId));
    if (!forget.size) return 0;
    const before = this.events.length;
    this.events = this.events.filter(event => !forget.has(event.sourceId));
    return before - this.events.length;
  }

  visibleEvents(scene, now = this.clock(), sourceIds) {
    const rank = SCENE_RANK[scene];
    if (!Number.isInteger(rank)) throw new Error('未知的情绪表达场景');
    const time = this.logicalNow(now);
    this.events = this.events.filter(event => time - event.ts <= MAX_EVENT_AGE_MS);
    const allowedSources = sourceIds === undefined ? null : sourceIds instanceof Set ? sourceIds :
      Array.isArray(sourceIds) ? new Set(sourceIds.filter(cleanId)) : new Set();
    return this.events.filter(event => event.visibilityFloor <= rank && (!allowedSources || allowedSources.has(event.sourceId)))
      .map(event => ({ event, weight: Math.exp(-Math.LN2 * Math.max(0, time - event.ts) / HALF_LIFE_MS) }));
  }

  aggregate(events) {
    const result = { valence: 0, arousal: 0, energy: 0 };
    for (const { event, weight } of events) {
      const signal = SIGNALS[event.kind];
      for (const key of Object.keys(result)) result[key] += signal[key] * event.intensity * weight;
    }
    for (const key of Object.keys(result)) result[key] = clamp(result[key], -MAX_SIGNAL, MAX_SIGNAL);
    return result;
  }

  snapshot(now = this.clock()) {
    return this.aggregate(this.visibleEvents('private', now));
  }

  rhythm(now) {
    const local = timeContext(now, this.timezone);
    const cues = [];
    if (local.hour < 5) cues.push('当地是凌晨，表达轻一些');
    else if (local.hour < 9) cues.push('当地是早晨，语气自然舒缓');
    else if (local.hour >= 22) cues.push('当地已是夜间，适当安静');
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, weekday: 'short' }).format(new Date(now));
    if (weekday === 'Sat' || weekday === 'Sun') cues.push('当地日期是周末，不推断是否休息');
    if (local.holiday) cues.push(`历法显示今天是${local.holiday}，不推断是否放假或庆祝`);
    return cues.length ? `生活节律：${cues.join('；')}。` : '生活节律：按当地时间自然交流，不推断作息。';
  }

  project(scene, now = this.clock(), { sourceIds } = {}) {
    const logicalNow = this.logicalNow(now);
    const state = this.aggregate(this.visibleEvents(scene, logicalNow, sourceIds));
    let expression = '表达平和自然，简短陪伴。';
    if (state.valence <= -0.05 || state.energy <= -0.04) expression = '语气温和克制，继续把眼前事情做好。';
    else if (state.valence >= 0.08) expression = '语气可以明快一点，保持自然。';
    else if (state.arousal >= 0.07) expression = '表达稍有活力，保持简洁。';
    return { prompt: `${this.rhythm(logicalNow)}表达状态：${expression}这些状态不改变任务优先级、授权、模型、验收标准或执行次数；不编造生活经历。` };
  }

  serialize(now = this.clock()) {
    this.logicalNow(now);
    return { version: VERSION, lastNow: this.lastNow,
      rateByFloor: Object.fromEntries(Object.entries(this.rateByFloor).map(([floor, value]) => [floor, { ...value }])),
      events: this.events.map(event => ({ ...event })) };
  }

  hydrate(value) {
    if (!value || typeof value !== 'object' || ![1, VERSION].includes(value.version) || !Array.isArray(value.events) ||
        value.events.length > (value.version === 1 ? MAX_EVENTS : MAX_TOTAL_EVENTS))
      throw new Error('情绪状态格式不合法');
    const events = value.events.map(normalizedEvent);
    if (events.some(event => !event)) throw new Error('情绪状态事件格式不合法');
    if (new Set(events.map(event => event.sourceId)).size !== events.length) throw new Error('情绪状态来源重复');
    const now = finiteTime(value.lastNow, 0);
    this.events = events;
    this.lastNow = Math.max(now, ...events.map(event => event.ts));
    if (value.version === 1) {
      const windowStart = finiteTime(value.rateWindowStart, this.lastNow);
      if (typeof value.rateUsed !== 'number' || !Number.isFinite(value.rateUsed) || value.rateUsed < 0 || value.rateUsed > RATE_BUDGET)
        throw new Error('情绪状态限幅数据不合法');
      const rateByFloor = Object.fromEntries([0, 1, 2].map(floor => [floor, { windowStart: Math.min(windowStart, this.lastNow), used: 0 }]));
      for (const event of events) {
        if (event.ts >= windowStart && event.ts <= this.lastNow) rateByFloor[event.visibilityFloor].used += event.intensity;
      }
      const visibleUse = rateByFloor[0].used + rateByFloor[1].used + rateByFloor[2].used;
      // V1 had a shared bucket. Unattributed usage is conservatively charged
      // only to private/floor 2 so it cannot suppress work or life expression.
      rateByFloor[2].used = Math.max(rateByFloor[2].used, value.rateUsed - rateByFloor[0].used - rateByFloor[1].used,
        rateByFloor[2].used + Math.max(0, value.rateUsed - visibleUse));
      for (const floor of [0, 1, 2]) rateByFloor[floor].used = Math.min(RATE_BUDGET, rateByFloor[floor].used);
      this.rateByFloor = rateByFloor;
    } else {
      const next = {};
      for (const floor of [0, 1, 2]) {
        const bucket = value.rateByFloor?.[floor];
        const windowStart = finiteTime(bucket?.windowStart, this.lastNow);
        if (typeof bucket?.used !== 'number' || !Number.isFinite(bucket.used) || bucket.used < 0 || bucket.used > RATE_BUDGET)
          throw new Error('情绪状态限幅数据不合法');
        next[floor] = { windowStart: Math.min(windowStart, this.lastNow), used: bucket.used };
      }
      this.rateByFloor = next;
    }
    return this;
  }
}

module.exports = { CompanionAffect, MAX_EVENTS, MAX_TOTAL_EVENTS, HALF_LIFE_MS, MAX_EVENT_AGE_MS, RATE_WINDOW_MS, RATE_BUDGET };
