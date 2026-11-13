'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectAvatarPack } = require('../src/main/avatar-pack-reader');
const { AvatarCatalogRouter } = require('../src/main/avatar-catalog-router');
const { MotionLibrary } = require('../src/main/motion-library');
const { Embodiment } = require('../src/main/embodiment');

let packPromise;
const loadPack = () => packPromise ||= inspectAvatarPack(fs.readFileSync(path.join(__dirname, '../src/renderer/assets/avatar-packs/soft-bunny.wbavatar')));
async function fixture(t) {
  const pack = await loadPack(), saved = [], sent = [];
  const vrma = new MotionLibrary({ motions: [{ key: 'wave', label: '挥手', slot: 'greet' }],
    groups: [{ id: 'greet', label: '问候' }], getConfig: () => ({ motions: {} }) });
  let activePack = pack, avatar = { key: 'builtin_soft_bunny', name: '兔兔', kind: 'avatar-pack' };
  const router = new AvatarCatalogRouter(vrma, () => activePack);
  const body = new Embodiment({ catalog: router, avatar: () => avatar, clock: () => 100000,
    send: event => sent.push(event), persist: (rows, state) => saved.push({ rows, state }) });
  t.after(() => body.close());
  return { pack, body, router, sent, saved, avatar: () => avatar,
    switchToBani() { activePack = null; avatar = { key: 'Bani.vrm', name: 'Bani', kind: 'vrm' }; body.avatarChanged(); } };
}
function receipt(f, event, phase) {
  return f.body.report({ ...event, avatar: f.avatar().key, phase, ok: phase === 'started' || phase === 'finished' });
}

test('the real bunny theatre pack uses complete numbered catalog and the same body start/end/cancel contract', async t => {
  const f = await fixture(t), snapshot = f.router.performanceSnapshot({ avatar: f.avatar(), posture: 'standing' });
  assert.equal(snapshot.entries.length, 101);
  assert.equal(snapshot.isCurrent(f.router, f.avatar()), true);
  for (const [label, fx, ending] of [['下雪啦', 'snow', 'finished'], ['耳朵拍回球', 'ball', 'cancelled']]) {
    const entry = snapshot.entries.find(entry => entry.motion.label === label);
    assert.ok(entry, label);
    const motion = snapshot.resolve(entry.number);
    assert.equal(motion.key, entry.key);
    assert.equal(motion.requiresProp, false, 'theatre effects are provided by the pack runtime');
    assert.equal(f.pack.runtime.actions.find(action => action.id === motion.localId).performance.fx, fx);
    assert.match(snapshot.promptText, new RegExp(`\\n${entry.number} ${label}(?:\\n|$)`));
    const pending = f.body.perform(motion.key, 'performance', { performanceId: `theatre-${entry.number}`, allowPostureChange: true, holdMs: 4000 });
    const event = f.sent.at(-1);
    assert.equal(event.reason, 'performance');
    assert.deepEqual(f.body.context().performance, { action: label, avatarName: '兔兔', phase: 'loading', started: false });
    assert.equal(receipt(f, event, 'started'), true);
    assert.equal((await pending).ok, true);
    assert.equal(f.body.context().recentActions.at(-1).action, label);
    assert.equal(f.body.context().recentActions.at(-1).avatarName, '兔兔');
    if (ending === 'finished') assert.equal(receipt(f, event, ending), true);
    else {
      assert.equal(f.body.cancelPerformance('owner-stop'), true);
      assert.deepEqual(f.sent.at(-1), { cancelPerformance: event.performanceId });
    }
    assert.equal(f.body.context().lastPerformance.phase, ending);
    assert.equal(f.body.context().lastPerformance.started, true);
    assert.equal(f.body.context().lastPerformance.avatarName, '兔兔');
    assert.equal(receipt(f, event, 'started'), false);
  }
  assert.equal(f.body.recent.length, 2);
  assert.doesNotMatch(snapshot.promptText, /需外部道具/);
});

test('former-avatar performance keeps its friendly identity across switching, routine actions and restore', async t => {
  const f = await fixture(t), snapshot = f.router.performanceSnapshot({ avatar: f.avatar() });
  f.body.setReady({ avatar: f.avatar().key });
  const entry = snapshot.entries.find(entry => entry.motion.label === '下雪啦');
  const pending = f.body.perform(snapshot.resolve(entry.number).key, 'performance', { performanceId: 'old-avatar', allowPostureChange: true });
  const event = f.sent.at(-1);
  receipt(f, event, 'started'); await pending;
  f.switchToBani();
  assert.equal(snapshot.isCurrent(f.router, f.avatar()), false);
  assert.equal(f.body.context().appearance.name, '兔兔');
  assert.equal(f.body.context().appearance.requestedName, 'Bani');
  f.body.setReady({ avatar: f.avatar().key });
  assert.equal(f.body.context().appearance.name, 'Bani');
  assert.equal(f.body.context().lastPerformance.avatarName, '兔兔');
  assert.equal(f.body.context().lastPerformance.phase, 'cancelled');
  assert.equal(f.body.context().lastPerformance.reason, 'avatar');
  assert.equal(f.body.recent[0].avatarName, '兔兔');
  const wave = f.body.perform('wave', 'reply'), waveEvent = f.sent.at(-1);
  receipt(f, waveEvent, 'started'); await wave;
  assert.deepEqual(f.body.context().recentActions.map(row => row.avatarName), ['兔兔', 'Bani']);
  assert.equal(f.body.context().lastPerformance.avatarName, '兔兔');
  const restored = new Embodiment({ catalog: f.router, avatar: f.avatar, send() {}, clock: () => 100000 });
  t.after(() => restored.close());
  restored.restore(f.saved.at(-1).rows, f.saved.at(-1).state.lastPerformance);
  assert.deepEqual(restored.context().recentActions.map(row => row.avatarName), ['兔兔', 'Bani']);
  assert.equal(restored.context().lastPerformance.avatarName, '兔兔');
  assert.equal(restored.context().appearance.name, null);
  assert.equal(restored.context().appearance.requestedName, 'Bani');
  restored.setReady({ avatar: f.avatar().key });
  assert.equal(restored.context().appearance.name, 'Bani');
});
