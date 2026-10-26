#!/usr/bin/env node
'use strict';

// FakeMemory covers state-machine boundaries. The final test uses the existing
// SQLite vault binary with MemoryService in a disposable temporary directory.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { createMemoryDream, PARTITIONS } = require('../src/main/memory-dream');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const testKey = Buffer.from('d9a62a5d05e64f39a4db40c319fc6bc0d9a62a5d05e64f39a4db40c319fc6bc0', 'hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-dream-'));
const services = new Set();

function clone(row) { return { ...row, value: { ...row.value, sources: [...(row.value.sources || [])] } }; }

class FakeMemory {
  constructor() {
    this.key = Buffer.from(testKey); this.records = new Map(); this.nextSeq = 1;
    this.epoch = 1; this.generation = 1; this.closed = false; this.tail = Promise.resolve();
    this.writes = []; this.afterQuery = null; this.queryLimits = [];
    this.decode = row => clone(row);
    this.db = { request: async (op, payload) => {
      if (op !== 'get') throw new Error(`unexpected fake operation ${op}`);
      return { rows: payload.ids.map(id => this.records.get(id)).filter(Boolean).map(clone) };
    } };
  }
  serial(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  async query(kind, limit = 50, cursor = {}) {
    this.queryLimits.push(limit);
    let rows = [...this.records.values()].filter(row => !kind || row.kind === kind);
    if (cursor.state && cursor.state !== 'all') rows = rows.filter(row => row.state === cursor.state);
    if (cursor.domain) rows = rows.filter(row => row.domain === cursor.domain);
    if (Number.isInteger(cursor.visibilityFloor)) rows = rows.filter(row => row.visibilityFloor === cursor.visibilityFloor);
    if (cursor.afterSeq !== undefined) rows = rows.filter(row => row.ingestionSeq > cursor.afterSeq);
    if (cursor.beforeSeq !== undefined) rows = rows.filter(row => row.ingestionSeq < cursor.beforeSeq);
    if (cursor.sort === 'ingestion') rows.sort((a, b) => cursor.order === 'asc' ? a.ingestionSeq - b.ingestionSeq : b.ingestionSeq - a.ingestionSeq);
    else rows.sort((a, b) => cursor.order === 'asc' ? a.ts - b.ts || a.id.localeCompare(b.id) : b.ts - a.ts || b.id.localeCompare(a.id));
    const output = rows.slice(0, limit).map(clone);
    if (this.afterQuery) await this.afterQuery(kind, cursor, output);
    return output;
  }
  async write(records, epoch = this.epoch) {
    if (epoch !== this.epoch) throw Object.assign(new Error('stale epoch'), { code: 'stale_epoch' });
    if (records.length > 200) throw new Error('write batch limit');
    const parentRows = new Map(this.records);
    for (const record of records) for (const source of record.value.sources || []) {
      if (!parentRows.has(source)) throw Object.assign(new Error('missing source'), { code: 'invalid_source' });
      if (record.visibilityFloor < parentRows.get(source).visibilityFloor) throw Object.assign(new Error('floor downgrade'), { code: 'invalid_source' });
    }
    const next = new Map(this.records);
    for (const record of records) {
      const old = next.get(record.id);
      const ingestionSeq = old?.ingestionSeq ?? this.nextSeq++;
      next.set(record.id, { state: 'active', updatedAt: record.ts, ...clone(record), ingestionSeq });
    }
    this.records = next; this.epoch++;
    this.writes.push(records.map(clone));
  }
  seed(record) {
    this.records.set(record.id, { state: 'active', updatedAt: record.ts, ...clone(record), ingestionSeq: this.nextSeq++ });
    this.epoch++;
  }
}

function sourceRecord(id = 'source') {
  return { id, kind: 'message', ts: 1, domain: 'private', visibilityFloor: 2, value: { role: 'user', content: 'synthetic source', sources: [] } };
}
function memoryRecord(id, seq, content, extra = {}) {
  return { id, kind: 'memory', ts: seq, domain: 'private', visibilityFloor: 2, state: 'active', ingestionSeq: seq,
    value: { content, key: '', memoryKind: 'fact', status: 'confirmed', importance: 0.5, sources: ['source'], ...extra } };
}
function seedSeries(memory, count, duplicateAt = -1, extra = {}) {
  memory.seed(sourceRecord());
  for (let index = 1; index <= count; index++) {
    const content = index === duplicateAt ? 'duplicate sentinel fact' : `synthetic fact ${index}`;
    memory.seed(memoryRecord(`m-${index}`, index, content, index === 1 ? { content: 'duplicate sentinel fact' } : extra));
  }
}

async function testCrossPageAndRestart() {
  const memory = new FakeMemory(); seedSeries(memory, 41, 41);
  let now = new Date(2026, 0, 1, 12).getTime();
  // The first item is the eventual canonical; replace the first series item content.
  memory.records.set('m-1', { ...memory.records.get('m-1'), value: { ...memory.records.get('m-1').value, content: 'duplicate sentinel fact' } });
  const first = await createMemoryDream({ memory, clock: () => now, maxPerPartition: 40, pageSize: 40 }).run();
  assert.equal(first.scanned, 40); assert.equal(first.archived, 0); assert.equal(first.more, true);
  assert.equal(memory.records.get('m-41').state, 'active');

  now = new Date(2026, 0, 2, 12).getTime();
  const restarted = await createMemoryDream({ memory, clock: () => now }).run();
  assert.equal(restarted.scanned, 1, 'a new instance resumes from persisted cursor');
  assert.equal(restarted.archived, 1);
  assert.equal(memory.records.get('m-41').state, 'archived');
  assert.equal(memory.records.get('m-41').value.content, 'duplicate sentinel fact', 'archive keeps original content');
  assert.equal(memory.records.get('m-41').value.duplicateOf, 'm-1');
  assert.equal(restarted.more, false);

  const writes = memory.writes.length;
  const noOp = await createMemoryDream({ memory, clock: () => now }).run();
  assert.deepEqual(noOp, { status: 'done', scanned: 0, archived: 0, partitions: PARTITIONS.length, more: false });
  assert.equal(memory.writes.length, writes, 'a repeated run with unchanged memory performs no writes');
  assert(memory.queryLimits.every(limit => limit <= 40), 'every vault query stays within the 40-record page cap');
  const index = [...memory.records.values()].find(row => row.kind === 'state' && row.value?.job === 'memory-dream-index-v1' && row.value.canonicalId === 'm-1');
  assert(index && index.value.sources.length === 1 && index.value.sources[0] === 'm-1');
  assert(!index.id.includes('duplicate sentinel fact'), 'index ID does not expose content for dictionary guessing');
}

async function testDailyRescanFindsSameSequenceUpdate() {
  const memory = new FakeMemory(); memory.seed(sourceRecord());
  memory.seed(memoryRecord('old-1', 1, 'stable original fact'));
  memory.seed(memoryRecord('old-2', 2, 'different prior fact'));
  let now = new Date(2026, 4, 1, 12).getTime();
  const first = await createMemoryDream({ memory, clock: () => now }).run();
  assert.equal(first.scanned, 2); assert.equal(first.archived, 0);
  const afterFirstWrites = memory.writes.length;

  const old = memory.records.get('old-2');
  memory.records.set('old-2', { ...old, value: { ...old.value, content: 'stable original fact' } });
  memory.epoch++; // Simulate an in-place edit that preserves ingestionSeq.
  const sameDay = await createMemoryDream({ memory, clock: () => now }).run();
  assert.equal(sameDay.scanned, 0); assert.equal(sameDay.archived, 0);
  assert.equal(memory.writes.length, afterFirstWrites, 'same-day unchanged high-water runs are true no-ops');

  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); now = tomorrow.getTime();
  const due = await createMemoryDream({ memory, clock: () => now }).run();
  assert.equal(due.scanned, 2, 'the next local day revisits older records despite an unchanged ingestion sequence');
  assert.equal(due.archived, 1);
  assert.equal(memory.records.get('old-2').state, 'archived');
  const afterDueWrites = memory.writes.length;
  const repeated = await createMemoryDream({ memory, clock: () => now }).run();
  assert.equal(repeated.scanned, 0); assert.equal(memory.writes.length, afterDueWrites,
    'repeated runs on one local date do not start another cold sweep');

