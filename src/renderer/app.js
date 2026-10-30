import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import { makeRig, groundClip, soleHeight } from './ground.js';
import { cutClip, MOTION_WINDOWS } from './motion-cut.js';
import { processMotionClip, crossFadeMotionAction } from './motion-quality.mjs';
import { createBodyAvoidance } from './body-avoidance.mjs';
import { createPCMPlayer } from './pcm-player.mjs';
import { createBubbleController } from './bubble-ui.mjs';
import { characterText } from './character-name.mjs';

/* ═══════════ 常量 ═══════════ */
/* 形象列表由主进程扫 assets/models/*.vrm 得到（丢个文件进来就能换角色），
 * 这里只留一份兜底，主进程没给的时候至少还能显示官方样例。 */
let AVATAR_LIST = [];
let AVATARS = {};
let hiddenAvatarMeshes = [];
const FALLBACK_AVATARS = [
  { key: 'AvatarSample_D.vrm', file: 'AvatarSample_D.vrm', label: 'D' },
  { key: 'AvatarSample_E.vrm', file: 'AvatarSample_E.vrm', label: 'E' },
  { key: 'AvatarSample_F.vrm', file: 'AvatarSample_F.vrm', label: 'F' },
  { key: 'AvatarSample_G.vrm', file: 'AvatarSample_G.vrm', label: 'G' },
];
function setAvatarList(list) {
  AVATAR_LIST = (Array.isArray(list) && list.length ? list : FALLBACK_AVATARS);
  AVATARS = {};
  for (const a of AVATAR_LIST) AVATARS[a.key] = a;
}
/* ═══════════ 动作库 · 92 条 ═══════════
 * 文件名即 key，规则是「槽位_变体」（全小写下划线）。
 * 中文名 / 怎么用 / 原素材出处都记在主进程 config.js 的 MOTIONS 里，启动时随 pet:init 送过来。
 * 素材：VRoid Project Motion Pack（pixiv Inc.）、VRM Viewer、desktop-homunculus(Apache-2.0)、
 *   Reika 待机集、Cipher Stage、MayaVE、ai-tuber、chatter-agent、mocopi 样例、desktop-waifu。
 *
 * ── 槽位制：模型只给类名，代码在类里随机挑 ──
 * 92 个动作名全塞进提示词是一堵墙，而且模型只会挑它听熟的那三四个，剩下的轮不上。
 * 所以提示词里只有十几个槽位名（cheer / think / shy …），模型输出 <m>cheer</m>，
 * pickSlotKey() 再从 cheer 这一槽的 9 条里随机挑一条，并避开上一次挑中的 ——
 * 主人连着夸她两次，两次的动作不一样，这才像活的。
 *
 * 超过 6.5 秒的一次性动作在 motion-cut.js 里切了段（窗口由能量曲线自动算出）。 */
const MOTION_FILES = [
  // idle
  'idle_look', 'idle_breath', 'idle_stand', 'idle_stand2', 'idle_lalala', 'idle_shift',
  'idle_pose', 'idle_loop', 'idle_walk_mocopi',

  // work
  'work_maid', 'work_sit',

  // greet
  'greet_yeah', 'greet_wave', 'greet_turn', 'greet_hand',

  // bye
  'bye_goodbye', 'bye_wave', 'bye_wave_maya',

  // cheer
  'cheer_clap_vr', 'cheer_jump_vr', 'cheer_hop', 'cheer_yay', 'cheer_clap_cipher',
  'cheer_clap_maya', 'cheer_arms', 'cheer_cross', 'cheer_joy',

  // praise
  'praise_shoot', 'praise_snap', 'praise_thumb',

  // sign
  'sign_peace',

  // dance
  'dance_excited', 'dance_excited_maya', 'dance_macarena',

  // tease
  'tease_cat', 'tease_scare', 'tease_zombie', 'tease_headbutt', 'tease_catwalk', 'tease_punch',
  'tease_stand', 'tease_peek',

  // refuse
  'refuse_head', 'refuse_reject', 'refuse_shrug', 'refuse_waving', 'refuse_fear', 'refuse_no',
  'refuse_startle',

  // angry
  'angry_pout', 'angry_tsundere', 'angry_hip', 'angry_arms', 'angry_stomp',

  // shy
  'shy_face', 'shy_cute', 'shy_bashful', 'shy_sway',

  // think
  'think_lady', 'think_idea', 'think_cute', 'think_ultra', 'think_dw',

  // sorry
  'sorry_sad', 'sorry_grab', 'sorry_cry', 'sorry_sigh', 'sorry_droop',

  // tired
  'tired_stretch_vr', 'tired_sleep', 'tired_reach', 'tired_sitnap', 'tired_nod', 'tired_yawn',
  'tired_armstretch',

  // thanks
  'thanks_bow_reika', 'thanks_cipher', 'thanks_maya',

  // surprise
  'surprise_scratch', 'surprise_vr', 'surprise_cipher',

  // pose
  'pose_model', 'pose_show', 'pose_spin',

  // motion
  'motion_cute', 'motion_spinjump', 'motion_walk', 'motion_run', 'motion_situp2',
  'motion_situp', 'motion_spin',

  // talk
  'talk_talk',
];

/* 待机。idle 槽里挑一条循环站姿；主人在干活时换成 work 槽的安静站姿。 */
const IDLE = 'idle_loop';
/* 第二待机：主人在干活时用的待命站姿。手交叠在身前，几乎不动 ——
 * 「她在旁边陪着，但不打扰」。会张望的那种待机留给主人闲着的时候。 */
const IDLE_QUIET = 'work_maid';
/* 空闲时允许轮换的循环待机（都是原地站姿，不会走开）。 */
const IDLE_POOL = ['idle_loop', 'idle_breath', 'idle_stand', 'idle_stand2', 'idle_shift', 'idle_pose', 'idle_lalala'];
/* 空闲自娱自乐抽的槽位：以安静的为主，穿插一点俏皮。
 * 不抽 pose / motion / dance 那种大动作 —— 无缘无故转圈显得神经。 */
const AMBIENT_SLOTS = ['idle', 'idle', 'idle', 'tired', 'tease', 'praise', 'sign', 'shy', 'think', 'cheer'];
const FADE = 0.26;
let expressiveUntil = 0;
let viewportManaged = false;
let stageViewport = { width: innerWidth, height: innerHeight, offsetY: 0 };
const motionCore = globalThis.BunnyMotion;

/* 动作表（中文名 / 槽位 / 什么场合用）由主进程在 pet:init 时一起送过来 ——
 * 唯一的真相源是 src/main/config.js 的 MOTIONS，渲染层不另存一份。
 * 槽位随机（pickSlotKey）和动作列表窗口都读它。 */
let MOTIONS = [];
let MOTION_GROUPS = [];

/* ═══════════ 状态 ═══════════ */
let cfg = null;
let vrm = null;
let mixer = null;
let bodyAvoidance = null;
let currentAction = null;
const motionActions = new Set();
let currentMotion = null;
let avatarKey = '';
const rawAnims = new Map();
const clips = new Map();
let loading = false;

let emoTimer = 0;
let blinkTimer = 2.2;
let talkLevel = 0;
let phase = 'idle';          // idle | work | done
let lastDonePoseAt = -1e9;
/* 主人上一次跟我说话是什么时候。用来判"他离开很久又回来了" —— 那时候该起身迎接，
 * 而不是继续站在原地当什么也没发生。 */
let lastMasterAt = performance.now();
let speakingNow = false;
let thinkingNow = false;   // 主人说完 → 她正在想：这段时间不能一动不动
let recording = false;

/* ═══════════ three 基础 ═══════════ */
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setSize(innerWidth, innerHeight);
stage.appendChild(renderer.domElement);

// MSAA already smooths geometry edges. Hair cutouts also need alpha coverage;
// this reuses those samples without an extra render pass or higher resolution.
function softenCutoutEdges(root) {
  const gl = renderer.getContext(), samples = gl.getParameter(gl.SAMPLES);
  if (!samples) return;
  const changed = new Set();
  root.traverse(o => {
    if (!o.isMesh) return;
    for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
      if (material && material.alphaTest > 0 && !material.transparent && !changed.has(material)) {
        material.alphaToCoverage = true; material.needsUpdate = true; changed.add(material);
      }
    }
  });
  pet.log(`[render] MSAA ${samples}x · AlphaToCoverage ${changed.size} 个裁剪材质 · DPR ${renderer.getPixelRatio()}`);
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.05, 60);
camera.position.set(0, 1.2, 3);

const ambient = new THREE.AmbientLight(0xffffff, 1.9);
scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xfff6ec, 2.1);
keyLight.position.set(1.1, 2.6, 2.2);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xbcc8ff, 1.15);
rimLight.position.set(-1.6, 1.7, -1.6);
scene.add(rimLight);
const fillLight = new THREE.DirectionalLight(0xffffff, .5);
fillLight.position.set(0, .6, 3);
scene.add(fillLight);

/* 每只角色的灯光系数。官方样例里有几只贴图本身就很亮（白裙 + 金发），
 * 统一的光打上去整片发白，裙子褶皱全糊掉 —— 载入时按角色压一档。
 * 基准值写在这里，只乘不改，换回来时不会有累积误差。 */
const LIGHT_BASE = { ambient: 1.9, key: 2.1, rim: 1.15, fill: .5 };
function applyAvatarLight(scale = 1) {
  const s = Math.max(0.4, Math.min(1.2, Number(scale) || 1));
  ambient.intensity = LIGHT_BASE.ambient * s;
  keyLight.intensity = LIGHT_BASE.key * s;
  rimLight.intensity = LIGHT_BASE.rim * s;
  fillLight.intensity = LIGHT_BASE.fill * s;
}

const clock = new THREE.Clock();

const vrmLoader = new GLTFLoader();
vrmLoader.register((p) => new VRMLoaderPlugin(p));
const animLoader = new GLTFLoader();
animLoader.register((p) => new VRMAnimationLoaderPlugin(p));

const lookTarget = new THREE.Object3D();
scene.add(lookTarget);
const pointer = new THREE.Vector2(0, 0);
const pointerSmooth = new THREE.Vector2(0, 0);

/* ═══════════ 相机取景 ═══════════ */
let fitInfo = { dist: 3, centerY: 1, visibleH: 2, modelH: 1.5 };

/* 角色取景：100% 半身 / 100% 全身 / 150% 放大；半身内部值沿用 0.5。
 * 超过 100% 时窗口会跟着撑大（她真的变大，而不是被窗口裁掉），
 * 所以取景比例只有「小于 100%」时才需要压 —— 放大交给窗口。 */
