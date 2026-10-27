#!/usr/bin/env node
'use strict';

// Isolated privacy regression coverage for historical credential text.
// Uses the existing native vault, temporary SQLite files, random test keys,
// and local stub extractors/summarizers only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { ContextCompression } = require('../src/main/context-compression');
const { recentRounds } = require('../src/main/recent-rounds');
const { rank } = require('../src/main/memory-scope');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-secret-boundaries-'));
const services = new Set(), workers = new Set(), testKeys = new Set();
const SECRET_A = '密码是fixture-only-credential-991';
const SECRET_B = '口令为fixture-only-credential-992';

function clock(start = Date.UTC(2026, 0, 1)) {
  let now = start;
  return { now: () => now, advanceMinute: () => { now += 60_001; } };
}

async function createMemory(name, settings = { enabled: true, extract: false, scene: 'life', recentRounds: 8 }, timer = clock()) {
  const key = crypto.randomBytes(32); testKeys.add(key);
  const memory = new MemoryService({ dir: path.join(temp, name), bin, getSettings: () => settings,
    clock: timer.now, openKey: async () => Buffer.from(key), random: () => 0 });
  services.add(memory);
  await memory.init();
  return { memory, settings, timer };
}

function message(id, role, content, turnId, ts, domain = 'life', visibilityFloor = 1) {
  return { id, kind: 'message', ts, updatedAt: ts, domain, visibilityFloor,
    value: { role, content, turnId, sources: [] } };
}

async function writeBatches(memory, records) {
  for (let offset = 0; offset < records.length; offset += 200)
    await memory.write(records.slice(offset, offset + 200), memory.epoch, { notify: false });
}

async function decoded(memory, id) {
  const row = (await memory.db.request('get', { ids: [id] })).rows[0];
  return row ? memory.decode(row) : null;
}

async function queryAll(memory, kind) {
  return memory.query(kind, 200, { scene: null, state: 'all', sort: 'ingestion', order: 'asc' });
}

async function testCorrectionRejectsSecretWithoutDeletingSource() {
  const { memory } = await createMemory('edit-reject');
  try {
    const source = message('edit-secret-source', 'user', '我想把一个普通偏好改得更简洁。', 'edit-turn', 10);
    await writeBatches(memory, [source]);
    const record = { id: 'edit-safe-memory', kind: 'memory', ts: 10, updatedAt: 10, domain: 'life', visibilityFloor: 1,
      value: { content: '我喜欢简洁的偏好记录', key: 'user.preference', memoryKind: 'preference', status: 'confirmed',
        evidence: '普通偏好', evidenceSourceId: source.id, sources: [source.id] } };
    await memory.write([record], memory.epoch, { notify: false });

    await assert.rejects(memory.updateMemory(record.id, SECRET_A), /密码|密钥|秘密/,
      'editing a memory to contain a password phrase must be rejected');
    assert.equal((await memory.db.request('get', { ids: [record.id, source.id] })).rows.length, 2,
      'rejected correction leaves both the memory and its source intact');
    assert.equal((await decoded(memory, record.id)).value.content, record.value.content);
    assert.equal((await decoded(memory, source.id)).value.content, source.value.content);
  } finally { await memory.close(); }
}

