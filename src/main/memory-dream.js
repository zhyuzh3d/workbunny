'use strict';

const crypto = require('node:crypto');

const PARTITIONS = Object.freeze([
  { domain: 'work', visibilityFloor: 0 }, { domain: 'work', visibilityFloor: 1 }, { domain: 'work', visibilityFloor: 2 },
  { domain: 'life', visibilityFloor: 1 }, { domain: 'life', visibilityFloor: 2 },
  { domain: 'private', visibilityFloor: 2 },
]);
const PAGE_SIZE = 40;
const MAX_PER_PARTITION = 200;
const CURSOR_PREFIX = 'dream-cursor-v1:';
const INDEX_PREFIX = 'dream-index-v1:';
const ARCHIVE_PREFIX = 'dream-archive-v1:';
const { containsSecret } = require('./conversation-input');
const SECRET = { test: containsSecret };

function keyMaterial(memory) {
  const key = memory?.key;
  if (!(Buffer.isBuffer(key) || key instanceof Uint8Array) || key.byteLength < 32) {
    throw new Error('dream_key_unavailable');
  }
  return key;
}

function keyedId(memory, namespace, value) {
  return crypto.createHmac('sha256', keyMaterial(memory))
    .update(`workbunny:${namespace}:v1\0`, 'utf8').update(value).digest('hex');
}

function partitionKey(partition) { return `${partition.domain}:${partition.visibilityFloor}`; }
function cursorId(partition) { return `${CURSOR_PREFIX}${partitionKey(partition)}`; }

function exactKey(record) {
  const value = record.value;
  // Keep comparison exact. Normalizing text here could merge distinct wording,
  // punctuation, Unicode forms, or user supplied values.
  return JSON.stringify([record.domain, record.visibilityFloor, value.memoryKind || 'fact', value.key || '', value.content]);
}

function isProtected(record) {
  const value = record?.value || {};
  return Number(value.importance) >= 0.95 || Boolean(value.protected || value.pinned || value.protection) ||
    ['anniversary', 'temporary', 'candidate'].includes(value.memoryKind) || ['user-reviewed', 'user-reviewed-conflict'].includes(value.origin);
}

function isCanonicalCandidate(record, partition) {
  if (!record || record.kind !== 'memory' || record.state !== 'active' || record.domain !== partition.domain ||
      Number(record.visibilityFloor) !== partition.visibilityFloor) return false;
  const value = record.value || {};
  return value.status === 'confirmed' && typeof value.content === 'string' && value.content.length > 0 &&
    !SECRET.test(value.content) && !isProtected(record);
}

function sameRecordSnapshot(a, b) {
  if (!a || !b) return false;
  const project = row => JSON.stringify({
    id: row.id, kind: row.kind, ts: row.ts, updatedAt: row.updatedAt, state: row.state,
    expiresAt: row.expiresAt, domain: row.domain, visibilityFloor: row.visibilityFloor,
    ingestionSeq: row.ingestionSeq, value: row.value,
  });
  return project(a) === project(b);
}
function sameOptionalSnapshot(a, b) {
  return (a === null && b === null) || sameRecordSnapshot(a, b);
}

function cursorValue(row, partition) {
  if (!row) return { job: 'memory-dream-cursor-v1', ...partition, cycle: 0, cursorSeq: 0,
    cutoffSeq: null, lastCompletedCutoff: 0, lastCompletedAt: 0, lastCompletedLocalDate: null, sources: [] };
  const value = row.value;
  if (row.kind !== 'state' || row.state !== 'active' || row.id !== cursorId(partition) || row.domain !== partition.domain ||
      Number(row.visibilityFloor) !== partition.visibilityFloor || value?.job !== 'memory-dream-cursor-v1' ||
      value.domain !== partition.domain || Number(value.visibilityFloor) !== partition.visibilityFloor ||
      !Number.isSafeInteger(value.cycle) || value.cycle < 0 || !Number.isSafeInteger(value.cursorSeq) || value.cursorSeq < 0 ||
      !(value.cutoffSeq === null || (Number.isSafeInteger(value.cutoffSeq) && value.cutoffSeq >= value.cursorSeq)) ||
      !Number.isSafeInteger(value.lastCompletedCutoff) || value.lastCompletedCutoff < 0 ||
      (value.lastCompletedAt !== undefined && (!Number.isSafeInteger(value.lastCompletedAt) || value.lastCompletedAt < 0)) ||
      (value.lastCompletedLocalDate !== undefined && value.lastCompletedLocalDate !== null &&
        (typeof value.lastCompletedLocalDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.lastCompletedLocalDate))) ||
      !Array.isArray(value.sources) || value.sources.length !== 0) throw new Error('dream_cursor_invalid');
  return { lastCompletedAt: 0, lastCompletedLocalDate: null, ...value };
}

