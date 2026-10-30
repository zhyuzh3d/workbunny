'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { createSemanticDream, PARTITIONS, MAX_GROUP_ITEMS, MAX_GROUP_CHARS } = require('../src/main/semantic-dream');
const { rank } = require('../src/main/memory-scope');

const ROOT = path.resolve(__dirname, '..');
const VAULT_BIN = path.join(ROOT, 'bin', 'vault');
const fixedKey = Buffer.alloc(32, 0x5b);

class FakeMemory {
  constructor() {
    this.records = new Map();
    this.nextSeq = 1;
    this.epoch = 1;
    this.generation = 1;
    this.sceneEpoch = 1;
    this.closed = false;
    this.key = Buffer.from(fixedKey);
    this.tail = Promise.resolve();
    this.decode = row => structuredClone(row);
    this.db = { request: async (op, args = {}) => {
      if (op !== 'get') throw new Error(`unexpected fake db operation ${op}`);
      const visible = args.scene === undefined || args.scene === null ? null : rank(args.scene);
      const rows = args.ids.map(id => this.records.get(id)).filter(row => row &&
        (visible === null || row.visibilityFloor <= visible));
      return { rows: structuredClone(rows) };
    } };
  }
  async serial(fn) {
    const result = this.tail.then(() => { if (this.closed) throw new Error('fake memory closed'); return fn(); });
    this.tail = result.catch(() => {});
    return result;
  }
  async query(kind, limit = 50, cursor = {}) {
    const visible = cursor.scene === undefined || cursor.scene === null ? null : rank(cursor.scene);
    let rows = [...this.records.values()].filter(row => (!kind || row.kind === kind) &&
      (row.state || 'active') === (cursor.state || 'active') && (visible === null || row.visibilityFloor <= visible));
    if (cursor.domain !== undefined) rows = rows.filter(row => row.domain === cursor.domain);
    if (cursor.visibilityFloor !== undefined) rows = rows.filter(row => row.visibilityFloor === cursor.visibilityFloor);
    if (cursor.afterSeq !== undefined) rows = rows.filter(row => row.ingestionSeq > cursor.afterSeq);
    if (cursor.beforeSeq !== undefined) rows = rows.filter(row => row.ingestionSeq < cursor.beforeSeq);
    rows.sort((a, b) => cursor.sort === 'ingestion'
      ? (cursor.order === 'desc' ? b.ingestionSeq - a.ingestionSeq : a.ingestionSeq - b.ingestionSeq)
      : (cursor.order === 'desc' ? b.ts - a.ts : a.ts - b.ts));
    return structuredClone(rows.slice(0, limit));
  }
  async search(text, kinds = ['memory'], limit = 30, { scene = 'life', domain, visibilityFloor } = {}) {
    const visible = rank(scene);
    const terms = String(text).toLowerCase().split(/[^\p{L}\p{N}._-]+/u).filter(Boolean);
    return [...this.records.values()].filter(row => kinds.includes(row.kind) && row.state === 'active' &&
      row.visibilityFloor <= visible && (domain === undefined || row.domain === domain) &&
      (visibilityFloor === undefined || row.visibilityFloor === visibilityFloor))
      .map(row => {
        const value = row.value || {};
        const haystack = [value.content, value.evidence, value.key, ...(value.tags || [])].join(' ').toLowerCase();
        const score = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
        return { row, score };
      }).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.row.ts - a.row.ts)
      .slice(0, limit).map(item => ({ ...structuredClone(item.row), score: item.score }));
  }
  seed(record) {
    const ingestionSeq = record.ingestionSeq ?? this.nextSeq++;
    this.nextSeq = Math.max(this.nextSeq, ingestionSeq + 1);
    const row = { state: 'active', updatedAt: record.updatedAt || record.ts, ...structuredClone(record), ingestionSeq };
    this.records.set(row.id, row);
    this.epoch++;
    return structuredClone(row);
  }
  async write(records, epoch = this.epoch) {
    if (epoch !== this.epoch) throw Object.assign(new Error('stale epoch'), { code: 'stale_epoch' });
    assert(records.length <= 200);
    const staged = new Map(this.records);
    for (const record of records) {
      const sources = record.value.sources || [];
      assert(sources.length <= 200);
      for (const sourceId of sources) {
        const source = staged.get(sourceId);
        if (!source) throw new Error(`missing source ${sourceId}`);
        assert(record.visibilityFloor >= source.visibilityFloor, 'scope cannot be lowered');
      }
      const prior = staged.get(record.id);
      staged.set(record.id, { ...structuredClone(record), state: 'active', updatedAt: record.updatedAt || record.ts,
        ingestionSeq: prior?.ingestionSeq ?? this.nextSeq++ });
    }
    this.records = staged;
    this.epoch++;
  }
  removeCascade(id) {
    const removed = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of this.records.values()) {
        if (!removed.has(row.id) && (row.value.sources || []).some(sourceId => removed.has(sourceId))) {
          removed.add(row.id); changed = true;
        }
      }
    }
    for (const recordId of removed) this.records.delete(recordId);
    this.epoch++;
    this.generation++;
    return [...removed];
  }
}

