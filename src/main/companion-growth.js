'use strict';

// Versioned special memories in the existing encrypted Vault. A head contains
// pointers only; experiences and past revisions remain immutable evidence.
const { randomUUID, createHash } = require('node:crypto');
const { readRecords, snapshotsOf, verifySnapshots } = require('./memory-evidence');
const { rank, canRead, SCENES } = require('./memory-scope');
const { containsSecret } = require('./conversation-input');
const actors = require('./message-identity');
const refs = require('./memory-references');
const TYPES = ['user_model', 'relationship', 'strategy', 'pursuit'];
const FEELINGS = ['calm', 'curious', 'hopeful', 'pleased', 'disappointed', 'concerned'];
const MODEL_STATES = ['tentative', 'stable', 'recheck'];
const GOAL_STATES = ['active', 'paused', 'done', 'abandoned'];
const PARTITIONS = [['work', 0], ['work', 1], ['work', 2], ['life', 1], ['life', 2], ['private', 2]];
const headId = (domain, floor) => `growth:head:v1:${domain}:${floor}`;
const claimHash = (type, content, condition) => createHash('sha256').update(JSON.stringify([type, content, condition])).digest('hex');
const live = (r, now) => r && (r.state || 'active') === 'active' && (!r.expiresAt || r.expiresAt > now);
function text(s, max = 400, empty = false) {
  if (typeof s !== 'string' || (!empty && !s.trim()) || s.length > max || containsSecret(s) || /[\u0000-\u0008]/u.test(s)) throw new Error('invalid_growth_text');
  return s.trim();
}
function validEntry(r, now) {
  const v = r?.value;
  return live(r, now) && r.kind === 'state' && v?.schema === 'growth-entry/v1' && TYPES.includes(v.type) &&
    typeof v.entryId === 'string' && Number.isSafeInteger(v.revision) &&
    (v.type === 'pursuit' ? GOAL_STATES : MODEL_STATES).includes(v.status);
}
function present(r) {
  const v = r.value;
  return { id: r.id, entryId: v.entryId, revision: v.revision, type: v.type, content: v.content, condition: v.condition,
    status: v.status, feeling: v.feeling, nextStep: v.nextStep, selfEntryId: v.selfEntryId || null,
    lastVerifiedAt: v.lastVerifiedAt, reviewAfter: v.reviewAfter, support: v.support, counter: v.counter };
}
function validateRecord(r) {
  const v = r?.value;
  if (!['growth-head/v1', 'growth-entry/v1'].includes(v?.schema)) return;
  if (r.kind !== 'state') throw new Error('成长记忆类型不正确');
  if (v.schema === 'growth-head/v1') {
    if (r.id !== headId(r.domain, r.visibilityFloor) || !Number.isSafeInteger(v.revision) || !Array.isArray(v.entries) || v.entries.length > 14 ||
        v.entries.some(e => typeof e?.entryId !== 'string' || typeof e?.recordId !== 'string') || new Set(v.entries.map(e => e.entryId)).size !== v.entries.length ||
        !Array.isArray(v.removed || []) || (v.removed || []).some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/u.test(h))) throw new Error('成长控制记录不合法');
  } else {
    if (!validEntry({ ...r, state: 'active', expiresAt: null }, 0) || !FEELINGS.includes(v.feeling) ||
        !Number.isSafeInteger(v.lastVerifiedAt) || !Number.isSafeInteger(v.reviewAfter)) throw new Error('成长记忆格式不合法');
    text(v.content); text(v.condition, 160, true); text(v.nextStep, 240, true);
    for (const list of [v.support, v.counter]) {
      if (!Array.isArray(list) || list.length > 8 || list.some(q => typeof q.sourceId !== 'string' || !v.sources.includes(q.sourceId))) throw new Error('成长依据不合法');
      list.forEach(q => text(q.quote, 200));
    }
  }
}

