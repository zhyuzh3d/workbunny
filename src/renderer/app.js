import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';

/* ═══════════ 常量 ═══════════ */
const AVATARS = {
  D: { file: 'AvatarSample_D.vrm', label: 'D' },
  E: { file: 'AvatarSample_E.vrm', label: 'E' },
  F: { file: 'AvatarSample_F.vrm', label: 'F' },
  G: { file: 'AvatarSample_G.vrm', label: 'G' },
};
const MOTION_FILES = [
  'idle_loop', 'LookAround', 'Relax', 'Thinking', 'Sleepy',
  'Goodbye', 'Clapping', 'Jump', 'Surprised', 'Angry', 'Sad', 'Blush',
];
const IDLE = 'idle_loop';
const FADE = 0.26;

/* ═══════════ 状态 ═══════════ */
let cfg = null;
let vrm = null;
let mixer = null;
let currentAction = null;
let currentMotion = null;
let avatarKey = 'D';
const rawAnims = new Map();
const clips = new Map();
let loading = false;

let emoTimer = 0;
let blinkTimer = 2.2;
let talkLevel = 0;
let phase = 'idle';          // idle | work | done
let lastWorkPoseAt = -1e9;
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

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.05, 60);
camera.position.set(0, 1.2, 3);

scene.add(new THREE.AmbientLight(0xffffff, 1.9));
const keyLight = new THREE.DirectionalLight(0xfff6ec, 2.1);
keyLight.position.set(1.1, 2.6, 2.2);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xbcc8ff, 1.15);
rimLight.position.set(-1.6, 1.7, -1.6);
scene.add(rimLight);
const fillLight = new THREE.DirectionalLight(0xffffff, .5);
fillLight.position.set(0, .6, 3);
scene.add(fillLight);

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

function fitCamera(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const fovR = (camera.fov * Math.PI) / 180;

  const fill = 0.80;                                  // 角色占画面高度比例
  const visibleH = size.y / fill;
  const dist = visibleH / 2 / Math.tan(fovR / 2);
  // 把角色压到画面下半部：底部留 2%，上方留出气泡位
  const shift = Math.max(0, 0.98 - fill / 2 - 0.5) * visibleH;
  const aimY = center.y + shift;

  camera.position.set(0, aimY, dist);
  camera.lookAt(0, aimY, 0);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  fitInfo = { dist, centerY: aimY, visibleH, modelH: size.y };
}

function onResize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (vrm) fitCamera(vrm.scene);
}
addEventListener('resize', onResize);

/* ═══════════ 动作 ═══════════ */
function rebuildClips() {
  clips.clear();
  for (const [id, anim] of rawAnims) {
    try {
      clips.set(id, createVRMAnimationClip(anim, vrm));
    } catch (e) {
      console.warn('retarget 失败', id, e);
    }
  }
}

function playMotion(key, { loop = false, fade = FADE } = {}) {
  const clip = clips.get(key);
  if (!clip || !mixer) return;
  const next = mixer.clipAction(clip);
  next.enabled = true;
  next.setEffectiveTimeScale(1);
  next.setEffectiveWeight(1);
  next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
  next.clampWhenFinished = !loop;

  if (next === currentAction) {
    if (!loop) next.reset().play();
    currentMotion = key;
    return;
  }
  if (currentAction) {
    next.reset();
    next.play();
    next.crossFadeFrom(currentAction, fade, false);
  } else {
    next.reset().play();
  }
  currentAction = next;
  currentMotion = key;
}

function playOneShot(key, fade = 0.2) {
  if (!clips.has(key)) return;
  playMotion(key, { loop: false, fade });
}

