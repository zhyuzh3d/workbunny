import * as THREE from 'three';
import { createDialogueOverlay } from './dialogue-overlay.mjs';
import { modelContextHit } from './model-context-hit.mjs';
import { dialogueTopForHead } from './dialogue-placement.mjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import { makeRig, groundClip, soleHeight } from './ground.js';
import { cutClip, MOTION_WINDOWS } from './motion-cut.js';
import { processMotionClip, crossFadeMotionAction } from './motion-quality.mjs';
import { captureThumbReference, sourceThumbReference, thumbPolicy, bakeThumbPolicy } from './thumb-relax.js';
import { createBodyAvoidance } from './body-avoidance.mjs';
import { createPCMPlayer } from './pcm-player.mjs';
import { taskActivity } from './task-activity.mjs';
import { taskCard, refreshTaskClock } from './task-card.mjs';
import { createTaskControls } from './task-controls.mjs';
import { observeInputRegions } from './window-input-regions.mjs';
import { createBubbleController } from './bubble-ui.mjs';
import { renderResultText } from './result-links.mjs';
import { characterText } from './character-name.mjs';
import { createAvatarLighting } from './avatar-lighting.mjs';
import { lightingForAvatar } from './avatar-lighting-profiles.mjs';
import { DataAvatarRuntime } from './data-avatar-runtime.mjs';
import { SoftSurfaceRuntime } from './soft-surface/runtime.mjs';
import { disposeAvatarScene } from './avatar-scene.mjs';

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
const IDLE = 'idle_pose';
const SIT_IDLE = 'ov_world_sit_idle';
const SIT_ENTER = 'hq_world_sit_enter';
const SIT_EXIT = 'hq_world_sit_exit';
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
let vrmBounds = null;
let postureHead = null, hitNodes = [];
let dataAvatar = null;
let dataAvatarDigest = '';
let mixer = null;
let bodyAvoidance = null;
let currentAction = null;
const motionActions = new Set();
let currentMotion = null;
let avatarKey = '';
const rawAnims = new Map();
const thumbReferences = new Map();
let modelThumbReference = null;
const clips = new Map();
const motionLoads = new Map();
let groundRig = null, groundReference = null;
let bodyPosture = 'standing', activeTransition = null, pendingMotion = null, motionRequestRevision = 0;
let standingHeadY = null; const postureHeadPosition = new THREE.Vector3();
let loading = false;
let loadingAvatarKey = null;

let emoTimer = 0;
let blinkTimer = 2.2, blinkRemaining = 0;
let talkLevel = 0;
let phase = 'idle';          // idle | work | done
let lastDonePoseAt = -1e9;
/* 主人上一次跟我说话是什么时候。用来判"他离开很久又回来了" —— 那时候该起身迎接，
 * 而不是继续站在原地当什么也没发生。 */
let lastMasterAt = performance.now();
let speakingNow = false;
let thinkingNow = false;   // 主人说完 → 她正在想：这段时间不能一动不动

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

const avatarLighting = createAvatarLighting(scene,renderer);
const ambient = avatarLighting.ambient;

/* 内置角色使用灯光工作台确认的完整配置；个人模型保留原始系数回退。
 * 已确认的配置包含模型系数，必须按绝对值应用，避免再次缩放。 */