  const back = new Date(now); back.setDate(back.getDate() - 2); now = back.getTime();
  const rolledBack = await createMemoryDream({ memory, clock: () => now }).run();
  assert.equal(rolledBack.scanned, 0, 'clock rollback cannot repeat a completed local-day sweep');
  assert.equal(memory.writes.length, afterDueWrites);
}

async function testChangedCanonicalCannotAbsorbOldKey() {
  const memory = new FakeMemory(); memory.seed(sourceRecord());
  memory.seed(memoryRecord('canonical', 1, 'old exact fact'));
  let now = new Date(2026, 5, 1, 12).getTime();
  const initial = await createMemoryDream({ memory, clock: () => now }).run();
  assert.equal(initial.scanned, 1);

  const canonical = memory.records.get('canonical');
  memory.records.set('canonical', { ...canonical, value: { ...canonical.value, content: 'edited canonical fact' } });
  memory.epoch++;
  memory.seed(memoryRecord('later-old-wording', 2, 'old exact fact'));
  const revised = await createMemoryDream({ memory, clock: () => now }).run();
  assert.equal(revised.archived, 0, 'an HMAC index match is insufficient if its canonical content changed');
  assert.equal(memory.records.get('later-old-wording').state, 'active');
}

async function testColdPoolBeyondTwoHundredAndProtectedRows() {
  const memory = new FakeMemory(); seedSeries(memory, 201, 201);
  memory.records.set('m-1', { ...memory.records.get('m-1'), value: { ...memory.records.get('m-1').value, content: 'duplicate sentinel fact' } });
  const first = await createMemoryDream({ memory }).run();
  assert.equal(first.scanned, 200); assert.equal(first.archived, 0); assert.equal(first.more, true);
  const second = await createMemoryDream({ memory }).run();
  assert.equal(second.scanned, 1); assert.equal(second.archived, 1);
  assert.equal(memory.records.get('m-201').state, 'archived', 'records beyond the first 200 are reached on the next bounded run');

  const scoped = new FakeMemory(); scoped.seed(sourceRecord());
  scoped.seed({ id: 'work-source', kind: 'message', ts: 1, domain: 'work', visibilityFloor: 0,
    value: { role: 'user', content: 'work scope source', sources: [] } });
  scoped.seed(memoryRecord('private-scope-copy', 1, 'same content cross scope'));
  const workCopy = memoryRecord('work-scope-copy', 2, 'same content cross scope');
  workCopy.domain = 'work'; workCopy.visibilityFloor = 0; workCopy.value.sources = ['work-source'];
  scoped.seed(workCopy);
  const scopeResult = await createMemoryDream({ memory: scoped }).run();
  assert.equal(scopeResult.archived, 0, 'equal content in different domain/floor partitions is never merged');

  const protectedMemory = new FakeMemory(); protectedMemory.seed(sourceRecord());
  protectedMemory.seed(memoryRecord('ordinary-1', 1, 'protected duplicate fact'));
  protectedMemory.seed(memoryRecord('ordinary-2', 2, 'protected duplicate fact'));
  protectedMemory.seed(memoryRecord('pinned', 3, 'protected duplicate fact', { importance: 1, pinned: true }));
  protectedMemory.seed(memoryRecord('candidate', 4, 'protected duplicate fact', { status: 'pending', memoryKind: 'candidate' }));
  protectedMemory.seed(memoryRecord('temporary', 5, 'protected duplicate fact', { memoryKind: 'temporary' }));
  protectedMemory.seed(memoryRecord('other-kind', 6, 'protected duplicate fact', { memoryKind: 'preference' }));
  const outcome = await createMemoryDream({ memory: protectedMemory }).run();
  assert.equal(outcome.archived, 1);
  for (const id of ['ordinary-1', 'pinned', 'candidate', 'temporary']) assert.equal(protectedMemory.records.get(id).state, 'active');
  assert.equal(protectedMemory.records.get('other-kind').state, 'active', 'same text with a different memory kind remains distinct');
  assert.equal(protectedMemory.records.get('ordinary-2').state, 'archived');
}

