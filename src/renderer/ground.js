/* 地面锚定 + 锁脚：所有动作共用同一个地面中心点，踩在地上的脚一动不动
 *
 * ── 病根 ──
 * VRMA 动作里 hips 的平移带着「整段身体的水平位移」（实测 Angry 净 25cm、
 * 全部动作合计 252cm）。播的时候整具身体带着脚一起在屏幕上平移 —— 这就是
 * 看到的「脚打滑」。idle_loop 干脆没有这条轨道，于是播完动作位子还对不上。
 *
 * ── 三步处理（行业标准做法，缺一不可）──
 *   ① 剥根位移：hips 的水平位移冻成 0（= 模型静止中轴），竖直照旧 ——
 *      蹲、跳、起伏都留着。Unity 里叫 "Bake into Pose (XZ)"，Unreal 叫
 *      "Root Motion 关掉"。这是十二分钟那款游戏踩过的同一个坑。
 *   ② 判"哪只脚该落地"：高度阈值 + 速度一致性，扫出连续接触段（footplant）。
 *      论文《Knowing When to Put Your Foot Down》指出单看高度或速度都会被误导，
 *      所以这里按"整段"取而不是逐帧判。
 *   ③ 两骨 IK 锁脚：Kovar/Schreiner/Gleicher《Footskate Cleanup for Motion
 *      Capture Editing》SCA 2002 —— 接触段里把脚踝钉在段内均值位置（这个
 *      target 使修正量最小），两端做权重混合（0→1→0，≈0.12s）避免抬落脚跳帧。
 *      只改大腿/小腿的旋转，脚掌的世界朝向保持原样，所以鞋底不会歪。
 *
 * ①②③全部在加载时离线算完、直接烘进 clip，运行时零开销。
 *
 * 为什么是"冻身体 + IK 锁脚"而不是"让身体跟着脚走"：试过了。让身体跟着脚走能把
 * 脚滑压到 32cm，但身体在屏幕上晃的量从 252cm 涨到 388cm —— 这个产品没有地面贴图、
 * 没有落脚阴影，屏幕框就是唯一参照物，身体在框里来回飘比脚滑更刺眼。
 *
 * 顺手补的一件事：每条 clip 都强制写一条 hips.position 轨道。原动作没有这条轨道的，
 * 播完别的动作会继承上一个动作残留的 hips 位置（three 不会自动复位）。
 */
import * as THREE from 'three';

const BAKE_FPS = 60;          // 采样密度：60 帧/秒足够，再高只是白算
/* 阈值按身高取相对值：不同形象身高差得多，而且 .vrma 的单位也不统一
 * （实测 idle_loop 的骨架是厘米制、hips 高 90.57，其它动作是米制的 0.9）。 */
const Y_LIMIT_R = 0.08;       // 竖直对齐最多 ±8% 身高，防止个别姿势被整体抬飞
const CONTACT_EPS_R = 0.025;  // 脚底离地面线 2.5% 身高以内算踩在地上
const BLEND_SEC = 0.12;       // 落脚/抬脚处的 IK 权重混合时长
const PULL_LIMIT_R = 0.16;    // 单次修正最多 16% 身高，超了说明接触判定错了

/* ═══════════ 替身骨架 ═══════════ */