function addUserAndMemory(memory, { id, scene, floor = rank(scene), quote, content, status = 'confirmed',
  memoryKind = 'fact', key = 'user.test.fact', tags = [], origin = 'user-statement',
  evidenceDomain = scene, evidenceFloor = floor, ts = 1000 }) {
  const userId = `${id}-evidence`;
  memory.seed({ id: userId, kind: 'message', ts, domain: evidenceDomain, visibilityFloor: evidenceFloor,
    value: { role: 'user', content: quote, source: 'user-reviewed', sources: [] } });
  const memoryValue = { content, status, memoryKind, key, tags,
    evidence: quote, evidenceSourceId: userId, origin, sources: [userId] };
  if (status === 'pending' && origin === 'doze-candidate-v2') memoryValue.importance = 0.6;
  const memoryRow = memory.seed({ id, kind: 'memory', ts, domain: scene, visibilityFloor: floor, value: memoryValue });
  return { memoryRow, userId };
}

function createValidAnalysis(inputs, type = 'equivalent', members = inputs) {
  const citations = members.map(input => ({ recordId: input.id, sourceId: input.evidence.sourceId, quote: input.evidence.quote }));
  const relation = { type, recordIds: members.map(input => input.id), evidence: citations };
  if (type === 'contextual') relation.conditions = citations;
  if (type === 'contradiction') {
    relation.conditionStatus = 'supported';
    relation.temporalStatus = 'supported';
    relation.conditions = citations;
    relation.temporal = citations;
  }
  if (type === 'update') relation.temporal = citations;
  return { relations: [relation] };
}

function relationRows(memory) {
  return [...memory.records.values()].filter(row => row.kind === 'state' && row.value?.origin === 'semantic-relation-v1');
}

function cacheRows(memory) {
  return [...memory.records.values()].filter(row => row.kind === 'state' && row.value?.origin === 'semantic-analysis-cache-v1');
}

