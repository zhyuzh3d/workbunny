'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { MemoryService } = require('../src/main/memory-service');
const vc = require('../src/main/vault-crypto');
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
    extract: options.extract, onChange: options.onChange, openKey: options.openKey,
  });
  activeServices.add(service);
  return service;
}

async function testChangeNotifications(temp, safeStorage) {
  const changes = [];
  const service = await createService(path.join(temp, 'change-vault'), safeStorage, { onChange: change => changes.push(change) }).init();
  await service.addMessage('user', '请记住我喜欢海边散步');
  assert(changes.length > 0, 'writes should notify the companion panel');
  const writeChange = changes.at(-1);
  assert.equal(writeChange.type, 'memory-changed');
  assert.deepEqual(Object.keys(writeChange), ['type']);
  assert.equal(JSON.stringify(writeChange).includes('海边散步'), false, 'change event must not include private content');
  const memory = (await service.list({ kind: 'memory' }))[0];
  const beforeUpdate = changes.length;
  await service.updateMemory(memory.id, '我喜欢安静的海边散步');
  assert.equal(changes.length, beforeUpdate + 1, 'correction emits one notification after its writes');
  const beforeRemove = changes.length;
  const updated = (await service.list({ kind: 'memory' }))[0];
  await service.remove(updated.id);
  assert.equal(changes.length, beforeRemove + 1, 'remove emits one notification');
  await service.clear();
  assert.equal(changes.at(-1).type, 'memory-changed', 'clear invalidates the open view');
  assert.equal((await service.db.request('stats')).counts.total, 0);
  await service.close();
}

async function testAsyncKeyOpening(temp, safeStorage) {
  let resolveKey;
  const key = crypto.randomBytes(32);
  const service = createService(path.join(temp, 'async-key-vault'), safeStorage, { openKey: () => new Promise(resolve => { resolveKey = resolve; }) });
  const opening = service.init();
  await delay(5); // Other requests must still complete while the OS prompt is pending.
  assert.equal((await service.stats()).ready, false);
  assert.equal(fs.existsSync(path.join(service.dir, 'companion.db')), false, 'pending key never creates an empty replacement vault');
  resolveKey(key); await opening; assert.equal((await service.stats()).ready, true);
  await service.close();

  let resolveCancelled;
  const lateKey = crypto.randomBytes(32);
  const cancelled = createService(path.join(temp, 'cancelled-key-vault'), safeStorage, { openKey: () => new Promise(resolve => { resolveCancelled = resolve; }) });
  const late = cancelled.init(); await cancelled.close(); resolveCancelled(lateKey); await late;
  assert.equal(cancelled.db, null, 'closing while waiting cannot reopen the vault');
  assert(lateKey.every(byte => byte === 0), 'late key is wiped');
  assert.equal(fs.existsSync(path.join(cancelled.dir, 'companion.db')), false);
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
  const reviewedSource = (await updateService.db.request('get', { ids: updatedMemory.sources })).rows[0];
  assert.equal(updateService.decode(reviewedSource).value.source, 'user-reviewed', 'correction evidence remains linked and removable');
  assert(!updateService.recent.some(x => x.value.source === 'user-reviewed'), 'memory edits are not recent chat turns');
  const correctedContext = await updateService.context('猫叫什么', { budget: 8500 });
  assert(!correctedContext.messages.some(x => x.role === 'user' && x.content.includes('新猫名RS')));
  assert.match(correctedContext.text, /新猫名RS/, 'the corrected fact remains available as memory');
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
  assert(!service.recent.some(x => x.value.content === '我改为喜欢绿茶' && x.value.source === 'user-reviewed'));
  await service.close();
}