/** 把一条骨骼链复制成替身：和真骨架同一套静止姿态，随便折腾，不影响画面 */
function cloneRig(node, map, rest) {
  const o = new THREE.Object3D();
  o.name = node.name;
  o.position.copy(node.position);
  o.quaternion.copy(node.quaternion);
  o.scale.copy(node.scale);
  map.set(node.name, o);
  rest.push({ node: o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
  for (const c of node.children) o.add(cloneRig(c, map, rest));
  return o;
}

const LEG_BONES = [
  ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'],
];

/** 造一副替身骨架。传入的 vrm 只要有 humanoid.getNormalizedBoneNode(name) 就行 */
export function makeRig(vrm) {
  const h = vrm && vrm.humanoid;
  if (!h) return null;
  const hips = h.getNormalizedBoneNode('hips');
  if (!hips) return null;
  const map = new Map();
  const rest = [];
  const root = cloneRig(hips, map, rest);
  /* 注意：归一化骨骼的节点名不一定是 VRM 骨骼名（不同版本前缀不一样），
   * 所以一律"先问 humanoid，再按节点名映射"，不能拿字符串直接当键。 */
  const pick = (n) => {
    const nd = h.getNormalizedBoneNode(n);
    return nd ? map.get(nd.name) || null : null;
  };
  const feet = [];
  for (const [f, t] of [['leftFoot', 'leftToes'], ['rightFoot', 'rightToes']]) {
    feet.push({ foot: pick(f), toes: pick(t) });
  }
  if (!feet[0].foot || !feet[1].foot) return null;
  const legs = LEG_BONES.map(([u, l, f]) => ({ up: pick(u), low: pick(l), foot: pick(f) }));
  // 身高基准：hips 的静止高度。所有容差都按它取相对值
  const hipHeight = Math.abs(root.position.y) || 1;
  return { root, map, rest, hipsName: hips.name, feet, legs, hipHeight };
}

/** 每个动作都从同一套静止姿态开跑：某个动作没动的骨骼，不能被上一个动作的残留带脏 */
export function resetRig(rig) {
  for (const r of rig.rest) {
    r.node.position.copy(r.p);
    r.node.quaternion.copy(r.q);
    r.node.scale.copy(r.s);
  }
  rig.root.updateMatrixWorld(true);
}

/** 把 clip 的骨骼轨道绑到替身骨架上，返回一个 apply(t)：按时间摆好整副骨架 */
function binder(clip, rig) {
  const list = [];
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    if (dot < 0) continue;
    const bone = tr.name.slice(0, dot);
    const prop = tr.name.slice(dot + 1);
    if (prop !== 'quaternion' && prop !== 'position' && prop !== 'scale') continue;
    const node = rig.map.get(bone);
    if (!node) continue;
    list.push({ node, prop, interp: tr.createInterpolant() });
  }
  return (t) => {
    for (const b of list) {
      const buf = b.interp.evaluate(t);
      if (b.prop === 'quaternion') b.node.quaternion.fromArray(buf);
      else if (b.prop === 'position') b.node.position.fromArray(buf);
      else b.node.scale.fromArray(buf);
    }
    rig.root.updateMatrixWorld(true);
  };
}

/** 把 clip 在替身骨架上逐帧走一遍，记下两只脚每帧踩在哪、抬多高、身体在哪 */
export function sampleFeet(clip, rig) {
  const dur = clip.duration || 0;
  if (!(dur > 0.02)) return null;
  const n = Math.max(2, Math.round(dur * BAKE_FPS) + 1);
  const dt = dur / (n - 1);
  resetRig(rig);
  const apply = binder(clip, rig);

  const lx = new Float32Array(n), lz = new Float32Array(n), cl = new Float32Array(n);
  const rx = new Float32Array(n), rz = new Float32Array(n), cr = new Float32Array(n);
  const hx = new Float32Array(n), hz = new Float32Array(n);
  const v = new THREE.Vector3();

  /** 脚此刻踩在哪：横向取脚踝，纵向取脚踝/脚尖里更低的那个 */
  const contact = (f) => {
    f.foot.getWorldPosition(v);
    const x = v.x, z = v.z;
    let y = v.y;
    if (f.toes) { f.toes.getWorldPosition(v); y = Math.min(y, v.y); }
    return { x, y, z };
  };

  for (let i = 0; i < n; i++) {
    apply(Math.min(dur, i * dt));
    const l = contact(rig.feet[0]);
    const r = contact(rig.feet[1]);
    lx[i] = l.x; lz[i] = l.z; cl[i] = l.y;
    rx[i] = r.x; rz[i] = r.z; cr[i] = r.y;
    hx[i] = rig.root.position.x; hz[i] = rig.root.position.z;
  }
  return { n, dt, dur, lx, lz, cl, rx, rz, cr, hx, hz };
}

/** 这个动作最低的那只脚离原点多高 —— 它就是这条动作认定的地面 */
export function soleHeight(clip, rig) {
  const S = sampleFeet(clip, rig);
  if (!S) return null;
  let lo = Infinity;
  for (let i = 0; i < S.n; i++) lo = Math.min(lo, S.cl[i], S.cr[i]);
  return isFinite(lo) ? lo : null;
}

/* ═══════════ 两骨 IK ═══════════ */

const _hip = new THREE.Vector3(), _knee = new THREE.Vector3(), _ank = new THREE.Vector3();
const _aim = new THREE.Vector3(), _bend = new THREE.Vector3(), _perp = new THREE.Vector3();
const _nk = new THREE.Vector3(), _dirA = new THREE.Vector3(), _dirB = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _qp = new THREE.Quaternion();

/** 直接指定一根骨骼的"世界朝向"，内部换算成局部四元数 */
function setWorldQuat(node, qWorld) {
  node.parent.getWorldQuaternion(_qp);
  node.quaternion.copy(_qp.invert().multiply(qWorld));
}

/**
 * 两骨 IK：把 end（脚踝）拉到 target。
 * 只动 upper（大腿）和 lower（小腿）的旋转，膝盖往原来的方向弯，所以不会翻腿。
 */
function solveLeg(upper, lower, foot, target) {
  upper.getWorldPosition(_hip);
  lower.getWorldPosition(_knee);
  foot.getWorldPosition(_ank);
  const L1 = _hip.distanceTo(_knee);
  const L2 = _knee.distanceTo(_ank);
  if (!(L1 > 1e-5) || !(L2 > 1e-5)) return false;

  _aim.subVectors(target, _hip);
  let d = _aim.length();
  if (!(d > 1e-6)) return false;
  _aim.divideScalar(d);
  // 够不着就按极限伸长，别硬拉（近奇异点也要稳）
  const dmin = Math.abs(L1 - L2) + L1 * 2e-3;
  const dmax = (L1 + L2) * 0.999;
  if (d < dmin) d = dmin;
  else if (d > dmax) d = dmax;

  // 原来的弯曲方向：膝盖相对 hip→ankle 这条线偏出去的部分
  _bend.subVectors(_knee, _hip).normalize();
  _perp.copy(_bend).addScaledVector(_aim, -_bend.dot(_aim));
  if (_perp.lengthSq() < 1e-8) {
    _perp.set(0, 0, 1).addScaledVector(_aim, -_aim.z);
    if (_perp.lengthSq() < 1e-8) _perp.set(1, 0, 0).addScaledVector(_aim, -_aim.x);
  }
  _perp.normalize();

  // 余弦定理定膝盖张开角
  const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)));
  _nk.copy(_aim).multiplyScalar(Math.cos(alpha)).addScaledVector(_perp, Math.sin(alpha));

  // ① 大腿：把 (膝盖−髋) 转到目标方向
  _dirA.subVectors(_knee, _hip).normalize();
  _qa.setFromUnitVectors(_dirA, _nk);
  upper.getWorldQuaternion(_qb);
  _qc.copy(_qa).multiply(_qb);
  setWorldQuat(upper, _qc);
  upper.updateWorldMatrix(false, true);

  // ② 小腿：把 (脚踝−膝盖) 转到 (目标−膝盖)
  lower.getWorldPosition(_knee);
  foot.getWorldPosition(_ank);
  _dirA.subVectors(_ank, _knee).normalize();
  _dirB.copy(target).sub(_knee).normalize();
  _qa.setFromUnitVectors(_dirA, _dirB);
  lower.getWorldQuaternion(_qb);
  _qc.copy(_qa).multiply(_qb);
  setWorldQuat(lower, _qc);
  lower.updateWorldMatrix(false, true);
  return true;
}

