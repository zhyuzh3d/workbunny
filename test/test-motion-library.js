'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const core = require('../src/shared/motion-core');
const { MotionLibrary, validateMotion } = require('../src/main/motion-library');
const { Embodiment } = require('../src/main/embodiment');
const assets = require('../src/main/asset-library');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-motion-library-')); assets.setRoot(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let cfg = { motions: { disabled: [] } };
  const library = new MotionLibrary({ motions: [{ key: 'idle_one', slot: 'idle', label: '待机' }, { key: 'wave_one', slot: 'greet', label: '挥手' }],
    groups: [{ id: 'idle', label: '待机' }, { id: 'greet', label: '问候' }], getConfig: () => cfg,
    saveConfig: patch => { cfg = { ...cfg, motions: { ...cfg.motions, ...patch.motions } }; }, random: () => 0.2 });
  return { library, root, config: () => cfg };
}
test('weighted random choice respects exact cumulative probability and excludes disabled/zero weights', () => {
  const items = [{ key: 'one', weight: 1 }, { key: 'nine', weight: 9 }, { key: 'zero', weight: 0 }, { key: 'disabled', weight: 100, enabled: false }];
  const counts = { one: 0, nine: 0 };
  for (let i = 0; i < 1000; i++) counts[core.choose(items, () => (i + 0.5) / 1000).key]++;
  assert.deepEqual(counts, { one: 100, nine: 900 });
});
test('category edits preserve motion identities and idle safety, exact requests never choose a different action', t => {
  const f = fixture(t);
  f.library.save({ type: 'category-add', label: '开心', description: '高兴时' });
  const group = f.library.catalog().categories.find(g => g.label === '开心');
  f.library.save({ type: 'motion-update', key: 'wave_one', slot: group.id, weight: 7 });
  assert.equal(f.library.select(group.id).key, 'wave_one'); assert.equal(f.library.select('missing'), null);
  assert.equal(f.library.select('wave_one', { exact: true }).key, 'wave_one');
  f.library.save({ type: 'category-delete', id: 'idle', moveTo: group.id });
  assert.equal(f.library.idle().key, 'idle_one');
  assert.throws(() => f.library.save({ type: 'motion-delete', key: 'idle_one' }), /至少保留/);
  assert.throws(() => f.library.save({ type: 'motion-update', key: 'idle_one', weight: 0 }), /至少保留/);
  f.config().motions.disabled.push('wave_one'); assert.equal(f.library.select('wave_one'), null);
});
test('VRMA import is self contained, deduplicated and does not admit source traversal', t => {
  const f = fixture(t), source = path.resolve('src/renderer/assets/motions/greet_sachi.vrma');
  const first = f.library.import(source, { slot: 'greet', label: '自己的挥手' });
  const again = f.library.import(source, { slot: 'greet' }); assert.equal(first.key, again.key);
  assert.equal(f.library.catalog().motions.filter(m => m.personal).length, 1);
  assert(f.library.select(first.key).url.startsWith('file:'));
  const invalid = path.join(f.root, 'bad.vrma');fs.writeFileSync(invalid, Buffer.alloc(40));assert.throws(() => validateMotion(invalid), /VRMA/);
  f.config().motions.library.items.push({ key: '../outside', file: '../outside.vrma' });
  assert(!f.library.catalog().motions.some(m => m.key === '../outside'));
});
test('only actual current-avatar starts enter the five-action history and resolve command receipts', async t => {
  const f = fixture(t), sent = [];let now = 10000;
  const body = new Embodiment({ catalog: f.library, avatar: () => ({ key: 'model.vrm' }), send: ev => sent.push(ev), clock: () => now, timeoutMs: 25 });t.after(() => body.close());
  const promise = body.perform('greet');assert.equal(body.recent.length, 0);
  assert.equal(body.report({ ...sent[0], avatar: 'stale.vrm', key: 'wave_one', ok: true }), false);
  body.report({ ...sent[0], avatar: 'model.vrm', key: 'wave_one', ok: true });assert((await promise).ok);
  for (let i = 0; i < 8; i++) { now += 1000;body.report({ avatar: 'model.vrm', key: i % 2 ? 'wave_one' : 'idle_one', ok: true }); }
  assert.equal(body.recent.length, 5);assert.equal(body.recent.at(-1).key, 'wave_one');
  assert.equal((await body.perform('wave_one')).ok, false);
});
