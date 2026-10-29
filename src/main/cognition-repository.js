'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { readRecords, snapshotsOf, verifySnapshots } = require('./memory-evidence');
const { containsSecret } = require('./conversation-input');
const actors = require('./message-identity');
const HEAD = 'bunny-self:head:v1';
const PRIVATE = Object.freeze({ domain: 'private', visibilityFloor: 2 });
const FACETS = ['identity', 'trait', 'value', 'behavior', 'interest'];
const MAX_ENTRIES = 40, MAX_TEXT = 400, MAX_TOTAL = 6000;
const clean = (text, max = MAX_TEXT) => {
  if (typeof text !== 'string' || !text.trim() || text.length > max || containsSecret(text)) throw new Error('自我理解内容为空、过长或含秘密');
  return text.trim();
};
const err = (code, text) => Object.assign(new Error(text), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function abstractSelf(text, condition = '', sourceRows = [], entities = []) {
  const combined = `${text}\n${condition}`;
  if (containsSecret(combined) || /https?:\/\/|\b\d{5,}\b|\d{4}[-年/]\d|(?:主人|用户|他|她)(?:住在|出生于|电话|账号|密码|叫|姓|的(?:名字|地址|生日|公司|职业|病))|(?:主人|用户)(?:与|和|跟)[^，。；\n]{1,30}/u.test(combined)) return false;
  const anchors = new Set(entities.flatMap(e => [e.name, ...(e.aliases || [])]).filter(n => typeof n === 'string' && n.length >= 2));
  for (const row of sourceRows) {
    const source = String(row.value?.content || row.value?.text || '');
    for (const e of row.value?.references?.entities || []) if (e.name?.length >= 2) anchors.add(e.name);
    for (const m of source.matchAll(/(?:我|主人|用户|他|她)(?:和|与|跟)([\p{L}·]{2,16}?)(?=在|去|说|聊|谈|一起|[，。；])/gu)) anchors.add(m[1]);
    for (const m of source.matchAll(/(?:住在|位于|来自|去了?|在)([\p{L}·]{2,24}?(?:市|省|县|区|路|街|巷|村|镇|岛|湾|湖|山谷))(?=[^\p{L}]|很|谈|开|见|工作|生活|居住|$)/gu)) anchors.add(m[1]);
    for (const m of source.matchAll(/(?:住在|位于|来自|去了)([\p{L}·]{2,20}?)(?=[，。；\n]|很|工作|生活|居住|$)/gu)) anchors.add(m[1]);
  }
  return ![...anchors].some(name => combined.includes(name));
}
function explicitSelfRequest(text) {
  return typeof text === 'string' && !containsSecret(text) &&
    /自我理解|你的人格|你的性格|你的行为约定|你对自己的/u.test(text) &&
    /添加|增加|加入|写入|记下|调整|更新|修改|改成|改为|记住|删除|移除|锁定|解锁|保持/u.test(text) &&
    !/(?:不要|别|不必|无需).{0,12}(?:添加|增加|更新|修改|删除|移除|锁定|解锁)|(?:如果|假如|假设|例如|比如).{0,30}(?:自我理解|人格)|[“「『"].*(?:自我理解|你的人格).*[”」』"]/u.test(text);
}
function validateRecord(record) {
  const v = record.value, schema = v?.schema;
  if (record.id !== HEAD && !['self-head/v1', 'self-entry/v1', 'self-settings/v1'].includes(schema)) return;
  if (record.domain !== 'private' || record.visibilityFloor !== 2) throw new Error('自我理解必须保存在加密私有区');
  if (schema === 'self-head/v1') {
    if (record.id !== HEAD || record.kind !== 'state' || !Number.isSafeInteger(v.revision) || v.revision < 1 || typeof v.locked !== 'boolean' ||
        !Array.isArray(v.entries) || v.entries.length > MAX_ENTRIES || v.entries.some(e => !e || typeof e.entryId !== 'string' || typeof e.recordId !== 'string') ||
        new Set(v.entries.map(e => e.entryId)).size !== v.entries.length || !Array.isArray(v.locks) || v.locks.some(e => typeof e !== 'string') ||
        !Array.isArray(v.removed) || v.removed.some(e => typeof e !== 'string')) throw new Error('自我理解控制记录损坏');
  } else if (schema === 'self-entry/v1') {
    if (record.kind !== 'persona' || v.group !== 'bunny-self' || typeof v.entryId !== 'string' || v.entryId.length > 100 ||
        !Number.isSafeInteger(v.revision) || v.revision < 1 || !FACETS.includes(v.facet)) throw new Error('自我理解条目格式不正确');
    clean(v.text); if (v.condition) clean(v.condition, 160);
  } else if (schema === 'self-settings/v1') {
    if (record.kind !== 'persona' || typeof v.identity !== 'string' || typeof v.behavior !== 'string') throw new Error('身份与行为输入格式不正确');
    if (v.identity) clean(v.identity, 2000); if (v.behavior) clean(v.behavior, 2000);
  } else throw new Error('自我理解版本不受支持');
}
class CognitionRepository {
  constructor({ memory, clock = Date.now, onChange = () => {} }) { Object.assign(this, { memory, clock, onChange }); }
  async _read() {
    const head = (await readRecords(this.memory, [HEAD]))[0];
    if (!head) return null;
    validateRecord(head);
    const h = head.value;
    if (h.schema !== 'self-head/v1' || !Number.isSafeInteger(h.revision) || !Array.isArray(h.entries) || h.entries.length > MAX_ENTRIES ||
        !Array.isArray(h.locks) || !Array.isArray(h.removed) || typeof h.locked !== 'boolean') throw new Error('自我理解控制记录损坏');
    const tag = digest([h, this.memory.generation, this.memory.epoch]);
    if (this.roleCache?.tag === tag) return { ...structuredClone(this.roleCache.state), head };
    const rows = await readRecords(this.memory, h.entries.map(e => e.recordId));
    rows.forEach(validateRecord);
    const entries = h.entries.flatMap(ref => {
      const r = rows.find(row => row.id === ref.recordId && row.kind === 'persona' && row.state === 'active' &&
        row.value.schema === 'self-entry/v1' && row.value.group === 'bunny-self' && row.value.entryId === ref.entryId);
      return r ? [{ ...r.value, recordId: r.id, locked: h.locks.includes(ref.entryId) }] : [];
    });
    const settings = h.settingsId ? (await readRecords(this.memory, [h.settingsId]))[0] : null;
    const learned = entries.filter(e => e.origin === 'dream-learning');
    const evidence = learned.length ? await readRecords(this.memory, [...new Set(learned.flatMap(e => e.sources || []))]) : [];
    const entities = learned.length ? await this.memory.entityAnchors?.('private') || [] : [];
    const safeEntries = entries.filter(e => e.origin !== 'dream-learning' ||
      !evidence.some(r => e.sources.includes(r.id) && r.state !== 'active') && abstractSelf(e.text, e.condition, evidence.filter(r => e.sources.includes(r.id)), entities));
    const state = { head, h, entries: safeEntries, settings };
    this.roleCache = { tag, state: structuredClone(state) };
    return state;
  }
  async ensure(persona = {}) {
    return this.memory.serial(async () => {
      let state = await this._read();
      if (state) return this._view(state);
      const identity = String(persona.profile || '我温和、好奇、有自己的看法，愿意认真倾听，也愿意与你一起把事情做好。').slice(0, 2000);
      const settingsId = 'self-settings:' + randomUUID(), now = this.clock();
      const legacy = Object.entries(persona.sceneProfiles || {}).filter(([, text]) => text && !containsSecret(text))
        .map(([scene, text]) => ({ scene, text: String(text).slice(0, 1000) }));
      const settings = { schema: 'self-settings/v1', identity: identity ? clean(identity, 2000) : '', behavior: '', legacy, sources: [] };
      await this.memory.write([{ id: settingsId, kind: 'persona', ts: now, ...PRIVATE, value: settings }]);
      const entries = identity.match(/[\s\S]{1,400}/gu).map((text, i) => {
        const entryId = randomUUID(), recordId = 'self-entry:' + entryId + ':1';
        return { id: recordId, kind: 'persona', ts: now + i, ...PRIVATE, value: { schema: 'self-entry/v1', group: 'bunny-self',
          entryId, revision: 1, facet: 'identity', text: clean(text), condition: '', origin: 'migration', sources: [settingsId] } };
      });
      await this.memory.write([...entries,
        { id: HEAD, kind: 'state', ts: 0, updatedAt: now, ...PRIVATE, value: { schema: 'self-head/v1', revision: 1, locked: false,
          entries: entries.map(r => ({ entryId: r.value.entryId, recordId: r.id })), locks: [], removed: [], settingsId, pendingSettings: legacy.length > 0, sources: [] } },
      ]);
      state = await this._read();
      return this._view(state);
    });
  }
  _view({ h, entries, settings }) {
    return { revision: h.revision, locked: h.locked, pendingSettings: !!h.pendingSettings,
      understanding: h.lastUnderstanding?.settingsId === h.settingsId ? { ...h.lastUnderstanding, settingsId: undefined } : null,
      settings: { identity: settings?.value.identity || '', behavior: settings?.value.behavior || '' },
      entries: entries.map(e => ({ entryId: e.entryId, revision: e.revision, facet: e.facet, text: e.text, condition: e.condition || '', locked: e.locked })),
      text: entries.map(e => `[${e.entryId}${e.locked ? ' 固定' : ''}] ${e.condition ? '在' + e.condition + '时：' : ''}${e.text}`).join('\n') };
  }
  async loadRoleView({ repair = true } = {}) {
    return this.memory.serial(async () => {
      const s = await this._read(); if (!s) return null;
      const active = new Set(s.entries.map(e => e.recordId));
      if (repair && active.size !== s.h.entries.length) {
        s.h = { ...s.h, revision: s.h.revision + 1, entries: s.h.entries.filter(e => active.has(e.recordId)) };
        await this.memory.write([{ ...s.head, updatedAt: this.clock(), value: s.h }]); this.onChange();
      }
      return this._view(s);
    });
  }
  async saveSettings({ identity, behavior = '', expectedRevision, reflect = true }) {
    const values = { identity: identity ? clean(identity, 2000) : '', behavior: behavior ? clean(behavior, 2000) : '' };
    return this.memory.serial(async () => {
      const s = await this._read(); if (!s) throw new Error('自我理解尚未初始化');
      if (expectedRevision !== undefined && expectedRevision !== s.h.revision) throw err('E_SELF_STALE', '自我理解刚有变化，请刷新后重试');
      const rid = 'self-settings:' + randomUUID(), now = this.clock();
      await this.memory.write([{ id: rid, kind: 'persona', ts: now, ...PRIVATE,
        value: { schema: 'self-settings/v1', ...values, sources: [] } }]);
      await this.memory.write([{ ...s.head, updatedAt: now, value: { ...s.h, revision: s.h.revision + 1, settingsId: rid, pendingSettings: reflect !== false, blockedSettings: false } }]);
      this.onChange(); return this._view(await this._read());
    });
  }
  async requestUnderstanding() {
    return this.memory.serial(async () => {
      const s = await this._read();
      if (!s?.settings) throw new Error('请先保存你给 Bunny 的设定');
      if (s.h.locked) throw err('E_SELF_LOCKED', '自我理解已锁定，请先在手工微调中解锁');
      if (!s.h.pendingSettings) await this.memory.write([{ ...s.head, updatedAt: this.clock(),
        value: { ...s.h, revision: s.h.revision + 1, pendingSettings: true, blockedSettings: false } }]);
      this.onChange(); return this._view(await this._read());
    });
  }
  async commitPatch(patch, { actor = 'learning', trustedUI = false, requestSourceId, sourceRows = [], extraRecords = [], validateExtra, signal, generation = this.memory.generation } = {}) {
    if (!patch || !Array.isArray(patch.ops) || patch.ops.length > MAX_ENTRIES || typeof patch.requestId !== 'string' || patch.requestId.length > 200)
      throw new Error('自我理解修改格式不正确');
    if (!['owner', 'learning'].includes(actor) || actor === 'owner' && !trustedUI && !requestSourceId) throw new Error('自我理解修改缺少主人来源');
    if (sourceRows.some(r => !Number.isSafeInteger(r.ingestionSeq))) {
      const actual = await readRecords(this.memory, sourceRows.map(r => r.id));
      if (actual.length !== sourceRows.length || sourceRows.some(r => {
        const a = actual.find(a => a.id === r.id); return !a || a.ts !== r.ts || JSON.stringify(a.value) !== JSON.stringify(r.value);
      })) throw err('E_SELF_STALE', '学习原文已变化');
      sourceRows = actual;
    }
    const snapshots = snapshotsOf(sourceRows);
    return this.memory.serial(async () => {
      if (signal?.aborted || generation !== this.memory.generation) throw err('E_SELF_STALE', '修改来源已失效');
      const s = await this._read(); if (!s) throw new Error('自我理解尚未初始化');
      if (s.h.lastRequestId === patch.requestId) return { ...this._view(s), duplicate: true, changed: false };
      if (patch.baseRevision !== s.h.revision) throw err('E_SELF_STALE', '自我理解版本已变化，旧提案没有覆盖新内容');
      if (snapshots.length && !(await verifySnapshots(this.memory, snapshots)).ok) throw err('E_SELF_STALE', '学习依据已变化');
      if (validateExtra && !await validateExtra()) throw err('E_SELF_STALE', '成长记忆已变化，旧提案没有覆盖新内容');
      let sourceIds = sourceRows.map(r => r.id);
      if (actor === 'owner' && !trustedUI) {
        const r = (await readRecords(this.memory, [requestSourceId]))[0];
        if (!r || r.kind !== 'message' || !actors.isOwner(r.value) || !explicitSelfRequest(r.value.content)) throw new Error('只有本轮主人明确请求可以直接修改自我理解');
        sourceIds = [r.id];
      }
      sourceIds = [...new Set(sourceIds)];
      if (actor === 'learning' && !sourceIds.length) throw new Error('自动更新必须有真实来源');
      if (sourceIds.length > 200) throw new Error('学习来源过多');
      const byId = new Map(s.entries.map(e => [e.entryId, e]));
      const refs = new Map(s.h.entries.filter(ref => byId.has(ref.entryId)).map(e => [e.entryId, e]));
      const locks = new Set(s.h.locks), removed = new Set(s.h.removed), removedHashes = new Set(s.h.removedHashes || []);
      const writes = [], skipped = []; let locked = s.h.locked;
      let unlockedEntry = false;
      const inherited = actor === 'learning' ? s.entries.map(e => e.recordId) : [];
      const entities = actor === 'learning' ? await this.memory.entityAnchors?.('private') || [] : [];
      const now = this.clock();
      for (const op of patch.ops) {
        if (actor === 'learning' && (!op || !['add', 'replace', 'remove'].includes(op.op) || op.lock !== undefined || op.op === 'add' && op.entryId)) { skipped.push('invalid-op'); continue; }
        if (!op || !['add', 'replace', 'remove', 'lock', 'unlock', 'lock_all', 'unlock_all'].includes(op.op)) throw new Error('不支持的自我理解操作');
        if (actor !== 'owner' && !['add', 'replace', 'remove'].includes(op.op)) throw new Error('自动学习不能修改锁');
        if (op.op === 'lock_all' || op.op === 'unlock_all') {
          locked = op.op === 'lock_all';
          if (op.op === 'unlock_all') { unlockedEntry ||= locks.size > 0; locks.clear(); }
          continue;
        }
        if (op.op === 'add' && op.entryId) throw new Error('新增自我条目不能覆盖已有ID');
        if (op.lock !== undefined && (actor !== 'owner' || op.op !== 'add' || typeof op.lock !== 'boolean')) throw new Error('只有主人新增条目可以同时锁定');
        const existing = op.entryId ? byId.get(op.entryId) : null;
        if (actor === 'learning' && op.op !== 'add' && !existing) { skipped.push('invalid-target'); continue; }
        if (op.op !== 'add' && !existing) throw new Error('目标自我条目已不存在');
        if (actor === 'learning' && (locked || locks.has(op.entryId))) { skipped.push('locked'); continue; }
        if (op.op === 'lock' || op.op === 'unlock') { if (op.op === 'unlock' && locks.has(op.entryId)) unlockedEntry = true; op.op === 'lock' ? locks.add(op.entryId) : locks.delete(op.entryId); continue; }
        if (op.op === 'remove') { refs.delete(op.entryId); byId.delete(op.entryId); locks.delete(op.entryId); removed.add(op.entryId); removedHashes.add(digest([existing.text, existing.condition || ''])); continue; }
        const facet = op.facet || existing?.facet || 'behavior';
        if (actor === 'learning' && !FACETS.includes(facet)) { skipped.push('invalid-facet'); continue; }
        if (!FACETS.includes(facet)) throw new Error('自我条目分类不正确');
        let text, condition;
        try { text = clean(op.text); condition = op.condition ? clean(op.condition, 160) : ''; }
        catch (e) { if (actor !== 'learning') throw e; skipped.push('invalid-content'); continue; }
        if (actor === 'learning' && !abstractSelf(text, condition, sourceRows, entities)) { skipped.push('private-fact'); continue; }
        if (actor === 'learning' && (s.h.removedHashes || []).includes(digest([text, condition]))) { skipped.push('removed'); continue; }
        const duplicate = [...byId.values()].find(e => e.text === text && e.condition === condition && e.facet === facet);
        if (duplicate) { if (op.lock === true) locks.add(duplicate.entryId); continue; }
        const nextSize = [...byId.values()].reduce((n, e) => n + e.text.length + (e.condition || '').length, 0) - (existing ? existing.text.length + (existing.condition || '').length : 0) + text.length + condition.length;
        if (actor === 'learning' && (nextSize > MAX_TOTAL || !existing && refs.size >= MAX_ENTRIES)) { skipped.push('content-budget'); continue; }
        const entryId = existing?.entryId || randomUUID(), revision = (existing?.revision || 0) + 1;
        const recordId = 'self-entry:' + entryId + ':' + revision + ':' + randomUUID().slice(0, 8);
        const value = { schema: 'self-entry/v1', group: 'bunny-self', entryId, revision, facet, text, condition,
          origin: actor === 'owner' ? 'owner-direct' : 'dream-learning', sources: [...new Set([...sourceIds, ...inherited])] };
        writes.push({ id: recordId, kind: 'persona', ts: now, ...PRIVATE, value });
        if (op.lock === true) locks.add(entryId);
        refs.set(entryId, { entryId, recordId }); byId.set(entryId, { ...value, recordId });
      }
      if (refs.size > MAX_ENTRIES || [...byId.values()].reduce((n, e) => n + e.text.length + e.condition.length, 0) > MAX_TOTAL) throw new Error('自我理解已达到内容预算，请先整理条目');
      const changed = writes.length > 0 || refs.size !== s.h.entries.length || JSON.stringify([...locks]) !== JSON.stringify(s.h.locks) || locked !== s.h.locked;
      const value = { ...s.h, entries: [...refs.values()], locks: [...locks], removed: [...removed].slice(-100), removedHashes: [...removedHashes].slice(-100), locked,
        revision: s.h.revision + (changed ? 1 : 0), lastRequestId: patch.requestId,
        pendingSettings: patch.completeSettings ? false : s.h.blockedSettings && (s.h.locked && !locked || unlockedEntry) ? true : s.h.pendingSettings,
        blockedSettings: patch.completeSettings ? locked || skipped.some(r => r.startsWith('locked')) : s.h.blockedSettings };
      if (actor === 'learning' && patch.completeSettings) value.lastUnderstanding = {
        settingsId: s.h.settingsId, at: now, revision: value.revision, changed,
        summary: skipped.length ? (changed ? '已融合可采纳的新设定，部分内容保留原有理解，可在“手工微调”中核对。' : '已核对新设定，本次保留原有理解。')
          : typeof patch.summary === 'string' && patch.summary.trim() && patch.summary.length <= 400 && !containsSecret(patch.summary) && !/entryId|sourceId|\b(?:identity|trait|value|behavior|interest)\b|[a-f\d]{8}-[a-f\d]{4}-[a-f\d-]{20,}/i.test(patch.summary) ? patch.summary.trim() : '',
      };
      writes.push({ ...s.head, updatedAt: now, value });
      if (writes.length + extraRecords.length > 200) throw new Error('认知提交批次过大');
      await this.memory.write([...writes, ...extraRecords]);
      if (changed) this.onChange(); else if (patch.completeSettings) void this.memory.notifyChange();
      return { ...this._view(await this._read()), changed, skipped };
    });
  }
  async learningInput() {
    await this.memory.tail; const s = await this._read(); if (!s) return null;
    return { ...this._view(s), settingsSourceId: s.settings?.id, legacy: s.settings?.value.legacy || [],
      sourceRows: s.h.pendingSettings && s.settings ? [s.settings] : [], entrySourceRows: await readRecords(this.memory, s.h.entries.map(e => e.recordId)) };
  }
  async history(entryId) {
    if (typeof entryId !== 'string' || entryId.length > 100) throw new Error('无效条目');
    return (await this.memory.query('persona', 200, { scene: null })).filter(r => r.value.schema === 'self-entry/v1' && r.value.entryId === entryId)
      .slice(0, 40).map(r => ({ revision: r.value.revision, text: r.value.text, condition: r.value.condition, ts: r.ts, origin: r.value.origin }));
  }
}
module.exports = { CognitionRepository, HEAD, PRIVATE, FACETS, explicitSelfRequest, digest, validateRecord };