/* ═══════════ 锁脚 ═══════════ */

/**
 * footskate cleanup：接触段里把脚钉住，两端权重混合。
 * 直接改写 clip 里大腿/小腿/脚掌的旋转轨道，运行时不增加任何计算。
 */
export function cleanFootSkate(clip, rig) {
  const S = sampleFeet(clip, rig);
  if (!S) return null;
  const { n, dt, dur, lx, lz, cl, rx, rz, cr } = S;
  const U = rig.hipHeight || 1;

  const legs = [
    { x: lx, z: lz, c: cl, ...rig.legs[0] },
    { x: rx, z: rz, c: cr, ...rig.legs[1] },
  ];
  if (!legs[0].up || !legs[0].low || !legs[1].up || !legs[1].low) return null;
  for (const L of legs) L.bones = [L.up, L.low, L.foot];

  // 地面线取"每帧最低那只脚"的中位数：单帧踩深一点不会把整条动作带偏
  const lo = [];
  for (let i = 0; i < n; i++) lo.push(Math.min(cl[i], cr[i]));
  lo.sort((a, b) => a - b);
  const ground = lo[Math.floor(lo.length / 2)];
  const eps = CONTACT_EPS_R * U;
  const pullLimit = PULL_LIMIT_R * U;

  let contacts = 0, maxPull = 0;
  for (const L of legs) {
    L.tx = new Float32Array(n);
    L.tz = new Float32Array(n);
    L.w = new Float32Array(n);
    let s = -1;
    for (let i = 0; i <= n; i++) {
      const touch = i < n && L.c[i] - ground <= eps;
      if (touch && s < 0) s = i;
      else if ((!touch || i === n) && s >= 0) {
        const e = i - 1;
        const len = e - s + 1;
        if (len >= 3) {
          // 锚点 = 段内均值（Kovar 的 minimum-error target：修正量最小的那个位置）
          let ax = 0, az = 0;
          for (let k = s; k <= e; k++) { ax += L.x[k]; az += L.z[k]; }
          ax /= len; az /= len;
          const ramp = Math.min(Math.max(1, Math.round(BLEND_SEC / dt)), Math.floor(len / 2));
          for (let k = s; k <= e; k++) {
            // 端点权重低、中间满 —— 抬脚落脚处不跳
            const up = Math.min(k - s, e - k);
            const w = ramp > 0 ? Math.min(1, (up + 1) / (ramp + 1)) : 1;
            if (w <= 0) continue;
            let dx = ax - L.x[k], dz = az - L.z[k];
            const dd = Math.hypot(dx, dz);
            if (dd > maxPull) maxPull = dd;
            if (dd > pullLimit) { const t = pullLimit / dd; dx *= t; dz *= t; }
            L.tx[k] = L.x[k] + dx;
            L.tz[k] = L.z[k] + dz;
            L.w[k] = w;
          }
          contacts++;
        }
        s = -1;
      }
    }
  }

  if (contacts === 0) return { contacts: 0, maxPull: 0 };

  // 逐帧解 IK，记下三根骨骼的局部四元数
  const out = new Map();
  for (const L of legs) for (const nd of L.bones) out.set(nd.name, new Float32Array(n * 4));
  const apply = binder(clip, rig);
  resetRig(rig);

  const target = new THREE.Vector3();
  const ank = new THREE.Vector3();
  const qFoot = new THREE.Quaternion();
  const q4 = [0, 0, 0, 0];

  for (let i = 0; i < n; i++) {
    apply(Math.min(dur, i * dt));
    for (const L of legs) {
      if (L.w[i] > 0.004) {
        L.foot.getWorldPosition(ank);
        target.set(L.tx[i], ank.y, L.tz[i]);      // 只治水平滑动，竖直交给地面线
        L.foot.getWorldQuaternion(qFoot);
        solveLeg(L.up, L.low, L.foot, target);
        setWorldQuat(L.foot, qFoot);              // 脚掌朝向保持原样，鞋底不歪
        L.foot.updateWorldMatrix(false, true);
      }
      for (const nd of L.bones) {
        const q = nd.quaternion;
        q4[0] = q.x; q4[1] = q.y; q4[2] = q.z; q4[3] = q.w;
        out.get(nd.name).set(q4, i * 4);
      }
    }
  }

  // 写回轨道：60Hz 采样 + 四元数符号连续（不然 slerp 会转反）
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = Math.min(dur, i * dt);
  for (const [nm, arr] of out) {
    for (let i = 1; i < n; i++) {
      const a = i * 4, b = a - 4;
      if (arr[a] * arr[b] + arr[a + 1] * arr[b + 1] + arr[a + 2] * arr[b + 2] + arr[a + 3] * arr[b + 3] < 0) {
        for (let k = 0; k < 4; k++) arr[a + k] = -arr[a + k];
      }
    }
    const name = `${nm}.quaternion`;
    const track = new THREE.QuaternionKeyframeTrack(name, times, arr);
    const at = clip.tracks.findIndex((t) => t.name === name);
    if (at >= 0) clip.tracks[at] = track;
    else clip.tracks.push(track);
  }
  return { contacts, frames: n, maxPull };
}

