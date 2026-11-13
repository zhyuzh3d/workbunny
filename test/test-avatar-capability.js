'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAvatarSnapshot, createAvatarCapability } = require('../src/main/avatar-capability');

function avatars() {
  return [...Array.from({ length: 7 }, (_, index) => ({ key: `official-${index + 1}`, label: `形象${index + 1}`, kind: index ? 'vrm' : 'avatar-pack', version: '1' })),
    { key: 'custom', label: '自定义形象', kind: 'avatar-pack', personal: true, version: '2', digest: 'digest-2', url: 'file:///safe/custom.wbavatar' }];
}
function fixture({ timeoutMs = 100, pollMs = 2, applyFailure = false } = {}) {
  const list = avatars(), calls = [];
  let key = 'official-1', avatarRevision = 1, capabilities = { expressions: [] }, bodyKey = key;
  const current = () => ({ key, name: list.find(item => item.key === key)?.label, kind: list.find(item => item.key === key)?.kind, avatarRevision });
  function change(next) { if (next !== key) avatarRevision++; key = next; bodyKey = next; capabilities = null; }
  const capability = createAvatarCapability({ list: () => list, current,
    getBody: () => ({ avatar: { key: bodyKey }, capabilities }), timeoutMs, pollMs,
    applySettings: async patch => { calls.push(patch); if (applyFailure) throw Error('设置未保存'); change(patch.avatar); } });
  return { capability, list, calls, current, key: () => key, ui: change,
    ready(avatar = key) { if (avatar === key) { bodyKey = avatar; capabilities = { expressions: [] }; } },
    mismatchedReady(avatar) { bodyKey = avatar; capabilities = { expressions: [] }; } };
}

test('avatar numbering includes all official and custom entries with immutable exact identity mapping', () => {
  const list = avatars(), snapshot = buildAvatarSnapshot(list);
  assert.equal(snapshot.choices.length, 8);
  assert.deepEqual(snapshot.choices[7], { number: 8, name: '自定义形象', kind: 'avatar-pack', custom: true });
  assert.equal(snapshot.choices[0].custom, false);
  assert.equal(snapshot.resolve(8, list), 'custom');
  assert.equal(snapshot.resolve(1, structuredClone(list)), 'official-1');
  assert.throws(() => { snapshot.choices[0].name = '改名'; }, TypeError);
  assert.throws(() => { snapshot.choices.push({}); }, TypeError);
  for (const number of [0, -1, '1', 1.5, 9, NaN]) assert.throws(() => snapshot.resolve(number, list), { code: 'E_AVATAR_NUMBER' });
  list[7].label = '新名称';
  assert.equal(snapshot.choices[7].name, '自定义形象');
  assert.throws(() => snapshot.resolve(8, list), { code: 'E_AVATAR_CATALOG_STALE' });
});

test('any stale avatar catalog identity or order is rejected without reinterpreting an ordinal', () => {
  const list = avatars(), snapshot = buildAvatarSnapshot(list);
  for (const field of ['key', 'label', 'kind', 'version', 'digest', 'url', 'personal']) {
    const changed = structuredClone(list); changed[7][field] = field === 'personal' ? false : 'changed';
    assert.throws(() => snapshot.resolve(8, changed), { code: 'E_AVATAR_CATALOG_STALE' }, field);
  }
  for (const changed of [list.slice(1), [...list].reverse(), [...list, { key: 'later', label: '新形象' }], null]) {
    assert.throws(() => snapshot.resolve(1, changed), { code: 'E_AVATAR_CATALOG_STALE' });
  }
  assert.throws(() => buildAvatarSnapshot([...list, list[0]]), { code: 'E_AVATAR_CATALOG' });
});

test('same currently ready avatar succeeds without applying settings or reloading', async () => {
  const f = fixture(), result = await f.capability.select('official-1');
  assert.equal(result.ok, true); assert.equal(result.ready, true); assert.equal(result.changed, false);
  assert.equal(result.label, '形象1'); assert.deepEqual(f.calls, []);
});

test('cancellation before selection and absent avatars apply no settings', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await f.capability.select('custom', { signal: controller.signal })).status, 'cancelled');
  assert.equal((await f.capability.select('custom', { isCurrent: () => false })).status, 'cancelled');
  assert.equal((await f.capability.select('absent')).status, 'failed');
  assert.deepEqual(f.calls, []);
});

test('selection uses the ordinary avatar setting and waits for matching actual body-ready capabilities', async () => {
  const f = fixture(), pending = f.capability.select('custom');
  assert.deepEqual(f.calls, [{ avatar: 'custom' }]);
  let settled = false; pending.then(() => { settled = true; });
  f.mismatchedReady('official-1'); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false);
  f.ready('custom'); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.key, 'custom'); assert.equal(result.changed, true);
  assert.equal(result.status, 'ready');
});

test('cancellation while loading restores only the previous configured key and late ready cannot revive selection', async () => {
  const f = fixture(), controller = new AbortController(), pending = f.capability.select('custom', { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(); const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.rolledBack, true);
  assert.equal(f.key(), 'official-1');
  assert.deepEqual(f.calls, [{ avatar: 'custom' }, { avatar: 'official-1' }]);
  f.ready('custom'); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.key(), 'official-1'); assert.equal(f.calls.length, 2);
});

test('timeout is bounded, restores the configured previous avatar and ignores later readiness', async () => {
  const f = fixture({ timeoutMs: 15 }), result = await f.capability.select('custom');
  assert.equal(result.status, 'timeout'); assert.equal(result.rolledBack, true);
  assert.equal(f.key(), 'official-1');
  f.ready('custom'); assert.equal(f.key(), 'official-1');
});

test('a visually completed selection wins a simultaneous cancellation and is never rolled back', async () => {
  const f = fixture(), controller = new AbortController(), pending = f.capability.select('custom', { signal: controller.signal });
  f.ready('custom'); controller.abort(); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.ready, true); assert.equal(f.key(), 'custom');
  assert.deepEqual(f.calls, [{ avatar: 'custom' }]);
});

test('later UI selection and toggle-away-back revisions cannot be overwritten by cancelled pending work', async () => {
  for (const backToTarget of [false, true]) {
    const f = fixture(), controller = new AbortController(), pending = f.capability.select('custom', { signal: controller.signal });
    f.ui('official-3'); if (backToTarget) f.ui('custom'); controller.abort();
    const result = await pending;
    assert.equal(result.status, 'superseded'); assert.equal(result.rolledBack, false);
    assert.equal(f.key(), backToTarget ? 'custom' : 'official-3');
    assert.deepEqual(f.calls, [{ avatar: 'custom' }]);
  }
});

test('a later capability request owns its avatar and the old generation performs no rollback', async () => {
  const f = fixture(), old = f.capability.select('custom'), next = f.capability.select('official-2');
  f.ready('official-2');
  assert.equal((await old).status, 'superseded'); assert.equal((await next).ok, true);
  assert.equal(f.key(), 'official-2');
  assert.deepEqual(f.calls, [{ avatar: 'custom' }, { avatar: 'official-2' }]);
});

test('logical caller invalidation cancels loading and rejected settings remain a truthful failed receipt', async () => {
  const f = fixture(); let current = true;
  const pending = f.capability.select('custom', { isCurrent: () => current }); current = false;
  assert.equal((await pending).status, 'cancelled'); assert.equal(f.key(), 'official-1');
  const failure = fixture({ applyFailure: true }), result = await failure.capability.select('custom');
  assert.equal(result.status, 'failed'); assert.equal(result.error, '设置未保存');
  assert.equal(result.rolledBack, false); assert.equal(failure.key(), 'official-1');
});
