'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { crc32 } = require('../src/main/avatar-pack-zip');
const { inspectAvatarPack } = require('../src/main/avatar-pack-reader');

function glb() {
  const source = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, nodes: [{ name: 'body' }, { name: 'wing' }] }));
  const json = Buffer.alloc(Math.ceil(source.length / 4) * 4, 32); source.copy(json);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12); header.write('JSON', 16); return Buffer.concat([header, json]);
}
function zip(files) {
  const chunks = [], directory = []; let offset = 0;
  for (const [file, value] of files) {
    const name = Buffer.from(file), data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const a = Buffer.alloc(30), b = Buffer.alloc(46);
    a.writeUInt32LE(0x04034b50); a.writeUInt16LE(20, 4); a.writeUInt32LE(crc32(data), 14); a.writeUInt32LE(data.length, 18); a.writeUInt32LE(data.length, 22); a.writeUInt16LE(name.length, 26);
    b.writeUInt32LE(0x02014b50); b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6); b.writeUInt32LE(crc32(data), 16); b.writeUInt32LE(data.length, 20); b.writeUInt32LE(data.length, 24); b.writeUInt16LE(name.length, 28); b.writeUInt32LE(offset, 42);
    chunks.push(a, name, data); directory.push(b, name); offset += a.length + name.length + data.length;
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dir, end]);
}
function fixture(change = () => {}) {
  const data = {
    actions: { categories: [{ id: 'idle', label: '待机', description: '平静待机' }], actions: [{ id: 'idle', category: 'idle', label: '呼吸', use: '平静待机', duration: 2, loop: true, idle: true }] },
    graph: { bindings: [{ channel: 'body_y', node: 'body', transform: 'position', component: 'y' }], anchors: [{ id: 'wing', node: 'wing' }],
      actions: [{ id: 'idle', loop: true, timeline: { duration: 2, tracks: [{ channel: 'body_y', frames: [{ time: 0, value: 0 }] }] } }] },
    interactions: { regions: [{ id: 'wing', pool: 'wing_pool', hitVolumes: [{ type: 'sphere', anchor: 'wing', size: [.2, .2, .2] }] }], pools: { wing_pool: [{ action: 'idle' }] } },
  };
  change(data);
  const files = new Map([['assets/model.glb', glb()], ['actions.json', Buffer.from(JSON.stringify(data.actions))],
    ['graph.json', Buffer.from(JSON.stringify(data.graph))], ['interactions.json', Buffer.from(JSON.stringify(data.interactions))]]);
  const manifest = { format: 'workbunny.avatar-pack', formatVersion: 1, id: 'figure', version: '1.0.0', character: { id: 'main', name: '形象', model: 'assets/model.glb' },
    requires: { runtime: 'declarative-3d-v1', features: ['transform-timeline-v1', 'hit-volumes-v1'] },
    actions: 'actions.json', graph: 'graph.json', interactions: 'interactions.json', defaultIdle: 'idle',
    assets: [...files].map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })) };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return zip(files);
}

test('one validated pack produces a consistent catalog, runtime and interaction map', async () => {
  const result = await inspectAvatarPack(fixture());
  assert.equal(result.catalog.motions.length, 1);
  assert.equal(result.catalog.idle().key, result.runtime.namespace + '_idle');
  assert.equal(result.runtime.actions[0].id, 'idle');
  assert.equal(result.interactions.regions[0].hitVolumes[0].anchor, 'wing');
});

test('rejects mismatched actions, unknown anchors and undeclared animation channels', async () => {
  for (const change of [
    d => { d.graph.actions[0].timeline.duration = 3; },
    d => { d.graph.anchors[0].node = 'unknown'; },
    d => { d.graph.actions[0].timeline.tracks[0].channel = 'unknown'; },
    d => { d.interactions.pools.wing_pool[0].action = 'missing'; },
    d => { d.graph.actions[0].effects = ['fire']; },
  ]) await assert.rejects(inspectAvatarPack(fixture(change)));
});
