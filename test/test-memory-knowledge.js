'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { createSemanticDream } = require('../src/main/semantic-dream');
const { marker, typeOf } = require('../src/main/knowledge-records');

const ROOT = path.resolve(__dirname, '..');
const VAULT_BIN = path.join(ROOT, 'bin', 'vault');
const TEST_KEY = Buffer.alloc(32, 0x37);
const RESTORE_KEY = Buffer.alloc(32, 0x82);
const PASSPHRASE = 'memory-knowledge-test-only-restore-key';

function createService(dir, { key = TEST_KEY, scene = 'life', clock,
  persona = { name: '小兔', ownerName: '主人', profile: '共通设定', sceneProfiles: { private: '', life: '', work: '' } } } = {}) {
  const settings = { scene };
  const service = new MemoryService({ dir, bin: VAULT_BIN, openKey: async () => Buffer.from(key),
    getSettings: () => ({ enabled: true, extract: false, ...settings }), getPersona: () => persona, clock,
    extract: async () => [] });
  return { service, settings, persona };
}

async function readyService(dir, opts) {
  const bundle = createService(dir, opts);
  await bundle.service.init();
  assert.equal(bundle.service.ready, true, `temporary vault opens: ${bundle.service.error}`);
  return bundle;
}

async function addPairs(memory, pairs, { domain = 'work', floor = domain === 'work' ? 0 : domain === 'life' ? 1 : 2 } = {}) {
  const messages = [], memories = [], expected = [];
  for (const pair of pairs) {
    const leftId = crypto.randomUUID(), rightId = crypto.randomUUID();
    const leftSource = crypto.randomUUID(), rightSource = crypto.randomUUID();
    const leftQuote = pair.leftQuote || `我在${pair.topic}这件事上是支持的。`;
    const rightQuote = pair.rightQuote || `我在${pair.topic}这件事上是不支持的。`;
    const key = pair.key || `fixture.${crypto.randomUUID()}`;
    messages.push({ id: leftSource, kind: 'message', ts: pair.ts || Date.now(), domain, visibilityFloor: floor,
      value: { role: 'user', content: leftQuote, sources: [] } });
    messages.push({ id: rightSource, kind: 'message', ts: (pair.ts || Date.now()) + 1, domain, visibilityFloor: floor,
      value: { role: 'user', content: rightQuote, sources: [] } });
    memories.push({ id: leftId, kind: 'memory', ts: (pair.ts || Date.now()) + 2, domain, visibilityFloor: floor,
      value: { content: pair.left || `${pair.topic}支持`, key, tags: [pair.tag || pair.topic], memoryKind: 'fact', status: 'confirmed',
        origin: 'user-statement', evidence: leftQuote, evidenceSourceId: leftSource, sources: [leftSource] } });
    memories.push({ id: rightId, kind: 'memory', ts: (pair.ts || Date.now()) + 3, domain, visibilityFloor: floor,
      value: { content: pair.right || `${pair.topic}不支持`, key, tags: [pair.tag || pair.topic], memoryKind: 'fact', status: 'confirmed',
        origin: 'user-statement', evidence: rightQuote, evidenceSourceId: rightSource, sources: [rightSource] } });
    expected.push({ topic: pair.topic, leftId, rightId, leftSource, rightSource, key });
  }
  await memory.write(messages, memory.epoch, { notify: false });
  await memory.write(memories, memory.epoch, { notify: false });
  return expected;
}

function contradiction(inputs) {
  return { relations: [{ type: 'contradiction', recordIds: inputs.map(row => row.id),
    evidence: inputs.map(row => ({ recordId: row.id, sourceId: row.evidence.sourceId, quote: row.evidence.quote })),
    conditionStatus: 'not_stated', temporalStatus: 'not_stated' }] };
}

async function runDream(memory) {
  const worker = createSemanticDream({ memory, analyze: async inputs => contradiction(inputs) });
  let result;
  for (let n = 0; n < 10; n++) {
    result = await worker.run();
    assert.equal(result.status, 'done');
    if (!result.more) return result;
  }
  throw new Error('semantic dream did not drain fixture pages');
}

