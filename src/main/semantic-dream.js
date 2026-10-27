'use strict';

const actors = require('./message-identity');
const crypto = require('node:crypto');
const { rank } = require('./memory-scope');
const { containsSecret } = require('./conversation-input');
const { fingerprint, snapshotsOf, readRecords, verifySnapshots, evidenceFor } = require('./memory-evidence');

const PARTITIONS = Object.freeze([
  { domain: 'work', visibilityFloor: 0 }, { domain: 'work', visibilityFloor: 1 }, { domain: 'work', visibilityFloor: 2 },
  { domain: 'life', visibilityFloor: 1 }, { domain: 'life', visibilityFloor: 2 },
  { domain: 'private', visibilityFloor: 2 },
]);
const PAGE_SIZE = 40;
const MAX_PER_PARTITION = 40;
const MAX_GROUP_ITEMS = 8;
const MAX_GROUP_CHARS = 12_000;
const MAX_RELATIONS_PER_ANALYSIS = 3;
const MAX_OUTPUT_MEMBERS = 6;
const MAX_QUOTE = 220;
const ALGORITHM_VERSION = '1';
const CURSOR_PREFIX = 'semantic-dream-cursor:v1:';
const CACHE_PREFIX = 'semantic-dream-cache:v1:';
const RELATION_PREFIX = 'semantic-relation:v1:';
const RELATIONS = new Set(['equivalent', 'update', 'contextual', 'contradiction', 'uncertain']);
const FLOOR_SCENE = Object.freeze(['work', 'life', 'private']);
const TEMPORAL_CUE = /(?:以前|原来|过去|曾经|之前|后来|之后|现在|目前|如今|搬到|改为|换成|更新为|从.{1,24}到|截至|自.{1,24}起|since|until|formerly|previously|now|moved to|changed to|updated to)/iu;
const SECRET = { test: containsSecret };

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function partitionKey(partition) { return `${partition.domain}:${partition.visibilityFloor}`; }
function cursorId(partition) { return CURSOR_PREFIX + partitionKey(partition); }
function cacheId(partition, memberIds) {
  const members = [...memberIds].sort();
  // IDs are opaque; omitting key and content keeps restore idempotent.
  return CACHE_PREFIX + sha256(`${partitionKey(partition)}\n${ALGORITHM_VERSION}\n${members.join('\n')}`);
}
function sceneFor(partition) { return FLOOR_SCENE[partition.visibilityFloor]; }
function isExactPartition(row, partition) {
  return row?.domain === partition.domain && Number(row.visibilityFloor) === partition.visibilityFloor;
}

function validCursor(row, partition) {
  const value = row?.value;
  if (!row) return { cycle: 0, cursorSeq: 0, cutoffSeq: null, lastCompletedCutoff: 0,
    lastCompletedAt: 0, lastCompletedLocalDate: null };
  if (row.kind !== 'state' || row.state !== 'active' || row.id !== cursorId(partition) || !isExactPartition(row, partition) ||
      value?.origin !== 'semantic-dream-cursor-v1' || value.domain !== partition.domain ||
      Number(value.visibilityFloor) !== partition.visibilityFloor || !Number.isSafeInteger(value.cycle) || value.cycle < 0 ||
      !Number.isSafeInteger(value.cursorSeq) || value.cursorSeq < 0 ||
      !(value.cutoffSeq === null || (Number.isSafeInteger(value.cutoffSeq) && value.cutoffSeq >= value.cursorSeq)) ||
      !Number.isSafeInteger(value.lastCompletedCutoff) || value.lastCompletedCutoff < 0 ||
      !Number.isSafeInteger(value.lastCompletedAt) || value.lastCompletedAt < 0 ||
      !(value.lastCompletedLocalDate === null || (typeof value.lastCompletedLocalDate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.lastCompletedLocalDate))) ||
      !Array.isArray(value.sources) || value.sources.length !== 0) throw new Error('semantic_dream_cursor_invalid');
  return value;
}

