#!/usr/bin/env node
'use strict';

// Real SQLite regression for immutable context-head provenance. Uses only
// synthetic local data, the prebuilt vault helper, and deterministic summaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { ContextCompression, sourceDigest, HEAD_PREFIX, SEGMENT_PREFIX, currentId } = require('../src/main/context-compression');
const { rank } = require('../src/main/memory-scope');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'vault');
const KEY_A = Buffer.alloc(32, 0x4a);
const KEY_B = Buffer.alloc(32, 0xa4);
const PASSPHRASE = 'compression-provenance-test-passphrase';
let now = Date.UTC(2026, 9, 27);

function createService(dir, key = KEY_A) {
  return new MemoryService({ dir, bin: BIN, openKey: async () => Buffer.from(key),
    getSettings: () => ({ enabled: true, extract: false, scene: 'work' }),
    clock: () => now++, extract: async () => [] });
}

function summarize(calls) {
  return async (messages, { scene }) => {
    calls.push({ scene, messages: structuredClone(messages) });
    const first = messages[0];
    return { content: `第${calls.length}段，整理${scene}的完整对话。`,
      excerpts: [{ sourceId: first.id, quote: first.content.slice(0, 100) }] };
  };
}

function makeWorker(memory, calls, opts = {}) {
  return new ContextCompression({ memory, recentRounds: opts.recentRounds ?? 1,
    clock: () => now++, summarize: opts.summarize || summarize(calls) });
}

async function addTurn(memory, turn, { sourceIds = [] } = {}) {
  const turnId = `provenance-turn-${turn}`;
  await memory.addMessage('user', `这是合成的第${turn}轮用户原话。`, { scene: 'work', turnId });
  await memory.addMessage('assistant', `这是合成的第${turn}轮助手回复。`, { scene: 'work', turnId, sources: sourceIds });
}

async function currentHead(memory, scene = 'work') {
  const pointerRaw = (await memory.db.request('get', { ids: [currentId(scene)], scene })).rows[0];
  if (!pointerRaw) return { pointer: null, head: null };
  const pointer = memory.decode(pointerRaw);
  const headRaw = (await memory.db.request('get', { ids: [pointer.value.headId], scene })).rows[0];
  return { pointer, head: headRaw && memory.decode(headRaw) };
}

async function expectNoPointer(memory, scene = 'work') {
  assert.equal((await memory.db.request('get', { ids: [currentId(scene)] })).rows.length, 0);
}