function toIdle(fade = 0.32) {
  playMotion(IDLE, { loop: true, fade });
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

function ensureAudio() {
  if (audioCtx) return audioCtx;
  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.55;
  analyser.connect(audioCtx.destination);
  analyserData = new Uint8Array(analyser.fftSize);
  return audioCtx;
}

async function playWav(u8) {
  const ctx = ensureAudio();
  if (ctx.state === 'suspended') await ctx.resume();
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  let buf;
  try {
    buf = await ctx.decodeAudioData(ab);
  } catch (e) {
    console.warn('decode 失败', e);
    pet.audioDone();
    return;
  }
  stopAudio(true);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(analyser);
  src.onended = () => {
    if (currentSource === src) {
      currentSource = null;
      talkLevel = 0;
      pet.audioDone();
    }
  };
  currentSource = src;
  src.start();
}

function stopAudio(keepQuiet) {
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch {}
    currentSource = null;
  }
  talkLevel = 0;
  if (!keepQuiet) pet.audioDone();
}

/* ═══════════ 加载 ═══════════ */
function loadMotions() {
  return Promise.all(MOTION_FILES.map((k) => new Promise((res) => {
    animLoader.load(`./assets/motions/${k}.vrma`, (g) => {
      const a = g.userData.vrmAnimations && g.userData.vrmAnimations[0];
      if (a) rawAnims.set(k, a);
      res();
    }, undefined, () => res());
  })));
}

function loadAvatar(key) {
  if (loading) return;
  loading = true;
  avatarKey = key;
  const info = AVATARS[key] || AVATARS.D;
  const ld = document.getElementById('hint');

  vrmLoader.load(`./assets/models/${info.file}`, (gltf) => {
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
    if (!vrm) { loading = false; return; }
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
    scene.add(vrm.scene);

    fitCamera(vrm.scene);

    mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.addEventListener('finished', () => {
      toIdle(0.35);
    });

    rebuildClips();
    toIdle(0.001);
    loading = false;
    pet.config({ avatar: key });
    if (ld) ld.classList.add('hidden');
  }, undefined, (e) => {
    console.error('模型加载失败', e);
    loading = false;
  });
}

/* ═══════════ 命中测试（决定窗口哪块能点） ═══════════ */
const hitBones = ['head', 'neck', 'hips', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftUpperArm', 'rightUpperArm'];
const _v = new THREE.Vector3();
function characterRect() {
  if (!vrm || !vrm.humanoid) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
  for (const b of hitBones) {
    const node = vrm.humanoid.getRawBoneNode(b) || vrm.humanoid.getNormalizedBoneNode(b);
    if (!node) continue;
    node.getWorldPosition(_v);
    _v.project(camera);
    if (!isFinite(_v.x) || !isFinite(_v.y)) continue;
    const x = (_v.x * 0.5 + 0.5) * innerWidth;
    const y = (-_v.y * 0.5 + 0.5) * innerHeight;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    n++;
  }
  if (!n) return null;
  const pad = 16;
  return { x0: minX - pad, x1: maxX + pad, y0: minY - pad, y1: maxY + pad };
}

let lastHit = null;
let interactiveState = false;
function updateHit(e) {
  const overUi = !!(e.target && e.target.closest &&
    e.target.closest('#dock, #bubble, #settings, #fab, #rec, #activity, button, input, textarea'));
  let inside = overUi;
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
let downAt = null;

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragMoved = false;
  downAt = { x: e.screenX, y: e.screenY };
});
addEventListener('mousemove', (e) => {
  if (dragging) {
    const dx = e.screenX - downAt.x;
    const dy = e.screenY - downAt.y;
    if (!dragMoved && Math.hypot(dx, dy) > 4) {
      dragMoved = true;
      pet.drag('start');
      document.body.style.cursor = 'grabbing';
    }
  }
  // 眼球跟随
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -((e.clientY / innerHeight) * 2 - 1);
  updateHit(e);
});
addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    if (dragMoved) pet.drag('end');
    else onPetClick();
    dragMoved = false;
    document.body.style.cursor = 'default';
  }
});
stage.addEventListener('mouseleave', () => {
  if (interactiveState) { interactiveState = false; pet.hit(false); }
});

