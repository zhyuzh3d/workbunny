'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { ContextCompression, HEAD_TEXT_BUDGET, MAX_SEGMENTS, currentId, headId } = require('../src/main/context-compression');
const { rank } = require('../src/main/memory-scope');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const fixedKey = Buffer.alloc(32, 0x46);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 3000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error(`timeout: ${label}`);
}

function currentHeadId(memory, scene) {
  return memory.records.get(currentId(scene))?.value?.headId || headId(scene);
}

function currentHead(memory, scene) { return memory.records.get(currentHeadId(memory, scene)); }

class FakeMemory {
  constructor() {
    this.records = new Map();
    this.nextSeq = 1;
    this.epoch = 1;
    this.generation = 1;
    this.sceneEpoch = 1;
    this.closed = false;
    this.tail = Promise.resolve();
    this.writes = [];
    this.decode = row => ({ ...row, value: structuredClone(row.value) });
    this.db = { request: async (op, payload) => {
      if (op !== 'get') throw new Error(`unexpected fake db operation ${op}`);
      const visible = payload.scene === undefined ? null : rank(payload.scene);
      return { rows: payload.ids.map(id => this.records.get(id)).filter(row => row && (visible === null || row.visibilityFloor <= visible))
        .map(row => ({ ...row, value: structuredClone(row.value) })) };
    } };
  }
  async serial(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async query(kind, limit = 50, cursor = {}) {
    const visible = cursor.scene === undefined ? null : rank(cursor.scene);
    let rows = [...this.records.values()].filter(row => (!kind || row.kind === kind) &&
      (row.state || 'active') === 'active' && (visible === null || row.visibilityFloor <= visible));
    if (cursor.domain) rows = rows.filter(row => row.domain === cursor.domain);
    if (Number.isInteger(cursor.visibilityFloor)) rows = rows.filter(row => row.visibilityFloor === cursor.visibilityFloor);
    if (cursor.afterSeq !== undefined) rows = rows.filter(row => row.ingestionSeq > cursor.afterSeq);
    if (cursor.beforeSeq !== undefined) rows = rows.filter(row => row.ingestionSeq < cursor.beforeSeq);
    rows.sort((a, b) => cursor.sort === 'ingestion'
      ? (cursor.order === 'desc' ? b.ingestionSeq - a.ingestionSeq : a.ingestionSeq - b.ingestionSeq)
      : (cursor.order === 'desc' ? b.ts - a.ts : a.ts - b.ts));
    return rows.slice(0, limit).map(row => ({ ...row, value: structuredClone(row.value) }));
  }
  seed(row) {
    const ingestionSeq = row.ingestionSeq ?? this.nextSeq++;
    this.nextSeq = Math.max(this.nextSeq, ingestionSeq + 1);
    this.records.set(row.id, { state: 'active', ...row, ingestionSeq, value: { sources: [], ...structuredClone(row.value) } });
    this.epoch++;
    return this.records.get(row.id);
  }
  async write(records, epoch = this.epoch) {
    if (epoch !== this.epoch) throw Object.assign(new Error('stale epoch'), { code: 'stale_epoch' });
    assert(records.length <= 200);
    const staged = new Map(this.records);
    for (const record of records) {
      const sources = record.value.sources || [];
      assert(sources.length <= 200);
      for (const id of sources) {
        const source = staged.get(id);
        if (!source) throw new Error(`missing source ${id}`);
        assert(record.visibilityFloor >= source.visibilityFloor, 'scope cannot be lowered');
      }
      const prior = staged.get(record.id);
      staged.set(record.id, { ...structuredClone(record), state: 'active',
        ingestionSeq: prior?.ingestionSeq ?? this.nextSeq++, updatedAt: record.updatedAt || record.ts,
        value: { ...structuredClone(record.value), sources: [...sources] } });
    }
    this.records = staged;
    this.epoch++;
    this.writes.push(records.map(row => structuredClone(row)));
  }
  removeCascade(id) {
    const removed = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of this.records.values()) {
        if (!removed.has(row.id) && (row.value.sources || []).some(source => removed.has(source))) {
          removed.add(row.id); changed = true;
        }
      }
    }
    for (const item of removed) this.records.delete(item);
    this.epoch++;
    this.generation++;
    return [...removed];
  }
}

