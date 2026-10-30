'use strict';
// Real encrypted SQLite + real Secretary filesystem receipts. Model doubles
// make strategy/learning and cancellation deterministic; no account effects.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const { Secretary } = require('../src/main/secretary');
const { CompanionAutonomy } = require('../src/main/companion-autonomy');
const { readRecords, fingerprint } = require('../src/main/memory-evidence');
const { requestReply } = require('../src/main/reply-request');
const dc = require('../src/main/dialogue-cognition');
const refs = require('../src/main/memory-references');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-loop-')));
let now = new Date(2026, 9, 29, 10).getTime(), scene = 'life';
const m = new MemoryService({ dir: path.join(root, 'vault'), bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 31),
  clock: () => now++, getSettings: () => ({ scene, enabled: true, extract: false }) });
let worker, autonomy;
async function main() {
  await m.init(); assert(m.ready, m.error);
  let self = await m.cognition.ensure({ profile: '我好奇、乐于一起想办法，也愿意调整自己的理解。' });
  const u1 = await m.addMessage('user', '工作上的事让我很烦。');
  const a1 = await m.addMessage('assistant', '我们来列一个解决清单。', { sources: [u1.id], cognition: {
    schema: 'dialogue-cognition/v1', review: { grade: 'unassessed', note: '首次交流', grasp: 'insufficient', pace: 'explore' },
    prediction: '用户想一起列解决方案。', previousReplyId: null, dialogueId: 'owner:life', selfRevision: self.revision } });
  const u2 = await m.addMessage('user', '不是这个意思，我只是想先说说，你先听我说。');
  const frame = dc.context([u1, a1, u2], { dialogueId: 'owner:life' });
  assert.equal(frame.previousReplyId, a1.id);
  let calls = 0, presented = 0;
  const r = await requestReply({ chat: async options => {
    calls++; assert(options.messages.some(x => x.content.includes('review')));
    return { raw: JSON.stringify({ protocol: 'dialogue-v2', stages: [
      { stage: 'review', grade: 'opposite', note: '他想倾诉，不要继续建议。', grasp: 'adjust', pace: 'listen' },
      { stage: 'reply', reply: { kind: 'chat', text: '好，我听你说。最让你烦的是哪一段？<e>relaxed</e>' } },
      { stage: 'prediction', expect: '用户继续倾诉具体烦恼。' },
    ] }) };
  }, request: { cognitive: true, deferPresentation: true, messages: [{ role: 'user', content: JSON.stringify(frame.data) }],
    onDelta: () => presented++, onSentence: () => presented++ } });
  assert.equal(calls, 1); assert.equal(presented, 0); assert(!r.text.includes('opposite')); assert.deepEqual(r.emos, ['relaxed']);
  const a2 = await m.addMessage('assistant', r.text, { sources: [u2.id, a1.id], cognition: { ...r.cognition,
    previousReplyId: a1.id, dialogueId: 'owner:life', selfRevision: self.revision } });
  assert.equal((await m.search('opposite', ['message'], 20)).length, 0, 'hidden cognition never enters the search index');
  let extractCalls = 0;
  worker = new MemoryMaintenance({ memory: m, clock: () => now, setTimer: () => 1, clearTimer: () => {}, extract: async (input, options) => {
    extractCalls++; assert(options.analysisContext.feedback.some(f => f.review.grade === 'opposite'));
    return { processedThrough: input.at(-1).endMessageId || input.at(-1).id,
      memories: [{ sourceId: u2.id, content: '表达烦恼时，用户有时希望先倾诉，应先核对需要。', evidence: '我只是想先说说，你先听我说', memoryKind: 'relationship', keywords: ['倾诉需要'] }],
      selfChanges: [{ op: 'add', facet: 'behavior', text: '我倾向先辨别倾诉与求助；对方想倾诉时先听完，再问是否需要建议。', sourceIds: [u2.id, a2.id] }] };
  } });
  worker.request('dream'); await worker.tick(); assert.equal(worker.status().status, 'idle', worker.status().note);
  self = await m.cognition.loadRoleView(); assert(self.text.includes('先听完')); assert.equal(extractCalls, 1);
  assert((await m.query('memory', 30)).some(r => r.value.memoryKind === 'relationship'));
  worker.request('dream'); await worker.tick(); assert.equal(extractCalls, 1, 'no new evidence means no repeated learning');
  const learned = self.entries.find(e => e.facet === 'behavior');
  self = await m.cognition.commitPatch({ requestId: 'lock-all', baseRevision: self.revision, ops: [{ op: 'lock_all' }] }, { actor: 'owner', trustedUI: true });
  self = await m.cognition.saveSettings({ identity: '我有主见且热情', behavior: '所有时候先给建议', expectedRevision: self.revision });
  let lockedReflectionCalls = 0;
  worker.extract = async (_input, { analysisContext }) => { lockedReflectionCalls++; return { memories: [], selfChanges: [{ op: 'replace', entryId: learned.entryId,
    text: '我在所有时候都先给建议。', sourceIds: [analysisContext.settings.sourceId] }] }; };
  worker.requestReflection('settings', { manual: true }); await worker.tick();
  self = await m.cognition.loadRoleView(); assert(self.text.includes('先听完')); assert.equal(self.pendingSettings, true, 'locked settings stay pending until unlock');
  assert.equal(lockedReflectionCalls, 0, 'locked self understanding never invokes the reflection model');
  await assert.rejects(m.cognition.requestUnderstanding(), error => error.code === 'E_SELF_LOCKED');
  const lockedContext = await worker.cognitiveContext([], { settings: true, deep: true });
  assert.equal(lockedContext.self.updateAllowed, false); assert.equal(lockedContext.settings, undefined); assert.equal(lockedContext.purpose, undefined);
  await worker.runPriorityReflection(new AbortController().signal, { deep: true });
  assert.equal(lockedReflectionCalls, 0, 'deep reflection also skips a locked self');
  const lockedSource = await m.addMessage('user', '我喜欢散步时听轻音乐。');
  let ordinaryCalls = 0;
  worker.extract = async (input, { analysisContext }) => {
    ordinaryCalls++; assert(analysisContext.self.locked); assert.equal(analysisContext.self.updateAllowed, false);
    return { processedThrough: input.at(-1).endMessageId || input.at(-1).id,
      memories: [{ sourceId: lockedSource.id, content: '散步时喜欢听轻音乐。', evidence: '我喜欢散步时听轻音乐', memoryKind: 'fact' }],
      selfChanges: [{ op: 'add', facet: 'behavior', text: '我总是在散步时唱歌。', sourceIds: [lockedSource.id] }] };
  };
  worker.request('dream'); await worker.tick();
  assert.equal(ordinaryCalls, 1); assert((await m.query('memory', 40)).some(r => r.value.content.includes('轻音乐')));
  self = await m.cognition.loadRoleView(); assert(!self.text.includes('散步时唱歌'), 'ordinary memory extraction cannot update a locked self');
  self = await m.cognition.commitPatch({ requestId: 'unlock', baseRevision: self.revision, ops: [{ op: 'unlock_all' }] }, { actor: 'owner', trustedUI: true });
  assert(self.pendingSettings, 'unlock preserves the pending request for later understanding');
  await worker.close(); worker = null;
  // Retrieval hops: A has query term, A/B share a precise keyword, B is reached once.
  const source = await m.addMessage('user', '昨天去海边看日落。');
  await m.write(['a', 'b'].map((id, i) => ({ id: 'hop-' + id, kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1,
    value: { content: i ? '潮汐表提醒' : '橘色落日约定', status: 'confirmed', memoryKind: 'fact', sources: [source.id],
      references: refs.normalize('昨天', { at: source.ts, keywords: ['沿海小旅行'] }).references } })));
  assert((await m.recall('橘色落日')).some(r => r.id === 'hop-b' && r.associated));
  const old = { id: 'old-memory', kind: 'memory', ts: now++, domain: 'life', visibilityFloor: 1,
    value: { content: '昨天看日落', status: 'confirmed', sources: [source.id], evidenceSourceId: source.id } };
  await m.write([old]); const before = fingerprint((await readRecords(m, [old.id]))[0]);
  await m.backfillReferences(); assert.equal(fingerprint((await readRecords(m, [old.id]))[0]), before, 'index backfill preserves immutable evidence');
  const index = (await readRecords(m, ['reference-index:' + old.id]))[0]; assert(index.value.content.includes('2026-10-28'));
  assert(refs.normalize('上个月', { at: source.ts }).references.dates.some(d => d.precision === 'month'));
  const directory = path.join(root, 'creations'); fs.mkdirSync(directory);
  const reports = [], secretary = new Secretary({ memory: m, ready: () => true, epoch: () => m.generation, clock: () => now });
  let proposals = 0, available = true;
  autonomy = new CompanionAutonomy({ memory: m, secretary, getScene: () => scene, clock: () => now,
    canRun: () => available, report: async r => reports.push(r), propose: async () => { proposals++; return { kind: 'create', title: '给日落的一封小信', extension: 'md', content: '# 日落\n留一点时间看看天空。' }; } });
  await autonomy.tick(); assert.equal(proposals, 0, 'no grant means no activity');
  await autonomy.save({ kind: 'create', enabled: true, days: 7, scene: 'life', directory, subject: '散步与小作品' });
  await autonomy.tick(); assert.equal(proposals, 1); assert.equal(reports.length, 1); assert.equal(fs.readdirSync(directory).length, 1);
  const task = (await readRecords(m, [reports[0].taskId]))[0]; assert.equal(task.value.status, 'accepted'); assert.equal(task.value.artifactManifest.files[0].sha256.length, 64);
  now += 26 * 3600000; await autonomy.tick(); assert.equal(proposals, 2, 'authorized creation can continue without a response');
  assert.equal(reports.length, 1, 'no response prevents another channel/next-day chase');
  await autonomy.ownerInput(); await autonomy.tick(); assert.equal(proposals, 2);
  now += 26 * 3600000; await autonomy.ownerInput();
  const create = secretary.createArtifact.bind(secretary); secretary.createArtifact = async args => { const result = await create(args); available = false; return result; };
  await autonomy.tick(); assert.equal(proposals, 3); assert.equal(reports.length, 2, 'foreground interruption holds a real completed artifact');
  available = true; await autonomy.tick(); assert.equal(proposals, 3); assert.equal(reports.length, 3, 'pending artifact is shared without re-creating it');
  await autonomy.save({ kind: 'create', enabled: false, days: 7, scene: 'life' });
  now += 26 * 3600000; await autonomy.ownerInput(); await autonomy.tick(); assert.equal(proposals, 3, 'revocation prevents new work');
  await m.remove(u2.id); assert(!(await m.cognition.loadRoleView()).entries.some(e => e.entryId === learned.entryId), 'forgotten learning is withdrawn');
  await m.clear(); await m.cognition.ensure({ profile: '旧配置不得复活' }); assert.equal((await m.cognition.loadRoleView()).entries.length, 0);
  console.log('cognitive loop passed: ordered reply, actual Dream learning/locks, no replay, immutable reference backfill/two hops, real artifacts, grants and contact budget');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await worker?.close(); await autonomy?.close(); await m.close(); fs.rmSync(root, { recursive: true, force: true }); });