let viewScale = 0.5;

/* 侧面板占掉右侧多少像素时，角色要往左让位。
 * 让位不是把相机歪过去（会有透视畸变），而是直接把角色挪到剩余区域的中间 ——
 * 面板一关，她又自己滑回正中。影子跟着一起走，否则会看见"影子留在原地"。 */
let sideInsetNow = 0;
let modelX = 0;
let lastGxPx = 1e9;
const groundEl = document.getElementById('ground');

/* 设置和动作列表都搬去自己的窗口了（见 panel.html），所以这里常年为 0：
 * 她不用再为了给面板腾地方而挪位置，永远站在画面正中。影子也就不用跟着跑。 */
function panelInsetPx() {
  return 0;
}

/* ── 三种尺寸各是一套「取景」，不是同一个缩放系数 ──
 *   半身 ：内部值 0.5。窗口一点不变，等于把镜头推近：只取头顶到胯，
 *          头压在画面上部的主视觉区，下面留够气泡的位置。
 *          桌面角落里的小尺寸要的是「一张脸」，不是「一个小人」。
 *   100% ：全身。脚落在窗口最下方 2%，头顶上方留出气泡位（原来的构图）。
 *   150% ：全身不变形，窗口按 1.5 倍撑开 —— 她真的变大了，而不是被窗口裁掉。
 * 宽度也一起算：切到胯的时候胳膊不能出画，所以拿肩宽反算一个最小视野。 */
/* 一个世界单位在屏幕上有多高。不能拿包围盒反推 ——
 * VRM 的包围盒是按 T-pose 的贴图包围算的，比实际站着的样子大一圈，
 * 反推出来的比例偏小，角色让位就会"挪不够"（袖子还压在面板底下）。
 * 直接投影模型竖轴上的一段，量出来的是真实比例。 */
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
function pxPerWorldY() {
  _pa.set(0, 0, 0).project(camera);
  _pb.set(0, 1, 0).project(camera);
  const d = Math.abs(_pb.y - _pa.y) * 0.5 * stageViewport.height;
  return d > 1e-4 ? d : stageViewport.height / Math.max(0.1, fitInfo.visibleH);
}

function fitCamera(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const fovR = (camera.fov * Math.PI) / 180;
  const bust = viewScale <= 0.51;

  let visibleH;
  let aimY;
  if (bust) {
    /* 头顶落在窗口 17% 处：上面正好放得下一颗气泡（约 44px），又不至于把脸推到中间去。
     * 下沿切到身高的 ~60%（腰胯之间）—— 再切少一点就成了"头像"，多一点就露出腿了。 */
    const topGap = 0.17;
    const crop = 0.70;
    visibleH = (crop * size.y) / (1 + topGap);
    const wideNeed = (0.33 * size.y) / camera.aspect;   // 肩 + 自然下垂的手臂
    if (wideNeed > visibleH) visibleH = wideNeed;
    aimY = box.max.y + topGap * visibleH - visibleH / 2;
  } else {
    const fill = 0.80;
    visibleH = size.y / fill;
    aimY = box.max.y + (1 - fill - 0.02) * visibleH - visibleH / 2;
  }

  const previousVisible = visibleH;
  const expansion = Math.max(1, stageViewport.height / (620 * Math.max(1, viewScale)));
  visibleH *= expansion; aimY += (visibleH - previousVisible) / 2;
  const dist = visibleH / 2 / Math.tan(fovR / 2);
  camera.position.set(0, aimY, dist);
  camera.lookAt(0, aimY, 0);
  camera.aspect = stageViewport.width / stageViewport.height;
  camera.updateProjectionMatrix();
  fitInfo = { dist, centerY: aimY, visibleH, modelH: size.y, bust };
  // 半身的时候脚在画面外，影子留在窗口下沿会像个浮空的黑块 —— 直接收掉
  groundEl.style.opacity = bust ? '0' : '1';
}

function onResize() {
  if (!viewportManaged) stageViewport = { width: innerWidth, height: innerHeight, offsetY: 0 };
  const w = stageViewport.width, h = stageViewport.height;
  const old = renderer.getSize(new THREE.Vector2());
  if (old.x !== w || old.y !== h) {
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    if (vrm) fitCamera(vrm.scene);
  }
  Object.assign(renderer.domElement.style, { position: 'absolute', top: stageViewport.offsetY + 'px', width: w + 'px', height: h + 'px' });
}
addEventListener('resize', onResize);

/* ═══════════ 动作 ═══════════ */
function rebuildClips() {
  clips.clear();
  for (const [id, anim] of rawAnims) {
    try {
      let clip = createVRMAnimationClip(anim, vrm);
      const w = MOTION_WINDOWS[id];
      if (w) clip = cutClip(clip, w[0], w[1]);
      clips.set(id, clip);
    } catch (e) {
      console.warn('retarget 失败', id, e);
    }
  }
  groundAllClips();
  let repaired = 0;
  for (const [key, clip] of clips) {
    const result = processMotionClip(clip, { loop: MOTIONS.some(m => m.key === key && m.loop) });
    repaired += result.isolatedSpikesRepaired + result.loopSeamsSmoothed + result.quaternionSignFlips;
  }
  pet.log(`[motion] ${clips.size} 条动作已检查，处理 ${repaired} 处轨道问题`);
}

function groundAllClips() {
  if (!vrm || clips.size === 0) return;
  let rig = null;
  try { rig = makeRig(vrm); } catch (e) { console.warn('建替身骨架失败', e); }
  if (!rig) return;

  // 地面基准：以站立待机为准；没有待机动作就取所有动作的中位数
  const soles = new Map();
  for (const [id, clip] of clips) {
    try {
      const h = soleHeight(clip, rig);
      if (h != null) soles.set(id, h);
    } catch (e) { console.warn('量落脚高度失败', id, e); }
  }
  let ref = soles.has(IDLE) ? soles.get(IDLE) : null;
  if (ref == null) {
    const all = [...soles.values()].sort((p, q) => p - q);
    if (all.length) ref = all[Math.floor(all.length / 2)];
  }

  const lines = [];
  for (const [id, clip] of clips) {
    try {
      const r = groundClip(clip, rig, ref);
      lines.push(`${id} 竖直${(r.yShift * 100).toFixed(1)}cm 落脚${r.ik ? r.ik.contacts : 0}段`);
    } catch (e) { console.warn('地面锚定失败', id, e); }
  }
  console.log('[ground]', lines.join(' | '));
  pet.log('ground ' + lines.join(' | '));
}

function playMotion(key, { loop = false, fade = FADE, requestId, reason = 'idle' } = {}) {
  const requestedKey = key;
  const report = ok => pet.motionStarted?.({ key: ok ? key : requestedKey, avatar: avatarKey, requestId, reason, ok });
  if (loading && requestId) { report(false); return; }
  if (!key || !motionEnabled(key) || !clips.has(key)) { key = randomIdle(); loop = true; }
  const clip = clips.get(key);
  if (!clip || !mixer) { report(false); return; }
  if (requestId && key !== requestedKey) { report(false); return; }
  const next = mixer.clipAction(clip);
  if (requestId) expressiveUntil = performance.now() + Math.max(1200, Math.min(12000, clip.duration * 1000));
  next.enabled = true;
  next.setEffectiveTimeScale(1);
  next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
  next.clampWhenFinished = !loop;

  if (next === currentAction) {
    if (!loop) next.reset().play();
    currentMotion = key;
    paintMotionActive(); report(true);
    return;
  }
  if (currentAction) {
    crossFadeMotionAction(next, currentAction, Math.max(0.25, fade), motionActions);
  } else {
    next.setEffectiveWeight(1); next.reset().play();
  }
  motionActions.add(next);
  currentAction = next;
  currentMotion = key;
  paintMotionActive(); report(true);
}

/* ═══════════ 槽位 → 具体动作 ═══════════
 * 模型给的是槽位名（cheer / think / shy …），这里在同一槽里随机挑一条。
 * 两个讲究：
 *   1. 避开这一槽上一次挑中的那条 —— 连着夸她两次，不能两次都是同一个鼓掌；
 *   2. 只挑真正载入成功的（clips.has），某条 .vrma 坏了也不至于演空。
 * 传进来的若已经是具体动作 key（含下划线），直接照播。 */
function motionEnabled(key) { return MOTIONS.some(m => m.key === key && m.enabled !== false) && !(cfg?.motions?.disabled || []).includes(key); }
function randomIdle() {
  return motionCore?.choose(MOTIONS.filter(m => (m.idle ?? (m.slot === 'idle')) && motionEnabled(m.key) && clips.has(m.key)))?.key || null;
}
function pickSlotKey(slot) {
  const pool = MOTIONS.filter(m => m.slot === slot && motionEnabled(m.key) && clips.has(m.key));
  return motionCore?.choose(pool)?.key || randomIdle();
}
/** 槽位名或具体 key 都吃：有 key 就播 key，否则当槽位随机。 */
function resolveMotion(name) {
  if (!name) return randomIdle();
  if (clips.has(name)) return motionEnabled(name) ? name : randomIdle();
  return pickSlotKey(name);
}
function playSlot(slot, fade = 0.22) {
  const k = resolveMotion(slot);
  if (!k) return null;
  playOneShot(k, fade);
  return k;
}

function playOneShot(key, fade = 0.2, metadata = {}) {
  playMotion(key, { loop: !!MOTIONS.find(m => m.key === key)?.loop, fade, ...metadata });
}

const AWAY_MS = 30 * 60e3;
/** 主人开口了。隔了半小时以上再开口 → 起身迎接（greet 槽里那几条的共性是「从蹲姿站起来」）。 */
function noteMaster() {
  const now = performance.now();
  const away = now - lastMasterAt;
  lastMasterAt = now;
  if (away > AWAY_MS && !speakingNow && !thinkingNow) playSlot('greet', 0.5);
}

/* 待机有两种：
 *   闲着 → idle_loop，会张望、会小动作；
 *   主人在干活 → idle-maid，手交叠站着，几乎不动（「在，但不打扰你」）。
 * 只用一条待机的话，两种场景要共用一张脸，怎么都不对。 */
let idleKey = IDLE;
function currentIdle() {
  const item = MOTIONS.find(m => m.key === idleKey);
  return item && (item.idle ?? (item.slot === 'idle')) && item.weight !== 0 && clips.has(idleKey) && motionEnabled(idleKey) ? idleKey : randomIdle();
}
function toIdle(fade = 0.32) {
  playMotion(currentIdle(), { loop: true, fade });
}
/** 换一种站姿。idle 槽有 9 条循环站姿，一直用同一条，看着像贴图不动。
 * 主人在干活时不换 —— 那时她该是待命站姿，不是在那儿换重心玩。 */