function seedMessage(memory, { id, role, content, scene, turnId, ts, delivery, source }) {
  return memory.seed({ id, kind: 'message', ts, domain: scene, visibilityFloor: rank(scene),
    value: { role, content, turnId, ...(delivery ? { delivery } : {}), ...(source ? { source } : {}), sources: [] } });
}

function seedTurns(memory, scene, count, { tsStart = 1_000_000, contentPrefix = scene } = {}) {
  const rows = [];
  for (let turn = 1; turn <= count; turn++) {
    const turnId = `${scene}-turn-${turn}`;
    rows.push(seedMessage(memory, { id: `${turnId}-user`, role: 'user', content: `${contentPrefix}-USER-${turn}`, scene, turnId, ts: tsStart - turn }));
    rows.push(seedMessage(memory, { id: `${turnId}-assistant`, role: 'assistant', content: `${contentPrefix}-ASSISTANT-${turn}`, scene, turnId, ts: tsStart - turn - 1 }));
  }
  return rows;
}

function summaryFn(calls) {
  return async (messages, { scene, signal }) => {
    calls.push({ scene, messages: structuredClone(messages) });
    if (signal.aborted) return { content: 'should-not-commit', excerpts: [] };
    return { content: `导航 ${scene} ${calls.length}`, excerpts: messages.slice(0, 1).map(row => ({ sourceId: row.id, quote: row.content })) };
  };
}

function makeWorker(memory, calls, options = {}) {
  return new ContextCompression({ memory, summarize: options.summarize || summaryFn(calls), clock: () => 2_000_000,
    recentRounds: options.recentRounds ?? 2, maxMessages: options.maxMessages ?? 40, maxChars: options.maxChars ?? 28_000 });
}

