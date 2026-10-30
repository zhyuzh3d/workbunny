'use strict';

// Isolated routing probe over the production task services. This does not
// construct Electron/native desktop access or operate a real application.
const assert = require('node:assert/strict');
const { DesktopService } = require('../src/main/desktop-service');
const { Secretary } = require('../src/main/secretary');
const { WatchService } = require('../src/main/watch-service');

async function privateWorkBuddyCannotRouteThroughTaskServices() {
  let scene = 'private';
  let nativeCalls = 0;
  const desktop = new DesktopService({
    getScene: () => scene,
    native: { request: async () => { nativeCalls++; return {}; } },
  });
  desktop.task = {
    id: 'private-task-1', target: 'workbuddy', domain: 'work', scene: 'private', visibilityFloor: 2,
    privacyEpoch: 7, origin: 'dialogue', status: 'paused', goal: 'PRIVATE_SCOPE_FIXTURE', note: 'paused',
  };
  const secretary = new Secretary({ desktop, getScene: () => scene, epoch: () => 7 });

  assert.match(secretary.context(), /PRIVATE_SCOPE_FIXTURE/);
  assert.equal(desktop.publicStatus().task.goal, 'PRIVATE_SCOPE_FIXTURE');
  scene = 'work';
  assert.equal(desktop.publicStatus().task, null, 'DesktopService hides the private task in work scene');
  assert.doesNotMatch(secretary.context(), /PRIVATE_SCOPE_FIXTURE/);
  assert.match(secretary.statusText(), /没有正在处理/);
  const resumed = await desktop.resume({ privacyEpoch: 7, scene });
  assert.equal(resumed.ok, false, 'direct resume is scope-gated before touching native');
  assert.equal(nativeCalls, 0);
  assert.equal(desktop.task.privacyEpoch, 7, 'scene changes do not mutate source epoch');
}

async function lifeWatchIsHiddenButRetainedAcrossSceneChanges() {
  let scene = 'life';
  let epoch = 11;
  const persisted = new Map();
  const service = new WatchService({
    getScene: () => scene,
    epoch: () => epoch,
    ready: () => true,
    autoSchedule: false,
    journal: {
      async saveWatch(watch) { persisted.set(watch.id, structuredClone(watch)); return watch; },
      async listWatches() { return [...persisted.values()]; },
    },
    sensor: { async forget() {}, async close() {} },
    inspect: async () => ({ headerMatched: true, messages: [] }),
    execute: async () => ({ ok: true }),
    propose: async () => ({ reply: null }),
    report: async () => {},
  });
  const created = await service.start({ recipient: 'fixture contact', goal: 'fixture only', criteria: '',
    sources: ['fixture-source'], scene, visibilityFloor: 1,
    watch: { mode: 'notify', policy: 'fixture policy', intervalSeconds: 30 } });
  assert.equal(created.ok, true);
  const watch = service.items.get(created.id);
  assert.deepEqual([watch.domain, watch.visibilityFloor, watch.privacyEpoch], ['life', 1, 11]);

  scene = 'work';
  assert.deepEqual(service.list(), [], 'life watch is not presented in work scene');
  assert.equal(service.find({ id: created.id }), null, 'hidden watch cannot be selected for control');
  assert.equal(service.items.get(created.id).status, 'waiting', 'scene filtering alone does not persist a paused state');
  assert.equal(typeof service.sceneChanged, 'function', 'scene switch has an explicit abort/pause hook');
  await service.sceneChanged();
  assert.equal(service.items.get(created.id).status, 'paused');

  scene = 'private';
  assert.equal(service.list().length, 1, 'the existing watch is visible again in a higher-visibility scene');
  assert.equal(service.items.get(created.id).status, 'paused', 'higher visibility does not silently resume a paused watch');
  assert.equal(service.items.get(created.id).privacyEpoch, 11);
  assert.equal(epoch, 11, 'scene switch does not invalidate source epoch');
  await service.close();
}

async function main() {
  await privateWorkBuddyCannotRouteThroughTaskServices();
  await lifeWatchIsHiddenButRetainedAcrossSceneChanges();
  console.log('scope routing service probes passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