function rotateIdle() {
  if (phase === 'work') return;
  const next = randomIdle();
  if (!next || next === idleKey) return;
  idleKey = next;
  toIdle(0.7);
  pet.log(`[idle] 换站姿 ${idleKey}`);
}

/* ═══════════ 表情 / 口型 ═══════════ */
function setExpr(name, v) {
  const em = vrm && vrm.expressionManager;
  if (!em) return;
  try { em.setValue(name, v); } catch {}
}
const EMO_LIST = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];
function clearEmo(except) {
  for (const n of EMO_LIST) if (n !== except) setExpr(n, 0);
}
function emoActive() {
  return emoTimer > 0;
}

function applyEmo(name, weight = 1, holdMs = 2600) {
  if (!vrm || !vrm.expressionManager) return;
  const has = vrm.expressionManager.expressions?.some((e) => e.expressionName === name);
  if (!has) return;
  clearEmo(name);
  setExpr(name, weight);
  emoTimer = holdMs / 1000;
}

/* ═══════════ 音频（嘴型） ═══════════ */
let audioCtx = null;
let analyser = null;
let analyserData = null;
let currentSource = null;
let pcmPlayer = null;
let audioRevision = 0;
let activeAudioId = null;

function ensureAudio() {
  if (audioCtx) return audioCtx;
  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.55;
  analyser.connect(audioCtx.destination);
  analyserData = new Uint8Array(analyser.fftSize);
  pcmPlayer = createPCMPlayer({ context: audioCtx, destination: analyser,
    onStart: () => { markReplyStarted(); pet.audioStarted(); },
    onDone: id => { talkLevel = 0; pet.audioDone(true, id); },
    onUnderrun: () => pet.log('[tts] 流式播放缓冲不足'),
  });
  return audioCtx;
}

async function playWav(u8, id) {
  stopAudio(true);
  activeAudioId = id;
  const revision = audioRevision;
  const ctx = ensureAudio();
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { if (revision === audioRevision) pet.audioDone(false, id); return; } }
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  let buf;
  try {
    buf = await ctx.decodeAudioData(ab);
  } catch (e) {
    if (revision !== audioRevision) return;
    console.warn('decode 失败', e);
    pet.audioDone(false, id);
    return;
  }
  if (revision !== audioRevision) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(analyser);
  src.onended = () => {
    if (currentSource === src) {
      currentSource = null;
      talkLevel = 0;
      pet.audioDone(true, id);
    }
  };
  currentSource = src;
  src.start();
  markReplyStarted(); pet.audioStarted();
}

function stopAudio(keepQuiet) {
  audioRevision++;
  pcmPlayer?.stop();
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch {}
    currentSource = null;
  }
  talkLevel = 0;
  if (!keepQuiet) pet.audioDone(false, activeAudioId);
}

function playPCM(event) {
  if (event.start) {
    stopAudio(true);
    activeAudioId = event.id;
    const ctx = ensureAudio();
    if (ctx.state === 'suspended') ctx.resume().catch(() => { pcmPlayer.stop(event.id); pet.audioDone(false, event.id); });
    pcmPlayer.begin(event.id);
  }
  if (event.stop) pcmPlayer?.stop(event.id);
  if (event.pcm) pcmPlayer?.push(event.id, event.pcm);
  if (event.end) pcmPlayer?.end(event.id);
}

function markReplyStarted() {
  if (shownHeard && shownState !== 'skip') { shownState = 'reply'; paintEar(); }
}

/* ═══════════ 加载 ═══════════ */
function loadMotions() {
  // 以主进程送来的表为准（那张表带中文名和槽位）；还没拿到就退回本地常量
  const keys = MOTIONS.length ? MOTIONS.map((m) => m.key) : MOTION_FILES;
  return Promise.all(keys.map((k) => new Promise((res) => {
    if (rawAnims.has(k)) { res(); return; }
    animLoader.load(MOTIONS.find(m => m.key === k)?.url || `./assets/motions/${k}.vrma`, (g) => {
      const a = g.userData.vrmAnimations && g.userData.vrmAnimations[0];
      if (a && MOTIONS.some(m => m.key === k)) rawAnims.set(k, a);
      res();
    }, undefined, () => res());
  })));
}

let queuedAvatar = null;
function nextAvatar() {
  const next = queuedAvatar; queuedAvatar = null;
  if (next && next !== avatarKey) queueMicrotask(() => void switchAvatar(next, { persist: false }));
}
function loadAvatar(key) {
  if (loading) return Promise.resolve(false);
  loading = true;
  avatarKey = key;
  const info = AVATARS[key] || AVATAR_LIST[0];
  setLoading(true, `正在努力加载 ${info.label || '角色'}…`);

  return new Promise((resolve) => vrmLoader.load(info.url || `./assets/models/${info.file}`, (gltf) => {
    if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); mixer = null; }
    currentAction = null;
    if (vrm) {
      scene.remove(vrm.scene);
      vrm.scene.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of ms) {
            for (const k of ['map', 'normalMap', 'emissiveMap']) m?.[k]?.dispose?.();
            m?.dispose?.();
          }
        }
      });
    }
    vrm = gltf.userData.vrm;
    if (!vrm) { loading = false; setLoading(false); resolve(false); nextAvatar(); return; }
    // This particular experimental character has a wider torso than the
    // source motions. Other built-in and personal avatars remain untouched.
    bodyAvoidance = vrm.meta?.name === 'Bunny Face Hybrid' ? createBodyAvoidance(vrm) : null;
    softenCutoutEdges(vrm.scene);
    hiddenAvatarMeshes = [];
    vrm.scene.traverse(object => {
      const source = gltf.parser.associations.get(object);
      const name = gltf.parser.json.meshes?.[source?.meshes]?.name;
      if (name && info.hiddenMeshes?.includes(name)) { object.visible = false; hiddenAvatarMeshes.push(name); }
    });
    if (vrm.meta?.metaVersion === '0') vrm.scene.rotation.y = Math.PI;
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    if (vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = true;
    if (vrm.lookAt) vrm.lookAt.target = lookTarget;
    // 手动挂 LookAt 代理：createVRMAnimationClip 找不到它会自己补一个并刷警告
    if (vrm.lookAt) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }
    // 有的角色天生太亮，压一档光（系数在 avatars.js，跟形象一起配）
    applyAvatarLight(info.light || 1);
    scene.add(vrm.scene);

    fitCamera(vrm.scene);

    motionActions.clear();
    mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.addEventListener('finished', event => {
      if (event.action !== currentAction) return;
      expressiveUntil = 0; toIdle(0.35);
      paintMotionActive();
    });

    rebuildClips();
    toIdle(0.001);
    loading = false;
    pet.bodyReady?.({ avatar: key, expressions: Object.keys(vrm?.expressionManager?.expressionMap || {}) });
    pet.motionStarted?.({ key: currentMotion, avatar: key, reason: 'idle', ok: true });
    const ld = document.getElementById('hint');
    if (ld) ld.classList.add('hidden');
    setLoading(false);
    resolve(true);
    nextAvatar();
  }, undefined, (e) => {
    console.error('模型加载失败', e);
    loading = false;
    setLoading(false);
    resolve(false);
    nextAvatar();
  }));
}

function avatarPreviewPNG() {
  if (!vrm || loading) return null;
  const width = 320, height = 512, target = new THREE.WebGLRenderTarget(width, height);
  const box = new THREE.Box3().setFromObject(vrm.scene), center = box.getCenter(new THREE.Vector3());
  const modelHeight = Math.max(0.1, box.max.y - box.min.y), previewCamera = camera.clone();
  previewCamera.aspect = width / height;
  previewCamera.position.set(center.x, center.y, center.z + modelHeight / (2 * Math.tan(previewCamera.fov * Math.PI / 360)) * 1.15);
  previewCamera.lookAt(center); previewCamera.updateProjectionMatrix();
  const previous = renderer.getRenderTarget(), pixels = new Uint8Array(width * height * 4);
  try { renderer.setRenderTarget(target); renderer.render(scene, previewCamera); renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels); }
  finally { renderer.setRenderTarget(previous); target.dispose(); }
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d'), image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4);
  context.putImageData(image, 0, 0); return canvas.toDataURL('image/png');
}

/* 换角色要 2~4 秒。这段时间绝不能让画面空掉一半 ——
 * 角色区域给一个转圈 + 一句具体的话，其他 UI 一动不动照常显示。 */
let loadingTimer = null;
function setLoading(on, txt) {
  const el = document.getElementById('loading');
  const t = document.getElementById('loadingTxt');
  if (!el) return;
  if (txt && t) t.textContent = txt;
  el.classList.toggle('hidden', !on);
  if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
  if (on) {
    // 10 秒还没下来：得说实话，别让主人盯着转圈猜
    loadingTimer = setTimeout(() => { if (t) t.textContent = '还在加载，文件有点大…'; }, 10000);
  }
}

