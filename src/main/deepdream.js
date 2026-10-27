'use strict';
const { PARTITIONS, createSemanticDream } = require('./semantic-dream');
const { readRecords } = require('./memory-evidence');
const PLAN = 'deepdream:plan:v1', MARKS = 'deepdream:marks:v1';
const day = now => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const key = p => `${p.domain}:${p.visibilityFloor}`;
function createDeepdream({ memory, analyze, clock = Date.now } = {}) {
  const semantic = analyze ? createSemanticDream({ memory, analyze, clock }) : null;
  async function save(value, signal, generation = memory.generation) {
    return memory.serial(async () => {
      if (signal?.aborted || memory.closed || generation !== memory.generation) return false;
      await memory.write([{ id: PLAN, kind: 'state', ts: 0, updatedAt: clock(), domain: 'private', visibilityFloor: 2,
        value: { ...value, sources: [] } }], memory.epoch, { notify: false });
      return true;
    });
  }
  async function plan(signal) {
    const prior = (await readRecords(memory, [PLAN]))[0]?.value;
    const generation = memory.generation;
    if (prior && !prior.completed) return prior;
    const marks = (await readRecords(memory, [MARKS]))[0]?.value?.cutoffs || {};
    const parts = [];
    for (const partition of PARTITIONS) {
      const latest = (await memory.query('memory', 1, { scene: null, ...partition, sort: 'ingestion', order: 'desc', excludedMarkers: ['bunny_memory_merged'] }))[0]?.ingestionSeq || 0;
      parts.push({ ...partition, lower: marks[key(partition)] || 0, cutoff: latest, before: latest + 1, done: latest <= (marks[key(partition)] || 0) });
    }
    const hasNew = parts.some(p => !p.done);
    const sameDay = prior?.date === day(clock());
    if (sameDay && !hasNew) return prior;
    const sampled = sameDay ? { rows: [], count: prior.historicalCount } : await memory.db.request('memory_sample', { scene: null, now: clock(), percent: hasNew ? 10 : 5,
      excludedTokens: memory.markerTokens(['bunny_memory_merged']), partitions: parts.map(p => ({ domain: p.domain, visibilityFloor: p.visibilityFloor, cutoff: p.lower })) });
    const important = [];
    for (const partition of PARTITIONS) {
      const rows = await memory.search('bunny_pinned_memory bunny_anniversary_memory', ['memory'], 4,
        { scene: ['work', 'life', 'private'][partition.visibilityFloor], ...partition });
      if (!sameDay) important.push(...rows.filter(r => r.ingestionSeq <= (marks[key(partition)] || 0)));
    }
    const historicalIds = [...new Set([...(sampled.rows || []).map(r => r.id), ...important.slice(0, 12).map(r => r.id)])];
    const next = { origin: 'deepdream-plan-v1', date: day(clock()), parts, historicalIds, historicalCursor: 0,
      randomCount: sameDay ? prior.randomCount : sampled.rows?.length || 0, historicalCount: sampled.count || 0, percent: hasNew ? 10 : 5, completed: false };
    if (!await save(next, signal, generation)) return null;
    return next;
  }
  async function review(rows, partition, opts) {
    if (!semantic) return { status: 'done', scanned: rows.length };
    return semantic.review(rows, partition, opts);
  }
  async function run({ signal = new AbortController().signal, canRun = () => true, reserveModelCall = () => ({ ok: true }) } = {}) {
    const generation = memory.generation;
    const allowed = async () => !signal.aborted && generation === memory.generation && !memory.closed && await canRun({ mode: 'deepdream', signal });
    if (!await allowed()) return { status: 'paused' };
    let value = await plan(signal);
    if (!value) return { status: 'paused' };
    if (value.completed) return { status: 'done', scanned: 0, more: false };
    let scanned = 0;
    // One bounded page per partition: new anchors newest first; all old related
    // neighbors remain searchable. Sampling is additional, never the new-work cap.
    for (let i = 0; i < value.parts.length; i++) {
      const part = value.parts[i];
      if (part.done) continue;
      if (!await allowed()) return { status: 'paused', scanned };
      const partition = { domain: part.domain, visibilityFloor: part.visibilityFloor };
      const rows = await memory.query('memory', 20, { scene: null, ...partition, sort: 'ingestion', order: 'desc', excludedMarkers: ['bunny_memory_merged'], afterSeq: part.lower, beforeSeq: part.before });
      const result = await review(rows, partition, { signal, canRun, reserveModelCall });
      if (result.status !== 'done') return { ...result, scanned };
      if (!await allowed()) return { status: 'paused', scanned };
      const nextPart = { ...part, before: rows.at(-1)?.ingestionSeq || part.before, done: rows.length < 20 };
      value = { ...value, parts: value.parts.map((p, n) => n === i ? nextPart : p) };
      if (!await save(value, signal, generation)) return { status: 'paused', scanned };
      scanned += rows.length;
    }
    if (value.parts.some(p => !p.done)) return { status: 'done', scanned, more: true };
    // A persisted, global sample cannot grow across budget pauses or restart.
    const ids = value.historicalIds.slice(value.historicalCursor, value.historicalCursor + 20);
    if (ids.length) {
      const rows = await readRecords(memory, ids);
      for (const partition of PARTITIONS) {
        if (!await allowed()) return { status: 'paused', scanned };
        const group = rows.filter(row => row.domain === partition.domain && row.visibilityFloor === partition.visibilityFloor);
        const result = await review(group, partition, { signal, canRun, reserveModelCall });
        if (result.status !== 'done') return { ...result, scanned };
      }
      if (!await allowed()) return { status: 'paused', scanned };
      value = { ...value, historicalCursor: value.historicalCursor + ids.length };
      if (!await save(value, signal, generation)) return { status: 'paused', scanned };
      scanned += rows.length;
      if (value.historicalCursor < value.historicalIds.length) return { status: 'done', scanned, more: true };
    }
    await memory.serial(async () => {
      if (!await allowed()) return;
      await memory.write([{ id: MARKS, kind: 'state', ts: 0, updatedAt: clock(), domain: 'private', visibilityFloor: 2,
        value: { cutoffs: Object.fromEntries(value.parts.map(p => [key(p), p.cutoff])), sources: [] } },
      { id: PLAN, kind: 'state', ts: 0, updatedAt: clock(), domain: 'private', visibilityFloor: 2,
        value: { ...value, completed: true, sources: [] } }], memory.epoch, { notify: false });
    });
    let more = value.date !== day(clock());
    for (const part of value.parts) {
      const latest = await memory.query('memory', 1, { scene: null, domain: part.domain, visibilityFloor: part.visibilityFloor,
        sort: 'ingestion', order: 'desc', excludedMarkers: ['bunny_memory_merged'] });
      more ||= (latest[0]?.ingestionSeq || 0) > part.cutoff;
    }
    return { status: await allowed() ? 'done' : 'paused', scanned, more };
  }
  return { run };
}
module.exports = { createDeepdream, PLAN, MARKS };