/* ═══════════ 气泡 ═══════════ */
let bubbleTimer = null;

function showBubble(text, holdMs) {
  const b = document.getElementById('bubble');
  const t = document.getElementById('bubbleText');
  if (!text) return;
  t.textContent = text;
  b.classList.remove('hidden');
  // 重播入场动画
  b.style.animation = 'none';
  void b.offsetWidth;
  b.style.animation = '';
  if (bubbleTimer) clearTimeout(bubbleTimer);
  const ms = holdMs || Math.max(2600, Math.min(12000, text.length * 260));
  bubbleTimer = setTimeout(hideBubble, ms);
}

function hideBubble() {
  document.getElementById('bubble').classList.add('hidden');
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
}

/* ═══════════ 交互区 ═══════════ */
const dock = document.getElementById('dock');
const dockText = document.getElementById('dockText');
const input = document.getElementById('input');
const hint = document.getElementById('hint');
const fab = document.getElementById('fab');
const recEl = document.getElementById('rec');
const activity = document.getElementById('activity');

/* 底部胶囊三种形态：
 *   mini       —— 一颗小胶囊：麦克风 + （在听时的跳动条）+（刚听到的那句话）
 *   open       —— 展开成输入框，左端仍是最初那颗麦克风
 * 同一个元素承担全部状态，所以"在听"永远不会压在输入框上。
 */
let dockMode = 'mini';
let listening = false;        // 耳朵开着（常驻聆听）
let shownHeard = '';          // 胶囊里此刻显示的"你说 · …"
let shownState = '';          // '' | 'ok' | 'skip'
let liveText = '';            // 主人正说到一半的字（实时字幕）
let aecOn = false;            // 系统回声消除可用 → 她说话时也能听
let pendingHeard = '';        // 刚听到、还没被主人用过的一句 —— 留着填进输入框
let pendingAt = 0;
let heardTimer = null;

function paintDock() {
  dock.classList.toggle('ear', listening);
  dock.classList.toggle('hasText', !!(shownHeard || liveText));
  dock.classList.toggle('skip', shownState === 'skip');
  dock.classList.toggle('live', !shownHeard && !!liveText);
  dockText.textContent = shownHeard
    ? `你说 · ${shownHeard}${shownState === 'ok' ? ' ✓' : shownState === 'skip' ? ' 略过' : ''}`
    : liveText || '';
}

/** 实时字幕：主人还在说，字先滚出来 —— 让他确信自己被听见了 */
function paintLive(text) {
  liveText = String(text || '').slice(0, 64);
  paintDock();
}

function openDock() {
  hideBubble();
  dockMode = 'open';
  dock.classList.remove('mini');
  dock.classList.add('open');
  hint.classList.add('hidden');
  // 刚才听到、还没发出去的话带进输入框，主人可以改一改再发
  if (pendingHeard && Date.now() - pendingAt < 45000 && !input.value.trim()) {
    input.value = pendingHeard;
    pendingHeard = '';
  }
  setTimeout(() => input.focus({ preventScroll: true }), 60);
}

function closeDock() {
  if (document.activeElement === input) input.blur();
  dockMode = 'mini';
  dock.classList.remove('open');
  dock.classList.add('mini');
  paintDock();
}

function onPetClick() {
  hideBubble();
  if (dockMode === 'open') closeDock();
  else openDock();
}

async function sendText() {
  const v = input.value.trim();
  if (!v) return;
  input.value = '';
  pendingHeard = '';
  shownHeard = '';
  paintDock();
  showBubble(v, 3200);
  await pet.say(v);
}

document.getElementById('sendBtn').addEventListener('click', sendText);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendText(); }
  if (e.key === 'Escape') closeDock();
});