/* ═══════════ 命中测试（决定窗口哪块能点） ═══════════ */
const hitBones = ['head', 'neck', 'hips', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftUpperArm', 'rightUpperArm'];
const _v = new THREE.Vector3();
const _headHit = new THREE.Vector3();
function characterRect() {
  if (!vrm || !vrm.humanoid) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
  const include = point => {
    point.project(camera);
    if (!isFinite(point.x) || !isFinite(point.y)) return;
    const x = (point.x * 0.5 + 0.5) * innerWidth;
    const y = (-point.y * 0.5 + 0.5) * stageViewport.height + stageViewport.offsetY;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    n++;
  };
  for (const b of hitBones) {
    const node = vrm.humanoid.getRawBoneNode(b) || vrm.humanoid.getNormalizedBoneNode(b);
    if (!node) continue;
    node.getWorldPosition(_v);
    if (b === 'head') _headHit.copy(_v);
    include(_v);
    if (b === 'head') {
      // The head bone sits near the face center. Include the skull and hair,
      // using the same crown height as bubble placement, at every view scale.
      _v.copy(_headHit); _v.y += fitInfo.modelH * .115; include(_v);
      for (const side of [-1, 1]) {
        _v.copy(_headHit); _v.x += side * fitInfo.modelH * .09; include(_v);
      }
    }
  }
  if (!n) return null;
  const pad = 16;
  return { x0: minX - pad, x1: maxX + pad, y0: minY - pad, y1: maxY + pad };
}

let lastHit = null;
let interactiveState = false;
function updateHit(e) {
  const overUi = !!(e.target && e.target.closest &&
    e.target.closest('#ear, #dock, #bubble, #settings, #motions, #fab, #rec, #activity, button, input, textarea'));
  let inside = dragging || overUi;
  if (!inside) {
    const r = lastHit;
    if (r) inside = e.clientX >= r.x0 && e.clientX <= r.x1 && e.clientY >= r.y0 && e.clientY <= r.y1;
  }
  if (inside !== interactiveState) {
    interactiveState = inside;
    pet.hit(inside);
  }
}

/* ═══════════ 拖拽 ═══════════ */
let dragging = false;
let dragMoved = false;
let downAt = null, dragPoint = null, dragFrame = 0;

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  stage.setPointerCapture(e.pointerId);
  dragging = true;
  dragMoved = false;
  downAt = { x: e.screenX, y: e.screenY };
});
addEventListener('pointermove', (e) => {
  if (dragging) {
    const dx = e.screenX - downAt.x;
    const dy = e.screenY - downAt.y;
    if (!dragMoved && Math.hypot(dx, dy) > 4) {
      dragMoved = true;
      pet.drag({ type: 'start', ...downAt });
      document.body.style.cursor = 'grabbing';
    }
    if (dragMoved) {
      dragPoint = { type: 'move', x: e.screenX, y: e.screenY };
      if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; if (dragPoint) pet.drag(dragPoint); });
    }
  }
  // 眼球跟随
  pointer.x = (e.clientX / stageViewport.width) * 2 - 1;
  pointer.y = -(((e.clientY - stageViewport.offsetY) / stageViewport.height) * 2 - 1);
  updateHit(e);
});
addEventListener('pointerup', (e) => {
  if (dragging) {
    dragging = false;
    if (dragMoved) { pet.drag({ type: 'move', x: e.screenX, y: e.screenY }); pet.drag({ type: 'end' }); }
    else onPetClick(e);
    dragMoved = false;
    document.body.style.cursor = 'default';
    cancelAnimationFrame(dragFrame); dragFrame = 0; dragPoint = null; updateHit(e);
  }
});
addEventListener('pointercancel', () => { dragging = false; dragMoved = false; cancelAnimationFrame(dragFrame); dragFrame = 0; dragPoint = null; pet.drag({ type: 'end' }); document.body.style.cursor = 'default'; });
stage.addEventListener('mouseleave', () => {
  if (dragging) return;
  if (interactiveState) { interactiveState = false; pet.hit(false); }
});

/* ═══════════ 气泡 ═══════════ */
const bubbleController = createBubbleController(document.getElementById('bubble'), document.getElementById('bubbleText'));

function showBubble(text, holdMs) {
  bubbleController.show(text, holdMs);
}

function paintRecallButton(entries) {
  const button = document.getElementById('memoryBasis');
  if (!button) return;
  const count = Array.isArray(entries) ? entries.filter(entry => entry && ['memory', 'summary'].includes(entry.kind) && typeof entry.content === 'string').length : 0;
  button.hidden = count === 0;
  button.textContent = count ? `记忆依据 · ${count}` : '记忆依据';
}

function clearWebSources() {
  const container = document.getElementById('webSources');
  const links = document.getElementById('webSourceLinks');
  if (!container || !links) return;
  links.replaceChildren();
  container.classList.add('hidden');
  document.getElementById('bubble')?.classList.remove('has-web-sources');
}

function paintWebSources(event) {
  clearWebSources();
  if (event?.used !== true || !Array.isArray(event.sources)) return;
  const container = document.getElementById('webSources');
  const links = document.getElementById('webSourceLinks');
  const bubble = document.getElementById('bubble');
  if (!container || !links || !bubble) return;
  const seen = new Set();
  const sources = [];
  for (const source of event.sources) {
    if (!source || typeof source.title !== 'string' || typeof source.url !== 'string' || source.url.length > 2048) continue;
    let parsed;
    try { parsed = new URL(source.url); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || seen.has(parsed.href)) continue;
    const title = source.title.trim().slice(0, 120);
    if (!title) continue;
    seen.add(parsed.href);
    sources.push({ title, url: parsed.href });
    if (sources.length === 3) break;
  }
  if (!sources.length) return;
  for (const source of sources) {
    const button = document.createElement('button');
    button.className = 'web-source-link';
    button.type = 'button';
    button.textContent = source.title;
    button.title = source.title;
    button.setAttribute('aria-label', `打开参考来源：${source.title}`);
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (typeof pet.openWebSource !== 'function') return;
      try { Promise.resolve(pet.openWebSource(source.url)).catch(() => {}); } catch {}
    });
    links.append(button);
  }
  container.classList.remove('hidden');
  bubble.classList.add('has-web-sources');
}

function hideBubble() {
  bubbleController.hide();
}
document.getElementById('memoryBasis')?.addEventListener('click', () => pet.open('memory'));

/* ═══════════ 交互区 ═══════════ */
const dock = document.getElementById('dock');
const input = document.getElementById('input');
input.addEventListener('input', () => pet.composing?.(!!input.value.trim()));
input.addEventListener('blur', () => pet.composing?.(false));
const hint = document.getElementById('hint');
const fab = document.getElementById('fab');
const recEl = document.getElementById('rec');
const activity = document.getElementById('activity');

/* 脚下那条（同时是"耳朵"的开关和"我说了什么"的显示器）：
 *   .off     耳朵关着 —— 灰，什么都不动
 *   .on      在听 —— 绿灯常亮（不做呼吸动画），电平条跟真实音量
 *   .loud    声音够大 —— 条子转暖色，主人一眼看出它听见了
 *   .expand  刚听到话 —— 撑满整窗宽，长了就横向滚动，不省略
 * 一个元素承担全部状态，所以"在听"永远不会跟输入框打架。 */
let dockMode = 'mini';        // mini | open
let listening = false;        // 耳朵开着（常驻聆听）
let shownHeard = '';          // 「你说 · …」
let shownState = '';          // pending | ready | reply | done | skip
let liveText = '';            // 正说到一半的字（实时字幕）
let aecOn = false;            // 系统回声消除可用 → 她说话时也能听
let pendingHeard = '';        // 刚听到、还没被主人用过的一句 —— 留着填进输入框
let pendingAt = 0;
let heardTimer = null;

function asrHealthy() {
  const micOk = asrStat.mic === true || asrStat.micSystem === 'granted';
  return asrStat.speech === 3 && micOk && asrStat.captureReady !== false;
}

function earLabel() {
  if (asrStat.note === 'locked') return '锁屏中 · 监听暂停';
  if (asrStat.note === 'memory-locked') return '记忆待解锁';
  if (listening && asrStat.captureReady === false) return asrStat.note === 'installing' ? '准备语音资源…' : asrStat.note === 'starting' ? '正在连接麦克风…' : '正在重连麦克风…';
  if (liveText) return liveText;
  if (shownHeard) {
    const status = { pending: '正在回应', ready: '正在准备声音', reply: '正在说话', skip: '略过' }[shownState];
    return `你说 · ${shownHeard}${status ? ' · ' + status : ''}`;
  }
  return listening ? '在听' : '耳朵关着';
}

/* 文字超出可用宽度时横向滚动（而不是打省略号）。
 * 主人想看到的是"我整句话被听清了吗"，截断等于没回答这个问题。 */
let marqueeTimer = null;
let earShown = null;
function startMarquee() {
  const t = document.getElementById('earTxt');
  if (!t) return;
  for (const a of t.getAnimations()) a.cancel();
  t.style.transform = '';
  const win = t.parentElement;
  const over = t.scrollWidth - (win ? win.clientWidth : 0);
  if (over <= 2) return;
  const dist = over + 16;
  const dur = Math.max(2800, Math.round(dist * 26));
  t.animate([
    { transform: 'translateX(0)', offset: 0 },
    { transform: 'translateX(0)', offset: .14 },
    { transform: `translateX(${-dist}px)`, offset: .9 },
    { transform: `translateX(${-dist}px)`, offset: 1 },
  ], { duration: dur, iterations: Infinity, easing: 'linear' });
}

function paintEar() {
  const ear = document.getElementById('ear');
  const t = document.getElementById('earTxt');
  if (!ear) return;
  const warn = listening && !asrHealthy();
  ear.classList.toggle('on', listening && !warn);
  ear.classList.toggle('off', !listening || warn);
  ear.classList.toggle('warn', warn);
  ear.classList.toggle('skip', shownState === 'skip');
  ear.classList.toggle('expand', !!(shownHeard || liveText));
  const toggle = document.getElementById('listenToggle');
  if (toggle) {
    toggle.title = listening ? '关闭实时监听' : '开启实时监听';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', String(listening));
  }

  const txt = earLabel();
  if (txt !== earShown) {
    earShown = txt;
    if (t) t.textContent = txt;
    // 只有换了字才重新量一次：撑宽是 260ms 的过渡，等它撑开再量，
    // 否则量到的是旧宽度，长句子会被判成"没超出"而不滚。
    if (marqueeTimer) clearTimeout(marqueeTimer);
    marqueeTimer = setTimeout(startMarquee, 340);
  }
}

/** 实时字幕：主人还在说，字先滚出来 —— 让他确信自己被听见了 */
function paintLive(text) {
  liveText = String(text || '').slice(0, 120);
  if (liveText) {
    clearTimeout(heardTimer);
    shownHeard = ''; shownState = '';
  }
  paintEar();
}

function openDock() {
  hideBubble();
  dockMode = 'open';
  dock.classList.remove('hidden');
  hint.classList.add('hidden');
  // 刚才听到、还没发出去的话带进输入框，主人可以改一改再发
  if (pendingHeard && Date.now() - pendingAt < 45000 && !input.value.trim()) {
    input.value = pendingHeard;
    pendingHeard = '';
  }
  setTimeout(() => input.focus({ preventScroll: true }), 60);
}

function closeDock() {
  pet.composing?.(false);
  if (document.activeElement === input) input.blur();
  dockMode = 'mini';
  dock.classList.add('hidden');
}

/* ═══════════ 摸她：点不同部位有不同反应 ═══════════
 * 点脑袋 → 多半摇头拒绝（"别闹"）；点上身 → 害羞；点下身 → 不高兴。
 * 每处都留了三条别的出路，概率错开 —— 同一个动作连点三次就穿帮了，
 * 那不是活物，是个按钮。
 *
 * 分区用骨头投影出来的横向分界线（脖子 / 胯），不猜模型比例：
 * 换任何一个 VRM 都照样分得对。 */
