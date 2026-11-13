'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createLocalAvatarControl } = require('../src/main/local-avatar-control');
const { ownerMethods } = require('../src/main/local-control');
test('avatar controls share UI selection and expose body receipts only in the authorized scene', async () => {
  let scene = 'life', selected = 'Bani.vrm', changes = 0;
  const controls = createLocalAvatarControl({ getScene: () => scene, isReady: () => true,
    list: () => [{ key: 'Bani.vrm', label: '芭尼' }, { key: 'builtin_soft_bunny', label: '兔兔', kind: 'avatar-pack' }],
    current: () => ({ key: selected }), body: () => ({ capabilities: {}, performance: { active: null } }),
    select: async key => { selected = key; changes++; } });
  const methods = ownerMethods({ getScene: () => scene, avatarControls: controls });
  assert(methods['tools.list'].execute({}).tools.some(t => t.name === 'avatar_status'));
  await controls.select({ key: 'builtin_soft_bunny' }); assert.equal(changes, 1);
  assert.equal(controls.status({}).avatar.key, 'builtin_soft_bunny');
  await assert.rejects(controls.select({ key: '../unknown' }), { code: 'E_LOCAL_PARAMS' });
  scene = 'private'; assert.throws(() => controls.status({}), { code: 'E_LOCAL_SCENE' });
  await assert.rejects(controls.select({ key: 'Bani.vrm' }), { code: 'E_LOCAL_SCENE' });
  assert.equal(changes, 1);
});
