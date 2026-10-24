#!/usr/bin/env node
/* 地面锚定回归测试：拿真实 .vrma 跑一遍完整管线，验两件事
 *   ① 身体在屏幕上不再整体平移（判据：hips 水平净位移 + 来回晃都应接近 0）
 *   ② 脚在地上别滑得更厉害（只做对照报告，不当判据 —— 见 ground.js 顶部说明）
 * 用法：node tools/ground-test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import { makeRig, sampleFeet, soleHeight, groundClip } from '../src/renderer/ground.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '../src/renderer/assets/motions');

function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}
const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function acc(g, bin, idx) {
  const a = g.accessors[idx], bv = g.bufferViews[a.bufferView];
  const [Arr, bytes] = CT[a.componentType], n = NC[a.type];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || bytes * n;
  const out = new Float32Array(a.count * n);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++)
    out[i * n + c] = new Arr(bin.buffer, bin.byteOffset + base + i * stride + c * bytes, 1)[0];
  return out;
}

/** 用 .vrma 自带的骨骼树造一副替身。运行时那副是 VRM 模型的 normalized humanoid，
 *  这里用 .vrma 自己的骨架 —— 在「动作本身长什么样」这个层面是等价的。 */
function load(file) {
  const { json: g, bin } = parseGLB(fs.readFileSync(file));
  const nodes = (g.nodes || []).map((nd) => {
    const o = new THREE.Object3D();
    o.name = nd.name || 'x';
    if (nd.translation) o.position.fromArray(nd.translation);
    if (nd.rotation) o.quaternion.fromArray(nd.rotation);
    if (nd.scale) o.scale.fromArray(nd.scale);
    return o;
  });
  const isChild = new Set();
  (g.nodes || []).forEach((nd, i) => (nd.children || []).forEach((c) => { nodes[i].add(nodes[c]); isChild.add(c); }));
  const root = new THREE.Object3D();
  nodes.forEach((o, i) => { if (!isChild.has(i)) root.add(o); });
  const scene = new THREE.Object3D(); scene.add(root);

  const hb = g.extensions.VRMC_vrm_animation.humanoid.humanBones;
  const map = new Map(Object.entries(hb).map(([k, v]) => [k, nodes[v.node]]));
  const vrm = { humanoid: { getNormalizedBoneNode: (n) => map.get(n) || null } };

  const anim = g.animations[0];
  const PROP = { translation: 'position', rotation: 'quaternion', scale: 'scale' };
  const tracks = []; let dur = 0;
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const t = Array.from(acc(g, bin, s.input));
    dur = Math.max(dur, t[t.length - 1]);
    const prop = PROP[ch.target.path];
    if (!prop) continue;
    const name = `${nodes[ch.target.node].name}.${prop}`;
    const v = Array.from(acc(g, bin, s.output));
    tracks.push(prop === 'quaternion' ? new THREE.QuaternionKeyframeTrack(name, t, v) : new THREE.VectorKeyframeTrack(name, t, v));
  }
  return { vrm, clip: new THREE.AnimationClip('a', dur, tracks) };
}

/** 身体在屏幕上挪了多少 + 脚在地上滑了多少（单次落脚内的净位移） */
function measure(clip, rig) {
  const S = sampleFeet(clip, rig);
  if (!S) return null;
  const { n, lx, lz, cl, rx, rz, cr, hx, hz } = S;
  const U = rig.hipHeight || 1;
  const toCm = (v) => (v / U) * 88;              // hips 高 ≈ 身高的 52%，折算成 165cm 身高的 cm

  // 身体：采样时 hips 节点已被轨道驱动，逐帧记下的世界位置就是身体在屏幕上的位置

  let bodyPath = 0;
  for (let i = 1; i < n; i++) bodyPath += Math.hypot(hx[i] - hx[i - 1], hz[i] - hz[i - 1]);
  const bodyNet = Math.hypot(hx[n - 1] - hx[0], hz[n - 1] - hz[0]);

  const eps = 0.02 * U;
  const lo = [];
  for (let i = 0; i < n; i++) lo.push(Math.min(cl[i], cr[i]));
  lo.sort((a, b) => a - b);
  const ground = lo[Math.floor(lo.length / 2)];

  let maxNet = 0;
  for (const [xs, zs, cs] of [[lx, lz, cl], [rx, rz, cr]]) {
    let s = -1;
    for (let i = 0; i <= n; i++) {
      const g = i < n && cs[i] - ground <= eps;
      if (g && s < 0) s = i;
      else if (!g && s >= 0) {
        const e = i - 1;
        if (e - s >= 2) maxNet = Math.max(maxNet, Math.hypot(xs[e] - xs[s], zs[e] - zs[s]));
        s = -1;
      }
    }
  }
  return { bodyPath: toCm(bodyPath), bodyNet: toCm(bodyNet), footMax: toCm(maxNet) };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.vrma')).sort();
const built = [];
for (const f of files) built.push({ name: f.replace('.vrma', ''), ...load(path.join(DIR, f)) });

const rig = makeRig(built[0].vrm);
if (!rig) { console.error('骨架不全'); process.exit(1); }

const soles = new Map();
for (const b of built) soles.set(b.name, soleHeight(b.clip, rig));
const ref = soles.get('idle_loop') ?? [...soles.values()].sort((a, b) => a - b)[Math.floor(soles.size / 2)];

console.log('动作          身体净/晃 前 → 后        脚滑 前→后    竖直对齐  落脚段   拉腿');
let bad = 0;
for (const b of built) {
  const before = measure(b.clip, rig);
  const r = groundClip(b.clip, rig, ref);
  const after = measure(b.clip, rig);
  const ok = after.bodyPath < 1 && after.bodyNet < 1;
  if (!ok) bad++;
  console.log(
    b.name.padEnd(13),
    `${before.bodyNet.toFixed(0)}/${before.bodyPath.toFixed(0)}`.padStart(9),
    '→',
    `${after.bodyNet.toFixed(2)}/${after.bodyPath.toFixed(2)}`.padStart(11),
    `${before.footMax.toFixed(0)}→${after.footMax.toFixed(0)}cm`.padStart(13),
    `${((r.yShift / rig.hipHeight) * 88).toFixed(1)}cm`.padStart(9),
    `${r.ik ? r.ik.contacts : 0}`.padStart(5),
    `${r.ik ? ((r.ik.maxPull / rig.hipHeight) * 88).toFixed(1) : '-'}cm`.padStart(8),
    ok ? '' : '  ✗ 身体还在动'
  );
}
console.log(bad === 0 ? '\n✓ 所有动作身体水平位移已归零' : `\n✗ ${bad} 个动作身体仍在移动`);