const LIGHT_BASE = { ambient: 1.9, key: 2.1, rim: 1.15, fill: .5 };
function applyAvatarLight(scale = 1) {
  const s = Math.max(0.4, Math.min(1.2, Number(scale) || 1));
  avatarLighting.apply(lightingForAvatar(avatarKey,s));
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
const groundEl = document.getElementById('ground');

/* ── 半身与全身分别取景，再按画布尺寸缩放 ──
 *   50% 半身：内部值 0.25。沿用 100% 半身取景，画布尺寸减半，底部 UI 不缩放。
 *   半身 ：内部值 0.5。窗口一点不变，等于把镜头推近：只取头顶到胯，
 *          头压在画面上部的主视觉区，下面留够气泡的位置。
 *          桌面角落里的小尺寸要的是「一张脸」，不是「一个小人」。
 *   100% ：全身。脚落在窗口最下方 2%，头顶上方留出气泡位（原来的构图）。
 *   150% ：全身不变形，窗口按 1.5 倍撑开 —— 她真的变大了，而不是被窗口裁掉。
 * 宽度也一起算：切到胯的时候胳膊不能出画，所以拿肩宽反算一个最小视野。 */
let dialogueRestTop = null;
let restHeadY = 0;
function updateDialoguePlacement() {
  if (!dialogueRestTop) return;
  camera.updateMatrixWorld();
  const p = new THREE.Vector3(dialogueRestTop.x, dialogueRestTop.y, dialogueRestTop.z).project(camera);
  const headY = (-p.y * .5 + .5) * stageViewport.height + stageViewport.offsetY;
  restHeadY = headY;
  const top = dialogueTopForHead(headY, innerHeight, canvasScaleFactor());
  document.documentElement.style.setProperty('--dialogue-top', `${top}px`);
  dispatchEvent(new Event('dialogue-layout'));
}

function canvasScaleFactor() {
  return viewScale === 0.25 ? 0.5 : Math.max(1, viewScale);
}

function fitCamera(obj) {
  const box = vrmBounds;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (dialogueRestTop?.root !== obj) dialogueRestTop = { root: obj, x: center.x, y: box.max.y, z: center.z };
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
  const expansion = Math.max(1, stageViewport.height / (620 * canvasScaleFactor()));
  visibleH *= expansion; aimY += (visibleH - previousVisible) / 2;
  // 100% 半身像整体上移 48px，保持角色大小不变，多露出腰胯部分。
  if (bust) aimY -= 48 * canvasScaleFactor() * visibleH / stageViewport.height;
  const dist = visibleH / 2 / Math.tan(fovR / 2);
  camera.position.set(0, aimY, dist);
  camera.lookAt(0, aimY, 0);
  camera.aspect = stageViewport.width / stageViewport.height;
  camera.updateProjectionMatrix();
  fitInfo = { dist, centerY: aimY, visibleH, modelH: size.y, bust };
  updateDialoguePlacement();
  // 半身的时候脚在画面外，影子留在窗口下沿会像个浮空的黑块 —— 直接收掉
  groundEl.style.opacity = bust ? '0' : '1';
}

function syncUIWidth() {
  const baseline = stageViewport.width / canvasScaleFactor();
  document.documentElement.style.setProperty('--ui-base-width', `${baseline * 4 / 7}px`);
}
function onResize() {
  if (!viewportManaged) stageViewport = { width: innerWidth, height: innerHeight, offsetY: 0 };
  syncUIWidth();
  const w = stageViewport.width, h = stageViewport.height;
  const old = renderer.getSize(new THREE.Vector2());
  if (old.x !== w || old.y !== h) {
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    if (vrm) fitCamera(vrm.scene);
    else if (dataAvatar) fitDataAvatar();
  }
  Object.assign(renderer.domElement.style, { position: 'absolute', top: stageViewport.offsetY + 'px', width: w + 'px', height: h + 'px' });
  updateDialoguePlacement();
}
addEventListener('resize', onResize);

/* ═══════════ 动作 ═══════════ */
function buildClip(id, anim) {
  const item = MOTIONS.find(m => m.key === id);
  if (!item || !vrm) return;
  try {
    let clip = createVRMAnimationClip(anim, vrm);
    // Reviewed corrections and merged sequences have already been baked in the
    // workbench. Applying grounding/IK a second time alters the approved motion.
    if (!item.bakedPreview) {
      const w = MOTION_WINDOWS[id];
      if (w && !item.sourceId) clip = cutClip(clip, w[0], w[1]);
      if (groundRig && !/swim/i.test(id)) {
        if (id === IDLE && groundReference == null) groundReference = soleHeight(clip, groundRig);
        groundClip(clip, groundRig, groundReference);
      }
      processMotionClip(clip, { loop: !!item.loop });
      if (item.thumbAdaptation !== false) bakeThumbPolicy(clip, vrm, thumbPolicy(modelThumbReference, thumbReferences.get(id), item.label));
    }
    clips.set(id, clip);
  } catch (e) { console.warn('动作重定向失败', id, e); }
}
function rebuildClips() {
  clips.clear(); groundReference = null;
  try { groundRig = makeRig(vrm); } catch (e) { groundRig = null; console.warn('建替身骨架失败', e); }
  // Establish a consistent standing ground reference before other actions.
  if (rawAnims.has(IDLE)) buildClip(IDLE, rawAnims.get(IDLE));
}

function clipFor(key) {
  if (!clips.has(key) && rawAnims.has(key)) buildClip(key, rawAnims.get(key));
  return clips.get(key);
}

function playMotion(key, { loop = false, fade = FADE, requestId, reason = 'idle' } = {}) {
  const requestedKey = key;
  const report = ok => { if (requestId || reason !== 'transition') pet.motionStarted?.({ key: ok ? key : requestedKey, avatar: avatarKey, requestId, reason, ok }); };
  if (activeTransition && reason !== 'transition') { if (requestId) report(false); return; }
  if (loading && requestId) { report(false); return; }
  let clip = key && motionEnabled(key) ? clipFor(key) : null;
  if (!clip) { key = randomIdle(); loop = true; clip = clipFor(key); }
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
  return motionCore?.choose(MOTIONS.filter(m => (m.idle ?? (m.slot === 'idle')) && m.posture !== (bodyPosture === 'sitting' ? 'standing' : 'sitting') && !m.transition && motionEnabled(m.key) && rawAnims.has(m.key)))?.key || null;
}
function pickSlotKey(slot) {
  const pool = MOTIONS.filter(m => m.slot === slot && m.posture !== (bodyPosture === 'sitting' ? 'standing' : 'sitting') && !m.transition && m.autonomous !== false && !m.requiresProp && motionEnabled(m.key) && rawAnims.has(m.key));
  return motionCore?.choose(pool)?.key || randomIdle();
}
/** 槽位名或具体 key 都吃：有 key 就播 key，否则当槽位随机。 */
function resolveMotion(name) {
  if (!name) return randomIdle();
  if (rawAnims.has(name)) return motionEnabled(name) ? name : randomIdle();
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
  return item && (item.idle ?? (item.slot === 'idle')) && item.posture !== (bodyPosture === 'sitting' ? 'standing' : 'sitting') && rawAnims.has(idleKey) && motionEnabled(idleKey) ? idleKey : randomIdle();
}
function toIdle(fade = 0.32) {
  const key = currentIdle();
  if (key) { idleKey = key; playMotion(key, { loop: true, fade }); }
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
function closeMouth() {
  talkLevel = 0;
  setExpr('aa', 0);
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
let voiceGain = null;
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
  voiceGain = audioCtx.createGain();
  voiceGain.gain.value = (volumePreview ?? cfg?.voice?.volume ?? 100) / 100;
  analyser.connect(voiceGain);
  voiceGain.connect(audioCtx.destination);
  analyserData = new Uint8Array(analyser.fftSize);
  pcmPlayer = createPCMPlayer({ context: audioCtx, destination: analyser,
    onStart: id => { markReplyStarted(id); pet.audioStarted(id); },
    onDone: id => { closeMouth(); pet.audioDone(true, id); },
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
      closeMouth();
      pet.audioDone(true, id);
    }
  };
  currentSource = src;
  src.start();
  markReplyStarted(id); pet.audioStarted(id);
}

function stopAudio(keepQuiet) {
  audioRevision++;
  pcmPlayer?.stop();
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch {}
    currentSource = null;
  }
  closeMouth();
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

function markReplyStarted(id) {
  if (id !== activeAudioId) return;
  if (shownHeard && !['skip', 'not-addressed'].includes(shownState)) { shownState = 'reply'; paintEar(); }
}

/* ═══════════ 加载 ═══════════ */
function loadMotion(key) {
  if (rawAnims.has(key)) { if (vrm && !loading && !clips.has(key)) buildClip(key, rawAnims.get(key)); return Promise.resolve(true); }
  if (motionLoads.has(key)) return motionLoads.get(key);
  const item = MOTIONS.find(m => m.key === key);
  if (!item) return Promise.resolve(false);
  const promise = animLoader.loadAsync(item.url || `./assets/motions/${key}.vrma`).then(async gltf => {
    const animation = gltf.userData.vrmAnimations?.[0];
    if (!animation) return false;
    let thumbs;
    try { thumbs = await sourceThumbReference(gltf); }
    catch (error) { console.warn('动作手部参考读取失败', key, error); }
    if (!MOTIONS.some(m => m.key === key && m.url === item.url)) return false;
    if (thumbs) thumbReferences.set(key, thumbs);
    rawAnims.set(key, animation);
    if (vrm && !loading) clipFor(key);
    return true;
  }).catch(() => false).finally(() => {
    if (motionLoads.get(key) === promise) motionLoads.delete(key);
  });
  motionLoads.set(key, promise); return promise;
}
function loadMotions() {
  // Retarget/ground the rest on demand: hundreds of clips must not delay startup.
  const initial = [IDLE, IDLE_QUIET, SIT_IDLE, SIT_ENTER, SIT_EXIT,
    ...MOTIONS.filter(m => m.idle && !m.requiresProp && m.posture !== 'sitting').slice(0, 7).map(m => m.key),
    ...MOTIONS.filter(m => m.idle && !m.requiresProp && m.posture === 'sitting' && m.key !== SIT_IDLE).slice(0, 2).map(m => m.key)];
  return Promise.all([...new Set(initial)].filter(k => MOTIONS.some(m => m.key === k)).map(loadMotion));
}
function cancelPendingMotion() {
  if (pendingMotion?.requestId) pet.motionStarted?.({ key: pendingMotion.key, avatar: avatarKey, requestId: pendingMotion.requestId, ok: false });
  pendingMotion = null;
}
async function requestMotion(event) {
  const revision = ++motionRequestRevision;
  const item = MOTIONS.find(m => m.key === event.key);
  if (!item || !motionEnabled(item.key)) { pet.motionStarted?.({ ...event, avatar: avatarKey, ok: false }); return; }
  if (activeTransition) { cancelPendingMotion(); pendingMotion = event; return; }
  const desired = item.posture || 'standing';
  if (item.transition && (item.transition === 'sit' ? bodyPosture === 'sitting' : bodyPosture === 'standing')) {
    pet.motionStarted?.({ ...event, avatar: avatarKey, ok: false }); return;
  }
  const bridge = desired !== bodyPosture ? (bodyPosture === 'standing' ? SIT_ENTER : SIT_EXIT) : null;
  if (bridge && (!event.allowPostureChange || !motionEnabled(bridge))) { pet.motionStarted?.({ ...event, avatar: avatarKey, ok: false }); return; }
  const currentAvatar = avatarKey;
  const loaded = await Promise.all([loadMotion(item.key), ...(bridge ? [loadMotion(bridge)] : [])]);
  if (revision !== motionRequestRevision || currentAvatar !== avatarKey || loading || loaded.some(v => !v) || !clips.has(item.key) || (bridge && !clips.has(bridge))) {
    pet.motionStarted?.({ ...event, avatar: currentAvatar, ok: false }); return;
  }
  if (bridge) {
    cancelPendingMotion(); pendingMotion = event;
    activeTransition = { to: desired };
    playMotion(bridge, { loop: false, fade: 0.4, reason: 'transition' });
  } else {
    if (item.transition) activeTransition = { to: item.transition === 'sit' ? 'sitting' : 'standing' };
    playOneShot(item.key, item.transition ? 0.4 : 0.28, { ...event, loop: !!item.idle || (event.reason === 'manual' && !!item.loop), reason: item.transition ? 'transition' : event.reason });
  }
}

let queuedAvatar = null;
function nextAvatar() {
  const next = queuedAvatar; queuedAvatar = null;
  if (next && next !== avatarKey) queueMicrotask(() => void switchAvatar(next, { persist: false }));
}
const dataModelLoader = new GLTFLoader();
async function loadDataModel(bytes) {
  if (!bytes || !ArrayBuffer.isView(bytes) || bytes.byteLength > 64 * 1024 * 1024) throw Error('形象模型数据不可用');
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve, reject) => dataModelLoader.parse(data, '', resolve, reject));
  if (!gltf.scene) throw Error('形象模型没有场景');
  return { root: gltf.scene, dispose: () => disposeAvatarScene(gltf.scene) };
}
async function createDataAvatar(payload, onFinished) {
  const instance = payload.runtime.engine === 'soft-surface-v1' ? new SoftSurfaceRuntime() : new DataAvatarRuntime();
  try { await instance.load({ loadModel: () => loadDataModel(payload.model),
    loadSurface: () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload.model)),
    camera, disposeRoot: disposeAvatarScene, onFinished }, payload.runtime); }
  catch (error) { instance.dispose(); throw error; }
  const box = new THREE.Box3().setFromObject(instance.visualRoot || instance.root);
  if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.y)) { instance.dispose(); throw Error('形象模型没有可见范围'); }
  instance.restBounds = box;
  return instance;
}
function fitDataAvatar() {
  if (!dataAvatar) return;
  const box = dataAvatar.restBounds || (dataAvatar.restBounds = new THREE.Box3().setFromObject(dataAvatar.visualRoot || dataAvatar.root));
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  dialogueRestTop = { root: dataAvatar.root, x: center.x, y: box.max.y, z: center.z };
  const margin = (dataAvatar.visualRoot ? 1.65 : 1.4) / .70;
  const visibleH = Math.max(.1, size.y * margin, size.x * margin / Math.max(.1, camera.aspect));
  const dist = visibleH / (2 * Math.tan(camera.fov * Math.PI / 360));
  const bottomInset = Math.min(stageViewport.height * .03, 8) + 30, aimY = box.min.y + visibleH * (.5 - bottomInset / stageViewport.height);
  camera.position.set(center.x, aimY, center.z + dist); camera.lookAt(center.x, aimY, center.z); camera.updateProjectionMatrix();
  fitInfo = { dist, centerX: center.x, centerY: aimY, centerZ: center.z, visibleH, modelH: size.y, bust: false };
  updateDialoguePlacement();
  groundEl.style.opacity = '0';
}
function clearMountedAvatar() {
  if (mixer) {
    mixer.stopAllAction();
    mixer.uncacheRoot(mixer.getRoot());
    mixer = null;
  }
  currentAction = null;
  currentMotion = null;
  motionActions.clear();
  clips.clear();
  avatarLighting.setModel(null);
  if (vrm) {
    scene.remove(vrm.scene);
    disposeAvatarScene(vrm.scene);
    vrm = null;
  }
  if (dataAvatar) {
    scene.remove(dataAvatar.root);
    dataAvatar.dispose();
    dataAvatar = null;
  }
  vrmBounds = null;
  modelThumbReference = null;
  dataAvatarDigest = '';
  bodyAvoidance = null;
  groundRig = null;
  hitNodes = [];
  postureHead = null;
  hiddenAvatarMeshes = [];
  lastHit = null;
}

