'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInteractionMap, AvatarInteractionPicker } = require('../src/main/avatar-interactions');

function fixture() {
  return {
    regions: [
      { id: 'left_ear', pool: 'ear', hitVolumes: [{ type: 'capsule', anchor: 'left_ear_1', size: [.2, .5, .2] }] },
      { id: 'head', pool: 'head', hitVolumes: [{ type: 'ellipsoid', anchor: 'head', size: [1, 1, 1] }] },
    ],
    pools: { ear: [{ action: 'twitch', weight: 2 }, { action: 'hide', weight: 1 }], head: [{ action: 'nod' }] },
  };
}
const actions = new Set(['twitch', 'hide', 'nod']);
const anchors = new Set(['left_ear_1', 'head']);
function validate(value) { return validateInteractionMap(value, { actionIds: actions, anchorIds: anchors }); }

test('interaction regions and pools are validated and copied', () => {
  const raw = fixture(), map = validate(raw);
  raw.regions[0].hitVolumes[0].size[0] = 1000;
  raw.pools.ear[0].action = 'altered';
  assert.equal(map.regions[0].hitVolumes[0].size[0], .2);
  assert.equal(map.pools.ear[0].action, 'twitch');
  assert.deepEqual(map.regions[0].hitVolumes[0].center, [0, 0, 0]);
});

test('rejects invalid references, ambiguous IDs, invalid geometry and weights', () => {
  for (const mutate of [
    x => { x.regions[0].pool = 'missing'; },
    x => { x.regions[0].hitVolumes[0].anchor = 'missing'; },
    x => { x.regions[0].hitVolumes[0].size[0] = NaN; },
    x => { x.regions[0].hitVolumes[0].size[1] = -1; },
    x => { x.regions[0].hitVolumes[0].type = 'script'; },
    x => { x.regions.push(x.regions[0]); },
    x => { x.pools.ear[0].action = 'missing'; },
    x => { x.pools.ear[0].weight = Infinity; },
    x => { x.pools.ear.forEach(row => { row.weight = 0; }); },
    x => { x.pools.ear.push({ action: 'hide' }); },
  ]) {
    const x = fixture(); mutate(x); assert.throws(() => validate(x));
  }
});

test('regions select only their own eligible actions and throttle accepted clicks', () => {
  let now = 0;
  const picker = new AvatarInteractionPicker({ clock: () => now, random: () => 0, cooldownMs: 900 });
  const map = validate(fixture());
  assert.equal(picker.pick(map, 'unknown'), null);
  assert.equal(picker.pick(map, 'left_ear', { allowed: () => false }), null);
  assert.deepEqual(picker.pick(map, 'left_ear', { allowed: id => id === 'hide' }), { region: 'left_ear', action: 'hide' });
  now = 899; assert.equal(picker.pick(map, 'head'), null);
  now = 900; assert.deepEqual(picker.pick(map, 'head'), { region: 'head', action: 'nod' });
  now = 1800; assert.deepEqual(picker.pick(map, 'head'), { region: 'head', action: 'nod' });
  picker.reset(); now = 0; assert.equal(picker.pick(map, 'head').action, 'nod');
});

test('repeat penalty reduces but does not eliminate the prior action', () => {
  const map = validate(fixture());
  let sample = 0;
  const picker = new AvatarInteractionPicker({ clock: () => 0, random: () => sample, cooldownMs: 0, repeatFactor: .25 });
  assert.equal(picker.pick(map, 'left_ear').action, 'twitch');
  // Effective weights become .5 and 1. At .5 the second item must win.
  sample = .5; assert.equal(picker.pick(map, 'left_ear').action, 'hide');
  // The previous item is still possible, with a nonzero probability.
  sample = .99; assert.equal(picker.pick(map, 'left_ear').action, 'hide');
});

test('interaction speech is validated, remains attached to its action, and is optional', () => {
  const input = fixture(); input.pools.ear[0].speech = { text: '你好呀！', emotion: 'happy' };
  const map = validate(input), picker = new AvatarInteractionPicker({ clock: () => 0, random: () => 0, cooldownMs: 0 });
  assert.deepEqual(picker.pick(map, 'left_ear').speech, { text: '你好呀！', emotion: 'happy' });
  for (const bad of [{ text: '<script>alert(1)</script>' }, { text: 'x'.repeat(121) }, { text: '你好', emotion: 'other' }, { text: '你好', code: 'run' }]) {
    const copy = fixture(); copy.pools.ear[0].speech = bad; assert.throws(() => validate(copy));
  }
});
