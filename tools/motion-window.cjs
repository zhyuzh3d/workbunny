'use strict';
/**
 * 给过长的动作自动挑一段：取"运动最密集"的 4.5 秒。
 *
 * 为什么要切：这批动作里有一半是 8~20 秒的展示片段，整条播会把娃娃钉在原地
 * 十几秒（主人说完一句话她还在摆姿势）。人工逐条看太慢，所以用能量曲线自动选：
 * 把所有骨骼的旋转角差 + 位移按时间累加成一条"忙不忙"的曲线，
 * 再在上面滑一个固定长度的窗口，取最忙的那段。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'motions');
const BIN = 0.1;      // 能量统计的时间分辨率（秒）
const WIN = 4.5;      // 目标窗口长度
const MAXT = 6.5;     // 超过这个长度才切
const LOOP_PREFIX = ['idle_', 'work_'];   // 待机循环：整条播，不切

const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const SZ = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const RD = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };

function loadGlb(p) {
  const d = fs.readFileSync(p);
  if (d.toString('ascii', 0, 4) !== 'glTF') throw new Error('非 GLB');
  let off = 12, js = null, bin = null;
  while (off + 8 <= d.length) {
    const cl = d.readUInt32LE(off), ct = d.readUInt32LE(off + 4);
    const body = d.subarray(off + 8, off + 8 + cl);
    if (ct === 0x4e4f534a) js = JSON.parse(body.toString('utf8').replace(/\s+$/, ''));
    else if (ct === 0x004e4942) bin = body;
    off += 8 + cl + (cl % 4 ? 4 - (cl % 4) : 0);
  }
  return { js, bin };
}

const dvCache = new WeakMap();
function readAcc(js, bin, idx) {
  const acc = js.accessors[idx];
  const n = acc.count, nc = NCOMP[acc.type];
  const bv = js.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || nc * SZ[acc.componentType];
  let dv = dvCache.get(bin);
  if (!dv) { dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength); dvCache.set(bin, dv); }
  const fn = RD[acc.componentType];
  const out = new Float64Array(n * nc);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < nc; k++) out[i * nc + k] = dv[fn](base + i * stride + k * SZ[acc.componentType], true);
  }
  return out;
}

function energyCurve(p) {
  const { js, bin } = loadGlb(p);
  const anim = js.animations[0];
  let dur = 0;
  for (const s of anim.samplers) {
    const t = readAcc(js, bin, s.input);
    dur = Math.max(dur, t[t.length - 1]);
  }
  const nb = Math.max(1, Math.ceil(dur / BIN));
  const e = new Float64Array(nb);
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const t = readAcc(js, bin, s.input);
    const v = readAcc(js, bin, s.output);
    if (t.length < 2) continue;
    const isRot = ch.target.path === 'rotation';
    const nc = v.length / t.length;
    for (let i = 0; i + 1 < t.length; i++) {
      let step = 0;
      if (isRot) {
        let dot = 0;
        for (let k = 0; k < nc; k++) dot += v[i * nc + k] * v[(i + 1) * nc + k];
        dot = Math.min(1, Math.max(-1, Math.abs(dot)));
        step = 2 * Math.acos(dot);
      } else {
        let sum = 0;
        for (let k = 0; k < nc; k++) { const d = v[(i + 1) * nc + k] - v[i * nc + k]; sum += d * d; }
        step = Math.sqrt(sum) * 20;
      }
      const a = t[i], b = t[i + 1];
      if (!(b > a)) continue;
      const share = (step * BIN) / (b - a);
      const i0 = Math.floor(a / BIN), i1 = Math.min(nb - 1, Math.floor(b / BIN));
      for (let j = i0; j <= i1; j++) e[j] += share;
    }
  }
  return { dur, e };
}

function bestWindow(dur, e) {
  const w = Math.min(WIN, dur);
  const wb = Math.max(1, Math.round(w / BIN));
  if (e.length <= wb) return null;
  const c = new Float64Array(e.length + 1);
  for (let i = 0; i < e.length; i++) c[i + 1] = c[i] + e[i];
  let best = -1, bi = 0;
  for (let i = 0; i + wb <= e.length; i++) {
    const s = c[i + wb] - c[i];
    if (s > best) { best = s; bi = i; }
  }
  const t0 = Math.round(bi * BIN * 100) / 100;
  return [t0, Math.round(Math.min(dur, t0 + w) * 100) / 100];
}

const out = [];
for (const f of fs.readdirSync(DIR).sort()) {
  if (!f.endsWith('.vrma')) continue;
  const key = f.slice(0, -5);
  if (LOOP_PREFIX.some((p) => key.startsWith(p))) continue;
  let r;
  try { r = energyCurve(path.join(DIR, f)); } catch (e) { console.error('  !', key, e.message); continue; }
  if (r.dur <= MAXT) continue;
  const w = bestWindow(r.dur, r.e);
  if (!w) continue;
  out.push({ key, dur: +r.dur.toFixed(2), w });
}
console.log(`需要切段 ${out.length} 条（> ${MAXT}s 的一次性动作）`);
console.log(out.map((o) => `  ${o.key}: [${o.w[0]}, ${o.w[1]}],   // 原长 ${o.dur}s`).join('\n'));
fs.writeFileSync(path.join(__dirname, '..', 'shots', 'windows.txt'), JSON.stringify(out, null, 0));