function prepareVrm(gltf, info) {
  const candidate = gltf.userData.vrm;
  if (!candidate?.humanoid) throw new Error('模型缺少 VRM 骨骼');
  const root = candidate.scene, hidden = [];
  root.position.x = 0;
  if (candidate.meta?.metaVersion === '0') root.rotation.y = Math.PI;
  root.traverse(object => {
    object.frustumCulled = false;
    const source = gltf.parser.associations.get(object);
    const name = gltf.parser.json.meshes?.[source?.meshes]?.name;
    if (name && info.hiddenMeshes?.includes(name)) {
      object.visible = false;
      hidden.push(name);
    }
  });
  candidate.humanoid.autoUpdateHumanBones = true;
  if (candidate.lookAt) {
    candidate.lookAt.target = lookTarget;
    const proxy = new VRMLookAtQuaternionProxy(candidate.lookAt);
    proxy.name = 'VRMLookAtQuaternionProxy';
    root.add(proxy);
  }
  softenCutoutEdges(root);
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty() || !Number.isFinite(bounds.min.y) || !Number.isFinite(bounds.max.y) || bounds.max.y <= bounds.min.y) {
    throw new Error('VRM 模型没有可见范围');
  }
  return { candidate, hidden, bounds, thumb: captureThumbReference(candidate),
    avoidance: candidate.meta?.name === 'Bunny Face Hybrid' ? createBodyAvoidance(candidate) : null };
}

function mountVrm({ candidate, hidden, bounds, thumb, avoidance }) {
  vrm = candidate;
  vrmBounds = bounds;
  modelThumbReference = thumb;
  bodyAvoidance = avoidance;
  hiddenAvatarMeshes = hidden;
  postureHead = vrm.humanoid.getNormalizedBoneNode('head');
  hitNodes = hitBones.map(name => ({ name, node: vrm.humanoid.getRawBoneNode(name) || vrm.humanoid.getNormalizedBoneNode(name) }))
    .filter(({ node }) => node);
  mixer = new THREE.AnimationMixer(vrm.scene);
  mixer.addEventListener('finished', event => {
    if (event.action !== currentAction) return;
    expressiveUntil = 0;
    if (activeTransition) {
      bodyPosture = activeTransition.to; activeTransition = null;
      idleKey = bodyPosture === 'sitting' ? SIT_IDLE : IDLE;
      pet.bodyPosture?.({ avatar: avatarKey, posture: bodyPosture });
      const next = pendingMotion; pendingMotion = null;
      if (next) void requestMotion(next); else toIdle(0.4);
    } else toIdle(0.35);
    paintMotionActive();
  });
}

async function loadAvatar(key) {
  if (loading) return false;
  const info = AVATARS[key] || AVATAR_LIST[0];
  loading = true;
  loadingAvatarKey = key;
  ++motionRequestRevision;
  cancelPendingMotion();
  setLoading(true, `正在努力加载 ${info.label || '角色'}…`);
  let nextData, nextVrm, gltf, payload, mounted = false;
  try {
    if (info.kind === 'avatar-pack') {
      payload = await pet.avatarPackData(key);
      nextData = await createDataAvatar(payload, () => {
        if (dataAvatar === nextData && avatarKey === key) {
          currentMotion = nextData.defaultIdle;
          pet.motionStarted?.({ key: currentMotion, avatar: key, reason: 'idle', ok: true });
        }
      });
      nextData.setPalette?.(cfg.avatarPalettes?.[key]);
    } else {
      const motionsReady = loadMotions();
      gltf = await vrmLoader.loadAsync(info.url || `./assets/models/${info.file}`);
      nextVrm = prepareVrm(gltf, info);
      await motionsReady;
    }
    if (queuedAvatar && queuedAvatar !== key) return null;

    // Leave the previous avatar live until the entire replacement is ready.
    clearMountedAvatar();
    avatarKey = key;
    bodyPosture = 'standing';
    standingHeadY = null;
    activeTransition = null;
    blinkTimer = 2.2;
    blinkRemaining = 0;
    idleKey = IDLE;
    if (nextData) {
      dataAvatar = nextData;
      dataAvatarDigest = payload.digest;
      currentMotion = nextData.defaultIdle;
    } else {
      mountVrm(nextVrm);
    }
    const root = dataAvatar?.root || vrm.scene;
    scene.add(root);
    mounted = true;
    avatarLighting.setModel(root);
    applyAvatarLight(info.light || 1);
    if (dataAvatar) fitDataAvatar();
    else {
      fitCamera(root);
      rebuildClips();
      toIdle(0.001);
    }
    pet.bodyPosture?.({ avatar: key, posture: bodyPosture });
    pet.bodyReady?.({ avatar: key, expressions: Object.keys(vrm?.expressionManager?.expressionMap || {}) });
    pet.motionStarted?.({ key: currentMotion, avatar: key, reason: 'idle', ok: true });
    document.getElementById('hint')?.classList.add('hidden');
    return true;
  } catch (error) {
    console.error('形象加载失败', error);
    return false;
  } finally {
    if (!mounted) {
      nextData?.dispose();
      const root = nextVrm?.candidate.scene || gltf?.scene;
      if (root) disposeAvatarScene(root);
    }
    loading = false;
    loadingAvatarKey = null;
    setLoading(false);
    if (mounted) flushAvatarDescription();
    nextAvatar();
  }
}
let pendingAvatarDescriptionKey = '';
function flushAvatarDescription() {
  if (!pendingAvatarDescriptionKey || pendingAvatarDescriptionKey !== avatarKey || loading) return;
  const key = pendingAvatarDescriptionKey, png = avatarPreviewPNG();
  pendingAvatarDescriptionKey = '';
  if (png) void pet.avatarDescribe?.({ key, png });
}

