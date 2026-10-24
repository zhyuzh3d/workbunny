'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MemoryService } = require('../src/main/memory-service');
const { timeContext } = require('../src/main/companion-time');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const activeServices = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 10000) {
  const stop = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= stop) throw new Error('timed out waiting for MemoryService state');
    await delay(20);
  }
}

function stubSafeStorage() {
  const testOnlyKey = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', testOnlyKey, nonce);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]);
    },
    decryptString(envelope) {
      const nonce = envelope.subarray(0, 12), tag = envelope.subarray(12, 28), data = envelope.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', testOnlyKey, nonce); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}

function makeClock(start = Date.UTC(2025, 0, 1)) {
  let value = start;
  return () => value++;
}

function createService(dir, safeStorage, options = {}) {
  const settings = options.settings || { enabled: true, extract: false };
  const service = new MemoryService({
    dir, bin, safeStorage, getSettings: () => settings,
    clock: options.clock || makeClock(), random: () => 0,
    extract: options.extract,
  });
  activeServices.add(service);
  return service;
}

async function testSearchEncryptionRestartAndRemoval(temp, safeStorage) {
  const dir = path.join(temp, 'search-vault');
  const service = await createService(dir, safeStorage).init();
  assert(service.db, `service init failed: ${service.error}`);
  const remembered = await service.addMessage('user', '请记住：我喜欢黑咖啡');
  await service.addMessage('user', 'I prefer oat milk with breakfast');
  await service.addMessage('user', '比如我说“请记住我住在火星”，这是个玩笑');
  await service.addMessage('user', '请记住：不要保存我的手机号');
  await service.addMessage('user', "Please do not remember my private address");
  await service.addMessage('user', '我今天很疲惫');

  const cn = await service.search('黑咖啡', ['memory']);
  assert(cn.some(x => x.value.content.includes('黑咖啡')));
  const en = await service.search('oat milk', ['message']);
  assert(en.some(x => x.value.content.includes('oat milk')));
  assert.equal((await service.search('火星', ['memory'])).length, 0, 'hypothetical quoted memory must not be captured');
  assert.equal((await service.search('手机号', ['memory'])).length, 0, 'explicit refusal must not be captured');
  assert.equal((await service.search('private address', ['memory'])).length, 0, 'English refusal must not be captured');

  await service.close();
  const dbBytes = ['companion.db', 'companion.db-wal', 'companion.db-shm']
    .filter(name => fs.existsSync(path.join(dir, name)))
    .map(name => fs.readFileSync(path.join(dir, name)));
  const stored = Buffer.concat(dbBytes).toString('utf8');
  assert(!stored.includes('黑咖啡'));
  assert(!stored.includes('oat milk with breakfast'));

  const restarted = await createService(dir, safeStorage).init();
  assert(restarted.db, `restart failed: ${restarted.error}`);
  assert((await restarted.search('黑咖啡', ['memory'])).length > 0);
  assert((await restarted.search('oat milk', ['message'])).length > 0);
  assert.equal(restarted.state.mood, '关切', 'mood state must persist across restart');
  const memory = (await restarted.list({ kind: 'memory' })).find(x => x.content.includes('黑咖啡'));
  assert(memory);
  const forgotten = await restarted.remove(memory.id);
  assert.equal(forgotten.removedSources, 1);
  assert((await restarted.search('黑咖啡', ['memory', 'message'])).length === 0, 'forget must delete source text as well as derived memory');
  assert(!restarted.recent.some(x => x.id === remembered.id), 'removed source must leave in-memory recent history');
  await restarted.close();
}

async function testAssistantLineageDeletionAndCorrection(temp, safeStorage) {
  const dir = path.join(temp, 'assistant-lineage-vault');
  const service = await createService(dir, safeStorage).init();
  const unrelated = await service.addMessage('user', '我最近想看海边日落');
  const source = await service.addMessage('user', '请记住：我的猫叫棉花糖ZQ');
  const memory = (await service.list({ kind: 'memory' })).find(x => x.content.includes('棉花糖ZQ'));
  assert(memory);

  const firstContext = await service.context('我的猫叫什么', { budget: 8500 });
  assert(firstContext.sourceIds.includes(source.id));
  assert(firstContext.sourceIds.includes(memory.id));
  assert(firstContext.sourceIds.length <= 200);
  assert.equal((await service.db.request('get', { ids: firstContext.sourceIds })).rows.length, firstContext.sourceIds.length);
  await assert.rejects(service.addMessage('assistant', 'reject excessive provenance', { sources: Array(201).fill(source.id) }), /数量或格式/);
  const assistant1 = await service.addMessage('assistant', '你的猫叫棉花糖ZQ。', {
    delivery: 'generated', sources: firstContext.sourceIds, role: 'user', content: '模型不得覆盖真实角色或正文', source: 'forged-source',
  });
  assert.equal(assistant1.value.role, 'assistant');
  assert.equal(assistant1.value.content, '你的猫叫棉花糖ZQ。');
  assert(assistant1.value.sources.includes(source.id));
  assert.equal(assistant1.value.source, undefined);

  const secondContext = await service.context('再说一次猫的名字', { budget: 8500 });
  assert(secondContext.sourceIds.includes(assistant1.id), 'assistant history actually injected into prompt must be a source');
  const assistant2 = await service.addMessage('assistant', '我还记得棉花糖ZQ。', { delivery: 'generated', sources: secondContext.sourceIds });
  assert(assistant2.value.sources.includes(assistant1.id));
  const summary = { id: 'cat-derived-summary', kind: 'summary', ts: service.clock(),
    value: { content: '猫叫棉花糖ZQ', sources: [assistant2.id], origin: 'test-derived', } };
  await service.write([summary]);
  await assert.rejects(service.addMessage('assistant', 'reject missing provenance', { sources: ['not-a-real-record'] }), /来源已删除或不存在/);
  const forgedUser = await service.addMessage('user', '普通用户消息', { role: 'assistant', content: 'forged', sources: [source.id] });
  assert.equal(forgedUser.value.role, 'user');
  assert.equal(forgedUser.value.content, '普通用户消息');
  assert.deepEqual(forgedUser.value.sources, []);
  const unbudgeted = await service.context('none', { internal: true, budget: 1 });
  assert.deepEqual(unbudgeted.sourceIds, [], 'records omitted by the character budget must not become lineage sources');

  const beforeForget = await service.search('棉花糖ZQ', ['message', 'memory', 'summary']);
  assert(beforeForget.length >= 4);
  const forgotten = await service.remove(source.id);
  assert(forgotten.removed >= 5);
  const afterIds = [source.id, memory.id, assistant1.id, assistant2.id, summary.id];
  assert.equal((await service.db.request('get', { ids: afterIds })).rows.length, 0);
  assert.equal((await service.search('棉花糖ZQ', ['message', 'memory', 'summary'])).length, 0);
  assert(service.recent.some(x => x.id === unrelated.id), 'forgetting one source must preserve unrelated user messages');
  assert(!service.recent.some(x => [source.id, assistant1.id, assistant2.id].includes(x.id)));
  await service.close();

  const updateService = await createService(path.join(temp, 'assistant-correction-vault'), safeStorage).init();
  const oldSource = await updateService.addMessage('user', '请记住：我的猫叫旧猫名PQ');
  const oldMemory = (await updateService.list({ kind: 'memory' })).find(x => x.content.includes('旧猫名PQ'));
  const oldContext = await updateService.context('猫叫什么', { budget: 8500 });
  const oldReply = await updateService.addMessage('assistant', '猫名是旧猫名PQ。', { sources: oldContext.sourceIds });
  const revised = await updateService.updateMemory(oldMemory.id, '我的猫名字改为新猫名RS');
  assert.equal(revised.removedSources, 1);
  const oldNameMatches = await updateService.search('旧猫名PQ', ['message', 'memory']);
  assert(!oldNameMatches.some(row => row.value.content.includes('旧猫名PQ')));
  assert.equal((await updateService.db.request('get', { ids: [oldSource.id, oldMemory.id, oldReply.id] })).rows.length, 0);
  const updatedMemory = (await updateService.list({ kind: 'memory' }))[0];
  assert.equal(updatedMemory.content, '我的猫名字改为新猫名RS');
  assert(updateService.recent.some(x => x.value.source === 'user-reviewed' && x.value.content.includes('新猫名RS')));
  await updateService.close();
}

async function testCorrectionInvalidatesSource(temp, safeStorage) {
  const service = await createService(path.join(temp, 'correction-vault'), safeStorage).init();
  const original = await service.addMessage('user', '我喜欢红茶');
  const memory = (await service.list({ kind: 'memory' }))[0];
  assert(memory && memory.content.includes('红茶'));
  const corrected = await service.updateMemory(memory.id, '我改为喜欢绿茶');
  assert.equal(corrected.removedSources, 1);
  assert((await service.search('红茶', ['message', 'memory'])).length === 0, 'old statement should no longer be searchable');
  const newMemory = (await service.list({ kind: 'memory' }))[0];
  assert.equal(newMemory.content, '我改为喜欢绿茶');
  assert.notEqual(newMemory.id, memory.id);
  assert(!service.recent.some(x => x.id === original.id));
  assert(service.recent.some(x => x.value.content === '我改为喜欢绿茶' && x.value.source === 'user-reviewed'));
  await service.close();
}

async function testOldExtractionCannotResurrectDeletedSource(temp, safeStorage) {
  let release;
  let called = false;
  const extract = () => { called = true; return new Promise(resolve => { release = resolve; }); };
  const service = await createService(path.join(temp, 'stale-job-vault'), safeStorage, { extract, settings: { enabled: true, extract: true } }).init();
  const messages = [];
  for (let i = 0; i < 4; i++) messages.push(await service.addMessage('user', `第${i}条测试对话，包含可验证证据词汇`));
  clearTimeout(service.extractTimer); service.extractTimer = null;
  const job = service.consolidate();
  await until(() => called);
  const source = messages[0];
  const removal = await service.remove(source.id);
  assert(removal.removed >= 1);
  release({ memories: [{ sourceId: source.id, evidence: '可验证证据词汇', content: '不应复活的事实' }], excerpts: [{ sourceId: source.id, quote: '可验证证据词汇' }] });
  await job;
  assert.equal((await service.db.request('get', { ids: [source.id] })).rows.length, 0);
  assert.equal((await service.search('不应复活', ['memory', 'summary'])).length, 0);
  await service.close();
}

async function testExtractionEvidenceAndPeriodicTrigger(temp, safeStorage) {
  let calls = 0, emptyExcerptMode = false;
  const extract = async batch => {
    calls++;
    if (emptyExcerptMode) return { memories: [], excerpts: [] };
    const user = batch.find(x => x.role === 'user');
    return {
      memories: [
        { sourceId: user.id, evidence: '周期提取证据', content: '每四条用户对话后保留候选' },
        { sourceId: 'unknown-id', evidence: '周期提取证据', content: '无来源内容' },
        { sourceId: user.id, evidence: '不存在的证据', content: '伪造证据内容' },
        { sourceId: user.id, evidence: '周期提取证据', content: '' },
      ],
      excerpts: [
        { sourceId: user.id, quote: '周期提取证据' },
        { sourceId: user.id, quote: '这句话并没有出现' },
      ],
    };
  };
  const settings = { enabled: true, extract: true };
  const dir = path.join(temp, 'periodic-vault');
  let service = await createService(dir, safeStorage, { extract, settings }).init();
  for (let i = 0; i < 40; i++) await service.addMessage('user', `第${i}轮周期提取证据测试`);
  await until(() => calls >= 1, 12000);
  await until(() => service.lastExtractCount === 40, 12000);
  assert.equal(service.userMessagesSeen, 40);
  assert.equal(service.lastExtractCount, 40);
  let candidates = (await service.list({ kind: 'memory' })).filter(x => x.content === '每四条用户对话后保留候选');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'pending');
  assert.equal(candidates[0].evidence, '周期提取证据');
  let summaries = await service.list({ kind: 'summary' });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].content, '用户说：周期提取证据');
  await service.close();

  calls = 0; emptyExcerptMode = true;
  service = await createService(dir, safeStorage, { extract, settings }).init();
  assert.equal(service.userMessagesSeen, 40, 'user ordinal must survive restart after recent[] reaches 40');
  assert.equal(service.lastExtractCount, 40);
  for (let i = 40; i < 44; i++) await service.addMessage('user', `第${i}轮周期提取证据测试`);
  await until(() => calls >= 1, 12000);
  await until(() => service.lastExtractCount === 44, 12000);
  assert.equal(service.userMessagesSeen, 44);
  assert.equal(service.lastExtractCount, 44, 'extraction must continue after the rolling recent window saturated');
  summaries = await service.list({ kind: 'summary' });
  assert.equal(summaries.length, 2);
  assert(summaries.some(summary => /^用户说：第\d+轮周期提取证据测试/.test(summary.content)));
  await service.close();
}

