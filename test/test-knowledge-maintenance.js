#!/usr/bin/env node
'use strict';

// Real SQLite integration of maintenance orchestration. All model boundaries
// are deterministic local stubs; no application, network, or production data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { ContextCompression } = require('../src/main/context-compression');
const { rank } = require('../src/main/memory-scope');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'vault');
const TEST_KEY = Buffer.from('4c6f63616c496e746567726174696f6e2d746573742d6d656d6f72792d6b6579', 'hex');
const TEMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workbunny-knowledge-maintenance-'));
const services = new Set();
let now = Date.UTC(2026, 9, 27, 10, 0, 0);

function createService(name, scene = 'work') {
  const settings = { enabled: true, extract: false, scene };
  const memory = new MemoryService({ dir: path.join(TEMP, name), bin: BIN,
    getSettings: () => settings, openKey: async () => Buffer.from(TEST_KEY), clock: () => now++ });
  services.add(memory);
  return { memory, settings };
}

function fakeTimers() {
  let sequence = 0;
  const timers = new Map();
  return { timers, setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id) };
}

async function seedConversation(memory) {
  const rows = [];
  for (const scene of ['work', 'life', 'private']) {
    const domain = scene, visibilityFloor = rank(scene);
    for (let turn = 1; turn <= 10; turn++) {
      const turnId = `raw-${scene}-turn-${turn}`;
      rows.push({ id: `${turnId}-user`, kind: 'message', ts: now++, domain, visibilityFloor,
        value: { role: 'user', turnId, content: `${scene} 原始对话第${turn}轮：讨论项目中的茶饮偏好和安排。`, sources: [] } });
      rows.push({ id: `${turnId}-assistant`, kind: 'message', ts: now++, domain, visibilityFloor,
        value: { role: 'assistant', turnId, content: `${scene} 助手答复第${turn}轮：记录讨论背景并说明下一步。`, sources: [] } });
    }
  }
  await memory.write(rows);
}

async function seedContradiction(memory, { domain, visibilityFloor, suffix }) {
  const positiveId = `evidence-${suffix}-positive`, negativeId = `evidence-${suffix}-negative`;
  const quotePositive = `我喜欢喝茉莉茶，记录编号${suffix}。`;
  const quoteNegative = `我不喜欢喝茉莉茶，记录编号${suffix}。`;
  await memory.write([
    { id: positiveId, kind: 'message', ts: now++, domain, visibilityFloor,
      value: { role: 'user', content: quotePositive, sources: [] } },
    { id: negativeId, kind: 'message', ts: now++, domain, visibilityFloor,
      value: { role: 'user', content: quoteNegative, sources: [] } },
  ]);
  await memory.write([
    { id: `fact-${suffix}-positive`, kind: 'memory', ts: now++, domain, visibilityFloor,
      value: { content: `喜欢茉莉茶 ${suffix}`, key: `user.drink.tea.${suffix}`, memoryKind: 'fact', status: 'confirmed', origin: 'user-statement',
        evidence: quotePositive, evidenceSourceId: positiveId, tags: ['茉莉茶'], sources: [positiveId] } },
    { id: `fact-${suffix}-negative`, kind: 'memory', ts: now++, domain, visibilityFloor,
      value: { content: `不喜欢茉莉茶 ${suffix}`, key: `user.drink.tea.${suffix}`, memoryKind: 'fact', status: 'confirmed', origin: 'user-statement',
        evidence: quoteNegative, evidenceSourceId: negativeId, tags: ['茉莉茶'], sources: [negativeId] } },
  ]);
}

function validContradiction(inputs) {
  const citations = inputs.map(input => ({ recordId: input.id, sourceId: input.evidence.sourceId, quote: input.evidence.quote }));
  return { relations: [{ type: 'contradiction', recordIds: inputs.map(input => input.id), evidence: citations,
    conditionStatus: 'not_stated', temporalStatus: 'not_stated', conditions: [], temporal: [] }] };
}