function avatarPreviewPNG() {
  const model = vrm?.scene || dataAvatar?.visualRoot || dataAvatar?.root;
  if (!model || loading) return null;
  const width = 320, height = 512, target = new THREE.WebGLRenderTarget(width, height);
  const box = new THREE.Box3().setFromObject(model), center = box.getCenter(new THREE.Vector3());
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
const dataBounds = new THREE.Box3(), dataProxyBounds = new THREE.Box3(), dataPoint = new THREE.Vector3();
const dataRaycaster = new THREE.Raycaster(), dataPointer = new THREE.Vector2();
function dataAvatarRect() {
  if (!dataAvatar) return null;
  dataBounds.setFromObject(dataAvatar.visualRoot || dataAvatar.root);
  if (dataAvatar.hitRegions) dataBounds.union(dataAvatar.hitRegions.worldBounds(dataProxyBounds));
  if (dataBounds.isEmpty()) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const x of [dataBounds.min.x, dataBounds.max.x]) for (const y of [dataBounds.min.y, dataBounds.max.y]) for (const z of [dataBounds.min.z, dataBounds.max.z]) {
    dataPoint.set(x, y, z).project(camera);
    if (!Number.isFinite(dataPoint.x) || !Number.isFinite(dataPoint.y)) continue;
    const px = (dataPoint.x * .5 + .5) * stageViewport.width;
    const py = (-dataPoint.y * .5 + .5) * stageViewport.height + stageViewport.offsetY;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  return Number.isFinite(x0) ? { x0: x0 - 8, x1: x1 + 8, y0: y0 - 8, y1: y1 + 8 } : null;
}
function characterRect() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, headY;
  const include = point => {
    point.project(camera);
    if (!isFinite(point.x) || !isFinite(point.y)) return;
    const x = (point.x * 0.5 + 0.5) * innerWidth;
    const y = (-point.y * 0.5 + 0.5) * stageViewport.height + stageViewport.offsetY;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    return y;
  };
  for (const { name, node } of hitNodes) {
    _v.setFromMatrixPosition(node.matrixWorld);
    if (name === 'head') _headHit.copy(_v);
    include(_v);
    if (name === 'head') {
      // The head bone sits near the face center. Include the skull and hair,
      // using the same crown height as bubble placement, at every view scale.
      _v.copy(_headHit); _v.y += fitInfo.modelH * .115; headY = include(_v);
      for (const side of [-1, 1]) {
        _v.copy(_headHit); _v.x += side * fitInfo.modelH * .09; include(_v);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  const pad = 16;
  return { x0: minX - pad, x1: maxX + pad, y0: minY - pad, y1: maxY + pad, headY };
}

observeInputRegions({publish:value=>pet.inputRegions?.(value)});
let lastHit = null;
let interactiveState = false, taskHitState=false;
function updateHit(e) {
  const overUi = !!(e.target && e.target.closest &&
    e.target.closest('#dialogueOverlay, #ear, #dock, #bubble, #settings, #motions, #fab, #rec, #activity, #activityDetails, button, input, textarea'));
  let inside = dragging || overUi;
  if (!inside && cfg?.ui?.avatarHidden !== true) {
    const r = lastHit;
    if (r) inside = e.clientX >= r.x0 && e.clientX <= r.x1 && e.clientY >= r.y0 && e.clientY <= r.y1;
  }
  const taskUi=!!e.target?.closest?.("#activity, #activityDetails");
  if (inside !== interactiveState || taskUi!==taskHitState) {
    interactiveState = inside;
    taskHitState=taskUi;pet.hit(inside,taskUi,overUi);
  }
}

/* ═══════════ 拖拽 ═══════════ */
let dragging = false;
let dragMoved = false;
let downAt = null, dragPoint = null, dragFrame = 0;
const dialogueAvatarHits = new WeakMap();
function avatarThroughDialogue(event) {
  if (cfg?.ui?.avatarHidden === true || !event.target.closest('#dialogueOverlay')) return false;
  if (!dialogueAvatarHits.has(event)) dialogueAvatarHits.set(event,
    modelContextHit(dataAvatar?.root || vrm?.scene, renderer, scene, camera, stageViewport, event.clientX, event.clientY));
  return dialogueAvatarHits.get(event);
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('#statusRow, #dock, #bubble, #activity, #activityDetails, button, input')) return;
  const overDialogue = !!e.target.closest('#dialogueOverlay');
  if (overDialogue && !avatarThroughDialogue(e)) return;
  if (overDialogue) { e.preventDefault(); e.target.setPointerCapture?.(e.pointerId); }
  if (e.target === stage || stage.contains(e.target)) stage.setPointerCapture(e.pointerId);
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

function showBubble(text, holdMs, notice = false) {
  document.getElementById('bubble').classList.toggle('notice', notice);
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
const activity = document.getElementById('activity');

/* 脚下那条（同时是"耳朵"的开关和"我说了什么"的显示器）：
 *   .off     耳朵关着 —— 灰，什么都不动
 *   .on      在听 —— 绿色圆点和竖线同步跟随真实音量
 *   .expand  刚听到话 —— 撑满整窗宽，长了就横向滚动，不省略
 * 一个元素承担全部状态，所以"在听"永远不会跟输入框打架。 */
let dockMode = 'mini';        // mini | open
pet.inputState?.(false);
let listening = false;        // 耳朵开着（常驻聆听）
let shownHeard = '';          // 本轮已识别内容，仅在正在回应时显示
let shownState = '';          // pending | ready | reply | done | skip | not-addressed
let liveText = '';            // 正说到一半的字（实时字幕）
let aecOn = false;            // 系统回声消除可用 → 她说话时也能听
let pendingHeard = '';        // 刚听到、还没被主人用过的一句 —— 留着填进输入框
let pendingAt = 0;
let heardTimer = null;
let heardTurn = 0;
let heardTurnClosed = false;

function clearHeard() {
  clearTimeout(heardTimer); heardTimer = null;
  liveText = ''; shownHeard = ''; shownState = ''; pendingHeard = ''; pendingAt = 0;
}

function acceptHeardTurn(turn) {
  if (!Number.isSafeInteger(turn) || turn <= 0) return true;
  if (turn < heardTurn || turn === heardTurn && heardTurnClosed) return false;
  if (turn > heardTurn) { clearHeard(); heardTurn = turn; heardTurnClosed = false; }
  return true;
}

function asrHealthy() {
  const micOk = asrStat.mic === true || asrStat.micSystem === 'granted';
  return asrStat.speech === 3 && micOk && asrStat.captureReady !== false;
}

function earLabel() {
  if (asrStat.note === 'locked') return '锁屏中 · 监听暂停';
  if (asrStat.note === 'memory-locked') return '记忆待解锁';
  if (listening && asrStat.captureReady === false) return asrStat.note === 'installing' ? '准备语音资源…' : asrStat.note === 'starting' ? '正在连接麦克风…' : '正在重连麦克风…';
  if (liveText) return liveText;
  if (shownState === 'pending') return shownHeard ? `${shownHeard} · 正在回应` : '正在回应';
  if (shownState === 'ready') return '正在转语音';
  if (shownState === 'reply') return '正在说话';
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
  ear.classList.toggle('on', listening);
  ear.classList.toggle('off', !listening);
  if (!listening) ear.style.setProperty('--lvl', '0');
  ear.classList.toggle('warn', warn);
  ear.classList.toggle('skip', ['skip', 'not-addressed'].includes(shownState));
  ear.classList.toggle('expand', !!(liveText || shownState === 'pending' && shownHeard));
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
function paintLive(text, state = {}) {
  if (state.phase === 'reset') {
    if (Number.isSafeInteger(state.turn) && state.turn > 0 && state.turn < heardTurn) return;
    clearHeard(); heardTurn = Math.max(heardTurn, state.turn || 0); heardTurnClosed = true; paintEar(); return;
  }
  if (!acceptHeardTurn(state.turn)) return;
  if (state.phase === 'completed') {
    liveText = ''; pendingHeard = ''; pendingAt = 0; heardTurnClosed = true;
    if (shownState === 'pending') shownState = 'done';
    if (!['ready', 'reply'].includes(shownState)) clearHeardLater(shownState === 'skip' ? 2400 : 3200);
    paintEar(); return;
  }
  liveText = String(text || '').slice(0, 180);
  if (liveText) {
    clearTimeout(heardTimer); heardTimer = null;
    shownHeard = ''; shownState = ''; pendingHeard = ''; pendingAt = 0;
  }
  paintEar();
}

function openDock() {
  if(activityExpandedKey)closeActivityCard();
  hideBubble();
  dockMode = 'open';
  document.body.classList.add('dialogue-input-open');
  dispatchEvent(new Event('dialogue-layout'));
  pet.inputState?.(true);
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
  document.body.classList.remove('dialogue-input-open');
  dispatchEvent(new Event('dialogue-layout'));
  pet.inputState?.(false);
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
  if (dataAvatar && r && e && e.clientX >= r.x0 && e.clientX <= r.x1 && e.clientY >= r.y0 && e.clientY <= r.y1) {
    if (performance.now() - lastInterruptedAt < 900 || thinkingNow) return;
    dataPointer.set(e.clientX / stageViewport.width * 2 - 1, -((e.clientY - stageViewport.offsetY) / stageViewport.height * 2 - 1));
    dataRaycaster.setFromCamera(dataPointer, camera);
    const hit = dataAvatar.hitTest(dataRaycaster);
    if (hit) pet.interact({ region: hit.id, avatar: avatarKey, digest: dataAvatarDigest }).catch(() => {});
    ambientTimer = 26;
    return;
  }
  const onBody = !!(r && e && vrm &&
    e.clientX >= r.x0 && e.clientX <= r.x1 && e.clientY >= r.y0 && e.clientY <= r.y1);
  if (onBody) {
    if (performance.now() - lastInterruptedAt < 900 || thinkingNow) return;
    const region = bodyRegionAt(e.clientX, e.clientY) || 'upper';
    // Actions load on demand. Restricting this list to already-loaded clips
    // leaves only idle animations immediately after startup.
    const motions = MOTIONS.filter(m => motionEnabled(m.key) && !m.requiresProp && !m.transition &&
      (!m.posture || m.posture === bodyPosture)).map(m => m.key);
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
  const result = await pet.say(v);
  if (result && !result.ok) { if (!input.value) input.value = v; showBubble(result.error || '这句话没有发送成功。', 7000, true); }
}

document.getElementById('sendBtn').addEventListener('click', sendText);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendText(); }
  if (e.key === 'Escape') closeDock();
});

/* 点击角色也能立即打断，不必等待语音识别。 */
const stageEl = document.getElementById('stage');
let lastInterruptedAt = -Infinity;
document.addEventListener('contextmenu', event => {
  const overlay = event.target.closest('#dialogueOverlay');
  if (overlay && !overlay.hidden) {
    event.preventDefault(); pet.contextMenu?.({ x: event.clientX, y: event.clientY });
    return;
  }
  if (cfg?.ui?.avatarHidden === true) return;
  if (event.target.closest('#statusRow, #dock, #bubble, #activity, #activityDetails, button, input, textarea')) return;
  if (modelContextHit(dataAvatar?.root || vrm?.scene, renderer, scene, camera, stageViewport, event.clientX, event.clientY)) {
    event.preventDefault(); pet.contextMenu?.({ x: event.clientX, y: event.clientY });
  }
});
document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('#statusRow, #dock, #bubble, #activity, #activityDetails, button, input') ||
      (event.target.closest('#dialogueOverlay') && !avatarThroughDialogue(event))) return;
  if (!speakingNow && !thinkingNow) return;
  lastInterruptedAt = performance.now();
  pet.stopSpeak();
  stopAudio(true);
  speakingNow = false;
  thinkingNow = false;
  toIdle(0.26);
}, { passive: true });