async function testCancelledExtractionDoesNotCommitAndCanRetry(temp, safeStorage) {
  let calls = 0, releaseFirst, firstSignal;
  const extract = (batch, { signal } = {}) => {
    calls++;
    const source = batch.find(r => r.role === 'user');
    if (calls === 1) {
      firstSignal = signal;
      return new Promise(resolve => { releaseFirst = resolve; }); // Simulate a provider returning late despite abort.
    }
    return Promise.resolve({
      memories: [{ sourceId: source.id, evidence: '可验证取消测试原句', content: '成功重试后的待确认候选' }],
      excerpts: [{ sourceId: source.id, quote: '可验证取消测试原句' }],
    });
  };
  const settings = { enabled: true, extract: true };
  const service = await createService(path.join(temp, 'cancel-extraction-vault'), safeStorage, { extract, settings }).init();
  for (let i = 0; i < 4; i++) await service.addMessage('user', `第${i}条可验证取消测试原句`);
  if (service.extractTimer) { clearTimeout(service.extractTimer); service.extractTimer = null; }
  const firstJob = service.consolidate();
  await until(() => typeof releaseFirst === 'function');
  service.cancelExtraction();
  assert.equal(firstSignal.aborted, true, 'cancelExtraction must abort the provider signal');
  releaseFirst({
    memories: [{ sourceId: 'late', evidence: '可验证取消测试原句', content: '取消后不得写入的候选' }],
    excerpts: [{ sourceId: 'late', quote: '可验证取消测试原句' }],
  });
  await firstJob;
  assert.equal(service.lastExtractCount, 0, 'cancelled extraction must not advance the processed count');
  assert.equal((await service.search('取消后不得写入', ['memory', 'summary'])).length, 0);
  assert.equal((await service.stats()).counts.summary || 0, 0, 'cancelled extraction must not persist a summary');

  await service.consolidate();
  assert.equal(calls, 2, 'a later extraction should be able to run');
  assert.equal(service.lastExtractCount, 4);
  assert((await service.search('成功重试后的待确认候选', ['memory'])).some(r => r.value.status === 'pending'));
  assert((await service.search('可验证取消测试原句', ['summary'])).length > 0);
  await service.close();
}

