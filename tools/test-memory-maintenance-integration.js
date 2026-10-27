#!/usr/bin/env node
'use strict';

// Real SQLite integration fixture. Uses only a disposable temp directory, the
// already-built native vault binary, a fixed test-only key, and a stub model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const key = Buffer.from('c7c9be6d657e47c72ef100792c72d3edc7c9be6d657e47c72ef100792c72d3ed', 'hex');
const passphrase = 'integration-fixture-only-passphrase';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-maintenance-integration-'));
const services = new Set(), workers = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 8000) {
  const untilAt = Date.now() + timeoutMs;
  while (Date.now() < untilAt) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error(`timeout: ${label}`);
}

function createService(name, { clock = () => Date.UTC(2026, 0, 1), scene = 'private' } = {}) {
  const settings = { enabled: true, extract: false, scene };
  const service = new MemoryService({
    dir: path.join(temp, name), bin, getSettings: () => settings, clock,
    openKey: async () => Buffer.from(key), random: () => 0,
  });
  services.add(service);
  return { service, settings };
}

function createWorker(service, extract, options = {}) {
  const worker = new MemoryMaintenance({ memory: service, extract, clock: options.clock || (() => Date.UTC(2026, 0, 1)),
    maxMessages: options.maxMessages, maxCallsPerDay: options.maxCallsPerDay, onStatus: options.onStatus });
  workers.add(worker);
  service.maintenance = worker;
  return worker;
}

async function addMessage(service, scene, role, content) {
  const result = await service.addMessage(role, content, { scene });
  assert(result?.id, `message insert failed: ${scene}/${role}`);
  return result;
}

function extractor(calls) {
  return async (batch, { signal } = {}) => {
    assert.equal(signal?.aborted, false);
    calls.push(batch.map(row => row.id));
    const users = batch.filter(row => row.role === 'user');
    return {
      memories: users.map(row => ({ sourceId: row.id, content: `偏好：${row.content.slice(0, 60)}`, evidence: row.content.slice(0, Math.min(row.content.length, 80)), tags: ['散步', '沿海', 'integration-tag'] })),
      excerpts: batch.slice(0, 8).map(row => ({ sourceId: row.id, quote: row.content.slice(0, Math.min(row.content.length, 180)) })),
    };
  };
}

async function testSqlitePartitionsWatermarkAndRemoval() {
  let now = Date.UTC(2026, 0, 2);
  const { service } = createService('partition-vault', { clock: () => now++ });
  await service.init();
  const input = [
    ['private', 'user', '今天我沿海边步道散了步。'], ['private', 'assistant', '海边散步听起来很放松。'],
    ['life', 'user', '生活里我常在公园慢跑。'], ['life', 'assistant', '公园慢跑是很好的习惯。'],
    ['work', 'user', '工作上我偏好先列出小步骤。'], ['work', 'assistant', '我会按小步骤检查工作内容。'],
  ];
  const sources = [];
  for (const [scene, role, content] of input) sources.push({ scene, ...(await addMessage(service, scene, role, content)) });
  const calls = [];
  const worker = createWorker(service, extractor(calls), { clock: () => now });
  worker.request('dream');
  await until(() => worker.status().status === 'idle' && calls.length >= 3, 'three scene batches');
  await worker.tick();
  assert.equal(calls.length, 3, 'private/life/work each use one extraction batch');

  const candidates = await service.query('memory', 100, { scene: null, sort: 'ingestion', order: 'asc' });
  assert.equal(candidates.length, 3, 'one pending candidate is stored for each user source');
  for (const row of candidates) {
    assert.equal(row.value.status, 'pending');
    assert.deepEqual(row.value.tags, ['自动记忆', '散步', '沿海', 'integration-tag']);
    const source = sources.find(item => item.id === row.value.sources[0]);
    assert(source && row.domain === source.scene, 'candidate scope follows its source scene');
    assert(Number.isSafeInteger(row.ingestionSeq));
  }
  const summaries = await service.query('summary', 100, { scene: null });
  assert.equal(summaries.length, 0, 'Dream creates memories only; Doze owns summaries');
  for (const row of summaries) {
    assert(row.value.sources.length >= 1);
    assert(row.value.sourceRange.firstSeq <= row.value.sourceRange.lastSeq);
    assert(row.domain === 'private' || row.domain === 'life' || row.domain === 'work');
  }
  for (const partition of [['private', 2], ['life', 1], ['work', 0]]) {
    const [domain, floor] = partition;
    const watermark = await service.query('state', 100, { scene: null, domain, visibilityFloor: floor });
    const checkpoint = watermark.find(row => row.id === `maintenance:${domain}:${floor}`);
    assert(checkpoint?.value.watermark && Number.isSafeInteger(checkpoint.value.watermark.ingestionSeq));
  }

  worker.request('dream');
  await worker.tick();
  assert.equal(calls.length, 3, 'zero new messages means zero extraction calls');
  assert.equal((await service.query('memory', 100, { scene: null })).length, 3, 'repeated doze does not create duplicate candidates');

  const lifeUser = sources.find(item => item.scene === 'life' && item.value.role === 'user');
  const lifeWatermark = (await service.query('state', 100, { scene: null, domain: 'life', visibilityFloor: 1 })).find(row => row.id === 'maintenance:life:1').value.watermark;
  await service.remove(lifeUser.id);
  assert.equal((await service.db.request('get', { ids: candidates.filter(r => r.domain === 'life').map(r => r.id) })).rows.length, 0,
    'deleting a source cascades to its derived candidate');
  assert(Number.isSafeInteger(lifeWatermark.ingestionSeq));
  assert.equal((await service.query('state', 100, { scene: null, domain: 'life', visibilityFloor: 1 })).find(row => row.id === 'maintenance:life:1').value.watermark,
    null, 'deleted analysis dependencies rewind the semantic frontier so surviving sources can be processed again');

  now += 60_001; // Leave the real 3-calls-per-minute budget window.
  const laterLife = await addMessage(service, 'life', 'user', '稍后我会继续在河边散步。');
  worker.request('dream');
  await until(() => worker.status().status === 'idle' && calls.length === 4, 'life post-delete append');
  assert(calls.at(-1).includes(laterLife.id), 'a lower timestamp after deletion is still found by ingestion sequence');
  const laterCandidates = await service.query('memory', 100, { scene: null });
  assert(laterCandidates.some(row => row.value.sources.includes(laterLife.id)));
  await worker.close();
  await service.close();
}