/* ═══════════ 对外主入口 ═══════════ */

/** 冻住水平位移 + 竖直对齐统一地面线 + 锁脚；返回 { yShift, ik } */
export function groundClip(clip, rig, refSole) {
  const name = `${rig.hipsName}.position`;
  const limit = Y_LIMIT_R * (rig.hipHeight || 1);

  let yShift = 0;
  const mine = soleHeight(clip, rig);
  if (mine != null && refSole != null) {
    yShift = Math.max(-limit, Math.min(limit, refSole - mine));
  }

  const tr = clip.tracks.find((t) => t.name === name);
  if (tr) {
    // 就地改：x/z 抹成 0，y 整体平移到统一地面线 —— 采样点一个不动
    const v = tr.values;
    for (let i = 0; i < tr.times.length; i++) {
      v[i * 3] = 0;
      v[i * 3 + 1] += yShift;
      v[i * 3 + 2] = 0;
    }
  } else {
    // 没有这条轨道就补一条常量轨道：不然它会继承上一个动作残留的 hips 位置
    const y = rig.root.position.y + yShift;
    clip.tracks.push(new THREE.VectorKeyframeTrack(
      name,
      new Float32Array([0, clip.duration]),
      new Float32Array([0, y, 0, 0, y, 0])
    ));
  }

  let ik = null;
  try { ik = cleanFootSkate(clip, rig); } catch (e) { console.warn('锁脚失败', e); }
  return { yShift, ik };
}