async function testSixPartitionsAndIdempotentCache() {
  const memory = new FakeMemory();
  const pairs = [];
  for (const [index, partition] of PARTITIONS.entries()) {
    const pending = index === 4;
    const quoteA = `我在${partition.domain}分区明确喜欢茉莉茶${index}。`;
    const quoteB = `我在${partition.domain}分区一直喜欢茉莉茶${index}。`;
    const a = addUserAndMemory(memory, { id: `semantic-${index}-a`, scene: partition.domain,
      floor: partition.visibilityFloor, quote: quoteA, content: `喜欢茉莉茶 ${index}`, tags: ['茉莉茶'],
      evidenceDomain: index === 5 ? 'work' : index === 2 ? 'private' : partition.domain,
      evidenceFloor: index === 5 ? 0 : partition.visibilityFloor, ts: index * 20 + 1 });
    const b = addUserAndMemory(memory, { id: `semantic-${index}-b`, scene: partition.domain,
      floor: partition.visibilityFloor, quote: quoteB, content: `长期喜欢茉莉茶 ${index}`,
      status: pending ? 'pending' : 'confirmed', origin: pending ? 'doze-candidate-v2' : 'user-statement',
      memoryKind: pending ? 'candidate' : 'fact', tags: ['茉莉茶'], ts: index * 20 + 2 });
    pairs.push({ partition, a, b });
  }
  const calls = [];
  const worker = createSemanticDream({ memory, clock: () => 2_000_000, analyze: async (inputs, options) => {
    calls.push({ inputs: structuredClone(inputs), partition: options.partition });
    assert(inputs.length <= MAX_GROUP_ITEMS);
    assert(Buffer.byteLength(JSON.stringify(inputs), 'utf8') <= MAX_GROUP_CHARS);
    return createValidAnalysis(inputs);
  } });
  const result = await worker.run();
  assert.equal(result.status, 'done');
  assert.equal(result.analyzed, PARTITIONS.length, 'each exact partition gets its own bounded relation analysis');
  assert.equal(result.relations, PARTITIONS.length);
  assert.equal(calls.length, PARTITIONS.length);
  const relations = relationRows(memory);
  assert.equal(relations.length, PARTITIONS.length);
  for (const pair of pairs) {
    const related = relations.find(row => row.domain === pair.partition.domain && row.visibilityFloor === pair.partition.visibilityFloor);
    assert(related, `relation exists only inside ${pair.partition.domain}:${pair.partition.visibilityFloor}`);
    assert.equal(related.kind, 'state');
    assert.equal(related.value.origin, 'semantic-relation-v1');
    assert.equal(related.value.relation, 'equivalent');
    assert.equal(related.value.status, 'proposed');
    assert(related.value.memberIds.length <= 6);
    assert.deepEqual(new Set(related.value.sources), new Set([
      pair.a.memoryRow.id, pair.a.userId, pair.b.memoryRow.id, pair.b.userId,
    ]));
    assert.deepEqual(new Set(related.value.analysisSnapshots.map(item => item.id)), new Set(related.value.sources));
    assert(related.value.analysisSnapshots.every(item => /^[0-9a-f]{64}$/u.test(item.fingerprint)));
    assert(related.value.content.includes(pair.a.memoryRow.value.evidence));
    assert(related.value.content.includes(pair.b.memoryRow.value.evidence));
    assert(!related.value.content.includes('新的模型事实'));
    const beforeA = pair.a.memoryRow.value.status;
    const beforeB = pair.b.memoryRow.value.status;
    assert.equal(memory.records.get(pair.a.memoryRow.id).value.status, beforeA, 'semantic relation never edits the original fact');
    assert.equal(memory.records.get(pair.b.memoryRow.id).value.status, beforeB, 'pending Doze candidate remains pending');
  }
  assert.equal(cacheRows(memory).length, PARTITIONS.length);
  assert.equal((await worker.run()).analyzed, 0);
  assert.equal(calls.length, PARTITIONS.length, 'unchanged input snapshots are served from the HMAC batch cache');
}

async function testFullInputSnapshotsAndSixMemberCap() {
  const memory = new FakeMemory();
  const records = [];
  for (let index = 0; index < 8; index++) {
    const quote = `我经常使用项目规划工具，版本${index}。`;
    records.push(addUserAndMemory(memory, { id: `wide-${index}`, scene: 'work', quote,
      content: `经常使用项目规划工具，版本${index}`, key: 'tool.planning', tags: ['项目规划'], ts: index + 1 }));
  }
  let inputLength = 0;
  const worker = createSemanticDream({ memory, analyze: async inputs => {
    inputLength = inputs.length;
    assert(inputLength <= MAX_GROUP_ITEMS);
    return createValidAnalysis(inputs, 'equivalent', inputs.slice(0, 6));
  } });
  assert.equal((await worker.run()).status, 'done');
  const relation = relationRows(memory)[0];
  assert.equal(inputLength, 8, 'model group includes at most eight local candidates');
  assert.equal(relation.value.memberIds.length, 6, 'a single relation references no more than six members');
  assert.equal(relation.value.analysisSnapshots.length, 16, 'snapshot includes all eight memory inputs and all direct user evidence');
  assert.equal(relation.value.sources.length, 16);
}

