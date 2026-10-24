'use strict';
/**
 * 形象库：扫 renderer/assets/models/ 下所有 .vrm，读 VRM 0.x / 1.0 的 meta 当显示名。
 *
 * 为什么要扫目录而不是写死数组：换角色是「丢一个文件进来」这种操作，
 * 不该每次都改代码重打包。key 直接用文件名，配置里存的就是它。
 */
const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '..', 'renderer', 'assets', 'models');

/* GLB 头：12 字节 + 第一个 chunk 就是 JSON。只解出 meta，不解整棵树。 */
function readMeta(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    fs.closeSync(fd);
    if (head.toString('ascii', 0, 4) !== 'glTF') return {};
    const jsonLen = head.readUInt32LE(12);
    const jsonType = head.toString('ascii', 16, 20);
    if (jsonType !== 'JSON' || !jsonLen || jsonLen > 64 * 1024 * 1024) return {};
    buf = Buffer.alloc(jsonLen);
    const fd2 = fs.openSync(file, 'r');
    fs.readSync(fd2, buf, 0, jsonLen, 20);
    fs.closeSync(fd2);
  } catch (e) {
    return {};
  }
  try {
    const gltf = JSON.parse(buf.toString('utf8'));
    const v1 = gltf.extensions && gltf.extensions.VRMC_vrm;
    const v0 = gltf.extensions && gltf.extensions.VRM;
    const meta = (v1 && v1.meta) || (v0 && v0.meta) || {};
    return {
      title: String(meta.name || meta.title || '').trim(),
      author: String(meta.authors ? [].concat(meta.authors).join(', ') : (meta.author || '')).trim(),
      version: String(meta.version || '').trim(),
      license: String(meta.licenseName || meta.licenseUrl || '').trim(),
      redistribute: !!(meta.licenseName && /Redistribution_Prohibited/i.test(meta.licenseName)),
      vrmVersion: v1 ? '1.0' : (v0 ? '0.x' : ''),
    };
  } catch (e) {
    return {};
  }
}

function scan(dir = MODELS_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.vrm$/i.test(n) && !n.startsWith('.'));
  } catch (e) {
    return [];
  }
  // 官方样例排在后面，自己的角色排前面：列表第一项就是默认形象
  const rank = (n) => (/^AvatarSample_/i.test(n) ? 1 : 0);
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names.map((file) => {
    const m = readMeta(path.join(dir, file));
    return {
      key: file,
      file,
      label: m.title || file.replace(/\.vrm$/i, ''),
      author: m.author || '',
      vrmVersion: m.vrmVersion || '',
      redistribute: m.redistribute || false,
    };
  });
}

/* 老配置里存的是 'D' / 'E' / 'F' / 'G'，换算成文件名；认不出来就退回第一个 */
function resolve(key, list) {
  const arr = list || scan();
  if (!arr.length) return null;
  if (key && arr.some((a) => a.key === key)) return key;
  if (key) {
    const legacy = arr.find((a) => a.key.toLowerCase() === `avatarsample_${String(key).toLowerCase()}.vrm`);
    if (legacy) return legacy.key;
    const byShort = arr.find((a) => a.key.toLowerCase() === `${String(key).toLowerCase()}.vrm`);
    if (byShort) return byShort.key;
  }
  return arr[0].key;
}

module.exports = { scan, resolve, readMeta, MODELS_DIR };
