'use strict';
const os = require('os');
function capabilities({ platform = process.platform, arch = process.arch, memory = os.totalmem(), version } = {}) {
  if (!version) {
    const darwin = Number(os.release().split('.')[0]);
    version = process.getSystemVersion?.() || String(darwin >= 25 ? darwin + 1 : darwin - 9);
  }
  const major = Number(String(version).split('.')[0]);
  const supported = platform === 'darwin' && arch === 'arm64' && major >= 13;
  const qwen = supported && memory >= 16 * 1024 ** 3 && major >= 13;
  return { platform, arch, version, major, memoryGiB: Math.round(memory / 1024 ** 3), supported,
    asrMode: supported ? (major >= 26 ? 'continuous' : 'single') : 'unavailable',
    qwen: { available: qwen, reason: memory < 16 * 1024 ** 3 ? '本地 Qwen 需要至少 16GB 内存' : major < 13 ? '需要 macOS 13 或更新系统' : !supported ? '需要 Apple Silicon Mac' : '' } };
}
function requireQwen() { const c = capabilities(); if (!c.qwen.available) throw new Error(c.qwen.reason); return c; }
module.exports = { capabilities, requireQwen };
