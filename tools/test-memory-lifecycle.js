#!/usr/bin/env node
'use strict';
// Isolated, real encrypted SQLite. No production files, network or account calls.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { ContextCompression } = require('../src/main/context-compression');
const { rememberRequest, explicitRequest } = require('../src/main/memory-commands');
const { createDeepdream, PLAN } = require('../src/main/deepdream');
const { readRecords } = require('../src/main/memory-evidence');
const { tagged } = require('../src/main/memory-tags');
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workbunny-lifecycle-'));
const services = [];
let now = new Date(2026, 9, 28, 3, 0).getTime();
async function service(name, scene = 'life') {
  const settings = { enabled: true, extract: false, scene, recentRounds: 2 };
  const m = new MemoryService({ dir: path.join(temp, name), bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 17), getSettings: () => settings, clock: () => now++ });
  await m.init(); assert(m.ready, m.error); services.push(m);
  return { m, settings };
}
const timers = { setTimer: () => 1, clearTimer: () => {} };
function worker(m, opts = {}) { return new MemoryMaintenance({ memory: m, clock: () => now, extract: async () => ({ memories: [] }), ...timers, ...opts }); }
async function drain(w) {
  for (let i = 0; i < 100; i++) {
    await w.tick();
    if (w.status().status === 'idle') return;
    assert.equal(w.status().status, 'queued', JSON.stringify(w.status())); now += 61_000;
  }
  throw new Error('maintenance did not converge');
}
function equivalent(inputs) {
  return { relations: [{ type: 'equivalent', recordIds: inputs.map(r => r.id),
    evidence: inputs.map(r => ({ recordId: r.id, sourceId: r.evidence.sourceId, quote: r.evidence.quote })) }] };
}
async function immediate() {
  const { m, settings } = await service('commands');
  const observation = await m.addMessage('user', '我喜欢薄荷茶。');
  const observationMemory = (await m.query('memory', 20)).find(r => r.value.sources.includes(observation.id));
  assert.deepEqual(observationMemory.value.provenance, ['automatic']);
  const source = await m.addMessage('user', '周末我通常去滨江公园跑步。');
  const request = await m.addMessage('user', '把刚才那个周末习惯记下来。');
  const intent = { action: 'remember', content: '周末通常去滨江公园跑步', quotes: ['周末我通常去滨江公园跑步'] };
  const before = await m.query('state', 200);
  const result = await rememberRequest(m, intent, { userRecord: request }); assert(result.ok);
  assert((await rememberRequest(m, intent, { userRecord: request })).duplicate);
  const row = (await readRecords(m, [result.id]))[0];
  assert(row.value.tags.includes('主动记忆')); assert(row.value.sources.includes(source.id)); assert.equal(row.domain, 'life');
  assert.equal((await readRecords(m, ['maintenance:life:1'])).length, 0, 'immediate save never advances extraction watermark');
  const unrelated = await m.addMessage('user', '今天周末天气怎么样？');
  assert.equal((await rememberRequest(m, intent, { userRecord: unrelated })).ok, false);
  for (const text of ['不要记住这件事', '如果我说记住我的生日', '她说“记住这个名字”']) assert(!explicitRequest(text));
  const taught = await m.addMessage('user', '请整理经验：构建失败时先检查编译日志，再核对依赖版本。');
  const lesson = await rememberRequest(m, { action: 'learn_experience', content: '构建失败先检查编译日志，再核对依赖版本', quotes: ['构建失败时先检查编译日志'] }, { userRecord: taught });
  assert(lesson.ok);
  const list = await m.knowledge.list({ category: 'experience' }); assert(list.rows.some(r => r.id === lesson.id && r.status === 'unverified'));
  const retrieved = await m.experiences.findApplicable({ goal: '编译日志和依赖版本核对', target: 'current', scene: 'life' });
  assert(retrieved.text.includes('用户传授经验（未实测'));
  settings.scene = 'private'; await m.changeScene('private');
  const secret = await m.addMessage('user', '请记住：私聊地点是PrivateIslandNeedle。');
  settings.scene = 'life'; await m.changeScene('life');
  const publicRequest = await m.addMessage('user', '把刚才提到的地点记下来。');
  const blocked = await rememberRequest(m, { action: 'remember', content: '私聊地点是PrivateIslandNeedle', quotes: ['私聊地点是PrivateIslandNeedle'] }, { userRecord: publicRequest });
  assert.equal(blocked.ok, false); assert.equal((await m.search('PrivateIslandNeedle', ['memory', 'message'])).length, 0);
  const stale = await m.addMessage('user', '请记住：这个请求撤回。');
  await assert.rejects(rememberRequest(m, intent, { userRecord: stale, isCurrent: () => false }));
}
async function stagesAndSchedule() {
  const { m } = await service('stages');
  for (let i = 0; i < 5; i++) {
    await m.addMessage('user', `这是一段可压缩的对话，第${i}轮。`);
    await m.addMessage('assistant', `回答第${i}轮的上下文。`);
  }
  const fallback = require('../src/main/workbuddy-free').excerptFallback([{ id: 'synthetic', role: 'user', content: '这段是原文索引测试。' }]);
  assert.equal(fallback.excerpts[0].quote, '这段是原文索引测试。');
  assert(fallback.content.includes('逐字摘录'));
  let extracts = 0, summaries = 0;
  const compression = m.compression = new ContextCompression({ memory: m, recentRounds: 2, clock: () => now++, summarize: async rows => {
    summaries++; return { content: '这些对话讨论同一主题，保留原文可回查。', excerpts: [{ sourceId: rows[0].id, quote: rows[0].content }] };
  } });
  const w = worker(m, { compression, extract: async rows => { extracts++; return { memories: [{ sourceId: rows[0].id, content: '对话主题', evidence: rows[0].content, tags: ['主题'] }] }; } });
  w.request('doze'); await drain(w); assert(summaries > 0); assert.equal(extracts, 0);
  assert.equal((await readRecords(m, ['maintenance:life:1'])).length, 0);
  const version = (await compression.snapshot('life')).version;
  w.request('dream'); await drain(w); assert.equal(extracts, 1); assert.equal((await compression.snapshot('life')).version, version);
  const auto = (await m.query('memory', 50)).find(r => r.value.origin === 'dream-candidate-v3'); assert(auto.value.tags.includes('自动记忆'));
  w.request('dream'); await drain(w); assert.equal(extracts, 1, 'Dream watermark prevents replay');
  now = new Date(2026, 9, 29, 3, 59).getTime();
  await m.addMessage('user', '少量积压也要被处理。');
  assert.equal(await w.checkDue(), false);
  now = new Date(2026, 9, 29, 4, 0).getTime(); assert(await w.checkDue()); assert(w.queue.includes('dream')); assert(!w.queue.includes('deepdream'));
  await drain(w); assert.equal((await readRecords(m, ['maintenance:daily-schedule']))[0].value.dreamDate, '2026-10-29');
  now = new Date(2026, 9, 29, 5, 0).getTime(); assert(await w.checkDue()); assert(w.queue.includes('deepdream'));
  await drain(w); assert.equal(await w.checkDue(), false);
  m.maintenance = w;
  await m.addMessage('user', '前台正忙也要排入压缩，执行仍然等待空闲。');
  assert(w.queue.includes('doze'), 'foreground extract=false must not lose the compression trigger');
  await w.close();
}
async function adaptiveExtraction() {
  const { m } = await service('adaptive');
  for (let i = 0; i < 10; i++) await m.addMessage('user', `Adaptive extraction source message ${i}.`, { conversationId: String(i % 2) });
  const lengths = [];
  const w = worker(m, { extract: async rows => {
    lengths.push(rows.length);
    if (rows.length > 2) throw Object.assign(new Error('synthetic upstream timeout'), { code: 'E_UPSTREAM' });
    return { memories: [] };
  } });
  w.request('dream'); await drain(w); assert.deepEqual(lengths.slice(0, 3), [10, 5, 2]);
  const checkpoint = (await readRecords(m, ['maintenance:life:1']))[0];
  const last = (await m.query('message', 1, { sort: 'ingestion' }))[0];
  assert.equal(checkpoint.value.watermark.ingestionSeq, last.ingestionSeq);
  assert.equal((await readRecords(m, ['maintenance:extract-tuning']))[0].value.batchSize, 2);
  await w.close();
}
async function summaryFallbacks() {
  const wb = require('../src/main/workbuddy'), free = require('../src/main/workbuddy-free');
  const chat = wb.chat, request = wb.request;
  const rows = [{ id: 'source-only', role: 'user', content: '这段只用于原文降级测试。' }];
  try {
    wb.request = async () => ({ body: JSON.stringify({ models: [{ id: 'hy3', credits: 'x0' }] }) });
    wb.chat = async () => { throw Object.assign(new Error('synthetic'), { code: 'E_UPSTREAM' }); };
    assert.deepEqual((await free.summarizeContext(rows)).excerpts, [{ sourceId: 'source-only', quote: rows[0].content }]);
    wb.chat = async () => ({ text: JSON.stringify({ content: '没有引文的模型内容', excerpts: [] }) });
    const fallback = await free.summarizeContext(rows);
    assert(!fallback.content.includes('没有引文的模型内容'));
    const abort = new AbortController(); abort.abort();
    wb.chat = async () => { throw Object.assign(new Error('aborted'), { code: 'E_UPSTREAM' }); };
    await assert.rejects(free.summarizeContext(rows, { signal: abort.signal }));
  } finally { wb.chat = chat; wb.request = request; }
}
async function automaticRetry() {
  const { m } = await service('retry');
  now = new Date(2026, 9, 30, 2, 0).getTime();
  let attempts = 0;
  const w = worker(m, { compression: { run: async () => {
    if (++attempts === 1) throw Object.assign(new Error('synthetic upstream timeout'), { code: 'E_UPSTREAM' });
    return { status: 'done', processed: 0 };
  } } });
  w.request('doze', { automatic: true }); await w.tick();
  assert.equal(w.status().status, 'failed');
  assert.equal((await readRecords(m, ['maintenance:daily-schedule']))[0].value.retryMode, 'doze');
  assert.equal(await w.checkDue(), false);
  now += 31 * 60_000;
  assert(await w.checkDue()); await drain(w); assert.equal(attempts, 2);
  assert.equal((await readRecords(m, ['maintenance:daily-schedule']))[0].value.retryAfter, 0);
  await w.close();
}
async function mergeAndScopes() {
  const { m, settings } = await service('merge');
  const user = await m.addMessage('user', '请记住：我喜欢茉莉茶。');
  const active = (await m.query('memory', 20))[0];
  await m.write([{ id: 'auto-tea', kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1,
    value: tagged({ content: active.value.content, origin: 'dream-candidate-v3', status: 'pending', memoryKind: 'candidate',
      evidence: user.value.content, evidenceSourceId: user.id, sources: [user.id], tags: ['茉莉茶'] }, ['automatic']) }]);
  let calls = 0;
  const w = worker(m, { analyzeRelations: async inputs => { calls++; return equivalent(inputs); } });
  w.request('deepdream'); await drain(w);
  const deep = w.deepdream;
  await w.close();
  const all = await m.query('memory', 50), merged = all.find(r => r.value.origin === 'deepdream-merged-v1');
  assert(merged, 'equivalent creates an immutable consolidated record');
  assert((await m.list({ kind: 'memory', effective: true })).rows.filter(r => r.content === active.value.content).length === 1);
  assert(merged.value.tags.includes('主动记忆') && merged.value.tags.includes('自动记忆')); assert.equal(merged.value.status, 'confirmed');
  const projected = await m.knowledge.projectMemories(all); assert.equal(projected.filter(r => r.value.content === active.value.content).length, 1);
  const backup = await m.export('temporary-fixture-passphrase');
  const restored = (await service('merge-delete')).m;
  await restored.restore(backup, 'temporary-fixture-passphrase');
  await restored.remove(merged.id);
  assert.equal((await restored.query('memory', 50)).length, 0, 'deleting a current merged card removes its factual evidence, avoiding resurrection');
  const count = calls; await deep.run({}); assert.equal(calls, count, 'same-day no-change rerun reuses plan');
  const context = await m.context('茉莉茶'); assert(context.sourceIds.includes(merged.id));
  settings.scene = 'work'; await m.changeScene('work'); assert.equal((await m.search('茉莉茶', ['memory'])).length, 0);
  settings.scene = 'life'; await m.changeScene('life');
  await m.write([{ ...active, value: { ...active.value, content: '我现在不喝茶了。' }, updatedAt: now++ }]);
  const after = await m.knowledge.projectMemories(await m.query('memory', 50)); assert(!after.some(r => r.id === merged.id), 'changed source invalidates stale consolidation');
  await assert.rejects(m.remove(merged.id), /已变化/);
  assert((await readRecords(m, [active.id])).length, 'stale card must not delete a newer source version');
}
async function sampleAndResume() {
  const { m } = await service('sample', 'private');
  for (let batch = 0; batch < 6; batch++) {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `historic-${batch}-${i}`, kind: 'memory', ts: now++, domain: 'private', visibilityFloor: 2,
      value: { content: '历史条目', status: 'pending', sources: [] } }));
    await m.write(rows);
  }
  const latest = (await m.query('memory', 1, { sort: 'ingestion' }))[0].ingestionSeq;
  const p = { partitions: [{ domain: 'private', visibilityFloor: 2, cutoff: latest }], percent: 10, now };
  const first100 = await m.query('memory', 100, { sort: 'ingestion', order: 'asc' });
  const small = { ...p, partitions: [{ ...p.partitions[0], cutoff: first100.at(-1).ingestionSeq }] };
  assert.equal((await m.db.request('memory_sample', { ...small, percent: 5 })).rows.length, 5);
  assert.equal((await m.db.request('memory_sample', { ...small, percent: 10 })).rows.length, 10);
  const sample = await m.db.request('memory_sample', p); assert.equal(sample.count, 1200); assert.equal(sample.rows.length, 50); assert.equal(new Set(sample.rows.map(r => r.id)).size, 50);
  const life = await m.db.request('memory_sample', { ...p, scene: 'life' }); assert.equal(life.count, 0); assert.equal(life.rows.length, 0);
  await assert.rejects(m.db.request('memory_sample', { ...p, percent: 90 }));
  const deep = createDeepdream({ memory: m, clock: () => now });
  let done = false;
  for (let i = 0; i < 65; i++) { const r = await deep.run({}); if (!r.more) { done = true; break; } }
  assert(done, 'all new records drain in bounded pages');
  now += 86400000;
  const second = createDeepdream({ memory: m, clock: () => now });
  await second.run({});
  const plan1 = (await readRecords(m, [PLAN]))[0].value;
  assert.equal(plan1.percent, 5); assert.equal(plan1.randomCount, 50);
  const restarted = createDeepdream({ memory: m, clock: () => now }); await restarted.run({});
  const plan2 = (await readRecords(m, [PLAN]))[0].value; assert.deepEqual(plan2.historicalIds, plan1.historicalIds);
}
(async () => {
  try { await immediate(); await stagesAndSchedule(); await automaticRetry(); await adaptiveExtraction(); await summaryFallbacks(); await mergeAndScopes(); await sampleAndResume(); console.log('Memory lifecycle integration passed: immediate, provenance, scope, stages, schedule, merge, sampling, resume'); }
  finally { for (const m of services) await m.close(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