async function seedAcceptedTask(memory) {
  const sourceId = 'raw-work-turn-1-user';
  const source = (await memory.db.request('get', { ids: [sourceId] })).rows[0];
  assert(source, 'a real original user message exists as the task source');
  const taskId = 'historical-accepted-task';
  await memory.write([{ id: taskId, kind: 'task', ts: now++, updatedAt: now++, domain: 'work', visibilityFloor: 0,
    value: { target: 'workbuddy', status: 'accepted', goal: '整理项目验收记录并核对来源清单', criteria: '报告列出可核验条目',
      scene: 'work', domain: 'work', visibilityFloor: 0, workModel: 'deepseek-v4.1-flash', acceptedAt: now++, automaticAccepted: true,
      verification: { verdict: 'pass', at: now++, report: '独立复验确认清单符合要求' },
      monitorSummary: '已完成来源清单并报告了对应证据。', sources: [sourceId], content: 'accepted historical task', steps: [] } }]);
}

async function testFullMaintenanceChainAndSharedBudget() {
  const { memory, settings } = createService('full-chain');
  await memory.init();
  await seedConversation(memory);
  const partitions = [
    { domain: 'work', visibilityFloor: 0, suffix: 'work0' },
    { domain: 'work', visibilityFloor: 1, suffix: 'work1' },
    { domain: 'life', visibilityFloor: 1, suffix: 'life1' },
    { domain: 'private', visibilityFloor: 2, suffix: 'private2' },
  ];
  for (const partition of partitions) await seedContradiction(memory, partition);
  await seedAcceptedTask(memory);

  const modelCalls = { extract: [], summarize: [], semantic: [] };
  const timers = fakeTimers();
  const compression = new ContextCompression({ memory, recentRounds: 8, clock: () => now++, summarize: async (messages, { scene }) => {
    modelCalls.summarize.push({ scene, ids: messages.map(row => row.id) });
    return { content: `本地测试压缩摘要 ${scene} ${modelCalls.summarize.length}`,
      excerpts: messages.length ? [{ sourceId: messages[0].id, quote: messages[0].content.slice(0, 120) }] : [] };
  } });
  const maintenance = new MemoryMaintenance({ memory, compression, clock: () => now++,
    extract: async (messages, { signal }) => {
      modelCalls.extract.push(messages.map(row => row.id));
      assert.equal(signal.aborted, false);
      return { memories: [], excerpts: [] };
    },
    analyzeRelations: async (inputs, { partition }) => {
      modelCalls.semantic.push(`${partition.domain}:${partition.visibilityFloor}`);
      return validContradiction(inputs);
    },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });

  assert.equal(maintenance.request('deepdream').ok, true);
  maintenance.request('doze');
  await maintenance.tick();
  assert.equal(maintenance.status().status, 'queued', 'the shared three-calls-per-minute budget pauses the full chain');
  assert.equal(modelCalls.extract.length, 3, 'Dream processed the three original scene partitions before the pause');
  assert.equal(modelCalls.semantic.length, 0);

  let semanticBudgetPaused = false;
  let finished = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    now += 60_001;
    await maintenance.tick();
    if (maintenance.status().status === 'queued' && modelCalls.semantic.length > 0 && modelCalls.semantic.length < partitions.length) {
      semanticBudgetPaused = true;
    }
    if (maintenance.status().status === 'idle') { finished = true; break; }
    assert.equal(maintenance.status().status, 'queued', `expected bounded budget continuation, got ${maintenance.status().status}`);
  }
  assert(finished, 'clock advancement resumes queued maintenance through completion');
  assert(semanticBudgetPaused, 'budget pause occurs after semantic relations have started');
  assert.equal(new Set(modelCalls.semantic).size, partitions.length, 'semantic groups completed once each across budget continuation');
  assert.deepEqual([...modelCalls.semantic].sort(), partitions.map(item => `${item.domain}:${item.visibilityFloor}`).sort());
  for (const scene of ['work', 'life', 'private']) {
    const snapshot = await compression.snapshot(scene);
    const head = (await memory.db.request('get', { ids: [snapshot.recordId], scene })).rows[0];
    assert(head, `Doze/ContextCompression produced the ${scene} scene head`);
  }

  const workDoubts = await memory.knowledge.list({ category: 'doubt', scene: 'work' });
  assert.equal(workDoubts.rows.length, 1, 'work scene can see only its work:0 relation');
  assert.equal(workDoubts.rows[0].domain, 'work');
  const allDoubts = await memory.knowledge.list({ category: 'doubt', scene: 'private' });
  assert.equal(allDoubts.rows.length, partitions.length, 'private scene can see the four scope-valid semantic doubts');

  const experiences = await memory.knowledge.list({ category: 'experience', scene: 'work' });
  assert(experiences.rows.some(row => row.id.startsWith('experience:')), 'Deepdream backfilled the accepted historical task experience');
  assert.equal(new Set(modelCalls.extract.map(ids => JSON.stringify(ids))).size, modelCalls.extract.length,
    'budget resumes continue after committed Dream batches without repeating model extraction');
  assert.equal(new Set(modelCalls.semantic).size, modelCalls.semantic.length, 'semantic analysis is not repeated after cache commit');
  assert(modelCalls.summarize.every(call => ['work', 'life', 'private'].includes(call.scene)));
  assert(['work', 'life', 'private'].every(scene => modelCalls.summarize.some(call => call.scene === scene)),
    'all three views were compressed during the same maintenance chain');
  await maintenance.close();
}