async function testStrictEvidenceAndRelationTypes() {
  const updateMemory = new FakeMemory();
  const oldFact = addUserAndMemory(updateMemory, { id: 'update-old', scene: 'work', quote: '我以前住在上海。',
    content: '住在上海', key: 'user.city', ts: 1 });
  const newFact = addUserAndMemory(updateMemory, { id: 'update-new', scene: 'work', quote: '我现在住在北京。',
    content: '住在北京', key: 'user.city', ts: 2 });
  const updateWorker = createSemanticDream({ memory: updateMemory, analyze: async inputs => createValidAnalysis(inputs, 'update') });
  const update = await updateWorker.run();
  assert.equal(update.status, 'done');
  assert.equal(relationRows(updateMemory)[0].value.relation, 'update');
  assert.equal(relationRows(updateMemory)[0].value.temporal.length, 2);
  assert(updateMemory.records.has(oldFact.memoryRow.id) && updateMemory.records.has(newFact.memoryRow.id));

  const contextualMemory = new FakeMemory();
  addUserAndMemory(contextualMemory, { id: 'context-a', scene: 'life', quote: '工作时我偏好用蓝色主题。',
    content: '偏好蓝色主题', key: 'ui.theme', tags: ['主题'], ts: 1 });
  addUserAndMemory(contextualMemory, { id: 'context-b', scene: 'life', quote: '休息时我偏好用绿色主题。',
    content: '偏好绿色主题', key: 'ui.theme', tags: ['主题'], ts: 2 });
  const contextualWorker = createSemanticDream({ memory: contextualMemory, analyze: async inputs => createValidAnalysis(inputs, 'contextual') });
  assert.equal((await contextualWorker.run()).status, 'done');
  assert.equal(relationRows(contextualMemory)[0].value.relation, 'contextual');

  const contradictionMemory = new FakeMemory();
  addUserAndMemory(contradictionMemory, { id: 'conflict-a', scene: 'life', quote: '我现在喜欢喝咖啡。',
    content: '喜欢咖啡', key: 'user.drink.coffee', tags: ['咖啡'], ts: 1 });
  addUserAndMemory(contradictionMemory, { id: 'conflict-b', scene: 'life', quote: '我现在不喜欢喝咖啡。',
    content: '不喜欢咖啡', key: 'user.drink.coffee', tags: ['咖啡'], ts: 2 });
  const contradictionWorker = createSemanticDream({ memory: contradictionMemory,
    analyze: async inputs => createValidAnalysis(inputs, 'contradiction') });
  assert.equal((await contradictionWorker.run()).status, 'done');
  assert.equal(relationRows(contradictionMemory)[0].value.relation, 'contradiction');
  assert.equal(relationRows(contradictionMemory)[0].value.status, 'proposed', 'contradictions remain proposed, never auto-resolved');

  const bareConflict = new FakeMemory();
  addUserAndMemory(bareConflict, { id: 'bare-a', scene: 'life', quote: '我喜欢咖啡。', content: '喜欢咖啡', key: 'drink.coffee', ts: 1 });
  addUserAndMemory(bareConflict, { id: 'bare-b', scene: 'life', quote: '我不喜欢咖啡。', content: '不喜欢咖啡', key: 'drink.coffee', ts: 2 });
  const bareWorker = createSemanticDream({ memory: bareConflict, analyze: async inputs => {
    const citations = inputs.map(input => ({ recordId: input.id, sourceId: input.evidence.sourceId, quote: input.evidence.quote }));
    return { relations: [{ type: 'contradiction', recordIds: inputs.map(input => input.id), evidence: citations,
      conditionStatus: 'not_stated', temporalStatus: 'not_stated' }] };
  } });
  assert.equal((await bareWorker.run()).status, 'done', 'directly incompatible statements may be candidates without invented context or time evidence');
  const bareRelation = relationRows(bareConflict)[0];
  assert.equal(bareRelation.value.conditionStatus, 'not_stated');
  assert.equal(bareRelation.value.temporalStatus, 'not_stated');
  assert.deepEqual(bareRelation.value.conditions, []);
  assert.deepEqual(bareRelation.value.temporal, []);

  const uncertainMemory = new FakeMemory();
  addUserAndMemory(uncertainMemory, { id: 'uncertain-a', scene: 'life', quote: '我可能会喜欢咖啡。',
    content: '可能喜欢咖啡', key: 'user.drink.coffee', ts: 1 });
  addUserAndMemory(uncertainMemory, { id: 'uncertain-b', scene: 'life', quote: '我不确定是否喜欢咖啡。',
    content: '不确定咖啡偏好', key: 'user.drink.coffee', ts: 2 });
  const uncertainWorker = createSemanticDream({ memory: uncertainMemory,
    analyze: async inputs => createValidAnalysis(inputs, 'uncertain') });
  assert.equal((await uncertainWorker.run()).status, 'done');
  assert.equal(relationRows(uncertainMemory)[0].value.relation, 'uncertain');

  for (const mutate of [
    result => { delete result.relations[0].conditionStatus; },
    result => { result.relations[0].conditionStatus = 'supported'; result.relations[0].conditions = []; },
    result => { result.relations[0].temporalStatus = 'supported'; result.relations[0].temporal = []; },
    result => { result.relations[0].temporalStatus = 'not_stated'; result.relations[0].temporal = [{ recordId: 'x', sourceId: 'y', quote: '伪造线索' }]; },
  ]) {
    const memory = new FakeMemory();
    addUserAndMemory(memory, { id: 'strict-conflict-a', scene: 'work', quote: '我喜欢茶。', content: '喜欢茶', key: 'drink.tea', ts: 1 });
    addUserAndMemory(memory, { id: 'strict-conflict-b', scene: 'work', quote: '我不喜欢茶。', content: '不喜欢茶', key: 'drink.tea', ts: 2 });
    const worker = createSemanticDream({ memory, analyze: async inputs => {
      const citations = inputs.map(input => ({ recordId: input.id, sourceId: input.evidence.sourceId, quote: input.evidence.quote }));
      const result = { relations: [{ type: 'contradiction', recordIds: inputs.map(input => input.id), evidence: citations,
        conditionStatus: 'not_stated', temporalStatus: 'not_stated' }] };
      mutate(result); return result;
    } });
    await assert.rejects(worker.run(), error => error.code === 'E_INVALID_MODEL_OUTPUT', 'contradiction labels cannot fabricate evidence');
    assert.equal(relationRows(memory).length, 0);
  }

  const invalidCases = [
    { name: 'wrong source ID', mutate: result => { result.relations[0].evidence[0].sourceId = 'made-up'; } },
    { name: 'invented quote', mutate: result => { result.relations[0].evidence[0].quote = '不存在的原句'; } },
    { name: 'unknown output field', mutate: result => { result.extra = 'model assertion'; } },
    { name: 'update without temporal proof', mutate: result => { result.relations[0].temporal = undefined; } },
    { name: 'temporal proof without explicit user wording', mutate: result => { result.relations[0].temporal[0].quote = '住在上海'; } },
    { name: 'context without condition proof', mutate: result => { result.relations[0].conditions = undefined; } },
    { name: 'more than six relation members', mutate: result => {
      result.relations[0].recordIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    } },
  ];
  for (const testCase of invalidCases) {
    const memory = new FakeMemory();
    addUserAndMemory(memory, { id: 'invalid-a', scene: 'work', quote: '我以前住在上海。', content: '住在上海', key: 'user.city', ts: 1 });
    addUserAndMemory(memory, { id: 'invalid-b', scene: 'work', quote: '我现在住在北京。', content: '住在北京', key: 'user.city', ts: 2 });
    const worker = createSemanticDream({ memory, analyze: async inputs => {
      const result = createValidAnalysis(inputs, testCase.name.includes('context') ? 'contextual' : 'update');
      testCase.mutate(result);
      return result;
    } });
    await assert.rejects(worker.run(), error => error.code === 'E_INVALID_MODEL_OUTPUT', `${testCase.name} fails closed with a terminal output error`);
    assert.equal(relationRows(memory).length, 0);
    assert.equal(cacheRows(memory).length, 0);
    assert(![...memory.records.values()].some(row => row.value?.origin === 'semantic-dream-cursor-v1'), 'invalid output does not advance the cursor');
  }
}