function snapshotHash(row) { return fingerprint(row); }

function normalizedTags(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(tag => typeof tag === 'string')
    .map(tag => tag.normalize('NFKC').trim().toLowerCase()).filter(Boolean))].slice(0, 8);
}

function isEligibleMemory(record, partition) {
  if (!record || record.kind !== 'memory' || record.state !== 'active' || !isExactPartition(record, partition)) return false;
  const value = record.value || {};
  if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 4000 || SECRET.test(value.content)) return false;
  if (['archived', 'archived-duplicate', 'deleted'].includes(value.status)) return false;
  if (value.origin === 'deepdream-merged-v1') return false;
  const isPendingDoze = value.status === 'pending' && ['doze-candidate-v2', 'dream-candidate-v3', 'dream-observation-v1'].includes(value.origin);
  if (value.status !== 'confirmed' && !isPendingDoze) return false;
  if (value.status === 'pending' && !isPendingDoze) return false;
  if (['password', 'secret', 'credential', 'api-key'].includes(String(value.memoryKind || '').toLowerCase())) return false;
  return typeof value.evidenceSourceId === 'string' && typeof value.evidence === 'string' && value.evidence.length >= 3 &&
    !SECRET.test(value.evidence) && Array.isArray(value.sources) && value.sources.includes(value.evidenceSourceId);
}

function semanticNamespace(record) {
  const value = record.value || {};
  const key = typeof value.key === 'string' ? value.key.trim() : '';
  const memoryKind = value.memoryKind === 'candidate' ? 'fact' : (value.memoryKind || 'fact');
  const protectedClass = value.protected || value.protection || value.pinned || value.pinnedAt || Number(value.importance) >= 0.95;
  if (protectedClass || key === 'user.name' || key === 'user.birthday') {
    const exactProtectedKey = key || String(value.protection || memoryKind || 'protected');
    return `protected:${memoryKind}:${exactProtectedKey}`;
  }
  if (key) return `key:${memoryKind}:${key}`;
  return `tagged:${memoryKind}`;
}

function compatible(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const av = a.value || {}, bv = b.value || {};
  if ((av.memoryKind === 'observation') !== (bv.memoryKind === 'observation')) return false;
  if (av.memoryKind === 'observation' && av.evidenceCharacter !== bv.evidenceCharacter) return false;
  const ak = typeof av.key === 'string' ? av.key.trim() : '';
  const bk = typeof bv.key === 'string' ? bv.key.trim() : '';
  if (ak || bk) return !!ak && ak === bk;
  const tags = require('./memory-tags').topics;
  const aTags = new Set(tags(av.tags));
  return tags(bv.tags).some(tag => aTags.has(tag)) || av.content === bv.content || (a.score || b.score || 0) > 0;
}

function sortedUnique(rows) {
  return [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => a.ingestionSeq - b.ingestionSeq || a.id.localeCompare(b.id));
}

function localDate(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('semantic_dream_clock_invalid');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dailyDue(cursor, now) {
  return !cursor.lastCompletedLocalDate || localDate(now) > cursor.lastCompletedLocalDate;
}

function makeModelInput(memoryRow, evidence) {
  const value = memoryRow.value;
  if (!evidence || evidence.recordId !== memoryRow.id || evidence.source?.kind !== 'message' ||
      (value.memoryKind === 'observation' ? value.evidenceCharacter !== actors.character(evidence.source.value) : !actors.isOwner(evidence.source.value)) || evidence.source.visibilityFloor > memoryRow.visibilityFloor) return null;
  return { id: memoryRow.id, claimType: value.memoryKind === 'observation' ? 'observation' : 'user-statement', characterId: actors.character(evidence.source.value), content: value.content, status: value.status, memoryKind: value.memoryKind || 'fact',
    key: value.key || '', time: memoryRow.ts,
    evidence: { sourceId: evidence.sourceId, quote: evidence.quote } };
}

function strictKeys(value, allowed) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.has(key));
}