/* 点她一下 = 打断她。
 * 为什么需要这个：她说话时是闭麦的（没有可用的系统回声消除），所以"主人开口"
 * 她根本听不见 —— 语音打断在物理上不可能。点一下是最直觉、最可靠的替代。 */
const stageEl = document.getElementById('stage');
stageEl.addEventListener('pointerdown', () => {
  if (!speakingNow) return;
  pet.stopSpeak();
  stopAudio(true);
  speakingNow = false;
  thinkingNow = false;
  toIdle(0.26);
}, { passive: true });

/* 麦克风按钮：单击 = 折叠/展开输入框；长按 = 开关耳朵 */
const micBtnEl = document.getElementById('micBtn');
let micHoldTimer = null;
let micLongFired = false;
micBtnEl.addEventListener('pointerdown', () => {
  micLongFired = false;
  clearTimeout(micHoldTimer);
  micHoldTimer = setTimeout(() => { micLongFired = true; pet.listen('toggle'); }, 520);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
  micBtnEl.addEventListener(ev, () => clearTimeout(micHoldTimer));
}
micBtnEl.addEventListener('click', () => {
  clearTimeout(micHoldTimer);
  if (micLongFired) { micLongFired = false; return; }
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
  const on = cfg && cfg.voice.enabled;
  btn.classList.toggle('muted', !on);
  wave.style.display = on ? '' : 'none';
}

/* ═══════════ 录制 ═══════════ */
function startRecordUI() {
  recording = true;
  recEl.classList.remove('hidden');
  document.getElementById('recText').textContent = '在听…';
  document.getElementById('micBtn').classList.add('rec');
  stopAudio();
  hideBubble();
}
function stopRecordUI() {
  recording = false;
  recEl.classList.add('hidden');
  document.getElementById('micBtn').classList.remove('rec');
  recEl.style.setProperty('--lvl', 0.2);
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSettings(); closeDock(); }
});

/* ═══════════ 常驻聆听 ═══════════ */
function paintListen() {
  paintDock();
  const btn = document.getElementById('listenBtn');
  if (btn) btn.classList.toggle('on', listening);
}

/** 听到一句话：同一颗胶囊就地变成文字条，主人一眼能确认有没有被听清 */
function paintHeard(text, replied) {
  if (!text) return;
  liveText = '';
  shownHeard = String(text).slice(0, 60);
  shownState = replied === true ? 'ok' : replied === false ? 'skip' : '';
  pendingHeard = shownHeard;      // 留着，主人点开输入框时能填进去改
  pendingAt = Date.now();
  paintDock();
  if (heardTimer) clearTimeout(heardTimer);
  // 只是把文字条收起来，不丢 pendingHeard
  heardTimer = setTimeout(() => {
    shownHeard = '';
    shownState = '';
    paintDock();
  }, replied === false ? 2400 : 4200);
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
    if (ok) { tip.textContent = '都通了。按 ⌘⇧Space 或点麦克风就开始说话。'; }
    else if (pending) { tip.textContent = '系统弹窗正在等你点「允许」。点完这里会自动变绿。'; }
    else { tip.textContent = '第一次要允许两项：语音识别 + 麦克风。允许后如果还是灰的，把开关关掉再打开一次。'; }
    tip.classList.toggle('hidden', false);
  }
  const micBtn = document.getElementById('micBtn');
  if (micBtn) micBtn.classList.toggle('warn', !(speech === 3 && micOk));
}

document.getElementById('permCheck')?.addEventListener('click', async () => {
  const tip = document.getElementById('permTip');
  if (tip) { tip.textContent = '正在请求权限…系统弹窗请点允许'; }
  const st = await pet.asrStatus({ request: true });
  paintPerm(st);
});
document.getElementById('permOpenSpeech')?.addEventListener('click', () => pet.openPrivacy('speech'));
document.getElementById('permOpenMic')?.addEventListener('click', () => pet.openPrivacy('mic'));

/* ═══════════ 设置面板 ═══════════ */
const settings = document.getElementById('settings');