async function testContextBudgetAndDisabledFallback(temp, safeStorage) {
  let enabled = true;
  const service = await createService(path.join(temp, 'context-vault'), safeStorage, { settings: { get enabled() { return enabled; }, extract: false } }).init();
  const source = await service.addMessage('user', 'budget reference phrase');
  const records = [];
  for (let i = 0; i < 12; i++) records.push({ id: `budget-memory-${i}`, kind: 'memory', ts: source.ts + i + 1,
    value: { content: `budget reference phrase memory fragment ${i} ` + '资料'.repeat(40), memoryKind: 'fact', importance: 0.9, status: 'confirmed', evidence: 'budget reference phrase', sources: [source.id] } });
  await service.write(records);
  for (let i = 0; i < 12; i++) await service.addMessage(i % 2 ? 'assistant' : 'user', `最近轮次消息 ${i} ` + '上下文'.repeat(50));
  const context = await service.context('budget reference phrase', { budget: 1000 });
  const actual = context.text.length + context.messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
  assert(actual <= 1000, `context used ${actual} characters over budget`);
  assert(context.used <= 1000);

  const oldSourceTs = Date.UTC(1996, 0, 2), currentTs = Date.UTC(2025, 0, 2);
  await service.write([
    { id: 'old-anchor-source', kind: 'message', ts: oldSourceTs, value: { role: 'user', content: '我长期保留的古典音乐偏好', sources: [] } },
    { id: 'new-anchor-source', kind: 'message', ts: currentTs, value: { role: 'user', content: 'recent anchor source', sources: [] } },
  ]);
  await service.write([{ id: 'old-pinned-anchor', kind: 'memory', ts: oldSourceTs + 1,
    value: { content: '我长期保留的古典音乐偏好', memoryKind: 'preference', importance: 1, status: 'confirmed', evidence: '我长期保留的古典音乐偏好', sources: ['old-anchor-source'] } }]);
  await service.write(Array.from({ length: 65 }, (_, i) => ({ id: `recent-memory-${String(i).padStart(3, '0')}`, kind: 'memory', ts: currentTs + i + 1,
    value: { content: `近期普通记忆片段 ${i}`, memoryKind: 'fact', importance: 0.5, status: 'confirmed', evidence: 'recent anchor source', sources: ['new-anchor-source'] } })));
  assert(!(await service.query('memory', 60)).some(r => r.id === 'old-pinned-anchor'));
  const pinnedContext = await service.context('unrelated topic', { budget: 4000 });
  assert(pinnedContext.text.includes('我长期保留的古典音乐偏好'), 'an old pinned memory must remain recallable beyond the latest 60 records');
  const roomy = await service.context('unrelated topic', { budget: 4000 });
  const historyChars = roomy.text.length - timeContext(service.clock(), 'Asia/Shanghai').line.length;
  const recentChars = roomy.messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
  assert(historyChars <= 1920, `historical context used ${historyChars} chars above its 48% ceiling`);
  assert(recentChars >= 1900, `large pinned context squeezed recent conversation to ${recentChars} chars`);
  enabled = false;
  const fallback = await service.context('当前这一轮', { recent: [
    { role: 'assistant', content: '更早的 RAM 对话' },
    { role: 'user', content: '当前这一轮' },
  ], budget: 500 });
  assert.deepEqual(fallback.messages, [{ role: 'user', content: '当前这一轮' }]);
  const tiny = await service.context('当前这一轮', { recent: [{ role: 'user', content: '当前这一轮' }], budget: 100 });
  assert(tiny.text.length + tiny.messages.reduce((n, m) => n + JSON.stringify(m).length, 0) <= 100);
  await service.close();
}