async function testSceneLanesRecentTailAndIdempotency() {
  const memory = new FakeMemory();
  seedTurns(memory, 'work', 6);
  seedTurns(memory, 'life', 6);
  seedTurns(memory, 'private', 6);
  const calls = [];
  const worker = makeWorker(memory, calls);
  let reservations = 0;
  const reserveModelCall = async () => { reservations++; return { ok: true }; };
  const result = await worker.run({ reserveModelCall });
  assert.equal(result.status, 'done');
  assert.equal(result.versions.work, 1);
  assert.equal(result.versions.life, 1);
  assert.equal(result.versions.private, 1);
  assert.equal(result.processed, 60, 'per-view output covers old complete rounds while leaving each view tail intact');

  const callByScene = new Map(calls.map(call => [call.scene, call]));
  const workInput = callByScene.get('work').messages;
  const lifeInput = callByScene.get('life').messages;
  const privateInput = callByScene.get('private').messages;
  assert(workInput.every(row => row.id.startsWith('work-')));
  assert(lifeInput.some(row => row.id.startsWith('work-')) && lifeInput.some(row => row.id.startsWith('life-')));
  assert(lifeInput.every(row => !row.id.startsWith('private-')));
  assert(privateInput.some(row => row.id.startsWith('private-')) && privateInput.some(row => row.id.startsWith('life-')) && privateInput.some(row => row.id.startsWith('work-')));
  for (const call of calls) {
    assert(!call.messages.some(row => /-(?:user|assistant)-(?:5|6)$/.test(row.id)), `${call.scene} tail turns must not be compressed`);
    const head = currentHead(memory, call.scene);
    assert.equal(head.value.origin, 'context-head-v2');
    assert.equal(head.domain, call.scene);
    assert.equal(head.visibilityFloor, rank(call.scene));
    assert.equal(head.value.segments.length, 1);
    const segment = memory.records.get(head.value.segments[0].id);
    assert.equal(segment.value.origin, 'context-segment-v1');
    assert.deepEqual(segment.value.sources, call.messages.map(row => row.id), 'segment source coverage equals every summarize input');
    assert(head.value.sources.includes(segment.id), 'head cites the already-persisted immutable segment');
    assert.equal(head.value.sources.includes(segment.value.sources[0]), false, 'raw batch sources remain below the segment');
    assert(head.value.text.length <= HEAD_TEXT_BUDGET);
    const snap = await worker.snapshot(call.scene);
    assert.equal(snap.version, 1);
    assert.equal(snap.text, head.value.text);
    assert.equal(snap.recordId, head.id);
    assert.equal(snap.updatedAt, head.updatedAt);
    assert.equal(snap.sourceIds[0], head.id, 'the exact head version is available as a downstream source');
    assert(!snap.sourceIds.includes(currentId(call.scene)), 'the mutable navigation pointer is never exposed as a source');
    assert(snap.sourceIds.length <= 200);
  }
  const writesBefore = memory.writes.length, callsBefore = calls.length;
  const reservationsBefore = reservations;
  const second = await worker.run({ reserveModelCall });
  assert.equal(second.status, 'done');
  assert.equal(calls.length, callsBefore, 'no newly eligible messages means zero summarize calls');
  assert.equal(reservations, reservationsBefore, 'no eligible messages do not reserve model-call budget');
  assert.equal(memory.writes.length, writesBefore, 'no eligible work means no state/version writes');

  const priorHeadIds = ['work', 'life', 'private'].map(scene => currentHeadId(memory, scene));
  memory.removeCascade('work-turn-1-user');
  assert(priorHeadIds.every(id => !memory.records.has(id)), 'deleting a source cascades through every view that cited it');
  assert.equal((await worker.snapshot('private')).version, 0, 'a deleted source cannot remain visible through a stale head');
  seedMessage(memory, { id: 'work-new-after-delete', role: 'user', content: 'new work turn', scene: 'work', turnId: 'work-new-after-delete', ts: -5 });
  const beforeRepairCalls = calls.length;
  const repaired = await worker.run();
  assert.equal(repaired.status, 'done');
  assert(calls.slice(beforeRepairCalls).every(call => !call.messages.some(row => row.id === 'work-turn-1-user')),
    'rebuild after cascade never resurrects the forgotten source');
}

async function testOrphansReceiptsAndLegacyTurnIds() {
  const memory = new FakeMemory();
  memory.seed({ id: 'orphan-assistant', kind: 'message', ts: 1, domain: 'work', visibilityFloor: 0,
    value: { role: 'assistant', content: '孤立助手消息', turnId: 'missing-turn', sources: [] } });
  seedMessage(memory, { id: 'legacy-user', role: 'user', content: 'legacy user', scene: 'work', ts: 2 });
  seedMessage(memory, { id: 'legacy-assistant', role: 'assistant', content: 'legacy adjacent assistant', scene: 'work', ts: 3 });
  seedMessage(memory, { id: 'legacy-receipt', role: 'assistant', content: 'do not summarize receipt', scene: 'work', ts: 4, delivery: 'task-receipt' });
  seedTurns(memory, 'work', 8, { tsStart: 100 }); // Supplies a recent user tail.
  const calls = [];
  const worker = makeWorker(memory, calls, { recentRounds: 2 });
  const result = await worker.run();
  assert.equal(result.status, 'done');
  const workCall = calls.find(call => call.scene === 'work');
  assert(workCall);
  assert.deepEqual(workCall.messages.slice(0, 2).map(row => row.id), ['legacy-user', 'legacy-assistant'], 'legacy missing turn IDs group only by adjacent user boundary');
  assert(!JSON.stringify(workCall).includes('孤立助手消息'));
  assert(!JSON.stringify(workCall).includes('do not summarize receipt'));
}

