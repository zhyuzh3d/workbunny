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
 * 每条边界都是"肉眼看定帧"定的，不是猜的（shots/anim 里留着证据）：
 *   greeting       1.7 站起来 → 5.6 挥完手（0~1.7 是蹲在地上，不要）
 *   greeting2      1.2~3.6 含蓄的单手挥（两头是静止站姿）
 *   hello          8.0 双手抱到脑后伸懒腰 → 13.0 张开手臂
 *   peace_sign     1.2~5.0 举手比耶
 *   spin           0.6~7.6 转一圈并摆姿势
 *   show_full_body 1.2~5.2 张开手把自己展示一遍
 *   model_pose     1.0~4.2 手抬到胸前的摆拍位
 *   motion_pose    11.5~15.5 迈步走近的一段（整条 20 秒太散）
 *   VRMA_07        3.6~6.4 扶脸/整理衣领 —— 第 7 秒会还原成 T-pose，必须躲开
 *   shoot          6.0~9.2 手举到头侧张开（招呼 / 敬礼）
 *   grabbed        0.15~3.2 被拎起来缩一下
 * idle-maid 整条循环（实测竖直振幅 0.00cm，钉死的站姿）
 * idle-sitting 不接入：并腿姿势把裙子顶穿（大腿从裙摆里穿出来） */
export const MOTION_WINDOWS = {
  greeting: [1.7, 5.6],
  greeting2: [1.2, 3.6],
  hello: [8.0, 13.0],
  peace_sign: [1.2, 5.0],
  spin: [0.6, 7.6],
  show_full_body: [1.2, 5.2],
  model_pose: [1.0, 4.2],
  motion_pose: [11.5, 15.5],
  VRMA_07: [3.6, 6.4],
  shoot: [6.0, 9.2],
  grabbed: [0.15, 3.2],
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
