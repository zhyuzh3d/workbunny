'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DESCRIPTIONS, contextDescription } = require('../src/main/avatar-descriptions');
const { inspectAvatarPack } = require('../src/main/avatar-pack-reader');
const { Embodiment } = require('../src/main/embodiment');

test('rabbit body context follows the real package palette and preserves custom description', async () => {
  const bytes = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/avatar-packs/soft-bunny.wbavatar'));
  const { runtime } = await inspectAvatarPack(bytes);
  let selected;
  const avatar = () => ({ key: 'builtin_soft_bunny', name: '兔兔', description: contextDescription('builtin_soft_bunny', '自定义兔兔描述。', runtime, selected) });
  const body = new Embodiment({ avatar, catalog: {}, send() {} });
  assert.match(body.context().appearance.description, /自定义兔兔描述。.*莓果粉（#ed3185）/);
  for (const palette of runtime.palettes) {
    selected = palette.id;
    const description = body.context().appearance.description;
    assert.ok(description.includes(palette.label));
    assert.ok(description.includes(palette.base));
  }
  selected = 'missing';
  assert.match(body.context().appearance.description, /莓果粉（#ed3185）/);
  body.close();
});

test('stock defaults cover seven appearances and do not inject rabbit colors into others', () => {
  assert.equal(Object.keys(DESCRIPTIONS).length, 7);
  assert.match(DESCRIPTIONS.builtin_soft_bunny, /长耳朵，黑眼睛/);
  assert.match(DESCRIPTIONS['Bani.vrm'], /爱心形粉色小纽扣/);
  assert.equal(contextDescription('Bani.vrm', DESCRIPTIONS['Bani.vrm'], { palette: { base: '#000000' } }, 'black'), DESCRIPTIONS['Bani.vrm']);
  assert.match(contextDescription('builtin_soft_bunny', '兔兔。', { palette: { base: '#123456' } }), /#123456/);
  assert.equal(contextDescription('builtin_soft_bunny', '兔兔。', null), '兔兔。');
});