async function getKnowledgeRows(memory, scene, category = 'doubt') {
  return (await memory.knowledge.list({ category, scene })).rows;
}

async function testChoosePrivateDoesNotRewriteWork(dir) {
  let now = Date.UTC(2026, 9, 27);
  const { service, settings, persona } = await readyService(dir, { scene: 'work', clock: () => now++ });
  try {
    const [pair] = await addPairs(service, [{ topic: '午餐茶饮', left: '午餐喝无糖茶', right: '午餐不喝无糖茶',
      leftQuote: '我午餐会喝无糖茶。', rightQuote: '我午餐不喝无糖茶。', tag: '无糖茶' }]);
    await runDream(service);
    const synced = await service.knowledge.sync();
    assert.equal(synced.status, 'done');
    assert.equal(synced.created, 1);
    const [open] = await getKnowledgeRows(service, 'work');
    assert(open && open.status === 'open');
    const personaBefore = structuredClone(persona);

    settings.scene = 'private';
    await service.changeScene('private');
    const resolved = await service.knowledge.resolve(open.id, { action: 'choose', choiceId: pair.leftId, note: '私密核对备注-仅私人可见' });
    assert.equal(resolved.ok, true);
    const privateMemory = await service.query('memory', 100, { scene: 'private', domain: 'work', visibilityFloor: 2 });
    const reviewed = privateMemory.find(row => row.id === resolved.factId);
    assert(reviewed);
    assert.equal(reviewed.value.origin, 'user-reviewed-doubt');
    assert.equal(reviewed.domain, 'work');
    assert.equal(reviewed.visibilityFloor, 2, 'a private resolution is private even when its source fact is work scoped');

    const workOriginals = await service.query('memory', 20, { scene: 'work', domain: 'work', visibilityFloor: 0 });
    assert.equal(workOriginals.length, 2);
    assert(workOriginals.every(row => row.value.status === 'confirmed'));
    assert.deepEqual(workOriginals.map(row => row.value.content).sort(), ['午餐不喝无糖茶', '午餐喝无糖茶']);
    const workContext = await service.knowledge.context('无糖茶', { scene: 'work' });
    assert(!workContext.text.includes('用户已核对的当前说法'));
    assert(!workContext.text.includes('私密核对备注-仅私人可见'));
    assert(!workContext.text.includes('用户已核对的当前说法'));
    const workDoubt = await getKnowledgeRows(service, 'work');
    assert.equal(workDoubt[0].status, 'open', 'private choice does not resolve the work-visible question');
    const lifeContext = await service.knowledge.context('无糖茶', { scene: 'life' });
    assert(!lifeContext.text.includes('私密核对备注-仅私人可见'), 'life cannot read private decision data');
    assert(!lifeContext.text.includes('用户已核对的当前说法'), 'life cannot read a private resolution');
    const privateContext = await service.knowledge.context('无糖茶', { scene: 'private' });
    assert(privateContext.text.includes('用户已核对的当前说法：午餐喝无糖茶'));
    assert.deepEqual(persona, personaBefore, 'explicit fact resolution leaves the common persona untouched');
    const decision = (await service.query('state', 30, { scene: 'private', requiredMarkers: [marker('decision')] }))
      .find(row => row.value.questionId === open.id);
    assert(decision && decision.visibilityFloor === 2);
    assert(!workDoubt.some(row => row.id === decision.id));
  } finally { await service.close(); }
}