async function testPaginationRetainsWholeRoundsAndCapsHead() {
  const memory = new FakeMemory();
  seedTurns(memory, 'work', 13);
  const calls = [];
  const worker = makeWorker(memory, calls, { recentRounds: 1, maxMessages: 4, maxChars: 28_000,
    summarize: async (messages, { scene }) => {
      calls.push({ scene, messages: structuredClone(messages) });
      return { content: `Batch ${calls.length}: ${'完整句。'.repeat(250)}`, excerpts: messages.slice(0, 1).map(row => ({ sourceId: row.id, quote: row.content })) };
    } });
  const result = await worker.run();
  assert.equal(result.status, 'done');
  const workCalls = calls.filter(call => call.scene === 'work');
  assert.equal(workCalls.length, 6, 'bounded pages split only between complete turns');
  for (const call of workCalls) assert.equal(call.messages.length, 4, 'each model batch contains complete pairs of turns');
  const head = currentHead(memory, 'work');
  assert.equal(head.value.segments.length, MAX_SEGMENTS);
  assert(head.value.text.length <= 1800);
  for (const segmentMeta of head.value.segments) assert(memory.records.has(segmentMeta.id), 'head metadata references persisted immutable segments');
  const refs = head.value.sources.filter(id => id.startsWith('context-segment:v1:'));
  assert.equal(refs.length, MAX_SEGMENTS, 'head sources cite only the bounded immutable segment set');
  assert(head.value.sources.includes(head.value.segments.at(-1).id), 'head cites its already-persisted latest segment');
  const latestSegment = memory.records.get(head.value.segments.at(-1).id);
  assert(head.value.text.startsWith(latestSegment.value.content), 'head always preserves the latest full summary first');
  assert(head.value.text.length <= HEAD_TEXT_BUDGET);
  for (const excerpt of latestSegment.value.excerpts) {
    if (head.value.text.includes(`原文摘录：${excerpt.quote}`))
      assert(head.value.text.includes(`原文摘录：${excerpt.quote}`), 'selected excerpt blocks remain complete');
  }
}

async function testHeadPrioritizesFullLatestSummary() {
  const memory = new FakeMemory();
  for (let turn = 1; turn <= 9; turn++) {
    const turnId = `long-${turn}`;
    const body = `来源 ${turn}：` + `这是完整的原始资料句子。`.repeat(20);
    seedMessage(memory, { id: `${turnId}-user`, role: 'user', content: body, scene: 'work', turnId, ts: turn * 2 });
    seedMessage(memory, { id: `${turnId}-assistant`, role: 'assistant', content: `答复 ${turn}`, scene: 'work', turnId, ts: turn * 2 + 1 });
  }
  const longContent = '最新摘要完整句。'.repeat(149); // 1,192 chars: near the per-segment limit.
  const worker = makeWorker(memory, [], { recentRounds: 1, summarize: async messages => ({
    content: longContent,
    excerpts: messages.filter(row => row.role === 'user').slice(0, 8).map(row => ({
      sourceId: row.id, quote: row.content.slice(0, 150),
    })),
  }) });
  const result = await worker.run();
  assert.equal(result.status, 'done');
  const head = currentHead(memory, 'work');
  const latest = memory.records.get(head.value.segments.at(-1).id);
  assert.equal(latest.value.content, longContent);
  assert(head.value.text.startsWith(longContent), 'full latest content wins over excerpts that exceed the remaining budget');
  assert(head.value.text.length <= HEAD_TEXT_BUDGET);
  const excerptBlocks = latest.value.excerpts.map(item => `原文摘录：${item.quote}`);
  const included = excerptBlocks.filter(block => head.value.text.includes(block));
  assert(included.length >= 1 && included.length < excerptBlocks.length, 'only complete excerpt blocks that fit are selected');
  for (const block of excerptBlocks) assert.equal(head.value.text.includes(block), included.includes(block), 'an excerpt is either complete or absent');
}

