'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MemoryService } = require('../src/main/memory-service');
const vc = require('../src/main/vault-crypto');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const services = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for isolated MemoryService');
    await delay(10);
  }
}

function createService(dir, { scene = 'life', settings, key = crypto.randomBytes(32), extract, clock } = {}) {
  const mutableSettings = settings || { enabled: true, extract: !!extract, scene };
  const service = new MemoryService({
    dir, bin, getSettings: () => mutableSettings,
    openKey: async () => Buffer.from(key), extract, clock: clock || Date.now, random: () => 0,
  });
  services.add(service);
  return { service, settings: mutableSettings, key };
}

async function ready(service) {
  await service.init();
  assert.equal(service.ready, true, `MemoryService must open isolated vault: ${service.error}`);
  return service;
}

async function testMatrixAndLineage(temp) {
  const { service, settings } = createService(path.join(temp, 'matrix-vault'));
  await ready(service);

  const work = await service.addMessage('user', '请记住：工作项目代号是WProjectNeedle', { domain: 'work', visibilityFloor: 0 });
  const life = await service.addMessage('user', '请记住：我生活中喜欢LTeaNeedle', { domain: 'life', visibilityFloor: 1 });
  const privateFact = await service.addMessage('user', '请记住：我的私聊昵称是PNicknameNeedle', { domain: 'private', visibilityFloor: 2 });
  const highFloorWork = await service.addMessage('user', '请记住：高范围工作标记是WPrivateNeedle', { domain: 'work', visibilityFloor: 2 });
  assert([work, life, privateFact, highFloorWork].every(Boolean));

  // Default scene is life: it can read work and life, but not private floor 2.
  assert((await service.search('WProjectNeedle', ['message'])).some(row => row.id === work.id));
  assert((await service.search('LTeaNeedle', ['memory'])).length > 0);
  assert.equal((await service.search('PNicknameNeedle', ['message', 'memory'])).length, 0);
  assert.equal((await service.search('WPrivateNeedle', ['message', 'memory'])).length, 0,
    'a work domain label cannot lower a private visibility floor');

  const defaultPage = await service.query('message', 200, { state: 'all' });
  assert(defaultPage.some(row => row.id === work.id));
  assert(defaultPage.some(row => row.id === life.id));
  assert(!defaultPage.some(row => row.id === privateFact.id || row.id === highFloorWork.id));

  const workCtx = await service.context('WProjectNeedle', { scene: 'work', budget: 8500 });
  assert.equal(workCtx.scene, 'work');
  assert(workCtx.messages.some(message => message.content.includes('WProjectNeedle')));
  assert(!workCtx.messages.some(message => /LTeaNeedle|PNicknameNeedle|WPrivateNeedle/.test(message.content)));
  assert(!/LTeaNeedle|PNicknameNeedle|WPrivateNeedle/.test(workCtx.text));

  const privateSearch = await service.search('PNicknameNeedle', ['message', 'memory'], 30, { scene: 'private' });
  assert(privateSearch.some(row => row.id === privateFact.id));
  const allSearch = await service.search('PNicknameNeedle', ['message'], 30, { scene: null });
  assert(allSearch.some(row => row.id === privateFact.id), 'explicit null is the internal full-vault path');

  const allMessages = await service.query('message', 200, { state: 'all', scene: null });
  assert(allMessages.some(row => row.id === privateFact.id));
  assert(allMessages.every(row => !Object.hasOwn(row.value, '_scopeV1')),
    'scope envelope metadata must be checked then stripped from public values');
  const workMemory = (await service.query('memory', 200, { scene: null, state: 'all' }))
    .find(row => row.value.content.includes('WProjectNeedle'));
  assert(workMemory, 'explicit user fact should derive a memory from the source');
  assert.equal(workMemory.domain, 'work');
  assert.equal(workMemory.visibilityFloor, 0);
  assert(workMemory.value.sources.includes(work.id));
  const privateDerived = (await service.query('memory', 200, { scene: null, state: 'all' }))
    .find(row => row.value.content.includes('WPrivateNeedle'));
  assert(privateDerived);
  assert.equal(privateDerived.domain, 'work');
  assert.equal(privateDerived.visibilityFloor, 2, 'derived memory inherits its source floor despite work domain');

  const lifePage = await service.query('message', 200, { state: 'all', scene: 'life' });
  assert(lifePage.some(row => row.id === work.id) && lifePage.some(row => row.id === life.id));
  assert(!lifePage.some(row => row.id === privateFact.id || row.id === highFloorWork.id));
  const workPage = await service.query('message', 200, { state: 'all', scene: 'work' });
  assert.deepEqual(new Set(workPage.map(row => row.id)), new Set([work.id]));

  const beforeGeneration = service.generation;
  settings.scene = 'work';
  await service.changeScene('work');
  assert.equal(service.generation, beforeGeneration, 'scene changes use context epoch, not privacy generation');
  assert(service.recent.some(row => row.id === work.id));
  assert(!service.recent.some(row => [life.id, privateFact.id, highFloorWork.id].includes(row.id)));
  const switched = await service.context('WProjectNeedle', { scene: 'work', budget: 8500 });
  assert.equal(switched.scene, 'work');
  assert(!/LTeaNeedle|PNicknameNeedle|WPrivateNeedle/.test(switched.text));

  // Export is a full encrypted snapshot; restore retains scopes and source edges.
  const passphrase = 'isolated-memory-scene-backup';
  const backup = await service.export(passphrase);
  for (const marker of ['WProjectNeedle', 'LTeaNeedle', 'PNicknameNeedle', 'WPrivateNeedle']) assert(!backup.includes(marker));
  const target = createService(path.join(temp, 'restore-matrix-vault'), { scene: 'life', key: crypto.randomBytes(32) });
  await ready(target.service);
  const restored = await target.service.restore(backup, passphrase);
  assert(restored.records >= 8);
  assert((await target.service.search('WProjectNeedle', ['message'])).some(row => row.id === work.id));
  assert((await target.service.search('LTeaNeedle', ['message'])).some(row => row.id === life.id));
  assert.equal((await target.service.search('PNicknameNeedle', ['message'])).length, 0);
  assert.equal((await target.service.search('WPrivateNeedle', ['message'])).length, 0);
  target.settings.scene = 'private';
  await target.service.changeScene('private');
  assert((await target.service.search('PNicknameNeedle', ['message'])).some(row => row.id === privateFact.id));
  assert((await target.service.search('WPrivateNeedle', ['memory'])).length > 0);
  await target.service.close();

  // A legacy export with no scope fields or _scopeV1 must restore private/2.
  const oldBackup = await vc.exportEnvelope({ format: 1, exportedAt: Date.now(), records: [{
    id: 'legacy-unscoped', kind: 'message', ts: 100, state: 'active', sources: [],
    value: { role: 'user', content: 'legacy scene fallback LegacyScopeNeedle', sources: [] },
  }] }, passphrase);
  const legacyTarget = createService(path.join(temp, 'legacy-backup-vault'));
  await ready(legacyTarget.service);
  await legacyTarget.service.restore(oldBackup, passphrase);
  assert.equal((await legacyTarget.service.search('LegacyScopeNeedle', ['message'], 20, { scene: 'life' })).length, 0);
  const legacyRow = (await legacyTarget.service.query('message', 20, { scene: null, state: 'all' }))[0];
  assert.equal(legacyRow.domain, 'private');
  assert.equal(legacyRow.visibilityFloor, 2);
  await legacyTarget.service.close();

  // A database-only metadata edit must not lower the authenticated scope.
  const tamperSQL = String.raw`import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute('UPDATE records SET domain="work",visibilityFloor=0 WHERE id=?',(sys.argv[2],))
db.commit();db.close()`;
  execFileSync('python3', ['-c', tamperSQL, path.join(service.dir, 'companion.db'), privateFact.id], { stdio: 'ignore' });
  await assert.rejects(service.query('message', 200, { state: 'all', scene: 'work' }), /场景完整性校验失败/);
  await service.close();
}