function openSettings() {
  const c = cfg;
  document.getElementById('setName').value = c.buddy.name || '';
  document.getElementById('setUrl').value = c.llm.baseURL || '';
  document.getElementById('setModel').value = c.llm.model || '';
  document.getElementById('setKey').value = c.llm.apiKey ? '••••••••' : '';
  document.getElementById('setTtsOn').checked = !!c.tts.enabled;
  document.getElementById('setTtsUrl').value = c.tts.baseURL || '';
  document.getElementById('setTtsKey').value = c.tts.apiKey ? '••••••••' : '';
  document.getElementById('setTtsInstr').value = c.tts.instructions || '';
  document.getElementById('setOnDone').checked = !!c.monitor.speakOnDone;
  document.getElementById('setOnLong').checked = c.monitor.speakOnLong !== false;
  document.getElementById('setOnStall').checked = c.monitor.speakOnStall !== false;
  document.getElementById('setOnRest').checked = c.monitor.speakOnRest !== false;
  document.getElementById('setGap').value = Math.round((c.monitor.minGapMs || 40000) / 1000);
  document.getElementById('probeOut').classList.add('hidden');
  paintPerm();
  settings.classList.remove('hidden');
  pet.hit(true);
  interactiveState = true;
}
function closeSettings() {
  settings.classList.add('hidden');
}

document.getElementById('closeSettings').addEventListener('click', closeSettings);

document.getElementById('saveBtn').addEventListener('click', async () => {
  const keyEl = document.getElementById('setKey');
  const ttsKeyEl = document.getElementById('setTtsKey');
  const patch = {
    buddy: { name: document.getElementById('setName').value.trim() || 'baby' },
    llm: {
      baseURL: document.getElementById('setUrl').value.trim(),
      model: document.getElementById('setModel').value.trim(),
    },
    tts: {
      enabled: document.getElementById('setTtsOn').checked,
      baseURL: document.getElementById('setTtsUrl').value.trim(),
      instructions: document.getElementById('setTtsInstr').value.trim(),
    },
    monitor: {
      speakOnDone: document.getElementById('setOnDone').checked,
      speakOnLong: document.getElementById('setOnLong').checked,
      speakOnStall: document.getElementById('setOnStall').checked,
      speakOnRest: document.getElementById('setOnRest').checked,
      minGapMs: Math.max(10, Number(document.getElementById('setGap').value) || 40) * 1000,
    },
  };
  if (keyEl.value && !keyEl.value.includes('•')) patch.llm.apiKey = keyEl.value.trim();
  if (ttsKeyEl.value && !ttsKeyEl.value.includes('•')) patch.tts.apiKey = ttsKeyEl.value.trim();
  cfg = await pet.config(patch);
  showBubble('记下了。', 1800);
  closeSettings();
});

document.getElementById('probeBtn').addEventListener('click', async () => {
  const out = document.getElementById('probeOut');
  out.classList.remove('hidden');
  out.textContent = '自检中…';
  const r = await pet.probe();
  const lines = [];
  lines.push(`模型  ${r.llm.ok ? '✓' : '✗'}  ${r.llm.ms}ms  ${r.llm.ok ? r.llm.text : r.llm.error}`);
  lines.push(`语音  ${r.tts.ok ? '✓' : '✗'}  ${r.tts.ms}ms  ${r.tts.ok ? Math.round(r.tts.bytes / 1024) + 'KB' : r.tts.error}`);
  lines.push(`识别  ${r.asr.ok ? '✓ 已就绪' : '✗ 缺少 bin/asr'}`);
  lines.push(`监控  ${r.monitor.file ? '✓ ' + (r.monitor.snap?.title || r.monitor.snap?.sessionId || '') : '✗ 没找到会话'}`);
  out.textContent = lines.join('\n');
});