/* 圆点与音波共用一个聆听按钮；其余区域只切换文字输入窗。 */
const earBar = document.getElementById('ear');
const listenToggle = document.getElementById('listenToggle');
listenToggle.addEventListener('pointerdown', event => event.stopPropagation());
listenToggle.addEventListener('click', event => { event.stopPropagation(); pet.listen('toggle'); });
earBar.addEventListener('click', () => dockMode === 'open' ? closeDock() : openDock());

let hintTimer = setTimeout(() => {
  hint.classList.remove('hidden');
  setTimeout(() => hint.classList.add('hidden'), 6000);
}, 1800);

document.getElementById('gearBtn').addEventListener('click', () => openSettings());
const voiceControl = document.getElementById('voiceControl');
const voiceButton = document.getElementById('muteBtn');
const voicePopover = document.getElementById('voicePopover');
const voiceVolume = document.getElementById('voiceVolume');
const voiceVolumeValue = document.getElementById('voiceVolumeValue');
const voiceMuteToggle = document.getElementById('voiceMuteToggle');
let volumePreview = null;
let volumeSaveRevision = 0;

function setVoicePopover(open) {
  voicePopover.hidden = !open;
  voiceButton.setAttribute('aria-expanded', String(open));
}
voiceButton.addEventListener('click', () => setVoicePopover(voicePopover.hidden));
document.addEventListener('pointerdown', event => {
  if (!voiceControl.contains(event.target)) setVoicePopover(false);
}, { capture: true });
addEventListener('blur', () => setVoicePopover(false));

async function saveVoiceSettings(voice) {
  try {
    const next = await pet.config({ voice });
    if ((next.settingsRevision ?? 0) >= (cfg?.settingsRevision ?? 0)) cfg = next;
  } catch {
    showBubble('声音设置未保存，请重试。', 2200, true);
  }
}
voiceVolume.addEventListener('input', () => {
  volumePreview = voiceVolume.valueAsNumber;
  paintVoiceControls();
});
voiceVolume.addEventListener('change', async () => {
  const volume = voiceVolume.valueAsNumber;
  const revision = ++volumeSaveRevision;
  await saveVoiceSettings({ volume });
  if (revision === volumeSaveRevision && volumePreview === volume) volumePreview = null;
  paintVoiceControls();
});
voiceMuteToggle.addEventListener('click', async () => {
  if (!cfg) return;
  await saveVoiceSettings({ enabled: cfg.voice.enabled === false });
  paintVoiceControls();
});
function paintVoiceControls() {
  const volume = volumePreview ?? cfg?.voice?.volume ?? 100;
  const muted = cfg?.voice?.enabled === false;
  const silent = muted || volume === 0;
  voiceVolume.value = volume;
  voiceVolumeValue.value = volume + '%';
  voiceVolume.setAttribute('aria-valuetext', voiceVolumeValue.value);
  voiceVolume.style.setProperty('--voice-level', voiceVolumeValue.value);
  voiceButton.classList.toggle('muted', silent);
  document.getElementById('muteWave').style.display = silent ? 'none' : '';
  document.getElementById('muteCross').style.display = silent ? '' : 'none';
  voiceButton.title = muted ? 'Bunny 音量（已静音）' : 'Bunny 音量';
  voiceButton.setAttribute('aria-label', voiceButton.title);
  voiceMuteToggle.classList.toggle('muted', muted);
  voiceMuteToggle.textContent = muted ? '取消静音' : '静音';
  voiceGain?.gain.setTargetAtTime(volume / 100, audioCtx.currentTime, 0.012);
}

/* ═══════════ 录制 ═══════════ */
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!voicePopover.hidden) {
    setVoicePopover(false);
    voiceButton.focus();
  } else closeDock();
});

/* ═══════════ 常驻聆听 ═══════════ */
function paintListen() {
  paintEar();
}

/** 保存本轮识别内容，正在回应时显示；后续语音状态只显示状态名。 */
function paintHeard(text, replied, reason, turn) {
  if (!text) return;
  if (!acceptHeardTurn(turn)) return;
  // 完成通知可能属于已被新一句打断的旧请求，不覆盖当前字幕。
  if (reason !== 'not-addressed' && replied !== undefined && shownHeard !== String(text).slice(0, 180)) return;
  liveText = '';
  shownHeard = String(text).slice(0, 180);
  shownState = reason === 'not-addressed' ? 'not-addressed' : reason === 'error' ? 'done' : replied === false ? 'skip' : replied === true
    ? (speakingNow ? (shownState === 'reply' ? 'reply' : 'ready') : 'done') : 'pending';
  pendingHeard = replied === undefined && reason !== 'not-addressed' ? shownHeard : '';
  pendingAt = Date.now();
  paintEar();
  clearTimeout(heardTimer);
  // 等待模型和合成期间保留字幕，绝不靠固定超时回到「在听」。
  if (['pending', 'ready', 'reply'].includes(shownState)) return;
  clearHeardLater(replied === false ? 2400 : 3200);
}