async function testOversizeTurnAndExcerptValidation() {
  const memory = new FakeMemory();
  seedMessage(memory, { id: 'large-user', role: 'user', content: 'x'.repeat(11), scene: 'work', turnId: 'large', ts: 1 });
  for (let i = 0; i < 3; i++) seedMessage(memory, { id: `recent-${i}`, role: 'user', content: `recent${i}`, scene: 'work', turnId: `recent-${i}`, ts: 2 + i });
  const calls = [];
  const worker = makeWorker(memory, calls, { recentRounds: 2, maxChars: 10 });
  const result = await worker.run();
  assert.equal(result.status, 'paused', 'single over-budget round is preserved rather than truncated');
  assert.equal(calls.length, 0);
  assert.equal(currentHead(memory, 'work'), undefined);

  const tooManyMemory = new FakeMemory();
  seedMessage(tooManyMemory, { id: 'wide-turn-user', role: 'user', content: 'wide turn', scene: 'work', turnId: 'wide-turn', ts: 1 });
  for (let i = 0; i < 40; i++) seedMessage(tooManyMemory, { id: `wide-turn-assistant-${i}`, role: 'assistant', content: `reply-${i}`, scene: 'work', turnId: 'wide-turn', ts: 2 + i });
  seedMessage(tooManyMemory, { id: 'wide-recent-user', role: 'user', content: 'recent boundary', scene: 'work', turnId: 'wide-recent', ts: 50 });
  const tooManyCalls = [];
  const tooManyWorker = makeWorker(tooManyMemory, tooManyCalls, { recentRounds: 1, maxMessages: 40 });
  const tooMany = await tooManyWorker.run();
  assert.equal(tooMany.status, 'paused', 'a 41-message turn is not split to fit the source cap');
  assert.equal(tooManyCalls.length, 0);
  assert.equal(currentHead(tooManyMemory, 'work'), undefined);

  const validationMemory = new FakeMemory();
  seedTurns(validationMemory, 'work', 9);
  const invalidWorker = makeWorker(validationMemory, [], { recentRounds: 2, summarize: async () => ({
    content: 'navigation', excerpts: [{ sourceId: 'unrelated', quote: 'fabricated' }],
  }) });
  await assert.rejects(invalidWorker.run(), /格式|校验/);
  assert.equal(currentHead(validationMemory, 'work'), undefined, 'invalid source excerpts never commit a checkpoint');

  for (const invalidSummary of [
    { content: '', excerpts: [] },
    { content: 'ok', excerpts: [] },
    { content: 'valid navigation', excerpts: [{ sourceId: 'work-turn-1-user', quote: 'x' }] },
  ]) {
    const invalidMemory = new FakeMemory();
    seedTurns(invalidMemory, 'work', 9);
    const invalid = makeWorker(invalidMemory, [], { recentRounds: 2, summarize: async () => invalidSummary });
    await assert.rejects(invalid.run(), /无效|为空|引文/);
    assert.equal(currentHead(invalidMemory, 'work'), undefined, 'empty or trivial summaries do not advance the lane');
  }

  const corruptMemory = new FakeMemory();
  seedTurns(corruptMemory, 'work', 10);
  const corruptCalls = [];
  const corruptWorker = makeWorker(corruptMemory, corruptCalls, { recentRounds: 2 });
  assert.equal((await corruptWorker.run()).status, 'done');
  const corruptHead = currentHead(corruptMemory, 'work');
  corruptHead.value.origin = 'unknown-head-format';
  const callsBefore = corruptCalls.length;
  const writesBefore = corruptMemory.writes.length;
  const corruptResult = await corruptWorker.run();
  assert.equal(corruptResult.status, 'paused', 'an existing invalid head is not mistaken for a missing lane');
  assert.equal(corruptCalls.length, callsBefore, 'invalid head state does not make another model call');
  assert.equal(corruptMemory.writes.length, writesBefore, 'invalid head state is never overwritten');

  const immutableMemory = new FakeMemory();
  seedTurns(immutableMemory, 'work', 10);
  const immutableCalls = [];
  const immutableWorker = makeWorker(immutableMemory, immutableCalls, { recentRounds: 2 });
  assert.equal((await immutableWorker.run()).status, 'done');
  const immutableHead = currentHead(immutableMemory, 'work');
  const immutableSegmentId = immutableHead.value.segments[0].id;
  const immutableSegment = immutableMemory.records.get(immutableSegmentId);
  const savedContent = immutableSegment.value.content;
  const savedWrites = immutableMemory.writes.length;
  // Simulate a lost pointer while the immutable segment remains. Reuse must
  // rebuild the head without calling a possibly nondeterministic summarizer.
  immutableMemory.records.delete(immutableHead.id);
  immutableMemory.records.delete(currentId('work'));
  immutableMemory.epoch++;
  const changedCalls = [];
  const changedWorker = makeWorker(immutableMemory, changedCalls, { recentRounds: 2, summarize: async (...args) => {
    changedCalls.push(args);
    return { content: 'different retry output', excerpts: [{ sourceId: 'work-turn-1-user', quote: 'work-USER-1' }] };
  } });
  const retry = await changedWorker.run();
  assert.equal(retry.status, 'done');
  assert.equal(changedCalls.length, 0, 'valid orphan immutable segment is reused before reserving/calling a model');
  assert.equal(immutableMemory.records.get(immutableSegmentId).value.content, savedContent);
  assert.equal(immutableMemory.writes.length, savedWrites + 2, 'the missing immutable head and navigation pointer are rebuilt separately');
  assert.equal(currentHead(immutableMemory, 'work').value.segments[0].id, immutableSegmentId);

  // Corrupt deterministic content is not regenerated over or trusted.
  immutableMemory.records.delete(currentHeadId(immutableMemory, 'work'));
  immutableMemory.records.delete(currentId('work'));
  immutableMemory.records.get(immutableSegmentId).value.excerpts[0].quote = 'fabricated quote';
  immutableMemory.epoch++;
  const writesBeforeBadSegment = immutableMemory.writes.length;
  const badSegmentCalls = [];
  const badSegmentWorker = makeWorker(immutableMemory, badSegmentCalls, { recentRounds: 2 });
  assert.equal((await badSegmentWorker.run()).status, 'paused');
  assert.equal(badSegmentCalls.length, 0, 'corrupt immutable content fails closed without a replacement model call');
  assert.equal(immutableMemory.writes.length, writesBeforeBadSegment);
}