async function testAnniversaryIndexAndClearCount(temp, safeStorage) {
  let now = Date.UTC(2010, 4, 1, 4);
  const service = await createService(path.join(temp, 'anniversary-vault'), safeStorage, { clock: () => now }).init();
  const source = await service.addMessage('user', '请记住：我的生日是5月1日');
  let birthday = await service.search('user.birthday', ['memory'], 20);
  assert.equal(birthday.length, 1);
  assert.deepEqual(birthday[0].value.anniversary, { calendar: 'solar', month: 5, day: 1 });
  await service.addMessage('user', '我的生日是6月2日');
  birthday = await service.search('user.birthday', ['memory'], 20);
  assert(birthday.some(r => r.value.anniversary?.month === 6 && r.value.status === 'pending'), 'birthday changes must remain pending');
  await service.write(Array.from({ length: 80 }, (_, i) => ({ id: `later-memory-${i}`, kind: 'memory', ts: now + i + 1,
    value: { content: `unrelated newer preference ${i} 海棠`, memoryKind: 'preference', importance: 0.5, status: 'confirmed', sources: [source.id] } })));
  now = Date.UTC(2026, 4, 1, 4);
  const context = await service.context('普通聊天', { budget: 4000 });
  assert(context.text.includes('我的生日是5月1日'), 'anniversary indexed lookup must recall an old birthday after many newer memories');
  assert(context.messages.length > 0);

  const chineseNumber = await service.addMessage('user', '我的生日是五月一日');
  assert(chineseNumber);
  const unparsed = await service.search('user.birthday', ['memory'], 50);
  assert(unparsed.some(r => r.value.content === '我的生日是五月一日' && !r.value.anniversary), 'Chinese numeral dates must not be guessed into an indexed month/day');
  await service.clear();
  assert.equal(service.userMessagesSeen, 0, 'clear resets periodic extraction count');
  await service.addMessage('user', '清空后第一轮');
  assert.equal(service.userMessagesSeen, 1);
  await service.close();

  let lunarNow = Date.UTC(2024, 1, 10, 4); // 2024 lunar new year: 正月初一
  const lunarService = await createService(path.join(temp, 'lunar-anniversary-vault'), safeStorage, { clock: () => lunarNow }).init();
  await lunarService.addMessage('user', '我的农历生日是1月1日');
  lunarNow = Date.UTC(2025, 0, 29, 4); // 2025 lunar new year
  const lunarContext = await lunarService.context('今天有什么安排', { budget: 4000 });
  assert(lunarContext.text.includes('我的农历生日是1月1日'), 'lunar indexed lookup must find a multi-year-old birthday');
  lunarNow = Date.UTC(2025, 6, 25, 4); // 闰六月; must not match an ordinary lunar June birthday
  await lunarService.addMessage('user', '我的农历生日是6月1日');
  const leapContext = await lunarService.context('今天有什么安排', { budget: 4000 });
  assert(!leapContext.text.includes('我的农历生日是6月1日'), 'leap lunar months are not automatically celebrated as ordinary month dates');
  await lunarService.close();
}