function bodyRegionAt(x, y) {
  if (!vrm || !vrm.humanoid) return null;
  const yOf = (bone) => {
    const n = vrm.humanoid.getRawBoneNode(bone) || vrm.humanoid.getNormalizedBoneNode(bone);
    if (!n) return null;
    n.getWorldPosition(_v);
    _v.project(camera);
    if (!isFinite(_v.y)) return null;
    return (-_v.y * 0.5 + 0.5) * stageViewport.height + stageViewport.offsetY;
  };
  const head = yOf('head');
  const hips = yOf('hips');
  if (head === null || hips === null) return null;
  const neck = yOf('neck');
  const neckY = neck !== null ? neck : (head + hips) / 2;
  if (y < neckY) return 'head';
  if (y < hips) return 'upper';
  return 'lower';
}

function onPetClick(e) {
  hideBubble();
  const r = lastHit;
  const onBody = !!(r && e && vrm &&
    e.clientX >= r.x0 && e.clientX <= r.x1 && e.clientY >= r.y0 && e.clientY <= r.y1);
  if (onBody) {
    if (performance.now() - lastInterruptedAt < 900 || thinkingNow) return;
    const region = bodyRegionAt(e.clientX, e.clientY) || 'upper';
    const motions = MOTIONS.filter(m => motionEnabled(m.key) && clips.has(m.key)).map(m => m.key);
    pet.interact({ region, motions }).catch(() => {});
    ambientTimer = 26;
    return;
  }
  if (dockMode === 'open') closeDock();
  else openDock();
}

async function sendText() {
  const v = input.value.trim();
  if (!v) return;
  clearWebSources();
  noteMaster();
  input.value = ''; pet.composing?.(false);
  pendingHeard = '';
  shownHeard = '';
  paintEar();
  showBubble(v, 3200);
  const result = await pet.say(v);
  if (result && !result.ok) { if (!input.value) input.value = v; showBubble(result.error || '这句话没有发送成功。'); }
}

document.getElementById('sendBtn').addEventListener('click', sendText);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendText(); }
  if (e.key === 'Escape') closeDock();
});

/* 点击角色也能立即打断，不必等待语音识别。 */
const stageEl = document.getElementById('stage');
let lastInterruptedAt = -Infinity;
stageEl.addEventListener('pointerdown', () => {
  if (!speakingNow && !thinkingNow) return;
  lastInterruptedAt = performance.now();
  pet.stopSpeak();
  stopAudio(true);
  speakingNow = false;
  thinkingNow = false;
  toIdle(0.26);
}, { passive: true });

/* 脚下那一条：单击 = 展开/收起输入框；长按 = 开关耳朵 */
const earBar = document.getElementById('ear');
let earHoldTimer = null;
let earLongFired = false;
const listenToggle = document.getElementById('listenToggle');
listenToggle.addEventListener('pointerdown', e => { e.stopPropagation(); clearTimeout(earHoldTimer); });
listenToggle.addEventListener('click', e => { e.stopPropagation(); clearTimeout(earHoldTimer); pet.listen('toggle'); });
earBar.addEventListener('pointerdown', () => {
  earLongFired = false;
  clearTimeout(earHoldTimer);
  earHoldTimer = setTimeout(() => { earLongFired = true; pet.listen('toggle'); }, 560);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
  earBar.addEventListener(ev, () => clearTimeout(earHoldTimer));
}
earBar.addEventListener('click', () => {
  clearTimeout(earHoldTimer);
  if (earLongFired) { earLongFired = false; return; }
  if (dockMode === 'open') closeDock();
  else openDock();
});

let hintTimer = setTimeout(() => {
  hint.classList.remove('hidden');
  setTimeout(() => hint.classList.add('hidden'), 6000);
}, 1800);

document.getElementById('gearBtn').addEventListener('click', () => openSettings());
document.getElementById('muteBtn').addEventListener('click', async () => {
  const on = !cfg.voice.enabled;
  cfg = await pet.config({ voice: { enabled: on } });
  paintMute();
});
function paintMute() {
  const btn = document.getElementById('muteBtn');
  const wave = document.getElementById('muteWave');
  const cross = document.getElementById('muteCross');
  const on = cfg && cfg.voice.enabled;
  btn.classList.toggle('muted', !on);
  wave.style.display = on ? '' : 'none';
  cross.style.display = on ? 'none' : '';
  btn.title = on ? '关闭语音' : '开启语音';
  btn.setAttribute('aria-label', btn.title);
}

/* ═══════════ 录制 ═══════════ */
function startRecordUI() {
  recording = true;
  recEl.classList.remove('hidden');
  document.getElementById('recText').textContent = '在听…';
  stopAudio();
  hideBubble();
}
function stopRecordUI() {
  recording = false;
  recEl.classList.add('hidden');
  recEl.style.setProperty('--lvl', 0.2);
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDock();
});

/* ═══════════ 常驻聆听 ═══════════ */
function paintListen() {
  paintEar();
}

/** 听到一句话：脚下那条撑开显示「你说 · …」，主人一眼能确认有没有被听清 */
function paintHeard(text, replied) {
  if (!text) return;
  // 完成通知可能属于已被新一句打断的旧请求，不覆盖当前字幕。
  if (replied !== undefined && shownHeard !== String(text).slice(0, 180)) return;
  liveText = '';
  shownHeard = String(text).slice(0, 180);
  shownState = replied === false ? 'skip' : replied === true
    ? (speakingNow ? (shownState === 'reply' ? 'reply' : 'ready') : 'done') : 'pending';
  pendingHeard = shownHeard;      // 留着，主人点开输入框时能填进去改
  pendingAt = Date.now();
  paintEar();
  clearTimeout(heardTimer);
  // 等待模型和合成期间保留字幕，绝不靠固定超时回到「在听」。
  if (['pending', 'ready', 'reply'].includes(shownState)) return;
  clearHeardLater(replied === false ? 2400 : 3200);
}

function clearHeardLater(delay = 3200) {
  clearTimeout(heardTimer);
  heardTimer = setTimeout(() => {
    shownHeard = '';
    shownState = '';
    paintEar();
  }, delay);
}

/* ═══════════ 权限 ═══════════ */
let asrStat = { speech: null, mic: null, note: '' };
const SPEECH_ZH = { 0: '待授权', 1: '被限制', 2: '已拒绝', 3: '已授权' };
const MIC_ZH = { granted: '已授权', denied: '已拒绝', restricted: '被限制', 'not-determined': '待授权', unknown: '未知' };

function paintPerm(st) {
  if (st) asrStat = { ...asrStat, ...st };
  const sEl = document.getElementById('permSpeech');
  const mEl = document.getElementById('permMic');
  const speech = asrStat.speech;
  const micOk = asrStat.mic === true || asrStat.micSystem === 'granted';
  const pending = asrStat.note === 'pending';

  if (sEl) {
    if (speech === 3) { sEl.textContent = '已授权'; sEl.className = 'pill ok'; }
    else if (speech === -1) { sEl.textContent = '不可用'; sEl.className = 'pill bad'; }
    else if (pending || speech === 0) { sEl.textContent = '待授权'; sEl.className = 'pill wait'; }
    else { sEl.textContent = SPEECH_ZH[speech] || '未知'; sEl.className = 'pill bad'; }
  }
  if (mEl) {
    if (micOk) { mEl.textContent = '已授权'; mEl.className = 'pill ok'; }
    else if (asrStat.micSystem) { mEl.textContent = MIC_ZH[asrStat.micSystem] || asrStat.micSystem; mEl.className = asrStat.micSystem === 'denied' ? 'pill bad' : 'pill wait'; }
    else if (asrStat.mic === false) { mEl.textContent = '未授权'; mEl.className = 'pill bad'; }
    else { mEl.textContent = '—'; mEl.className = 'pill'; }
  }
  const tip = document.getElementById('permTip');
  if (tip) {
    const ok = speech === 3 && micOk;
    if (ok) { tip.textContent = '都通了。按 ⌘⇧Space 或点她脚下那条就开始说话。'; }
    else if (pending) { tip.textContent = '系统弹窗正在等你点「允许」。点完这里会自动变绿。'; }
    else { tip.textContent = '第一次要允许两项：语音识别 + 麦克风。允许后如果还是灰的，把开关关掉再打开一次。'; }
    tip.classList.toggle('hidden', false);
  }
  paintEar();
}

document.getElementById('permCheck')?.addEventListener('click', async () => {
  const tip = document.getElementById('permTip');
  if (tip) { tip.textContent = '正在请求权限…系统弹窗请点允许'; }
  const st = await pet.asrStatus({ request: true });
  paintPerm(st);
});
document.getElementById('permOpenSpeech')?.addEventListener('click', () => pet.openPrivacy('speech'));
document.getElementById('permOpenMic')?.addEventListener('click', () => pet.openPrivacy('mic'));

/* ═══════════ 设置 / 动作列表 ═══════════
 * 这两个都是独立窗口了（见 panel.html / panel.js）。
 * 以前它们塞在角色窗口里：设置表单一铺开就把她的脸挡掉一半，92 条动作列表
 * 更是把画面挤成一条缝。搬出去之后，这里只负责"喊一声把窗口开出来"。 */
function openSettings() { pet.open('settings'); }
function openMotions() { pet.open('motions'); }
/* 动作列表窗口自己管高亮（它有自己的列表），这里只是留个同名的空实现，
 * 免得播放路径上到处判空。 */
function paintMotionActive() { /* 面板已搬到独立窗口 */ }
function closeSettings() { /* 同上：设置不在本窗口里了 */ }

/* 形象切换：点一下立刻换，不用等「保存」；换完顺手写回配置 */
function paintAvatars() {
  const row = document.getElementById('avRow');
  if (!row) return;
  if (row.childElementCount !== AVATAR_LIST.length) {
    row.innerHTML = '';
    for (const info of AVATAR_LIST) {
      const b = document.createElement('button');
      b.dataset.key = info.key;
      b.textContent = info.label || info.key;
      // 中文名是给人看的；tooltip 里留着原来的日文名，想查是哪只官方样例还查得到
      b.title = [info.label, info.title && info.title !== info.label ? `（${info.title}）` : '',
        info.author ? `· ${info.author}` : ''].join(' ').trim();
      b.addEventListener('click', () => switchAvatar(info.key));
      row.appendChild(b);
    }
  }
  for (const b of row.children) b.classList.toggle('on', b.dataset.key === avatarKey);
}