async function testExportRestoreSequenceAndNewAppend() {
  let now = Date.UTC(2026, 1, 1);
  const { service: source } = createService('export-source', { clock: () => now++ });
  await source.init();
  const a = await addMessage(source, 'private', 'user', '导出前较早的私人消息。');
  const b = await addMessage(source, 'life', 'user', '导出前较晚的生活消息。');
  const calls = [];
  const worker = createWorker(source, extractor(calls), { clock: () => now });
  worker.request('dream'); await until(() => worker.status().status === 'idle' && calls.length === 2, 'source doze before export');
  const before = await source.query(undefined, 200, { scene: null, state: 'all', sort: 'ingestion', order: 'asc' });
  const beforeSeq = new Map(before.map(row => [row.id, row.ingestionSeq]));
  const backup = await source.export(passphrase);
  await worker.close(); await source.close();

  const { service: restored } = createService('export-restored', { clock: () => now++ });
  await restored.init();
  const result = await restored.restore(backup, passphrase);
  assert(result.records > 0);
  const after = await restored.query(undefined, 200, { scene: null, state: 'all', sort: 'ingestion', order: 'asc' });
  const afterSeq = new Map(after.map(row => [row.id, row.ingestionSeq]));
  assert.equal(afterSeq.size, beforeSeq.size);
  for (const row of before) {
    const restoredRow = after.find(item => item.id === row.id);
    assert(restoredRow, `restored record missing: ${row.id}`);
    assert.equal(restoredRow.domain, row.domain, `restored scope changed: ${row.id}`);
    assert.equal(restoredRow.visibilityFloor, row.visibilityFloor, `restored visibility changed: ${row.id}`);
  }

  const restoredCalls = [];
  const restoredWorker = createWorker(restored, extractor(restoredCalls), { clock: () => now });
  now = Date.UTC(2025, 11, 31); // Deliberate wall-clock rollback after restore.
  const newMessage = await addMessage(restored, 'life', 'user', '恢复后新增且时间回拨的生活消息。');
  restoredWorker.request('dream');
  await until(() => restoredCalls.length > 0 || restoredWorker.status().status === 'failed' || restoredWorker.status().note.includes('预算'), 'restored worker consumes append');
  assert(restoredCalls.length > 0, `restored append did not reach extractor: ${JSON.stringify(restoredWorker.status())}`);
  await until(() => ['idle', 'paused', 'failed'].includes(restoredWorker.status().status) ||
    (restoredWorker.status().status === 'queued' && restoredWorker.status().note.includes('预算')), 'restored worker finishes or reaches budget');
  assert(restoredCalls.some(batch => batch.includes(newMessage.id)), 'restored ingestion watermark does not skip a later insertion');
  const appendedCandidates = await restored.query('memory', 100, { scene: null });
  assert(appendedCandidates.some(row => row.value.sources.includes(newMessage.id)), 'restored worker commits a candidate for the new message');
  const oldSourceIds = new Set([a.id, b.id]);
  const replayedOldSources = restoredCalls.flat().filter(id => oldSourceIds.has(id));

  const seqMismatches = before.filter(row => afterSeq.get(row.id) !== beforeSeq.get(row.id));
  await restoredWorker.close(); await restored.close();
  return {
    seqMismatches: seqMismatches.map(row => ({ id: row.id, before: beforeSeq.get(row.id), after: afterSeq.get(row.id) })),
    replayedOldSources,
  };
}

