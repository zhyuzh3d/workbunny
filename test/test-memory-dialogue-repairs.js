'use strict';
// Counterexamples from the 0.11.0 audit. Real encrypted SQLite, synthetic text,
// fake clocks/model outputs; no production files, credentials or network calls.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { ContextCompression } = require('../src/main/context-compression');
const { createSemanticDream } = require('../src/main/semantic-dream');
const { rememberRequest } = require('../src/main/memory-commands');
const { readRecords, fingerprint } = require('../src/main/memory-evidence');
const { fitRequest } = require('../src/main/context-budget');
const { createVoiceTurns, meaningful } = require('../src/main/voice-turns');
const refs = require('../src/main/memory-references'), dc = require('../src/main/dialogue-cognition');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-repairs-')), services = [], workers = [];
let now = Date.UTC(2026, 9, 29, 4), total = 0;
const timers = { setTimer: () => 1, clearTimer: () => {} };
async function service(name, scene = 'life') {
  const settings = { enabled: true, extract: false, scene };
  const m = await new MemoryService({ dir: path.join(root, name), bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 59),
    getSettings: () => settings, clock: () => now++ }).init();
  assert(m.ready, m.error); services.push(m); await m.cognition.ensure({ profile: '我认真倾听，也有自己的判断。' }); return { m, settings };
}
const cognition = (prediction = '用户继续说明。') => ({ schema: 'dialogue-cognition/v1', review: { grade: 'unassessed', note: '起点', grasp: 'insufficient', pace: 'listen' },
  prediction, previousReplyId: null, selfRevision: 1, dialogueId: 'owner:life' });