async function testSecretRoundsNeverReachSummarizer() {
  const memory = new FakeMemory();
  seedMessage(memory, { id: 'secret-user', role: 'user', content: '请使用 password: super-secret-12345', scene: 'work', turnId: 'secret-turn', ts: 1 });
  seedMessage(memory, { id: 'secret-assistant', role: 'assistant', content: '收到，我会处理这段私密凭据。'.repeat(300), scene: 'work', turnId: 'secret-turn', ts: 2 });
  seedMessage(memory, { id: 'normal-user', role: 'user', content: '下周安排会议', scene: 'work', turnId: 'normal-turn', ts: 3 });
  seedMessage(memory, { id: 'normal-assistant', role: 'assistant', content: '我可以帮你整理时间。', scene: 'work', turnId: 'normal-turn', ts: 4 });
  seedMessage(memory, { id: 'recent-1', role: 'user', content: 'recent one', scene: 'work', turnId: 'recent-1', ts: 5 });
  seedMessage(memory, { id: 'recent-2', role: 'user', content: 'recent two', scene: 'work', turnId: 'recent-2', ts: 6 });
  const calls = [];
  const reservations = [];
  const worker = makeWorker(memory, calls, { recentRounds: 2 });
  const result = await worker.run({ reserveModelCall: async signal => { reservations.push(signal); return { ok: true }; } });
  assert.equal(result.status, 'done');
  assert.equal(result.skippedSecretRounds.work, 1);
  assert(calls.length >= 1);
  for (const call of calls) assert.deepEqual(call.messages.map(row => row.id), ['normal-user', 'normal-assistant'],
    `${call.scene} must exclude the complete secret round while retaining the normal turn`);
  assert(!JSON.stringify(calls).includes('super-secret'));
  assert(!JSON.stringify(calls).includes('私密凭据'));
  assert.equal(reservations.length, calls.length);

  const secretOnly = new FakeMemory();
  seedMessage(secretOnly, { id: 'secret-only-user', role: 'user', content: 'api_key=abcdef0123456789', scene: 'work', turnId: 'secret-only', ts: 1 });
  seedMessage(secretOnly, { id: 'secret-only-assistant', role: 'assistant', content: '已收到', scene: 'work', turnId: 'secret-only', ts: 2 });
  seedMessage(secretOnly, { id: 'tail-one', role: 'user', content: 'tail one', scene: 'work', turnId: 'tail-one', ts: 3 });
  seedMessage(secretOnly, { id: 'tail-two', role: 'user', content: 'tail two', scene: 'work', turnId: 'tail-two', ts: 4 });
  const secretOnlyCalls = [];
  let secretOnlyReservations = 0;
  const secretOnlyResult = await makeWorker(secretOnly, secretOnlyCalls, { recentRounds: 2 }).run({
    reserveModelCall: async () => { secretOnlyReservations++; return { ok: true }; },
  });
  assert.equal(secretOnlyResult.status, 'done');
  assert.equal(secretOnlyResult.skippedSecretRounds.work, 1);
  assert.equal(secretOnlyCalls.length, 0, 'secret-only eligible history requires no model call');
  assert.equal(secretOnlyReservations, 0, 'secret-only eligible history reserves no model budget');
  assert.equal(currentHead(secretOnly, 'work'), undefined, 'secret-only history is not summarized into a head');
}

