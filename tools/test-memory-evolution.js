#!/usr/bin/env node
'use strict';

// Real SQLite integration for three scene-specific rolling context heads.
// Uses disposable databases, random test keys, deterministic local stubs, and
// the already-built native vault binary. It never contacts a model/provider.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { ContextCompression, currentId } = require('../src/main/context-compression');
const { rank } = require('../src/main/memory-scope');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-evolution-'));
const services = new Set(), workers = new Set();
const testKeys = new Set();
const PASSPHRASE = 'fixture-only-memory-evolution-passphrase';
const SCOPES = [
  { domain: 'work', visibilityFloor: 0, marker: 'EVOLUTION_WORK_F0' },
  { domain: 'life', visibilityFloor: 1, marker: 'EVOLUTION_LIFE_F1' },
  { domain: 'private', visibilityFloor: 2, marker: 'EVOLUTION_PRIVATE_F2' },
  { domain: 'work', visibilityFloor: 2, marker: 'EVOLUTION_WORK_BUSINESS_F2' },
];

function fakeClock(start = Date.UTC(2026, 0, 1)) {
  let value = start;
  return {
    now: () => value,
    advanceMinute() { value += 60_001; },
    advance(ms) { value += ms; },
  };
}

function createSystem(name, clock, { scene = 'private', summarizeOverride } = {}) {
  const settings = { enabled: true, extract: false, scene, recentRounds: 8 };
  const key = crypto.randomBytes(32);
  testKeys.add(key);
  const memory = new MemoryService({
    dir: path.join(temp, name), bin, getSettings: () => settings, clock: clock.now,
    openKey: async () => Buffer.from(key), random: () => 0,
  });
  services.add(memory);
  const calls = { extract: [], summarize: [] };
  const summarize = summarizeOverride || (async (messages, { scene: lane, signal }) => {
    assert.equal(signal?.aborted, false);
    calls.summarize.push({ scene: lane, ids: messages.map(row => row.id) });
    const source = messages.find(row => row.role === 'user');
    if (!source) throw new Error('fixture expected at least one user message in each summary batch');
    clock.advanceMinute();
    const visibleMarkers = [...new Set(messages.flatMap(row => row.content.match(/EVOLUTION_[A-Z_0-9]+/gu) || []))].join(',');
    return { content: `FIXTURE_HEAD_${lane} visible=${visibleMarkers} count=${messages.length}`,
      excerpts: [{ sourceId: source.id, quote: source.content.slice(0, Math.min(180, source.content.length)) }] };
  });
  const compression = new ContextCompression({ memory, summarize, clock: clock.now, recentRounds: 8 });
  memory.compression = compression;
  const extract = async (batch, { signal } = {}) => {
    assert.equal(signal?.aborted, false);
    calls.extract.push(batch.map(row => row.id));
    const firstUser = batch.find(row => row.role === 'user');
    clock.advanceMinute();
    return { memories: [], excerpts: firstUser ? [{ sourceId: firstUser.id, quote: firstUser.content.slice(0, 180) }] : [] };
  };
  const worker = new MemoryMaintenance({ memory, extract, compression, clock: clock.now, maxCallsPerDay: 100 });
  workers.add(worker); memory.maintenance = worker;
  return { memory, settings, compression, worker, calls, clock, key };
}

let nextTs = Date.UTC(2025, 0, 1);
function turnsForScope(scope, count = 12, { prefix = scope.marker, start = 1 } = {}) {
  const records = [];
  for (let turn = start; turn < start + count; turn++) {
    const turnId = `${scope.domain}-${scope.visibilityFloor}-turn-${turn}`;
    const suffix = String(turn).padStart(2, '0');
    records.push({ id: `${turnId}-user`, kind: 'message', ts: nextTs++, domain: scope.domain,
      visibilityFloor: scope.visibilityFloor, value: { role: 'user', content: `${prefix}_turn_${suffix}_user 原文样本`, turnId, sources: [] } });
    records.push({ id: `${turnId}-assistant`, kind: 'message', ts: nextTs++, domain: scope.domain,
      visibilityFloor: scope.visibilityFloor, value: { role: 'assistant', content: `${prefix}_turn_${suffix}_assistant 回复样本`, turnId, sources: [] } });
  }
  return records;
}

async function writeBatches(memory, records) {
  for (let i = 0; i < records.length; i += 200) await memory.write(records.slice(i, i + 200), memory.epoch, { notify: false });
}

