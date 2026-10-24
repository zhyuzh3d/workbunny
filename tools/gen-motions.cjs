'use strict';
/**
 * 生成 config.js 里的 MOTIONS 表。
 *
 * 为什么用脚本生成而不是手写：92 条动作，手写一次必漏；
 * 而且「新名 ← 原包/原文件名」这张对照表必须永远和磁盘上的文件一致 ——
 * 用 tools/motion-map.cjs 做唯一真相源，脚本自动带上 src 字段，改一次全对。
 */
const fs = require('fs');
const path = require('path');
const { MAP } = require('./motion-map.cjs');

/* key → [槽位, 中文名, 是否循环, 什么时候用] */
const META = {
  // ── idle：闲着的时候。主人没在干活，她可以动、可以东看西看 ──────────────
  idle_breath: ['idle', '呼吸待机', true, '什么事都没有时的默认站姿'],
  idle_loop: ['idle', '循环待机', true, '最省事的循环站姿，兜底用'],
  idle_shift: ['idle', '换脚站', true, '站着把重心从一只脚换到另一只'],
  idle_lalala: ['idle', '哼歌撒娇', true, '心情不错、轻轻晃着等主人'],
  idle_look: ['idle', '四处张望', true, '好奇、找东西、等回应'],
  idle_stand: ['idle', '站姿待机一', true, '安静站着，偶尔小动作'],
  idle_stand2: ['idle', '站姿待机二', true, '安静站着，另一种站法'],
  idle_pose: ['idle', '待机姿势', true, '标准站姿，最不抢戏'],
  idle_walk_mocopi: ['idle', '原地走动', true, '原地走两步转个圈，动捕质感'],

  // ── work：主人在专注干活。她"在，但不打扰" ──────────────────────────────
  work_maid: ['work', '安静站姿', true, '主人在干活时的待命站姿，手交叠几乎不动'],
  work_sit: ['work', '坐姿待命', true, '坐姿待命（裙子会被顶穿，只在动作列表里手动看）'],

  // ── greet：打招呼 / 迎接 ────────────────────────────────────────────────
  greet_wave: ['greet', '挥手打招呼', false, '主人刚回来、早安、轻一点的招呼'],
  greet_turn: ['greet', '转身打招呼', false, '背对着你再转过来打招呼'],
  greet_yeah: ['greet', '起身 yeah', false, '从蹲姿站起来举双手，主人离开很久回来时的迎接'],
  greet_hand: ['greet', '高举挥手', false, '远远看见你、用力挥手'],

  // ── bye：告别 ───────────────────────────────────────────────────────────
  bye_wave: ['bye', '轻轻挥手', false, '轻声告别，byebye'],
  bye_wave_maya: ['bye', '留恋挥手', false, '舍不得地挥手'],
  bye_goodbye: ['bye', '说话式告别', false, '边说边摆手，任务交付完的收尾'],

  // ── cheer：庆祝 / 高兴 ──────────────────────────────────────────────────
  cheer_yay: ['cheer', '举双手欢呼', false, '非常高兴，庆祝 + 爱心'],
  cheer_arms: ['cheer', '举双手胜利', false, '举双手庆祝胜利'],
  cheer_clap_vr: ['cheer', '鼓掌一', false, '称赞、恭喜、干得漂亮'],
  cheer_clap_cipher: ['cheer', '鼓掌二', false, '称赞、恭喜（另一种鼓掌）'],
  cheer_clap_maya: ['cheer', '鼓掌三', false, '有点高冷的鼓掌'],
  cheer_jump_vr: ['cheer', '轻松跳', false, '活动身体、准备开工'],
  cheer_hop: ['cheer', '高兴地跳', false, '好消息、兴奋'],
  cheer_joy: ['cheer', '萌妹跳', false, '扮可爱的高兴，成功的时候'],
  cheer_cross: ['cheer', '来回跳', false, '高兴地左右跳，也可以是无聊时的活动'],

  // ── praise：夸你 / 得意 ────────────────────────────────────────────────
  praise_shoot: ['praise', '开枪命中', false, '对着你比枪，bingo，夸你或挑逗'],
  praise_snap: ['praise', '响指', false, '优雅挑逗：小意思、不在话下'],
  praise_thumb: ['praise', '坐姿点赞', false, '坐着翘大拇指：你可真不错'],

  // ── sign：手势 ─────────────────────────────────────────────────────────
  sign_peace: ['sign', '比耶', false, '胜利、卖萌、办成了'],

  // ── dance：跳舞 / 兴奋 ─────────────────────────────────────────────────
  dance_macarena: ['dance', '尬舞', false, '有趣地跳舞，逗主人开心'],
  dance_excited: ['dance', '原地扭动一', false, '高兴地原地扭动'],
  dance_excited_maya: ['dance', '原地扭动二', false, '小幅度扭动跳舞'],

  // ── tease：逗你玩 ──────────────────────────────────────────────────────
  tease_cat: ['tease', '小猫扭屁股', false, '学小猫弯腰，被夸奖时用，很调皮'],
  tease_scare: ['tease', '吓你一跳', false, '顽皮地轻轻吓你'],
  tease_zombie: ['tease', '学僵尸', false, '伸着手学僵尸逗你'],
  tease_headbutt: ['tease', '假装对打', false, '冲上来假装要和你对打，顽皮'],
  tease_catwalk: ['tease', '学猫步', false, '夸张猫步走上前再走回去，很高兴很满意'],
  tease_peek: ['tease', '藏猫猫', false, '背对着你再转头偷看'],
  tease_punch: ['tease', '伸手戳你', false, '伸手戳你一下，挑逗'],
  tease_stand: ['tease', '挑逗站姿', false, '超可爱的挑逗站姿'],

  // ── refuse：拒绝 / 不要 ────────────────────────────────────────────────
  refuse_waving: ['refuse', '挥手拒绝', false, '不要了不要了'],
  refuse_head: ['refuse', '摇头否认', false, '轻轻摇头，不强烈'],
  refuse_no: ['refuse', '拒绝手势', false, '摆手表示不'],
  refuse_startle: ['refuse', '吓一跳拒绝', false, '被吓到然后拒绝'],
  refuse_fear: ['refuse', '慌忙否认', false, '匆忙摆手否认'],
  refuse_reject: ['refuse', '夸张失望', false, '哎呀不要了，夸张的失望'],
  refuse_shrug: ['refuse', '摊手无奈', false, '还能怎么办呢'],

  // ── angry：生气 ────────────────────────────────────────────────────────
  angry_arms: ['angry', '抱胸跺脚', false, '双手抱胸还跺脚，不开心'],
  angry_pout: ['angry', '御姐生气', false, '被亏待、抱怨（玩笑级别）'],
  angry_stomp: ['angry', '生气跺脚', false, '跺脚扭头不理你'],
  angry_tsundere: ['angry', '傲娇不理你', false, '责怪你、闹别扭'],
  angry_hip: ['angry', '叉腰生气', false, '叉腰，很有气势地生气'],

  // ── shy：害羞 ──────────────────────────────────────────────────────────
  shy_cute: ['shy', '可爱害羞', false, '害羞得不敢看你'],
  shy_bashful: ['shy', '腼腆', false, '有点不情愿又不说'],
  shy_face: ['shy', '扶脸', false, '整理仪表、害羞'],
  shy_sway: ['shy', '害羞看你', false, '害羞地晃着，期待你的反应'],

  // ── think：思考 ────────────────────────────────────────────────────────
  think_lady: ['think', '淑女思考', false, '低头想一想'],
  think_cute: ['think', '萌妹思考', false, '歪头想事情'],
  think_idea: ['think', '灵光一闪', false, '优雅地想到好主意'],
  think_ultra: ['think', '奥特曼手势', false, '无聊时的招牌手势'],
  think_dw: ['think', '傲娇思考', false, '让我想想呢'],

  // ── sorry：认错 / 低落 ─────────────────────────────────────────────────
  sorry_droop: ['sorry', '低头认错', false, '做错了、低头不语'],
  sorry_grab: ['sorry', '整个人垂下', false, '无可奈何、被拎起来那种垂头'],
  sorry_sad: ['sorry', '背手低头', false, '不开心、遗憾'],
  sorry_cry: ['sorry', '哭', false, '伤心地哭，也可以是假装哭的恶作剧'],
  sorry_sigh: ['sorry', '叹气松懈', false, '唉，不想再努力了'],

  // ── tired：困了 / 伸懒腰 ───────────────────────────────────────────────
  tired_reach: ['tired', '伸懒腰', false, '刚睡醒、坐太久催主人动一动'],
  tired_stretch_vr: ['tired', '舒展身体', false, '放松、伸个懒腰'],
  tired_armstretch: ['tired', '运动前拉伸', false, '干活或运动前的准备拉伸'],
  tired_yawn: ['tired', '打哈欠', false, '慵懒、不太想理人'],
  tired_nod: ['tired', '打瞌睡', false, '困得点头'],
  tired_sleep: ['tired', '有点困', false, '深夜、主人很久没理我'],
  tired_sitnap: ['tired', '坐着打瞌睡', false, '坐着困得不行'],

  // ── thanks：感谢 / 拜托 ────────────────────────────────────────────────
  thanks_bow_reika: ['thanks', '鞠躬拜托', false, '拜托了！太感谢了！'],
  thanks_cipher: ['thanks', '感谢臣服', false, '非常感谢，或表示忠心'],
  thanks_maya: ['thanks', '衷心感谢', false, '衷心地道谢'],

  // ── surprise：惊讶 ─────────────────────────────────────────────────────
  surprise_vr: ['surprise', '小惊喜退避', false, '哎呦呦，不要不要'],
  surprise_cipher: ['surprise', '惊讶比划', false, '哎呦呦这么厉害，后仰比划'],
  surprise_scratch: ['surprise', '抓抓头', false, '好像忘了什么'],

  // ── pose：展示自己 ─────────────────────────────────────────────────────
  pose_show: ['pose', '展示自己', false, '被问长什么样、被问穿了什么'],
  pose_model: ['pose', '单手叉腰', false, '傲娇地摆个姿势'],
  pose_spin: ['pose', '优雅亮相', false, '登场、被夸到飞起'],

  // ── motion：原地运动 ───────────────────────────────────────────────────
  motion_cute: ['motion', '扮可爱', false, '扮可爱吸引你注意'],
  motion_walk: ['motion', '模特步', false, '原地走模特步'],
  motion_run: ['motion', '原地跑', false, '有急事、或者做运动'],
  motion_spin: ['motion', '转圈', false, '跳起来转圈，无聊做运动或高兴'],
  motion_spinjump: ['motion', '冲过来转圈', false, '武术式冲过来再回去，无聊时偶发'],
  motion_situp: ['motion', '仰卧起坐', false, '原地做仰卧起坐'],
  motion_situp2: ['motion', '起坐起身', false, '做完仰卧起坐站起来'],

  // ── talk：说话（事件用：她边说边比划）───────────────────────────────────
  talk_talk: ['talk', '说话带手势', false, '站着说话，带手势'],
};

/* 哪些槽交给模型挑（进提示词）；其余由代码在事件上用 */
const LLM_SLOTS = ['idle', 'greet', 'bye', 'cheer', 'praise', 'sign', 'dance', 'tease',
  'refuse', 'angry', 'shy', 'think', 'sorry', 'tired', 'thanks', 'surprise', 'pose', 'motion'];

const lines = [];
for (const [dir, file, key] of MAP) {
  const m = META[key];
  if (!m) { console.error('缺 META：', key); process.exit(1); }
  const [slot, label, loop, use] = m;
  const tag = LLM_SLOTS.includes(slot) ? 'llm' : 'event';
  const src = `${dir.split('/').pop()} / ${file}`;
  lines.push(`  { key: '${key}', slot: '${slot}', label: '${label}', loop: ${loop}, tag: '${tag}', use: '${use}', src: '${src}' },`);
}

fs.writeFileSync(path.join(__dirname, '..', 'shots', 'motions.js.txt'), lines.join('\n') + '\n');
console.log(`生成 ${lines.length} 行 → shots/motions.js.txt`);
const slots = {};
for (const [, file, key] of MAP) { const s = META[key][0]; slots[s] = (slots[s] || 0) + 1; }
console.log('槽位统计：', JSON.stringify(slots));