async function testLegacyUnknownTimeIsNotInvented(temp, safeStorage) {
  const parent = path.join(temp, 'legacy-vault'); fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(path.join(parent, 'memory.json'), JSON.stringify({ history: [{ role: 'user', content: '旧记录内容' }] }));
  const service = await createService(path.join(parent, 'db'), safeStorage).init();
  assert(service.db, `legacy migration failed: ${service.error}`);
  const context = await service.context('你好', { budget: 1000 });
  assert.match(context.text, /具体时间未知/);
  assert(!/在\d+秒前/.test(context.text));
  assert(!fs.existsSync(path.join(parent, 'memory.json')));
  await service.close();
}

async function testExportRestorePaginationAndOldTimes(temp, safeStorage) {
  const service = await createService(path.join(temp, 'export-vault'), safeStorage).init();
  const sameTs = Date.UTC(2001, 0, 1);
  await service.write([{ id: 'same-source', kind: 'message', ts: sameTs, value: { role: 'user', content: 'source quote', sources: [] } }]);
  const sameTime = Array.from({ length: 205 }, (_, i) => ({
    id: `same-${String(i).padStart(3, '0')}`, kind: 'message', ts: sameTs,
    value: { role: 'user', content: `same timestamp record ${i}`, sources: [] },
  }));
  sameTime[204].value.userOrdinal = 48;
  await service.write(sameTime.slice(0, 200));
  await service.write(sameTime.slice(200));
  await service.write([{ id: 'same-summary', kind: 'summary', ts: sameTs,
    value: { content: 'source quote', sources: ['same-source'] } }]);
  const historicTs = Date.UTC(1990, 5, 15);
  await service.write([{ id: 'known-old-year', kind: 'message', ts: historicTs,
    value: { role: 'user', content: '旧年份记录', timeUnknown: false, sources: [] } }]);
  await service.write([{ id: 'companion-state', kind: 'state', ts: sameTs + 2,
    value: { mood: '愉快', energy: 0.8, warmth: 0.9, updatedAt: sameTs + 2, interactions: 48, userMessagesSeen: 37, lastExtractCount: 33, sources: [] } }]);

  const all = []; let cursor = {};
  for (;;) {
    const page = await service.query(undefined, 200, { ...cursor, state: 'all' });
    if (!page.length) break;
    all.push(...page);
    const last = page.at(-1); cursor = { before: last.ts, beforeId: last.id };
  }
  assert.equal(all.length, 209);
  assert.equal(new Set(all.map(r => r.id)).size, all.length);
  assert.equal(all.find(r => r.id === 'known-old-year').ts, historicTs);
  assert.equal(all.filter(r => r.ts === sameTs).length, 207);

  const passphrase = 'test-only-backup-passphrase';
  const backup = await service.export(passphrase);
  assert(!backup.includes('same timestamp record'));
  await assert.rejects(service.restore(backup, 'wrong-passphrase'), /authenticate|Unsupported state/i);
  const tampered = JSON.parse(backup), encryptedBody = Buffer.from(tampered.body, 'base64');
  encryptedBody[encryptedBody.length - 1] ^= 1; tampered.body = encryptedBody.toString('base64');
  await assert.rejects(service.restore(JSON.stringify(tampered), passphrase), /authenticate|Unsupported state/i);
  await service.clear();
  const restored = await service.restore(backup, passphrase);
  assert.equal(restored.records, 209);
  assert.equal(service.state.mood, '愉快');
  assert.equal(service.userMessagesSeen, 48, 'restore must rehydrate the largest recent user ordinal');
  assert.equal(service.lastExtractCount, 33);
  const after = [];
  cursor = {};
  for (;;) {
    const page = await service.query(undefined, 200, { ...cursor, state: 'all' });
    if (!page.length) break;
    after.push(...page);
    const last = page.at(-1); cursor = { before: last.ts, beforeId: last.id };
  }
  assert.equal(after.length, 209);
  assert.equal(after.find(r => r.id === 'known-old-year').ts, historicTs);
  assert(after.some(r => r.id === 'same-summary' && r.value.sources.includes('same-source')));
  await service.close();

  const fresh = await createService(path.join(temp, 'fresh-persona-vault'), safeStorage).init();
  await fresh.personaRevision({ name: '默认伙伴', profile: '默认设定', ownerName: '用户' });
  assert.equal((await fresh.stats()).counts.persona, 1);
  const freshRestore = await fresh.restore(backup, passphrase);
  assert.equal(freshRestore.records, 209, 'restore should replace only auto-created persona/state records on a fresh vault');
  assert.equal((await fresh.stats()).counts.message, 207);
  await fresh.close();
}