/* ═══════════ 主循环 ═══════════ */
let ambientTimer = 22 + Math.random() * 16;
let nodeCount = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = performance.now() / 1000;

  if (vrm) {
    if (mixer) mixer.update(dt);

    // 眨眼
    blinkTimer -= dt;
    if (blinkTimer <= 0) {
      setExpr('blink', 1);
      setTimeout(() => setExpr('blink', 0), 105);
      blinkTimer = 2.2 + Math.random() * 3.6;
    }

    // 口型：直接从播放中的波形取能量，真实对嘴
    if (analyser && currentSource) {
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

    // 视线：跟鼠标，但说话时看向主人
    pointerSmooth.lerp(pointer, Math.min(1, dt * 5.5));
    const lx = pointerSmooth.x * 1.15;
    const ly = 1.32 + pointerSmooth.y * 0.5 + (speakingNow ? -0.05 : 0);
    lookTarget.position.set(lx, ly, 1.05);

    vrm.update(dt);

    // 命中框（每帧算，随动作变化）
    lastHit = characterRect();

    // 气泡贴着头顶走，而不是钉死在窗口顶上
    const head = vrm.humanoid && (vrm.humanoid.getRawBoneNode('head') || vrm.humanoid.getNormalizedBoneNode('head'));
    if (head) {
      head.getWorldPosition(_v);
      _v.y += fitInfo.modelH * 0.115;      // 头顶（含发梢）在 head 骨骼上方约 11.5% 身高处
      _v.project(camera);
      const topY = (-_v.y * 0.5 + 0.5) * innerHeight;
      const bubble = document.getElementById('bubble');
      if (!bubble.classList.contains('hidden')) {
        const h = bubble.offsetHeight || 44;
        const bottom = Math.min(innerHeight - 8, Math.max(h + 14, innerHeight - topY + 12));
        bubble.style.top = 'auto';
        bubble.style.bottom = bottom + 'px';
      }
    }

    // 空闲自娱自乐：没在说话、没在录、没开输入框、没在思考，就隔一会儿动一动
    if (!speakingNow && !thinkingNow && !recording && dockMode !== 'open' && !emoActive()) {
      ambientTimer -= dt;
      if (ambientTimer <= 0) {
        const pool = ['LookAround', 'Relax', 'Sleepy', 'Clapping'];
        playOneShot(pool[Math.floor(Math.random() * pool.length)], 0.45);
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
        if (ev.role === 'user') showBubble(ev.text, 3000);
        else if (ev.role === 'assistant') showBubble(ev.text, 9000);
        break;
      case 'delta':
        break;
      case 'motion':
        if (ev.key) playOneShot(ev.key, 0.18);
        break;
      case 'emo':
        if (ev.key) applyEmo(ev.key, 1, 2800);
        break;
      case 'think':
        // 说完到出声之间有 1~2 秒空档。这段时间她必须"在动"，否则就是死机脸。
        thinkingNow = !!ev.on;
        if (thinkingNow) {
          ambientTimer = 30;
          if (!speakingNow && clips.has('Thinking')) playMotion('Thinking', { loop: true, fade: 0.22 });
          else if (!speakingNow) playOneShot('LookAround', 0.3);
        } else if (!speakingNow) {
          toIdle(0.42);
        }
        break;
      case 'speaking':
        speakingNow = !!ev.on;
        if (ev.on) {
          ambientTimer = 30;
          // 说话时身体回中性站姿：不要在"抱臂思考"这种姿势里讲话
          if (currentMotion !== IDLE) toIdle(0.45);
        }
        break;
      case 'audio':
        if (ev.stop) { stopAudio(true); break; }
        if (ev.buffer) playWav(ev.buffer);
        break;
      case 'phase':
        phase = ev.phase || 'idle';
        if (phase === 'work') {
          // 主人在干活时别再抱臂皱眉（太严肃），改成好奇地张望一下
          const now = performance.now();
          if (!speakingNow && now - lastWorkPoseAt > 14000) {
            lastWorkPoseAt = now;
            playOneShot('LookAround', 0.5);
          }
        } else if (phase === 'idle') {
          if (!speakingNow) toIdle(0.6);
        }
        break;
      case 'monitor':
        paintActivity(ev);
        break;
      case 'toast':
        paintActivityText(ev.text);
        break;
      case 'avatar':
        if (ev.key && ev.key !== avatarKey) loadAvatar(ev.key);
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
        // 常驻监听时，胶囊里的跳动条要跟着真实音量动 ——
        // 这是"它在听我说话"最直接的证据，比任何文案都管用。
        dock.style.setProperty('--lvl', Math.min(1, ev.v * 1.9).toFixed(3));
        dock.classList.toggle('loud', ev.v > 0.22);
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
let lastActivityAt = 0;

/** 状态条只说"在做什么/做完了没"，绝不显示命令、路径、工具名 */
function paintActivity(snap) {
  lastWorkSnap = snap;
  lastActivityAt = Date.now();
  if (!snap || !snap.sessionId || !snap.task) { activity.classList.add('hidden'); return; }
  const t = snap.task;
  let txt = null;
  if (t.status === 'running') {
    const mins = Math.floor(t.durationMs / 60000);
    txt = `在干活 · ${t.name}${mins >= 1 ? `（${mins} 分）` : ''}`;
  } else if (t.status === 'failed') {
    txt = `这次没成 · ${t.name}`;
  } else if (t.status === 'ok') {
    txt = `做完了 · ${t.name}`;
  }
  if (!txt) { activity.classList.add('hidden'); return; }
  document.getElementById('activityText').textContent = txt;
  activity.classList.remove('hidden');
}
function paintActivityText(txt) {
  if (!txt) return;
  document.getElementById('activityText').textContent = txt;
  activity.classList.remove('hidden');
  if (activityHideTimer) clearTimeout(activityHideTimer);
  activityHideTimer = setTimeout(() => {
    activity.classList.add('hidden');
  }, 5200);
}
// 任务在跑时，耗时得自己往上爬（监控只在有事件时才推）
setInterval(() => {
  if (lastWorkSnap && lastWorkSnap.task && lastWorkSnap.task.status === 'running') paintActivity(lastWorkSnap);
}, 15000);

/* ═══════════ 启动 ═══════════ */
(async function boot() {
  cfg = (await pet.init()).config;
  paintMute();
  wire();
  renderer.setAnimationLoop(frame);
  await loadMotions();
  loadAvatar(cfg.avatar || 'D');
  fab.classList.remove('hidden');
  setTimeout(() => fab.classList.add('show'), 300);
  // 耳朵状态：配置里开着就先点亮，真实状态等主进程回报
  listening = !!(cfg.voice && cfg.voice.alwaysListen);
  paintListen();
  setTimeout(async () => {
    try { paintPerm(await pet.asrStatus()); } catch {}
  }, 1500);
})();

window.__pet = () => ({
  vrm: !!vrm, mixer: !!mixer, clips: clips.size, currentMotion, phase, speakingNow,
  talkLevel: +talkLevel.toFixed(3), recording, avatarKey,
  audio: !!currentSource, emo: emoTimer > 0,
  hit: lastHit, dockOpen: dockMode === 'open',
  asr: asrStat, listening,
});
window.__play = (k) => { playOneShot(k, 0.18); return k; };
window.__avatar = (k) => { loadAvatar(k); return k; };
// 自检钩子：直接驱动底部胶囊的三种形态
window.__dock = (m) => {
  if (m === 'open') openDock();
  else if (m === 'close') closeDock();
  return { mode: dockMode, listening, text: shownHeard };
};
window.__heard = (text, replied) => { paintHeard(text, replied); return shownHeard; };
window.__listen = (on) => { listening = !!on; paintDock(); return listening; };
