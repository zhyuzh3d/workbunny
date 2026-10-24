/* 从一条长动作里切出一段来用
 *
 * ── 为什么要切 ──
 * VRoid Motion Pack 那批动作是「展示用」的：hello 15.8 秒、motion_pose 20 秒、
 * peace_sign 11.7 秒。娃娃说一句话只有 4 秒，给她放一条 20 秒的动作，她就得
 * 卡在那儿僵 16 秒 —— 动作比话长，人看着像卡住了。
 * 而且 hello 开头是整理头发、中间张开手、结尾又回到站姿；VRMA_07 里甚至夹了一段
 * 还原成 T-pose 的空档（第 7 秒实测双臂完全平举），整条照播必然露馅。
 *
 * ── 做法 ──
 * 按时间窗口 [t0, t1) 重建每条轨道：窗口内的原始关键帧保留，两个端点各插一个新
 * 关键帧（用轨道自己的插值器求值，四元数走 slerp），时间轴平移到 0 起点。
 * 之后照常走 ground.js 的「冻位移 + 统一地面 + 锁脚」，所以切出来的段和整条一样稳。
 */
import * as THREE from 'three';

const EPS = 1e-4;

/* 切段表：key → [起, 止]（秒）。没写的整条播。
 *
 * 92 条里超过 6.5 秒的一次性动作（跳过 idle_/work_ 这种循环待机）全部切一刀 ——
 * 这批是「展示用」素材：转圈、猫步、展示自己，整条 8~20 秒。
 * 娃娃说一句话只有 4 秒，给她放一条 20 秒的动作，她就得卡在那儿僵 16 秒。
 *
 * 窗口不是猜的：tools/motion-window.cjs 把每条动作的所有骨骼旋转（四元数角差）
 * 加位移，按 0.1 秒分箱累加成一条「忙不忙」曲线，再滑一个 4.5 秒的窗取最忙的那段 ——
 * 也就是"这段里动作最密"，切出来最不像站着发呆。
 * 列在下面的是实测值（原时长注在后面）。 */
export const MOTION_WINDOWS = {
  angry_arms: [14.7, 19.17],   // 原 19.17s
  angry_hip: [2.2, 6.7],   // 原 7.33s
  angry_tsundere: [0, 4.5],   // 原 8.33s
  dance_excited: [0.1, 4.6],   // 原 6.53s
  dance_excited_maya: [0.1, 4.6],   // 原 6.57s
  dance_macarena: [0.1, 4.6],   // 原 8.23s
  greet_turn: [7.4, 11.9],   // 原 15.77s
  greet_yeah: [1.5, 6],   // 原 7.27s
  motion_cute: [4.7, 9.2],   // 原 19.97s
  pose_model: [0, 4.5],   // 原 7.52s
  pose_show: [3.6, 8.1],   // 原 11.80s
  pose_spin: [0.7, 5.2],   // 原 9.32s
  praise_shoot: [0.2, 4.7],   // 原 9.60s
  shy_bashful: [0.1, 4.6],   // 原 11.00s
  shy_cute: [0, 4.5],   // 原 8.33s
  shy_face: [0.5, 5],   // 原 11.52s
  sign_peace: [6.9, 11.4],   // 原 11.68s
  tease_cat: [0.6, 5.1],   // 原 8.33s
  tease_catwalk: [8.7, 13.2],   // 原 15.13s
  tease_scare: [0, 4.5],   // 原 7.67s
  thanks_bow_reika: [1.6, 6.1],   // 原 7.00s
  think_idea: [3.8, 8.3],   // 原 9.33s
  tired_armstretch: [1, 5.5],   // 原 8.88s
  tired_sitnap: [1, 5.5],   // 原 8.30s
  tired_yawn: [3.2, 7.7],   // 原 8.33s
};

export function cutClip(clip, t0, t1) {
  const dur = clip.duration;
  const a = Math.max(0, Math.min(t0, dur - 0.05));
  const b = Math.max(a + 0.05, Math.min(t1, dur));
  if (a <= EPS && b >= dur - EPS) return clip;   // 整条就要，别白复制一遍

  const tracks = [];
  for (const tr of clip.tracks) {
    const stride = tr.getValueSize();
    const interp = tr.createInterpolant();
    const times = [a];
    for (let i = 0; i < tr.times.length; i++) {
      const t = tr.times[i];
      if (t > a + EPS && t < b - EPS) times.push(t);
    }
    times.push(b);

    const values = new Float32Array(times.length * stride);
    for (let i = 0; i < times.length; i++) {
      const v = interp.evaluate(times[i]);
      for (let k = 0; k < stride; k++) values[i * stride + k] = v[k];
      times[i] -= a;
    }
    tracks.push(new tr.constructor(tr.name, new Float32Array(times), values));
  }
  return new THREE.AnimationClip(`${clip.name}@${a.toFixed(2)}-${b.toFixed(2)}`, b - a, tracks);
}
