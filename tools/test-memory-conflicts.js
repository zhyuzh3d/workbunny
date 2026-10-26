#!/usr/bin/env node
'use strict';

// Isolated SQLite integration coverage for source-aware user-fact conflicts.
// Uses the already-built vault binary and never opens the user's real store.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const key = Buffer.from('f594a20e3b7c49acb360a057e61915c9f594a20e3b7c49acb360a057e61915c9', 'hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-conflicts-'));
const services = [];
let tick = Date.UTC(2026, 9, 27);

function createService(name, scene = 'private') {
  const settings = { enabled: true, extract: false, scene };
  const memory = new MemoryService({ dir: path.join(temp, name), bin,
    getSettings: () => settings, openKey: async () => Buffer.from(key),
    clock: () => tick++, random: () => 0 });
  services.push(memory);
  return { memory, settings };
}

async function user(memory, content, scope = {}) {
  return memory.addMessage('user', content, scope);
}

async function memories(memory, scene = 'private') {
  return memory.query('memory', 200, { scene, sort: 'ingestion' });
}

async function birthdayConflict(memory, a = '我的生日是3月4日', b = '我出生于4月5日', scope = {}) {
  const oldSource = await user(memory, a, scope);
  const oldFact = (await memories(memory, scope.scene || 'private')).find(row => row.value.key === 'user.birthday' && row.value.status === 'confirmed');
  assert(oldFact, 'first explicit birthday should create a confirmed fact');
  const newSource = await user(memory, b, scope);
  const rows = await memories(memory, scope.scene || 'private');
  const conflict = rows.find(row => row.value.origin === 'user-key-conflict-v1' && row.value.status === 'pending');
  assert(conflict, 'different valid birthday should create a pending conflict');
  return { oldSource, oldFact, newSource, conflict };
}

async function testCanonicalSameBirthdayAndScopedConflict() {
  const { memory } = createService('same-birthday');
  await memory.init();
  await user(memory, '我的生日是3月4日');
  await user(memory, '我出生于3月4日');
  assert.deepEqual(await memory.relevantConflicts('我生日是哪天？', { scene: 'private' }), []);
  assert.equal((await memories(memory)).filter(row => row.value.key === 'user.birthday' && row.value.status === 'confirmed').length, 1,
    'same canonical birthday with different wording should remain one fact');

  const work = await user(memory, '我的生日是5月6日', { domain: 'work', visibilityFloor: 0 });
  await user(memory, '我出生于7月8日', { domain: 'life', visibilityFloor: 1 });
  const allVisible = await memories(memory, 'private');
  const workFact = allVisible.find(row => row.value.evidenceSourceId === work.id);
  assert(workFact, 'work-scope fact should be retained');
  assert(!allVisible.some(row => row.value.origin === 'user-key-conflict-v1' && row.value.conflictWith?.includes(workFact.id)),
    'different business domains must not conflict');
  assert.equal(allVisible.find(row => row.value.evidenceSourceId && row.value.evidenceSourceId !== work.id &&
    row.value.key === 'user.birthday')?.value.status, 'confirmed');

  const floorService = createService('floor-partition');
  await floorService.memory.init();
  await user(floorService.memory, '我的生日是11月12日', { domain: 'work', visibilityFloor: 0 });
  await user(floorService.memory, '我出生于12月13日', { domain: 'work', visibilityFloor: 1 });
  const floorRows = await memories(floorService.memory, 'life');
  assert(!floorRows.some(row => row.value.origin === 'user-key-conflict-v1'),
    'the same domain at different visibility floors must be partitioned');

  const isolated = createService('floor-isolation');
  await isolated.memory.init();
  await birthdayConflict(isolated.memory, '我的生日是8月9日', '我出生于9月10日', { domain: 'private', visibilityFloor: 2 });
  assert.deepEqual(await isolated.memory.relevantConflicts('我生日是哪天？', { scene: 'work' }), [],
    'private-floor conflict must not leak into work scene');
  const workContext = await isolated.memory.context('我生日是哪天？', { scene: 'work', budget: 4000 });
  assert(!workContext.text.includes('待核对的相关用户说法'));
}

