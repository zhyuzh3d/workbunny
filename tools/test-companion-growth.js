'use strict';
// Real encrypted Vault and filesystem receipts; all conversations/models are
// synthetic. No installed-app data, accounts, speech or external sends.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { CompanionAutonomy } = require('../src/main/companion-autonomy');
const { Secretary } = require('../src/main/secretary');
const { readRecords, fingerprint } = require('../src/main/memory-evidence');
const { createRecallSession, FIND, READ } = require('../src/main/conversation-recall');
const { chatWithSearch, TOOL_NAME } = require('../src/main/conversation-search');
const { requestReply } = require('../src/main/reply-request');
const dc = require('../src/main/dialogue-cognition');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-growth-'))), services = [], workers = [], autonomies = [];
let now = new Date(2026, 9, 29, 10).getTime();
async function service(name) {
  const settings = { scene: 'life', enabled: true, extract: false };
  const m = await new MemoryService({ dir: path.join(root, name), bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 91),
    getSettings: () => settings, clock: () => now++ }).init();
  assert(m.ready, m.error); services.push(m); await m.cognition.ensure({ profile: '我好奇，愿意尝试创作，也认真倾听。' }); return { m, settings };
}
const q = (r, quote = r.value.content) => ({ sourceId: r.id, quote });
const proposal = (r, extra = {}) => ({ op: 'add', type: 'user_model', content: '倾诉烦恼时，用户希望先听完。', condition: '表达烦恼且尚未请求建议',
  support: [q(r)], status: 'tentative', ...extra });