class CompanionGrowth {
  constructor({ memory, clock = Date.now }) { Object.assign(this, { memory, clock }); }
  async view({ scene = this.memory.scene(), domain, visibilityFloor, budget = 3200, query = '' } = {}) {
    rank(scene);
    if (!this.memory.ready || !this.memory.getSettings().enabled) return { entries: [], rows: [], heads: [], text: '', sourceIds: [] };
    const partitions = PARTITIONS.filter(([d, f]) => f <= rank(scene) && (domain === undefined || d === domain) && (visibilityFloor === undefined || f === visibilityFloor));
    const ids = partitions.map(([d, f]) => headId(d, f));
    const heads = (await readRecords(this.memory, ids, { scene })).filter(r => live(r, this.clock()) && r.value.schema === 'growth-head/v1');
    heads.forEach(validateRecord);
    const records = await readRecords(this.memory, heads.flatMap(r => (r.value.entries || []).slice(0, 14).map(e => e.recordId)), { scene });
    const entries = records.filter(r => validEntry(r, this.clock()) && heads.some(h => h.domain === r.domain && h.visibilityFloor === r.visibilityFloor && h.value.entries.some(e => e.recordId === r.id && e.entryId === r.value.entryId)));
    entries.forEach(validateRecord);
    // A corrected, archived or expired piece of evidence cannot support a live
    // understanding, even before a later Dream revisits that understanding.
    const evidence = await readRecords(this.memory, [...new Set(entries.flatMap(r => r.value.sources || []))], { scene });
    const known = new Map(evidence.map(r => [r.id, r]));
    const safe = entries.filter(r => !containsSecret(JSON.stringify(present(r))) && r.value.sources.every(id => live(known.get(id), this.clock())));
    const lines = [], sourceIds = [];
    let remaining = Math.max(0, Math.min(6000, budget));
    const words = require('./vault-crypto').terms(query).filter(w => w.length >= 2).slice(0, 32);
    const relevance = r => words.reduce((n, w) => n + Number((r.value.content + r.value.condition + r.value.nextStep).includes(w)), 0);
    for (const r of safe.slice().sort((a, b) => relevance(b) - relevance(a) || b.updatedAt - a.updatedAt)) {
      const v = present(r), due = v.reviewAfter <= this.clock();
      const line = JSON.stringify({ id: v.id, type: v.type, content: v.content, condition: v.condition, status: v.status,
        nextStep: v.nextStep, feeling: v.feeling, lastVerifiedAt: v.lastVerifiedAt, needsReview: due,
        support: v.support.slice(-1), counter: v.counter.slice(-1) });
      if (line.length + 1 > remaining) continue;
      lines.push(line); remaining -= line.length + 1; sourceIds.push(r.id);
    }
    return { entries: safe.map(present), rows: safe, heads, expectedHeads: ids.map(id => heads.find(r => r.id === id) || { id }),
      text: lines.join('\n'), sourceIds };
  }