async function testSameFloorBothSnoozeDismissAndContext(dir) {
  let now = Date.UTC(2026, 9, 27);
  const { service } = await readyService(dir, { scene: 'life', clock: () => now++ });
  try {
    const pairs = await addPairs(service, [
      { topic: '周末运动', left: '周末跑步', right: '周末不跑步', leftQuote: '我周末会跑步。', rightQuote: '我周末不会跑步。', tag: '跑步' },
      { topic: '工作音乐', left: '工作时听纯音乐', right: '工作时不听纯音乐', leftQuote: '工作时我喜欢听纯音乐。', rightQuote: '工作时我不喜欢听纯音乐。', tag: '纯音乐' },
      { topic: '晚餐甜点', left: '晚餐吃甜点', right: '晚餐不吃甜点', leftQuote: '晚餐我会吃甜点。', rightQuote: '晚餐我不会吃甜点。', tag: '甜点' },
      { topic: '早晨散步', left: '早晨散步', right: '早晨不散步', leftQuote: '我早晨会散步。', rightQuote: '我早晨不会散步。', tag: '散步' },
    ], { domain: 'life', floor: 1 });
    await runDream(service);
    await service.knowledge.sync();
    const doubts = await getKnowledgeRows(service, 'life');
    const chooseBoth = doubts.find(row => row.memberChoices.some(item => item.content === '周末跑步'));
    const snooze = doubts.find(row => row.memberChoices.some(item => item.content === '工作时听纯音乐'));
    const dismiss = doubts.find(row => row.memberChoices.some(item => item.content === '晚餐吃甜点'));
    const sameFloorChoose = doubts.find(row => row.memberChoices.some(item => item.content === '早晨散步'));
    assert(chooseBoth && snooze && dismiss && sameFloorChoose);
    await assert.rejects(service.knowledge.resolve(chooseBoth.id, { action: 'both', scene: 'life' }), /请补充两种情况各自适用的条件/u);
    const bothFirst = await service.knowledge.resolve(chooseBoth.id, { action: 'both', note: '仅天气适宜时跑步；雨天在家休息。', scene: 'life' });
    assert(bothFirst.factId);
    assert.equal((await service.knowledge.resolve(snooze.id, { action: 'snooze', scene: 'life' })).ok, true);
    assert.equal((await service.knowledge.resolve(dismiss.id, { action: 'dismiss', scene: 'life' })).ok, true);
    const chosenFirst = await service.knowledge.resolve(sameFloorChoose.id, { action: 'choose', choiceId: sameFloorChoose.memberChoices[0].id, scene: 'life' });
    assert(chosenFirst.factId);
    const chosenAgain = await service.knowledge.resolve(sameFloorChoose.id, { action: 'choose', choiceId: sameFloorChoose.memberChoices[1].id, scene: 'life' });
    assert(chosenAgain.factId);
    assert.notEqual(chosenAgain.factId, chosenFirst.factId);
    const bothAgain = await service.knowledge.resolve(chooseBoth.id, { action: 'both', note: '更新条件：降雨时改在室内运动。', scene: 'life' });
    assert(bothAgain.factId, 'a later both decision creates a replacement fact');

    const after = await getKnowledgeRows(service, 'life');
    assert.equal(after.find(row => row.id === chooseBoth.id).status, 'resolved');
    assert.equal(after.find(row => row.id === snooze.id).status, 'snoozed');
    assert.equal(after.find(row => row.id === dismiss.id).status, 'dismissed');
    assert.equal(after.find(row => row.id === sameFloorChoose.id).status, 'resolved');
    const bothContext = await service.knowledge.context('周末运动', { scene: 'life', budget: 600 });
    assert(bothContext.text.includes('用户已说明适用条件：更新条件：降雨时改在室内运动。'));
    assert(!bothContext.text.includes('只在本轮确实相关时简短核对'));
    assert(bothContext.text.length <= 600);
    const chosenContext = await service.knowledge.context('早晨散步', { scene: 'life' });
    assert(chosenContext.text.includes('用户已核对的当前说法'));
    assert(!chosenContext.text.includes('只在本轮确实相关时简短核对'), 'same-floor choice suppresses the open question');
    const allLifeFacts = await service.query('memory', 50, { scene: 'life', domain: 'life', visibilityFloor: 1 });
    const reconciled = await service.knowledge.applyResolutions(allLifeFacts, { scene: 'life' });
    const reviewedDoubtFacts = reconciled.facts.filter(row => row.value.origin === 'user-reviewed-doubt');
    assert.deepEqual(reviewedDoubtFacts.map(row => row.id).sort(), [bothAgain.factId, chosenAgain.factId].sort(),
      'repeated choose/both decisions hide stale reviewed facts and retain only the latest per question');
    assert(reconciled.suppressed.includes(chosenFirst.factId), 'the replaced reviewed fact is suppressed by its newer decision');
    assert(reconciled.suppressed.includes(bothFirst.factId), 'updated both conditions suppress the earlier reviewed conditions');
    const integrated = await service.context('早晨散步', { scene: 'life', budget: 6000 });
    assert(integrated.references.some(row => row.id === chosenAgain.factId), 'main context includes the current reviewed choice');
    assert(!integrated.references.some(row => row.id === chosenFirst.factId), 'main context does not retain an old chosen fact');
    const integratedBoth = await service.context('周末运动', { scene: 'life', budget: 6000 });
    assert(integratedBoth.references.some(row => row.id === bothAgain.factId), 'main context includes the current conditions');
    assert(!integratedBoth.references.some(row => row.id === bothFirst.factId), 'main context does not retain old conditions');
    const snoozeContext = await service.knowledge.context('工作音乐', { scene: 'life' });
    assert.equal(snoozeContext.text, '');
    const dismissContext = await service.knowledge.context('晚餐甜点', { scene: 'life' });
    assert.equal(dismissContext.text, '');
    const mainSnooze = await service.context('工作音乐', { scene: 'life', budget: 6000 });
    assert(!mainSnooze.references.some(row => [snooze.memberChoices[0].id, snooze.memberChoices[1].id].includes(row.id)),
      'main context must not reintroduce the snoozed pair as ordinary confirmed memories');
    const mainDismiss = await service.context('晚餐甜点', { scene: 'life', budget: 6000 });
    assert(!mainDismiss.references.some(row => [dismiss.memberChoices[0].id, dismiss.memberChoices[1].id].includes(row.id)),
      'main context must not reintroduce the dismissed pair as ordinary confirmed memories');
    now += 8 * 86400000;
    assert.equal((await getKnowledgeRows(service, 'life')).find(row => row.id === snooze.id).status, 'open',
      'a snooze expires instead of suppressing the question forever');
    const afterSnoozeExpiry = await service.knowledge.context('工作音乐', { scene: 'life' });
    assert(afterSnoozeExpiry.text.includes('只在本轮确实相关时简短核对'));
    const again = await service.knowledge.sync();
    assert.equal(again.created, 0, 'unchanged relation signatures do not recreate resolved or dismissed doubts');
    assert.equal((await getKnowledgeRows(service, 'life')).length, 4);
  } finally { await service.close(); }
}