async function testBudgetAndCancellationBoundaries() {
  const budgetMemory = new FakeMemory();
  seedTurns(budgetMemory, 'work', 10);
  const calls = [];
  const budgetWorker = makeWorker(budgetMemory, calls, { recentRounds: 2 });
  const budget = await budgetWorker.run({ reserveModelCall: async () => ({ ok: false }) });
  assert.equal(budget.status, 'budget');
  assert.equal(calls.length, 0);
  assert.equal(currentHead(budgetMemory, 'work'), undefined);

  const canceledMemory = new FakeMemory();
  seedTurns(canceledMemory, 'work', 10);
  let startedResolve, releaseResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const cancelCalls = [];
  const canceledWorker = makeWorker(canceledMemory, cancelCalls, { recentRounds: 2, summarize: async (messages, { signal }) => {
    cancelCalls.push(messages);
    startedResolve();
    await release;
    return { content: signal.aborted ? 'late completion' : 'summary', excerpts: [] };
  } });
  const controller = new AbortController();
  const running = canceledWorker.run({ signal: controller.signal });
  await started;
  const firstInputId = cancelCalls[0][0].id;
  canceledMemory.removeCascade(firstInputId);
  controller.abort();
  releaseResolve();
  const result = await running;
  assert.equal(result.status, 'paused');
  assert.equal(currentHead(canceledMemory, 'work'), undefined, 'late model result cannot commit after cancellation/source deletion');
}

