#!/usr/bin/env node
'use strict';
// Read-only evidence for repeatability review. Similar endpoints and a short
// duration are diagnostics, never sufficient to turn a story into a cycle.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { performancePlayback } = require('../src/main/performance-playback-policy');
const overrides = require('../src/main/performance-loop-overrides.json');

function analyzeVrma(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(8) !== bytes.length) throw Error('Invalid GLB');
  let doc, bin;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset), kind = bytes.readUInt32LE(offset + 4);
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (chunk.length !== size) throw Error('Truncated chunk');
    if (kind === 0x4e4f534a) doc = JSON.parse(chunk.toString());
    if (kind === 0x004e4942) bin = chunk;
    offset += 8 + size;
  }
  if (!doc || !bin) throw Error('Missing GLB data');
  function accessor(index) {
    const a = doc.accessors[index], v = doc.bufferViews[a.bufferView], width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
    if (a.componentType !== 5126 || !width || a.sparse || v.buffer !== 0) throw Error('Unsupported animation accessor');
    const stride = v.byteStride || width * 4, offset = (v.byteOffset || 0) + (a.byteOffset || 0);
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, k) => bin.readFloatLE(offset + i * stride + k * 4)));
  }
  const angle = (a, b) => {
    const norm = Math.hypot(...a) * Math.hypot(...b);
    return norm > 0 ? 2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, x, i) => sum + x * b[i], 0) / norm))) * 180 / Math.PI : NaN;
  };
  let duration = 0, rotations = 0;
  const gaps = [];
  for (const animation of doc.animations || []) for (const channel of animation.channels || []) {
    const sampler = animation.samplers[channel.sampler], times = accessor(sampler.input).map(row => row[0]);
    duration = Math.max(duration, ...times);
    if (channel.target.path !== 'rotation') continue;
    rotations++;
    const raw = accessor(sampler.output), values = sampler.interpolation === 'CUBICSPLINE' ? times.map((_, i) => raw[i * 3 + 1]) : raw;
    const first = values[0], last = values.at(-1);
    // Constant fingers and helper joints should not conceal a moving leg seam.
    if (values.some(q => angle(first, q) > 2)) gaps.push(angle(first, last));
  }
  gaps.sort((a, b) => a - b);
  return { durationSeconds: duration, rotationTracks: rotations, activeRotationTracks: gaps.length,
    seamMaxDegrees: gaps.at(-1) || 0, seamP95Degrees: gaps[Math.floor((gaps.length - 1) * .95)] || 0,
    seamRmsDegrees: gaps.length ? Math.sqrt(gaps.reduce((sum, n) => sum + n * n, 0) / gaps.length) : 0 };
}

function audit(root = path.resolve(__dirname, '..')) {
  return require(path.join(root, 'src/main/reviewed-motions')).map(motion => {
    const bytes = fs.readFileSync(path.join(root, 'src/renderer/assets/motions', motion.key + '.vrma'));
    return { key: motion.key, label: motion.label, sourceId: motion.sourceId, originalLoop: motion.loop,
      policy: performancePlayback(motion), basis: overrides[motion.key] ? 'reviewed-locomotion' : motion.transition || motion.postureChanging || motion.sourceId?.startsWith('sequence__') ? 'complete-transition-or-sequence' : motion.loop ? 'existing-loop-metadata' : 'once-unless-confirmed',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...analyzeVrma(bytes) };
  });
}
if (require.main === module) {
  const rows = audit(), target = process.argv[2];
  if (target) fs.writeFileSync(path.resolve(target), JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ motions: rows.length, cycle: rows.filter(m => m.policy.mode === 'cycle').length,
    once: rows.filter(m => m.policy.mode === 'once').length,
    overrides: rows.filter(m => overrides[m.key]).map(({ key, durationSeconds, seamMaxDegrees, seamRmsDegrees }) => ({ key, durationSeconds, seamMaxDegrees, seamRmsDegrees })),
    warning: 'Endpoint metrics do not establish semantic repeatability; review source intent and playback.' }));
}
module.exports = { analyzeVrma, audit };