async function testChangedEvidenceInvalidatesDoubt(dir) {
  let now = Date.UTC(2026, 9, 27);
  const { service } = await readyService(dir, { scene: 'work', clock: () => now++ });
  try {
    const [pair] = await addPairs(service, [{ topic: '咖啡时间', left: '早上喝咖啡', right: '早上不喝咖啡',
      leftQuote: '我早上喝咖啡。', rightQuote: '我早上不喝咖啡。', tag: '咖啡' }]);
    await runDream(service);
    await service.knowledge.sync();
    const [question] = await getKnowledgeRows(service, 'work');
    assert(question);
    await service.knowledge.resolve(question.id, { action: 'choose', choiceId: pair.leftId, scene: 'work' });
    const source = (await service.query('message', 20, { scene: 'work' })).find(row => row.id === pair.rightSource);
    assert(source);
    await service.write([{ ...source, updatedAt: now++, value: { ...source.value, content: '我早上偶尔不喝咖啡。' } }]);
    assert.equal((await getKnowledgeRows(service, 'work')).length, 0, 'changed source snapshots invalidate the doubt on read');
    const context = await service.knowledge.context('咖啡', { scene: 'work' });
    assert(!context.text.includes('只在本轮确实相关时简短核对'), 'stale question is not injected into context');
    const allFacts = await service.query('memory', 20, { scene: 'work', domain: 'work', visibilityFloor: 0 });
    const applied = await service.knowledge.applyResolutions(allFacts, { scene: 'work' });
    assert(applied.rows.some(row => row.id === pair.rightId), 'resolution of the old pair must not suppress the changed member');
    assert(!applied.suppressed.includes(pair.rightId));
  } finally { await service.close(); }
}