async function testBudgetCancellationAndStaleDeletion() {
  const budgetMemory = new FakeMemory();
  addUserAndMemory(budgetMemory, { id: 'budget-a', scene: 'work', quote: '我喜欢柠檬茶。', content: '喜欢柠檬茶', tags: ['饮品'], ts: 1 });
  addUserAndMemory(budgetMemory, { id: 'budget-b', scene: 'work', quote: '我一直喜欢柠檬茶。', content: '一直喜欢柠檬茶', tags: ['饮品'], ts: 2 });
  let calls = 0;
  const budgetWorker = createSemanticDream({ memory: budgetMemory, analyze: async inputs => { calls++; return createValidAnalysis(inputs); } });
  const budget = await budgetWorker.run({ reserveModelCall: async () => ({ ok: false }) });
  assert.equal(budget.status, 'budget');
  assert.equal(calls, 0);
  assert.equal(relationRows(budgetMemory).length, 0);

  const partialMemory = new FakeMemory();
  for (let group = 0; group < 4; group++) {
    addUserAndMemory(partialMemory, { id: `partial-${group}-a`, scene: 'work', quote: `我明确偏好主题${group}方案。`,
      content: `偏好主题${group}`, key: `user.preference.${group}`, tags: [`主题${group}`], ts: group * 10 + 1 });
    addUserAndMemory(partialMemory, { id: `partial-${group}-b`, scene: 'work', quote: `我一直偏好主题${group}方案。`,
      content: `一直偏好主题${group}`, key: `user.preference.${group}`, tags: [`主题${group}`], ts: group * 10 + 2 });
  }
  let partialCalls = 0;
  const partialWorker = createSemanticDream({ memory: partialMemory, analyze: async inputs => {
    partialCalls++;
    return createValidAnalysis(inputs);
  } });
  let reservations = 0;
  const partial = await partialWorker.run({ reserveModelCall: async () => ({ ok: ++reservations === 1 }) });
  assert.equal(partial.status, 'budget');
  assert.equal(partial.analyzed, 1);
  assert.equal(cacheRows(partialMemory).length, 1, 'completed local analysis is cached before the page cursor advances');
  assert(![...partialMemory.records.values()].some(row => row.value?.origin === 'semantic-dream-cursor-v1'));
  const resumedWorker = createSemanticDream({ memory: partialMemory, analyze: async inputs => {
    partialCalls++;
    return createValidAnalysis(inputs);
  } });
  assert.equal((await resumedWorker.run()).status, 'done');
  assert.equal(partialCalls, 4, 'resumption reuses the first completed group and calls only the remaining three');
  assert.equal(relationRows(partialMemory).length, 4);

  const canceledMemory = new FakeMemory();
  const source = addUserAndMemory(canceledMemory, { id: 'cancel-a', scene: 'work', quote: '我喜欢乌龙茶。', content: '喜欢乌龙茶', tags: ['茶'], ts: 1 });
  addUserAndMemory(canceledMemory, { id: 'cancel-b', scene: 'work', quote: '我一直喜欢乌龙茶。', content: '一直喜欢乌龙茶', tags: ['茶'], ts: 2 });
  const controller = new AbortController();
  const canceledWorker = createSemanticDream({ memory: canceledMemory, analyze: async inputs => {
    controller.abort();
    return createValidAnalysis(inputs);
  } });
  assert.equal((await canceledWorker.run({ signal: controller.signal })).status, 'paused');
  assert.equal(relationRows(canceledMemory).length, 0, 'cancellation during the model request prevents commit');
  assert.equal(cacheRows(canceledMemory).length, 0);

  const deletedMemory = new FakeMemory();
  const deletedSource = addUserAndMemory(deletedMemory, { id: 'delete-a', scene: 'work', quote: '我喜欢红茶。', content: '喜欢红茶', tags: ['茶'], ts: 1 });
  addUserAndMemory(deletedMemory, { id: 'delete-b', scene: 'work', quote: '我一直喜欢红茶。', content: '一直喜欢红茶', tags: ['茶'], ts: 2 });
  const deleteWorker = createSemanticDream({ memory: deletedMemory, analyze: async inputs => {
    deletedMemory.removeCascade(deletedSource.userId);
    return createValidAnalysis(inputs);
  } });
  assert.equal((await deleteWorker.run()).status, 'paused');
  assert.equal(relationRows(deletedMemory).length, 0, 'source deletion invalidates the late semantic result');
}