async function testConflictContextAndResolution() {
  const { memory } = createService('resolution');
  await memory.init();
  const { oldSource, oldFact, newSource, conflict } = await birthdayConflict(memory);
  assert.equal(conflict.value.evidenceSourceId, newSource.id);
  assert(conflict.value.conflictWith.includes(oldFact.id));
  assert(conflict.value.sources.includes(newSource.id) && conflict.value.sources.includes(oldFact.id));

  const relevant = await memory.relevantConflicts('我生日是哪天？', { scene: 'private' });
  assert.equal(relevant.length, 1);
  assert.match(relevant[0].value.content, /previous/);
  assert.match(relevant[0].value.content, /later/);
  const context = await memory.context('我生日是哪天？', { scene: 'private', budget: 6000 });
  assert(context.text.includes('待核对的相关用户说法'));
  assert(context.text.includes('我的生日是3月4日'));
  assert(context.text.includes('我出生于4月5日'));
  const unrelated = await memory.context('今天晚饭吃什么？', { scene: 'private', budget: 6000 });
  assert(!unrelated.text.includes('待核对的相关用户说法'), 'unrelated question must not surface an unsolicited conflict');
  assert.deepEqual(await memory.relevantConflicts('今天晚饭吃什么？', { scene: 'private' }), []);

  await assert.rejects(memory.updateMemory(conflict.id, '我的生日是4月5日'), /采用这次说法|核对冲突/,
    'generic update must not confirm a conflict');
  const afterRejectedUpdate = (await memories(memory)).find(row => row.id === conflict.id);
  assert.equal(afterRejectedUpdate.value.status, 'pending');

  const resolved = await memory.resolveConflict(conflict.id);
  assert.equal(resolved.ok, true);
  const currentRows = await memories(memory);
  const direct = (await memory.db.request('get', { ids: [oldFact.id, conflict.id], scene: 'private' })).rows.map(row => memory.decode(row));
  const oldAfter = direct.find(row => row.id === oldFact.id);
  const newAfter = direct.find(row => row.id === conflict.id);
  assert.equal(oldAfter.state, 'superseded');
  assert.equal(oldAfter.value.status, 'superseded');
  assert.equal(oldAfter.value.content, '我的生日是3月4日', 'retiring a claim preserves its body');
  assert.equal(newAfter.value.status, 'confirmed');
  assert.equal(newAfter.value.origin, 'user-reviewed-conflict');
  assert.deepEqual(newAfter.value.sources, [newSource.id], 'resolved fact must cite only the selected user statement');
  assert.deepEqual(newAfter.value.conflictWith, []);
  assert(!newAfter.value.sources.includes(oldFact.id));

  const resolvedContext = await memory.context('我生日是哪天？', { scene: 'private', budget: 6000 });
  assert(!resolvedContext.text.includes('待核对的相关用户说法'), 'resolved conflict is no longer injected as pending');
  assert(resolvedContext.text.includes('用户已核对于'), 'context marks the explicit resolution time');
  assert(resolvedContext.text.includes('作为当前有效信息并替代此前不同说法'), 'context explains selected fact precedence');
  assert(resolvedContext.messages.some(message => message.content === oldSource.value.content), 'the old user statement remains in recent history');
  assert(resolvedContext.messages.some(message => message.content === newSource.value.content), 'the selected user statement remains in recent history');

  await memory.remove(oldSource.id);
  const afterOldSourceDeletion = (await memories(memory)).find(row => row.id === conflict.id);
  assert(afterOldSourceDeletion, 'deleting the retired source must not remove the newly confirmed independent claim');
  assert.equal(afterOldSourceDeletion.value.status, 'confirmed');
}

