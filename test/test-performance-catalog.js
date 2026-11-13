'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPerformanceSnapshot } = require('../src/main/performance-catalog');
const { AvatarCatalogRouter } = require('../src/main/avatar-catalog-router');

function fixture() {
  const catalog = { revision: 1, categories: [{ id: 'greet', label: '问候', description: '普通问候' }, { id: 'exercise', label: '运动' }], motions: [
    { key: 'wave', label: '挥手', slot: 'greet', posture: 'standing', enabled: true, url: 'file:///private/wave.vrma' },
    { key: 'run', label: '原地跑', slot: 'exercise', posture: 'standing', enabled: true, autonomous: false, loop: true },
    { key: 'sit_wave', label: '挥手', use: '坐着抬手致意', slot: 'greet', posture: 'sitting', enabled: true },
    { key: 'phone', label: '看手机', slot: 'exercise', requiresProp: true, enabled: true },
    { key: 'disabled', label: '禁用项', slot: 'exercise', enabled: false },
    { key: 'deleted', label: '删除项', slot: 'exercise', enabled: true, deleted: true }
  ] };
  return { catalog, avatar: { key: 'test.vrm', kind: 'vrm', name: '测试形象' } };
}

test('the compact immutable performance catalog includes explicit nonautonomous choices and exact numbering', () => {
  const { catalog, avatar } = fixture();
  const snapshot = buildPerformanceSnapshot(catalog, { avatar, posture: 'sitting' });
  assert.equal(snapshot.motions.length, 4);
  assert.equal(snapshot.resolve(0), null);
  assert.equal(snapshot.resolve(2).key, 'run');
  assert.equal(snapshot.map[2], snapshot.resolve(2));
  assert.match(snapshot.promptText, /2 原地跑 短周期重复展示/);
  assert.match(snapshot.promptText, /3 挥手 坐着抬手致意；坐姿/);
  assert.match(snapshot.promptText, /4 看手机 需外部道具（当前不可用）/);
  assert.doesNotMatch(snapshot.promptText, /file:|private|wave|sit_wave|disabled|删除项|禁用项/);
  for (const bad of [-1, 1.5, '1', NaN, Infinity, 5]) assert.throws(() => snapshot.resolve(bad), RangeError);
  catalog.motions[1].label = '已改名'; catalog.motions.reverse(); avatar.name = '新名字';
  assert.equal(snapshot.resolve(2).label, '原地跑');
  assert.equal(snapshot.avatar.name, '测试形象');
  assert.throws(() => { snapshot.map[1] = snapshot.map[2]; }, TypeError);
  assert.throws(() => { snapshot.resolve(2).key = 'other'; }, TypeError);
  assert.throws(() => { snapshot.entries.push({}); }, TypeError);
});

test('catalog validity follows identity and motion execution content rather than unrelated settings revisions', () => {
  const { catalog, avatar } = fixture(), router = { catalog: () => catalog };
  const snapshot = buildPerformanceSnapshot(router, { avatar });
  catalog.revision++;
  assert.equal(snapshot.isCurrent(router, { ...avatar, name: '改名', description: '新描述' }), true);
  assert.equal(snapshot.isCurrent(router, { ...avatar, key: 'other.vrm' }), false);
  for (const [field, value] of [['enabled', false], ['url', 'file:///replacement.vrma'], ['loop', true], ['bakedPreview', true], ['thumbAdaptation', false]]) {
    const previous = catalog.motions[0][field]; catalog.motions[0][field] = value;
    assert.equal(snapshot.isCurrent(router, avatar), false, field);
    if (previous === undefined) delete catalog.motions[0][field]; else catalog.motions[0][field] = previous;
  }
  catalog.motions.reverse(); assert.equal(snapshot.isCurrent(router, avatar), false); catalog.motions.reverse();
  catalog.motions.pop(); assert.equal(snapshot.isCurrent(router, avatar), false);
});

test('ordinary category context includes only eligible random candidates and no concrete motion IDs', () => {
  const { catalog, avatar } = fixture(); let active = null;
  const router = new AvatarCatalogRouter({ catalog: () => catalog }, () => active);
  assert.deepEqual(router.ordinaryPrompt(), [{ category: 'greet', meaning: '问候', use: '普通问候' }]);
  assert.deepEqual(router.ordinaryPrompt('sitting'), [{ category: 'greet', meaning: '问候', use: '普通问候' }]);
  catalog.motions[2].enabled = false;
  assert.deepEqual(router.ordinaryPrompt('sitting'), []);
  active = { catalog: { catalog: () => ({ categories: [{ id: 'dance', label: '跳舞' }], motions: [{ key: 'pack_dance', label: '舞蹈', slot: 'dance', enabled: true }] }) } };
  assert.deepEqual(router.ordinaryPrompt(), [{ category: 'dance', meaning: '跳舞', use: '' }]);
  assert.equal(router.performanceSnapshot({ avatar }).resolve(1).key, 'pack_dance');
});

test('catalog validity and repetition markers follow resolved presentation policy independently of loop processing', () => {
  const { catalog, avatar } = fixture(), run = catalog.motions.find(motion => motion.key === 'run');
  const cycle = buildPerformanceSnapshot(catalog, { avatar });
  assert.match(cycle.promptText, /2 原地跑 短周期重复展示/);
  run.performanceMode = 'once';
  assert.equal(cycle.isCurrent(catalog, avatar), false);
  const once = buildPerformanceSnapshot(catalog, { avatar });
  assert.equal(run.loop, true);
  assert.doesNotMatch(once.promptText.split('\n').find(line => line.startsWith('2 ')), /重复/);
  run.loop = false; run.performanceMode = 'cycle';
  assert.equal(once.isCurrent(catalog, avatar), false);
  assert.match(buildPerformanceSnapshot(catalog, { avatar }).promptText, /2 原地跑 短周期重复展示/);
});
