'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectAvatarGLB } = require('../src/main/avatar-pack-glb');

function glb(doc, binary = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(doc)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
  const header = Buffer.alloc(20), bin = binary.length ? Buffer.concat([Buffer.alloc(8), binary]) : Buffer.alloc(0);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12); header.write('JSON', 16);
  if (bin.length) { bin.writeUInt32LE(binary.length); bin.write('BIN\0', 4); }
  return Buffer.concat([header, padded, bin]);
}
const base = () => ({ asset: { version: '2.0' }, nodes: [{ name: 'body', children: [1] }, { name: 'ear' }], scenes: [{ nodes: [0] }], scene: 0 });

test('accepts self-contained GLB and returns its named anchors', () => {
  const result = inspectAvatarGLB(glb(base()));
  assert.deepEqual([...result.nodeNames], ['body', 'ear']);
});

test('rejects external resource, required extension, cycles, duplicate anchors and non-finite values', () => {
  for (const change of [
    d => { d.images = [{ uri: 'https://example.com/a.png' }]; },
    d => { d.extensionsRequired = ['EXTERNAL']; },
    d => { d.nodes[1].children = [0]; },
    d => { d.nodes[1].name = 'body'; },
    d => { d.accessors = [{ count: 900000 }]; },
    d => { d.bufferViews = [{ buffer: 0, byteLength: 100 }]; },
  ]) { const doc = base(); change(doc); assert.throws(() => inspectAvatarGLB(glb(doc))); }
  const huge = glb(base()).toString('binary').replace('"2.0"', '1e400');
  assert.throws(() => inspectAvatarGLB(Buffer.from(huge, 'binary')));
});
