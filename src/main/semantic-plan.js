'use strict';
const crypto = require('node:crypto');
const { readRecords, snapshotsOf, verifySnapshots } = require('./memory-evidence');
const { selectBoundary } = require('./semantic-boundary');
const actors = require('./message-identity');
async function planBatch(memory, { mode, scope, rows, generate, signal, force = false, afterSeq = 0, reserveModelCall, analysisContext }) {
  const generation = memory.generation, snapshots = snapshotsOf(rows);
  const id = 'semantic-plan:v1:' + crypto.createHash('sha256').update(JSON.stringify([mode, scope, afterSeq, force, snapshots, analysisContext || null])).digest('hex');
  const existing = (await readRecords(memory, [id]))[0];
  let result, allowedIds;
  if (existing?.value.result?.processedThrough === null && !force && memory.clock() - existing.updatedAt >= 10 * 60_000) return planBatch(memory, { mode, scope, rows, generate, signal, force: true, afterSeq, reserveModelCall, analysisContext });
  if (existing && existing.value.origin === 'semantic-plan-v1' && (await verifySnapshots(memory, existing.value.analysisSnapshots)).ok) { result = existing.value.result; allowedIds = existing.value.allowedIds; }
  else {
    const prepared = memory.blocks ? await memory.blocks.prepare(rows, { signal, allowLongModel: true, reserveModelCall }) : { status: 'done', units: rows.map(actors.inputRow) };
    if (prepared.status !== 'done') return prepared;
    const reserved = await reserveModelCall(signal);
    if (reserved === false || reserved?.ok === false) return { status: 'budget' };
    allowedIds = prepared.units.map(u => u.endMessageId || u.id).filter(id => rows.some(r => r.id === id && r.ingestionSeq > afterSeq));
    result = await generate(prepared.units, { signal, force, rawIds: rows.map(r => r.id), allowedThrough: allowedIds, afterSeq, analysisContext });
    if (signal?.aborted || generation !== memory.generation) return { status: 'paused' };
    if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result)) > 40000)
      throw Object.assign(new Error('整理结果不完整或过大'), { code: 'E_INVALID_MODEL_OUTPUT' });
    selectBoundary(result, rows.filter(r => r.ingestionSeq > afterSeq), { force, allowedIds });
    const committed = await memory.serial(async () => {
      if (signal?.aborted || generation !== memory.generation || !(await verifySnapshots(memory, snapshots)).ok) return false;
      await memory.write([{ id, kind: 'state', ts: 0, updatedAt: memory.clock(), ...scope,
        value: { origin: 'semantic-plan-v1', result, allowedIds, analysisSnapshots: snapshots, sources: rows.map(r => r.id) } }], memory.epoch, { notify: false });
      return true;
    });
    if (!committed) return { status: 'paused' };
  }
  return { status: 'done', result, ...selectBoundary(result, rows.filter(r => r.ingestionSeq > afterSeq), { force, allowedIds }), sourceRows: rows, cacheId: id };
}
module.exports = { planBatch };