async function testFreshKeyRestoreKeepsDecision(dir) {
  let now = Date.UTC(2026, 9, 27);
  const source = await readyService(path.join(dir, 'source'), { scene: 'private', clock: () => now++ });
  let destination;
  try {
    const [pair] = await addPairs(source.service, [{ topic: '旅行方式', left: '旅行坐火车', right: '旅行不坐火车',
      leftQuote: '旅行时我喜欢坐火车。', rightQuote: '旅行时我不喜欢坐火车。', tag: '火车' }], { domain: 'private', floor: 2 });
    await runDream(source.service);
    await source.service.knowledge.sync();
    const [question] = await getKnowledgeRows(source.service, 'private');
    assert(question);
    await source.service.knowledge.resolve(question.id, { action: 'choose', choiceId: pair.leftId, scene: 'private' });
    const relationCount = (await source.service.query('state', 100, { scene: null, requiredMarkers: [marker('relation')] })).length;
    const doubtCount = (await source.service.query('state', 100, { scene: null, requiredMarkers: [marker('doubt')] })).length;
    const decisionRows = await source.service.query('state', 100, { scene: null, requiredMarkers: [marker('decision')] });
    assert.equal(decisionRows.length, 1);
    const decisionIdBefore = decisionRows[0].id;
    const acceptedFactIds = (await source.service.query('memory', 30, { scene: null })).filter(row => row.value.origin === 'user-reviewed-doubt').map(row => row.id);
    const backup = await source.service.export(PASSPHRASE);

    destination = await readyService(path.join(dir, 'destination'), { key: RESTORE_KEY, scene: 'private', clock: () => now + 86_400_000 });
    const restored = await destination.service.restore(backup, PASSPHRASE);
    assert.equal(restored.ok, true);
    const sync = await destination.service.knowledge.sync();
    assert.equal(sync.created, 0);
    const restoredDecision = await destination.service.query('state', 100, { scene: null, requiredMarkers: [marker('decision')] });
    assert.equal(restoredDecision.length, 1);
    assert.equal(restoredDecision[0].id, decisionIdBefore, 'deterministic decision ID survives vault-key rotation');
    const restoredFacts = (await destination.service.query('memory', 30, { scene: null })).filter(row => row.value.origin === 'user-reviewed-doubt');
    assert.deepEqual(restoredFacts.map(row => row.id), acceptedFactIds);
    assert.equal((await destination.service.query('state', 100, { scene: null, requiredMarkers: [marker('relation')] })).length, relationCount);
    assert.equal((await destination.service.query('state', 100, { scene: null, requiredMarkers: [marker('doubt')] })).length, doubtCount);
    const context = await destination.service.knowledge.context('火车', { scene: 'private' });
    assert(context.text.includes('用户已核对的当前说法'));
    assert(!context.text.includes('只在本轮确实相关时简短核对'));
  } finally {
    await source.service.close();
    if (destination) await destination.service.close();
  }
}

async function testFortyRowSyncPaging(dir) {
  let now = Date.UTC(2026, 9, 27);
  const { service } = await readyService(dir, { scene: 'work', clock: () => now++ });
  try {
    const pairs = Array.from({ length: 45 }, (_, index) => ({ topic: `批次主题${index}`, tag: `批次主题${index}`,
      key: `fixture.paging.${index}.${crypto.randomUUID()}`, left: `主题${index}支持`, right: `主题${index}不支持`,
      leftQuote: `关于主题${index}，我明确支持。`, rightQuote: `关于主题${index}，我明确不支持。` }));
    await addPairs(service, pairs, { domain: 'work', floor: 0 });
    await runDream(service);
    const first = await service.knowledge.sync();
    assert.equal(first.status, 'done');
    assert.equal(first.created, 40, 'sync limits its relation scan to 40 rows');
    assert.equal(first.more, true, 'remaining relations are signaled for another bounded call');
    const second = await service.knowledge.sync();
    assert.equal(second.status, 'done');
    assert.equal(second.created, 5);
    assert.equal(second.more, false);
    assert.equal((await getKnowledgeRows(service, 'work')).length, 45, 'continued cursor scans every relation once');
    assert.equal((await service.knowledge.sync()).created, 0, 'completed cursor does not duplicate questions');
  } finally { await service.close(); }
}