async function testInvalidSemanticOutputDoesNotAdvance() {
  const { memory } = createService('invalid-semantic');
  await memory.init();
  await seedContradiction(memory, { domain: 'work', visibilityFloor: 0, suffix: 'invalid' });
  const timers = fakeTimers();
  const maintenance = new MemoryMaintenance({ memory, extract: async () => ({ memories: [], excerpts: [] }),
    analyzeRelations: async () => ({ relations: [{ type: 'unsupported', recordIds: [] }] }),
    clock: () => now++, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  maintenance.request('deepdream');
  await maintenance.tick();
  assert.equal(maintenance.status().status, 'failed');
  assert.match(maintenance.status().note, /E_INVALID_MODEL_OUTPUT/u);
  const relationRows = await memory.query('state', 50, { scene: null, domain: 'work', visibilityFloor: 0 });
  assert.equal(relationRows.filter(row => row.value?.origin === 'semantic-relation-v1').length, 0);
  assert.equal(relationRows.filter(row => row.value?.origin === 'semantic-analysis-cache-v1').length, 0,
    'invalid semantic output commits no relation cache');
  assert.equal(relationRows.filter(row => row.id === 'semantic-dream-cursor:v1:work:0').length, 0,
    'invalid semantic output does not advance the partition cursor');
  await maintenance.close();
}

async function testFailedDreamCooldownSurvivesRestartAndManualRetry() {
  const { memory } = createService('failure-cooldown');
  await memory.init();
  await seedContradiction(memory, { domain: 'work', visibilityFloor: 0, suffix: 'cooldown' });
  const timers = fakeTimers();
  const invalid = new MemoryMaintenance({ memory, extract: async () => ({ memories: [], excerpts: [] }),
    analyzeRelations: async () => ({ relations: [{ type: 'unsupported', recordIds: [] }] }),
    clock: () => now++, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  assert.equal(invalid.request('deepdream').ok, true);
  await invalid.tick();
  assert.equal(invalid.status().status, 'failed');
  const failedAt = now;
  const schedule = await readSchedule(memory);
  assert(schedule.value.retryAfter >= failedAt + 29 * 60_000, 'failure persists a bounded automatic retry cooldown');
  assert.equal(invalid.request('deepdream', { automatic: true }).ok, false, 'the same worker suppresses automatic retries');
  await invalid.close();
  await memory.close();

  // Simulate a worker restart while retaining the same encrypted SQLite data.
  now = failedAt + 15_000;
  const reopened = createService('failure-cooldown');
  await reopened.memory.init();
  let semanticCalls = 0;
  const restartedTimers = fakeTimers();
  const restarted = new MemoryMaintenance({ memory: reopened.memory, extract: async () => ({ memories: [], excerpts: [] }),
    analyzeRelations: async inputs => { semanticCalls++; return validContradiction(inputs); },
    clock: () => now++, setTimer: restartedTimers.setTimer, clearTimer: restartedTimers.clearTimer });
  assert.equal(await restarted.checkDue(now), false, 'persisted cooldown blocks automatic retry after worker restart');
  assert.equal(restarted.request('deepdream', { automatic: true }).ok, false);
  assert.equal(semanticCalls, 0);
  assert.equal(restarted.request('deepdream').ok, true, 'manual retry bypasses the automatic cooldown');
  await restarted.tick();
  assert.equal(restarted.status().status, 'idle');
  assert.equal(semanticCalls, 1);
  assert.equal((await readSchedule(reopened.memory)).value.retryAfter, 0, 'successful manual retry clears persisted cooldown');
  await restarted.close();
}

function delayNextScheduleRead(worker) {
  const read = worker.readDailySchedule.bind(worker);
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let delay = true;
  worker.readDailySchedule = async () => {
    const snapshot = await read();
    if (delay) { delay = false; started(); await gate; }
    return snapshot;
  };
  return { started: startedPromise, release };
}

async function testDelayedScheduleReadCannotOverrideFailureOrSuccess() {
  const { memory } = createService('schedule-read-race');
  await memory.init();
  await seedContradiction(memory, { domain: 'work', visibilityFloor: 0, suffix: 'schedule-race' });
  const timers = fakeTimers();
  let valid = false;
  const worker = new MemoryMaintenance({ memory, extract: async () => ({ memories: [], excerpts: [] }),
    analyzeRelations: async inputs => valid ? validContradiction(inputs) : ({ relations: [{ type: 'unsupported', recordIds: [] }] }),
    clock: () => now++, setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  // An old "no cooldown" read completes after a concurrent failed run stores one.
  const staleBeforeFailure = delayNextScheduleRead(worker);
  const firstCheck = worker.checkDue(now);
  await staleBeforeFailure.started;
  assert.equal(worker.request('deepdream').ok, true);
  await worker.tick();
  assert.equal(worker.status().status, 'failed');
  const failureCooldown = worker.automaticRetryAfter;
  assert(failureCooldown > now);
  staleBeforeFailure.release();
  assert.equal(await firstCheck, false, 'checkDue discards a read that crossed a persisted failure update');
  assert.equal(worker.automaticRetryAfter, failureCooldown, 'stale pre-failure data cannot erase the cooldown');
  assert.equal((await readSchedule(memory)).value.retryAfter, failureCooldown);

  // A stale read of the cooldown also cannot restore it after manual success clears it.
  valid = true;
  now = failureCooldown + 1;
  const staleBeforeSuccess = delayNextScheduleRead(worker);
  const secondCheck = worker.checkDue(now);
  await staleBeforeSuccess.started;
  assert.equal(worker.request('deepdream').ok, true, 'manual retry remains available during the cooldown');
  await worker.tick();
  assert.equal(worker.status().status, 'idle');
  assert.equal(worker.automaticRetryAfter, 0);
  assert.equal((await readSchedule(memory)).value.retryAfter, 0);
  staleBeforeSuccess.release();
  assert.equal(await secondCheck, false, 'checkDue discards a read that crossed successful cooldown clearing');
  assert.equal(worker.automaticRetryAfter, 0, 'stale cooldown data cannot restore the cleared retry time');
  await worker.close();
}

async function testCanRunFalseDoesNotWrite() {
  const { memory } = createService('cannot-run');
  await memory.init();
  await memory.write([{ id: 'must-not-process', kind: 'message', ts: now++, domain: 'work', visibilityFloor: 0,
    value: { role: 'user', turnId: 'blocked-turn', content: '本条消息不能处理', sources: [] } }]);
  let calls = 0;
  const timers = fakeTimers();
  const maintenance = new MemoryMaintenance({ memory, extract: async () => { calls++; return { memories: [], excerpts: [] }; },
    canRun: () => false, clock: () => now++, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const epoch = memory.epoch;
  maintenance.request('dream');
  await maintenance.tick();
  assert.equal(maintenance.status().status, 'paused');
  assert.equal(memory.epoch, epoch, 'a denied canRun check writes no watermark or derivative record');
  assert.equal(calls, 0);
  await maintenance.close();
}

async function readSchedule(memory) {
  const raw = await memory.db.request('get', { ids: ['maintenance:daily-schedule'] });
  return raw.rows[0] ? memory.decode(raw.rows[0]) : null;
}

async function testSemanticScheduleVersionUpgrade() {
  const { memory } = createService('schedule-upgrade');
  await memory.init();
  const localDate = new Date(now);
  const scheduleDate = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
  await memory.write([{ id: 'maintenance:daily-schedule', kind: 'state', ts: 0, updatedAt: now++, domain: 'private', visibilityFloor: 2,
    value: { lastDueLocalDate: scheduleDate, lastSuccessAt: now - 1, sources: [] } }]);
  const timers = fakeTimers();
  const worker = new MemoryMaintenance({ memory, extract: async () => ({ memories: [], excerpts: [] }),
    analyzeRelations: async () => ({ relations: [] }), clock: () => now++,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  assert.equal(await worker.checkDue(now), true, 'a same-day 0.7 schedule is rechecked once for semantic Dream version 1');
  await worker.tick();
  const upgraded = await readSchedule(memory);
  assert.equal(upgraded.value.lastDueLocalDate, scheduleDate);
  assert.equal(upgraded.value.lifecycleVersion, 3);
  assert.equal(upgraded.value.deepdreamDate, scheduleDate);
  assert.equal(await worker.checkDue(now), false, 'successful version-1 Dream suppresses another same-day upgrade run');
  await worker.close();

  const { memory: disabledMemory } = createService('schedule-upgrade-disabled');
  await disabledMemory.init();
  await disabledMemory.write([{ id: 'maintenance:daily-schedule', kind: 'state', ts: 0, updatedAt: now++, domain: 'private', visibilityFloor: 2,
    value: { lastDueLocalDate: scheduleDate, lastSuccessAt: now - 1, sources: [] } }]);
  const disabledTimers = fakeTimers(); let semanticCalls = 0;
  const disabled = new MemoryMaintenance({ memory: disabledMemory, extract: async () => ({ memories: [], excerpts: [] }),
    analyzeRelations: async () => { semanticCalls++; return { relations: [] }; }, allowAutomatic: () => false,
    clock: () => now++, setTimer: disabledTimers.setTimer, clearTimer: disabledTimers.clearTimer });
  const due = await disabled.checkDue(now);
  assert.equal(due, false, 'disabled automatic work does not queue an upgrade run');
  assert.equal(semanticCalls, 0, 'automatic maintenance disabled prevents the semantic upgrade scan');
  assert.notEqual((await readSchedule(disabledMemory)).value.lifecycleVersion, 3, 'disabled automatic work does not mark the upgrade as complete');
  await disabled.close();
}

async function main() {
  try {
    await testFullMaintenanceChainAndSharedBudget();
    await testInvalidSemanticOutputDoesNotAdvance();
    await testFailedDreamCooldownSurvivesRestartAndManualRetry();
    await testDelayedScheduleReadCannotOverrideFailureOrSuccess();
    await testCanRunFalseDoesNotWrite();
    await testSemanticScheduleVersionUpgrade();
    console.log('Knowledge maintenance SQLite end-to-end integration passed');
  } finally {
    await Promise.all([...services].map(service => service.close().catch(() => {})));
    fs.rmSync(TEMP, { recursive: true, force: true });
    TEST_KEY.fill(0);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