async function testCancellationAndChangedSourceDoNotAdvance() {
  const memory = new FakeMemory(); seedSeries(memory, 80);
  let checks = 0;
  const paused = await createMemoryDream({ memory, maxPerPartition: 80 }).run({ canRun: async () => ++checks <= 12 });
  assert.equal(paused.status, 'paused'); assert.equal(paused.scanned, 40, JSON.stringify(paused));
  const resumed = await createMemoryDream({ memory }).run();
  assert.equal(resumed.scanned, 40, 'committed page resumes without rescanning it');

  const signalMemory = new FakeMemory(); seedSeries(signalMemory, 80);
  const controller = new AbortController(); let signalChecks = 0;
  const signalPaused = await createMemoryDream({ memory: signalMemory, maxPerPartition: 80 }).run({ signal: controller.signal,
    canRun: async () => { if (++signalChecks === 13) controller.abort(); return true; } });
  assert.equal(signalPaused.status, 'paused'); assert.equal(signalPaused.scanned, 40,
    'AbortSignal stops before the next page after the previous page was committed');

  const changed = new FakeMemory(); seedSeries(changed, 1);
  changed.afterQuery = async (kind, cursor, rows) => {
    if (kind === 'memory' && cursor.sort === 'ingestion' && cursor.order === 'asc' && rows.some(row => row.id === 'm-1')) {
      changed.afterQuery = null;
      const row = changed.records.get('m-1');
      changed.records.set(row.id, { ...row, value: { ...row.value, content: 'changed after page snapshot' } });
      changed.epoch++;
    }
  };
  const beforeWrites = changed.writes.length;
  const cancelled = await createMemoryDream({ memory: changed }).run();
  assert.equal(cancelled.status, 'paused'); assert.equal(cancelled.scanned, 0);
  assert.equal(changed.writes.length, beforeWrites, 'changed source prevents archive, index, and cursor commit');
  assert.equal([...changed.records.values()].some(row => row.kind === 'state' && row.value?.job === 'memory-dream-cursor-v1'), false);
}