function validateCitationList(items, inputById, memberIds, evidenceByRecord, { requireEach = false, temporal = false } = {}) {
  if (!Array.isArray(items) || items.length < (requireEach ? memberIds.length : 1) || items.length > 18) return null;
  const normalized = [];
  for (const item of items) {
    if (!strictKeys(item, new Set(['recordId', 'sourceId', 'quote'])) || !memberIds.includes(item.recordId) ||
        typeof item.sourceId !== 'string' || typeof item.quote !== 'string' || item.quote.length < 3 || item.quote.length > MAX_QUOTE) return null;
    const input = inputById.get(item.recordId);
    if (!input || input.evidence.sourceId !== item.sourceId) return null;
    const evidenceRecord = evidenceByRecord.get(item.recordId);
    if (!evidenceRecord || evidenceRecord.kind !== 'message' || (input.claimType === 'observation' ? input.characterId !== actors.character(evidenceRecord.value) : !actors.isOwner(evidenceRecord.value)) ||
        !evidenceRecord.value.content.includes(item.quote) || SECRET.test(item.quote)) return null;
    if (temporal && !TEMPORAL_CUE.test(item.quote)) return null;
    normalized.push({ recordId: item.recordId, sourceId: item.sourceId, quote: item.quote });
  }
  if (requireEach && memberIds.some(id => !normalized.some(item => item.recordId === id))) return null;
  return normalized;
}

function makeContent(type, evidence, inputById) {
  const label = { equivalent: '相近原述', update: '有时间变化的原述', contextual: '带条件的原述',
    contradiction: '可能不一致的原述', uncertain: '尚待核对的原述' }[type];
  const seen = new Set();
  const lines = [];
  for (const item of evidence) {
    if (seen.has(item.recordId)) continue;
    seen.add(item.recordId);
    const input = inputById.get(item.recordId);
    lines.push(`${label}（${input.status}）：${item.quote}`);
  }
  return lines.join('\n');
}

function validateAnalysis(result, inputs, evidenceByRecord) {
  if (!strictKeys(result, new Set(['relations'])) || !Array.isArray(result.relations) || result.relations.length > MAX_RELATIONS_PER_ANALYSIS)
    return null;
  const inputById = new Map(inputs.map(input => [input.id, input]));
  const normalized = [];
  const seenRelations = new Set();
  for (const relation of result.relations) {
    if (!strictKeys(relation, new Set(['type', 'recordIds', 'evidence', 'conditions', 'temporal',
      'conditionStatus', 'temporalStatus'])) ||
        !RELATIONS.has(relation.type) || !Array.isArray(relation.recordIds) || relation.recordIds.length < 2 ||
        relation.recordIds.length > MAX_OUTPUT_MEMBERS || new Set(relation.recordIds).size !== relation.recordIds.length ||
        relation.recordIds.some(id => !inputById.has(id))) return null;
    const memberIds = [...relation.recordIds];
    const observations = memberIds.filter(id => inputById.get(id).claimType === 'observation');
    if (observations.length && observations.length !== memberIds.length) return null;
    if (observations.length && !['equivalent', 'contextual'].includes(relation.type)) continue;
    const relationKey = `${relation.type}\n${[...memberIds].sort().join('\n')}`;
    if (seenRelations.has(relationKey)) return null;
    seenRelations.add(relationKey);
    const evidence = validateCitationList(relation.evidence, inputById, memberIds, evidenceByRecord, { requireEach: true });
    if (!evidence) return null;
    let conditions = [];
    let temporal = [];
    let conditionStatus = null, temporalStatus = null;
    if (relation.type === 'contradiction') {
      if (!['supported', 'not_stated'].includes(relation.conditionStatus) ||
          !['supported', 'not_stated'].includes(relation.temporalStatus)) return null;
      conditionStatus = relation.conditionStatus;
      temporalStatus = relation.temporalStatus;
      if (conditionStatus === 'supported') {
        conditions = validateCitationList(relation.conditions, inputById, memberIds, evidenceByRecord, { requireEach: true });
        if (!conditions) return null;
      } else if (relation.conditions !== undefined && (!Array.isArray(relation.conditions) || relation.conditions.length !== 0)) return null;
      if (temporalStatus === 'supported') {
        temporal = validateCitationList(relation.temporal, inputById, memberIds, evidenceByRecord,
          { requireEach: true, temporal: true });
        if (!temporal) return null;
      } else if (relation.temporal !== undefined && (!Array.isArray(relation.temporal) || relation.temporal.length !== 0)) return null;
    } else if (relation.type === 'contextual') {
      conditions = validateCitationList(relation.conditions, inputById, memberIds, evidenceByRecord, { requireEach: true });
      if (!conditions) return null;
    } else if (relation.conditions !== undefined) {
      conditions = validateCitationList(relation.conditions, inputById, memberIds, evidenceByRecord);
      if (!conditions) return null;
    }
    if (relation.type === 'update' || relation.type === 'contradiction') {
      if (relation.type === 'update') {
        temporal = validateCitationList(relation.temporal, inputById, memberIds, evidenceByRecord,
          { requireEach: true, temporal: true });
        if (!temporal) return null;
      }
    } else if (relation.temporal !== undefined) {
      temporal = validateCitationList(relation.temporal, inputById, memberIds, evidenceByRecord);
      if (!temporal) return null;
    }
    if (relation.type !== 'contradiction' && (relation.conditionStatus !== undefined || relation.temporalStatus !== undefined)) return null;
    const members = memberIds.map(id => {
      const input = inputById.get(id);
      return { id, status: input.status, memoryKind: input.memoryKind };
    });
    normalized.push({ type: relation.type, recordIds: memberIds, members, evidence, conditions, temporal,
      ...(relation.type === 'contradiction' ? { conditionStatus, temporalStatus } : {}),
      content: makeContent(relation.type, evidence, inputById) });
  }
  return normalized;
}