async function testReviewedEditAndMoodForget(temp, safeStorage) {
  const correctionDir = path.join(temp, 'reviewed-edit-history-vault');
  let service = await createService(correctionDir, safeStorage).init();
  await service.addMessage('user', '请记住：我的小猫叫棉花Audit');
  const originalMemory = (await service.list({ kind: 'memory' }))[0];
  const updated = await service.updateMemory(originalMemory.id, '我的小猫名字更正为云朵Audit');
  assert.equal(updated.removedSources, 1);
  let correctedMemory = (await service.list({ kind: 'memory' }))[0];
  const correctedSourceId = correctedMemory.sources[0];
  assert.equal((await service.db.request('get', { ids: [correctedSourceId] })).rows.length, 1,
    'the correction source remains available for provenance and cascade deletion');
  assert(!service.recent.some(row => row.id === correctedSourceId));
  let context = await service.context('你好', { budget: 8500 });
  assert(!context.messages.some(row => row.role === 'user' && row.content.includes('云朵Audit')),
    'an editor correction must not be injected as a spoken user turn');
  assert.match(context.text, /云朵Audit/, 'the corrected memory itself remains in context');
  assert.match(context.text, /新的对话起点/, 'an edit must not advance the last-conversation timestamp');
  await service.close();

  service = await createService(correctionDir, safeStorage).init();
  correctedMemory = (await service.list({ kind: 'memory' }))[0];
  assert(!service.recent.some(row => row.value.source === 'user-reviewed'), 'restart must keep editor evidence out of recent dialogue');
  context = await service.context('你好', { budget: 8500 });
  assert(!context.messages.some(row => row.role === 'user' && row.content.includes('云朵Audit')));
  assert.match(context.text, /新的对话起点/);
  await service.remove(correctedMemory.id);
  assert.equal((await service.db.request('get', { ids: [correctedMemory.sources[0]] })).rows.length, 0,
    'forgetting the corrected memory still cascades to its review evidence');
  assert.equal((await service.search('云朵Audit', ['message', 'memory'])).length, 0);
  await service.close();

  const moodDir = path.join(temp, 'mood-forget-vault');
  service = await createService(moodDir, safeStorage).init();
  const moodSource = await service.addMessage('user', '我很难过');
  assert.equal(service.state.mood, '关切');
  assert.equal(service.moodSourceId, moodSource.id);
  const persisted = (await service.query('state', 1))[0].value;
  assert.equal(persisted.moodSourceId, moodSource.id);
  await service.remove(moodSource.id);
  assert.equal(service.state.mood, '平静');
  assert.equal(service.moodSourceId, null);
  assert.equal((await service.query('state', 1))[0].value.mood, '平静');
  assert.doesNotMatch((await service.context('你好', { budget: 8500 })).text, /虚拟表现状态：关切/);
  const rememberedMoodSource = await service.addMessage('user', '请记住：我很难过');
  const rememberedMood = (await service.list({ kind: 'memory' })).find(row => row.sources.includes(rememberedMoodSource.id));
  assert(rememberedMood);
  assert.equal(service.state.mood, '关切');
  await service.remove(rememberedMood.id);
  assert.equal(service.state.mood, '平静', 'forgetting a derived memory resets state sourced from its user message');
  assert.equal((await service.db.request('get', { ids: [rememberedMoodSource.id] })).rows.length, 0);
  await service.close();

  service = await createService(moodDir, safeStorage).init();
  assert.equal(service.state.mood, '平静', 'the neutralized state survives restart');
  assert.equal(service.moodSourceId, null);
  assert.doesNotMatch((await service.context('你好', { budget: 8500 })).text, /虚拟表现状态：关切/);
  await service.close();

  // Older encrypted state has no mood source ID. Deleting a user record must
  // conservatively reset a non-neutral mood instead of preserving an opaque effect.
  const legacyDir = path.join(temp, 'legacy-mood-vault');
  service = await createService(legacyDir, safeStorage).init();
  const legacyMessage = await service.addMessage('user', '普通旧消息');
  await service.write([{ id: 'companion-state', kind: 'state', ts: service.clock(), value: {
    mood: '关切', energy: 0.7, warmth: 0.7, updatedAt: service.clock(), interactions: 1,
    userMessagesSeen: 1, lastExtractCount: 0, sources: [],
  } }]);
  await service.close();
  service = await createService(legacyDir, safeStorage).init();
  assert.equal(service.moodSourceId, null);
  await service.remove(legacyMessage.id);
  assert.equal(service.state.mood, '平静', 'legacy state without provenance is cleared conservatively');
  assert.equal((await service.query('state', 1))[0].value.moodSourceId, undefined);
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

async function testContextReferences(temp, safeStorage) {
  let enabled = true;
  const service = await createService(path.join(temp, 'reference-vault'), safeStorage, {
    settings: { get enabled() { return enabled; }, extract: false },
  }).init();
  const source = await service.addMessage('user', 'reference alpha source phrase');
  await service.write([
    { id: 'reference-memory', kind: 'memory', ts: source.ts + 1, value: {
      content: 'confirmed reference alpha memory', memoryKind: 'fact', status: 'confirmed', sources: [source.id],
    } },
    { id: 'reference-pending-memory', kind: 'memory', ts: source.ts + 2, value: {
      content: 'pending reference alpha candidate', memoryKind: 'candidate', status: 'pending', sources: [source.id],
    } },
    { id: 'reference-summary', kind: 'summary', ts: source.ts + 3, value: {
      content: 'reference alpha summary excerpt', sources: [source.id],
    } },
    { id: 'reference-old-message', kind: 'message', ts: Date.UTC(2001, 0, 1), value: {
      role: 'assistant', content: 'historical transcript-only yellow ziggurat marker', sources: [],
    } },
  ]);

  const included = await service.context('reference alpha summary', { budget: 5000 });
  const includedRefs = included.references;
  assert(includedRefs.some(r => r.id === 'reference-memory' && r.kind === 'memory'));
  assert(includedRefs.some(r => r.id === 'reference-summary' && r.kind === 'summary'));
  assert.equal(includedRefs.filter(r => r.id === 'reference-summary').length, 1, 'a summary matched in two sections must appear once');
  assert(!includedRefs.some(r => r.id === 'reference-pending-memory'), 'pending candidate must not be shown as a fact reference');
  assert(!includedRefs.some(r => r.id === 'reference-old-message'), 'ordinary old messages are not memory references');
  const memoryRef = includedRefs.find(r => r.id === 'reference-memory');
  assert.equal(memoryRef.content, 'confirmed reference alpha memory');
  assert.equal(memoryRef.ts, source.ts + 1);
  assert.deepEqual(memoryRef.sources, [source.id]);
  assert(included.text.includes(memoryRef.content), 'reference content must be the same content inserted into the prompt');
  assert(included.sourceIds.includes('reference-memory') && included.sourceIds.includes('reference-summary'), 'references supplement, not replace, sourceIds');
  assert(included.text.includes('不要把检索相似当作事实'), 'prompt must instruct the model to clarify ambiguous identity/relations');

  const oldMessageContext = await service.context('historical transcript-only yellow ziggurat', { budget: 5000 });
  assert(oldMessageContext.text.includes('historical transcript-only yellow ziggurat marker'));
  assert(oldMessageContext.sourceIds.includes('reference-old-message'), 'sourceIds must continue to include injected old messages');
  assert(!oldMessageContext.references.some(r => r.id === 'reference-old-message'), 'old transcript rows never become memory references');

  const recentContext = await service.context('quasar unicorn 7f31', {
    recent: [{ role: 'user', content: 'recent-only marker' }], budget: 5000,
  });
  assert(!recentContext.references.some(r => r.id === source.id || r.kind === 'message'), 'recent messages are not memory references');
  const internalContext = await service.context('reference alpha summary', { internal: true, budget: 5000 });
  assert.deepEqual(internalContext.references, [], 'internal context without historical records has no references');

  const cutSource = await service.addMessage('user', 'budget cut reference marker');
  await service.write([{ id: 'reference-cut-memory', kind: 'memory', ts: cutSource.ts + 1, value: {
    content: 'budget cut reference marker ' + '长内容'.repeat(260), memoryKind: 'fact', status: 'confirmed', sources: [cutSource.id],
  } }]);
  const cutContext = await service.context('budget cut reference marker', { budget: 1000 });
  assert(!cutContext.text.includes('budget cut reference marker'));
  assert(!cutContext.references.some(r => r.id === 'reference-cut-memory'), 'a row that did not fit the history budget must not be listed as a reference');

  const beforeDelete = await service.context('reference alpha summary', { budget: 5000 });
  assert(beforeDelete.references.some(r => r.id === 'reference-memory'));
  await service.remove('reference-memory');
  const afterDelete = await service.context('reference alpha summary', { budget: 5000 });
  assert(!afterDelete.references.some(r => r.id === 'reference-memory' || r.id === 'reference-summary'), 'deleted sources cannot remain in new references');

  enabled = false;
  const disabledContext = await service.context('reference alpha summary', {
    recent: [{ role: 'user', content: 'current turn only' }], budget: 1000,
  });
  assert.deepEqual(disabledContext.references, [], 'disabled memory falls back without historical references');
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

async function testRestoreTopologyAndRollback(temp, safeStorage) {
  const passphrase = 'test-only-topology-passphrase';
  const target = await createService(path.join(temp, 'topology-target-vault'), safeStorage).init();
  await target.personaRevision({ name: '默认伙伴', profile: '仅测试', ownerName: '用户' });
  const parentA = { id: 'topology-parent-a', kind: 'message', ts: 10,
    value: { role: 'user', content: 'first parent source', sources: [] } };
  const parentB = { id: 'topology-parent-b', kind: 'message', ts: 20,
    value: { role: 'user', content: 'second parent source', sources: [] } };
  const summary = { id: 'topology-two-parent-summary', kind: 'summary', ts: 30,
    value: { content: 'derived from both parents', sources: [parentA.id, parentB.id] } };
  const memory = { id: 'topology-child-memory', kind: 'memory', ts: 40,
    value: { content: 'multi-parent restored fact marker', status: 'confirmed', memoryKind: 'fact',
      evidence: 'derived from both parents', sources: [summary.id] } };
  const childFirstBackup = await vc.exportEnvelope({ format: 1, exportedAt: Date.now(),
    records: [memory, summary, parentB, parentA] }, passphrase);
  const restored = await target.restore(childFirstBackup, passphrase);
  assert.equal(restored.records, 4);
  const imported = await target.db.request('get', { ids: [parentA.id, parentB.id, summary.id, memory.id] });
  assert.equal(imported.rows.length, 4, 'out-of-order parents and child should all restore');
  assert((await target.search('multi-parent restored fact marker', ['memory'], 5)).some(r => r.id === memory.id));
  assert.deepEqual((await target.query('memory', 1))[0].value.sources, [summary.id]);
  assert.deepEqual((await target.query('summary', 1))[0].value.sources, [parentA.id, parentB.id]);
  await target.close();

  const cycleTarget = await createService(path.join(temp, 'cycle-target-vault'), safeStorage).init();
  await cycleTarget.personaRevision({ name: '默认伙伴', profile: '仅测试', ownerName: '用户' });
  const cycleBackup = await vc.exportEnvelope({ format: 1, exportedAt: Date.now(), records: [
    { id: 'cycle-a', kind: 'summary', ts: 1, value: { content: 'cycle A', sources: ['cycle-b'] } },
    { id: 'cycle-b', kind: 'summary', ts: 2, value: { content: 'cycle B', sources: ['cycle-a'] } },
  ] }, passphrase);
  await assert.rejects(cycleTarget.restore(cycleBackup, passphrase), /来源关系有循环/);
  assert.equal((await cycleTarget.db.request('stats')).counts.total, 1, 'cycle rejection must not clear the existing fresh persona');
  assert.equal((await cycleTarget.db.request('stats')).counts.persona, 1);

  const selfBackup = await vc.exportEnvelope({ format: 1, exportedAt: Date.now(), records: [
    { id: 'self-reference', kind: 'message', ts: 3,
      value: { role: 'user', content: 'self reference', sources: ['self-reference'] } },
  ] }, passphrase);
  await assert.rejects(cycleTarget.restore(selfBackup, passphrase), /不能引用自身/);
  assert.equal((await cycleTarget.db.request('stats')).counts.persona, 1, 'self-reference rejection leaves the destination unchanged');
  await cycleTarget.close();

  const rollback = await createService(path.join(temp, 'restore-rollback-vault'), safeStorage).init();
  const invalidRecord = { id: 'rollback-too-large', kind: 'message', ts: 201,
    value: { role: 'user', content: 'x'.repeat(2 * 1024 * 1024), sources: [] } };
  const manyValid = Array.from({ length: 200 }, (_, i) => ({ id: `rollback-valid-${String(i).padStart(3, '0')}`,
    kind: 'message', ts: i, value: { role: 'user', content: `rollback batch ${i}`, sources: [] } }));
  const failingBackup = await vc.exportEnvelope({ format: 1, exportedAt: Date.now(), records: [...manyValid, invalidRecord] }, passphrase);
  await assert.rejects(rollback.restore(failingBackup, passphrase), /Vault request failed/);
  const emptyAfterFailure = await rollback.db.request('stats');
  assert.equal(emptyAfterFailure.counts.total, 0, 'a failed later batch must clear earlier committed batches');
  await rollback.close();
}

async function testRestoreExportScale(temp, safeStorage) {
  const messageCount = 6000, memoryCount = 600;
  const sourceDir = path.join(temp, 'restore-scale-source-vault');
  const source = await createService(sourceDir, safeStorage).init();
  const start = Date.UTC(2016, 0, 1), end = Date.UTC(2026, 0, 1);
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    id: `restore-scale-message-${String(i).padStart(5, '0')}`, kind: 'message',
    ts: Math.round(start + (end - start) * i / (messageCount - 1)),
    value: { role: i % 2 ? 'assistant' : 'user', content: `Synthetic migration sample ${i}: fictional travel note.`, sources: [] },
  }));
  for (let i = 0; i < messages.length; i += 200) await source.write(messages.slice(i, i + 200), source.epoch, { notify: false });
  const memories = Array.from({ length: memoryCount }, (_, i) => {
    const sourceIndex = i * 10, sourceId = messages[sourceIndex].id;
    return { id: `restore-scale-memory-${String(i).padStart(4, '0')}`, kind: 'memory', ts: messages[sourceIndex].ts,
      value: { content: i === 0 ? 'synthetic oldest anchor for restore check' : `Synthetic migration memory ${i}: fictional route note.`,
        memoryKind: 'fact', status: 'confirmed', evidence: messages[sourceIndex].value.content,
        sources: i === 0 ? [sourceId, messages[sourceIndex + 2].id] : [sourceId] } };
  });
  for (let i = 0; i < memories.length; i += 200) await source.write(memories.slice(i, i + 200), source.epoch, { notify: false });

  const passphrase = 'test-only-scale-restore-passphrase';
  const exportStart = performance.now();
  const backup = await source.export(passphrase);
  const exportMs = performance.now() - exportStart;
  const target = await createService(path.join(temp, 'restore-scale-target-vault'), safeStorage).init();
  const restoreStart = performance.now();
  const result = await target.restore(backup, passphrase);
  const restoreMs = performance.now() - restoreStart;
  assert.equal(result.records, messageCount + memoryCount);
  const anchor = (await target.db.request('get', { ids: [memories[0].id, messages[0].id, messages[2].id] })).rows;
  assert.equal(anchor.length, 3);
  const decoded = new Map(anchor.map(row => [row.id, target.decode(row)]));
  assert.deepEqual(decoded.get(memories[0].id).value.sources, [messages[0].id, messages[2].id]);
  assert.equal(decoded.get(messages[0].id).value.role, 'user');
  assert.equal(decoded.get(messages[2].id).value.role, 'user');
  assert((await target.search('synthetic oldest anchor restore check', ['memory'], 5)).some(row => row.id === memories[0].id));
  const sourceCount = (await target.db.request('get', { ids: decoded.get(memories[0].id).value.sources })).rows.length;
  assert.equal(sourceCount, 2, 'restored oldest fact retains both source records');
  const stats = await target.stats();
  assert.equal(stats.counts.message, messageCount);
  assert.equal(stats.counts.memory, memoryCount);
  console.log(`[memory-restore-scale] records=${result.records} export_ms=${exportMs.toFixed(1)} restore_ms=${restoreMs.toFixed(1)} sources_ok=${sourceCount}`);
  await source.close();
  await target.close();
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
    await testChangeNotifications(temp, safeStorage);
    await testAsyncKeyOpening(temp, safeStorage);
    await testAssistantLineageDeletionAndCorrection(temp, safeStorage);
    await testCorrectionInvalidatesSource(temp, safeStorage);
    await testReviewedEditAndMoodForget(temp, safeStorage);
    await testOldExtractionCannotResurrectDeletedSource(temp, safeStorage);
    await testExtractionEvidenceAndPeriodicTrigger(temp, safeStorage);
    await testCancelledExtractionDoesNotCommitAndCanRetry(temp, safeStorage);
    await testContextBudgetAndDisabledFallback(temp, safeStorage);
    await testContextReferences(temp, safeStorage);
    await testAnniversaryIndexAndClearCount(temp, safeStorage);
    await testLegacyUnknownTimeIsNotInvented(temp, safeStorage);
    await testRestoreTopologyAndRollback(temp, safeStorage);
    await testRestoreExportScale(temp, safeStorage);
    await testExportRestorePaginationAndOldTimes(temp, safeStorage);
    testLunarDates();
    console.log('MemoryService integration checks passed');
  } finally {
    await Promise.all([...activeServices].map(item => item.close().catch(() => {})));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
