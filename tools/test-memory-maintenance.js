'use strict';

const assert = require('node:assert/strict');
const { MemoryMaintenance, normalizeTags, MAX_MESSAGES } = require('../src/main/memory-maintenance');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error(`timeout: ${label}`);
}

class FakeMemory {
  constructor() {
    this.key = Buffer.alloc(32, 14); // Test-only deterministic HMAC key.
    this.records = new Map();
    this.nextSeq = 1;
    this.epoch = 1;
    this.generation = 1;
    this.closed = false;
    this.tail = Promise.resolve();
    this.writes = [];
    this.decode = row => ({ ...row, value: row.value });
    this.db = { request: async (op, payload) => {
      if (op !== 'get') throw new Error(`unexpected fake db op ${op}`);
      return { rows: payload.ids.map(id => this.records.get(id)).filter(Boolean).map(row => ({ ...row, value: row.value })) };
    } };
  }
  async serial(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async query(kind, limit = 50, cursor = {}) {
    let rows = [...this.records.values()].filter(row => !kind || row.kind === kind);
    if (cursor.state !== 'all') rows = rows.filter(row => row.state !== 'archived');
    if (cursor.domain) rows = rows.filter(row => row.domain === cursor.domain);
    if (Number.isInteger(cursor.visibilityFloor)) rows = rows.filter(row => row.visibilityFloor === cursor.visibilityFloor);
    if (cursor.afterSeq !== undefined) rows = rows.filter(row => row.ingestionSeq > cursor.afterSeq);
    if (cursor.beforeSeq !== undefined) rows = rows.filter(row => row.ingestionSeq < cursor.beforeSeq);
    if (cursor.sort === 'ingestion') rows.sort((a, b) => cursor.order === 'asc' ? a.ingestionSeq - b.ingestionSeq : b.ingestionSeq - a.ingestionSeq);
    else rows.sort((a, b) => cursor.order === 'asc' ? a.ts - b.ts || a.id.localeCompare(b.id) : b.ts - a.ts || b.id.localeCompare(a.id));
    return rows.slice(0, limit).map(row => ({ ...row, value: { ...row.value, sources: [...(row.value.sources || [])] } }));
  }
  async write(records, epoch = this.epoch) {
    if (epoch !== this.epoch) throw Object.assign(new Error('stale epoch'), { code: 'stale_epoch' });
    if (records.length > 200) throw new Error('write batch limit');
    const staged = new Map(this.records);
    for (const record of records) {
      for (const sourceId of record.value.sources || []) {
        const source = staged.get(sourceId);
        if (!source) throw new Error(`missing source ${sourceId}`);
        if (record.visibilityFloor < source.visibilityFloor) throw new Error('floor downgrade');
      }
      const prior = staged.get(record.id);
      const ingestionSeq = prior?.ingestionSeq ?? record.ingestionSeq ?? this.nextSeq++;
      this.nextSeq = Math.max(this.nextSeq, ingestionSeq + 1);
      staged.set(record.id, { ...record, ingestionSeq, state: record.state || 'active', updatedAt: record.updatedAt || record.ts, value: { ...record.value, sources: [...(record.value.sources || [])] } });
    }
    this.records = staged;
    this.epoch++;
    this.writes.push(records.map(row => ({ ...row, value: { ...row.value } })));
  }
  seed(row) {
    const prior = this.records.get(row.id);
    const ingestionSeq = prior?.ingestionSeq ?? row.ingestionSeq ?? this.nextSeq++;
    this.nextSeq = Math.max(this.nextSeq, ingestionSeq + 1);
    this.records.set(row.id, { state: 'active', updatedAt: row.ts, ...row, ingestionSeq, value: { sources: [], ...row.value } });
    if (!prior) this.epoch++;
  }
}

function message(id, role, content, ts, domain = 'private', visibilityFloor = 2) {
  return { id, kind: 'message', ts, domain, visibilityFloor, state: 'active', value: { role, content, sources: [] } };
}
function makeWorker(memory, options = {}) {
  return new MemoryMaintenance({ memory, extract: options.extract || (async () => ({ memories: [], excerpts: [] })),
    canRun: options.canRun || (() => true), onStatus: options.onStatus, clock: options.clock || (() => 10_000),
    allowAutomatic: options.allowAutomatic || (() => true),
    maxMessages: options.maxMessages, maxChars: options.maxChars, maxCalls: options.maxCalls, windowMs: options.windowMs,
    maxCallsPerDay: options.maxCallsPerDay,
    setTimer: options.setTimer, clearTimer: options.clearTimer });
}
async function waitForIdle(worker) { await until(() => worker.status().status === 'idle', 'worker idle'); }

async function testDozeValidationAndCheckpoint() {
  const memory = new FakeMemory();
  memory.seed(message('u-1', 'user', '我喜欢沿海步道，周末会去散步。', 100));
  memory.seed(message('a-1', 'assistant', '听起来你喜欢海边散步。', 101));
  memory.seed(message('u-2', 'user', '另外我不吃花生。', 102));
  const calls = [];
  const worker = makeWorker(memory, { extract: async input => {
    calls.push(input);
    return {
      memories: [
        { sourceId: 'u-1', content: '喜欢海边步道', evidence: '我喜欢沿海步道', tags: ['散步', '休闲', '散步', '音乐', '标签4', '标签5', '标签6', '标签7', '标签8', '标签9', 'password:secret'] },
        { sourceId: 'a-1', content: '用户喜欢海边', evidence: '听起来你喜欢海边' },
        { sourceId: 'u-2', content: '喜欢花生', evidence: '我吃花生' },
        { sourceId: 'u-2', content: '伪造证据', evidence: '假设我住在火星' },
      ],
      excerpts: [
        { sourceId: 'u-1', quote: '我喜欢沿海步道' },
        { sourceId: 'a-1', quote: '听起来你喜欢海边散步。' },
        { sourceId: 'u-2', quote: '这不是原文' },
      ],
    };
  } });
  assert.deepEqual(worker.request('doze'), { ok: true, queued: true });
  await waitForIdle(worker);
  assert.equal(calls.length, 1, 'one batch uses one existing extraction call');
  assert.deepEqual(calls[0].map(x => x.id), ['u-1', 'a-1', 'u-2']);
  const memories = [...memory.records.values()].filter(r => r.kind === 'memory');
  assert.equal(memories.length, 1, 'assistant claims, fabricated evidence, and invalid excerpts are not user facts');
  assert.equal(memories[0].value.status, 'pending', 'all model-derived memories remain review candidates');
  assert.equal(memories[0].value.evidenceSourceId, 'u-1');
  assert.deepEqual(memories[0].value.sources, ['u-1', 'a-1', 'u-2'], 'every model input is provenance, even when not selected as evidence');
  assert.equal(memories[0].domain, 'private');
  assert.equal(memories[0].visibilityFloor, 2);
  assert.deepEqual(memories[0].value.tags, ['散步', '休闲', '音乐', '标签4', '标签5', '标签6', '标签7', '标签8']);
  const summary = [...memory.records.values()].find(r => r.kind === 'summary');
  assert.equal(summary.value.content, '用户说：我喜欢沿海步道\n助手答：听起来你喜欢海边散步。');
  assert.deepEqual(summary.value.sources, ['u-1', 'a-1', 'u-2']);
  assert.equal(summary.domain, 'private');
  const checkpoint = memory.records.get('maintenance:private:2');
  assert.deepEqual(checkpoint.value.watermark, { ingestionSeq: memory.records.get('u-2').ingestionSeq, ts: 102, id: 'u-2' });
  assert.equal(checkpoint.ts, 0, 'maintenance state cannot outrank companion-state in latest-state queries');
  assert.equal(memory.writes.at(-1).some(r => r.id === checkpoint.id), true, 'derivatives and checkpoint share one atomic write');
  await worker.request('doze');
  await waitForIdle(worker);
  assert.equal(calls.length, 1, 'a completed watermark is not re-extracted');
  await worker.close();
}

async function testPartitionBoundariesAndRestart() {
  const memory = new FakeMemory();
  memory.seed(message('life-msg', 'user', '生活范围的原文', 20, 'life', 1));
  memory.seed(message('work-msg', 'user', '工作范围的原文', 21, 'work', 0));
  const seen = [];
  const extract = async batch => { seen.push(batch[0].id); return { memories: [], excerpts: [{ sourceId: batch[0].id, quote: batch[0].content }] }; };
  let worker = makeWorker(memory, { extract });
  worker.request('doze'); await waitForIdle(worker); await worker.close();
  assert.deepEqual(seen.sort(), ['life-msg', 'work-msg']);
  assert.equal(memory.records.get('maintenance:life:1').value.watermark.id, 'life-msg');
  assert.equal(memory.records.get('maintenance:work:0').value.watermark.id, 'work-msg');
  assert.equal([...memory.records.values()].filter(r => r.kind === 'summary').find(r => r.value.sources.includes('life-msg')).visibilityFloor, 1);
  assert.equal([...memory.records.values()].filter(r => r.kind === 'summary').find(r => r.value.sources.includes('work-msg')).visibilityFloor, 0);
  memory.seed(message('life-next', 'user', '稍后新增的生活原文', 22, 'life', 1));
  worker = makeWorker(memory, { extract });
  worker.request('doze'); await waitForIdle(worker);
  assert.deepEqual(seen.sort(), ['life-msg', 'life-next', 'work-msg'], 'a restarted worker resumes from each partition watermark');
  assert.equal(memory.records.get('maintenance:life:1').value.watermark.id, 'life-next');
  await worker.close();
}

async function testIngestionCursorSameMillisecondRollbackAndRestart() {
  const memory = new FakeMemory();
  memory.seed(message('z-first', 'user', '这条先进入库。', 100));
  let calls = 0;
  const extract = async batch => {
    calls++;
    if (batch[0].id === 'z-first') {
      // Simulate a later insertion in the same wall-clock millisecond with a
      // lexically smaller random ID while the model call is outstanding.
      memory.seed(message('a-later', 'user', '这条同毫秒后入库但ID更小。', 100));
    }
    return { memories: [], excerpts: [{ sourceId: batch[0].id, quote: batch[0].content }] };
  };
  let worker = makeWorker(memory, { maxMessages: 1, extract });
  worker.request('doze'); await waitForIdle(worker); await worker.close();
  assert.equal(calls, 2, 'new ingestion after the snapshot is picked up by monotonic sequence');
  assert.equal(memory.records.get('maintenance:private:2').value.watermark.id, 'a-later');
  assert.equal(memory.records.get('maintenance:private:2').value.watermark.ingestionSeq, memory.records.get('a-later').ingestionSeq);
  assert(memory.records.get('z-first').ingestionSeq < memory.records.get('a-later').ingestionSeq);

  memory.seed(message('0-restarted', 'user', '重启后追加，时间回拨。', 20));
  worker = makeWorker(memory, { maxMessages: 1, extract });
  worker.request('doze'); await waitForIdle(worker); await worker.close();
  assert.equal(calls, 3, 'restart resumes strictly after the persisted ingestion sequence');
  assert.equal(memory.records.get('maintenance:private:2').value.watermark.id, '0-restarted');
}

async function testAbortAndGenerationChangeDoNotAdvance() {
  const memory = new FakeMemory();
  memory.seed(message('abort-msg', 'user', '暂停时不会截断或遗失这条来源。', 1));
  let extractionStarted;
  const started = new Promise(resolve => { extractionStarted = resolve; });
  let worker = makeWorker(memory, { extract: async (_batch, { signal }) => {
    extractionStarted();
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } });
  worker.request('doze'); await started; worker.cancel();
  await until(() => worker.status().status === 'paused', 'cancel pause');
  assert.equal(memory.records.has('maintenance:private:2'), false, 'abort does not advance the checkpoint');
  await worker.close();

  worker = makeWorker(memory, { extract: async () => { memory.generation++; return { memories: [], excerpts: [] }; } });
  worker.request('doze');
  await until(() => worker.status().status === 'paused', 'generation invalidation pause');
  assert.equal(memory.records.has('maintenance:private:2'), false, 'privacy generation changes reject late extraction output');
  await worker.close();
}

async function testBatchAndBudget() {
  const memory = new FakeMemory();
  for (let i = 0; i < MAX_MESSAGES + 2; i++) memory.seed(message(`u-${i}`, 'user', `编号${i}`, i + 1));
  let now = 1_000;
  let calls = 0;
  const worker = makeWorker(memory, { clock: () => now, maxMessages: 1, maxCalls: 3, extract: async batch => {
    calls++; assert.equal(batch.length, 1); return { memories: [], excerpts: [{ sourceId: batch[0].id, quote: batch[0].content }] };
  } });
  worker.request('doze');
  await until(() => worker.status().status === 'queued' && worker.status().note.includes('预算'), '3-call budget pause');
  assert.equal(calls, 3);
  for (let round = 0; round < 20 && worker.status().status !== 'idle'; round++) {
    now += 60_001;
    await worker.tick();
  }
  await waitForIdle(worker);
  assert.equal(calls, MAX_MESSAGES + 2, 'one batch never exceeds the per-call row limit and resumes within the rolling call budget');
  assert.equal(memory.records.get('maintenance:private:2').value.watermark.id, `u-${MAX_MESSAGES + 1}`);
  await worker.close();

  const longMemory = new FakeMemory();
  longMemory.seed(message('too-long', 'user', '一'.repeat(30), 1));
  const oversized = makeWorker(longMemory, { maxChars: 10, extract: async () => { throw new Error('must not run'); } });
  oversized.request('doze');
  await until(() => oversized.status().status === 'failed', 'oversized message stop');
  assert.equal(longMemory.records.has('maintenance:private:2'), false, 'oversized input is neither truncated nor skipped');
  await oversized.close();
}

async function testPersistedDailyBudgetAcrossRestart() {
  const memory = new FakeMemory();
  memory.seed(message('budget-1', 'user', '第一条。', 1));
  memory.seed(message('budget-2', 'user', '第二条。', 2));
  let now = 10_000;
  let calls = 0;
  const extract = async batch => { calls++; return { memories: [], excerpts: [{ sourceId: batch[0].id, quote: batch[0].content }] }; };
  let worker = makeWorker(memory, { clock: () => now, maxMessages: 1, maxCallsPerDay: 1, extract });
  worker.request('doze');
  await until(() => worker.status().status === 'queued' && worker.status().note.includes('每日'), 'daily budget pause');
  assert.equal(calls, 1);
  await worker.close();

  worker = makeWorker(memory, { clock: () => now, maxMessages: 1, maxCallsPerDay: 1, extract });
  worker.request('doze');
  await until(() => worker.status().status === 'queued' && worker.status().note.includes('每日'), 'daily budget survives restart');
  assert.equal(calls, 1, 'restart cannot reset the persisted daily call budget');
  now += 24 * 60 * 60_000 + 1;
  await worker.tick();
  await waitForIdle(worker);
  assert.equal(calls, 2, 'budget becomes available after the rolling day expires');
  await worker.close();
}

async function testDreamExactDuplicateOnlyAndDozeFirst() {
  const memory = new FakeMemory();
  memory.seed(message('doze-first', 'user', '先吸收新增，再归档旧重复。', 1));
  memory.seed({ id: 'm-1', kind: 'memory', ts: 2, domain: 'private', visibilityFloor: 2, value: { content: '完全相同的普通事实', status: 'confirmed', importance: 0.6, memoryKind: 'fact', sources: ['doze-first'] } });
  memory.seed({ id: 'm-2', kind: 'memory', ts: 3, domain: 'private', visibilityFloor: 2, value: { content: '完全相同的普通事实', status: 'confirmed', importance: 0.6, memoryKind: 'fact', sources: ['doze-first'] } });
  memory.seed({ id: 'm-pinned', kind: 'memory', ts: 4, domain: 'private', visibilityFloor: 2, value: { content: '完全相同的普通事实', status: 'confirmed', importance: 1, memoryKind: 'fact', sources: ['doze-first'] } });
  memory.seed({ id: 'm-work', kind: 'memory', ts: 5, domain: 'work', visibilityFloor: 0, value: { content: '完全相同的普通事实', status: 'confirmed', importance: 0.6, memoryKind: 'fact', sources: ['doze-first'] } });
  memory.seed({ id: 'm-other-kind', kind: 'memory', ts: 6, domain: 'private', visibilityFloor: 2, value: { content: '完全相同的普通事实', status: 'confirmed', importance: 0.6, memoryKind: 'preference', sources: ['doze-first'] } });
  const order = [];
  const worker = makeWorker(memory, { extract: async batch => {
    order.push('extract'); return { memories: [], excerpts: [{ sourceId: batch[0].id, quote: batch[0].content }] };
  } });
  worker.request('dream'); await waitForIdle(worker);
  assert.equal(order[0], 'extract', 'dream completes doze before archiving');
  assert.equal(memory.records.get('m-1').state, 'active', 'oldest exact duplicate remains canonical');
  assert.equal(memory.records.get('m-2').state, 'archived');
  assert.equal(memory.records.get('m-2').value.content, '完全相同的普通事实', 'archive preserves the original content');
  assert([...memory.records.values()].some(row => row.id.startsWith('dream-archive-v1:') && row.value.status === 'archived-duplicate'));
  assert.equal(memory.records.get('m-pinned').state, 'active', 'pinned records are never archived');
  assert.equal(memory.records.get('m-work').state, 'active', 'identical content in another partition is not a duplicate');
  assert.equal(memory.records.get('m-other-kind').state, 'active', 'same text with a different memory kind is kept conservatively');
  await worker.close();
}

async function testDailyDueAndTags() {
  assert.deepEqual(normalizeTags([' A ', 'Ａ', 'B']).slice(0, 2), ['a', 'b']);
  const memory = new FakeMemory();
  let now = new Date(2026, 9, 26, 4, 59, 0, 0).getTime();
  const worker = makeWorker(memory, { clock: () => now });
  assert.equal(await worker.checkDue(now), false, 'daily schedule does not start before local 05:00');
  now = new Date(2026, 9, 26, 5, 0, 0, 0).getTime();
  assert.equal(await worker.checkDue(now), true, 'daily due work starts at local 05:00');
  await waitForIdle(worker);
  assert.equal(memory.records.get('maintenance:daily-schedule').value.lastDueLocalDate, '2026-10-26');
  assert.equal(await worker.checkDue(now + 60_000), false, 'daily work is deduplicated for the local date');
  await worker.close();
}

async function testAutomaticPreferenceAndManualOverride() {
  const memory = new FakeMemory(); memory.seed(message('automatic-source', 'user', '关闭自动整理时仍保留这条原文。', 1));
  let calls = 0, automatic = false;
  const worker = makeWorker(memory, { allowAutomatic: () => automatic, extract: async () => { calls++; return { memories: [], excerpts: [] }; } });
  worker.request('doze', { automatic: true });
  await until(() => worker.status().status === 'paused', 'automatic disabled pause');
  assert.equal(calls, 0);
  assert.equal(memory.records.has('maintenance:private:2'), false);
  worker.request('doze');
  await waitForIdle(worker);
  assert.equal(calls, 1, 'an explicit manual request can run while automatic organization is disabled');
  assert.equal(memory.records.get('maintenance:private:2').value.watermark.id, 'automatic-source');
  await worker.close();

  const pendingMemory = new FakeMemory(); pendingMemory.seed(message('late-automatic', 'user', '关闭时不能提交迟到结果。', 2));
  let started; const begin = new Promise(resolve => { started = resolve; }); automatic = true;
  const pending = makeWorker(pendingMemory, { allowAutomatic: () => automatic, extract: async (_batch, { signal }) => {
    started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { memories: [], excerpts: [] };
  } });
  pending.request('doze', { automatic: true }); await begin; automatic = false; pending.cancel(); await pending.tick();
  assert.equal(pendingMemory.records.has('maintenance:private:2'), false, 'late automatic results cannot advance progress after cancellation');
  await pending.tick(); assert.equal(pending.status().status, 'paused'); await pending.close();
}

async function main() {
  await testDozeValidationAndCheckpoint();
  await testPartitionBoundariesAndRestart();
  await testIngestionCursorSameMillisecondRollbackAndRestart();
  await testAbortAndGenerationChangeDoNotAdvance();
  await testBatchAndBudget();
  await testPersistedDailyBudgetAcrossRestart();
  await testDreamExactDuplicateOnlyAndDozeFirst();
  await testDailyDueAndTags();
  await testAutomaticPreferenceAndManualOverride();
  console.log('memory-maintenance fixtures passed (synthetic in-memory store; no production vault or model calls)');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