async function testImmutableReferencesAndCycleFreeUpdates(dir) {
  const memory = createService(path.join(dir, 'cycle-free'));
  await memory.init();
  try {
    for (let i = 1; i <= 4; i++) await addTurn(memory, i);
    const calls = [];
    const worker = makeWorker(memory, calls);
    const first = await worker.run();
    assert.equal(first.status, 'done');
    const snapshot1 = await worker.snapshot('work');
    const firstHead = (await currentHead(memory)).head;
    assert(firstHead && firstHead.id.startsWith('context-head:v2:'));
    assert.equal(snapshot1.recordId, firstHead.id);
    assert.deepEqual(snapshot1.sourceIds, [firstHead.id]);
    assert(!snapshot1.sourceIds.includes(currentId('work')), 'mutable navigation pointer is never a downstream source');
    const fixedLegacy = (await memory.db.request('get', { ids: [HEAD_PREFIX + 'work'] })).rows;
    assert.equal(fixedLegacy.length, 0, 'new writes do not recreate the mutable v1 head ID');

    await addTurn(memory, 5, { sourceIds: snapshot1.sourceIds });
    await memory.addMessage('user', '这是第6轮用户的未完成尾部。', { scene: 'work', turnId: 'provenance-turn-6' });
    const second = await worker.run();
    assert.equal(second.status, 'done', 'writing a later head succeeds although an intervening assistant cited the earlier head');
    const snapshot2 = await worker.snapshot('work');
    const secondHead = (await currentHead(memory)).head;
    assert(secondHead && secondHead.id !== firstHead.id);
    assert.equal(snapshot2.recordId, secondHead.id);
    assert(!snapshot2.sourceIds.includes(currentId('work')));
    assert.deepEqual(firstHead.value, (await memory.db.request('get', { ids: [firstHead.id], scene: 'work' })).rows.map(row => memory.decode(row))[0].value,
      'the cited first head is immutable after subsequent compression');

    await memory.addMessage('assistant', '第6轮助手引用当前只读摘要。', { scene: 'work', turnId: 'provenance-turn-6', sources: snapshot2.sourceIds });
    await memory.addMessage('user', '这是第7轮用户的未完成尾部。', { scene: 'work', turnId: 'provenance-turn-7' });
    const third = await worker.run();
    assert.equal(third.status, 'done', 'another generation after an assistant cites v2 also commits without a source cycle');
    const snapshot3 = await worker.snapshot('work');
    const thirdHead = (await currentHead(memory)).head;
    assert.notEqual(thirdHead.id, secondHead.id);
    assert.equal(snapshot3.recordId, thirdHead.id);
    assert.deepEqual(thirdHead.value.sources, thirdHead.value.segments.map(item => item.id));
    assert(thirdHead.value.sources.every(id => id.startsWith(SEGMENT_PREFIX)));
    const pointer = (await currentHead(memory)).pointer;
    assert.equal(pointer.value.headId, thirdHead.id);
    assert.deepEqual(pointer.value.sources, [thirdHead.id]);

    const beforeRestoreHead = thirdHead.id;
    const backup = await memory.export(PASSPHRASE);
    const restored = createService(path.join(dir, 'cycle-free-restored'), KEY_B);
    try {
      await restored.init();
      const restoreResult = await restored.restore(backup, PASSPHRASE);
      assert.equal(restoreResult.ok, true);
      const restoredCalls = [];
      const restoredWorker = makeWorker(restored, restoredCalls);
      const restoredSnapshot = await restoredWorker.snapshot('work');
      assert.equal(restoredSnapshot.recordId, beforeRestoreHead, 'head IDs survive fresh-key restore');
      assert.deepEqual(restoredSnapshot.sourceIds, [beforeRestoreHead]);
      assert.equal((await restoredWorker.run()).status, 'done');
      assert.equal(restoredCalls.length, 0, 'restored pointer resumes without a redundant summarize call');
    } finally { await restored.close(); }

    const firstUser = (await memory.query('message', 100, { scene: 'work', sort: 'ingestion', order: 'asc' }))
      .find(row => row.value.turnId === 'provenance-turn-1' && row.value.role === 'user');
    assert(firstUser, 'the first synthetic source turn is present before deletion');
    const removed = await memory.remove(firstUser.id);
    assert(removed.removed > 0);
    assert.equal((await worker.snapshot('work')).version, 0, 'source deletion cascades through immutable segments, heads and pointer');
    assert.equal((await memory.db.request('get', { ids: [currentId('work')] })).rows.length, 0,
      'the pointer cascades when its current immutable head disappears');
  } finally { await memory.close(); }
}

async function testBudgetAndOrphanRecovery(dir) {
  const memory = createService(path.join(dir, 'crash-recovery'));
  await memory.init();
  try {
    for (let i = 1; i <= 5; i++) await addTurn(memory, i);
    const budgetCalls = [];
    const budgetWorker = makeWorker(memory, budgetCalls);
    const budget = await budgetWorker.run({ reserveModelCall: async () => ({ ok: false }) });
    assert.equal(budget.status, 'budget');
    assert.equal(budgetCalls.length, 0);
    await expectNoPointer(memory);

    const originalWrite = memory.write.bind(memory);
    let failAfterSegment = true;
    memory.write = async (records, ...args) => {
      const result = await originalWrite(records, ...args);
      if (failAfterSegment && records.some(row => row.value?.origin === 'context-segment-v1')) {
        failAfterSegment = false;
        throw new Error('fixture crash after immutable segment write');
      }
      return result;
    };
    const calls = [];
    const worker = makeWorker(memory, calls);
    await assert.rejects(worker.run(), /fixture crash/u);
    assert.equal(calls.length, 1, 'the first work view summarizes before the injected first-stage crash');
    await expectNoPointer(memory);
    const orphanSegments = (await memory.query('state', 100, { scene: null })).filter(row => row.value.origin === 'context-segment-v1');
    assert(orphanSegments.length > 0, 'the first durable stage leaves a reusable immutable segment');

    memory.write = originalWrite;
    const resumeCalls = [];
    const resumed = makeWorker(memory, resumeCalls);
    const resumedResult = await resumed.run();
    assert.equal(resumedResult.status, 'done');
    assert.equal(resumeCalls.length, 2, 'the work orphan is reused without another model call; other visible lanes proceed normally');
    assert((await resumed.snapshot('work')).recordId);

    // Fail after persisting the next immutable head but before its pointer.
    await addTurn(memory, 6);
    await addTurn(memory, 7);
    let failAfterHead = true;
    memory.write = async (records, ...args) => {
      const result = await originalWrite(records, ...args);
      if (failAfterHead && records.some(row => row.value?.origin === 'context-head-v2')) {
        failAfterHead = false;
        throw new Error('fixture crash after immutable head write');
      }
      return result;
    };
    const secondCalls = [];
    const secondWorker = makeWorker(memory, secondCalls);
    await assert.rejects(secondWorker.run(), /fixture crash after immutable head/u);
    const priorSnapshot = await resumed.snapshot('work');
    assert(priorSnapshot.recordId, 'the previous pointer remains readable through an interrupted new version');
    memory.write = originalWrite;
    const finalCalls = [];
    const finish = makeWorker(memory, finalCalls);
    assert.equal((await finish.run()).status, 'done');
    assert.equal(finalCalls.length, 2, 'the work orphan head is reused before pointer advance; life/private views proceed once');
    assert.notEqual((await finish.snapshot('work')).recordId, priorSnapshot.recordId);
  } finally { await memory.close(); }
}

