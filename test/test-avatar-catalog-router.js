'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AvatarCatalogRouter } = require('../src/main/avatar-catalog-router');
const { Embodiment } = require('../src/main/embodiment');

test('routing changes with the active avatar without mutating the VRMA catalog', () => {
  const calls = [];
  function catalog(name) {
    return Object.fromEntries(['catalog', 'select', 'idle', 'prompt'].map(method => [method, (...args) => {
      calls.push({ name, method, args }); return name + ':' + method;
    }]));
  }
  const vrma = catalog('vrma'), pack = catalog('pack'); let active = null;
  const router = new AvatarCatalogRouter(vrma, () => active);
  assert.equal(router.select('greet'), 'vrma:select');
  active = { catalog: pack };
  assert.equal(router.select('greet'), 'pack:select');
  assert.equal(router.prompt('开心'), 'pack:prompt');
  active = null;
  assert.equal(router.catalog().startsWith('vrma'), true);
  assert.equal(calls.length, 4);
});

test('avatar switching rejects outstanding receipts and clears prior capabilities', async () => {
  let key = 'old', sent;
  const motion = { key: 'wave', label: '挥手', slot: 'greet', enabled: true };
  const body = new Embodiment({ catalog: { select: () => motion, catalog: () => ({ motions: [motion] }) },
    avatar: () => ({ key }), send: value => { sent = value; }, timeoutMs: 5000 });
  body.capabilities = { expressions: ['happy'] };
  const result = body.perform('wave');
  key = 'new'; body.avatarChanged();
  assert.deepEqual(await result, { ok: false, error: '形象已切换' });
  assert.equal(body.capabilities, null);
  assert.equal(body.report({ avatar: 'old', key: 'wave', requestId: sent.requestId, ok: true }), false);
  assert.deepEqual(body.recent, []);
});