async function commit(m, changes, rows, suppliedView) {
  const view = suppliedView || await m.growth.view({ scene: 'life', domain: 'life', visibilityFloor: 1 }), self = await m.cognition.learningInput();
  const plan = await m.growth.prepare(changes, { rows, view, self, domain: 'life', visibilityFloor: 1 });
  if (plan.records.length) await m.cognition.commitPatch({ requestId: 'test:' + require('node:crypto').randomUUID(), baseRevision: self.revision, ops: [] },
    { sourceRows: rows, extraRecords: plan.records, validateExtra: plan.guard });
  return plan;
}
async function lifecycle() {
  const { m, settings } = await service('lifecycle');
  const a = await m.addMessage('user', '我现在只想说说，先别给建议。'), before = fingerprint((await readRecords(m, [a.id]))[0]);
  let p = await commit(m, [proposal(a, { support: [{ sourceId: a.id, quote: '没有说过的话' }] })], [a]); assert.equal(p.records.length, 0);
  p = await commit(m, [proposal(a, { status: 'stable' })], [a]); assert.equal(p.records.length, 0, 'one source does not establish a stable trait');
  await commit(m, [proposal(a)], [a]); let view = await m.growth.view(); assert.equal(view.entries.length, 1);
  const initial = view.entries[0], stored = (await readRecords(m, [initial.id]))[0];
  const b = await m.addMessage('user', '这次我是明确想一起想办法，你可以主动给建议。');
  await commit(m, [proposal(b, { op: 'replace', entryId: initial.entryId, content: '先分辨倾诉与求助；明确求助时共同推进。', status: 'recheck', support: [], counter: [q(b)] })], [b]);
  view = await m.growth.view(); assert.equal(view.entries[0].revision, 2); assert.equal(view.entries[0].support[0].sourceId, a.id); assert.equal(view.entries[0].counter[0].sourceId, b.id);
  assert.equal(fingerprint((await readRecords(m, [initial.id]))[0]), fingerprint(stored), 'old versions are immutable');
  assert.equal(fingerprint((await readRecords(m, [a.id]))[0]), before, 'raw history is immutable');
  settings.scene = 'work'; assert.equal((await m.growth.view()).entries.length, 0); settings.scene = 'life';
  settings.enabled = false; assert.equal((await m.growth.view()).entries.length, 0); settings.enabled = true;
  const saved = await m.export('synthetic-growth-passphrase'), restored = (await service('restored')).m;
  await restored.restore(saved, 'synthetic-growth-passphrase'); assert.equal((await restored.growth.view()).entries[0].revision, 2);
  await restored.remove(a.id); assert.equal((await restored.growth.view()).entries.length, 0, 'forgetting evidence withdraws every dependent revision');
  await m.growth.dismiss(initial.entryId); assert.equal((await m.growth.view()).entries.length, 0);
  p = await commit(m, [proposal(b, { content: view.entries[0].content, condition: view.entries[0].condition })], [b]); assert.equal(p.records.length, 0, 'an explicitly removed understanding does not return unchanged');
}
async function staleAndScope() {
  const { m, settings } = await service('stale'); const a = await m.addMessage('user', '我喜欢在讨论方案时先弄清目标。');
  const old = await m.growth.view({ scene: 'life', domain: 'life', visibilityFloor: 1 });
  await commit(m, [proposal(a)], [a]); await assert.rejects(commit(m, [proposal(a, { content: '另一条旧提案' })], [a], old), e => e.code === 'E_SELF_STALE');
  settings.scene = 'private'; const secret = await m.addMessage('user', '私聊才说的细节不进入生活认识。'); settings.scene = 'life';
  assert.equal((await commit(m, [proposal(secret)], [secret])).records.length, 0);
  const external = await m.addMessage('user', '外部报告说主人讨厌建议。', { characterId: 'workbuddy' });
  assert.equal((await commit(m, [proposal(external)], [external])).records.length, 0, 'external reports cannot define the user');
}
async function dreamAndGoals() {
  const { m } = await service('dream');
  const u = await m.addMessage('user', '写故事时，我愿意一起讨论人物对话。');
  const b = await m.addMessage('assistant', '我想试着写一个通过对话表现人物关系的短篇。');
  const worker = new MemoryMaintenance({ memory: m, clock: () => now, setTimer: () => 1, clearTimer() {},
    extract: async (_input, opts) => {
      assert(Array.isArray(opts.analysisContext.growth));
      return { processedThrough: b.id, memories: [], selfChanges: [{ op: 'add', facet: 'interest', text: '我想探索用人物对话创作短篇故事，逐渐形成自己的风格。', sourceIds: [u.id, b.id] }],
        growthChanges: [proposal(u), { op: 'add', type: 'pursuit', content: '尝试一个对话短篇', status: 'active', nextStep: '先写一个两人对话的开场', feeling: 'curious', support: [q(b)] }] };
    } }); workers.push(worker); worker.request('dream'); await worker.tick(); assert.equal(worker.status().status, 'idle', JSON.stringify(worker.status()));
  const view = await m.growth.view(); assert.equal(view.entries.length, 2); assert((await m.cognition.loadRoleView()).text.includes('自己的风格'));
  assert(m.affect.serialize().events.some(e => e.kind === 'curiosity'));
  const goal = view.entries.find(e => e.type === 'pursuit');
  const planned = await commit(m, [{ op: 'replace', entryId: goal.entryId, content: goal.content, status: 'done', support: [q(b)] }], [b]);
  assert.equal(planned.records.length, 0, 'Bunny merely saying something cannot complete a goal');
  const directory = path.join(root, 'creations'); fs.mkdirSync(directory);
  const reports = [], secretary = new Secretary({ memory: m, ready: () => true, epoch: () => m.generation, clock: () => now });
  let calls = 0;
  const auto = new CompanionAutonomy({ memory: m, secretary, canRun: () => true, getScene: () => 'life', clock: () => now,
    report: async r => reports.push(r), propose: async input => { calls++; assert(input.growth.includes(goal.id)); return { kind: 'create', title: '对话短篇' + calls, extension: 'md', content: '甲：你还记得吗？\n乙：记得那片海。', pursuitId: goal.id }; } }); autonomies.push(auto);
  await auto.tick(); assert.equal(calls, 0);
  await auto.save({ kind: 'create', enabled: true, scene: 'life', directory, days: 7, subject: '短篇故事' });
  await auto.tick(); assert.equal(calls, 1); assert.equal(reports.length, 1);
  now += 24 * 3600000; await auto.tick(); assert.equal(calls, 2); assert.equal(reports.length, 1, 'unanswered outreach stays quiet while creation proceeds');
  let state = (await readRecords(m, ['autonomy:budget:v1']))[0]; assert.equal(state.value.pendingTaskIds.length, 1);
  const pendingId = state.value.pendingTaskIds[0];
  await auto.ownerInput(); await auto.tick(); assert.equal(calls, 2); assert.equal(reports.length, 2, 'share queued actual work before proposing more');
  const task = (await readRecords(m, [pendingId]))[0]; assert.equal(task.value.status, 'accepted');
  await commit(m, [{ op: 'replace', entryId: goal.entryId, content: '对话短篇初稿已保存，下一步需要讨论修改。', status: 'done', support: [q(task, task.value.goal)], feeling: 'pleased' }], [task]);
  assert.equal((await m.growth.view()).entries.find(e => e.entryId === goal.entryId).status, 'done');
  await auto.save({ kind: 'create', enabled: false, scene: 'life', days: 7 }); now += 24 * 3600000; await auto.ownerInput(); await auto.tick(); assert.equal(calls, 2);
  const receipts = await m.query('message', 50); assert(receipts.some(r => r.value.taskId === pendingId && r.value.delivery === 'task-receipt'));
  const role = await m.cognition.loadRoleView(); await m.cognition.commitPatch({ requestId: 'lock', baseRevision: role.revision, ops: [{ op: 'lock_all' }] }, { actor: 'owner', trustedUI: true });
  const locked = await m.cognition.loadRoleView(); await m.cognition.commitPatch({ requestId: 'attempt', baseRevision: locked.revision, ops: [{ op: 'add', facet: 'interest', text: '我更想成为影评作者。' }] }, { sourceRows: [u, b] });
  assert.equal((await m.cognition.loadRoleView()).text, locked.text);
}
const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function recall() {
  const { m, settings } = await service('recall');
  const a = await m.addMessage('user', '2026-10-28讨论的海风方案采用蓝色封面。' + '原文细节。'.repeat(550));
  const session = createRecallSession(m, { scene: 'life' });
  await assert.rejects(session.run(READ, { id: a.id }), /invalid_memory_source/);
  let n = 0, searches = 0;
  const result = await chatWithSearch({ webSearch: true, recallSession: session, messages: [{ role: 'user', content: '海风方案上次的细节是什么？' }] }, {
    chat: async opts => {
      n++;
      if (n === 1) return { toolCalls: [tc('find', FIND, { query: '2026-10-28 海风方案' })] };
      if (n === 2) { const found = JSON.parse(opts.messages.at(-1).content); assert(found.results.some(r => r.id === a.id));
        return { toolCalls: [tc('read', READ, { id: a.id }), tc('egress', TOOL_NAME, { query: '海风方案私人细节' })] }; }
      const read = JSON.parse(opts.messages.at(-2).content); assert(read.nextOffset > 0); assert.equal(read.time, a.ts); assert(!read.content.includes('cognition'));
      return { raw: '蓝色封面。', text: '蓝色封面。' };
    }, search: async () => { searches++; return { results: [] }; },
  });
  assert.equal(searches, 0, 'local recall content never feeds a later web query'); assert(result.memoryRecall.sourceIds.includes(a.id)); assert(await session.verify());
  assert((await session.run(READ, { id: a.id, offset: 2200 })).content.length > 0);
  const snapshots = session.snapshots;
  await m.write([{ ...(await readRecords(m, [a.id]))[0], state: 'archived' }]);
  assert.equal(await session.verify(), false); await assert.rejects(m.addMessageOnce('stale-reply', 'assistant', '旧回答', { scene: 'life', sources: [a.id], evidenceSnapshots: snapshots }));
  settings.scene = 'private'; const hidden = await m.addMessage('user', 'PrivateOnlyGrowthSentinel'); settings.scene = 'life';
  const limited = createRecallSession(m, { scene: 'life' }); assert.equal((await limited.run(FIND, { query: 'PrivateOnlyGrowthSentinel' })).results.length, 0);
  await assert.rejects(limited.run(READ, { id: hidden.id }));
  settings.enabled = false; await assert.rejects(limited.run(FIND, { query: '海风方案' }), e => e.code === 'E_ABORTED'); settings.enabled = true;
  const cancelled = createRecallSession(m, { scene: 'life' }); await m.changeScene('work'); await assert.rejects(cancelled.run(FIND, { query: '海风方案' }), e => e.code === 'E_ABORTED');
}
async function prediction() {
  const result = await requestReply({ chat: async () => ({ raw: JSON.stringify({ protocol: 'dialogue-v2', stages: [
    { stage: 'review', grade: 'opposite', note: '明确求助，应共同推进。', grasp: 'adjust', pace: 'advance' },
    { stage: 'reply', reply: { kind: 'chat', text: '好，我们一起看具体卡点。' } },
    { stage: 'prediction', expect: '用户补充具体卡点。', basis: ['growth-original'] },
  ] }) }), request: { cognitive: true, messages: [{ role: 'user', content: '这次我想一起想办法。' }] } });
  assert.deepEqual(result.cognition.basis, ['growth-original']); assert(!result.raw.includes('growth-original')); assert(!result.text.includes('opposite'));
  const legacy = { ...result.cognition, previousReplyId: null, selfRevision: 1, dialogueId: 'owner:life' }; delete legacy.basis; assert(dc.stored(legacy));
}
async function datesAndPrefix() {
  const { m } = await service('dates-prefix');
  const originalTime = new Date(2026, 8, 11, 10).getTime();
  const old = await m.addMessage('user', '明天可以试写对话短篇。', { occurredAt: originalTime });
  await commit(m, [proposal(old, { type: 'pursuit', content: '明天尝试对话短篇', condition: '昨天讨论创作后', nextStep: '明天写一个开场', status: 'active', feeling: 'curious' })], [old]);
  const entry = (await m.growth.view()).entries[0];
  assert(entry.content.includes('2026-09-12')); assert(entry.nextStep.includes('2026-09-12')); assert(entry.condition.includes('2026-09-10'));
  assert.equal(entry.lastVerifiedAt, originalTime); assert(entry.reviewAfter < now, 'backfilling an old experience does not make it recently verified');
  const raw = (await readRecords(m, [entry.id]))[0]; await m.observeGrowthRecords([raw]);
  assert(!m.affect.project('life').prompt.includes('有些好奇'), 'an old experience does not generate a fresh emotion');
  const future = await m.addMessage('user', '这段话还没处理到，不能提前形成用户认识。');
  const worker = new MemoryMaintenance({ memory: m, clock: () => now, setTimer: () => 1, clearTimer() {},
    extract: async () => ({ processedThrough: old.id, memories: [{ sourceId: old.id, content: '用户提出尝试对话短篇。', evidence: old.value.content }], selfChanges: [], growthChanges: [proposal(future)] }) });
  workers.push(worker); worker.request('dream'); await worker.tick();
  assert((await m.query('memory', 20)).some(r => r.value.evidenceSourceId === old.id));
  assert(!(await m.growth.view()).entries.some(e => e.type === 'user_model'), 'a tail quote outside the committed prefix is ignored');
  assert.equal((await readRecords(m, ['maintenance:life:1']))[0].value.watermark.id, old.id);
}
async function main() { await lifecycle(); await staleAndScope(); await dreamAndGoals(); await recall(); await prediction(); await datesAndPrefix(); console.log('companion growth passed: 6 integrated groups, real Vault/restore/forget, atomic Dream/prefix, dates, goals/artifacts, quiet creation, local tools, prediction and legacy data'); }
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { for (const a of autonomies) await a.close(); for (const w of workers) await w.close(); for (const m of services) await m.close(); fs.rmSync(root, { recursive: true, force: true }); });