/* 角色大小三档。放大交给主进程撑窗口（以底部中心为锚点），
 * 缩小则窗口一动不动 —— 只是取景推近成半身（见 fitCamera）。 */
function paintScale() {
  const row = document.getElementById('sizeRow');
  if (!row) return;
  for (const b of row.children) {
    b.classList.toggle('on', Math.abs(Number(b.dataset.k) - viewScale) < 0.01);
  }
}

async function setScale(k) {
  viewScale = Number(k) || 1;
  paintScale();
  if (vrm) fitCamera(vrm.scene);
  try { await pet.scale(viewScale); } catch {}
  pet.log(`[scale] ${viewScale}`);
}

document.getElementById('sizeRow')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  setScale(Number(b.dataset.k));
});

async function switchAvatar(k, { persist = true } = {}) {
  if (!AVATARS[k]) return;
  if (persist) void pet.config({ avatar: k }).catch(error => showBubble(error.message, 2200));
  if (loading) { queuedAvatar = k === avatarKey ? null : k; return; }
  if (k === avatarKey) return;
  const row = document.getElementById('avRow');
  const btns = row ? [...row.children] : [];
  // 按钮置灰但面板留着 —— 换角色的时候其他 UI 一律照常显示
  for (const b of btns) b.disabled = true;
  const label = (AVATARS[k] || {}).label || k;
  const ok = await loadAvatar(k);
  for (const b of btns) b.disabled = false;
  if (avatarKey !== k || loading) return;
  if (!ok) { showBubble('这个形象没加载起来。', 2200); paintAvatars(); return; }
  paintAvatars();
  showBubble(`${label} 来了。`, 1600);
  pet.log(`[avatar] ${k} ${label}`);
}

/* 重扫模型目录：丢一个 .vrm 进来，下次打开设置就在列表里（不用重启、不用改代码） */
async function refreshAvatars() {
  try {
    const list = await pet.avatars();
    if (!Array.isArray(list) || !list.length) return;
    setAvatarList(list);
    const row = document.getElementById('avRow');
    if (row) row.innerHTML = '';
    paintAvatars();
  } catch {}
}

/* 动作列表在独立窗口里（panel.html），这里只留一个开关。
 * 主人从那边点一个动作，主进程把 key 转成 'motion' 事件送回来，playOneShot 照播。 */
let motionOpenFlag = false;

/* ═══════════ 主循环 ═══════════ */
let ambientTimer = 22 + Math.random() * 16;
let nodeCount = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = performance.now() / 1000;

  if (vrm) {
    bodyAvoidance?.restore();
    if (mixer) mixer.update(dt);

    // 面板打开 → 角色连影子一起往左让位；面板一关再滑回正中。
    // 在渲染循环里平滑（而不是 CSS 过渡），才能每一帧都对得上命中框和气泡。
    sideInsetNow += (panelInsetPx() - sideInsetNow) * Math.min(1, dt * 9);
    const dxPx = (innerWidth - sideInsetNow) / 2 - innerWidth / 2;
    modelX = dxPx / pxPerWorldY();
    vrm.scene.position.x = modelX;
    if (Math.abs(dxPx - lastGxPx) > 0.4) {
      lastGxPx = dxPx;
      groundEl.style.setProperty('--gx', `${dxPx.toFixed(1)}px`);
    }

    // 眨眼
    blinkTimer -= dt;
    if (blinkTimer <= 0) {
      setExpr('blink', 1);
      setTimeout(() => setExpr('blink', 0), 105);
      blinkTimer = 2.2 + Math.random() * 3.6;
    }

    // 口型：直接从播放中的波形取能量，真实对嘴
    if (analyser && (currentSource || pcmPlayer?.playing)) {
      analyser.getByteTimeDomainData(analyserData);
      let sum = 0;
      for (let i = 0; i < analyserData.length; i++) {
        const v = (analyserData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / analyserData.length);
      // 噪声门 + 较高增益：人声 RMS 通常 0.05~0.2，需要放大才能看出张嘴
      const gated = rms < 0.006 ? 0 : rms;
      const target = Math.min(1, Math.pow(gated * 9.5, 0.85));
      talkLevel += (target - talkLevel) * Math.min(1, dt * (target > talkLevel ? 30 : 14));
      setExpr('aa', Math.min(1, talkLevel * 1.15));
    } else if (talkLevel > 0.001) {
      talkLevel *= Math.max(0, 1 - dt * 12);
      if (talkLevel < 0.01) { talkLevel = 0; setExpr('aa', 0); }
      else setExpr('aa', talkLevel);
    }

    // 表情淡出
    if (emoTimer > 0) {
      emoTimer -= dt;
      if (emoTimer <= 0) clearEmo();
    }

    // 视线：跟鼠标，但说话时看向主人（角色让位时视点跟着走，才不会斜眼看人）
    pointerSmooth.lerp(pointer, Math.min(1, dt * 5.5));
    const lx = pointerSmooth.x * 1.15 + modelX;
    const ly = 1.32 + pointerSmooth.y * 0.5 + (speakingNow ? -0.05 : 0);
    lookTarget.position.set(lx, ly, 1.05);

    bodyAvoidance?.apply();
    vrm.update(dt);

    // 命中框（每帧算，随动作变化）
    lastHit = characterRect();

    // 气泡贴着头顶走，而不是钉死在窗口顶上
    const head = vrm.humanoid && (vrm.humanoid.getRawBoneNode('head') || vrm.humanoid.getNormalizedBoneNode('head'));
    if (head) {
      head.getWorldPosition(_v);
      _v.y += fitInfo.modelH * 0.115;      // 头顶（含发梢）在 head 骨骼上方约 11.5% 身高处
      _v.project(camera);
      const topY = (-_v.y * 0.5 + 0.5) * stageViewport.height + stageViewport.offsetY;
      const bubble = document.getElementById('bubble');
      if (!bubble.classList.contains('hidden')) {
        bubbleController.place(topY, innerHeight);
      }
    }

    // 空闲自娱自乐：没在说话、没在录、没开输入框、没在思考、没开动作列表，就隔一会儿动一动
    if (!speakingNow && !thinkingNow && !recording && dockMode !== 'open' && !emoActive() && !motionOpenFlag) {
      ambientTimer -= dt;
      if (ambientTimer <= 0) {
        // 抽一个槽位，槽内随机。抽到 idle 且抽中循环站姿 → 换一种站法站着；
        // 其余按一次性动作播，播完 mixer 的 finished 会自己回待机。
        // 不抽 pose / motion / dance —— 无缘无故转圈、做仰卧起坐，显得神经。
        const slot = AMBIENT_SLOTS[Math.floor(Math.random() * AMBIENT_SLOTS.length)];
        const k = pickSlotKey(slot);
        if (k) {
          const m = MOTIONS.find((x) => x.key === k);
          if (m && m.loop) { idleKey = k; toIdle(0.7); }
          else playOneShot(k, 0.45);
        }
        ambientTimer = 18 + Math.random() * 20;
      }
    }

    nodeCount++;
  }

  renderer.render(scene, camera);
}