async function testLegacyCredentialsStayLocalButNeverEnterContextOrModelInputs() {
  const timer = clock();
  const { memory, settings } = await createMemory('legacy-filter', { enabled: true, extract: false, scene: 'life', recentRounds: 8 }, timer);
  let worker;
  try {
    const turns = [];
    let ts = 1_800_000_000_000;
    for (let turn = 1; turn <= 12; turn++) {
      const turnId = `legacy-turn-${turn}`;
      const content = turn === 1 ? `旧导入凭据 ${SECRET_A}`
        : turn === 12 ? `最近一轮口述凭据 ${SECRET_B}`
          : `NORMAL_HISTORY_TURN_${String(turn).padStart(2, '0')} 普通生活记录`;
      turns.push(message(`legacy-u-${turn}`, 'user', content, turnId, ts++));
      turns.push(message(`legacy-a-${turn}`, 'assistant', `NORMAL_ASSISTANT_${turn} 普通回应`, turnId, ts++));
    }
    await writeBatches(memory, turns);
    const secretSource = turns.find(row => row.id === 'legacy-u-1');
    await memory.write([{ id: 'legacy-secret-memory', kind: 'memory', ts: secretSource.ts, updatedAt: secretSource.ts,
      domain: 'life', visibilityFloor: 1,
      searchText: `旧导入凭据 fixture-only-credential-991`,
      value: { content: `旧导入资料：${SECRET_A}`, key: 'legacy.test', memoryKind: 'fact', status: 'confirmed',
        evidence: SECRET_A, evidenceSourceId: secretSource.id, sources: [secretSource.id] } }], memory.epoch, { notify: false });

    // The vault remains locally readable for explicit user inspection.
    const rawLegacy = await decoded(memory, 'legacy-u-1');
    assert(rawLegacy.value.content.includes(SECRET_A));
    const rawMemory = await decoded(memory, 'legacy-secret-memory');
    assert(rawMemory.value.content.includes(SECRET_A));

    await memory.changeScene('life');
    const messages = await queryAll(memory, 'message');
    const recent = recentRounds(messages, { rounds: 24, budget: 8500 });
    const recentText = JSON.stringify(recent.rows);
    assert(!recentText.includes(SECRET_A) && !recentText.includes(SECRET_B), 'recentRounds omits complete credential turns');
    assert(recentText.includes('NORMAL_HISTORY_TURN_11'), 'safe recent rounds remain available');

    const context = await memory.context('fixture-only-credential-991', { scene: 'life', budget: 8500 });
    const contextText = `${context.text}\n${JSON.stringify(context.messages)}\n${JSON.stringify(context.references)}`;
    assert(!contextText.includes(SECRET_A) && !contextText.includes(SECRET_B), 'context and references omit historical credentials');
    assert(context.messages.some(row => row.content.includes('NORMAL_HISTORY_TURN_11')),
      'context still includes a recent safe original turn');

    const extractInputs = [], compressionInputs = [];
    const compression = new ContextCompression({ memory, recentRounds: 8, clock: timer.now, summarize: async (batch, { scene, signal }) => {
      assert.equal(signal?.aborted, false);
      compressionInputs.push({ scene, rows: batch.map(row => ({ ...row })) });
      const firstSafe = batch.find(row => row.role === 'user');
      assert(firstSafe, 'compression should continue for neighboring safe rounds');
      timer.advanceMinute();
      return { content: `SAFE_COMPRESSED_${scene} ${firstSafe.content.slice(0, 40)}`,
        excerpts: [{ sourceId: firstSafe.id, quote: firstSafe.content.slice(0, 80) }] };
    } });
    memory.compression = compression;
    worker = new MemoryMaintenance({ memory, compression, clock: timer.now, maxCallsPerDay: 100,
      extract: async (batch, { signal }) => {
        assert.equal(signal?.aborted, false);
        extractInputs.push(batch.map(row => ({ ...row })));
        timer.advanceMinute();
        const firstSafe = batch.find(row => row.role === 'user');
        return { memories: [], excerpts: firstSafe ? [{ sourceId: firstSafe.id, quote: firstSafe.content.slice(0, 80) }] : [] };
      } });
    memory.maintenance = worker; workers.add(worker);
    const result = await worker.runDoze(new AbortController().signal);
    assert.equal(result, 'done');
    const sentToExtract = JSON.stringify(extractInputs);
    assert(!sentToExtract.includes(SECRET_A) && !sentToExtract.includes(SECRET_B), 'Doze stub receives no credential text');
    assert(sentToExtract.includes('NORMAL_HISTORY_TURN_02'), 'Doze continues with ordinary user history');
    assert(compressionInputs.length > 0, 'compression is exercised on old rounds');
    const sentToSummarize = JSON.stringify(compressionInputs);
    assert(!sentToSummarize.includes(SECRET_A) && !sentToSummarize.includes(SECRET_B), 'compression excludes every message in a credential turn');
    assert(sentToSummarize.includes('NORMAL_HISTORY_TURN_02'), 'safe rounds surrounding a secret turn remain compressible');

    for (const row of await queryAll(memory, 'summary')) {
      assert(!row.value.content.includes(SECRET_A) && !row.value.content.includes(SECRET_B), 'persisted summaries contain no credential text');
    }
    const head = await compression.snapshot('life');
    assert(!head.text.includes(SECRET_A) && !head.text.includes(SECRET_B), 'the persisted compression head is credential-free');
    assert.equal((await memory.db.request('get', { ids: ['legacy-u-1', 'legacy-u-12', 'legacy-secret-memory'] })).rows.length, 3,
      'privacy filtering does not delete local legacy source records');
  } finally {
    if (worker) await worker.close().catch(() => {});
    await memory.close();
  }
}