function indexRecordId(memory, record) {
  return INDEX_PREFIX + keyedId(memory, 'memory-dream-exact', exactKey(record));
}

function createMemoryDream({ memory, clock = Date.now, maxPerPartition = MAX_PER_PARTITION, pageSize = PAGE_SIZE } = {}) {
  if (!memory || typeof memory.query !== 'function' || typeof memory.write !== 'function' ||
      typeof memory.serial !== 'function' || typeof memory.decode !== 'function' || typeof memory.db?.request !== 'function') {
    throw new TypeError('MemoryDream requires MemoryService query/write/serial/decode/db');
  }
  if (!Number.isSafeInteger(maxPerPartition) || maxPerPartition < 1 || maxPerPartition > MAX_PER_PARTITION ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) throw new RangeError('invalid_dream_budget');

  async function rawRows(ids) {
    const result = await memory.db.request('get', { ids: [...new Set(ids)] });
    return (result?.rows || []).map(row => memory.decode(row));
  }

  async function readCursor(partition) {
    const rows = await rawRows([cursorId(partition)]);
    const row = rows[0] || null;
    return { row, value: cursorValue(row, partition) };
  }

  async function latestSequence(partition) {
    const rows = await memory.query('memory', 1, { scene: null, domain: partition.domain,
      visibilityFloor: partition.visibilityFloor, state: 'active', sort: 'ingestion', order: 'desc' });
    return Number.isSafeInteger(rows[0]?.ingestionSeq) ? rows[0].ingestionSeq : 0;
  }

  function localDayKey(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('dream_clock_invalid');
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function dailyRescanDue(cursor, now) {
    // Old cursors have no calendar checkpoint. One conservative sweep upgrades
    // them; a backwards clock never moves this stored high-water date back.
    return !cursor.lastCompletedLocalDate || localDayKey(now) > cursor.lastCompletedLocalDate;
  }

  function checkpointRecord(partition, value, ts) {
    return { id: cursorId(partition), kind: 'state', ts: 0, updatedAt: ts,
      domain: partition.domain, visibilityFloor: partition.visibilityFloor,
      value: { ...value, job: 'memory-dream-cursor-v1', domain: partition.domain,
        visibilityFloor: partition.visibilityFloor, sources: [] } };
  }

  async function processPage(partition, cursorSnapshot, page, isLastPage, snapshotVersion, signal) {
    if (signal?.aborted) return { committed: false };
    const { generation, epoch } = snapshotVersion;
    if (memory.generation !== generation || memory.epoch !== epoch) return { committed: false };
    const pageSnapshot = page.map(row => ({ ...row, value: { ...row.value, sources: [...(row.value.sources || [])] } }));
    const fingerprints = new Map();
    const indexIds = [];
    const candidates = [];
    for (const row of pageSnapshot) {
      if (!isCanonicalCandidate(row, partition)) continue;
      const id = indexRecordId(memory, row);
      fingerprints.set(row.id, id); indexIds.push(id); candidates.push(row);
    }

    // At most one bounded page of index rows is read. A per-page map handles
    // repeated keys in the same page before their index rows are committed.
    const existingIndexRows = await rawRows(indexIds);
    const indexById = new Map(existingIndexRows.map(row => [row.id, row]));
    const canonicalIds = [...new Set(existingIndexRows.map(row => row.value?.canonicalId).filter(id => typeof id === 'string'))];
    const canonicalRows = await rawRows(canonicalIds);
    const canonicalById = new Map(canonicalRows.map(row => [row.id, row]));
    const localCanonical = new Map();
    const writesById = new Map();
    const now = clock();
    let archived = 0;

    for (const row of pageSnapshot) {
      if (!isCanonicalCandidate(row, partition)) continue;
      const stateId = fingerprints.get(row.id);
      let canonicalId = localCanonical.get(stateId);
      let indexRow = indexById.get(stateId);
      if (!canonicalId && indexRow) {
        const candidate = canonicalById.get(indexRow.value?.canonicalId);
        if (indexRow.kind === 'state' && indexRow.state === 'active' && indexRow.domain === partition.domain &&
            Number(indexRow.visibilityFloor) === partition.visibilityFloor &&
            indexRow.value?.job === 'memory-dream-index-v1' && candidate &&
            isCanonicalCandidate(candidate, partition) && exactKey(candidate) === exactKey(row) &&
            indexRow.value.fingerprintVersion === 1 &&
            Array.isArray(indexRow.value.sources) && indexRow.value.sources.length === 1 &&
            indexRow.value.sources[0] === indexRow.value.canonicalId) {
          canonicalId = candidate.id;
        }
      }

      if (!canonicalId) {
        canonicalId = row.id;
        localCanonical.set(stateId, canonicalId);
        const value = { job: 'memory-dream-index-v1', fingerprintVersion: 1, canonicalId, sources: [canonicalId] };
        writesById.set(stateId, { id: stateId, kind: 'state', ts: 0, updatedAt: now,
          domain: partition.domain, visibilityFloor: partition.visibilityFloor, value });
        continue;
      }

      localCanonical.set(stateId, canonicalId);
      if (row.id === canonicalId) continue;
      const archivedValue = { ...row.value, status: 'archived-duplicate', duplicateOf: canonicalId,
        archivedAt: now, dreamArchiveVersion: 1 };
      const archiveId = ARCHIVE_PREFIX + keyedId(memory, 'memory-dream-archive', row.id);
      const archivedRecord = { id: row.id, kind: 'memory', ts: row.ts, updatedAt: now, state: 'archived',
        ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}), domain: partition.domain,
        visibilityFloor: partition.visibilityFloor, searchText: row.searchText,
        value: archivedValue };
      const archiveCopy = { ...archivedRecord, id: archiveId };
      writesById.set(row.id, archivedRecord);
      writesById.set(archiveId, archiveCopy);
      archived++;
    }

    if (signal?.aborted || memory.generation !== generation) return { committed: false };
    const idsToVerify = [...new Set([...pageSnapshot.map(row => row.id), ...canonicalIds])];
    const currentRows = await rawRows(idsToVerify);
    const currentById = new Map(currentRows.map(row => [row.id, row]));
    if (pageSnapshot.some(row => !sameRecordSnapshot(row, currentById.get(row.id))) ||
        canonicalRows.some(row => !sameRecordSnapshot(row, currentById.get(row.id)))) return { committed: false };
    const currentIndexRows = await rawRows(indexIds);
    const currentIndexById = new Map(currentIndexRows.map(row => [row.id, row]));
    if (existingIndexRows.some(row => !sameRecordSnapshot(row, currentIndexById.get(row.id))) ||
        indexIds.some(id => indexById.has(id) !== currentIndexById.has(id))) return { committed: false };
    const currentCursor = await readCursor(partition);
    if (!sameOptionalSnapshot(cursorSnapshot.row, currentCursor.row)) return { committed: false };

    if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch) return { committed: false };
    const lastSeq = pageSnapshot.at(-1)?.ingestionSeq;
    if (!Number.isSafeInteger(lastSeq)) throw new Error('dream_sequence_invalid');
    const nextCursor = isLastPage
      ? { cycle: cursorSnapshot.value.cycle, cursorSeq: 0, cutoffSeq: null,
          lastCompletedCutoff: cursorSnapshot.value.cutoffSeq, lastCompletedAt: now,
          lastCompletedLocalDate: localDayKey(now), sources: [] }
      : { cycle: cursorSnapshot.value.cycle, cursorSeq: lastSeq, cutoffSeq: cursorSnapshot.value.cutoffSeq,
          lastCompletedCutoff: cursorSnapshot.value.lastCompletedCutoff, lastCompletedAt: cursorSnapshot.value.lastCompletedAt,
          lastCompletedLocalDate: cursorSnapshot.value.lastCompletedLocalDate, sources: [] };
    writesById.set(cursorId(partition), checkpointRecord(partition, nextCursor, now));
    const writes = [...writesById.values()];
    if (!writes.length) return { committed: false };
    if (writes.length > 200) throw new Error('dream_write_limit');
    await memory.write(writes, epoch);
    return { committed: true, archived };
  }

  async function finishEmptyPage(partition, cursorSnapshot, snapshotVersion, signal) {
    if (signal?.aborted) return false;
    const { generation, epoch } = snapshotVersion, now = clock();
    if (memory.generation !== generation || memory.epoch !== epoch) return false;
    if (cursorSnapshot.value.cutoffSeq === null) return true;
    const currentCursor = await readCursor(partition);
    if (!sameOptionalSnapshot(cursorSnapshot.row, currentCursor.row) ||
        signal?.aborted || memory.generation !== generation || memory.epoch !== epoch) return false;
    const next = { cycle: cursorSnapshot.value.cycle, cursorSeq: 0, cutoffSeq: null,
      lastCompletedCutoff: cursorSnapshot.value.cutoffSeq, lastCompletedAt: now,
      lastCompletedLocalDate: localDayKey(now), sources: [] };
    await memory.write([checkpointRecord(partition, next, now)], epoch);
    return true;
  }

  async function run({ signal, canRun = async () => true } = {}) {
    let scanned = 0, archived = 0, partitions = 0, more = false;
    for (const partition of PARTITIONS) {
      if (signal?.aborted || !await canRun({ mode: 'dream', partition, signal })) {
        return { status: 'paused', scanned, archived, partitions, more: true };
      }
      let partitionScanned = 0;
      while (partitionScanned < maxPerPartition) {
        const allowed = await canRun({ mode: 'dream', partition, signal });
        if (signal?.aborted || !allowed) {
          return { status: 'paused', scanned, archived, partitions, more: true };
        }
        const loaded = await memory.serial(async () => {
          const snapshotVersion = { epoch: memory.epoch, generation: memory.generation };
          const cursor = await readCursor(partition);
          let value = cursor.value;
          const latest = await latestSequence(partition);
          if (value.cutoffSeq === null) {
            const hasNewIngestion = latest > value.lastCompletedCutoff;
            const dailyDue = latest > 0 && dailyRescanDue(value, clock());
            if ((!hasNewIngestion && !dailyDue) || latest === 0) return { cursor, page: [], latest, noWork: true,
              snapshotVersion: memory.epoch === snapshotVersion.epoch && memory.generation === snapshotVersion.generation ? snapshotVersion : null };
            value = { ...value, cycle: value.cycle + 1, cursorSeq: 0, cutoffSeq: latest };
            cursor.value = value;
          }
          const take = Math.min(pageSize, maxPerPartition - partitionScanned);
          const page = await memory.query('memory', take, { scene: null, domain: partition.domain,
            visibilityFloor: partition.visibilityFloor, state: 'active', sort: 'ingestion', order: 'asc',
            afterSeq: value.cursorSeq });
          return { cursor, page: page.filter(row => row.ingestionSeq <= value.cutoffSeq), latest, noWork: false, take,
            snapshotVersion: memory.epoch === snapshotVersion.epoch && memory.generation === snapshotVersion.generation ? snapshotVersion : null };
        });

        if (!loaded.snapshotVersion) return { status: 'paused', scanned, archived, partitions, more: true };
        if (loaded.noWork) { partitions++; break; }
        const page = loaded.page;
        if (!page.length) {
          if (loaded.cursor.value.cutoffSeq !== null) {
            const done = await memory.serial(() => finishEmptyPage(partition, loaded.cursor, loaded.snapshotVersion, signal));
            if (!done) return { status: 'paused', scanned, archived, partitions, more: true };
          }
          partitions++;
          break;
        }
        const isLastPage = page.length < loaded.take;
        const outcome = await memory.serial(() => processPage(partition, loaded.cursor, page, isLastPage, loaded.snapshotVersion, signal));
        if (!outcome.committed) return { status: 'paused', scanned, archived, partitions, more: true };
        scanned += page.length; partitionScanned += page.length; archived += outcome.archived;
        if (isLastPage) { partitions++; break; }
        if (partitionScanned >= maxPerPartition) { more = true; partitions++; break; }
      }
    }
    return { status: 'done', scanned, archived, partitions, more };
  }

  return { run };
}

module.exports = { PARTITIONS, PAGE_SIZE, MAX_PER_PARTITION, createMemoryDream, isProtected, isCanonicalCandidate };