async function runDoze(worker) {
  const outcome = await worker.runDoze(new AbortController().signal);
  assert.equal(outcome, 'done');
}

async function waitWithTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function getRawRows(memory) {
  const out = [];
  let before;
  for (;;) {
    const page = await memory.query(undefined, 200, { scene: null, state: 'all', sort: 'ingestion', order: 'asc',
      ...(before === undefined ? {} : { afterSeq: before }) });
    if (!page.length) break;
    out.push(...page);
    before = page.at(-1).ingestionSeq;
  }
  return out;
}

async function decodedById(memory, id) {
  const raw = (await memory.db.request('get', { ids: [id] })).rows[0];
  return raw ? memory.decode(raw) : null;
}

async function assertSceneContext(system, scene, expectations) {
  const snapshot = await system.compression.snapshot(scene);
  assert(snapshot.version > 0, `${scene} context head exists`);
  assert(snapshot.text.includes(`FIXTURE_HEAD_${scene}`), `${scene} head has an independent lane summary`);
  const head = await decodedById(system.memory, snapshot.recordId);
  assert(head);
  assert.equal(head.domain, scene);
  assert.equal(head.visibilityFloor, rank(scene));
  const context = await system.memory.context(`fixture ${scene}`, { scene, budget: 8500 });
  assert(context.text.includes(snapshot.text), `${scene} context uses its current head`);
  assert(context.used <= 8500, `${scene} context stays within its character budget`);
  const rendered = `${context.text}\n${JSON.stringify(context.messages)}`;
  for (const marker of expectations.present) assert(rendered.includes(marker), `${scene} should contain allowed marker ${marker}`);
  for (const marker of expectations.absent) assert(!rendered.includes(marker), `${scene} leaked forbidden marker ${marker}`);
  assert(context.messages.some(message => message.content.includes(expectations.latest)), `${scene} context keeps its recent original round`);
  return { snapshot, context };
}

