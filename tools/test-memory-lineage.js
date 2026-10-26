#!/usr/bin/env node
'use strict';

// Isolated integration coverage for source lineage, voice receipts, and
// maintenance state lookups. Uses the already-built SQLite vault binary,
// temporary databases, and a stub extractor; no model or user data is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { createVoiceTurns } = require('../src/main/voice-turns');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-lineage-'));
const services = new Set(), workers = new Set();
const key = crypto.randomBytes(32);

function createService(name, { scene = 'life', clock = Date.now } = {}) {
  const settings = { enabled: true, extract: false, scene, recentRounds: 8 };
  const service = new MemoryService({
    dir: path.join(temp, name), bin, getSettings: () => settings, clock,
    openKey: async () => Buffer.from(key), random: () => 0,
  });
  services.add(service);
  return { service, settings };
}

function createWorker(memory, extract, options = {}) {
  const worker = new MemoryMaintenance({
    memory, extract, clock: options.clock || (() => Date.now()),
    maxMessages: options.maxMessages || 40,
  });
  workers.add(worker);
  return worker;
}

async function addUser(memory, content, scene = 'life') {
  const row = await memory.addMessage('user', content, { scene });
  assert(row?.id, 'user message must be persisted');
  return row;
}

async function allRows(memory, kind) {
  return memory.query(kind, 200, { scene: null, state: 'all', sort: 'ingestion', order: 'asc' });
}

function voiceFixture(onRemember) {
  let now = 0, timerId = 0;
  const timers = new Map(), requests = [];
  const voice = createVoiceTurns({
    sessionId: 'test-session', now: () => now,
    setTimer(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    onRequest(token) { requests.push(token); }, onRemember,
    onInvalidate() {},
  });
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; timers.delete(id); now = timer.at; timer.fn();
    }
    now = target;
  }
  return { voice, advance, requests };
}

async function testVoiceStableTurnReceiptAndCascade() {
  const { service } = createService('voice');
  await service.init();
  const callbackTurnIds = [];
  const fixture = voiceFixture((text, { turnId }) => {
    callbackTurnIds.push(turnId);
    const id = `voice:${crypto.createHash('sha256').update(turnId).digest('hex')}`;
    return service.addMessageOnce(id, 'user', text, { turnId, scene: 'life' });
  });
  fixture.voice.partial('请记住海风很舒服');
  fixture.advance(1000);
  assert.equal(fixture.requests.length, 1);
  const token = fixture.requests[0];
  fixture.voice.final('请记住海风很舒服。');
  fixture.advance(2000);
  assert.equal(await token.waitForCommit(), true);

  const firstReceipt = await token.remember();
  const duplicateReceipt = await token.remember();
  assert.equal(firstReceipt.inserted, true);
  assert.equal(duplicateReceipt.inserted, true, 'voice coordinator returns its original idempotent receipt');
  assert.equal(firstReceipt.record.id, duplicateReceipt.record.id);
  assert.equal(firstReceipt.record.value.content, '请记住海风很舒服。', 'final punctuation, not speculative text, is persisted');
  assert.deepEqual(callbackTurnIds, ['test-session:1'], 'the finalized text is paired with one stable turn identity');
  assert.equal((await allRows(service, 'message')).filter(row => row.id === firstReceipt.record.id).length, 1);

  const assistant = await service.addMessageOnce('voice-reply:1', 'assistant', '我会记得你说海风很舒服。', {
    scene: 'life', sources: [firstReceipt.record.id], delivery: 'generated',
  });
  assert.equal(assistant.inserted, true);
  assert.deepEqual(assistant.record.value.sources, [firstReceipt.record.id]);
  await service.remove(firstReceipt.record.id);
  assert.equal((await service.db.request('get', { ids: ['voice-reply:1'] })).rows.length, 0,
    'forgetting the remembered voice turn cascades to the assistant reply');
  await service.close();
}

async function runTwoInputDoze(service, { candidateFor, excerptFor, clock }) {
  const extract = async batch => ({
    memories: candidateFor ? [candidateFor(batch)] : [],
    // The test can deliberately omit a model input from excerpts. The v2
    // summary still records all inputs as its dependency set.
    excerpts: excerptFor ? [excerptFor(batch)] : [],
  });
  const worker = createWorker(service, extract, { clock });
  const outcome = await worker.runDoze(new AbortController().signal);
  assert.equal(outcome, 'done');
  await worker.close();
  return worker;
}