function makeAnalysisInput(memoryRow, evidenceRow) {
  const input = makeModelInput(memoryRow, evidenceRow);
  if (!input) return null;
  return input;
}

function fitsBudget(inputs) { return Buffer.byteLength(JSON.stringify(inputs), 'utf8') <= MAX_GROUP_CHARS; }

function createSemanticDream({ memory, analyze, clock = Date.now, pageSize = PAGE_SIZE, maxPerPartition = MAX_PER_PARTITION } = {}) {
  if (!memory || typeof memory.query !== 'function' || typeof memory.search !== 'function' ||
      typeof memory.write !== 'function' || typeof memory.serial !== 'function' || typeof memory.decode !== 'function' ||
      typeof memory.db?.request !== 'function') throw new TypeError('SemanticDream requires MemoryService query/search/write/serial/decode/db');
  if (typeof analyze !== 'function') throw new TypeError('SemanticDream requires an analyze function');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE ||
      !Number.isSafeInteger(maxPerPartition) || maxPerPartition < 1 || maxPerPartition > MAX_PER_PARTITION)
    throw new RangeError('invalid_semantic_dream_budget');

  async function getDecoded(ids, partition) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const decoded = await readRecords(memory, unique, { scene: sceneFor(partition) });
    if (decoded.length !== unique.length || new Set(decoded.map(row => row.id)).size !== unique.length ||
        unique.some(id => !decoded.some(row => row.id === id))) return null;
    if (decoded.some(row => row.visibilityFloor > rank(sceneFor(partition)))) return null;
    return decoded;
  }

  async function getCursor(partition) {
    const raw = await memory.db.request('get', { ids: [cursorId(partition)] });
    if (!raw?.rows?.length) return { row: null, value: validCursor(null, partition) };
    const row = memory.decode(raw.rows[0]);
    if (!isExactPartition(row, partition)) throw new Error('semantic_dream_cursor_scope_invalid');
    return { row, value: validCursor(row, partition) };
  }

  async function latestSequence(partition) {
    const rows = await memory.query('memory', 1, { scene: null, domain: partition.domain,
      visibilityFloor: partition.visibilityFloor, state: 'active', sort: 'ingestion', order: 'desc' });
    return Number.isSafeInteger(rows[0]?.ingestionSeq) ? rows[0].ingestionSeq : 0;
  }

  async function readPage(partition, signal) {
    return memory.serial(async () => {
      if (signal?.aborted || memory.closed) return { aborted: true };
      const epoch = memory.epoch, generation = memory.generation;
      const cursor = await getCursor(partition);
      let value = cursor.value;
      const latest = await latestSequence(partition);
      const isCold = value.cutoffSeq === null && latest > 0 && latest <= value.lastCompletedCutoff && dailyDue(value, clock());
      if (value.cutoffSeq === null) {
        if (!latest || (latest <= value.lastCompletedCutoff && !isCold)) return { noWork: true, cursor, epoch, generation };
        value = { ...value, cycle: value.cycle + 1,
          cursorSeq: isCold ? 0 : value.lastCompletedCutoff, cutoffSeq: latest };
      }
      const take = Math.min(pageSize, maxPerPartition);
      const page = await memory.query('memory', take, { scene: null, domain: partition.domain,
        visibilityFloor: partition.visibilityFloor, state: 'active', sort: 'ingestion', order: 'asc',
        afterSeq: value.cursorSeq, beforeSeq: value.cutoffSeq + 1 });
      if (memory.epoch !== epoch || memory.generation !== generation) return { stale: true };
      return { page, cursor, value, take, epoch, generation, lastSeq: page.at(-1)?.ingestionSeq || value.cursorSeq,
        isLast: page.length < take || (page.length > 0 && page.at(-1).ingestionSeq >= value.cutoffSeq), cutoffSeq: value.cutoffSeq };
    });
  }

  async function loadEvidence(row, partition) {
    if (!isEligibleMemory(row, partition)) return null;
    const evidence = await evidenceFor(memory, row, { scene: sceneFor(partition) });
    if (!evidence) return null;
    const input = makeAnalysisInput(row, evidence);
    if (!input) return null;
    return { row, source: evidence.source, input };
  }

  async function neighborRows(anchor, partition, cutoffSeq) {
    const value = anchor.value || {};
    const queryText = typeof value.key === 'string' && value.key.trim() ? value.key.trim()
      : require('./memory-tags').topics(value.tags).slice(0, 3).join(' ') || value.content.slice(0, 180);
    if (!queryText) return [];
    const found = await memory.search(queryText, ['memory'], 12, { scene: sceneFor(partition),
      domain: partition.domain, visibilityFloor: partition.visibilityFloor });
    return found.filter(row => row.ingestionSeq <= cutoffSeq && isEligibleMemory(row, partition) && compatible(anchor, row))
      .sort((a, b) => (b.score || 0) - (a.score || 0) || a.ingestionSeq - b.ingestionSeq)
      .slice(0, MAX_GROUP_ITEMS - 1);
  }

  async function makeGroup(anchor, neighbors, partition) {
    const rows = sortedUnique([anchor, ...neighbors]).slice(0, MAX_GROUP_ITEMS);
    if (rows.length < 2) return null;
    const loaded = [];
    for (const row of rows) {
      const item = await loadEvidence(row, partition);
      if (item) loaded.push(item);
    }
    if (loaded.length < 2) return null;
    const inputs = loaded.map(item => item.input);
    while (inputs.length && !fitsBudget(inputs)) { inputs.pop(); loaded.pop(); }
    if (loaded.length < 2) return null;
    const inputIds = loaded.map(item => item.row.id);
    const directIds = loaded.map(item => item.source.id);
    const snapshots = snapshotsOf([...loaded.map(item => item.row), ...loaded.map(item => item.source)]);
    const sources = [...new Set([...inputIds, ...directIds])].sort();
    const snapshotKey = stableStringify(snapshots);
    const inputHash = sha256(snapshotKey);
    const groupId = cacheId(partition, inputIds);
    return { rows: loaded.map(item => item.row), evidenceRows: new Map(loaded.map(item => [item.row.id, item.source])),
      inputs, inputIds, sources, snapshots, inputHash, groupId };
  }

  async function readExistingCache(group, partition) {
    const rows = await getDecoded([group.groupId], partition);
    if (!rows) {
      const any = await memory.db.request('get', { ids: [group.groupId] });
      return any?.rows?.length ? { invalid: true } : { invalid: false, exists: false };
    }
    const row = rows[0];
    const value = row.value || {};
    if (row.kind !== 'state' || !isExactPartition(row, partition) || value.origin !== 'semantic-analysis-cache-v1' ||
        value.domain !== partition.domain || Number(value.visibilityFloor) !== partition.visibilityFloor ||
        value.algorithmVersion !== ALGORITHM_VERSION || stableStringify(value.memberIds) !== stableStringify([...group.inputIds].sort()) ||
        !Array.isArray(value.analysisSnapshots) || !Array.isArray(value.sources) || !Array.isArray(value.relationIds) ||
        value.relationIds.length > MAX_RELATIONS_PER_ANALYSIS || value.relationIds.some(id => typeof id !== 'string')) return { invalid: true };
    const matches = value.inputHash === group.inputHash &&
      stableStringify(value.analysisSnapshots) === stableStringify(group.snapshots) &&
      stableStringify(value.sources) === stableStringify(group.sources);
    return matches ? { invalid: false, exists: true, row } : { invalid: false, exists: false, prior: row };
  }

  function buildRelationRecords(group, partition, relations, now) {
    const rows = [];
    for (const relation of relations) {
      const id = RELATION_PREFIX + crypto.randomUUID();
      rows.push({ id, kind: 'state', ts: now, updatedAt: now, domain: partition.domain,
        visibilityFloor: partition.visibilityFloor,
        value: { origin: 'semantic-relation-v1', relation: relation.type, status: 'proposed',
          partition: { ...partition }, memberIds: relation.recordIds,
          members: relation.members, evidence: relation.evidence, conditions: relation.conditions,
          temporal: relation.temporal, conditionStatus: relation.conditionStatus, temporalStatus: relation.temporalStatus,
          analysisSnapshots: group.snapshots, content: relation.content, sources: group.sources } });
    }
    const cache = { id: group.groupId, kind: 'state', ts: now, updatedAt: now, domain: partition.domain,
      visibilityFloor: partition.visibilityFloor,
      value: { origin: 'semantic-analysis-cache-v1', domain: partition.domain,
        visibilityFloor: partition.visibilityFloor, algorithmVersion: ALGORITHM_VERSION,
        memberIds: [...group.inputIds].sort(), inputHash: group.inputHash,
        analysisSnapshots: group.snapshots, relationIds: rows.map(row => row.id), sources: group.sources } };
    return [...rows, cache];
  }

  async function supersedePriorRelations(priorCache, partition, now, replacements) {
    if (!priorCache) return [];
    const ids = priorCache.value.relationIds;
    if (!ids.length) return [];
    const raw = await memory.db.request('get', { ids, scene: sceneFor(partition) });
    const existing = new Map((raw?.rows || []).map(row => [row.id, memory.decode(row)]));
    const updates = [];
    for (const id of ids) {
      const row = existing.get(id);
      if (!row) {
        const any = await memory.db.request('get', { ids: [id] });
        if (any?.rows?.length) throw new Error('semantic_dream_prior_relation_invalid');
        continue;
      }
      if (row.kind !== 'state' || !isExactPartition(row, partition) || row.value?.origin !== 'semantic-relation-v1' ||
          !Array.isArray(row.value.memberIds) || !Array.isArray(row.value.sources)) throw new Error('semantic_dream_prior_relation_invalid');
      if (row.value.status === 'superseded') continue;
      if (row.value.status !== 'proposed') throw new Error('semantic_dream_prior_relation_invalid');
      updates.push({ ...row, updatedAt: now, value: { ...row.value, status: 'superseded',
        supersededAt: now, supersededBy: replacements } });
    }
    return updates;
  }

  async function processPage(partition, loaded, signal, canRun, reserveModelCall, commitCursor = true) {
    const { page, cursor, value, generation, isLast, cutoffSeq } = loaded;
    let epoch = loaded.epoch;
    const groupKeys = new Set();
    let analyzed = 0, relationCount = 0;
    for (const anchor of page) {
      if (!isEligibleMemory(anchor, partition)) continue;
      if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch) return { status: 'paused', analyzed, relations: relationCount };
      if (!await canRun({ mode: 'dream', partition, signal })) return { status: 'paused', analyzed, relations: relationCount };
      const neighbors = await neighborRows(anchor, partition, cutoffSeq);
      if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch) return { status: 'paused', analyzed, relations: relationCount };
      const group = await makeGroup(anchor, neighbors, partition);
      if (!group) continue;
      if (groupKeys.has(group.inputHash)) continue;
      groupKeys.add(group.inputHash);
      const cache = await readExistingCache(group, partition);
      if (cache.invalid) return { status: 'paused', analyzed, relations: relationCount };
      if (cache.exists) continue;
      const reserved = await reserveModelCall(signal);
      if (reserved === false || reserved?.ok === false) return { status: 'budget', analyzed, relations: relationCount };
      // The durable shared budget reservation is itself a vault write.
      // Rebase the epoch; exact source snapshots are revalidated at commit.
      epoch = memory.epoch;
      const raw = await analyze(group.inputs, { signal, partition: { ...partition } });
      if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch) return { status: 'paused', analyzed, relations: relationCount };
      const relations = validateAnalysis(raw, group.inputs, group.evidenceRows);
      if (!relations) throw Object.assign(new Error('Semantic relation output failed strict validation'), { code: 'E_INVALID_MODEL_OUTPUT' });
      const built = buildRelationRecords(group, partition, relations, clock());
      let superseded;
      try { superseded = await supersedePriorRelations(cache.prior, partition, clock(),
        built.filter(row => row.value?.origin === 'semantic-relation-v1').map(row => row.id)); }
      catch { return { status: 'paused', analyzed, relations: relationCount }; }
      const writes = [...superseded, ...built];
      if (writes.length > 200) return { status: 'paused', analyzed, relations: relationCount };
      const committedGroup = await memory.serial(async () => {
        if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch || memory.closed) return false;
        const verified = await verifySnapshots(memory, group.snapshots, { scene: sceneFor(partition) });
        if (!verified.ok) return false;
        const cursorNow = await getCursor(partition);
        if ((cursor.row && (!cursorNow.row || snapshotHash(cursorNow.row) !== snapshotHash(cursor.row))) ||
            (!cursor.row && cursorNow.row)) return false;
        if (cache.prior) {
          const currentCache = await getDecoded([group.groupId], partition);
          if (!currentCache?.[0] || snapshotHash(currentCache[0]) !== snapshotHash(cache.prior)) return false;
        }
        if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch) return false;
        await memory.write(writes, epoch);
        return true;
      });
      if (!committedGroup) return { status: 'paused', analyzed, relations: relationCount };
      epoch = memory.epoch;
      analyzed++;
      relationCount += relations.length;
    }
    if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch) return { status: 'paused', analyzed, relations: relationCount };
    if (!commitCursor) return { status: 'done', scanned: page.length, analyzed, relations: relationCount, more: false };
    const nextCursor = isLast
      ? { cycle: value.cycle, cursorSeq: 0, cutoffSeq: null, lastCompletedCutoff: cutoffSeq,
          lastCompletedAt: clock(), lastCompletedLocalDate: localDate(clock()), sources: [] }
      : { cycle: value.cycle, cursorSeq: loaded.lastSeq, cutoffSeq,
          lastCompletedCutoff: cursor.value.lastCompletedCutoff, lastCompletedAt: cursor.value.lastCompletedAt,
          lastCompletedLocalDate: cursor.value.lastCompletedLocalDate, sources: [] };
    const cursorRecord = { id: cursorId(partition), kind: 'state', ts: 0, updatedAt: clock(),
      domain: partition.domain, visibilityFloor: partition.visibilityFloor,
      value: { origin: 'semantic-dream-cursor-v1', domain: partition.domain,
        visibilityFloor: partition.visibilityFloor, ...nextCursor } };
    const committed = await memory.serial(async () => {
      if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch || memory.closed) return false;
      const currentSnapshots = page.length ? await getDecoded(page.map(row => row.id), partition) : [];
      if (!currentSnapshots || currentSnapshots.length !== page.length || page.some(row => {
        const current = currentSnapshots.find(item => item.id === row.id);
        return !current || snapshotHash(current) !== snapshotHash(row);
      })) return false;
      const cursorNow = await getCursor(partition);
      if ((cursor.row && (!cursorNow.row || snapshotHash(cursorNow.row) !== snapshotHash(cursor.row))) ||
          (!cursor.row && cursorNow.row)) return false;
      if (signal?.aborted || memory.generation !== generation || memory.epoch !== epoch) return false;
      await memory.write([cursorRecord], epoch, { notify: false });
      return true;
    });
    if (!committed) return { status: 'paused', analyzed, relations: relationCount };
    return { status: 'done', scanned: page.length, analyzed, relations: relationCount, more: !isLast };
  }

  async function run({ signal = new AbortController().signal, canRun = async () => true,
    reserveModelCall = async () => ({ ok: true }) } = {}) {
    let scanned = 0, analyzed = 0, relations = 0, more = false;
    for (const partition of PARTITIONS) {
      if (signal.aborted || !await canRun({ mode: 'dream', partition, signal }))
        return { status: 'paused', scanned, analyzed, relations, more: true };
      const loaded = await readPage(partition, signal);
      if (loaded.aborted || loaded.stale) return { status: 'paused', scanned, analyzed, relations, more: true };
      if (loaded.noWork) continue;
      if (!loaded.page.length) {
        const empty = { ...loaded, page: [], lastSeq: loaded.value.cursorSeq, isLast: true };
        const outcome = await processPage(partition, empty, signal, canRun, reserveModelCall);
        analyzed += outcome.analyzed || 0; relations += outcome.relations || 0;
        if (outcome.status !== 'done') return { status: outcome.status, scanned, analyzed, relations, more: true };
        continue;
      }
      const outcome = await processPage(partition, loaded, signal, canRun, reserveModelCall);
      analyzed += outcome.analyzed || 0; relations += outcome.relations || 0;
      if (outcome.status !== 'done') return { status: outcome.status, scanned, analyzed, relations, more: true };
      scanned += outcome.scanned; more ||= outcome.more;
    }
    return { status: 'done', scanned, analyzed, relations, more };
  }

  async function review(rows, partition, { signal = new AbortController().signal, canRun = async () => true,
    reserveModelCall = async () => ({ ok: true }) } = {}) {
    if (!PARTITIONS.some(p => p.domain === partition.domain && p.visibilityFloor === partition.visibilityFloor) ||
        !Array.isArray(rows) || rows.length > PAGE_SIZE || rows.some(row => !isExactPartition(row, partition))) throw new Error('invalid_review_scope');
    const cursor = await getCursor(partition);
    const latest = await latestSequence(partition);
    return processPage(partition, { page: rows, cursor, value: cursor.value, generation: memory.generation,
      epoch: memory.epoch, cutoffSeq: latest, isLast: true }, signal, canRun, reserveModelCall, false);
  }
  return { run, review };
}

module.exports = { PARTITIONS, PAGE_SIZE, MAX_PER_PARTITION, MAX_GROUP_ITEMS, MAX_GROUP_CHARS,
  createSemanticDream, validateAnalysis, isEligibleMemory, semanticNamespace };