async function testContextBudgetAndSceneIsolation(dir) {
  let now = Date.UTC(2026, 9, 27);
  const { service, settings } = await readyService(dir, { scene: 'private', clock: () => now++ });
  let analyzeCalls = 0;
  try {
    const [pair] = await addPairs(service, [{ topic: '工作排期', left: '周一完成代码评审', right: '周一不做代码评审',
      leftQuote: '工作场景中我周一完成代码评审。', rightQuote: '工作场景中我周一不做代码评审。', tag: '代码评审' }],
      { domain: 'work', floor: 0 });
    const worker = createSemanticDream({ memory: service, analyze: async inputs => { analyzeCalls++; return contradiction(inputs); } });
    for (let i = 0; i < 10; i++) { const result = await worker.run(); assert.equal(result.status, 'done'); if (!result.more) break; }
    await service.knowledge.sync();
    const workQuestion = (await getKnowledgeRows(service, 'private'))[0];
    assert(workQuestion);
    const privateContext = await service.knowledge.context('代码评审', { budget: 94 });
    assert(privateContext.text.length <= 94, 'context never exceeds requested budget');
    assert(privateContext.sourceIds.length > 0);
    settings.scene = 'work'; await service.changeScene('work');
    const workContext = await service.knowledge.context('代码评审', { budget: 1200 });
    assert(workContext.text.includes('只在本轮确实相关时简短核对'));
    const privateChoice = workQuestion.memberChoices[0];
    settings.scene = 'private'; await service.changeScene('private');
    await service.knowledge.resolve(workQuestion.id, { action: 'choose', choiceId: privateChoice.id });
    settings.scene = 'work'; await service.changeScene('work');
    const afterWorkMode = await service.knowledge.context('代码评审', { budget: 1200 });
    assert(afterWorkMode.text.includes('只在本轮确实相关时简短核对'), 'active work mode does not read private decision');
    settings.scene = 'private'; await service.changeScene('private');
    const afterPrivateMode = await service.knowledge.context('代码评审', { budget: 1200 });
    assert(afterPrivateMode.text.includes('用户已核对的当前说法'));
    assert(!afterPrivateMode.text.includes('private'), 'context contains user facts but no internal mode label');
    const beforeUnrelated = analyzeCalls;
    const unrelated = await service.context('今天想聊聊草莓种植和园艺', { budget: 1400 });
    assert(unrelated.used <= 1400, 'full MemoryService context fits its total char budget');
    assert.equal(unrelated.recalled, 0, 'lexically unrelated semantic facts are not recalled');
    assert.equal(analyzeCalls, beforeUnrelated, 'context assembly performs no extra model call');
  } finally { await service.close(); }
}

async function main() {
  if (!fs.existsSync(VAULT_BIN)) throw new Error(`Existing vault binary missing; test will not build it: ${VAULT_BIN}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-knowledge-'));
  try {
    await testChoosePrivateDoesNotRewriteWork(path.join(temp, 'private-choice'));
    await testSameFloorBothSnoozeDismissAndContext(path.join(temp, 'actions'));
    await testChangedEvidenceInvalidatesDoubt(path.join(temp, 'stale'));
    await testFreshKeyRestoreKeepsDecision(path.join(temp, 'restore'));
    await testFortyRowSyncPaging(path.join(temp, 'paging'));
    await testContextBudgetAndSceneIsolation(path.join(temp, 'context'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log('memory knowledge SQLite checks passed (scope, decisions, paging, restore, context)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
