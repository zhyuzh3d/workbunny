'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { crc32, readAvatarPackZip } = require('../src/main/avatar-pack-zip');

function archive(items) {
  const locals = [], central = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), data = Buffer.from(item.data || ''), method = item.method ?? 8;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30), header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(3 << 8 | 20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(data), 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE((item.mode || 0x8000) * 65536, 38); header.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(header, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const base = () => [{ name: 'manifest.json', data: '{"format":"test"}' }, { name: 'assets/model.glb', data: '12345' }];

test('reads stored and deflated entries without extracting filesystem paths', () => {
  const items = base(); items[1].method = 0;
  items.push({ name: 'assets/', mode: 0x4000, data: '' });
  const pack = readAvatarPackZip(archive(items));
  assert.equal(pack.manifest.format, 'test');
  assert.equal(pack.files.get('assets/model.glb').toString(), '12345');
  assert.equal(pack.files.size, 1);
});

test('rejects path escapes, case collisions, symlinks, corruption and excessive sizes', () => {
  for (const extra of [
    { name: '../secret.json', data: '{}' },
    { name: 'ASSETS/MODEL.GLB', data: 'x' },
    { name: 'assets/link.json', mode: 0xa000, data: 'x' },
    { name: 'assets/script.js', data: 'x' },
  ]) assert.throws(() => readAvatarPackZip(archive([...base(), extra])));
  const invalid = archive(base()); invalid[30 + 'manifest.json'.length] ^= 1;
  assert.throws(() => readAvatarPackZip(invalid));
  const huge = archive(base());
  const eocd = huge.length - 22, directory = huge.readUInt32LE(eocd + 16);
  huge.writeUInt32LE(0xffffffff, directory + 24);
  assert.throws(() => readAvatarPackZip(huge));
});
