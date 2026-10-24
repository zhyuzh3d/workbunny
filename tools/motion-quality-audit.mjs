#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { analyzeMotionTracks, processMotionClip } from '../src/renderer/motion-quality.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src/renderer/assets/motions');
const output = path.join(root, 'tools/motion-quality-report.json');
const COMPONENTS = { 5120: ['getInt8', 1], 5121: ['getUint8', 1], 5122: ['getInt16', 2], 5123: ['getUint16', 2], 5125: ['getUint32', 4], 5126: ['getFloat32', 4] };
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const loopKeys = new Set(require('../src/main/config.js').MOTIONS.filter((motion) => motion.loop).map((motion) => motion.key));

function readGlb(file) {
  const data = fs.readFileSync(file);
  if (data.toString('ascii', 0, 4) !== 'glTF') throw new Error('not GLB');
  let off = 12, json, bin;
  while (off + 8 <= data.length) {
    const len = data.readUInt32LE(off), type = data.readUInt32LE(off + 4), body = data.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8').replace(/[\u0000\u0020]+$/, ''));
    if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('missing GLB JSON/BIN chunk');
  const readAccessor = (index) => {
    const a = json.accessors[index], view = json.bufferViews[a.bufferView], [method, size] = COMPONENTS[a.componentType], width = WIDTHS[a.type];
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength), base = (view.byteOffset || 0) + (a.byteOffset || 0);
    const stride = view.byteStride || size * width, out = new Float64Array(a.count * width);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) out[i * width + k] = dv[method](base + i * stride + k * size, true);
    return { values: out, width };
  };
  return { json, readAccessor };
}

function summarize(file) {
  const { json, readAccessor } = readGlb(file), animation = json.animations?.[0];
  if (!animation) throw new Error('no animation');
  const tracks = [], unsupportedChannels = [];
  for (const channel of animation.channels || []) {
    const sampler = animation.samplers[channel.sampler], input = readAccessor(sampler.input).values;
    const { values, width } = readAccessor(sampler.output), pathName = channel.target.path;
    if (sampler.interpolation === 'CUBICSPLINE' || values.length !== input.length * width) {
      unsupportedChannels.push({ node: json.nodes[channel.target.node]?.name || `node${channel.target.node}`,
        path: pathName, interpolation: sampler.interpolation || 'LINEAR' });
      continue;
    }
    const trackProperty = pathName === 'rotation' ? 'quaternion' : pathName === 'translation' ? 'position' : pathName;
    const name = `${json.nodes[channel.target.node]?.name || `node${channel.target.node}`}.${trackProperty}`;
    const TrackType = trackProperty === 'quaternion' ? QuaternionKeyframeTrack : VectorKeyframeTrack;
    tracks.push(new TrackType(name, Float32Array.from(input), Float32Array.from(values)));
  }
  const name = path.basename(file, '.vrma'), loop = loopKeys.has(name);
  const rows = analyzeMotionTracks(tracks, { loop });
  const loopSeamCandidates = loop ? rows.filter((r) => (r.type === 'quaternion' && r.seamGap > 0.06)
    || (['position', 'scale'].includes(r.type) && r.seamGap > 0.01)).length : 0;
  const findings = rows.filter((r) => r.invalid || r.signFlips || r.outliers || (loop && r.seamGap > (r.type === 'quaternion' ? 0.06 : 0.01)));
  const duration = tracks.reduce((d, t) => Math.max(d, t.times[t.times.length - 1] || 0), 0);
  const repairTracks = tracks.map((t) => new t.constructor(t.name, Float32Array.from(t.times), Float32Array.from(t.values)));
  const repairs = processMotionClip({ tracks: repairTracks }, { loop });
  return { name, durationSeconds: +duration.toFixed(3), loop, channels: animation.channels.length, sampledChannels: tracks.length, unsupportedChannels,
    keyframes: rows.reduce((n, t) => n + t.keys, 0), quaternionTracks: rows.filter((r) => r.type === 'quaternion').length,
    positionTracks: rows.filter((r) => r.type === 'position').length, loopSeamCandidates,
    quaternionSignDiscontinuities: rows.reduce((n, r) => n + r.signFlips, 0),
    repairs: { normalizedQuaternionKeys: repairs.quaternionKeysNormalized, quaternionSignFlips: repairs.quaternionSignFlips,
      isolatedSpikes: repairs.isolatedSpikesRepaired, loopSeamsSmoothed: repairs.loopSeamsSmoothed },
    flaggedTracks: findings.length, findings: findings.map((r) => ({ track: r.name, type: r.type, keys: r.keys,
      invalidQuaternions: r.invalid, signDiscontinuities: r.signFlips, isolatedSpikeCandidates: r.outliers,
      seamGap: +r.seamGap.toFixed(5) })) };
}

const files = fs.readdirSync(dir).filter((name) => name.endsWith('.vrma')).sort();
const motions = files.map((name) => {
  try { return summarize(path.join(dir, name)); }
  catch (error) { return { name: path.basename(name, '.vrma'), error: String(error.message || error) }; }
});
const report = { generatedAt: new Date().toISOString(), source: 'src/renderer/assets/motions/*.vrma',
  policy: { quaternionNormTolerance: [0.8, 1.2], isolatedQuaternionSpike: 'adjacent changes > 1.35rad, neighbor change < 0.30rad',
    vectorSpike: 'position deviation > 0.08 source units or scale > 0.15 and >5x neighbor delta',
    loopCandidates: 'MOTIONS.loop from config.js; quaternion tails for gaps >0.06rad; position gap 0.01-0.5 source units; scale gap 0.01-0.4; eased 0.25-0.8s tail' },
  totals: { files: files.length, parsed: motions.filter((m) => !m.error).length, parseErrors: motions.filter((m) => m.error).length,
    channels: motions.reduce((n, m) => n + (m.channels || 0), 0), sampledChannels: motions.reduce((n, m) => n + (m.sampledChannels || 0), 0),
    unsupportedChannels: motions.reduce((n, m) => n + (m.unsupportedChannels?.length || 0), 0), keyframes: motions.reduce((n, m) => n + (m.keyframes || 0), 0),
    quaternionTracks: motions.reduce((n, m) => n + (m.quaternionTracks || 0), 0), positionTracks: motions.reduce((n, m) => n + (m.positionTracks || 0), 0),
    tracksWithFindings: motions.reduce((n, m) => n + (m.flaggedTracks || 0), 0), isolatedSpikeCandidates: motions.reduce((n, m) => n + m.findings?.reduce((x, f) => x + f.isolatedSpikeCandidates, 0), 0),
    quaternionSignDiscontinuities: motions.reduce((n, m) => n + (m.quaternionSignDiscontinuities || 0), 0),
    loopMotions: motions.filter((m) => m.loop).length, loopSeamFindings: motions.reduce((n, m) => n + (m.loopSeamCandidates || 0), 0),
    inMemoryRepairs: Object.fromEntries(['normalizedQuaternionKeys', 'quaternionSignFlips', 'isolatedSpikes', 'loopSeamsSmoothed'].map((key) => [key, motions.reduce((n, m) => n + (m.repairs?.[key] || 0), 0)])) },
  motions };
if (!report.totals.quaternionTracks || !report.totals.positionTracks) throw new Error('Audit failed: no quaternion/position tracks classified');
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.totals, null, 2));