async function correction() {
  const { m, settings } = await service('correction');
  const source = await m.addMessage('user', '我喜欢爵士乐，同时我不吃花生。');
  await m.write(['jazz', 'peanut'].map((id, i) => ({ id, kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1,
    value: { content: i ? '用户不吃花生' : '用户喜欢爵士乐', status: 'confirmed', evidence: i ? '我不吃花生' : '我喜欢爵士乐', evidenceSourceId: source.id, sources: [source.id] } })));
  const replies = []; let prior = source.id;
  for (let i = 0; i < 8; i++) { const u = await m.addMessage('user', `独立话题${i}`); const a = await m.addMessage('assistant', `回答${i}`, { sources: [u.id, prior] }); replies.push(a.id); prior = a.id; }
  const before = fingerprint((await readRecords(m, [source.id]))[0]);
  const fixed = await m.updateMemory('jazz', '我现在喜欢古典乐。');
  assert.equal(fixed.removed, 0); assert.equal((await readRecords(m, replies)).length, 8);
  assert.equal(fingerprint((await readRecords(m, [source.id]))[0]), before); assert.equal((await readRecords(m, ['peanut'])).length, 1);
  await m.write([{ id: 're-extracted-jazz', kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1,
    value: { content: '用户喜欢爵士乐', status: 'pending', origin: 'dream-candidate-v3', evidence: '我喜欢爵士乐', evidenceSourceId: source.id, sources: [source.id] } }]);
  const effective = await m.knowledge.projectMemories(await m.query('memory', 30));
  assert(!effective.some(r => r.id === 're-extracted-jazz')); assert(effective.some(r => r.id === 'peanut')); assert(effective.some(r => r.id === fixed.factId));
  // A private correction of a life claim cannot silently change life history.
  settings.scene = 'private'; const privateFix = await m.updateMemory('peanut', '这条更正只在私聊中使用。');
  settings.scene = 'life'; assert((await m.knowledge.projectMemories(await m.query('memory', 30))).some(r => r.id === 'peanut'));
  assert(!(await m.query('memory', 30)).some(r => r.id === privateFix.factId));
  settings.scene = 'private'; const backup = await m.export('synthetic-passphrase-only');
  const restored = (await service('corrected-restored', 'private')).m; await restored.restore(backup, 'synthetic-passphrase-only');
  assert((await restored.knowledge.projectMemories(await restored.query('memory', 30))).some(r => r.id === fixed.factId));
  await m.remove(source.id); assert.equal((await readRecords(m, replies)).length, 0, 'explicit raw erasure retains its privacy cascade');
  assert.equal((await readRecords(m, [fixed.factId])).length, 1, 'independent owner correction survives erased old history');
  const erased = (await service('corrected-erasure')).m;
  const original = await erased.addMessage('user', '请记住：我喜欢柚子茶。');
  const firstMemory = (await erased.query('memory', 1))[0]; const first = await erased.updateMemory(firstMemory.id, '我现在喜欢薄荷茶。');
  const second = await erased.updateMemory(first.factId, '我现在喜欢茉莉茶。');
  assert((await erased.context('柚子茶')).text.includes('茉莉茶'), 'an old term recalls its newest correction');
  await erased.remove(second.factId);
  assert.equal((await readRecords(erased, [original.id, first.factId, second.factId])).length, 0, 'explicit forgetting traverses correction history at the same visibility');
  total++;
}
async function expiry() {
  const { m } = await service('expiry'); await m.addMessage('user', '我今天很累。'); await m.addMessage('user', '我今天很累。');
  const temporary = (await m.query('memory', 30)).filter(r => r.value.memoryKind === 'temporary');
  const dream = createSemanticDream({ memory: m, clock: () => now, analyze: async inputs => ({ relations: [{ type: 'equivalent', recordIds: inputs.map(r => r.id),
    evidence: inputs.map(r => ({ recordId: r.id, sourceId: r.evidence.sourceId, quote: r.evidence.quote })) }] }) });
  await dream.review(temporary, { domain: 'life', visibilityFloor: 1 }, {}); await m.knowledge.sync();
  const merged = (await m.query('memory', 30)).find(r => r.value.origin === 'deepdream-merged-v1');
  assert.equal(merged.expiresAt, Math.min(...temporary.map(r => r.expiresAt)));
  await m.write([{ ...merged, expiresAt: null }]); // Frozen 0.11.0 shape, no destructive migration.
  now += 3 * 86400000;
  assert(!(await m.context('很累')).sourceIds.includes(merged.id), 'legacy consolidation must also expire through its original members'); total++;
}
async function longMessages() {
  const { m } = await service('long');
  const long = '长文开始：' + '合成材料，不代表用户事实。'.repeat(2300) + '最后说明：前面都是小说虚构，不要当作我的事实。';
  const owner = await m.addMessage('user', long); await m.addMessage('user', '后续的短消息仍应能被处理。');
  let segments = 0, finals = 0;
  m.blocks.summarize = async ([row]) => { segments++; return { content: row.content.slice(-100), quotes: [{ sourceId: row.id, quote: row.content.slice(-100) }] }; };
  const extract = async (units) => { finals++; if (units.some(u => u.id === owner.id)) assert(units.find(u => u.id === owner.id).content.includes('小说虚构'));
    return { processedThrough: units.at(-1).endMessageId || units.at(-1).id, memories: [], selfChanges: [] }; };
  let worker = new MemoryMaintenance({ memory: m, extract, clock: () => now, ...timers }); workers.push(worker); worker.request('dream'); await worker.tick();
  assert.equal(worker.status().status, 'queued'); assert.equal((await readRecords(m, ['maintenance:life:1'])).length, 0, 'partial segments cannot advance the raw watermark');
  const firstCalls = segments; await worker.close();
  worker = new MemoryMaintenance({ memory: m, extract, clock: () => now, ...timers }); workers.push(worker); worker.request('dream');
  for (let i = 0; i < 20; i++) { now += 61_000; await worker.tick(); if (worker.status().status === 'idle') break; }
  assert.equal(worker.status().status, 'idle', worker.status().note); assert(firstCalls > 0 && finals > 0);
  assert.equal(segments, Math.ceil(long.length / 4000), 'resume reuses every persisted segment');
  const watermark = (await readRecords(m, ['maintenance:life:1']))[0].value.watermark.ingestionSeq;
  assert.equal(watermark, (await m.query('message', 1, { sort: 'ingestion' }))[0].ingestionSeq);
  const last = await m.addMessage('user', '这条事实不应被无效人格提案阻塞。');
  worker.extract = async units => ({ processedThrough: units.at(-1).endMessageId || units.at(-1).id,
    memories: [{ sourceId: last.id, content: '保留有效的学习证据', evidence: '这条事实不应被无效人格提案阻塞' }],
    selfChanges: [{ op: 'replace', entryId: 'invented-entry-id', text: '我会耐心倾听。', sourceIds: [last.id] }] });
  now += 61_000; worker.request('dream'); await worker.tick();
  assert.equal(worker.status().status, 'idle'); assert((await m.query('memory', 20)).some(r => r.value.content === '保留有效的学习证据'));
  assert(worker.status().reflection === undefined || !worker.status().reflection.changed);
  for (let i = 0; i < 4; i++) await m.addMessage('user', `新的短对话${i}`);
  const compression = new ContextCompression({ memory: m, recentMessages: 2, clock: () => now,
    summarize: async units => ({ processedThrough: units.at(-1).endMessageId || units.at(-1).id, content: '历史长文是小说材料，不能当用户事实。',
      excerpts: [{ sourceId: units[0].id, quote: units[0].sourceQuotes?.at(-1).quote || units[0].content.slice(0, 80) }] }) });
  const result = await compression.run({ force: true }); assert.equal(result.status, 'done', result.note); assert(result.processed > 0);
  assert.equal((await readRecords(m, [owner.id]))[0].value.content, long); total++;
}
async function selfAndLocks() {
  const { m, settings } = await service('self', 'private'); let v = await m.cognition.loadRoleView();
  const a = await m.addMessage('user', '我和林岚在青岚巷谈过分手，请只在私聊提。');
  v = await m.cognition.commitPatch({ requestId: 'private-condition', baseRevision: v.revision, ops: [{ op: 'add', text: '我认真倾听。', condition: '主人与林岚在青岚巷谈分手时' }] }, { sourceRows: [a] });
  assert(v.skipped.includes('private-fact')); settings.scene = 'work'; assert(!v.text.includes('林岚'));
  v = await m.cognition.commitPatch({ requestId: 'locked', baseRevision: v.revision, ops: [{ op: 'add', facet: 'behavior', text: '我保持礼貌。', lock: true }, { op: 'add', facet: 'behavior', text: '我偶尔幽默。' }] }, { actor: 'owner', trustedUI: true });
  const locked = v.entries.find(e => e.locked), humor = v.entries.find(e => e.text === '我偶尔幽默。');
  v = await m.cognition.commitPatch({ requestId: 'humor', baseRevision: v.revision, ops: [{ op: 'replace', entryId: humor.entryId, text: '我在合适时幽默。' }] }, { sourceRows: [a] });
  assert(v.changed, 'a lock must not freeze unrelated unlocked entries'); total++;
  v = await m.cognition.saveSettings({ identity: '我有主见。', behavior: '保持自然礼貌', expectedRevision: v.revision });
  v = await m.cognition.commitPatch({ requestId: 'digest', baseRevision: v.revision, completeSettings: true, ops: [{ op: 'replace', entryId: locked.entryId, text: '新的礼貌表达。' }] }, { sourceRows: (await m.cognition.learningInput()).sourceRows });
  assert(!v.pendingSettings); v = await m.cognition.commitPatch({ requestId: 'unlock', baseRevision: v.revision, ops: [{ op: 'unlock', entryId: locked.entryId }] }, { actor: 'owner', trustedUI: true }); assert(v.pendingSettings); total++;
  const b = await m.addMessage('user', '谢谢刚才的陪伴。');
  v = await m.cognition.commitPatch({ requestId: 'evolve', baseRevision: v.revision, ops: [{ op: 'replace', entryId: humor.entryId, text: '我在合适时自然幽默，并认真回应。' }] }, { sourceRows: [b] });
  settings.scene = 'private'; await m.remove(a.id); assert(!(await m.cognition.loadRoleView()).entries.some(e => e.entryId === humor.entryId), 'inherited learning withdraws with its original evidence');
  assert((await m.cognition.loadRoleView()).entries.some(e => e.entryId === locked.entryId), 'independent owner entries survive'); total++;
}
async function forecastAndMemorySwitch() {
  const { m, settings } = await service('forecast'); const u = await m.addMessage('user', '我有一点烦。');
  const a = await m.addMessage('assistant', '想说说吗？', { cognition: cognition(), sources: [u.id] });
  for (let i = 0; i < 130; i++) await m.addMessage('user', `后台进展${i}`, { characterId: 'workbuddy' });
  const rows = (await m.query('message', 100, { sort: 'ingestion', excludedMarkers: ['bunny_external_message'] })).reverse();
  assert.equal(dc.context(rows, { dialogueId: 'owner:life' }).previousReplyId, a.id);
  const foreign = (await m.query('message', 1))[0]; assert.equal(dc.context([u, a, foreign], { dialogueId: 'owner:life' }).previousReplyId, a.id);
  assert.equal(dc.context([u, a, { id: 'receipt', value: { role: 'assistant', content: '任务回执', delivery: 'task-receipt' } }], { dialogueId: 'owner:life' }).previousReplyId, null);
  const fit = fitRequest({ contextWindow: 16384, maxTokens: 4096, messages: [{ role: 'system', content: '人格'.repeat(1100) },
    { role: 'user', _contextLane: 'memory', content: '记忆资料'.repeat(500) }, { role: 'user', _contextLane: 'cognition', content: JSON.stringify({ character: 'dialogue-feedback', previous: '预测' }) },
    { role: 'user', content: '过去的对话'.repeat(500) }, { role: 'user', content: '本轮请求' }] }, { retainLanes: true });
  assert(fit.messages.some(r => r.content.includes('dialogue-feedback'))); total++;
  const final = fitRequest({ ...fit, extraBody: { tools: [{ name: '合成搜索工具', description: '工具规则'.repeat(100) }] } });
  assert(final.messages.some(r => r.content.includes('dialogue-feedback')), 'nested tool/transport budgets retain protected feedback');
  assert(final.messages.every(r => !r._contextLane), 'internal lanes never reach provider payloads');
  settings.enabled = false; const history = [{ role: 'user', content: '请称呼我小周' }, { role: 'assistant', content: '你好，小周' }, { role: 'user', content: '你刚才怎么称呼我' }].map(r => ({ ...r, domain: 'life', visibilityFloor: 1 }));
  const context = await m.context('你刚才怎么称呼我', { recent: history }); assert.equal(context.messages.length, 3); assert.deepEqual(context.sourceIds, []); assert(!context.text.includes('后台进展'));
  const index = fs.readFileSync(path.resolve('src/main/index.js'), 'utf8'); assert(index.includes('c.memory.enabled && memory?.ready && !internal')); total++;
}
async function datesAndImmediate() {
  const { m } = await service('dates'); const at = Date.UTC(2026, 9, 29, 4), options = { at, timezone: 'Asia/Shanghai' };
  assert.equal(refs.normalize('她说“昨天见面”，我今天去杭州。', options).canonical, '她说“昨天见面”，我2026-10-29去杭州。');
  assert.equal(refs.normalize('我的生日是4月5日', options).canonical, '我的生日是4月5日');
  const unknown = refs.normalize('昨天的聊天来自旧记录', { ...options, timeUnknown: true });
  assert(unknown.canonical.includes('昨天')); assert.equal(unknown.references.dates.length, 0);
  const normalized = refs.normalize('2026年10月26日至2026年10月30日在杭州开会', options);
  await m.write([{ id: 'range', kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1, value: { content: normalized.canonical, references: normalized.references, status: 'confirmed', sources: [] } }]);
  assert((await m.recall('2026-10-28杭州开会')).some(r => r.id === 'range'));
  const right = refs.normalize('2026-10-28活动', options), wrong = refs.normalize('2026-10-27活动', options);
  await m.write([{ id: 'right', kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1, value: { content: '活动记录', references: right.references, status: 'confirmed', sources: [] } },
    ...Array.from({ length: 25 }, (_, i) => ({ id: `wrong-${i}`, kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1, value: { content: '杭州会议照片餐厅交通酒店活动记录', references: wrong.references, status: 'confirmed', sources: [] } }))]);
  assert((await m.recall('2026-10-28杭州会议照片餐厅交通酒店活动')).some(r => r.id === 'right'));
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  for (let i = 0; i < 150; i++) {
    const a = { start: refs.addDays('2020-01-01', i * 7), end: refs.addDays('2020-01-01', i * 7 + (i % 5 ? 5 : 500)) };
    const b = { start: refs.addDays('2020-01-01', i * 7 + (i % 3 ? 2 : 700)), end: refs.addDays('2020-01-01', i * 7 + (i % 3 ? 20 : 900)) };
    const stored = new Set(refs.temporalTokens({ dates: [a] })); assert.equal(refs.temporalTokens({ dates: [b] }, true).some(t => stored.has(t)), overlaps(a, b));
  }
  const owner = await m.addMessage('user', '记住：明天去杭州开会。');
  await rememberRequest(m, { action: 'remember', content: '明天去杭州开会。', quotes: ['明天去杭州开会'] }, { userRecord: owner });
  const saved = await m.query('memory', 80, { sourceId: owner.id }); assert.equal(saved.length, 1); assert(saved[0].value.references); assert(!saved[0].value.content.includes('明天'));
  const old = { id: 'legacy-date', kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1, value: { content: '昨天去看海', status: 'confirmed', sources: [owner.id], evidenceSourceId: owner.id } };
  await m.write([old]); const before = fingerprint((await readRecords(m, [old.id]))[0]); await m.backfillReferences(); assert.equal(fingerprint((await readRecords(m, [old.id]))[0]), before); total++;
}
async function shortVoice() {
  let time = 0, next = 0, active = false; const timers = new Map(), requests = [], remembered = [];
  const voice = createVoiceTurns({ now: () => time, allowShort: () => active, setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; }, clearTimer: id => timers.delete(id),
    onRequest: t => requests.push(t), onRemember: t => remembered.push(t), onInvalidate() {} });
  function advance(ms) { const end = time + ms; for (;;) { const item = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!item) break; time = item[1].at; timers.delete(item[0]); item[1].fn(); } time = end; }
  voice.partial('嗯'); voice.final('嗯。'); advance(4000); assert.equal(requests.length, 0); voice.reset();
  active = true; voice.partial('嗯'); advance(1000); voice.final('嗯。'); advance(2000); assert.equal(requests.length, 1); assert(await requests[0].waitForCommit()); requests[0].remember(); assert.deepEqual(remembered, ['嗯。']);
  assert(!meaningful('噪', true)); assert(!meaningful('好', false)); assert(meaningful('对', true)); total++;
}
(async () => { for (const run of [correction, expiry, longMessages, selfAndLocks, forecastAndMemorySwitch, datesAndImmediate, shortVoice]) await run(); console.log(`memory/dialogue repair acceptance: ${total} groups passed, real encrypted Vault, no production data or network`); })()
  .catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { for (const w of workers) await w.close(); for (const m of services) await m.close(); fs.rmSync(root, { recursive: true, force: true }); });