async function testRestartCacheAndProtectedNamespace() {
  const memory = new FakeMemory();
  addUserAndMemory(memory, { id: 'pin-a', scene: 'private', quote: '我固定记录的称呼是小岚。',
    content: '称呼小岚', key: 'user.name', memoryKind: 'fact', tags: ['姓名'], ts: 1 });
  addUserAndMemory(memory, { id: 'pin-b', scene: 'private', quote: '我固定记录的称呼一直是小岚。',
    content: '称呼小岚', key: 'user.name', memoryKind: 'fact', tags: ['姓名'], ts: 2 });
  addUserAndMemory(memory, { id: 'ordinary-c', scene: 'private', quote: '小岚是一个故事角色。',
    content: '故事角色小岚', key: 'story.character', memoryKind: 'experience', tags: ['姓名'], ts: 3 });
  const calls = [];
  const firstWorker = createSemanticDream({ memory, maxPerPartition: 1, analyze: async inputs => {
    calls.push(inputs.map(item => item.id));
    return createValidAnalysis(inputs);
  } });
  const first = await firstWorker.run();
  assert.equal(first.status, 'done');
  assert(first.more, 'one-row page leaves a persisted cursor for restart');
  assert.equal(relationRows(memory).length, 1, 'protected name facts form only their isolated namespace');
  assert.deepEqual(new Set(relationRows(memory)[0].value.memberIds), new Set(['pin-a', 'pin-b']));
  const afterFirst = calls.length;
  const resumedWorker = createSemanticDream({ memory, maxPerPartition: 1, analyze: async inputs => {
    calls.push(inputs.map(item => item.id));
    return createValidAnalysis(inputs);
  } });
  await resumedWorker.run();
  assert.equal(calls.length, afterFirst, 'restart resumes the cursor and does not reanalyze cached input snapshots');
  assert.equal(memory.records.get('pin-a').value.status, 'confirmed');
  assert.equal(memory.records.get('pin-b').value.status, 'confirmed');
}