async function testFrozenLegacyHeadMigration(dir) {
  const memory = createService(path.join(dir, 'legacy-v1'));
  await memory.init();
  try {
    for (let i = 1; i <= 4; i++) await addTurn(memory, i);
    const batch = await memory.query('message', 100, { scene: 'work', domain: 'work', visibilityFloor: 0, sort: 'ingestion', order: 'asc' });
    const covered = batch.filter(row => /^provenance-turn-[12]$/u.test(row.value.turnId || ''));
    assert.equal(covered.length, 4);
    const hash = sourceDigest(covered);
    const first = covered[0], last = covered.at(-1);
    const segmentId = `${SEGMENT_PREFIX}work:legacy-fixture`;
    const segment = { id: segmentId, kind: 'state', ts: last.ts, updatedAt: now++, domain: 'work', visibilityFloor: 0,
      value: { origin: 'context-segment-v1', scene: 'work', version: last.ingestionSeq,
        range: { firstSeq: first.ingestionSeq, firstId: first.id, lastSeq: last.ingestionSeq, lastId: last.id, turnCount: 2, messageCount: 4 },
        sourceHash: hash, content: '冻结旧版摘要，来源保持完整。',
        excerpts: [{ sourceId: covered[0].id, quote: covered[0].value.content }], sources: covered.map(row => row.id) } };
    await memory.write([segment], memory.epoch, { notify: false });
    const legacyHead = { id: HEAD_PREFIX + 'work', kind: 'state', ts: 0, updatedAt: now++, domain: 'work', visibilityFloor: 0,
      value: { origin: 'context-head-v1', scene: 'work', version: 7,
        watermark: { ingestionSeq: last.ingestionSeq, id: last.id, ts: last.ts },
        coveredThrough: { ingestionSeq: last.ingestionSeq, id: last.id, ts: last.ts },
        segments: [{ id: segmentId, version: last.ingestionSeq, range: segment.value.range, sourceHash: hash }],
        text: '冻结旧版摘要，来源保持完整。', batchSourceIds: covered.map(row => row.id), batchSourceHash: hash,
        skippedSecretRounds: 0, sources: covered.map(row => row.id) } };
    await memory.write([legacyHead], memory.epoch, { notify: false });
    const before = await memory.db.request('get', { ids: [legacyHead.id], scene: 'work' });
    const worker = makeWorker(memory, []);
    const legacySnapshot = await worker.snapshot('work');
    assert.equal(legacySnapshot.recordId, legacyHead.id, 'legacy v1 remains a read-only fallback before migration');
    for (let i = 5; i <= 6; i++) await addTurn(memory, i);
    assert.equal((await worker.run()).status, 'done');
    const after = await memory.db.request('get', { ids: [legacyHead.id], scene: 'work' });
    assert.equal(after.rows.length, 1);
    assert.deepEqual(memory.decode(after.rows[0]).value, memory.decode(before.rows[0]).value,
      'migration never overwrites the fixed legacy head cited by historical replies');
    const migrated = await worker.snapshot('work');
    assert(migrated.recordId.startsWith('context-head:v2:'));
    assert.notEqual(migrated.recordId, legacyHead.id);
    assert.equal((await currentHead(memory)).head.id, migrated.recordId);
    assert((await currentHead(memory)).head.value.segments.some(item => item.id === segmentId),
      'migration retains validated legacy immutable segment sources');
  } finally { await memory.close(); }
}

async function main() {
  if (!fs.existsSync(BIN)) throw new Error(`Existing vault binary missing; test will not build it: ${BIN}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-compression-provenance-'));
  try {
    await testImmutableReferencesAndCycleFreeUpdates(temp);
    await testBudgetAndOrphanRecovery(temp);
    await testFrozenLegacyHeadMigration(temp);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log('compression provenance SQLite checks passed (immutable sources, crash recovery, frozen v1 migration, fresh-key restore)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