async function testPendingCandidateIsNotConflictAndSourceDeletion() {
  const { memory } = createService('candidate-and-delete');
  await memory.init();
  const source = await user(memory, '我喜欢周末去公园。');
  await memory.write([{ id: 'ordinary-doze-candidate', kind: 'memory', ts: tick++, domain: 'private', visibilityFloor: 2,
    value: { content: '候选生日：3月4日', key: 'user.birthday', memoryKind: 'fact', status: 'pending', origin: 'doze-candidate-v1',
      evidence: source.value.content, evidenceSourceId: source.id, sources: [source.id], importance: 0.5 } }]);
  assert.deepEqual(await memory.relevantConflicts('我生日是哪天？', { scene: 'private' }), [],
    'ordinary pending doze candidate is not a user-statement conflict');
  const candidateContext = await memory.context('我生日是哪天？', { scene: 'private', budget: 6000 });
  assert(!candidateContext.text.includes('待核对的相关用户说法'));

  const first = await birthdayConflict(memory, '我的生日是1月2日', '我出生于2月3日');
  await memory.remove(first.oldSource.id);
  assert.deepEqual(await memory.relevantConflicts('我生日是哪天？', { scene: 'private' }), [],
    'conflict becomes unavailable when its confirmed parent source is deleted');

  const second = await birthdayConflict(memory, '我的生日是6月7日', '我出生于10月11日');
  await memory.remove(second.newSource.id);
  assert.deepEqual(await memory.relevantConflicts('我生日是哪天？', { scene: 'private' }), [],
    'conflict becomes unavailable when its evidence source is deleted');
}

async function testChangedSourceRejected() {
  const { memory } = createService('changed-source');
  await memory.init();
  const { conflict, newSource } = await birthdayConflict(memory);
  // Simulate source drift without deleting the referenced ID. The resolver must
  // compare the pending snapshot to the live message and refuse to adopt it.
  const changed = { ...newSource, value: { ...newSource.value, content: '普通聊天文本，已不再是原生日陈述。' } };
  await memory.write([changed]);
  await assert.rejects(memory.resolveConflict(conflict.id), /来源已变化|不存在/);
  const unchangedConflict = (await memories(memory)).find(row => row.id === conflict.id);
  assert.equal(unchangedConflict.value.status, 'pending');
}

async function testStructuredFactEditing() {
  const { memory } = createService('structured-edits');
  await memory.init();
  await user(memory, '我的生日是3月4日');
  let birthday = (await memories(memory)).find(row => row.value.key === 'user.birthday' && row.value.status === 'confirmed');
  assert(birthday);
  await memory.updateMemory(birthday.id, '我的生日是10月12日');
  birthday = (await memories(memory)).find(row => row.value.key === 'user.birthday' && row.value.status === 'confirmed');
  assert.equal(birthday.value.canonicalValue, 'solar:10-12');
  assert.deepEqual(birthday.value.anniversary, { calendar: 'solar', month: 10, day: 12 });

  await user(memory, '我叫Alice');
  let name = (await memories(memory)).find(row => row.value.key === 'user.name' && row.value.status === 'confirmed');
  assert(name);
  await memory.updateMemory(name.id, '我叫Bob');
  name = (await memories(memory)).find(row => row.value.key === 'user.name' && row.value.status === 'confirmed');
  assert.equal(name.value.canonicalValue, 'bob');
  assert.equal(name.value.key, 'user.name');
  assert.equal(name.value.anniversary, undefined);
}

async function main() {
  assert(fs.existsSync(bin), `prebuilt vault binary missing: ${bin}`);
  try {
    await testCanonicalSameBirthdayAndScopedConflict();
    await testConflictContextAndResolution();
    await testPendingCandidateIsNotConflictAndSourceDeletion();
    await testChangedSourceRejected();
    await testStructuredFactEditing();
    console.log('memory conflict SQLite integration: ok');
  } finally {
    await Promise.allSettled(services.map(service => service.close()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