async function testSecretCandidateIsDroppedAndMalformedDozeDoesNotAdvance() {
  const timer = clock(Date.UTC(2026, 2, 1));
  const { memory } = await createMemory('bad-candidate', { enabled: true, extract: false, scene: 'life' }, timer);
  let worker;
  try {
    const source = message('candidate-source', 'user', '我每周二会散步，并喜欢茶。', 'candidate-turn', 30);
    await writeBatches(memory, [source]);
    worker = new MemoryMaintenance({ memory, clock: timer.now, maxCallsPerDay: 100,
      extract: async batch => {
        timer.advanceMinute();
        const user = batch.find(row => row.role === 'user');
        return { memories: [
          { sourceId: user.id, content: '普通安全候选：每周二散步', evidence: '每周二会散步' },
          { sourceId: user.id, content: SECRET_A, evidence: '我每周二会散步' },
        ], excerpts: [{ sourceId: user.id, quote: '我每周二会散步' }] };
      } });
    workers.add(worker); memory.maintenance = worker;
    const outcome = await worker.runDoze(new AbortController().signal);
    assert.equal(outcome, 'done', 'a single invalid secret candidate is dropped without blocking valid work');
    const candidates = (await queryAll(memory, 'memory')).filter(row => row.value.origin === 'doze-candidate-v2');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].value.content, '普通安全候选：每周二散步');
    assert.equal(candidates.some(row => row.value.content.includes(SECRET_A)), false);
    const checkpoint = await decoded(memory, 'maintenance:life:1');
    assert(checkpoint?.value?.watermark, 'the batch watermark may advance for a dropped per-item candidate');
    assert((await decoded(memory, source.id)).value.content === source.value.content, 'invalid output does not delete its input source');
  } finally {
    if (worker) await worker.close().catch(() => {});
    await memory.close();
  }

  const malformedClock = clock(Date.UTC(2026, 3, 1));
  const malformed = await createMemory('malformed-doze', { enabled: true, extract: false, scene: 'life' }, malformedClock);
  let malformedWorker;
  try {
    const source = message('malformed-source', 'user', '普通合成来源供错误返回测试。', 'malformed-turn', 31);
    await writeBatches(malformed.memory, [source]);
    malformedWorker = new MemoryMaintenance({ memory: malformed.memory, clock: malformedClock.now, maxCallsPerDay: 100,
      extract: async () => { malformedClock.advanceMinute(); return null; } });
    workers.add(malformedWorker); malformed.memory.maintenance = malformedWorker;
    await assert.rejects(malformedWorker.runDoze(new AbortController().signal));
    assert.equal(await decoded(malformed.memory, 'maintenance:life:1'), null, 'malformed whole Doze response does not advance the watermark');
    assert.equal((await malformed.memory.db.request('get', { ids: [source.id] })).rows.length, 1, 'malformed output preserves original input');
    assert.equal((await queryAll(malformed.memory, 'summary')).length, 0);
  } finally {
    if (malformedWorker) await malformedWorker.close().catch(() => {});
    await malformed.memory.close();
  }
}

async function testSecretCompressionOutputNeverCommitsHeadOrDeletesSources() {
  const timer = clock(Date.UTC(2026, 4, 1));
  const { memory } = await createMemory('bad-compression-output', { enabled: true, extract: false, scene: 'life', recentRounds: 8 }, timer);
  try {
    const records = [];
    let ts = 1_900_000_000_000;
    for (let turn = 1; turn <= 12; turn++) {
      const turnId = `safe-compression-turn-${turn}`;
      records.push(message(`safe-comp-u-${turn}`, 'user', `SAFE_COMPRESSION_SOURCE_${turn} 普通历史`, turnId, ts++));
      records.push(message(`safe-comp-a-${turn}`, 'assistant', `SAFE_COMPRESSION_REPLY_${turn} 普通回复`, turnId, ts++));
    }
    await writeBatches(memory, records);
    const compression = new ContextCompression({ memory, recentRounds: 8, clock: timer.now,
      summarize: async (batch, { signal }) => {
        assert.equal(signal?.aborted, false);
        assert(batch.some(row => row.content.includes('SAFE_COMPRESSION_SOURCE_1')));
        const safe = batch.find(row => row.role === 'user');
        timer.advanceMinute();
        return { content: `整理结果：${SECRET_A}`, excerpts: [{ sourceId: safe.id, quote: safe.content.slice(0, 80) }] };
      } });
    await assert.rejects(compression.run({ reserveModelCall: async () => ({ ok: true }) }), /摘要|格式|无效/,
      'a credential-bearing summary is rejected');
    assert.equal((await memory.db.request('get', { ids: ['context-current:v2:life', 'context-head:v1:life'] })).rows.length, 0,
      'rejected compression output does not write or advance a pointer or legacy head');
    assert.equal((await queryAll(memory, 'state')).filter(row => row.id.startsWith('context-segment:v1:')).length, 0,
      'rejected compression output does not persist a segment');
    assert.equal((await memory.db.request('get', { ids: records.map(row => row.id) })).rows.length, records.length,
      'all local original messages remain intact after rejection');
  } finally { await memory.close(); }
}

async function main() {
  if (!fs.existsSync(bin) || !fs.statSync(bin).isFile()) throw new Error(`existing native vault binary is required: ${bin}`);
  try {
    await testCorrectionRejectsSecretWithoutDeletingSource();
    await testLegacyCredentialsStayLocalButNeverEnterContextOrModelInputs();
    await testSecretCandidateIsDroppedAndMalformedDozeDoesNotAdvance();
    await testSecretCompressionOutputNeverCommitsHeadOrDeletesSources();
    console.log('memory secret-boundary SQLite integration passed (temporary vaults, no model/provider calls)');
  } finally {
    for (const worker of workers) await worker.close().catch(() => {});
    for (const memory of services) await memory.close().catch(() => {});
    for (const key of testKeys) key.fill(0);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