/* ═══════════ 主进程事件 ═══════════ */
function wire() {
  pet.on(async (ev) => {
    switch (ev.type) {
      case 'scene':
        bubbleController.hide();
        clearWebSources();
        paintHeard('', false); paintLive(''); paintRecallButton([]);
        break;
      case 'avatars': setAvatarList(ev.avatars || []); break;
      case 'config':
        cfg = ev.config;
        if (currentMotion && !motionEnabled(currentMotion)) toIdle(0.25);
        paintMute();
        paintActivity(lastWorkSnap || {});
        break;
      case 'listen':
        listening = !!ev.on;
        paintListen();
        break;
      case 'heard':
        // 听到了什么：只做轻提示，不抢气泡
        paintHeard(ev.text, ev.replied);
        break;
      case 'asrLive':
        paintLive(ev.text);
        break;
      case 'aec':
        aecOn = !!ev.on;
        break;
      case 'say':
        showBubble(ev.text);
        break;
      case 'chat':
        if (ev.role === 'user') { clearWebSources(); noteMaster(); showBubble(ev.text, 3000); }
        else if (ev.role === 'assistant') bubbleController.finish(ev.text, 9000);
        break;
      case 'recall':
        paintRecallButton(ev.entries);
        break;
      case 'delta':
        clearWebSources();
        bubbleController.appendDelta(ev.text);
        break;
      case 'webSources':
        paintWebSources(ev);
        break;
      case 'avatar-description-request': {
        const key = ev.key;
        if (key === avatarKey && !loading) { const png = avatarPreviewPNG(); if (png) void pet.avatarDescribe?.({ key, png }); }
        break;
      }
      case 'viewport': viewportManaged = true; stageViewport = { width: ev.width, height: ev.height, offsetY: ev.offsetY || 0 }; onResize(); break;
      case 'motion-library': {
        const oldLoops = new Map(MOTIONS.map(m => [m.key, m.loop]));
        const oldKeys = new Set(MOTIONS.map(m => m.key));
        MOTIONS = ev.motions || []; MOTION_GROUPS = ev.categories || [];
        const keys = new Set(MOTIONS.map(m => m.key));
        let changed = MOTIONS.some(m => !rawAnims.has(m.key) || oldLoops.get(m.key) !== m.loop);
        for (const key of oldKeys) if (!keys.has(key)) { rawAnims.delete(key); clips.delete(key); changed = true; }
        if (changed) { await loadMotions(); if (vrm) rebuildClips(); }
        if (!motionEnabled(currentMotion)) toIdle();
        break;
      }
      case 'motion': {
        // 模型给的是槽位名（cheer），也可能是具体 key（手动列表复用这条路）
        const k = ev.requestId ? ev.key : resolveMotion(ev.key);
        if (k) playOneShot(k, 0.18, ev);
        else pet.motionStarted?.({ key: ev.key, avatar: avatarKey, requestId: ev.requestId, ok: false });
        break;
      }
      case 'emo':
        if (ev.key) applyEmo(ev.key, 1, ev.holdMs || 3500);
        break;
      case 'think':
        thinkingNow = !!ev.on;
        if (thinkingNow) {
          clearWebSources();
          ambientTimer = 30;
          if (!speakingNow) {
            // think 槽 5 条轮换；一条都没载入就退回张望
            const k = resolveMotion('think');
            if (k) playOneShot(k, 0.3, { reason: 'thinking' });
            else if (clips.has('idle_look')) playOneShot('idle_look', 0.3);
          }
        } else if (!speakingNow) {
          if (performance.now() >= expressiveUntil) toIdle(0.42);
          if (shownState === 'pending') { shownState = 'done'; clearHeardLater(); }
        }
        paintEar();
        break;
      case 'speaking':
        speakingNow = !!ev.on;
        bubbleController.setSpeaking(!!ev.on && cfg?.tts?.enabled !== false && cfg?.voice?.enabled !== false);
        if (ev.on) {
          if (shownHeard && shownState !== 'skip') shownState = 'ready';
          ambientTimer = 30;
          // 说话时身体回中性站姿：不要在"抱臂思考"这种姿势里讲话
          if (currentMotion !== IDLE && !ev.interaction && performance.now() >= expressiveUntil) toIdle(0.45);
        } else if (!thinkingNow && shownHeard && shownState !== 'skip') {
          shownState = 'done'; clearHeardLater();
        }
        paintEar();
        break;
      case 'audio':
        if (ev.stop) { stopAudio(true); hideBubble(); break; }
        if (ev.stream) { playPCM(ev.stream); break; }
        if (ev.buffer) {
          playWav(ev.buffer, ev.id);
        }
        break;
      case 'phase': {
        const next = ev.phase || 'idle';
        const prev = phase;
        phase = next;
        // 干活时换成"安静站姿"，闲下来换回会张望的那条
        const want = phase === 'work' ? IDLE_QUIET : IDLE;
        if (want !== idleKey && clips.has(want)) {
          idleKey = want;
          // 只有正停在待机上才当场换；正在说话/播别的动作就别打断，等它自然回到待机
          if (!speakingNow && !thinkingNow && performance.now() >= expressiveUntil && (currentMotion === IDLE || currentMotion === IDLE_QUIET)) {
            toIdle(0.8);
          }
        }
        if (performance.now() < expressiveUntil || speakingNow || thinkingNow) break;
        if (phase === 'idle') {
          toIdle(0.6);
        } else if (phase === 'done' && prev !== 'done' && !speakingNow) {
          // 一件活收尾了，且刚才是别的状态 —— 庆祝一次；同一条消息重复上报不会反复庆祝
          const now = performance.now();
          if (now - lastDonePoseAt > 20000) {
            lastDonePoseAt = now;
            playSlot('cheer', 0.3);
          }
        }
        break;
      }
      case 'monitor':
        paintActivity(ev);
        break;
      case 'desktop':
        paintDesktopActivity(ev);
        break;
      case 'toast':
        paintActivityText(ev.text);
        break;
      case 'avatar':
        if (ev.key) void switchAvatar(ev.key, { persist: false });
        break;
      case 'scale':
        // 从顶部菜单改的大小：窗口已经是新的了，这里只需要重新取景
        viewScale = Number(ev.scale) || 1;
        paintScale();
        if (vrm) fitCamera(vrm.scene);
        break;
      case 'motions':
        openMotions();
        break;
      case 'toidle':
        // 动作列表窗口里的「回到待机」
        ambientTimer = 26;
        toIdle(0.3);
        break;
      case 'record':
        if (ev.state === 'listening') { startRecordUI(); document.getElementById('recText').textContent = '在听…'; }
        else if (ev.state === 'idle') stopRecordUI();
        else if (ev.state === 'starting') {
          startRecordUI();
          // 还没拿到权限时别说"准备"，要说清在等什么
          document.getElementById('recText').textContent =
            asrStat.note === 'pending' ? '等授权…' : '准备…';
        }
        break;
      case 'asrLevel': {
        const l = Math.max(0.08, Math.min(1, ev.v * 2.2));
        recEl.style.setProperty('--lvl', l.toFixed(3));
        // 脚下那条的电平条跟着真实音量走 ——
        // 这是"它在听我说话"最直接的证据，比任何文案都管用。
        const earEl = document.getElementById('ear');
        if (earEl) {
          earEl.style.setProperty('--lvl', Math.min(1, ev.v * 1.9).toFixed(3));
          earEl.classList.toggle('loud', ev.v > 0.22);
        }
        break;
      }
      case 'asrPartial':
        document.getElementById('recText').textContent = ev.text || '在听…';
        break;
      case 'asrFinal':
        stopRecordUI();
        if (ev.text) showBubble(ev.text, 2600);
        break;
      case 'asrStatus':
        paintPerm(ev);
        break;
      case 'asrError':
        stopRecordUI();
        showBubble(ev.message, 7000);
        break;
      case 'ttsError':
        showBubble('嗓子哑了：' + ev.message, 6000);
        break;
      case 'ask':
        openDock();
        break;
      case 'settings':
        openSettings();
        break;
      default:
        break;
    }
  });
}

let activityHideTimer = null;
let lastWorkSnap = null;
let lastDesktopEvent = null;
let lastActivityAt = 0;
let desktopRecentKey = '';
let desktopRecentUntil = 0;

/* ── 状态条轮播 ──
 * 同时可能有好几件事在跑（WorkBuddy 一次开几个任务很常见），一条横幅放不下，
 * 就让这些行自己上下轮播：每 3.8 秒往上顶一行，新行从下方滑进来。 */
const ACT_ROLL_MS = 3800;
let actLines = [];        // 当前要轮播的全部行：{ key, text }
let actSig = '';          // 这些行的"身份"（不含耗时，避免每分钟重置到第一行）
let actIdx = 0;
let actTimer = null;
let actTextMode = false;  // 临时提示语抢占时暂停轮播
/* 被主人点 ✓ 收起的那几条：${sessionId}#${taskId}。
 * 同一个任务从「在干活」变成「做完了」也不再冒出来 —— 他点的是"这个任务别显示了"。
 * 任务重新开始会换新的 taskId，所以不会被旧记录挡住。 */
const actSeen = new Set();

const actTextEl = () => document.getElementById('activityText');
const actKey = (t) => `${t.sessionId || ''}#${t.taskId || 0}`;

function actNode(t, i, n) {
  const mins = Math.floor((t.durationMs || 0) / 60000);
  const pos = n > 1 ? `${i + 1}/${n} · ` : '';
  const lead =
    t.status === 'running' ? `在干活 ${pos}`
      : t.status === 'failed' ? '这次没成 · '
        : t.status === 'abandoned' ? '没下文 · '
          : '有结果 · ';
  const name = t.name || '一件事';
  const tail = mins >= 1 ? `（${mins} 分）` : '';
  // 一行能放多少字：状态条现在能用到窗口右侧（约 260px 文字区），中文 11px 一个字 ≈ 22 字
  const BUDGET = 22;
  return lead + name + (tail && lead.length + name.length + tail.length <= BUDGET ? tail : '');
}

function activityLines(snap) {
  const tasks = (snap && snap.tasks) || [];
  const running = tasks.filter((t) => t.status === 'running' && !actSeen.has(actKey(t)));
  const out = [];
  const desktopTask = lastDesktopEvent?.task;
  if (desktopTask) {
    const status = desktopTask.status;
    const text = status === 'starting' ? 'Bunny 正在准备代理操作'
      : status === 'running' ? (desktopTask.handoffSent ? 'WorkBuddy 已收到原文 · Bunny 正在观察' : 'Bunny 正在操作目标窗口')
        : status === 'awaiting' ? '已提交，等待 WorkBuddy 开始处理'
        : status === 'monitoring' ? 'Bunny 正在观察 WorkBuddy 会话'
          : status === 'verifying' ? 'Bunny 正在核对可见结果'
            : ['paused', 'stopped'].includes(status) ? (desktopTask.handoffSent ? 'Bunny 代理已暂停 · WorkBuddy 会话可能继续' : 'Bunny 代理已暂停')
              : status === 'review' ? (desktopTask.origin === 'dialogue' ? '已有结果，Bunny 正在核对' : '代理结果待你确认')
                : status === 'accepted' ? (desktopTask.automaticAccepted ? 'Bunny 已核对代理结果' : '你已确认代理结果')
                  : status === 'failed' ? '代理任务未完成'
                  : '';
    const active = ['starting', 'running', 'awaiting', 'monitoring', 'verifying', 'review'].includes(status) || lastDesktopEvent.running === true;
    const recentTerminal = ['paused', 'stopped', 'accepted', 'failed'].includes(status) && Date.now() < desktopRecentUntil;
    const key = `desktop#${desktopTask.id || ''}#${status}`;
    if (text && !actSeen.has(key) && (active || (recentTerminal && running.length === 0))) return [{ key, text: characterText(text, cfg) }];
  }
  running.forEach((t, i) => out.push({ key: actKey(t), text: actNode(t, i, running.length) }));
  for (const t of tasks) {
    if (t.status === 'running' || actSeen.has(actKey(t))) continue;
    out.push({ key: actKey(t), text: actNode(t, 0, 0) });
  }
  return out.slice(0, 4);
}

function paintDesktopActivity(event) {
  const previousKey = lastDesktopEvent?.task ? `${lastDesktopEvent.task.id || ''}#${lastDesktopEvent.task.status || ''}` : '';
  lastDesktopEvent = event || null;
  const task = lastDesktopEvent?.task;
  const key = task ? `${task.id || ''}#${task.status || ''}` : '';
  const active = !!task && (lastDesktopEvent.running === true || ['starting', 'running', 'awaiting', 'monitoring', 'verifying', 'review'].includes(task.status));
  if (active) { desktopRecentKey = ''; desktopRecentUntil = 0; }
  else if (task && ['paused', 'stopped', 'accepted', 'failed'].includes(task.status) && key !== desktopRecentKey) {
    desktopRecentKey = key;
    desktopRecentUntil = Date.now() + 7000;
    setTimeout(() => paintActivity(lastWorkSnap || { tasks: [] }), 7050);
  } else if (key !== previousKey) { desktopRecentKey = ''; desktopRecentUntil = 0; }
  paintActivity(lastWorkSnap || { tasks: [] });
}

function canOpenDesktopActivity() {
  const task = lastDesktopEvent?.task;
  if (!task) return false;
  if (lastDesktopEvent.running === true || ['starting', 'running', 'awaiting', 'monitoring', 'verifying', 'review'].includes(task.status)) return true;
  return Date.now() < desktopRecentUntil && actLines[actIdx % Math.max(1, actLines.length)]?.key === `desktop#${task.id || ''}#${task.status}`;
}

function setActLine(txt) {
  const el = actTextEl();
  if (!el || el.textContent === txt) return;
  el.textContent = txt;
}