function createSQLiteService(name) {
  const settings = { enabled: true, extract: false, scene: 'private' };
  const service = new MemoryService({ dir: path.join(temp, name), bin, getSettings: () => settings,
    openKey: async () => Buffer.from(testKey), clock: () => Date.UTC(2026, 0, 1) });
  services.add(service); return service;
}

async function testSQLiteRestartAndSourceCascade() {
  if (!fs.existsSync(bin)) throw new Error(`existing native vault binary required: ${bin}`);
  let memory = createSQLiteService('sqlite-roundtrip'); await memory.init();
  const source = await memory.addMessage('user', 'SQLite dream synthetic source', { scene: 'private' });
  const records = [];
  for (let index = 1; index <= 41; index++) {
    records.push({ id: `sqlite-memory-${index}`, kind: 'memory', ts: index, domain: 'private', visibilityFloor: 2,
      value: { content: index === 1 || index === 41 ? 'SQLite exact duplicate sentinel' : `SQLite unique fact ${index}`,
        memoryKind: 'fact', status: 'confirmed', importance: 0.5, sources: [source.id] } });
  }
  await memory.write(records.slice(0, 40)); await memory.write(records.slice(40));
  const first = await createMemoryDream({ memory, maxPerPartition: 40, pageSize: 40 }).run();
  assert.equal(first.scanned, 40); assert.equal(first.more, true);
  await memory.close(); services.delete(memory);

  memory = createSQLiteService('sqlite-roundtrip'); await memory.init();
  const second = await createMemoryDream({ memory }).run();
  assert.equal(second.scanned, 1); assert.equal(second.archived, 1);
  const duplicate = (await memory.db.request('get', { ids: ['sqlite-memory-41'] })).rows[0];
  assert.equal(duplicate.state, 'archived');
  const indexRows = await memory.query('state', 200, { scene: null, domain: 'private', visibilityFloor: 2, state: 'all' });
  const index = indexRows.find(row => row.value?.job === 'memory-dream-index-v1' && row.value.canonicalId === 'sqlite-memory-1');
  assert(index, 'cross-page canonical index survived restart');
  assert.deepEqual(index.value.sources, ['sqlite-memory-1']);
  await memory.remove('sqlite-memory-1');
  assert.equal((await memory.db.request('get', { ids: [index.id] })).rows.length, 0,
    'source deletion cascades to its HMAC index row');
  await memory.close(); services.delete(memory);
}

async function main() {
  try {
    await testCrossPageAndRestart();
    await testDailyRescanFindsSameSequenceUpdate();
    await testChangedCanonicalCannotAbsorbOldKey();
    await testColdPoolBeyondTwoHundredAndProtectedRows();
    await testCancellationAndChangedSourceDoNotAdvance();
    await testSQLiteRestartAndSourceCascade();
    console.log('MemoryDream isolated and SQLite integration checks passed');
  } finally {
    await Promise.all([...services].map(service => service.close().catch(() => {})));
    fs.rmSync(temp, { recursive: true, force: true });
    testKey.fill(0);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