  // Prepare outside the serial commit. The returned guard is checked inside
  // CognitionRepository's atomic commit, including an initially absent head.
  async prepare(changes, { rows, view, self, domain, visibilityFloor, entities = [] } = {}) {
    const empty = { records: [], guard: async () => true };
    if (!Array.isArray(changes) || !changes.length || changes.length > 4 || !view) return empty;
    const now = this.clock(), key = headId(domain, visibilityFloor);
    const previous = view.heads.find(r => r.id === key);
    const expected = snapshotsOf([...(previous ? [previous] : []), ...view.rows]);
    const map = new Map(view.rows.map(r => [r.value.entryId, r]));
    const all = new Map(rows.map(r => [r.id, r]));
    const records = [], modified = new Set();
    for (const c of changes) {
      try {
        if (!c || !['add', 'replace'].includes(c.op) || c.op === 'add' && c.entryId) continue;
        const old = c.entryId ? map.get(c.entryId) : null;
        if (c.op === 'replace' && (!old || modified.has(c.entryId))) continue;
        const type = old?.value.type || c.type;
        if (!TYPES.includes(type) || c.type && c.type !== type) continue;
        const content = text(c.content), condition = text(c.condition || '', 160, true);
        if ((previous?.value.removed || []).includes(claimHash(type, content, condition))) continue;
        // Each new claim/change needs a verbatim quote from the consumed
        // prefix or an actual task receipt, never another generated summary.
        const checkQuotes = list => {
          if (!Array.isArray(list) || list.length > 4) throw new Error('invalid_growth_evidence');
          return list.map(q => {
            const r = all.get(q?.sourceId), quote = text(q?.quote, 200);
            if (quote.length < 3) throw new Error('invalid_growth_evidence');
            if (!live(r, now) || r.domain !== domain || r.visibilityFloor !== visibilityFloor ||
                !(r.kind === 'message' && (actors.isOwner(r.value) || type === 'pursuit' && actors.isBunny(r.value)) || type === 'pursuit' && r.kind === 'task') ||
                !String(r.value.content || r.value.goal || '').includes(quote)) throw new Error('invalid_growth_evidence');
            return { sourceId: r.id, quote };
          });
        };
        const support = checkQuotes(c.support || []), counter = checkQuotes(c.counter || []);
        if (!support.length && !counter.length) continue;
        const status = c.status || old?.value.status || (type === 'pursuit' ? 'active' : 'tentative');
        if (!(type === 'pursuit' ? GOAL_STATES : MODEL_STATES).includes(status)) continue;
        const merge = (a, b) => [...new Map([...a, ...b].map(q => [q.sourceId + '\n' + q.quote, q])).values()].slice(-8);
        const supports = merge(old?.value.support || [], support), counters = merge(old?.value.counter || [], counter);
        if (type !== 'pursuit' && status === 'stable' && new Set(supports.map(q => q.sourceId)).size < 2) continue;
        if (status === 'recheck' && !counters.length) continue;
        const selfEntryId = c.selfEntryId ?? old?.value.selfEntryId ?? null;
        if (selfEntryId && !self.entries.some(e => e.entryId === selfEntryId)) continue;
        const nextStep = text(c.nextStep || '', 240, type !== 'pursuit' || status !== 'active');
        const feeling = FEELINGS.includes(c.feeling) ? c.feeling : 'calm';
        if (type === 'pursuit' && ['done', 'abandoned'].includes(status) && !old) continue;
        if (type === 'pursuit' && status === 'done' && ![...support, ...counter].some(q => {
          const r = all.get(q.sourceId); return r?.kind === 'task' && (r.value.status === 'accepted' || r.value.verification?.verdict === 'pass') || r?.kind === 'message' && actors.isOwner(r.value);
        })) continue;
        const activeOthers = [...map.values()].filter(r => r.value.entryId !== old?.value.entryId && r.value.type === 'pursuit' && r.value.status === 'active');
        if (type === 'pursuit' && status === 'active' && activeOthers.length >= 3) continue;
        if (!old && [...map.values()].filter(r => r.value.type !== 'pursuit').length >= 8 && type !== 'pursuit') continue;
        if (!old && map.size >= 14) {
          const retired = [...map.values()].filter(r => r.value.type === 'pursuit' && ['done', 'abandoned'].includes(r.value.status)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
          if (!retired) continue;
          map.delete(retired.value.entryId);
        }
        if ([...map.values()].some(r => r.value.content === content && r.value.condition === condition && r.value.type === type && r.id !== old?.id)) continue;
        const entryId = old?.value.entryId || randomUUID(), revision = (old?.value.revision || 0) + 1;
        const sourceIds = [...new Set([...(old ? [old.id] : []), ...supports.map(q => q.sourceId), ...counters.map(q => q.sourceId), ...rows.map(r => r.id)])];
        if (sourceIds.length > 180) continue;
        const anchor = [...support, ...counter].map(q => all.get(q.sourceId)).sort((a, b) => b.ts - a.ts)[0];
        const refOptions = { at: anchor.value.occurredAt || anchor.ts, timezone: anchor.value.timezone, timeUnknown: !!anchor.value.timeUnknown, entities };
        const n = refs.normalize(content, refOptions), normalizedCondition = refs.normalize(condition, refOptions).canonical,
          normalizedStep = refs.normalize(nextStep, refOptions).canonical;
        text(n.canonical); text(normalizedCondition, 160, true); text(normalizedStep, 240, true);
        if ((previous?.value.removed || []).includes(claimHash(type, n.canonical, normalizedCondition))) continue;
        const referenceSources = n.references.entities.map(e => e.sourceId).filter(Boolean);
        const lastVerifiedAt = Math.max(...[...support, ...counter].map(q => { const r = all.get(q.sourceId); return r.value.occurredAt || r.ts; }));
        const record = { id: 'growth-entry:' + entryId + ':' + revision + ':' + randomUUID().slice(0, 8), kind: 'state', ts: now,
          updatedAt: now, domain, visibilityFloor, value: { schema: 'growth-entry/v1', origin: 'companion-growth-v1', entryId, revision, type,
            content: n.canonical, condition: normalizedCondition, status, nextStep: normalizedStep, feeling, selfEntryId, support: supports, counter: counters,
            references: n.references, lastVerifiedAt,
            reviewAfter: lastVerifiedAt + (type === 'pursuit' ? 7 : status === 'stable' ? 30 : 7) * 86400000, sources: [...new Set([...sourceIds, ...referenceSources])] } };
        records.push(record); map.set(entryId, record); modified.add(entryId);
      } catch { /* Invalid optional learning cannot discard valid memories. */ }
    }
    if (!records.length) return empty;
    records.push({ id: key, kind: 'state', ts: 0, updatedAt: now, domain, visibilityFloor,
      value: { schema: 'growth-head/v1', revision: (previous?.value.revision || 0) + 1, removed: previous?.value.removed || [],
        entries: [...map.values()].map(r => ({ entryId: r.value.entryId, recordId: r.id })), sources: [] } });
    return { records, guard: async () => (await verifySnapshots(this.memory, expected)).ok &&
      (previous ? true : !(await readRecords(this.memory, [key])).length) };
  }

  async dismiss(entryId, { scene = this.memory.scene() } = {}) {
    return this.memory.serial(async () => {
      const view = await this.view({ scene }), row = view.rows.find(r => r.value.entryId === entryId);
      if (!row || !canRead(scene, row)) throw new Error('这条认识或目标已变化，请刷新');
      const h = view.heads.find(r => r.id === headId(row.domain, row.visibilityFloor));
      // The head withdraws the whole logical entry. Also archive recent history
      // so old feedback cannot reintroduce it. Source-level erasure stays with Vault.
      const history = await this.memory.search(entryId, ['state'], 50, { scene, domain: row.domain, visibilityFloor: row.visibilityFloor, requiredMarkers: ['bunny_growth_entry'] });
      await this.memory.write([{ ...h, updatedAt: this.clock(), value: { ...h.value, revision: h.value.revision + 1,
        removed: [...new Set([...(h.value.removed || []), claimHash(row.value.type, row.value.content, row.value.condition)])].slice(-100),
        entries: h.value.entries.filter(e => e.entryId !== entryId) } }, ...new Map([...history, row].filter(r => r.value.schema === 'growth-entry/v1' && r.value.entryId === entryId)
        .map(r => [r.id, { ...r, state: 'archived' }])).values()]);
      await this.memory.notifyChange();
      return true;
    });
  }
}
module.exports = { CompanionGrowth, TYPES, FEELINGS, headId, validEntry, present, validateRecord };