function testLunarDates() {
  const time = iso => timeContext(Date.parse(iso), 'Asia/Shanghai');
  assert.match(time('2025-01-29T12:00:00Z').holiday, /春节/);
  assert.match(time('2025-10-06T12:00:00Z').holiday, /中秋节/);
  assert.match(time('2025-01-28T12:00:00Z').holiday, /除夕/);
  assert.match(time('2025-07-25T12:00:00Z').lunar, /闰六月/);
}

async function main() {
  execFileSync(path.join(__dirname, 'build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-test-'));
  const safeStorage = stubSafeStorage();
  try {
    await testSearchEncryptionRestartAndRemoval(temp, safeStorage);
    await testAssistantLineageDeletionAndCorrection(temp, safeStorage);
    await testCorrectionInvalidatesSource(temp, safeStorage);
    await testOldExtractionCannotResurrectDeletedSource(temp, safeStorage);
    await testExtractionEvidenceAndPeriodicTrigger(temp, safeStorage);
    await testCancelledExtractionDoesNotCommitAndCanRetry(temp, safeStorage);
    await testContextBudgetAndDisabledFallback(temp, safeStorage);
    await testAnniversaryIndexAndClearCount(temp, safeStorage);
    await testLegacyUnknownTimeIsNotInvented(temp, safeStorage);
    await testExportRestorePaginationAndOldTimes(temp, safeStorage);
    testLunarDates();
    console.log('MemoryService integration checks passed');
  } finally {
    await Promise.all([...activeServices].map(item => item.close().catch(() => {})));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
