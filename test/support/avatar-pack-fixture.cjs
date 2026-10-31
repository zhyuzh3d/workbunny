'use strict';
const crypto = require('node:crypto');
const { crc32 } = require('../../src/main/avatar-pack-zip');

function glb() {
  const bin = Buffer.alloc(168);
  [-.7, -.6, 0, .7, -.6, 0, 0, .7, 0].forEach((n, i) => bin.writeFloatLE(n, i * 4));
  [0, 1, 2].forEach((n, i) => bin.writeUInt16LE(n, 36 + i * 2));
  for (let i = 0; i < 3; i++) bin.writeFloatLE(1, 56 + i * 16);
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -.25, 0, 1].forEach((n, i) => bin.writeFloatLE(n, 104 + i * 4));
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 },
      { buffer: 0, byteOffset: 44, byteLength: 12 }, { buffer: 0, byteOffset: 56, byteLength: 48 }, { buffer: 0, byteOffset: 104, byteLength: 64 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-.7, -.6, 0], max: [.7, .7, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }, { bufferView: 2, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' }, { bufferView: 4, componentType: 5126, count: 1, type: 'MAT4' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 1 }] }],
    skins: [{ joints: [1], skeleton: 1, inverseBindMatrices: 4 }],
    nodes: [{ name: 'body', mesh: 0, skin: 0, children: [1] }, { name: 'wing', translation: [0, .25, 0] }], scenes: [{ nodes: [0] }], scene: 0 };
  const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32); raw.copy(json);
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length + 8 + bin.length, 8); header.writeUInt32LE(json.length, 12); header.write('JSON', 16);
  binHeader.writeUInt32LE(bin.length); binHeader.write('BIN\0', 4);
  return Buffer.concat([header, json, binHeader, bin]);
}
function zip(files) {
  const chunks = [], central = []; let offset = 0;
  for (const [file, value] of files) {
    const name = Buffer.from(file), data = Buffer.isBuffer(value) ? value : Buffer.from(value), local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc32(data), 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    chunks.push(local, name, data); central.push(entry, name); offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dir, end]);
}
function packageBytes(version = '1.0.0', { speech } = {}) {
  const actions = { categories: [{ id: 'idle', label: '待机', description: '平静待机' }, { id: 'cheer', label: '开心', description: '表达开心' }], actions: [
    { id: 'idle', category: 'idle', label: '呼吸', use: '平静待机', duration: 2, loop: true, idle: true },
    { id: 'wave', category: 'cheer', label: '挥动', use: '高兴时挥动', duration: 1 },
  ] };
  const graph = { bindings: [{ channel: 'wing_z', node: 'wing', transform: 'rotation', component: 'z' }], anchors: [{ id: 'wing', node: 'wing' }],
    springs: [{ joints: [{ node: 'wing', tip: [0, .5, 0], hz: 3, damping: .7, maxAngle: .5 }] }], actions: [
    { id: 'idle', loop: true, timeline: { duration: 2, tracks: [{ channel: 'wing_z', frames: [{ time: 0, value: 0 }] }] } },
    { id: 'wave', timeline: { duration: 1, tracks: [{ channel: 'wing_z', frames: [{ time: 0, value: 0 }, { time: .5, value: 1, ease: 'snap' }, { time: 1, value: 0 }] }] } },
  ] };
  const interactions = { regions: [{ id: 'wing', pool: 'wing_pool', hitVolumes: [{ type: 'sphere', anchor: 'wing', size: [.3, .3, .3] }] }], pools: { wing_pool: [{ action: 'wave', ...(speech ? { speech } : {}) }] } };
  const files = new Map([['assets/model.glb', glb()], ['actions.json', Buffer.from(JSON.stringify(actions))], ['graph.json', Buffer.from(JSON.stringify(graph))], ['interactions.json', Buffer.from(JSON.stringify(interactions))]]);
  const manifest = { format: 'workbunny.avatar-pack', formatVersion: 1, id: 'fixture', version, character: { id: 'main', name: '测试形象', model: 'assets/model.glb' },
    requires: { runtime: 'declarative-3d-v1', features: ['transform-timeline-v1', 'hit-volumes-v1', 'spring-bone-v1', 'dual-quaternion-skin-v1'] }, actions: 'actions.json', graph: 'graph.json', interactions: 'interactions.json', defaultIdle: 'idle',
    assets: [...files].map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })) };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return zip(files);
}
module.exports = { packageBytes };