function clearHeardLater(delay = 3200) {
  clearTimeout(heardTimer);
  const turn = heardTurn;
  const timer = heardTimer = setTimeout(() => {
    if (turn !== heardTurn || heardTimer !== timer) return;
    clearHeard();
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
    if (ok) { tip.textContent = '麦克风已就绪，开启自动聆听即可。'; }
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

/* 角色画布以底部中心为锚点缩放；100% 半身/全身共用同一窗口大小。 */
function paintScale() {
  syncUIWidth();
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

let avatarSwitchRevision = 0;
async function switchAvatar(k, { persist = true } = {}) {
  if (!AVATARS[k]) return;
  const revision = ++avatarSwitchRevision, previousKey = avatarKey;
  if (persist) void pet.config({ avatar: k }).catch(error => showBubble(error.message, 2200));
  if (loading) { queuedAvatar = k === loadingAvatarKey ? null : k; return; }
  if (k === avatarKey) return;
  const row = document.getElementById('avRow');
  const btns = row ? [...row.children] : [];
  // 按钮置灰但面板留着 —— 换角色的时候其他 UI 一律照常显示
  for (const b of btns) b.disabled = true;
  const label = (AVATARS[k] || {}).label || k;
  const ok = await loadAvatar(k);
  for (const b of btns) b.disabled = false;
  if (ok === null || revision !== avatarSwitchRevision) return;
  if (!ok) {
    if (revision === avatarSwitchRevision && previousKey && previousKey !== k) void pet.config({ avatar: previousKey }).catch(() => {});
    showBubble('这个形象没加载起来。', 2200, true); paintAvatars(); return;
  }
  if (avatarKey !== k || loading) return;
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
let windowVisible = true, deferredFrameTime = 0;
const bubbleElement = document.getElementById('bubble');

function frame() {
  deferredFrameTime += clock.getDelta();
  if (!dataAvatar && !vrm) { deferredFrameTime = 0; return; }
  const render = windowVisible && cfg?.ui?.avatarHidden !== true;
  if (!render && deferredFrameTime < 1 / 30) return;
  const dt = Math.min(deferredFrameTime, 0.1);
  deferredFrameTime = 0;

  if (dataAvatar) {
    dataAvatar.update(dt);
    if (dataAvatar.visualRoot && fitInfo) {
      const p = dataAvatar.visualRoot.position, zoom = Math.min(5, (dataAvatar.cameraOffset || 0) + Math.max(0, Math.abs(p.x) - 1) * .7 + Math.max(0, -p.z) * .25);
      const followX = Math.sign(p.x) * Math.max(0, Math.abs(p.x) - 1.2) * .45;
      const a = 1 - Math.exp(-dt * 6);
      camera.position.x += (fitInfo.centerX + followX - camera.position.x) * a;
      camera.position.z += (fitInfo.centerZ + fitInfo.dist + zoom - camera.position.z) * a;
      camera.lookAt(fitInfo.centerX + followX * .5, fitInfo.centerY, fitInfo.centerZ);
    }
  }
  if (vrm) {
    bodyAvoidance?.restore();
    if (mixer) mixer.update(dt);
    // In the cropped bust view a sitting avatar would otherwise slide almost
    // completely below the window. Keep the head visible by moving the model,
    // never the camera, and ease the offset during sit/stand transitions.
    if (postureHead) {
      postureHead.getWorldPosition(postureHeadPosition);
      const headY = postureHeadPosition.y - vrm.scene.position.y;
      if (bodyPosture === 'standing' && !activeTransition) standingHeadY = headY;
      const sittingView = bodyPosture === 'sitting' || activeTransition?.to === 'sitting';
      const targetY = viewScale <= 0.51 && sittingView && standingHeadY != null ? Math.max(0, Math.min(0.65, standingHeadY - headY)) : 0;
      vrm.scene.position.y += (targetY - vrm.scene.position.y) * Math.min(1, dt * 4);
    }

    if (blinkRemaining > 0) {
      blinkRemaining = Math.max(0, blinkRemaining - dt);
      if (blinkRemaining === 0) setExpr('blink', 0);
    }
    blinkTimer -= dt;
    if (blinkTimer <= 0) {
      setExpr('blink', 1);
      blinkRemaining = 0.105;
      blinkTimer = 2.2 + Math.random() * 3.6;
    }

    // 口型：直接从播放中的波形取能量，真实对嘴
    if (render && analyser && (currentSource || pcmPlayer?.playing)) {
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
    } else {
      // Audio callbacks can end between frames, and a motion can also write
      // expression weights. Always clear the actual mouth expression at rest.
      closeMouth();
    }

    // 表情淡出
    if (emoTimer > 0) {
      emoTimer -= dt;
      if (emoTimer <= 0) clearEmo();
    }

    // 视线：跟鼠标，但说话时看向主人（角色让位时视点跟着走，才不会斜眼看人）
    pointerSmooth.lerp(pointer, Math.min(1, dt * 5.5));
    const lx = pointerSmooth.x * 1.15;
    const ly = 1.32 + pointerSmooth.y * 0.5 + (speakingNow ? -0.05 : 0);
    lookTarget.position.set(lx, ly, 1.05);

    bodyAvoidance?.apply();
    vrm.update(dt);

    // 空闲自娱自乐：没在说话、没在录、没开输入框、没在思考、没开动作列表，就隔一会儿动一动
    if (!speakingNow && !thinkingNow && dockMode !== 'open' && !emoActive() && !motionOpenFlag) {
      ambientTimer -= dt;
      if (ambientTimer <= 0) {
        // 抽一个槽位，槽内随机。抽到 idle 且抽中循环站姿 → 换一种站法站着；
        // 其余按一次性动作播，播完 mixer 的 finished 会自己回待机。
        // 不抽 pose / motion / dance —— 无缘无故转圈、做仰卧起坐，显得神经。
        // 80% of checks preserve the current idle; never change posture on a whim.
        if (!activeTransition && Math.random() >= 0.8) rotateIdle();
        ambientTimer = 40 + Math.random() * 40;
      }
    }

    nodeCount++;
  }

  if (render) {
    renderer.render(scene, camera);
    // The renderer has already updated the scene and camera matrices.
    lastHit = dataAvatar ? dataAvatarRect() : characterRect();
  } else lastHit = null;
  if (windowVisible && !bubbleElement.classList.contains('hidden')) {
    const anchor = dataAvatar ? lastHit?.y0 : lastHit?.headY;
    bubbleController.place(anchor ?? restHeadY, innerHeight);
  }
}

/* ═══════════ 主进程事件 ═══════════ */
function wire() {
  pet.on(async (ev) => {
    switch (ev.type) {
      case 'scene':
        bubbleController.hide();
        clearWebSources();
        clearHeard(); paintEar(); paintRecallButton([]);
        break;
      case 'avatars': setAvatarList(ev.avatars || []); break;
      case 'avatar-pack-probe': {
        let candidate;
        try { candidate = await createDataAvatar(ev); pet.avatarPackProbeResult?.({ id: ev.id, ok: true }); }
        catch (error) { pet.avatarPackProbeResult?.({ id: ev.id, ok: false, error: String(error?.message || error) }); }
        finally { candidate?.dispose(); }
        break;
      }
      case 'avatar-pack-refresh': {
        let ok = true;
        if (ev.key === avatarKey && AVATARS[ev.key]?.kind === 'avatar-pack') {
          ok = await loadAvatar(ev.key) === true;
          if (ok && ev.digest && dataAvatarDigest !== ev.digest) ok = false;
        }
        if (ev.id) pet.avatarPackProbeResult?.({ id: ev.id, ok, error: ok ? undefined : '形象切换失败' });
        break;
      }
      case 'config':
        cfg = ev.config;
        dataAvatar?.setPalette?.(cfg.avatarPalettes?.[avatarKey]);
        if (!dataAvatar && currentMotion && !motionEnabled(currentMotion)) toIdle(0.25);
        paintVoiceControls();
        paintActivity(lastWorkSnap || {});
        break;
      case 'pet-visibility':
        windowVisible = ev.visible === true;
        break;
      case 'listen':
        listening = !!ev.on;
        paintListen();
        break;
      case 'heard':
        // 听到了什么：只做轻提示，不抢气泡
        paintHeard(ev.text, ev.replied, ev.reason, ev.turn);
        break;
      case 'asrLive':
        paintLive(ev.text, ev);
        break;
      case 'aec':
        aecOn = !!ev.on;
        break;
      case 'say':
        showBubble(ev.text);
        break;
      case 'chat':
        document.getElementById('bubble').classList.remove('notice');
        if (ev.role === 'user') { clearWebSources(); noteMaster(); if (ev.source !== 'keyboard') showBubble(ev.text, 3000); }
        else if (ev.role === 'assistant') {bubbleController.finish(ev.text, 9000);if(ev.taskId&&ev.links?.length)renderResultText(document.getElementById('bubbleText'),ev.text,ev.links,index=>pet.agentResultLink(ev.taskId,index));}
        break;
      case 'recall':
        paintRecallButton(ev.entries);
        break;
      case 'delta':
        document.getElementById('bubble').classList.remove('notice');
        clearWebSources();
        bubbleController.appendDelta(ev.text);
        break;
      case 'webSources':
        paintWebSources(ev);
        break;
      case 'avatar-description-request': {
        const key = ev.key;
        pendingAvatarDescriptionKey = key; flushAvatarDescription();
        break;
      }
      case 'viewport': viewportManaged = true; stageViewport = { width: ev.width, height: ev.height, offsetY: ev.offsetY || 0 }; onResize(); break;
      case 'motion-library': {
        const oldLoops = new Map(MOTIONS.map(m => [m.key, m.loop]));
        const oldKeys = new Set(MOTIONS.map(m => m.key));
        MOTIONS = ev.motions || []; MOTION_GROUPS = ev.categories || [];
        const keys = new Set(MOTIONS.map(m => m.key));
        let changed = MOTIONS.some(m => rawAnims.has(m.key) && oldLoops.get(m.key) !== m.loop);
        for (const key of oldKeys) if (!keys.has(key)) { rawAnims.delete(key); clips.delete(key); changed = true; }
        if (changed && vrm) rebuildClips();
        if (!motionEnabled(currentMotion)) toIdle();
        break;
      }
      case 'motion': {
        if (dataAvatar) {
          const result = !loading ? dataAvatar.play({ key: ev.key }) : { ok: false };
          if (result.ok) currentMotion = ev.key;
          pet.motionStarted?.({ key: ev.key, avatar: avatarKey, requestId: ev.requestId, reason: ev.reason, ok: !!result.ok });
          break;
        }
        // 模型给的是槽位名（cheer），也可能是具体 key（手动列表复用这条路）
        const k = ev.requestId ? ev.key : resolveMotion(ev.key);
        if (k) void requestMotion({ ...ev, key: k });
        else pet.motionStarted?.({ key: ev.key, avatar: avatarKey, requestId: ev.requestId, ok: false });
        break;
      }
      case 'emo':
        if (ev.key) applyEmo(ev.key, 1, ev.holdMs || 3500);
        break;
      case 'think':
        thinkingNow = !!ev.on;
        if (thinkingNow) {
          // stopSpeaking retires the previous output before this request
          // starts. Restore the current candidate's response caption here.
          if (ev.text) paintHeard(ev.text, undefined, undefined, ev.turn);
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
          if (shownState === 'pending' && (!Number.isSafeInteger(ev.turn) || ev.turn === heardTurn)) { shownState = 'done'; clearHeardLater(); }
        }
        paintEar();
        break;
      case 'speaking':
        speakingNow = !!ev.on;
        bubbleController.setSpeaking(!!ev.on && cfg?.tts?.enabled !== false && cfg?.voice?.enabled !== false);
        if (ev.on) {
          if (shownHeard && !['skip', 'not-addressed'].includes(shownState)) shownState = 'ready';
          ambientTimer = 30;
          // 说话时身体回中性站姿：不要在"抱臂思考"这种姿势里讲话
          if (currentMotion !== IDLE && !ev.interaction && performance.now() >= expressiveUntil) toIdle(0.45);
        } else if (!thinkingNow && shownHeard && !['skip', 'not-addressed'].includes(shownState)) {
          shownState = 'done'; clearHeardLater();
        } else if (thinkingNow && shownHeard && shownState === 'reply') {
          shownState = 'pending';
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
        const want = bodyPosture === 'sitting' ? SIT_IDLE : phase === 'work' ? IDLE_QUIET : IDLE;
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
      case 'agent':
        lastAgentEvent=ev;
        paintActivity(lastWorkSnap || {tasks:[]});
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
        else if (dataAvatar) fitDataAvatar();
        break;
      case 'motions':
        openMotions();
        break;
      case 'toidle':
        // 动作列表窗口里的「回到待机」
        ambientTimer = 26;
        if (dataAvatar) { dataAvatar.play({ key: dataAvatar.defaultIdle, loop: true }); currentMotion = dataAvatar.defaultIdle; }
        else toIdle(0.3);
        break;
      case 'asrLevel': {
        // 圆点和竖线共用实际电平，按钮命中区域保持固定。
        const earEl = document.getElementById('ear');
        if (earEl) {
          const level = Number.isFinite(ev.v) ? Math.max(0, Math.min(1, ev.v * 1.9)) : 0;
          earEl.style.setProperty('--lvl', level.toFixed(3));
        }
        break;
      }
      case 'asrPartial': paintLive(ev.text || ''); break;
      case 'asrStatus':
        paintPerm(ev);
        break;
      case 'asrError':
        showBubble(ev.message, 7000, true);
        break;
      case 'ttsError':
        showBubble('嗓子哑了：' + ev.message, 6000, true);
        break;
      case 'ask':
        if (ev.open === false) closeDock();
        else { pet.hit(true); openDock(); }
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
let lastAgentEvent = null;
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
let actExpiryTimer = null;
let actTextMode = false;  // 临时提示语抢占时暂停轮播
/* ✓ 只收起已结束的提示，正在执行或监看的任务始终可见。 */
const actSeen = new Set();
const activityControls=createTaskControls({changed:()=>{activityCardSignature='';paintActivity(lastWorkSnap||{});}}),activityStopPending=activityControls.pending,activityActionMessages=activityControls.messages;
let activityExpandedKey=null,activityCardSignature='';

const actTextEl = () => document.getElementById('activityText');


function activityLines(snap) {
  return taskActivity({agent:lastAgentEvent||{},desktop:lastDesktopEvent||{},work:snap||{},now:Date.now(),recentUntil:desktopRecentUntil,seen:actSeen,selectedKey:activityExpandedKey});
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

function canOpenDesktopActivity() { return actLines.length>0; }

function setActLine(txt) {
  const el = actTextEl();
  if (!el) return;
  el.textContent = txt;
  const row=actLines[actIdx%Math.max(1,actLines.length)],icon=activity.querySelector('.workbuddy-logo');
  if(!actTextMode&&row&&activityActionMessages.has(row.key))el.textContent=activityActionMessages.get(row.key)+' · '+row.text;
  if(!actTextMode&&row?.record?.stopRequest?.phase==='pending'&&(row.record.resources?.some(r=>r.kind!=='controller'&&!['ended','stopped','preserved'].includes(r.phase))||row.record.workJobId)){const seconds=Math.max(0,Math.ceil((row.record.stopRequest.deadlineAt-Date.now())/1000));el.textContent='Bunny 已停止 · 外部停止中 '+seconds+' 秒 · '+row.record.presentation?.title;}
  if (icon) {
    const isWorkBuddy = !actTextMode && row?.icon === 'workbuddy';
    icon.src = isWorkBuddy ? './assets/icons/workbuddy-logo.png' : '../../res/trayTemplate.svg';
    icon.alt = isWorkBuddy ? 'WorkBuddy' : 'Bunny';
  }
  const button=document.getElementById('actDone');button.hidden=actTextMode||!row?.action;button.textContent=row?.action==='dismiss'?'✓':'×';button.title=row?.action==='stop'?'停止这项任务':row?.action==='archive'?'移出任务列表（保留记录）':'收起已完成任务';button.setAttribute('aria-label',button.title);button.disabled=activityStopPending.has(row?.key);
  activity.title=txt+(row?' · 点击展开任务详情':'');
  paintActivityCard();
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
    setActLine(txt);
    el.animate(
      [{ opacity: 0, transform: `translateY(${-min * 0.55}px)` }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 250, easing: 'ease-out' }
    );
  };
}
setInterval(()=>{const row=actLines[actIdx%Math.max(1,actLines.length)];if(!actTextMode&&row?.record?.stopRequest?.phase==='pending')setActLine(row.text);},1000);

/* 鼠标停在状态条上 = 主人正在读这一条：立刻停住，别在他眼皮底下把字滚走。
 * 移开之后不是接着滚，而是重新等满一个周期 —— 他可能只是顺手划过去看看。 */
let actHover = false;
activity.addEventListener('pointerenter', () => { actHover = true; stopRoll(); });
activity.addEventListener('pointerleave', () => { actHover = false; startRoll(); });
activity.addEventListener('wheel',event=>{if(actLines.length<2)return;event.preventDefault();stopRoll();actIdx=(actIdx+(event.deltaY>0?1:-1)+actLines.length)%actLines.length;if(activityExpandedKey)activityExpandedKey=actLines[actIdx].key;setActLine((actIdx+1)+'/'+actLines.length+' · '+actLines[actIdx].text);if(!actHover)startRoll();},{passive:false});
activity.tabIndex = -1;
activity.addEventListener('click', (event) => {
  if (event.target.closest('#actDone') || !canOpenDesktopActivity()) return;
  toggleActivityCard();
});
activity.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('#actDone') && canOpenDesktopActivity()) {
    event.preventDefault(); toggleActivityCard();
  }
});

function stopRoll() {
  if (actTimer) clearInterval(actTimer);
  actTimer = null;
}

function startRoll() {
  stopRoll();
  if (actHover || activityExpandedKey) return;                 // 鼠标还停在上面，等它移开再重新开始计时
  if (actLines.length < 2 || actTextMode) return;
  actTimer = setInterval(() => {
    if (actTextMode || !actLines.length) return;
    if (activity.classList.contains('hidden')) return;
    actIdx = (actIdx + 1) % actLines.length;
    slideLine((actLines.length>1?(actIdx+1)+'/'+actLines.length+' · ':'')+actLines[actIdx].text);
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
  clearTimeout(actExpiryTimer);
  lastWorkSnap = snap;
  lastActivityAt = Date.now();
  if (!snap) { activity.classList.add('hidden'); actLines = []; actSig = ''; stopRoll(); return; }
  const lines = activityLines(snap);
  if (!lines.length) { paintIdle(); return; }
  const expiries=lines.map(l=>l.expiresAt).filter(Boolean);
  if(expiries.length)actExpiryTimer=setTimeout(()=>paintActivity(lastWorkSnap||{tasks:[]}),Math.max(1,Math.min(...expiries)-Date.now()+10));
  const sig = lines.map((l) => l.key).join('|');
  actLines = lines;
  for(const key of activityActionMessages.keys())if(!lines.some(l=>l.key===key))activityActionMessages.delete(key);
  if(activityExpandedKey&&!lines.some(l=>l.key===activityExpandedKey)){closeActivityCard(false);}
  activity.classList.remove('hidden');
  activity.classList.remove('idle');
  activity.classList.toggle('desktop-openable', canOpenDesktopActivity());
  activity.tabIndex = canOpenDesktopActivity() ? 0 : -1;
  actTextMode = false;
  if (sig !== actSig) {
    // 任务集合变了（新任务 / 被点掉一条）：从第一条重新开始
    actSig = sig;
    actIdx = Math.max(0,lines.findIndex(l=>l.key===activityExpandedKey));
    setActLine((lines.length>1?(actIdx+1)+'/'+lines.length+' · ':'')+lines[actIdx].text);
  } else {
    // 只是耗时在涨：原地更新当前这一行，别把轮播打回第一行
    setActLine((lines.length>1?(actIdx+1)+'/'+lines.length+' · ':'')+lines[actIdx % lines.length].text);
  }
  if(!actTimer)startRoll();
}

function toggleActivityCard(){
 const row=actLines[actIdx%Math.max(1,actLines.length)];if(!row)return;
 if(activityExpandedKey){closeActivityCard();return;}
 activityExpandedKey=row.key;activityCardSignature='';stopRoll();document.getElementById('activityDetails').hidden=false;activity.setAttribute('aria-expanded','true');
 void pet.activityExpanded(true).catch(()=>{});paintActivity(lastWorkSnap||{});
}
function closeActivityCard(repaint=true){
 activityExpandedKey=null;activityCardSignature='';document.getElementById('activityDetails').hidden=true;activity.setAttribute('aria-expanded','false');void pet.activityExpanded(false).catch(()=>{});if(repaint)paintActivity(lastWorkSnap||{});
}
function switchActivityCard(delta){
 if(actLines.length<2)return;actIdx=(actIdx+delta+actLines.length)%actLines.length;activityExpandedKey=actLines[actIdx].key;activityCardSignature='';paintActivity(lastWorkSnap||{});
}
function paintActivityCard(){
 if(!activityExpandedKey)return;const row=actLines.find(l=>l.key===activityExpandedKey);if(!row)return;
 const details=document.getElementById('activityDetails'),body=document.getElementById('activityTaskCard');details.hidden=false;
 document.getElementById('activityTaskCount').textContent=(actIdx+1)+' / '+actLines.length+' · 轮播已暂停';
 for(const id of ['activityPrevious','activityNext'])document.getElementById(id).disabled=actLines.length<2;
 const record=row.record||{},status=['ready','running','waiting'].includes(record.status)?'active':record.status,signature=JSON.stringify([row.key,status,record.note,record.presentation,record.queuedEvents,record.result,record.delivery,record.schedule,activityStopPending.has(row.key),activityActionMessages.get(row.key)]);
 if(signature===activityCardSignature){refreshTaskClock(body,record);return;}activityCardSignature=signature;
 const scroll=body.scrollTop,open=[...body.querySelectorAll('details[open]')].map(d=>d.dataset.detailsKey);
 const card=taskCard(record,{external:row.ref.source!=='agent',pending:activityStopPending.has(row.key),message:activityActionMessages.get(row.key)||'',onAction:operation=>void runActivityAction(row,operation),onResultLink:(id,index)=>pet.agentResultLink(id,index),onArtifact:(id,index)=>pet.agentArtifact(id,index).catch(error=>{activityActionMessages.set(row.key,error.message);activityCardSignature='';paintActivityCard();})});
 body.replaceChildren(card);for(const d of body.querySelectorAll('details'))if(open.includes(d.dataset.detailsKey))d.open=true;body.scrollTop=scroll;
}
async function runActivityAction(row,operation){
 if(operation==='details'){const d=document.querySelector('#activityTaskCard [data-details-key="reason"]');if(d)d.open=true;return;}
 return activityControls.run(row.key,operation,()=>pet.activityControl(operation,row.ref));
}
for(const [id,delta]of [['activityPrevious',-1],['activityNext',1]])document.getElementById(id).onclick=()=>switchActivityCard(delta);
document.getElementById('activityCollapse').onclick=()=>closeActivityCard();
document.getElementById('activityAllTasks').onclick=()=>{closeActivityCard();pet.open('desktop');};
addEventListener('keydown',event=>{if(event.key==='Escape'&&activityExpandedKey){event.preventDefault();closeActivityCard();}});

/** ✓：把当前显示的那一条收起来，剩下还有就继续轮到下一条 */
async function dismissCurrent() {
  if (!actLines.length) return;
  const cur = actLines[actIdx % actLines.length];
  if(cur.action==='stop')return runActivityAction(cur,'stop');
  if(cur.action==='archive'||cur.action==='dismiss'&&cur.ref.source==='agent')return runActivityAction(cur,'archive');
  if(cur.action!=='dismiss')return;
  if(activityExpandedKey===cur.key)closeActivityCard(false);
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
  cls: activity.className,expandedKey:activityExpandedKey,
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
    if(init?.agent)lastAgentEvent=init.agent;
    if (init?.desktop) paintDesktopActivity(init.desktop);
    paintRecallButton(init?.currentRecall);
    cfg = init.config;
    window.__dialogueOverlay = createDialogueOverlay(pet, cfg);
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
    paintVoiceControls();
    wire();
    renderer.setAnimationLoop(frame);
    windowVisible = init.visible !== false;
    void loadAvatar(AVATARS[init.avatar] ? init.avatar : AVATAR_LIST[0].key);
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
  vrm: !!vrm, dataAvatar: !!dataAvatar, palette: dataAvatar?.paletteId || null, loading, mixer: !!mixer, clips: clips.size, currentMotion, bodyPosture, transition: activeTransition?.to || null, phase, speakingNow,
  talkLevel: +talkLevel.toFixed(3), mouth: vrm?.expressionManager?.getValue('aa') ?? null, avatarKey, avatarDigest: dataAvatarDigest,
  renderFrame: renderer.info.render.frame,
  audio: !!currentSource, emo: emoTimer > 0,
  hit: lastHit, dockOpen: dockMode === 'open',
  hiddenMeshes: [...new Set(hiddenAvatarMeshes)],
  asr: asrStat, listening, bootErr: window.__bootErr || null,
});
window.__play = (k) => { if (dataAvatar) { if (dataAvatar.play({ key: k }).ok) currentMotion = k; } else playOneShot(k, 0.18); return k; };
window.__away = (ms) => { lastMasterAt = performance.now() - ms; return ms; };
window.__avatar = (k) => { switchAvatar(k); return k; };
window.__avatars = () => Object.keys(AVATARS);
window.__regionPoint = id => {
  const matches = dataAvatar?.hitRegions?.items.filter(entry => entry.id === id) || [];
  const item = matches[matches.length - 1];
  if (!item) return null;
  item.anchor.updateWorldMatrix(true, false);
  const p = new THREE.Vector3().setFromMatrixPosition(item.local).applyMatrix4(item.anchor.matrixWorld).project(camera);
  return { x: (p.x * .5 + .5) * stageViewport.width, y: (-p.y * .5 + .5) * stageViewport.height + stageViewport.offsetY };
};
window.__openSettings = () => { openSettings(); return true; };
window.__motions = () => ({ count: MOTIONS.length, groups: MOTION_GROUPS.length, slots: [...new Set(MOTIONS.map((m) => m.slot))] });
window.__playSlot = (slot) => playSlot(slot, 0.2);
window.__scale = (k) => { setScale(k); return viewScale; };
window.__light = (scale) => {
  if (scale !== undefined) { applyAvatarLight(scale); renderer.render(scene, camera); }
  return {
  ambient: +ambient.intensity.toFixed(2),
  key: +avatarLighting.getLight('key').intensity.toFixed(2),
  factor: +((ambient.intensity || 0) / LIGHT_BASE.ambient).toFixed(2),
  avatar: avatarKey, profile: avatarLighting.snapshot(),
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
    modelX: 0,
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
window.__heard = (text, replied, reason) => { paintHeard(text, replied, reason); return shownHeard; };
window.__listen = (on) => { listening = !!on; paintEar(); return listening; };
window.__level = (v) => {
  const ear = document.getElementById('ear');
  ear.style.setProperty('--lvl', Math.min(1, Number(v) || 0).toFixed(3));
  return true;
};
