'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AvatarPackStore } = require('../src/main/avatar-pack-store');

async function inspect(bytes) {
  const value = JSON.parse(bytes.toString());
  if (value.bad) throw Error('invalid package');
  return { metadata: { id: value.id, version: value.version }, manifest: { character: { name: value.name } } };
}
const payload = version => Buffer.from(JSON.stringify({ id: 'test', version, name: '角色' }));
function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-pack-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new AvatarPackStore(dir, { inspect }) };
}

test('staging is invisible until committed and replacing preserves old content', async t => {
  const state = store(t), staged = await state.store.prepare(payload('1.0.0'));
  assert.equal(state.store.index().items.length, 0);
  const first = state.store.commit(staged.token);
  assert.equal((await state.store.read(first.key)).entry.version, '1.0.0');
  const newer = await state.store.prepare(payload('2.0.0'), { targetKey: first.key });
  assert.equal((await state.store.read(first.key)).entry.version, '1.0.0');
  const second = state.store.commit(newer.token);
  assert.equal(second.key, first.key);
  assert.equal((await state.store.read(first.key)).entry.version, '2.0.0');
  assert.ok(fs.existsSync(path.join(state.store.objects, first.digest + '.wbavatar')));
  assert.equal(new AvatarPackStore(state.dir, { inspect }).index().items[0].digest, second.digest);
  const restored = await state.store.rollback(first.key);
  assert.equal(restored.entry.version, '1.0.0');
  assert.equal((await state.store.read(first.key)).entry.version, '1.0.0');
  state.store.remove(first.key);
  assert.equal(state.store.index().items.length, 0);
});

test('failed or conflicting upgrades keep the prior committed package', async t => {
  const state = store(t), first = state.store.commit((await state.store.prepare(payload('1.0.0'))).token);
  await assert.rejects(state.store.prepare(Buffer.from('{"bad":true}'), { targetKey: first.key }), /invalid package/);
  const a = await state.store.prepare(payload('2.0.0'), { targetKey: first.key });
  const b = await state.store.prepare(payload('3.0.0'), { targetKey: first.key });
  state.store.commit(a.token);
  assert.throws(() => state.store.commit(b.token), /changed while staging/);
  assert.equal(state.store.discard(b.token), true);
  assert.equal((await state.store.read(first.key)).entry.version, '2.0.0');
});

test('staged tampering and symlinks are rejected before the index changes', async t => {
  const state = store(t), first = state.store.commit((await state.store.prepare(payload('1.0.0'))).token);
  const next = await state.store.prepare(payload('2.0.0'), { targetKey: first.key });
  const stagePath = path.join(state.store.staging, next.token + '.tmp');
  fs.unlinkSync(stagePath); fs.symlinkSync(path.join(state.store.objects, first.digest + '.wbavatar'), stagePath);
  assert.throws(() => state.store.commit(next.token));
  assert.equal((await state.store.read(first.key)).entry.version, '1.0.0');
  state.store.discard(next.token);
});