async function testV2EvidenceRemovalAndCorrection() {
  const { service: removeService } = createService('evidence-remove', { clock: () => 1_800_000_000_000 });
  await removeService.init();
  const fact = await addUser(removeService, '我每周三会去河边散步。');
  const unrelated = await addUser(removeService, '另一个话题是我喜欢柚子茶。');
  await runTwoInputDoze(removeService, {
    clock: () => 1_800_000_000_010,
    candidateFor: batch => ({ sourceId: batch[0].id, content: '每周三去河边散步', evidence: '每周三会去河边散步' }),
    excerptFor: batch => ({ sourceId: batch[0].id, quote: batch[0].content }),
  });
  let candidates = (await allRows(removeService, 'memory')).filter(row => row.value.origin === 'doze-candidate-v2');
  let summaries = await allRows(removeService, 'summary');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].value.origin, 'doze-candidate-v2');
  assert.equal(candidates[0].value.evidenceSourceId, fact.id);
  assert.deepEqual(new Set(candidates[0].value.sources), new Set([fact.id, unrelated.id]),
    'candidate carries the full batch as dependency sources plus a distinct evidence source');
  assert.equal(summaries.length, 1);
  assert.deepEqual(new Set(summaries[0].value.sources), new Set([fact.id, unrelated.id]),
    'summary depends on every input, including inputs not selected as excerpts');

  const removal = await removeService.remove(candidates[0].id);
  assert(removal.removedSources >= 1);
  const afterRemovalMessages = await allRows(removeService, 'message');
  assert(!afterRemovalMessages.some(row => row.id === fact.id), 'forgetting a candidate removes its evidence original');
  assert(afterRemovalMessages.some(row => row.id === unrelated.id), 'unrelated model input is not removed with a v2 candidate');
  assert.equal((await removeService.db.request('get', { ids: [candidates[0].id, summaries[0].id] })).rows.length, 0,
    'evidence deletion removes the candidate and full-batch-derived summary');
  await removeService.close();

  const { service: updateService } = createService('evidence-update', { clock: () => 1_800_000_100_000 });
  await updateService.init();
  const oldFact = await addUser(updateService, '我现在住在苏州园区。');
  const otherInput = await addUser(updateService, '我喜欢听爵士乐。');
  await runTwoInputDoze(updateService, {
    clock: () => 1_800_000_100_010,
    candidateFor: batch => ({ sourceId: batch[0].id, content: '目前住在苏州园区', evidence: '现在住在苏州园区' }),
    excerptFor: batch => ({ sourceId: batch[0].id, quote: batch[0].content }),
  });
  const oldCandidate = (await allRows(updateService, 'memory')).find(row => row.value.origin === 'doze-candidate-v2');
  assert(oldCandidate, 'v2 candidate should be distinguishable from user-rule memories');
  const update = await updateService.updateMemory(oldCandidate.id, '我现在住在杭州滨江');
  assert(update.ok);
  const messages = await allRows(updateService, 'message');
  assert(!messages.some(row => row.id === oldFact.id), 'correction removes only the evidence original');
  assert(messages.some(row => row.id === otherInput.id), 'correction preserves unrelated input from that extraction batch');
  const memories = await allRows(updateService, 'memory');
  const reviewed = memories.find(row => row.value.origin === 'user-reviewed');
  assert.equal(reviewed?.value.content, '我现在住在杭州滨江');
  assert(!memories.some(row => row.id === oldCandidate.id), 'old candidate does not survive correction');
  assert.equal((await updateService.db.request('get', { ids: [oldCandidate.id] })).rows.length, 0);
  assert.equal((await allRows(updateService, 'summary')).length, 0, 'summary depending on the corrected evidence is cascaded');
  await updateService.close();
}

async function testUnselectedBatchInputInvalidatesAllDerivatives() {
  const { service } = createService('unselected-input', { clock: () => 1_800_000_200_000 });
  await service.init();
  const evidence = await addUser(service, '我计划春天去成都旅行。');
  const omittedFromExcerpts = await addUser(service, '顺便说我不吃香菜。');
  await runTwoInputDoze(service, {
    clock: () => 1_800_000_200_010,
    candidateFor: batch => ({ sourceId: batch[0].id, content: '春天计划去成都旅行', evidence: '计划春天去成都旅行' }),
    excerptFor: batch => ({ sourceId: batch[0].id, quote: batch[0].content }),
  });
  const candidate = (await allRows(service, 'memory')).find(row => row.value.origin === 'doze-candidate-v2'), summary = (await allRows(service, 'summary'))[0];
  assert(candidate && summary);
  assert(!summary.value.content.includes('香菜'), 'second input did not appear as a selected excerpt');
  assert(candidate.value.sources.includes(omittedFromExcerpts.id));
  assert(summary.value.sources.includes(omittedFromExcerpts.id), 'summary dependency set is wider than excerpt set');
  await service.remove(omittedFromExcerpts.id);
  assert.equal((await service.db.request('get', { ids: [candidate.id, summary.id] })).rows.length, 0,
    'deleting any unselected model input invalidates every derived artifact from that batch');
  assert((await service.db.request('get', { ids: [evidence.id] })).rows.length === 1,
    'the other original remains because it is not the deleted source');
  await service.close();
}