async function testRealSqliteContract(temp) {
  if (!fs.existsSync(bin)) throw new Error(`existing vault binary missing; test will not build it: ${bin}`);
  let now = Date.UTC(2026, 9, 27);
  const service = new MemoryService({
    dir: path.join(temp, 'native-vault'), bin,
    openKey: async () => Buffer.from(fixedKey),
    getSettings: () => ({ enabled: true, extract: false, scene: 'life' }),
    clock: () => now++, random: () => 0,
  });
  try {
    await service.init();
    const records = [];
    for (const scene of ['work', 'life', 'private']) {
      for (let turn = 1; turn <= 4; turn++) {
        const turnId = `native-${scene}-${turn}`;
        records.push({ id: `${turnId}-u`, kind: 'message', ts: now++, domain: scene, visibilityFloor: rank(scene),
          value: { role: 'user', content: `${scene} native user ${turn}`, turnId, sources: [] } });
        records.push({ id: `${turnId}-a`, kind: 'message', ts: now++, domain: scene, visibilityFloor: rank(scene),
          value: { role: 'assistant', content: `${scene} native answer ${turn}`, turnId, sources: [] } });
      }
    }
    await service.write(records, service.epoch, { notify: false });
    const calls = [];
    const worker = new ContextCompression({ memory: service, recentRounds: 1, clock: () => now++, summarize: async (messages, { scene }) => {
      calls.push({ scene, ids: messages.map(row => row.id) });
      return { content: `native ${scene} summary`, excerpts: [{ sourceId: messages[0].id, quote: messages[0].content }] };
    } });
    service.compression = worker;
    const result = await worker.run({ reserveModelCall: async () => ({ ok: true }) });
    assert.equal(result.status, 'done');
    assert.equal(calls.length, 3);
    for (const scene of ['work', 'life', 'private']) {
      const snapshot = await worker.snapshot(scene);
      assert.equal(snapshot.version, 1);
      assert(snapshot.text.includes(`native ${scene} summary`));
      const head = (await service.db.request('get', { ids: [snapshot.recordId], scene })).rows[0];
      assert(head, `native scene-filtered lookup returns ${scene} head`);
      const decoded = service.decode(head);
      assert.equal(decoded.domain, scene);
      assert.equal(decoded.visibilityFloor, rank(scene));
    }
    const none = await worker.run({ reserveModelCall: async () => ({ ok: true }) });
    assert.equal(none.status, 'done');
    assert.equal(calls.length, 3, 'native checkpoint restart does not call summarizer for unchanged ranges');

    // A later assistant may cite an immutable snapshot. A subsequent
    // compression publishes a new immutable head without updating that source.
    const firstSnapshot = await worker.snapshot('work');
    assert(firstSnapshot.recordId && firstSnapshot.sourceIds[0] === firstSnapshot.recordId);
    const firstHeadRow = (await service.db.request('get', { ids: [firstSnapshot.recordId], scene: 'work' })).rows[0];
    const firstHead = service.decode(firstHeadRow);
    const firstHeadValue = structuredClone(firstHead.value);
    await service.addMessage('user', 'work follow-up turn five question', { scene: 'work' });
    const context = await service.context('work follow-up turn five question', { scene: 'work' });
    assert(context.sourceIds.includes(firstSnapshot.recordId), 'context cites the immutable snapshot');
    assert(!context.sourceIds.includes(currentId('work')), 'context never cites the mutable pointer');
    await service.addMessage('assistant', 'work follow-up turn five answer', { scene: 'work', sources: context.sourceIds });
    await service.addMessage('user', 'work follow-up turn six question', { scene: 'work' });
    await service.addMessage('assistant', 'work follow-up turn six answer', { scene: 'work' });
    const secondRun = await worker.run({ reserveModelCall: async () => ({ ok: true }) });
    assert.equal(secondRun.status, 'done', 'new immutable checkpoint can be published after an assistant cites the old one');
    const secondSnapshot = await worker.snapshot('work');
    assert.equal(secondSnapshot.version, firstSnapshot.version + 1);
    assert.notEqual(secondSnapshot.recordId, firstSnapshot.recordId);
    const stillFirstRow = (await service.db.request('get', { ids: [firstSnapshot.recordId], scene: 'work' })).rows[0];
    assert(stillFirstRow, 'old immutable checkpoint remains reachable from the assistant provenance');
    const stillFirst = service.decode(stillFirstRow);
    assert.deepEqual(stillFirst.value, firstHeadValue, 'publishing a new checkpoint never mutates the old snapshot');

    const workSource = calls.find(call => call.scene === 'work').ids[0];
    await service.remove(workSource);
    for (const scene of ['work', 'life', 'private']) assert.equal((await worker.snapshot(scene)).version, 0,
      `native source deletion cascades its ${scene} projection head`);
  } finally {
    await service.close();
  }
}

async function main() {
  await testSceneLanesRecentTailAndIdempotency();
  await testOrphansReceiptsAndLegacyTurnIds();
  await testPaginationRetainsWholeRoundsAndCapsHead();
  await testHeadPrioritizesFullLatestSummary();
  await testOversizeTurnAndExcerptValidation();
  await testSecretRoundsNeverReachSummarizer();
  await testBudgetAndCancellationBoundaries();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-context-compression-'));
  try { await testRealSqliteContract(temp); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log('context compression checks passed (three scene lanes, bounded rounds, cancellation, temporary SQLite)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
