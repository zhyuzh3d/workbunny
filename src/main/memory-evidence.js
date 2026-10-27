'use strict';

const actors = require('./message-identity');
const crypto = require('node:crypto');
const scopes = require('./memory-scope');
const { containsSecret } = require('./conversation-input');

function stableValue(value, depth = 0) {
  if (depth > 64) throw new TypeError('invalid_evidence_record');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('invalid_evidence_record');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => stableValue(item, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('invalid_evidence_record');
  }
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = stableValue(value[key], depth + 1);
  return output;
}

function fingerprint(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id ||
      typeof record.kind !== 'string' || !Number.isSafeInteger(record.ts) ||
      !record.value || typeof record.value !== 'object' || Array.isArray(record.value)) {
    throw new TypeError('invalid_evidence_record');
  }
  const scope = scopes.scopeOf(record);
  const metadata = {
    id: record.id,
    kind: record.kind,
    ts: record.ts,
    updatedAt: record.updatedAt ?? null,
    state: record.state ?? 'active',
    expiresAt: record.expiresAt ?? null,
    domain: scope.domain,
    visibilityFloor: scope.visibilityFloor,
    ingestionSeq: record.ingestionSeq ?? null,
    value: stableValue(record.value),
  };
  return crypto.createHash('sha256').update(JSON.stringify(metadata), 'utf8').digest('hex');
}

function snapshotsOf(rows) {
  if (!Array.isArray(rows)) throw new TypeError('invalid_evidence_rows');
  const byId = new Map();
  for (const record of rows) {
    const digest = fingerprint(record);
    const existing = byId.get(record.id);
    if (existing && existing.fingerprint !== digest) throw new Error('conflicting_evidence_snapshot');
    byId.set(record.id, { id: record.id, fingerprint: digest });
  }
  return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && Buffer.byteLength(id, 'utf8') <= 256 &&
    id === id.trim() && !/[\u0000-\u001f\u007f]/u.test(id);
}

async function readRecords(memory, ids, { scene = null } = {}) {
  if (!memory?.db || typeof memory.db.request !== 'function' || typeof memory.decode !== 'function' || !Array.isArray(ids)) {
    throw new TypeError('invalid_evidence_reader');
  }
  if (!ids.every(validId)) throw new TypeError('invalid_evidence_ids');
  const unique = [...new Set(ids)], decodedById = new Map();
  for (let offset = 0; offset < unique.length; offset += 200) {
    const batch = unique.slice(offset, offset + 200);
    const result = await memory.db.request('get', { ids: batch, scene });
    for (const row of result.rows || []) decodedById.set(row.id, memory.decode(row));
  }
  return unique.flatMap(id => decodedById.has(id) ? [decodedById.get(id)] : []);
}

async function verifySnapshots(memory, snapshots, { scene = null } = {}) {
  if (!Array.isArray(snapshots)) return { ok: false, rows: [] };
  const seen = new Set();
  for (const snapshot of snapshots) {
    if (!snapshot || !validId(snapshot.id) || typeof snapshot.fingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(snapshot.fingerprint) || seen.has(snapshot.id)) return { ok: false, rows: [] };
    seen.add(snapshot.id);
  }
  const rows = await readRecords(memory, snapshots.map(item => item.id), { scene });
  if (rows.length !== snapshots.length) return { ok: false, rows };
  const current = new Map(rows.map(row => [row.id, fingerprint(row)]));
  return { ok: snapshots.every(item => current.get(item.id) === item.fingerprint), rows };
}

async function evidenceFor(memory, record, { scene = null } = {}) {
  if (!record || record.kind !== 'memory' || !record.value || typeof record.value !== 'object') return null;
  let memoryScope;
  try {
    memoryScope = scopes.scopeOf(record);
    if (scene !== null && !scopes.canRead(scene, record)) return null;
  } catch { return null; }
  const value = record.value;
  const quote = value.evidence;
  const content = value.content;
  const sources = value.sources;
  if (typeof quote !== 'string' || quote.length < 3 || quote.length > 2000 || containsSecret(quote) ||
      typeof content !== 'string' || containsSecret(content) || !Array.isArray(sources) || sources.length > 200 ||
      sources.some(source => !validId(source))) return null;

  let sourceIds;
  if (Object.hasOwn(value, 'evidenceSourceId')) {
    if (!validId(value.evidenceSourceId) || !sources.includes(value.evidenceSourceId)) return null;
    sourceIds = [value.evidenceSourceId];
  } else {
    sourceIds = [...new Set(sources)];
  }
  const rows = await readRecords(memory, sourceIds, { scene });
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const sourceId of sourceIds) {
    const source = byId.get(sourceId);
    if (!source || source.kind !== 'message') continue;
    const observation = value.memoryKind === 'observation';
    if (observation ? value.evidenceCharacter !== actors.character(source.value) : !actors.isOwner(source.value)) continue;
    let sourceScope;
    try { sourceScope = scopes.scopeOf(source); } catch { continue; }
    if (sourceScope.visibilityFloor > memoryScope.visibilityFloor) continue;
    const sourceContent = source.value?.content;
    if (typeof sourceContent !== 'string' || containsSecret(sourceContent) || !sourceContent.includes(quote)) continue;
    return { recordId: record.id, sourceId: source.id, quote, source };
  }
  return null;
}

module.exports = { fingerprint, snapshotsOf, readRecords, verifySnapshots, evidenceFor };