async function testSceneChangeCancelsUncommittedExtraction() {
  const { service } = createService('cancel-vault');
  await service.init();
  const source = await addMessage(service, 'private', 'user', '取消期间的合成私密消息。');
  let extractionStarted;
  const started = new Promise(resolve => { extractionStarted = resolve; });
  const worker = createWorker(service, async (_batch, { signal }) => {
    extractionStarted();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic interrupted')), { once: true }));
  });
  worker.request('dream'); await started;
  await service.changeScene('work');
  await until(() => worker.status().status === 'paused', 'scene change abort');
  assert.equal((await service.query('memory', 50, { scene: null })).length, 0, 'scene switch abort prevents candidate commit');
  assert.equal((await service.query('summary', 50, { scene: null })).length, 0, 'scene switch abort prevents summary commit');
  assert.equal((await service.query('state', 50, { scene: null, domain: 'private', visibilityFloor: 2 })).some(row => row.id === 'maintenance:private:2'), false,
    'scene switch abort leaves the source watermark unchanged');
  assert((await service.db.request('get', { ids: [source.id] })).rows.length === 1, 'the original source remains intact');
  await worker.close(); await service.close();
}

async function testPersistedBudgetOnRealVault() {
  let now = Date.UTC(2026, 2, 1);
  const { service } = createService('budget-vault', { clock: () => now++ });
  await service.init();
  await addMessage(service, 'life', 'user', '预算测试生活消息。');
  await addMessage(service, 'private', 'user', '预算测试私人消息。');
  let calls = 0;
  const extract = async batch => { calls++; return { memories: [], excerpts: [{ sourceId: batch[0].id, quote: batch[0].content }] }; };
  let worker = createWorker(service, extract, { clock: () => now, maxCallsPerDay: 1 });
  worker.request('dream');
  await until(() => worker.status().status === 'queued' && worker.status().note.includes('每日'), 'daily budget reached');
  assert.equal(calls, 1);
  await worker.close();

  worker = createWorker(service, extract, { clock: () => now, maxCallsPerDay: 1 });
  worker.request('dream');
  await until(() => worker.status().status === 'queued' && worker.status().note.includes('每日'), 'daily budget survives worker restart');
  assert.equal(calls, 1, 'restart cannot bypass the persisted daily cap');
  now += 24 * 60 * 60_000 + 1;
  await worker.tick();
  assert.equal(calls, 2, 'rolling daily budget releases after 24 hours');
  await worker.close(); await service.close();
}

async function testEmptyVaultAndSafeErrors() {
  const { service } = createService('empty-vault');
  await service.init();
  let calls = 0;
  const worker = createWorker(service, async () => { calls++; return { memories: [], excerpts: [] }; });
  worker.request('dream'); await worker.tick();
  assert.equal(calls, 0, 'an empty vault causes no model call');
  assert.equal(worker.safeError({ message: '解析失败，原文含秘密：FIXTURE_PRIVATE_SENTINEL' }), '整理暂未完成，请稍后再试');
  assert.equal(worker.safeError({ code: 'ERR_PARSE', message: 'FIXTURE_PRIVATE_SENTINEL' }), '整理暂未完成（错误码 ERR_PARSE）');
  assert.equal(worker.safeError({ code: 'stale_epoch', message: 'FIXTURE_PRIVATE_SENTINEL' }), '本地记忆刚有更新，整理没有提交（stale_epoch）');
  await worker.close(); await service.close();
}

async function main() {
  if (!fs.existsSync(bin)) throw new Error(`native vault binary is missing: ${bin}; test does not build it`);
  if (!fs.statSync(bin).isFile()) throw new Error(`native vault path is not a file: ${bin}`);
  try {
    await testSqlitePartitionsWatermarkAndRemoval();
    const restoreAudit = await testExportRestoreSequenceAndNewAppend();
    await testSceneChangeCancelsUncommittedExtraction();
    await testPersistedBudgetOnRealVault();
    await testEmptyVaultAndSafeErrors();
    assert.deepEqual(restoreAudit, { seqMismatches: [], replayedOldSources: [] },
      `export/restore must preserve sequence and not replay completed sources: ${JSON.stringify({
        seqMismatches: restoreAudit.seqMismatches.slice(0, 8), replayedOldSources: restoreAudit.replayedOldSources,
      })}`);
    console.log('memory-maintenance SQLite integration fixtures passed (temporary vaults, fixed test key, stub extractor)');
  } finally {
    for (const worker of workers) await worker.close().catch(() => {});
    for (const service of services) await service.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
    key.fill(0);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
