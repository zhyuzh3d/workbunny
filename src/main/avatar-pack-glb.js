'use strict';

const MAX_JSON = 8 * 1024 * 1024;
const LIMITS = { nodes: 4096, meshes: 2048, accessors: 8192, bufferViews: 8192, materials: 1024, textures: 1024, images: 1024, animations: 512 };
function assert(value, message) { if (!value) throw Error(message); }
function imageDimensions(data, mime) {
  if (mime === 'image/png') {
    assert(data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR', 'invalid PNG image');
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  assert(mime === 'image/jpeg' && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8, 'unsupported image');
  let pos = 2;
  while (pos < data.length) {
    assert(data[pos++] === 0xff, 'invalid JPEG image');
    while (pos < data.length && data[pos] === 0xff) pos++;
    const marker = data[pos++];
    if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    assert(marker !== 0xd9 && marker !== 0xda && pos + 2 <= data.length, 'JPEG dimensions unavailable');
    const length = data.readUInt16BE(pos);
    assert(length >= 2 && pos + length <= data.length, 'invalid JPEG image');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      assert(length >= 8, 'invalid JPEG dimensions'); return [data.readUInt16BE(pos + 5), data.readUInt16BE(pos + 3)];
    }
    pos += length;
  }
  throw Error('JPEG dimensions unavailable');
}

// This validates the container and rejects external resources before passing
// bytes to GLTFLoader. The renderer must still enforce resource/GPU budgets.
function inspectAvatarGLB(data) {
  assert(Buffer.isBuffer(data) && data.length >= 20 && data.toString('ascii', 0, 4) === 'glTF' &&
    data.readUInt32LE(4) === 2 && data.readUInt32LE(8) === data.length, 'invalid GLB header');
  const jsonLength = data.readUInt32LE(12);
  assert(data.toString('ascii', 16, 20) === 'JSON' && jsonLength > 0 && jsonLength % 4 === 0 && jsonLength <= MAX_JSON && 20 + jsonLength <= data.length, 'invalid GLB JSON');
  let doc;
  try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(20, 20 + jsonLength))); }
  catch { throw Error('invalid GLB JSON'); }
  assert(doc && doc.asset?.version === '2.0', 'unsupported glTF version');
  assert(doc.extensionsRequired === undefined || Array.isArray(doc.extensionsRequired) && doc.extensionsRequired.length === 0, 'unsupported required glTF extension');
  let binLength = 0, offset = 20 + jsonLength;
  if (offset < data.length) {
    assert(offset + 8 <= data.length, 'invalid GLB binary chunk');
    binLength = data.readUInt32LE(offset);
    assert(binLength % 4 === 0 && data.toString('ascii', offset + 4, offset + 8) === 'BIN\0' && offset + 8 + binLength === data.length, 'invalid GLB binary chunk');
  }
  for (const [key, limit] of Object.entries(LIMITS)) assert(doc[key] === undefined || Array.isArray(doc[key]) && doc[key].length <= limit, `invalid glTF ${key}`);
  assert(doc.buffers === undefined || Array.isArray(doc.buffers) && doc.buffers.length <= 1, 'invalid glTF buffers');
  if (doc.buffers?.length) {
    const length = doc.buffers[0]?.byteLength;
    assert(Number.isSafeInteger(length) && length >= 0 && length <= binLength && binLength - length <= 3, 'invalid glTF buffer size');
  } else assert(binLength === 0, 'unreferenced glTF binary chunk');
  for (const accessor of doc.accessors || []) assert(Number.isSafeInteger(accessor.count) && accessor.count >= 0 && accessor.count <= 600000, 'glTF accessor too large');
  for (const view of doc.bufferViews || []) {
    const start = view.byteOffset ?? 0;
    assert(view.buffer === 0 && Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(view.byteLength) &&
      view.byteLength >= 0 && start + view.byteLength <= (doc.buffers?.[0]?.byteLength ?? 0), 'invalid glTF buffer view');
  }
  let pixels = 0;
  for (const image of doc.images || []) {
    assert(Number.isInteger(image.bufferView) && image.bufferView >= 0 && image.bufferView < (doc.bufferViews || []).length, 'invalid embedded image');
    const view = doc.bufferViews[image.bufferView], start = offset + 8 + (view.byteOffset || 0);
    const [width, height] = imageDimensions(data.subarray(start, start + view.byteLength), image.mimeType);
    assert(width > 0 && height > 0 && width <= 4096 && height <= 4096, 'image dimensions exceed limit');
    pixels += width * height; assert(pixels <= 32 * 1024 * 1024, 'avatar image budget exceeded');
  }
  const stack = [doc];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'number') assert(Number.isFinite(value), 'non-finite glTF value');
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value)) assert(!Object.hasOwn(value, 'uri'), 'external glTF resource is not allowed');
    for (const item of Object.values(value)) stack.push(item);
  }
  const names = new Set();
  for (const node of doc.nodes || []) if (typeof node.name === 'string' && node.name) {
    assert(!names.has(node.name), 'duplicate glTF node name'); names.add(node.name);
  }
  const nodes = doc.nodes || [], colors = new Uint8Array(nodes.length), parent = new Int32Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) for (const child of nodes[i].children || []) {
    assert(Number.isInteger(child) && child >= 0 && child < nodes.length && parent[child] === -1, 'invalid glTF node hierarchy');
    parent[child] = i;
  }
  for (let i = 0; i < nodes.length; i++) {
    let n = i;
    while (n !== -1 && colors[n] === 0) { colors[n] = 1; n = parent[n]; }
    assert(n === -1 || colors[n] !== 1, 'cyclic glTF node hierarchy');
    n = i;
    while (n !== -1 && colors[n] === 1) { colors[n] = 2; n = parent[n]; }
  }
  return { doc, nodeNames: names };
}

module.exports = { inspectAvatarGLB };
