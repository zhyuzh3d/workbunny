'use strict';
// Execute the actual main-process think() source with a real disposable Vault.
// Transport/speech/UI are doubles; no Electron instance or account is touched.
const assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { MemoryService } = require('../src/main/memory-service');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-foreground-'));
const file = path.resolve('src/main/index.js'), source = fs.readFileSync(file, 'utf8');
const localRequire = require('node:module').createRequire(file);
const settings = { enabled: true, extract: false, scene: 'life' }, calls = [], shown = [];
const m = new MemoryService({ dir: root, bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 71), getSettings: () => settings });
const reply = () => JSON.stringify({ protocol: 'dialogue-v2', stages: [
  { stage: 'review', grade: 'opposite', note: '先听完用户原话。', grasp: 'adjust', pace: 'listen' },
  { stage: 'reply', reply: { kind: 'chat', text: '我听着，你继续说。' } }, { stage: 'prediction', expect: '用户继续倾诉。' },
] });
const ctx = { storageBusy: false, storageError: '', connection: { status: () => ({ ready: true }) }, require: localRequire, AbortController, Date, Set, JSON, randomUUID: require('node:crypto').randomUUID,
  inputAdmission: localRequire('./conversation-input'), scopePolicy: localRequire('./memory-scope'),
  config: { load: () => ({ memory: settings }), resolveLLM: () => ({ transport: 'workbuddy', provider: 'synthetic', model: 'test' }), buildSystemPrompt: () => '合成角色与操作规则' },
  memory: m, currentScene: () => settings.scene, contextEpoch: 0, screenLocked: false, activeThought: null, busy: false,
  desktop: null, monitor: null, secretary: null, history: [], presentedReplies: new Set(), lastDialogueAt: 0,
  dialogueActions: localRequire('./dialogue-actions'), SELF_RULE: localRequire('./dialogue-cognition').SELF_RULE, JUDGE_RULE: '',
  dialogueHistory: localRequire('./reply-format').dialogueHistory, requestReply: localRequire('./reply-request').requestReply,
  llm: { ...localRequire('./llm'), chat: async options => { calls.push(options.messages); return { raw: reply() }; } },
  send: (name, value) => shown.push({ name, value }), log: () => {}, publishRecall() {}, publishWebSources() {}, speak() {},
  presentConversation: text => text, conversationText: text => text, maintenance: { requestReflection() {} },
  pushHistory: (...args) => m.addMessage(...args), selfMutationOwner: false };
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('async function think('), source.indexOf('/* ── 主动播报')), ctx);
vm.runInContext(source.slice(source.indexOf('function worthJudging('), source.indexOf('/** 听见有人叫我名字')), ctx);
async function run() {
  await m.init(); assert(m.ready, m.error); await m.cognition.ensure({ profile: '我认真倾听。' });
  const first = await m.addMessage('user', 'PrivateHistorySentinel，我只是想说说。');
  assert(await ctx.think({ userText: first.value.content, userMessage: first, allowSpeech: false }));
  const previous = (await m.query('message', 1, { sort: 'ingestion' }))[0]; assert(previous.value.cognition);
  for (let i = 0; i < 110; i++) await m.addMessage('user', `后台消息${i}`, { characterId: 'workbuddy' });
  const next = await m.addMessage('user', '不是这个意思，先听我说。');
  assert(await ctx.think({ userText: next.value.content, userMessage: next, allowSpeech: false }));
  const feedback = JSON.parse(calls.at(-1).find(r => r._contextLane === 'cognition').content);
  assert.equal(feedback.previous.prediction, previous.value.cognition.prediction);
  assert.equal((await m.query('message', 1, { sort: 'ingestion' }))[0].value.cognition.previousReplyId, previous.id);
  const growthView = await m.growth.view({ domain: 'life', visibilityFloor: 1 }), self = await m.cognition.learningInput();
  let plan = await m.growth.prepare([{ op: 'add', type: 'user_model', content: '倾诉时先认真听完。', condition: '尚未请求建议', support: [{ sourceId: next.id, quote: next.value.content }] }],
    { rows: [next], view: growthView, self, domain: 'life', visibilityFloor: 1 });
  await m.cognition.commitPatch({ requestId: 'foreground-growth', baseRevision: self.revision, ops: [] }, { sourceRows: [next], extraRecords: plan.records, validateExtra: plan.guard });
  const belief = (await m.growth.view()).entries[0];
  ctx.llm.chat = async options => { calls.push(options.messages); const v = JSON.parse(reply()); v.stages[2].basis = [belief.id, 'invented-record']; return { raw: JSON.stringify(v) }; };
  const third = await m.addMessage('user', '继续听我说。'); await ctx.think({ userText: third.value.content, userMessage: third, allowSpeech: false });
  assert.deepEqual((await m.query('message', 1, { sort: 'ingestion' }))[0].value.cognition.basis, [belief.id], 'only actually supplied beliefs can support a prediction');
  const fourth = await m.addMessage('user', '这次请一起想办法，主动给些建议。');
  plan = await m.growth.prepare([{ op: 'replace', entryId: belief.entryId, type: 'user_model', content: '明确求助时共同推进。', condition: '主人已请求建议', status: 'recheck', counter: [{ sourceId: fourth.id, quote: fourth.value.content }] }],
    { rows: [fourth], view: await m.growth.view({ domain: 'life', visibilityFloor: 1 }), self: await m.cognition.learningInput(), domain: 'life', visibilityFloor: 1 });
  await m.cognition.commitPatch({ requestId: 'foreground-revise', baseRevision: (await m.cognition.loadRoleView()).revision, ops: [] }, { sourceRows: [fourth], extraRecords: plan.records, validateExtra: plan.guard });
  await ctx.think({ userText: fourth.value.content, userMessage: fourth, allowSpeech: false });
  const reviewed = JSON.parse(calls.at(-1).find(r => r._contextLane === 'cognition').content);
  assert.equal(reviewed.previous.beliefs[0].content, belief.content, 'review sees the belief actually used, even after revision');
  assert(reviewed.growth.includes('明确求助时共同推进'));
  settings.enabled = false; ctx.presentedReplies.clear();
  ctx.history = [{ role: 'user', content: '这次临时叫我小周' }, { role: 'assistant', content: '你好小周' }, { role: 'user', content: '你刚才怎么称呼我' }].map(r => ({ ...r, domain: 'life', visibilityFloor: 1 }));
  const query = m.query.bind(m); let messageReads = 0;
  m.query = (...args) => { if (args[0] === 'message') messageReads++; return query(...args); };
  assert(await ctx.think({ userText: '你刚才怎么称呼我', allowSpeech: false }));
  assert.equal(messageReads, 0, 'disabled memory must never load persisted dialogue/predictions');
  const current = JSON.stringify(calls.at(-1)); assert(current.includes('你好小周')); assert(!current.includes('PrivateHistorySentinel'));
  assert.equal(JSON.parse(calls.at(-1).find(r => r._contextLane === 'cognition').content).previous, null);
  assert(ctx.worthJudging('嗯')); ctx.lastDialogueAt = 0; assert(!ctx.worthJudging('嗯'));
  assert(shown.some(e => e.name === 'chat' && e.value.final));
  // The actual periodic callback must not create an idle-activity promise
  // while maintenance is entering its own asynchronous permission checks.
  const { MemoryMaintenance } = localRequire('./memory-maintenance');
  const { CompanionAutonomy } = localRequire('./companion-autonomy');
  let autonomy;
  const worker = new MemoryMaintenance({ memory: m, extract: async () => ({ memories: [] }),
    compression: { run: async options => ({ status: await options.canRun() ? 'done' : 'paused', processed: 0 }) },
    canRun: () => !autonomy?.running, setTimer: () => 1, clearTimer() {} });
  autonomy = new CompanionAutonomy({ memory: m, canRun: () => !worker.activeMode, getScene: () => settings.scene });
  ctx.maintenance = worker; ctx.autonomy = autonomy; ctx.readyForTasks = () => true;
  const start = source.indexOf('maintenanceTimer = setInterval(() => {') + 'maintenanceTimer = setInterval(() => {'.length;
  vm.runInContext('function maintenancePulse(){' + source.slice(start, source.indexOf('}, 15000);', start)) + '}', ctx);
  for (let i = 0; i < 3; i++) { worker.request('doze'); ctx.maintenancePulse(); await worker.tickPromise; await autonomy.running; assert.equal(worker.status().status, 'idle', 'idle checking must not starve maintenance'); }
  await worker.close(); await autonomy.close();
  console.log('actual foreground think passed: persisted forecast pairing under external flood, protected feedback, memory-off isolation/session history, short acknowledgement admission');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await m.close(); fs.rmSync(root, { recursive: true, force: true }); });