function slideLine(txt, up = true) {
  const el = actTextEl();
  if (!el) return;
  for (const a of el.getAnimations()) a.cancel();
  const h = el.offsetHeight || 16;
  const min = up ? -h : h;
  el.animate(
    [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: `translateY(${min * 0.55}px)` }],
    { duration: 190, easing: 'ease-in' }
  ).onfinish = () => {
    el.textContent = txt;
    el.animate(
      [{ opacity: 0, transform: `translateY(${-min * 0.55}px)` }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 250, easing: 'ease-out' }
    );
  };
}

/* 鼠标停在状态条上 = 主人正在读这一条：立刻停住，别在他眼皮底下把字滚走。
 * 移开之后不是接着滚，而是重新等满一个周期 —— 他可能只是顺手划过去看看。 */
let actHover = false;
activity.addEventListener('pointerenter', () => { actHover = true; stopRoll(); });
activity.addEventListener('pointerleave', () => { actHover = false; startRoll(); });
activity.tabIndex = -1;
activity.addEventListener('click', (event) => {
  if (event.target.closest('#actDone') || !canOpenDesktopActivity()) return;
  pet.open('desktop');
});
activity.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('#actDone') && canOpenDesktopActivity()) {
    event.preventDefault(); pet.open('desktop');
  }
});

function stopRoll() {
  if (actTimer) clearInterval(actTimer);
  actTimer = null;
}

function startRoll() {
  stopRoll();
  if (actHover) return;                 // 鼠标还停在上面，等它移开再重新开始计时
  if (actLines.length < 2 || actTextMode) return;
  actTimer = setInterval(() => {
    if (actTextMode || !actLines.length) return;
    if (activity.classList.contains('hidden')) return;
    actIdx = (actIdx + 1) % actLines.length;
    slideLine(actLines[actIdx].text);
  }, ACT_ROLL_MS);
}

/** 没任务了不消失，改成「空闲中」——让主人知道是真没事，而不是条被吞了 */
function paintIdle() {
  stopRoll();
  actLines = []; actSig = ''; actIdx = 0;
  activity.classList.remove('hidden');
  activity.classList.add('idle');
  activity.classList.remove('desktop-openable');
  activity.tabIndex = -1;
  setActLine('空闲中');
}

/** 状态条只说"在做什么/做完了没"，绝不显示命令、路径、工具名。多任务时轮播。 */
function paintActivity(snap) {
  lastWorkSnap = snap;
  lastActivityAt = Date.now();
  if (!snap) { activity.classList.add('hidden'); actLines = []; actSig = ''; stopRoll(); return; }
  const lines = activityLines(snap);
  if (!lines.length) { paintIdle(); return; }
  const sig = lines.map((l) => l.key).join('|');
  actLines = lines;
  activity.classList.remove('hidden');
  activity.classList.remove('idle');
  activity.classList.toggle('desktop-openable', canOpenDesktopActivity());
  activity.tabIndex = canOpenDesktopActivity() ? 0 : -1;
  actTextMode = false;
  if (sig !== actSig) {
    // 任务集合变了（新任务 / 被点掉一条）：从第一条重新开始
    actSig = sig;
    actIdx = 0;
    setActLine(lines[0].text);
  } else {
    // 只是耗时在涨：原地更新当前这一行，别把轮播打回第一行
    setActLine(lines[actIdx % lines.length].text);
  }
  startRoll();
}

/** ✓：把当前显示的那一条收起来，剩下还有就继续轮到下一条 */
function dismissCurrent() {
  if (!actLines.length) return;
  const cur = actLines[actIdx % actLines.length];
  actSeen.add(cur.key);
  if (actSeen.size > 60) {
    // 只留最近的一批，别无限长
    const keep = [...actSeen].slice(-40);
    actSeen.clear();
    for (const k of keep) actSeen.add(k);
  }
  const el = actTextEl();
  for (const a of el.getAnimations()) a.cancel();
  paintActivity(lastWorkSnap || {});
}
document.getElementById('actDone').addEventListener('click', (event) => { event.stopPropagation(); dismissCurrent(); });
/* 调试用：看轮播队列此刻的真实状态 */
window.__act = () => ({
  keys: actLines.map((l) => l.key),
  texts: actLines.map((l) => l.text),
  idx: actIdx,
  seen: [...actSeen],
  text: actTextEl() ? actTextEl().textContent : null,
  cls: activity.className,
});

/** 临时提示语（"看着呢"之类）：占住横幅，过一会儿自动回到轮播 */
function paintActivityText(txt) {
  if (!txt) return;
  actTextMode = true;
  stopRoll();
  setActLine(txt);
  activity.classList.remove('hidden');
  if (activityHideTimer) clearTimeout(activityHideTimer);
  activityHideTimer = setTimeout(() => {
    actTextMode = false;
    if (actLines.length) {
      actIdx = 0;
      setActLine(actLines[0].text);
      startRoll();
    } else if (lastWorkSnap) {
      paintIdle();
    } else {
      activity.classList.add('hidden');
    }
  }, 5200);
}
// 任务在跑时，耗时得自己往上爬（监控只在结构变化时才推）
setInterval(() => {
  if (lastWorkSnap && lastWorkSnap.tasks && lastWorkSnap.tasks.some((t) => t.status === 'running')) {
    paintActivity(lastWorkSnap);
  }
}, 15000);

/* ═══════════ 启动 ═══════════ */
/* 启动链路任何一步失败都必须留痕：以前是静默半死（面板能开、角色不出来） */
(function boot() {
  const run = async () => {
    const init = await pet.init();
    if (init?.desktop) paintDesktopActivity(init.desktop);
    paintRecallButton(init?.currentRecall);
    cfg = init.config;
    if (init.viewport) { viewportManaged = true; stageViewport = init.viewport; onResize(); }
    const ver = document.getElementById('ver');
    if (ver) ver.textContent = 'v' + ((init.versions && init.versions.app) || '');
    const settingsButton = document.getElementById('gearBtn');
    if (settingsButton && init.versions?.app) settingsButton.title = `设置 · v${init.versions.app}`;
    setAvatarList(init.avatars);
    MOTIONS = Array.isArray(init.motions) ? init.motions : [];
    if (Array.isArray(init.motionGroups) && init.motionGroups.length) MOTION_GROUPS = init.motionGroups;
    viewScale = (cfg.window && cfg.window.scale) || 0.5;
    paintScale();
    paintMute();
    wire();
    renderer.setAnimationLoop(frame);
    await loadMotions();
    loadAvatar(AVATARS[init.avatar] ? init.avatar : AVATAR_LIST[0].key);
    fab.classList.remove('hidden');
    setTimeout(() => fab.classList.add('show'), 300);
      // 耳朵状态：配置里开着就先点亮，真实状态等主进程回报
    listening = !!(cfg.voice && cfg.voice.alwaysListen);
    paintListen();
    setTimeout(async () => {
      try { paintPerm(await pet.asrStatus()); } catch {}
    }, 1500);
  };
  run().catch((e) => {
    window.__bootErr = String((e && e.stack) || e);
    console.error('启动失败', e);
    try { pet.log('[boot] 失败 ' + String((e && e.message) || e)); } catch {}
    const ld = document.getElementById('hint');
    if (ld) { ld.textContent = '我起不来了：' + String((e && e.message) || e).slice(0, 80); ld.classList.remove('hidden'); }
  });
})();

window.__pet = () => ({
  vrm: !!vrm, loading, mixer: !!mixer, clips: clips.size, currentMotion, phase, speakingNow,
  talkLevel: +talkLevel.toFixed(3), recording, avatarKey,
  audio: !!currentSource, emo: emoTimer > 0,
  hit: lastHit, dockOpen: dockMode === 'open',
  hiddenMeshes: [...new Set(hiddenAvatarMeshes)],
  asr: asrStat, listening, bootErr: window.__bootErr || null,
});
window.__play = (k) => { playOneShot(k, 0.18); return k; };
window.__away = (ms) => { lastMasterAt = performance.now() - ms; return ms; };
window.__avatar = (k) => { switchAvatar(k); return k; };
window.__avatars = () => Object.keys(AVATARS);
window.__openSettings = () => { openSettings(); return true; };
window.__motions = () => ({ count: MOTIONS.length, groups: MOTION_GROUPS.length, slots: [...new Set(MOTIONS.map((m) => m.slot))] });
window.__playSlot = (slot) => playSlot(slot, 0.2);
window.__scale = (k) => { setScale(k); return viewScale; };
window.__light = (scale) => {
  if (scale !== undefined) { applyAvatarLight(scale); renderer.render(scene, camera); }
  return {
  ambient: +ambient.intensity.toFixed(2),
  key: +keyLight.intensity.toFixed(2),
  factor: +((ambient.intensity || 0) / LIGHT_BASE.ambient).toFixed(2),
  };
};
/* 取景自检：把关键点投到屏幕上，验证"半身/全身"两种构图到底落在哪几行像素 */
window.__frame = () => {
  if (!vrm || !vrm.humanoid) return null;
  const toScreen = (v) => {
    const p = v.clone().project(camera);
    return { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * stageViewport.height + stageViewport.offsetY) };
  };
  const bone = (n) => {
    const node = vrm.humanoid.getRawBoneNode(n) || vrm.humanoid.getNormalizedBoneNode(n);
    if (!node) return null;
    const v = new THREE.Vector3();
    node.getWorldPosition(v);
    return toScreen(v);
  };
  const box = new THREE.Box3().setFromObject(vrm.scene);
  return {
    scale: viewScale,
    bust: !!fitInfo.bust,
    w: innerWidth, h: innerHeight, viewport: stageViewport,
    top: toScreen(box.max).y,
    bottom: toScreen(box.min).y,
    head: bone('head'),
    hips: bone('hips'),
    footL: bone('leftFoot'),
    modelX: +modelX.toFixed(3),
    node: nodeCount,
  };
};
/* 截图用：停掉渲染循环，否则软件渲染下截图会漏掉带 backdrop-filter 的面板 */
window.__freeze = (v) => { renderer.setAnimationLoop(v === false ? frame : null); return true; };
addEventListener('error', (e) => { window.__err = String(e.message || e.error || e); });
// 自检钩子：驱动脚下那条的各种形态
window.__dock = (m) => {
  if (m === 'open') openDock();
  else if (m === 'close') closeDock();
  return { mode: dockMode, listening, text: shownHeard };
};
window.__heard = (text, replied) => { paintHeard(text, replied); return shownHeard; };
window.__listen = (on) => { listening = !!on; paintEar(); return listening; };
window.__level = (v) => {
  const ear = document.getElementById('ear');
  ear.style.setProperty('--lvl', Math.min(1, Number(v) || 0).toFixed(3));
  ear.classList.toggle('loud', Number(v) > 0.22);
  return true;
};