async function testLegacyJsonMigrationPrivate(temp) {
  const parent = path.join(temp, 'legacy-json');
  const dir = path.join(parent, 'vault');
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(path.join(parent, 'memory.json'), JSON.stringify({ history: [
    { role: 'user', content: 'old history LegacyJsonNeedle' },
  ] }), { mode: 0o600 });
  const { service } = createService(dir);
  await ready(service);
  assert.equal((await service.search('LegacyJsonNeedle', ['message'])).length, 0,
    'unclassified old JSON history is not visible in default life mode');
  const rows = await service.query('message', 20, { scene: null, state: 'all' });
  const legacy = rows.find(row => row.value.content.includes('LegacyJsonNeedle'));
  assert(legacy);
  assert.equal(legacy.domain, 'private');
  assert.equal(legacy.visibilityFloor, 2);
  assert.equal(fs.existsSync(path.join(parent, 'memory.json')), false, 'verified isolated migration consumes the legacy fixture');
  await service.close();
}

async function testSceneSwitchCancelsLateJob(temp) {
  let calls = 0, release, signal;
  const extract = (batch, options = {}) => {
    calls++;
    if (calls === 1) {
      signal = options.signal;
      return new Promise(resolve => { release = resolve; });
    }
    return Promise.resolve({ memories: [], excerpts: [] });
  };
  const settings = { enabled: true, extract: true, scene: 'life' };
  const { service } = createService(path.join(temp, 'scene-job-vault'), { settings, extract });
  await ready(service);
  const messages = [];
  for (let i = 0; i < 4; i++) messages.push(await service.addMessage('user', `生活来源 SceneLateNeedle ${i}`, { domain: 'life', visibilityFloor: 1 }));
  clearTimeout(service.extractTimer); service.extractTimer = null;
  const job = service.consolidate();
  await until(() => typeof release === 'function');
  const generation = service.generation;
  settings.scene = 'work';
  await service.changeScene('work');
  assert.equal(service.generation, generation);
  assert.equal(signal.aborted, true);
  release({
    memories: [{ sourceId: messages[0].id, evidence: 'SceneLateNeedle', content: '不应跨场景写入的迟到记忆' }],
    excerpts: [{ sourceId: messages[0].id, quote: 'SceneLateNeedle' }],
  });
  await job;
  assert.equal((await service.search('不应跨场景写入', ['memory', 'summary'], 20, { scene: null })).length, 0);
  assert.equal(service.lastExtractCount, 0, 'a cancelled scene job cannot advance its watermark');
  assert(service.recent.every(row => row.domain === 'work' || row.visibilityFloor === 0),
    'scene switch reloads only visible recent records');
  await service.close();
}

async function main() {
  execFileSync(path.join(__dirname, '../tools/build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-scenes-'));
  try {
    await testMatrixAndLineage(temp);
    await testLegacyJsonMigrationPrivate(temp);
    await testSceneSwitchCancelsLateJob(temp);
    console.log('Memory scene integration checks passed');
  } finally {
    await Promise.all([...services].map(service => service.close().catch(() => {})));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
