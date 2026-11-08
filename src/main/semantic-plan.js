'use strict';
const crypto = require('node:crypto');
const { readRecords, snapshotsOf, verifySnapshots } = require('./memory-evidence');
const { selectBoundary } = require('./semantic-boundary');
const actors = require('./message-identity');
async function planBatch(memory, { mode, scope, rows, generate, signal, force = false, afterSeq = 0, reserveModelCall, analysisContext, validateResult }) {
  const generation = memory.generation, snapshots = snapshotsOf(rows);
  const id = 'semantic-plan:v1:' + crypto.createHash('sha256').update(JSON.stringify([mode, scope, afterSeq, force, snapshots, analysisContext || null])).digest('hex');
  const existing = (await readRecords(memory, [id]))[0];
  let result, allowedIds, boundary, reusable = false;
  const current = () => !signal?.aborted && generation === memory.generation;
  const validate = async (candidate, allowed) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Buffer.byteLength(JSON.stringify(candidate)) > 40000)
      throw Object.assign(new Error('整理结果不完整或过大'), { code: 'E_INVALID_MODEL_OUTPUT' });
    const selected = selectBoundary(candidate, rows.filter(r => r.ingestionSeq > afterSeq), { force, allowedIds: allowed });
    if (validateResult) await validateResult(candidate, { ...selected, sourceRows: rows });
    return selected;
  };
  if (existing?.value?.result?.processedThrough === null && !force && memory.clock() - existing.updatedAt >= 10 * 60_000) return planBatch(memory, { mode, scope, rows, generate, signal, force: true, afterSeq, reserveModelCall, analysisContext, validateResult });
  if (existing?.value?.origin === 'semantic-plan-v1' && (await verifySnapshots(memory, existing.value.analysisSnapshots)).ok) {
    // Old plans may have been saved before their consumer checked the result.
    // Reject them locally; never delete source records or advance a watermark.
    try { boundary = await validate(existing.value.result, existing.value.allowedIds); reusable = true; }
    catch { if (!current()) return { status: 'paused' }; }
    if (reusable) {
      const verified = await verifySnapshots(memory, existing.value.analysisSnapshots);
      if (!current() || !verified.ok) return { status: 'paused' };
      result = existing.value.result; allowedIds = existing.value.allowedIds;
    }
  }
  if (!reusable) {
    const prepared = memory.blocks ? await memory.blocks.prepare(rows, { signal, allowLongModel: true, reserveModelCall }) : { status: 'done', units: rows.map(actors.inputRow) };
    if (prepared.status !== 'done') return prepared;
    const reserved = await reserveModelCall(signal);
    if (reserved === false || reserved?.ok === false) return { status: 'budget' };
    allowedIds = prepared.units.map(u => u.endMessageId || u.id).filter(id => rows.some(r => r.id === id && r.ingestionSeq > afterSeq));
    result = await generate(prepared.units, { signal, force, rawIds: rows.map(r => r.id), allowedThrough: allowedIds, afterSeq, analysisContext });
    if (!current()) return { status: 'paused' };
    boundary = await validate(result, allowedIds);
    if (!current()) return { status: 'paused' };
    const committed = await memory.serial(async () => {
      if (signal?.aborted || generation !== memory.generation || !(await verifySnapshots(memory, snapshots)).ok) return false;
      await memory.write([{ id, kind: 'state', ts: 0, updatedAt: memory.clock(), ...scope,
        value: { origin: 'semantic-plan-v1', result, allowedIds, analysisSnapshots: snapshots, sources: rows.map(r => r.id) } }], memory.epoch, { notify: false });
      return true;
    });
    if (!committed) return { status: 'paused' };
  }
  return { status: 'done', result, ...boundary, sourceRows: rows, cacheId: id };
}
module.exports = { planBatch };