async function testMaintenanceStatePointReadsPastLargeStateSet() {
  const fixedNow = new Date(2026, 9, 27, 6, 0, 0).getTime();
  const { service, settings } = createService('maintenance-state', { scene: 'life', clock: () => fixedNow });
  await service.init();
  const lifeMessage = await addUser(service, '我在生活里喜欢晨跑。', 'life');
  const persistedMessage = (await service.db.request('get', { ids: [lifeMessage.id] })).rows[0];
  assert(Number.isSafeInteger(persistedMessage.ingestionSeq));
  const stateRows = [];
  for (let i = 0; i < 240; i++) stateRows.push({
    id: `fixture-state-${String(i).padStart(3, '0')}`, kind: 'state', ts: i,
    domain: 'life', visibilityFloor: 1, value: { marker: i, sources: [] },
  });
  for (let i = 0; i < stateRows.length; i += 200) await service.write(stateRows.slice(i, i + 200));
  await service.write([{ id: 'maintenance:life:1', kind: 'state', ts: 0, domain: 'life', visibilityFloor: 1,
    value: { job: 'doze', domain: 'life', visibilityFloor: 1, watermark: { ingestionSeq: 0, ts: 0, id: 'old-watermark' }, sources: [] } }]);
  const scheduledDate = '2026-10-27';
  await service.write([{ id: 'maintenance:daily-schedule', kind: 'state', ts: 0, domain: 'private', visibilityFloor: 2,
    value: { lastDueLocalDate: scheduledDate, lastSuccessAt: fixedNow, sources: [] } }]);
  await service.write([{ id: 'maintenance:budget', kind: 'state', ts: 0, domain: 'private', visibilityFloor: 2,
    value: { calls: [fixedNow - 1000], sources: [] } }]);

  const worker = createWorker(service, async batch => ({ memories: [], excerpts: batch.filter(x => x.role === 'user').map(x => ({ sourceId: x.id, quote: x.content })) }), { clock: () => fixedNow });
  const checkpoint = await worker.readPartitionState('life', 1);
  assert.equal(checkpoint.value.watermark.id, 'old-watermark', 'point read finds the exact life watermark after 240 state records');
  const budgetBefore = (await worker.readState('maintenance:budget')).value.calls;
  assert.deepEqual(budgetBefore, [fixedNow - 1000], 'point read finds the daily budget outside the first page');
  const reserved = await worker.reserveModelCall(new AbortController().signal);
  assert.equal(reserved.ok, true);
  const budgetAfter = (await worker.readState('maintenance:budget')).value.calls;
  assert.deepEqual(budgetAfter, [fixedNow - 1000, fixedNow], 'reservation appends instead of losing the old budget');

  const schedule = await worker.readDailySchedule();
  assert.equal(schedule.domain, 'private', 'daily schedule remains private at rest');
  assert.equal(schedule.value.lastDueLocalDate, scheduledDate,
    `life scene (${settings.scene}) can internally retrieve the private daily schedule`);
  assert.equal(await worker.checkDue(fixedNow), false, 'the persisted daily plan prevents another run on the same local day');

  const calls = [];
  const doze = createWorker(service, async batch => {
    calls.push(batch.map(row => row.id));
    return { memories: [], excerpts: [] };
  }, { clock: () => fixedNow });
  const outcome = await doze.runDoze(new AbortController().signal);
  assert.equal(outcome, 'done');
  assert(calls.flat().includes(lifeMessage.id), 'doze uses the persisted ingestion watermark and sees the life source');
  const updatedCheckpoint = await doze.readPartitionState('life', 1);
  assert(updatedCheckpoint.value.watermark.ingestionSeq >= persistedMessage.ingestionSeq);
  assert.equal(updatedCheckpoint.value.watermark.id, lifeMessage.id);
  await doze.close(); await worker.close(); await service.close();
}

async function main() {
  if (!fs.existsSync(bin) || !fs.statSync(bin).isFile()) throw new Error(`existing native vault binary is required: ${bin}`);
  try {
    await testVoiceStableTurnReceiptAndCascade();
    await testV2EvidenceRemovalAndCorrection();
    await testUnselectedBatchInputInvalidatesAllDerivatives();
    await testMaintenanceStatePointReadsPastLargeStateSet();
    console.log('memory lineage SQLite integration tests passed (temporary vaults, stub extractor, fake voice clock)');
  } finally {
    for (const worker of workers) await worker.close().catch(() => {});
    for (const service of services) await service.close().catch(() => {});
    key.fill(0);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