async function testCompressionExportRestoreDeleteAndResume() {
  const clock = fakeClock();
  const original = createSystem('original', clock);
  await original.memory.init();
  const turns = SCOPES.flatMap(scope => turnsForScope(scope));
  await writeBatches(original.memory, turns);

  await runDoze(original.worker);
  assert(original.calls.extract.length > 0 && original.calls.summarize.length >= 3);
  const initialHeadState = {};
  for (const scene of ['work', 'life', 'private']) {
    const { snapshot } = await assertSceneContext(original, scene, scene === 'work' ? {
      present: ['EVOLUTION_WORK_F0'], absent: ['EVOLUTION_LIFE_F1', 'EVOLUTION_PRIVATE_F2', 'EVOLUTION_WORK_BUSINESS_F2'],
      latest: 'EVOLUTION_WORK_F0_turn_12_user',
    } : scene === 'life' ? {
      present: ['EVOLUTION_WORK_F0', 'EVOLUTION_LIFE_F1'], absent: ['EVOLUTION_PRIVATE_F2', 'EVOLUTION_WORK_BUSINESS_F2'],
      latest: 'EVOLUTION_LIFE_F1_turn_12_user',
    } : {
      present: ['EVOLUTION_WORK_F0', 'EVOLUTION_LIFE_F1', 'EVOLUTION_PRIVATE_F2', 'EVOLUTION_WORK_BUSINESS_F2'],
      absent: [], latest: 'EVOLUTION_WORK_BUSINESS_F2_turn_12_user',
    });
    initialHeadState[scene] = { version: snapshot.version, watermark: snapshot.coveredThrough };
  }

  const budgetRow = await decodedById(original.memory, 'maintenance:budget');
  const totalCalls = original.calls.extract.length + original.calls.summarize.length;
  assert.equal(budgetRow.value.calls.length, totalCalls, 'shared persistent budget records each extractor and compression call');
  assert(totalCalls <= 100);
  for (let index = 1; index < budgetRow.value.calls.length; index++) {
    assert(budgetRow.value.calls[index] - budgetRow.value.calls[index - 1] >= 60_000,
      'fake clock advances between calls so the shared three-per-minute limit is respected without waiting');
  }
  const initialRows = await getRawRows(original.memory);
  const sequences = new Map(initialRows.map(row => [row.id, row.ingestionSeq]));
  const watermarks = new Map();
  for (const row of initialRows.filter(row => row.id.startsWith('maintenance:') && row.id !== 'maintenance:budget')) {
    watermarks.set(row.id, structuredClone(row.value.watermark || null));
  }
  const rawSnapshot = await original.memory.db.request('query', { scene: null, state: 'all', limit: 200 });
  assert(!JSON.stringify(rawSnapshot.rows).includes('EVOLUTION_'), 'raw SQLite rows do not expose source plaintext');
  for (const row of initialRows) {
    const raw = (await original.memory.db.request('get', { ids: [row.id] })).rows[0];
    assert(!raw.body.includes('EVOLUTION_'), 'SQLite body does not contain source plaintext');
  }

  const callsBeforeIdle = totalCalls;
  await runDoze(original.worker);
  assert.equal(original.calls.extract.length + original.calls.summarize.length, callsBeforeIdle,
    'an unchanged idle cycle makes zero extract or summary calls');

  const backup = await original.memory.export(PASSPHRASE);
  const restored = createSystem('restored-new-key', clock);
  assert.notDeepEqual(restored.key, original.key, 'restore test uses a new database key');
  await restored.memory.init();
  const restoreResult = await restored.memory.restore(backup, PASSPHRASE);
  assert.equal(restoreResult.ok, true);
  const restoredRows = await getRawRows(restored.memory);
  assert.equal(restoredRows.length, initialRows.length);
  assert.deepEqual(new Map(restoredRows.map(row => [row.id, row.ingestionSeq])), sequences,
    'export/restore preserves every ingestion sequence and worker cursor');
  for (const [id, watermark] of watermarks) {
    const row = await decodedById(restored.memory, id);
    assert(row, `restored maintenance state exists: ${id}`);
    assert.deepEqual(row.value.watermark || null, watermark, `watermark survived restore: ${id}`);
  }
  for (const scene of ['work', 'life', 'private']) {
    const snapshot = await restored.compression.snapshot(scene);
    assert.equal(snapshot.version, initialHeadState[scene].version);
    assert.deepEqual(snapshot.coveredThrough, initialHeadState[scene].watermark);
  }

  const restoredCallCount = restored.calls.extract.length + restored.calls.summarize.length;
  await runDoze(restored.worker);
  assert.equal(restored.calls.extract.length + restored.calls.summarize.length, restoredCallCount,
    'restored checkpoint and compression watermarks do not reprocess old turns');

  const workBeforeAppend = await restored.compression.snapshot('work');
  const newWorkTurn = turnsForScope(SCOPES[0], 1, { prefix: 'EVOLUTION_WORK_F0_NEW', start: 13 });
  await writeBatches(restored.memory, newWorkTurn);
  await runDoze(restored.worker);
  const workAfterAppend = await restored.compression.snapshot('work');
  assert(workAfterAppend.version > workBeforeAppend.version, 'restored worker continues its work head from the saved watermark');
  const workCheckpoint = await decodedById(restored.memory, 'maintenance:work:0');
  const afterAppendRows = await getRawRows(restored.memory);
  const latestSeq = Math.max(...newWorkTurn.map(row => afterAppendRows.find(saved => saved.id === row.id).ingestionSeq));
  assert(workCheckpoint.value.watermark.ingestionSeq >= latestSeq, 'restored doze waterline advances past newly ingested work');

  // Pick a life source inside a compressed segment, excluding the selected
  // literal excerpt. Its links must invalidate that lane and higher-visibility
  // private projection, while the unrelated work-only head remains intact.
  const lifeSnapshotBeforeDelete = await restored.compression.snapshot('life');
  const privateSnapshotBeforeDelete = await restored.compression.snapshot('private');
  const workSnapshotBeforeDelete = await restored.compression.snapshot('work');
  const lifeHead = await decodedById(restored.memory, lifeSnapshotBeforeDelete.recordId);
  const lifeSegmentIds = lifeHead.value.segments.map(item => item.id);
  const lifeSegments = await Promise.all(lifeSegmentIds.map(id => decodedById(restored.memory, id)));
  let target = null;
  for (const segment of lifeSegments) {
    for (const id of segment.value.sources) {
      const source = await decodedById(restored.memory, id);
      if (source?.kind === 'message' && source.domain === 'life' && segment.value.excerpts.every(excerpt => excerpt.sourceId !== id)) {
        target = { segment, id, source }; break;
      }
    }
    if (target) break;
  }
  assert(target, 'a compressed source not selected as an excerpt exists');
  const removedSource = target.source;
  assert.equal(removedSource.kind, 'message');
  assert.equal(removedSource.domain, 'life');
  restored.settings.scene = 'private';
  await restored.memory.remove(target.id);
  assert.equal((await restored.memory.db.request('get', { ids: [lifeSnapshotBeforeDelete.recordId] })).rows.length, 0,
    'deleting a non-excerpt life source cascades to the immutable life head');
  assert.equal((await restored.memory.db.request('get', { ids: [privateSnapshotBeforeDelete.recordId] })).rows.length, 0,
    'deleting a life source cascades to private projections that depend on it');
  assert.equal((await restored.memory.db.request('get', { ids: [workSnapshotBeforeDelete.recordId] })).rows.length, 1,
    'deleting life data does not invalidate the independent work head');
  assert.equal((await restored.memory.db.request('get', { ids: [currentId('life'), currentId('private')] })).rows.length, 0,
    'mutable pointers cascade with the removed immutable heads');
  const deletedRaw = await restored.memory.db.request('get', { ids: [target.id] });
  assert.equal(deletedRaw.rows.length, 0);
  const oldCalls = restored.calls.extract.length;
  await runDoze(restored.worker);
  assert.equal(restored.calls.extract.length, oldCalls, 'the deleted old message is behind the durable doze watermark');
  const afterDelete = await restored.compression.snapshot('private');
  assert(!afterDelete.text.includes(removedSource.value.content), 'a rebuilt higher-scope head cannot resurrect the deleted source');
  const persistedBudget = await decodedById(restored.memory, 'maintenance:budget');
  assert.equal(persistedBudget.value.calls.length,
    totalCalls + restored.calls.extract.length + restored.calls.summarize.length,
    'post-restore calls extend the database budget state; the database is the authority');
  for (const row of await getRawRows(restored.memory)) {
    assert(!Array.isArray(row.value?.sources) || !row.value.sources.includes(target.id), 'no live derivative retains the forgotten source id');
  }

  return { initialRows: initialRows.length, totalModelStubCalls: totalCalls, removedSourceId: target.id };
}

