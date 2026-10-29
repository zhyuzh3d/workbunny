'use strict';
// Explicit opt-in. Confirmed zero-credit model, synthetic data, disposable
// encrypted Vault and local artifacts only; never opens the production Vault.
if (!process.argv.includes('--live')) { console.log('Use --live for isolated synthetic growth/model acceptance.'); process.exit(0); }
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const config = require('../src/main/config'), free = require('../src/main/workbuddy-free'), wb = require('../src/main/workbuddy');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { requestReply } = require('../src/main/reply-request');
const { chatWithSearch } = require('../src/main/conversation-search');
const { createRecallSession } = require('../src/main/conversation-recall');
const dc = require('../src/main/dialogue-cognition');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-growth-live-')));
let m, worker;
async function main() {
  config.setPath(path.join(root, 'config.json'));
  const model = await free.freeModel(), started = Date.now();
  m = await new MemoryService({ dir: path.join(root, 'vault'), bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 92), getSettings: () => ({ enabled: true, extract: false, scene: 'life' }) }).init();
  await m.cognition.ensure({ profile: '我好奇，愿意探索人物故事，也认真倾听。' });
  await m.addMessage('user', '2026-10-28讨论海风方案时，明确决定封面使用深蓝色，标题放左上角。');
  const recallSession = createRecallSession(m, { scene: 'life' });
  const reply = await requestReply({ chat: options => chatWithSearch(options, { chat: wb.chat }), request: { provider: 'workbuddy', model, maxTokens: 4096, timeoutMs: 55000,
    cognitive: true, deferPresentation: true, recallSession, webSearch: false, extraBody: { reasoning_effort: 'low' }, messages: [
      { role: 'system', content: '你是Bunny。需要时先查共同经历再回答。\n' + dc.RULE },
      { role: 'user', content: '请查2026-10-28我们讨论的海风方案，找到后必须再读取原话，告诉我当时封面颜色和标题位置。本轮不联网。' },
    ] } });
  assert(reply.memoryRecall.calls >= 2, 'model should find and then read original evidence'); assert(/深蓝|蓝色/u.test(reply.text) && /左上/u.test(reply.text));
  assert.equal(reply.webSearch.calls, 0); assert(await recallSession.verify());
  console.log(JSON.stringify({ stage: 'recall', model, calls: reply.memoryRecall.calls, ms: Date.now() - started }));
  // Fresh separate model-learning partition, so the unrelated cover request
  // cannot serve as evidence of a writing preference.
  const u = await m.addMessage('user', '我愿意读你自己写的故事，可以先试一个通过人物对话表达关系的短篇。');
  const b = await m.addMessage('assistant', '我想试写一个两个人在海边重逢的短篇，先写一个对话开场。');
  worker = new MemoryMaintenance({ memory: m, setTimer: () => 1, clearTimer() {}, extract: async (...args) => {
    const result = await free.extractMemories(...args);
    fs.writeFileSync('/tmp/workbunny-growth-live-dream.json', JSON.stringify({ input: args[0], context: args[1].analysisContext, result }, null, 2), { mode: 0o600 });
    return result;
  } });
  worker.request('dream'); await worker.tick();
  assert.equal(worker.status().status, 'idle', JSON.stringify(worker.status()));
  const growth = await m.growth.view();
  const goal = growth.entries.find(e => e.type === 'pursuit' && e.status === 'active');
  assert(goal, 'real Dream must form an evidenced, actionable creative goal'); assert(goal.nextStep.trim());
  assert(goal.support.some(q => [u.id, b.id].includes(q.sourceId)));
  console.log(JSON.stringify({ stage: 'dream', goals: growth.entries.filter(e => e.type === 'pursuit').length, ms: Date.now() - started }));
  const activity = await free.proposeActivity({ grant: { kind: 'create', subject: '人物对话短篇', scene: 'life' }, self: (await m.cognition.loadRoleView()).text,
    growth: growth.text, context: '刚开始尝试写一个人物对话短篇，尚无已完成作品。', recent: [], actualState: '当前空闲，有本地创作授权，尚未开始本次活动。' });
  assert.equal(activity.kind, 'create'); assert(activity.content.length > 30); assert(['md', 'txt', 'html', 'js', 'py'].includes(activity.extension));
  if (activity.pursuitId) assert.equal(activity.pursuitId, goal.id);
  const report = { passed: true, syntheticOnly: true, model, ms: Date.now() - started, recall: { calls: reply.memoryRecall.calls, text: reply.text },
    goal: { type: goal.type, nextStep: goal.nextStep }, creation: { title: activity.title, characters: activity.content.length, linked: !!activity.pursuitId } };
  fs.writeFileSync('/tmp/workbunny-growth-live.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
main().catch(e => { console.error(e.code || e.name, e.message); process.exitCode = 1; }).finally(async () => { await worker?.close(); await m?.close(); fs.rmSync(root, { recursive: true, force: true }); });