async function testRealSqliteLineage(temp) {
  if (!fs.existsSync(VAULT_BIN)) throw new Error(`Existing vault binary missing; test will not build it: ${VAULT_BIN}`);
  let now = Date.UTC(2026, 9, 27);
  const changes = [];
  const service = new MemoryService({ dir: path.join(temp, 'sqlite'), bin: VAULT_BIN,
    openKey: async () => Buffer.from(fixedKey), getSettings: () => ({ enabled: true, extract: false, scene: 'life' }),
    clock: () => now++, random: () => 0, onChange: event => { changes.push(event); } });
  try {
    await service.init();
    if (!service.ready) throw new Error(`Temporary SQLite vault failed to open: ${service.error}`);
    const userRows = [], memoryRows = [];
    for (const [index, quote] of ['我以前常在上海生活。', '我现在常在北京生活。'].entries()) {
      const userId = `sqlite-evidence-${index}`;
      const recordId = `sqlite-memory-${index}`;
      userRows.push({ id: userId, kind: 'message', ts: now++, domain: 'work', visibilityFloor: 0,
        value: { role: 'user', content: quote, sources: [] } });
      memoryRows.push({ id: recordId, kind: 'memory', ts: now++, domain: 'work', visibilityFloor: 0,
        value: { content: index ? '居住北京' : '居住上海', status: 'confirmed', memoryKind: 'fact', key: 'user.city',
          evidence: quote, evidenceSourceId: userId, origin: 'user-statement', sources: [userId] } });
    }
    await service.write(userRows, service.epoch, { notify: false });
    await service.write(memoryRows, service.epoch, { notify: false });
    const calls = [];
    const worker = createSemanticDream({ memory: service, clock: () => now++, analyze: async inputs => {
      calls.push(inputs.length);
      return createValidAnalysis(inputs, 'update');
    } });
    const result = await worker.run();
    assert.equal(result.status, 'done');
    assert.equal(result.relations, 1);
    const relation = (await service.query('state', 20, { scene: null, domain: 'work', visibilityFloor: 0 }))
      .find(row => row.value.origin === 'semantic-relation-v1');
    assert(relation);
    assert.equal(relation.value.relation, 'update');
    assert.equal(relation.kind, 'state');
    assert.equal(relation.value.analysisSnapshots.length, 4);
    const markedRelations = await service.query('state', 20, { scene: 'life', domain: 'work', visibilityFloor: 0,
      requiredMarkers: ['bunny_knowledge_relation'] });
    assert(markedRelations.some(row => row.id === relation.id), 'semantic relations use the knowledge marker query path');
    assert(changes.some(event => event.type === 'memory-changed'), 'new knowledge relation invalidates the open memory view');
    const changesAfterRelation = changes.length;
    assert.equal((await worker.run()).analyzed, 0, 'SQLite cache prevents a second model call for unchanged snapshots');
    assert.equal(calls.length, 1);
    assert.equal(changes.length, changesAfterRelation, 'no-change scan does not emit a spurious view refresh');

    const backupPassphrase = 'semantic-dream-fresh-key-fixture';
    const backup = await service.export(backupPassphrase);
    let restoredNow = now + 86_400_000;
    const destination = new MemoryService({ dir: path.join(temp, 'restored-new-key'), bin: VAULT_BIN,
      openKey: async () => Buffer.alloc(32, 0x21), getSettings: () => ({ enabled: true, extract: false, scene: 'life' }),
      clock: () => restoredNow++, random: () => 0 });
    try {
      await destination.init();
      if (!destination.ready) throw new Error(`Fresh-key restore vault failed to open: ${destination.error}`);
      const restored = await destination.restore(backup, backupPassphrase);
      assert.equal(restored.ok, true);
      const beforeRelations = (await destination.query('state', 100, { scene: null, domain: 'work', visibilityFloor: 0 }))
        .filter(row => row.value.origin === 'semantic-relation-v1');
      const beforeCaches = (await destination.query('state', 100, { scene: null, domain: 'work', visibilityFloor: 0 }))
        .filter(row => row.value.origin === 'semantic-analysis-cache-v1');
      assert.equal(beforeRelations.length, 1);
      assert.equal(beforeCaches.length, 1);
      const cacheIdBefore = beforeCaches[0].id;
      const relationIdBefore = beforeRelations[0].id;
      let restoreModelCalls = 0;
      const restoredWorker = createSemanticDream({ memory: destination, clock: () => restoredNow++, analyze: async inputs => {
        restoreModelCalls++;
        return createValidAnalysis(inputs, 'update');
      } });
      const idempotent = await restoredWorker.run();
      assert.equal(idempotent.status, 'done');
      assert.equal(idempotent.analyzed, 0, 'fresh key restore reuses the opaque member-ID cache with zero model calls');
      assert.equal(restoreModelCalls, 0);
      assert.equal((await destination.query('state', 100, { scene: null, domain: 'work', visibilityFloor: 0 }))
        .filter(row => row.value.origin === 'semantic-relation-v1').length, 1, 'restore must not duplicate relations');

      const member = (await destination.query('memory', 20, { scene: null, domain: 'work', visibilityFloor: 0 }))
        .find(row => row.id === 'sqlite-memory-0');
      assert(member);
      await destination.write([{ ...member, updatedAt: restoredNow++, value: { ...member.value, content: '后来确认居住上海' } }]);
      restoredNow += 86_400_000;
      const refreshedWorker = createSemanticDream({ memory: destination, clock: () => restoredNow++, analyze: async inputs => {
        restoreModelCalls++;
        return createValidAnalysis(inputs, 'update');
      } });
      const refreshed = await refreshedWorker.run();
      assert.equal(refreshed.status, 'done');
      assert.equal(restoreModelCalls, 1, 'same member IDs with changed snapshot are analyzed again');
      const finalRows = await destination.query('state', 100, { scene: null, domain: 'work', visibilityFloor: 0 });
      const finalRelations = finalRows.filter(row => row.value.origin === 'semantic-relation-v1');
      const finalCache = finalRows.find(row => row.value.origin === 'semantic-analysis-cache-v1');
      assert.equal(finalRelations.length, 2);
      const oldRelation = finalRelations.find(row => row.id === relationIdBefore);
      const newRelation = finalRelations.find(row => row.id !== relationIdBefore);
      assert.equal(oldRelation.value.status, 'superseded');
      assert.deepEqual(oldRelation.value.supersededBy, [newRelation.id]);
      assert.equal(newRelation.value.status, 'proposed');
      assert.equal(finalCache.id, cacheIdBefore, 'content changes do not alter the member-identity cache ID');
      assert.deepEqual(finalCache.value.relationIds, [newRelation.id], 'cache atomically points at the refreshed relation');
      assert.equal(beforeCaches[0].value.algorithmVersion, '1');
    } finally {
      await destination.close();
    }

    const removed = await service.remove('sqlite-evidence-0');
    assert(removed.removed > 1, 'removing an original evidence message cascades through relation and cache');
    assert.equal((await service.db.request('get', { ids: [relation.id], scene: 'work' })).rows.length, 0);
  } finally {
    await service.close();
  }
}

async function main() {
  await testSixPartitionsAndIdempotentCache();
  await testFullInputSnapshotsAndSixMemberCap();
  await testStrictEvidenceAndRelationTypes();
  await testBudgetCancellationAndStaleDeletion();
  await testRestartCacheAndProtectedNamespace();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-semantic-dream-'));
  try { await testRealSqliteLineage(temp); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log('semantic dream checks passed (six partitions, strict evidence, restart cache, SQLite lineage)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
