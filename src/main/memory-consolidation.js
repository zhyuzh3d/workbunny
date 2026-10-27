'use strict';
const crypto = require('node:crypto');
const { readRecords, verifySnapshots, snapshotsOf } = require('./memory-evidence');
const { tagged, provenance, topics } = require('./memory-tags');
const hash = id => crypto.createHash('sha256').update(id).digest('hex');
const pointerId = id => 'memory-merge-member:v1:' + hash(id);
function createMemoryConsolidation({ memory, clock = Date.now }) {
  // Called inside knowledge.sync's serial section. The original records never
  // change: old summaries, decisions and source fingerprints stay meaningful.
  async function recordRelation(relation, members) {
    if (relation.value.relation !== 'equivalent' || members.length < 2 || members.some(r => r.value.origin === 'deepdream-merged-v1')) return null;
    const id = 'memory-merged:v1:' + hash(relation.id);
    if ((await readRecords(memory, [id])).length) return id;
    const clean = members.map(({ evidence, ...row }) => row);
    const base = [...clean].sort((a, b) => (b.value.status === 'confirmed') - (a.value.status === 'confirmed') ||
      provenance(b.value).includes('active') - provenance(a.value).includes('active') || b.ts - a.ts)[0];
    const sources = [...new Set([relation.id, ...relation.value.sources])];
    const flags = [...new Set(clean.flatMap(r => provenance(r.value)).concat('automatic'))];
    const value = tagged({ ...base.value, origin: 'deepdream-merged-v1',
      tags: clean.flatMap(r => topics(r.value.tags)), sources, memberIds: clean.map(r => r.id), relationId: relation.id,
      baseId: base.id, memberEvidenceIds: [...new Set(clean.map(r => r.value.evidenceSourceId))], analysisSnapshots: snapshotsOf([relation, ...clean]),
      evidence: base.value.evidence, evidenceSourceId: base.value.evidenceSourceId,
      protected: clean.some(r => provenance(r.value).includes('active')), mergedAt: clock() }, flags);
    await memory.write([{ id, kind: 'memory', ts: clock(), domain: relation.domain, visibilityFloor: relation.visibilityFloor, value }]);
    // Parents must already exist before a native write. A crash here only
    // leaves an immutable orphan; the next sync reuses it and repairs pointers.
    return id;
  }
  async function link(relation, members) {
    const id = await recordRelation(relation, members);
    if (!id) return null;
    const now = clock();
    const records = members.map(row => ({ id: pointerId(row.id), kind: 'state', ts: 0, updatedAt: now,
      domain: row.domain, visibilityFloor: row.visibilityFloor,
      value: { origin: 'memory-merge-member-v1', memberId: row.id, mergedId: id, sources: [id] } }));
    const existing = new Map((await readRecords(memory, records.map(r => r.id))).map(r => [r.id, r]));
    const changes = records.filter(r => existing.get(r.id)?.value.mergedId !== id);
    if (changes.length) await memory.write(changes, memory.epoch, { notify: false });
    return id;
  }
  async function valid(row, scene) {
    if (row?.kind !== 'memory' || row.value.origin !== 'deepdream-merged-v1' || !Array.isArray(row.value.memberIds) ||
        row.value.memberIds.length < 2 || row.value.memberIds.length > 6 || !Array.isArray(row.value.analysisSnapshots)) return false;
    const checked = await verifySnapshots(memory, row.value.analysisSnapshots, { scene });
    if (!checked.ok) return false;
    const relation = checked.rows.find(r => r.id === row.value.relationId), base = checked.rows.find(r => r.id === row.value.baseId);
    if (!relation || relation.value.relation !== 'equivalent' || relation.value.status !== 'proposed' || !base ||
        base.value.content !== row.value.content || base.value.status !== row.value.status ||
        checked.rows.some(r => r.domain !== row.domain || r.visibilityFloor !== row.visibilityFloor)) return false;
    const pointers = await readRecords(memory, row.value.memberIds.map(pointerId), { scene });
    return pointers.length === row.value.memberIds.length && pointers.every(p => p.domain === row.domain && p.visibilityFloor === row.visibilityFloor && p.value.mergedId === row.id);
  }
  async function project(rows, { scene = memory.scene() } = {}) {
    const pointers = await readRecords(memory, rows.map(r => pointerId(r.id)), { scene });
    const targets = await readRecords(memory, [...new Set(pointers.map(p => p.value.mergedId).filter(Boolean))], { scene });
    const byId = new Map(targets.map(r => [r.id, r])), replacements = new Map(pointers.map(p => [p.value.memberId, byId.get(p.value.mergedId)]));
    const cache = new Map(), output = new Map();
    for (const row of rows) {
      let selected = replacements.get(row.id) || row;
      if (selected.value.origin === 'deepdream-merged-v1') {
        if (!cache.has(selected.id)) cache.set(selected.id, await valid(selected, scene));
        if (!cache.get(selected.id)) {
          if (row.value.origin === 'deepdream-merged-v1') continue;
          selected = row;
        }
      }
      output.set(selected.id, { ...selected, score: Math.max(selected.score || 0, row.score || 0) });
    }
    return [...output.values()];
  }
  return { link, project, valid };
}
module.exports = { createMemoryConsolidation, pointerId };
