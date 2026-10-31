'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AvatarActionCatalog } = require('../src/main/avatar-action-catalog');

function fixture() {
  return { namespace: 'pet_one', defaultIdle: 'idle', categories: [
    { id: 'idle', label: '休息', description: '平静待机' },
    { id: 'cheer', label: '开心', description: '表达高兴' },
  ], actions: [
    { id: 'idle', category: 'idle', label: '呼吸', use: '平静待机', duration: 4, loop: true, idle: true },
    { id: 'jump', category: 'cheer', label: '开心跳', use: '高兴时跳起', duration: 2, weight: 2 },
    { id: 'wave', category: 'cheer', label: '挥动', use: '开心地挥动', duration: 1, weight: 1 },
    { id: 'special', category: 'cheer', label: '特殊', use: '需要外部道具', duration: 1, requiresExternalProp: true },
  ] };
}

test('catalog keeps fixed action IDs and separates exact and category selection', () => {
  const source = fixture(), c = new AvatarActionCatalog(source, { random: () => .1 });
  source.actions[1].label = 'changed';
  assert.equal(c.select('pet_one_jump').label, '开心跳');
  assert.equal(c.select('cheer').key, 'pet_one_jump');
  assert.equal(c.select('pet_one_missing', { exact: true }), null);
  assert.equal(c.select('pet_one_special'), null);
  assert.equal(c.select('pet_one_special', { manual: true }).key, 'pet_one_special');
  assert.equal(c.idle().key, 'pet_one_idle');
  assert.equal(c.catalog().motions.length, 4);
  assert.equal(c.prompt('开心跳一下').find(g => g.category === 'cheer').actions[0].id, 'pet_one_jump');
});

test('invalid catalogs are rejected before publication', () => {
  for (const mutate of [
    d => { d.namespace = '../bad'; },
    d => { d.actions[0].id = '__proto__'; },
    d => { d.actions[1].category = 'missing'; },
    d => { d.actions[1].duration = Infinity; },
    d => { d.actions[1].weight = -1; },
    d => { d.actions[0].loop = false; },
    d => { d.actions.push({ ...d.actions[0] }); },
    d => { d.categories[1].id = 'idle'; },
  ]) { const d = fixture(); mutate(d); assert.throws(() => new AvatarActionCatalog(d)); }
});

test('automatic selection respects action availability without overriding exact requests', () => {
  const c = new AvatarActionCatalog(fixture(), { random: () => .9 });
  assert.equal(c.select('cheer', { autonomous: true, allowed: m => m.key.endsWith('_jump') }).key, 'pet_one_jump');
  assert.equal(c.select('pet_one_jump', { allowed: () => false }), null);
  assert.equal(c.select('cheer', { autonomous: true, allowed: () => false }), null);
});

test('zero random weight excludes a category candidate but permits its exact request', () => {
  const data = fixture();
  data.actions.find(action => action.id === 'jump').weight = 0;
  const c = new AvatarActionCatalog(data, { random: () => 0 });
  assert.equal(c.select('cheer').key, 'pet_one_wave');
  assert.equal(c.select('pet_one_jump', { exact: true }).key, 'pet_one_jump');
});

test('an explicitly requested manual-only action remains discoverable without random selection', () => {
  const data = fixture();
  data.actions.find(action => action.id === 'jump').autonomous = false;
  const c = new AvatarActionCatalog(data, { random: () => 0 });
  assert.equal(c.select('cheer').key, 'pet_one_wave');
  assert.equal(c.select('pet_one_jump').key, 'pet_one_jump');
  assert.equal(c.select('pet_one_jump', { autonomous: true }), null);
  assert.equal(c.prompt('开心跳').find(group => group.category === 'cheer').actions[0].id, 'pet_one_jump');
});