async function testLateSummaryCannotCommitAfterSceneEpochChange() {
  const clock = fakeClock(Date.UTC(2026, 5, 1));
  let summaryStartedResolve, releaseSummaryResolve;
  const summaryStarted = new Promise(resolve => { summaryStartedResolve = resolve; });
  const releaseSummary = new Promise(resolve => { releaseSummaryResolve = resolve; });
  const system = createSystem('late-summary', clock, {
    scene: 'work', summarizeOverride: async (messages, { scene }) => {
      system.calls.summarize.push({ scene, ids: messages.map(row => row.id) });
      summaryStartedResolve();
      await releaseSummary; // Deliberately ignores abort to exercise late completion.
      const source = messages.find(row => row.role === 'user');
      clock.advanceMinute();
      return { content: `LATE_FIXTURE_SUMMARY_${scene}`, excerpts: [{ sourceId: source.id, quote: source.content.slice(0, 100) }] };
    },
  });
  await system.memory.init();
  await writeBatches(system.memory, turnsForScope(SCOPES[0], 12));
  const controller = new AbortController();
  // changeScene() owns cancellation through the attached maintenance worker;
  // ContextCompression additionally checks sceneEpoch before committing.
  system.worker.controller = controller;
  system.worker.activeMode = 'doze';
  const running = system.compression.run({ signal: controller.signal,
    reserveModelCall: signal => system.worker.reserveModelCall(signal) });
  await waitWithTimeout(summaryStarted, 5000, `late summary did not start; compressionCalls=${system.calls.summarize.length}`);
  system.settings.scene = 'life';
  await system.memory.changeScene('life');
  releaseSummaryResolve();
  const result = await running;
  assert.equal(result.status, 'paused');
  for (const scene of ['work', 'life', 'private']) {
    assert.equal((await system.memory.db.request('get', { ids: [currentId(scene), `context-head:v1:${scene}`] })).rows.length, 0,
      'late summary after scene epoch change must not commit a pointer or legacy head');
  }
}

async function main() {
  if (!fs.existsSync(bin) || !fs.statSync(bin).isFile()) throw new Error(`existing native vault binary is required: ${bin}`);
  try {
    const report = await testCompressionExportRestoreDeleteAndResume();
    await testLateSummaryCannotCommitAfterSceneEpochChange();
    console.log(`memory evolution SQLite integration passed (${report.initialRows} records; ${report.totalModelStubCalls} stub calls; fresh-key restore; three scope heads)`);
  } finally {
    for (const worker of workers) await worker.close().catch(() => {});
    for (const memory of services) await memory.close().catch(() => {});
    for (const key of testKeys) key.fill(0);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
