'use strict';
/**
 * workbunny 主进程
 * ─ 透明置顶浮窗（可穿透、可拖拽、跨桌面空间）
 * ─ 大脑：OpenAI 兼容流式 LLM（默认复用 WorkBuddy 自己的模型额度）
 * ─ 嗓子：A1X 掌机 Qwen3-TTS
 * ─ 耳朵：原生 SFSpeechRecognizer 子进程
 * ─ 眼睛：直接 tail WorkBuddy 会话日志
 */
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage,
  shell, dialog, globalShortcut, Notification, systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// 最早的一行探针：写到 /tmp，用来看「进程到底有没有跑到 JS」
try {
  fs.appendFileSync('/tmp/buddy-boot.log',
    `${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))}
`);
} catch {}

const config = require('./config');
const llm = require('./llm');
const tts = require('./tts');
const { createTTSSession } = require('./tts-session');
const voiceFiles = require('./qwen-voices');
const replyPolicy = require('./reply-policy');
const { Monitor, taskName } = require('./monitor');
const { Asr, probeAccess } = require('./asr');
const avatars = require('./avatars');

/* ── 数据目录（开发时可被 BUDDY_PET_HOME 指到工作区） ── */
app.setName('workbunny');
if (process.env.BUDDY_PET_NO_SANDBOX === '1') {
  // 某些沙箱环境里 Chromium 自己的 sandbox 起不来，开了才能渲染
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
if (process.env.BUDDY_PET_HOME) {
  try { app.setPath('userData', process.env.BUDDY_PET_HOME); } catch (e) { console.error(e); }
}
const USER_DIR = app.getPath('userData');
fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(USER_DIR, 0o700);
config.setPath(path.join(USER_DIR, 'config.json'));

const IS_DEV = !app.isPackaged;
const BOOT_AT = Date.now();          // 启动时刻：此前的历史事件不触发主动说话
const ASR_BIN = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'asr')
  : path.join(__dirname, '..', '..', 'bin', 'asr');

let win = null;
let tray = null;
let monitor = null;
let asr = null;
let quitting = false;
let rendererGoneAt = 0;
let selfHealTimer = null;
let asrStatus = { speech: null, mic: null, checkedAt: 0, note: '' };

/* ── 顶层崩溃捕获：桌宠没有终端，崩了必须留下痕迹 ──
 * 注意：这里故意不退出 —— 桌宠崩掉比带病活着更糟，能继续跑就继续跑。 */
process.on('uncaughtException', (e) => {
  try { log('[crash] uncaught: ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : String(e))); } catch {}
});
process.on('unhandledRejection', (e) => {
  try { log('[crash] rejection: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e))); } catch {}
});
/* 死因取证：桌宠"莫名其妙就没了"必须有据可查。这三条把退出码、
 * 子进程暴毙、渲染进程异常都记进 buddy.log，下次再出问题一眼看到。 */
process.on('exit', (code) => {
  try { log(`[exit] code=${code} uptime=${Math.round(process.uptime())}s`); } catch {}
});
process.on('SIGTERM', () => {
  try { log('[exit] 收到 SIGTERM（被要求退出）'); } catch {}
  markCleanExit();
  app.quit();
});

/* ── 文件日志（桌宠没有终端，出问题只能看这个） ── */
const LOG_PATH = path.join(USER_DIR, 'buddy.log');
function log(...args) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ` + args.map((a) =>
    typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
  ).join(' ');
  // 只留最近 400 行，防止日志无限长
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    let prev = '';
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > 256 * 1024) {
        const all = fs.readFileSync(LOG_PATH, 'utf8').split('\n');
        prev = all.slice(-400).join('\n') + '\n';
      } else {
        prev = fs.readFileSync(LOG_PATH, 'utf8');
      }
    } catch { prev = ''; }
    fs.writeFileSync(LOG_PATH, prev + line + '\n');
  } catch {}
  if (process.stdout && process.stdout.writable) { try { process.stdout.write(line + '\n'); } catch {} }
}

log(`[boot] pid=${process.pid} packaged=${app.isPackaged} userData=${USER_DIR}`);

/* ── 看门狗 ──────────────────────────────────────────────────────────
 * 主进程崩掉（段错误、ObjC 异常、被 -9）时，进程内任何 JS 都来不及执行，
 * 只能靠一个**进程外**的东西把它拉回来。这里在开机时 spawn 一个脱离进程组
 * 的 sh 影子，它每 2 秒确认一次"父进程还在吗"。
 * 退出时靠 .clean-exit 标记区分「正常退出」和「崩了」，避免主人点了退出它又爬回来。 */
/** 主动退出前留个记号，告诉看门狗「别把我拉回来」 */
function markCleanExit() {
  try { fs.writeFileSync(path.join(USER_DIR, '.clean-exit'), String(Date.now())); } catch {}
}

/** 看门狗还活着吗？没了就补一个（心跳里每 20 秒问一次） */
function ensureWatchdog() {
  if (!app.isPackaged) return;
  try {
    const pidFile = path.join(USER_DIR, 'watchdog.pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid) {
      try { process.kill(pid, 0); return; } catch {}   // 还活着
    }
    log('[watchdog] 看门狗不见了，重新布防');
    startWatchdog();
  } catch {
    startWatchdog();
  }
}

function startWatchdog() {  if (!app.isPackaged) return;
  try {
    const stop = path.join(USER_DIR, '.no-restart');
    if (fs.existsSync(stop)) { log('[watchdog] 有 .no-restart，不启动看门狗'); return; }
    // 新实例起来 = 之前无论怎么退的，都翻篇
    try { fs.unlinkSync(path.join(USER_DIR, '.clean-exit')); } catch {}

    const script = path.join(__dirname, 'watchdog.sh');
    if (!fs.existsSync(script)) { log('[watchdog] 缺少 watchdog.sh，跳过'); return; }
    const bundle = path.resolve(app.getAppPath(), '../../..');
    // 先收掉上一任看门狗，避免越积越多
    try {
      const pidFile = path.join(USER_DIR, 'watchdog.pid');
      const old = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (old && old !== process.pid) { try { process.kill(old, 'SIGTERM'); } catch {} }
    } catch {}

    const p = spawn('/bin/sh', [script, String(process.pid), bundle, USER_DIR], {
      detached: true,
      stdio: 'ignore',
    });
    p.unref();
    try { fs.writeFileSync(path.join(USER_DIR, 'watchdog.pid'), String(p.pid)); } catch {}
    log(`[watchdog] 已布防 pid=${p.pid}`);
  } catch (e) {
    log('[watchdog] 启动失败：' + e.message);
  }
}


/* ── 会话记忆（让娃娃记得刚才聊了什么） ── */
const MEM_PATH = path.join(USER_DIR, 'memory.json');
let history = [];
try { history = JSON.parse(fs.readFileSync(MEM_PATH, 'utf8')).history || []; } catch { history = []; }

function saveHistory() {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(MEM_PATH, JSON.stringify({ history: history.slice(-24) }, null, 2));
  } catch {}
}

function pushHistory(role, content) {
  if (!content) return;
  history.push({ role, content: String(content).slice(0, 800) });
  if (history.length > 24) history = history.slice(-24);
  saveHistory();
}

/* ── 窗口 ── */
function defaultPos(w, h) {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  return {
    x: Math.round(wa.x + wa.width - w - 28),
    y: Math.round(wa.y + wa.height - h - 8),
  };
}

/* ── 角色大小 ────────────────────────────────────────────────
 * 三档：100% 半身 / 100% 全身 / 150% 放大。半身沿用内部值 0.5，
 * 窗口的 w/h 永远是 100% 的基准，
 * 只是「放大时」把窗口按倍数撑开（她在屏幕上也真的变大了）；
 * 缩小时窗口一点不动 —— 只是她自己在窗口中变小，绝不能把窗口缩到 UI 挤成一团。
 * 切换时以窗口底部中心为锚点。 */
const SCALES = [0.5, 1, 1.5];
const SCALE_LABELS = { 0.5: '100% 半身', 1: '100% 全身', 1.5: '150% 放大' };
function clampScale(v) {
  const n = Number(v);
  if (!isFinite(n)) return 1;
  return SCALES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), 1);
}
const winFactor = (k) => Math.max(1, clampScale(k));

function windowSizeFor(k) {
  const c = config.load();
  const f = winFactor(k);
  return { w: Math.round(c.window.w * f * 1.4), h: Math.round(c.window.h * f) };
}

function applyWindowScale(k) {
  if (!win || win.isDestroyed()) return null;
  const { w, h } = windowSizeFor(k);
  const b = win.getBounds();
  const cx = b.x + b.width / 2;
  const bottom = b.y + b.height;
  const wa = screen.getDisplayNearestPoint({ x: Math.round(cx), y: bottom - 1 }).workArea;
  const nw = Math.min(w, wa.width - 8);
  // macOS 不允许窗口顶边越过菜单栏；空间不足时限制高度，避免系统把底部锚点推走。
  const nh = Math.min(h, wa.height - 8, Math.max(1, bottom - wa.y));
  const nx = Math.round(cx - nw / 2);
  const ny = bottom - nh;
  win.setBounds({ x: nx, y: ny, width: nw, height: nh });
  win.setPosition(nx, ny, false);
  log(`[window] 角色 ${SCALE_LABELS[clampScale(k)]}（窗口 ${nw}×${nh}）`);
  return { x: nx, y: ny, w: nw, h: nh };
}

function createWindow() {
  let c = config.load();
  if (c.window.canvasWidthVersion !== 1) {
    const x = typeof c.window.x === 'number' ? Math.round(c.window.x - c.window.w * winFactor(c.window.scale) * .2) : null;
    c = config.save({ window: { x, canvasWidthVersion: 1 } });
  }
  const size = windowSizeFor(c.window.scale);
  const w = size.w;
  const h = size.h;
  let { x, y } = c.window;
  const disp = screen.getPrimaryDisplay().workArea;
  if (typeof x !== 'number' || typeof y !== 'number' ||
      x < disp.x - 50 || x > disp.x + disp.width - 80 ||
      y < disp.y - 50 || y > disp.y + disp.height - 80) {
    const p = defaultPos(w, h);
    x = p.x; y = p.y;
  }

  win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // 关键：桌宠永远在后台，不能被降帧
      webgl: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 渲染层日志接到主进程（打包版只记 warn/error，dev 全记）
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['log', 'warn', 'error', 'debug'][level] || 'log';
    const msg = String(message);
    if (msg.includes('DevTools')) return;
    // three-vrm 对每个没写 specVersion 的 VRMA 都会喊一句。素材是第三方导的，
    // 改不动；让它在日志里刷 92 遍只会把真正的报错埋掉。
    if (msg.includes('specVersion of the VRMA')) return;
    if (!IS_DEV && level < 2) return;
    log(`[renderer:${tag}] ${msg}  (${String(sourceId || '').split('/').pop()}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('[renderer] did-fail-load ' + [code, desc, url].join(' '));
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log('[renderer] gone ' + JSON.stringify(d) + ' —— 自动重建窗口');
    // 渲染进程没了，画面就空白一片。别让主人盯着一个死画面，重建一个。
    rendererGoneAt = Date.now();
    setTimeout(() => {
      if (!win || win.isDestroyed()) { createWindow(); return; }
      // 窗口对象还在但画布已经死了：重新加载最省事
      try { win.webContents.reload(); } catch { createWindow(); }
    }, 600);
  });
  win.webContents.on('unresponsive', () => {
    log('[renderer] 卡住了，3 秒后若还没缓过来就重载');
    setTimeout(() => {
      try { if (win && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer(); } catch {}
    }, 3000);
  });

  win.once('ready-to-show', () => {
    win.showInactive();
    // macOS 会在首次显示时把加宽窗口挪回工作区；恢复锚点，UI 才不会跟着位移。
    win.setPosition(x, y, false);
    scheduleSelfTest();
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('moved', () => {
    if (!win) return;
    const [px, py] = win.getPosition();
    config.save({ window: { x: px, y: py } });
  });
}

/* ── 独立窗口：设置 / 动作列表 ──
 * 这两个以前是角色窗口里的抽屉和侧栏。问题是：设置表单一铺开就把她的脸挡掉一半，
 * 92 条动作列表更是把画面挤成一条缝。它们本来就不是"表演的一部分"，
 * 所以给它们各自一个正经窗口 —— 娃娃在自己的窗口里照常站着，主人在这边慢慢挑。
 *
 * 同一个窗口只开一个：再点一次就把它提到前台，不叠出一排一样的窗。 */
const panels = new Map();
const PANEL_SIZE = {
  settings: { w: 420, h: 760, title: 'workbunny · 设置' },
  motions: { w: 340, h: 660, title: 'workbunny · 动作库' },
};

function openPanel(kind) {
  const spec = PANEL_SIZE[kind] || PANEL_SIZE.settings;
  const old = panels.get(kind);
  if (old && !old.isDestroyed()) {
    if (old.isMinimized()) old.restore();
    old.focus();
    return old;
  }
  const w = new BrowserWindow({
    width: spec.w,
    height: Math.min(spec.h, screen.getPrimaryDisplay().workAreaSize.height - 48),
    title: spec.title,
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
    resizable: true,
    show: false,
    backgroundColor: '#f7f3ec',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 面板窗口可以被降帧：主人不在这边操作时，别和娃娃抢 CPU
      backgroundThrottling: true,
    },
  });
  w.setMenuBarVisibility(false);
  // 面板的报错也得进日志：新窗口一旦白屏，日志里没字就等于无从查起
  w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['log', 'warn', 'error', 'debug'][level] || 'log';
    const msg = String(message);
    if (msg.includes('DevTools')) return;
    if (!IS_DEV && level < 2) return;
    log(`[panel:${kind}:${tag}] ${msg}  (${String(sourceId || '').split('/').pop()}:${line})`);
  });
  w.webContents.on('did-fail-load', (_e, code, desc) => log(`[panel:${kind}] did-fail-load ${code} ${desc}`));
  w.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'), { query: { p: kind } });
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => panels.delete(kind));
  panels.set(kind, w);
  return w;
}

function closePanels() {
  for (const [, w] of panels) { try { if (!w.isDestroyed()) w.close(); } catch {} }
  panels.clear();
}

/* ── 鼠标穿透开关 ── */
let interactive = false;
function setInteractive(v) {
  if (!win || v === interactive) return;
  interactive = v;
  win.setIgnoreMouseEvents(!v, { forward: true });
}

/* ── 拖拽（用光标屏幕坐标，鼠标移出窗口也不会断） ── */
let dragTimer = null;
let dragAnchor = null;
ipcMain.on('pet:drag', (_e, action) => {
  if (!win) return;
  if (action === 'start') {
    if (dragTimer) clearInterval(dragTimer);
    const cur = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    dragAnchor = { cx: cur.x, cy: cur.y, wx, wy };
    dragTimer = setInterval(() => {
      if (!dragAnchor || !win) return;
      const p = screen.getCursorScreenPoint();
      win.setPosition(dragAnchor.wx + (p.x - dragAnchor.cx), dragAnchor.wy + (p.y - dragAnchor.cy));
    }, 16);
  } else {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    dragAnchor = null;
  }
});

/* ── 事件推给渲染层 ── */
function send(type, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
  try {
    wc.send('pet:ev', { type, ...payload });
  } catch {
    /* 渲染层正在重载时会抛，忽略即可 */
  }
}
function sendConfig(c = config.load()) {
  const payload = { type: 'config', config: config.publicConfig(c) };
  send('config', { config: payload.config });
  for (const panel of panels.values()) {
    try { if (!panel.isDestroyed()) panel.webContents.send('pet:ev', payload); } catch {}
  }
}

/* ── 说话队列（合成 → 播放，逐句流水线，可被打断） ── */
const speechQueue = [];
let speaking = false;
let speechGen = 0;
let speakWatchdog = null;
let recentSpeech = '';    // 最近说过的字，用来识别"这句其实是自己的回声"
let lastSpokeAt = 0;

/** 刚出口的话留个尾巴，用于回声判定 */
function noteSpoken(text) {
  recentSpeech = (recentSpeech + ' ' + text).slice(-140);
  lastSpokeAt = Date.now();
}

/** 这句识别结果是不是我自己刚说过的？用 2-gram 覆盖率判，够糙也够稳 */
function echoLike(text) {
  const clean = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '');
  const a = clean(text);
  const b = clean(recentSpeech);
  if (a.length < 2 || b.length < 2) return false;
  let hit = 0;
  let n = 0;
  for (let i = 0; i < a.length - 1; i++) {
    n++;
    if (b.includes(a.slice(i, i + 2))) hit++;
  }
  return n > 0 && hit / n > 0.72;
}

function stopSpeaking() {
  activeThought?.abort();
  tts.cancel();
  synthCache.clear();
  speechGen++;
  speechQueue.length = 0;
  speaking = false;
  if (speakWatchdog) { clearTimeout(speakWatchdog); speakWatchdog = null; }
  unmuteAsr('stopSpeaking');
  send('audio', { stop: true });
  send('speaking', { on: false });
}

/* ── 闭麦/开麦：只此两个入口，带日志和兜底 ────────────────────────────
 * 踩过的坑：自己说一句话之后，开麦那一步只要有一条路径没走到，麦克风就永久
 * 闭着 —— 表现是"电平日志不走了、主人怎么说话都没反应"，而且没有任何报错。
 * 所以这里强制加一道死线：闭麦超过 MUTE_MAX_MS 一律自动打开。 */
const MUTE_MAX_MS = 20000;
let muteWatchdog = null;
let mutedSince = 0;

function muteAsr(reason) {
  if (!asr) return;
  if (!mutedSince) mutedSince = Date.now();
  asr.mute();
  if (muteWatchdog) clearTimeout(muteWatchdog);
  muteWatchdog = setTimeout(() => {
    log('[asr] 闭麦超时（' + Math.round(MUTE_MAX_MS / 1000) + 's），强制开麦 —— 上次是：' + (reason || ''));
    unmuteAsr('watchdog');
  }, MUTE_MAX_MS);
}

function unmuteAsr(reason) {
  if (mutedSince) {
    log('[asr] 开麦（' + (reason || '') + '，闭了 ' + Math.round((Date.now() - mutedSince) / 1000) + 's）');
    mutedSince = 0;
  }
  if (muteWatchdog) { clearTimeout(muteWatchdog); muteWatchdog = null; }
  if (asr) asr.unmute();
}

/* 情绪 → 音色微调（VoiceDesign 用自然语言描述音色，所以情绪也写成人话） */
const EMO_VOICE = {
  Angry: 'Now a bit annoyed and pouty: shorter phrasing, firmer tone, still cute and young.',
  Sad: 'Now soft and low and slow, slightly downcast, like a small sigh at the end.',
  Surprised: 'Now bright and startled, pitch lifted, speaking quickly with a little gasp.',
  Blush: 'Now shy and soft, slightly breathy, hesitant, a little embarrassed.',
  Clapping: 'Now cheerful and lively, smiling through the words, warm and bouncy.',
  Jump: 'Now excited and energetic, quick and bright.',
  Sleepy: 'Now drowsy and very soft and slow, trailing off lazily.',
  Thinking: 'Now thoughtful, unhurried, with small pauses.',
};

function voiceFor(emo, base) {
  const extra = emo && EMO_VOICE[emo] ? EMO_VOICE[emo] : '';
  return extra ? `${base} ${extra}` : base;
}

/* 合成缓存 + 预取：念第一句的同时把第二句先合成好，句与句之间几乎没有等待 */
const synthCache = new Map();
const SYNTH_CACHE_MAX = 8;
const ttsSession = createTTSSession({
  getConfig: config.load, saveConfig: config.save, synthesize: tts.synthesize,
  onFallback: (c, result) => {
    synthCache.clear();
    tts.shutdown();
    sendConfig(c);
    log(`[tts] 已切换到系统默认语音：${result.reason || '所选引擎不可用'}`);
  },
});
function syncQwenRuntime(c = config.load()) {
  if (c.tts.enabled && c.tts.engine === 'qwen') {
    const q = { ...c.tts.qwen, dir: c.tts.qwen.dir || MODELS_DIR };
    const alreadyReady = tts.runtimeStatus().ready;
    tts.prewarm(q).then(() => {
      if (!alreadyReady && tts.runtimeStatus().ready) log(`[tts] 本地模型已预热并常驻（初始化 ${tts.runtimeStatus().initMs}ms）`);
    }).catch((e) => { if (e.name !== 'AbortError') log('[tts] 本地引擎预热未完成：' + e.message); });
  } else tts.shutdown();
}
function ttsChanged(c = config.load()) {
  tts.cancel(); tts.reset(); ttsSession.changed(); synthCache.clear();
  syncQwenRuntime(c); sendConfig(c);
}

let fallbackLogged = '';
const cfgEngineName = (t) => (t && t.engine === 'qwen' ? '本地大模型' : (t && t.engine === 'remote' ? '局域网 CHP' : '系统语音'));

function synthBuffer(text, emo, options) {
  const key = (emo || '') + '\u0000' + text;
  const hit = synthCache.get(key);
  if (hit) return hit.then((r) => ({ ...r, streamed: false }));
  const c = config.load();
  const ttsCfg = { ...c.tts, instructions: voiceFor(emo, c.tts.instructions) };
  const p = ttsSession.synthesize(text, ttsCfg, options).then((r) => {
    // 每次都说清嗓子是谁 + 用的哪个音色：主人抱怨"声音不对"时，日志能自证到底走的哪条路
    const src = r.engine === 'remote' ? '远程' : (r.engine === 'qwen' ? '本地大模型' : `系统·${r.voice || '默认'}`);
    if (r.ms > 900) log(`[tts] 合成 ${r.ms}ms（${text.length} 字 · ${src}${r.cached ? ' · 缓存' : ''}）`);
    if (r.stats) log(`[tts] CustomVoice/${r.voice} 首片 ${r.stats.firstMs}ms · RTF ${r.stats.rtf.toFixed(2)}${r.streamed ? ' · 流式' : ''}`);
    if (r.degraded && r.reason !== fallbackLogged) {
      fallbackLogged = r.reason || '';
      log(`[tts] ${cfgEngineName(c.tts)} 合成不可用（${fallbackLogged}），退回系统语音 ${r.voice || '默认'}`);
    }
    return r;
  });
  p.catch(() => synthCache.delete(key));   // 失败别把坏结果留在缓存里
  synthCache.set(key, p);
  if (synthCache.size > SYNTH_CACHE_MAX) synthCache.delete(synthCache.keys().next().value);
  return p;
}

let streamSequence = 0;
function streamingPlayback(c, gen, text) {
  const id = `${gen}:${++streamSequence}`;
  let started = false, stopped = false;
  const enabled = c.tts.engine === 'qwen' && c.tts.qwen?.streaming;
  return {
    options: !enabled ? undefined : {
      onChunk: (pcm) => {
        if (gen !== speechGen || stopped) return;
        if (!started) {
          started = true;
          noteSpoken(text || '');
          if (asr && !asr.aec) muteAsr('开始播放');
          send('audio', { stream: { id, start: true } });
        }
        send('audio', { stream: { id, pcm } });
      },
      onStop: () => { stopped = true; if (started) send('audio', { stream: { id, stop: true } }); },
    },
    finish: (r) => {
      if (!r.streamed || !started || stopped || gen !== speechGen) return false;
      send('audio', { stream: { id, end: true } }); return true;
    },
  };
}

function prefetchNext() {
  const c = config.load();
  if (!(c.tts.enabled && c.voice.enabled)) return;
  const next = speechQueue[0];
  if (next) synthBuffer(next.text, next.emo);
}

async function pumpSpeech() {
  if (speaking) return;
  const item = speechQueue.shift();
  if (!item) return;
  speaking = true;
  const gen = speechGen;
  const c = config.load();
  // 合成期间继续识别；缺少 AEC 时只在即将播放音频时闭麦。
  send('speaking', { on: true, text: item.text });

  if (c.tts.enabled && c.voice.enabled) {
    // 注意：不再要求 apiKey —— 远程 TTS 不可用时会自动退回系统语音，
    // 否则"没有密钥"就等于"永远不说话"。
    // 合成阶段也要有看门狗：TTS 服务端不返回时，await 会一直悬着，
    // 闭麦状态就永久锁死（"主人说话没反应"的真实成因，踩过一次）。
    if (speakWatchdog) clearTimeout(speakWatchdog);
    speakWatchdog = setTimeout(() => {
      if (gen === speechGen && speaking) {
        log('[tts] 合成超时，放弃这句');
        finishSpeech();
      }
    }, c.tts.engine === 'qwen' ? 145000 : c.tts.engine === 'remote' ? 90000 : 30000);
    try {
      const playback = streamingPlayback(c, gen, item.text);
      const bufP = synthBuffer(item.text, item.emo, playback.options);
      prefetchNext();           // 和当前这句并行，先把下一句准备出来
      const result = await bufP, buffer = result.buffer;
      // 被打断/换代：不能裸 return —— 那样 speaking 和闭麦都留在原地，麦克风永久哑
      if (gen !== speechGen) return;
      if (!playback.finish(result)) {
        noteSpoken(item.text);
        if (asr && !asr.aec) muteAsr('开始播放');
        send('audio', { buffer, text: item.text });
      }
      // 看门狗：万一渲染层没回 audio-done（窗口崩了/解码失败），别让队列永远卡住
      if (speakWatchdog) clearTimeout(speakWatchdog);
      const durMs = Math.max(1500, ((buffer.length - 44) / (24000 * 2)) * 1000) + 2500;
      speakWatchdog = setTimeout(() => {
        if (gen === speechGen && speaking) finishSpeech();
      }, durMs);
    } catch (e) {
      if (e.name === 'AbortError') { if (gen === speechGen) finishSpeech(); return; }
      // 以前只往 stderr 写，日志里什么都看不到 —— 于是"她不说话"永远查不出原因
      log('[tts] 合成失败：' + e.message);
      console.error('[tts]', e.message);
      send('ttsError', { message: e.message });
      send('speaking', { on: false });
      speaking = false;
      unmuteAsr('合成失败');
      if (speechQueue.length) pumpSpeech();
      return;
    }
  } else {
    // 静音模式：只显示气泡，靠定时收尾
    const ms = Math.max(1200, item.text.length * 180);
    setTimeout(() => {
      if (gen !== speechGen) return;
      finishSpeech();
    }, ms);
    return;
  }
}

function finishSpeech() {
  speaking = false;
  if (speakWatchdog) { clearTimeout(speakWatchdog); speakWatchdog = null; }
  send('speaking', { on: false });
  // 说完再等 450ms 才开麦：尾巴上的混响别当成新的一句
  if (asr) setTimeout(() => { if (!speaking) unmuteAsr('说完'); }, 450);
  if (speechQueue.length) setTimeout(pumpSpeech, 60);
}

function speak(text, { motion, emo, silent = false } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (motion) send('motion', { key: motion, once: true });
  if (emo) send('emo', { key: emo });
  send('say', { text: clean });
  if (silent) return;
  speechQueue.push({ text: clean, emo });
  pumpSpeech();
}

/* ── 大脑 ── */
const PROMPT_TASK_DONE =
  '（系统提示，不是主人说的话：主人刚在 WorkBuddy 里把一件事交付了，情况写在「主人现在的状态」里。' +
  '用一到两句话告诉他这件事办完了：先说结果，再说一句你认为他该留意的地方。' +
  '没办成就直说没办成、卡在哪。别复述他的原话，别说"任务已完成"这种空话，别列举过程。）';
const PROMPT_TASK_LONG =
  '（系统提示，不是主人说的话：主人手上这件事已经做了好一阵子还没交付，情况写在「主人现在的状态」里。' +
  '用一到两句话给出你的判断：是正常的慢，还是可能在某个地方绕圈；然后给一个他能马上动手的建议。' +
  '别催，别显得不耐烦，别说"加油"。）';
const PROMPT_TASK_STALL =
  '（系统提示，不是主人说的话：这件事已经很久没有任何进展了，像卡住了。' +
  '用一句话轻轻提醒他去看一眼，并猜一个最可能卡住的原因。语气要软，别指责、别惊动。）';
const PROMPT_REST =
  '（系统提示，不是主人说的话：主人已经连着干了一个多小时没歇。' +
  '用一句话提醒他歇一会儿，要具体说你看见他连着做完了几件事，别说空话。）';

let busy = false;
let activeThought = null;

/** 时间感知：小模型不知道"现在"，不给它就会瞎猜 */
function nowLine() {
  const d = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const hh = d.getHours();
  const part = hh < 5 ? '凌晨' : hh < 9 ? '早上' : hh < 12 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜';
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `现在是 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${week} ${part}${hh}:${mm}。`;
}

/** 常驻监听：同一次输出中直接回答或跳过。 */
const JUDGE_RULE = replyPolicy.RULE;

const HISTORY_TURNS = 6;   // 只带最近 3 轮对话，够接话又不撑爆上下文

async function think({ userText, internal = false, allowSpeech = true, judge = false, voiceTurn }) {
  const c = config.load();
  // 大脑的配置在 brain 里，这里折算成真正能发请求的那三个字段
  const L = config.resolveLLM(c);
  if (L.transport !== 'workbuddy' && !L.apiKey) {
    send('chat', { role: 'assistant', text: '（还没配好大脑：去设置里看看 —— 默认用 WorkBuddy 的额度，一行都不用填）' });
    return null;
  }
  activeThought?.abort();
  const controller = new AbortController();
  activeThought = controller;
  log(`[brain] provider=${L.provider} model=${L.model}`);
  const ctx = nowLine() + '\n' + (monitor ? monitor.context() : '');
  const sys = config.buildSystemPrompt(ctx) + (judge ? JUDGE_RULE : '');
  const msgs = [{ role: 'system', content: sys }];
  for (const h of history.slice(-HISTORY_TURNS)) msgs.push(h);
  // 别把同一句主人话塞两遍。调用方有时已经 pushHistory('user') 过了，
  // 这里再无脑 push 一次，模型看到连着两条一模一样的输入，就会开始复读。
  const lastH = history[history.length - 1];
  const dup = lastH && lastH.role === 'user' && String(lastH.content).trim() === String(userText).trim();
  if (!dup) msgs.push({ role: 'user', content: userText });

  busy = true;
  const requestStarted = Date.now();
  send('think', { on: true });
  // 边生成边念。判官模式也能提前出声：<skip> 只可能出现在开头，
  // 第一句一旦不是 skip，就等于已经判定"这话是对我说的"，可以直接念 —— 省掉整段等生成。
  let silenced = false;   // 已判定不该出声（命中 skip）
  let streamed = false;   // 已经有句子进了朗读队列
  const earlySentences = [];
  const responseGate = replyPolicy.makeReplyGate((text) => {
    if (!internal && !controller.signal.aborted) send('delta', { text });
  });
  const enqueueSentence = (s) => {
    if (controller.signal.aborted || (voiceTurn && !voiceTurn.isCurrent())) return;
    if (silenced || !allowSpeech) return;
    if (/<\s*skip/i.test(s)) { silenced = true; return; }
    const parsed = llm.extractTags(s);
    const txt = parsed.clean.replace(/<\s*skip\s*\/?>/gi, '').trim();
    if (!txt) return;
    streamed = true;
    speechQueue.push({ text: txt });
    if (!speaking) pumpSpeech();
  };
  const saySentence = (s) => voiceTurn ? earlySentences.push(s) : enqueueSentence(s);

  try {
    const r = await llm.chat({
      ...L,
      // Hy3 的上限包含内部推理，压到 512 会截断到没有回答；
      // 简短口语由提示词约束，不能靠截断推理来冒充加速。
      maxTokens: L.maxTokens || 4096,
      signal: controller.signal,
      messages: msgs,
      onDelta: (d) => {
        if (controller.signal.aborted || (voiceTurn && !voiceTurn.isCurrent())) return;
        if (judge) responseGate.push(d);
        else if (!internal) send('delta', { text: d });
      },
      onSentence: saySentence,
    });
    if (controller.signal.aborted || (voiceTurn && !voiceTurn.isCurrent())) return null;
    log(`[brain] 完成 ${Date.now() - requestStarted}ms（一次请求 · ${L.provider}/${r.model || L.model}）`);

    responseGate.flush();
    const raw = (r.text || '').trim();
    // 判官说「不是在跟我说话」→ 什么都不做，也不记进历史
    if (judge && (responseGate.skipped || /^<\s*skip\s*\/?>/i.test(raw))) {
      voiceTurn?.skip();
      silenced = true;
      stopSpeaking();
      send('heard', { text: userText, replied: false });
      log('[judge] skip: ' + userText.slice(0, 40));
      return r;
    }

    // 请求已在一秒停顿时发出；三秒边界前的续说仍能撤销它。
    // 模型生成与轮次收尾并行，绝不在请求前再等待三秒。
    if (voiceTurn) {
      if (!await voiceTurn.waitForCommit() || !voiceTurn.isCurrent() || controller.signal.aborted) return null;
      voiceTurn.remember();
      for (const sentence of earlySentences) enqueueSentence(sentence);
    }

    const clean = raw.replace(/<\s*skip\s*\/?>/gi, '').trim();
    // 把她实际说的话记下来：回看时才知道"她到底说了什么蠢话"，否则无从优化
    if (clean) log('[say] ' + clean.replace(/\s+/g, ' ').slice(0, 90));
    if (clean) {
      if (judge && !voiceTurn) pushHistory('user', userText);
      pushHistory('assistant', clean);
      if (!internal) {
        send('chat', { role: 'assistant', text: clean, final: true });
      }
      if (!streamed && allowSpeech) {
        speak(clean, { motion: r.motions[0], emo: r.emos[0] });
      }
    }
    if (r.motions && r.motions[0]) send('motion', { key: r.motions[0], once: true });
    if (r.emos && r.emos[0]) send('emo', { key: r.emos[0] });
    // 注意：这里绝不能调 finishSpeech() —— 句子是流水线朗读的，
    // 真正的收尾由渲染层播完音频回 pet:audio-done 驱动。
    return r;
  } catch (e) {
    if (controller.signal.aborted) return null;
    console.error('[llm]', e.message);
    send('chat', { role: 'assistant', text: '（我这会儿想不出来：' + e.message + '）' });
    return null;
  } finally {
    if (activeThought === controller) {
      activeThought = null;
      busy = false;
      send('think', { on: false });
    }
  }
}

/* ── 主动播报 ──
 * 只有这几件事值得娃娃主动开口（主人在 WorkBuddy 里干活时）：
 *   taskDone  —— 一件事交付了 → 报结果 + 一句该留意的地方（核心）
 *   taskLong  —— 同一件事拖太久 → 分析一下 + 给建议
 *   taskStall —— 很久没动静 → 轻轻提醒去看一眼
 *   rest      —— 连着干了一个多小时 → 劝歇（不单独说，挂在 taskDone 尾巴上）
 * 明确不做：不因某条命令失败而开口，不逐条念工具调用，不在主人刚下指令时抢话。
 */
let lastProactiveAt = 0;
let turnT0 = 0;         // 本轮的计时起点（听见 → 第一声）
let lastHeardAt = 0;    // 主上一次开口的时刻：用来避免抢话
let quietUntil = 0;     // 「别烦我」之后安静到什么时候

/* 主人明确让我闭嘴的说法。命中就安静 10 分钟，只留一行字，不出声 —— 
 * 这时候再"好的一声"本身就是烦人的一部分。 */
const QUIET_WORDS = /别(再)?(说|念|烦|吵|唠叨|讲)了?|安静(点|一下)?|闭嘴|不要说话|先别说|别打扰/;
let workSpanStart = 0;
let lastWorkSeenAt = 0;
let restNoticedAt = 0;

function proactiveAllowed() {
  const c = config.load();
  if (!c.monitor.enabled) return false;
  if (busy) return false;
  // 主人刚说了「别烦」→ 安静期内一声不吭（除非他先开口）
  if (Date.now() < quietUntil) return false;
  // 主人正在说话/刚说完 8 秒内不插话 —— 抢话是最掉好感的毛病
  if (Date.now() - lastHeardAt < 8000) return false;
  // 热身期：刚启动的 12 秒内不主动开口，避免"一开机就复述历史"
  if (Date.now() - BOOT_AT < 12000) return false;
  if (Date.now() - lastProactiveAt < c.monitor.minGapMs) return false;
  return true;
}

function proactive(kind, extra = {}) {
  const c = config.load();
  const s = monitor ? monitor.snap : null;
  if (!s || !s.sessionId) return;
  // 只对"本次启动之后新发生的事"有反应
  if (!s.lastEventAt || s.lastEventAt < BOOT_AT) return;
  if (!proactiveAllowed()) return;

  let prompt = '';
  if (kind === 'taskDone') {
    if (!c.monitor.speakOnDone) return;
    prompt = PROMPT_TASK_DONE;
  } else if (kind === 'taskLong') {
    if (!c.monitor.speakOnLong) return;
    prompt = PROMPT_TASK_LONG;
  } else if (kind === 'taskStall') {
    if (!c.monitor.speakOnStall) return;
    prompt = PROMPT_TASK_STALL;
  } else {
    return;
  }
  if (extra.withRest) prompt += '\n另外：主人已经连着干了一个多小时了，最后补一句让他歇一会儿。';

  lastProactiveAt = Date.now();
  if (kind === 'taskDone' && win && !win.isVisible()) {
    notify('这件事做完了', s.task ? taskName(s.task) : '去看看结果？');
  }
  log('[proactive] ' + kind + (extra.note ? ' · ' + extra.note : ''));
  think({ userText: prompt, internal: true });
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    n.on('click', () => { showWindow(); });
    n.show();
  } catch {}
}

/* ── 监控接线 ── */
function startMonitor() {
  const c = config.load();
  if (monitor) monitor.stop();
  monitor = new Monitor();

  monitor.on('update', (v) => {
    lastWorkSeenAt = Date.now();
    // 单会话事件（assistant 说话/工具调用）传进来的是 snap，汇总视图从 monitor 现取
    const view = v && v.running ? v : monitor.view;
    send('monitor', snapshotForUi(view));
    // 状态映射到动作（只在空闲态跟随，避免打断正在播的动作）
    if (view && view.running && view.running.length) send('phase', { phase: 'work' });
    else if (view && view.primary && view.primary.phase === 'done') send('phase', { phase: 'done' });
    else send('phase', { phase: 'idle' });
  });

  monitor.on('taskStart', () => {
    const now = Date.now();
    // 歇了半小时以上再开工 → 连续工作时间重新算
    if (!workSpanStart || now - lastWorkSeenAt > 30 * 60e3) workSpanStart = now;
    lastWorkSeenAt = now;
  });

  monitor.on('taskDone', (s) => {
    const now = Date.now();
    if (!workSpanStart) workSpanStart = now;
    const c2 = config.load();
    // 连着干太久：不单独说，合并进"做完了"那句的尾巴
    const withRest =
      c2.monitor.speakOnRest !== false &&
      now - workSpanStart > 95 * 60e3 &&
      now - restNoticedAt > 90 * 60e3;
    if (withRest) {
      restNoticedAt = now;
      workSpanStart = now;
    }
    proactive('taskDone', { withRest, note: s.task ? taskName(s.task) : '' });
  });

  monitor.on('taskLong', ({ elapsedMs, round }) => {
    proactive('taskLong', { note: Math.round(elapsedMs / 60000) + 'min#' + round });
  });

  monitor.on('taskStall', ({ idleMs }) => {
    proactive('taskStall', { note: Math.round(idleMs / 60000) + 'min 无动静' });
  });

  if (c.monitor.enabled) monitor.start(c.monitor.root);
}

/* 汇总视图 → 给界面的扁平结构。
 * tasks 是「要轮播的那几行」：在跑的排前面（可以有多个），再跟最多两条刚做完的。 */
function snapshotForUi(v) {
  if (!v) return null;
  // 兼容旧调用：传进来的是单个会话 snap 就包成 view
  const view = v.running
    ? v
    : { primary: v, running: v.task && v.task.status === 'running' ? [v] : [], done: v.task && v.task.status !== 'running' ? [v] : [], count: 0 };
  const one = (s) => ({
    sessionId: s.sessionId,
    taskId: s.task ? s.task.id : 0,     // 界面「✓ 这条看过了」靠它认人
    title: s.sessionTitle || (s.task && s.task.title) || '',
    name: s.task ? taskName(s.task) : '',
    status: s.task ? s.task.status : 'idle',
    startedAt: s.task ? s.task.startedAt : 0,
    endedAt: s.task ? s.task.endedAt : 0,
    durationMs: s.task ? (s.task.status === 'running' ? Date.now() - s.task.startedAt : s.task.durationMs) : 0,
    steps: s.task ? s.task.steps : 0,
  });
  const running = (view.running || []).map(one);
  const done = (view.done || []).map(one);
  const primary = view.primary;
  const t = primary && primary.task;
  return {
    sessionId: primary ? primary.sessionId : null,
    title: primary ? primary.sessionTitle || (t && t.title) || '' : '',
    phase: running.length ? 'running' : (primary ? primary.phase : 'idle'),
    userText: primary ? primary.userText : '',
    assistantText: primary ? primary.assistantText : '',
    lastEventAt: primary ? primary.lastEventAt : 0,
    task: t ? {
      name: taskName(t),
      status: t.status,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs: t.status === 'running' ? Date.now() - t.startedAt : t.durationMs,
      steps: t.steps,
    } : null,
    running,                                     // 同时在跑的全部
    runningCount: running.length,
    tasks: [...running, ...done.slice(0, 2)],    // 界面上轮播的行
    history: (primary ? primary.history || [] : []).map((h) => ({
      name: taskName(h),
      status: h.status,
      durationMs: h.durationMs,
      endedAt: h.endedAt,
    })),
  };
}

/* ── 托盘 ── */
function trayImage() {
  const p = path.join(__dirname, '..', '..', 'res', 'trayTemplate.png');
  let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) {
    // 兜底：8x8 全透明，至少不崩
    img = nativeImage.createEmpty();
  }
  img.setTemplateImage(true);
  return img;
}

function buildTrayMenu() {
  const c = config.load();
  const vis = win && win.isVisible();
  return Menu.buildFromTemplate([
    { label: `${c.buddy.name} · ${vis ? '在屏幕上' : '已收起'}`, enabled: false },
    { type: 'separator' },
    { label: vis ? '收起' : '叫出来', click: () => (vis ? hideWindow() : showWindow()) },
    { label: '说句话', click: () => { showWindow(); send('ask', { focus: true }); } },
    { label: '按住说话  ⌘⇧Space', click: () => toggleRecord() },
    { type: 'separator' },
    { label: '动作列表…', click: () => { showWindow(); openPanel('motions'); } },
    {
      label: '形象',
      submenu: avatars.scan().map((a) => ({
        label: `${a.label}${c.avatar === a.key ? '  ✓' : ''}`,
        click: () => { config.save({ avatar: a.key }); send('avatar', { key: a.key }); },
      })),
    },
    {
      label: '角色大小',
      submenu: SCALES.map((k) => ({
        label: `${SCALE_LABELS[k]}${clampScale(c.window.scale) === k ? '  ✓' : ''}`,
        click: () => {
          config.save({ window: { scale: k } });
          applyWindowScale(k);
          send('scale', { scale: k });
          rebuildTray();
        },
      })),
    },
    {
      label: '声音',
      submenu: [
        {
          label: '说话（TTS）', type: 'checkbox', checked: c.voice.enabled,
          click: (i) => { config.save({ voice: { enabled: i.checked } }); rebuildTray(); },
        },
        {
          label: '只在我叫它时才说', type: 'checkbox', checked: !c.monitor.speakOnDone,
          click: (i) => {
            config.save({
              monitor: {
                speakOnDone: !i.checked,
                speakOnLong: !i.checked,
                speakOnStall: !i.checked,
                speakOnRest: !i.checked,
              },
            });
            rebuildTray();
          },
        },
      ],
    },
    { type: 'separator' },
    { label: '打开设置…', click: () => openPanel('settings') },
    {
      label: (asrStatus.speech === 3 && (asrStatus.mic === true || asrStatus.micSystem === 'granted'))
        ? '语音权限 ✓ 正常'
        : '语音权限 ✗ 未就绪（点这里修）',
      click: () => openPanel('settings'),
    },
    { label: '打开数据目录', click: () => shell.openPath(USER_DIR) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

function rebuildTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function showWindow() {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.showInactive();
  win.setPosition(x, y, false);
  rebuildTray();
}
function hideWindow() {
  if (!win) return;
  win.hide();
  rebuildTray();
}

/* ── 录音（单次，按住说话） ── */
function toggleRecord() {
  if (!asr) { log('[asr] not initialized'); return; }
  if (asr.running) {
    log('[asr] stop requested');
    asr.stop();
    send('record', { state: 'stopping' });
  } else {
    stopSpeaking();
    const c = config.load();
    log('[asr] start requested, bin=' + ASR_BIN + ' exists=' + fs.existsSync(ASR_BIN));
    asr.start({ lang: c.asr.lang, silenceMs: c.asr.silenceMs, maxSeconds: c.asr.maxSeconds });
    send('record', { state: 'starting' });
  }
}

/* ══════════ 常驻聆听 ══════════
 * 设计要点（用户明确要求）：
 *   · 麦克风与识别常开（系统 ASR，端侧），但这不等于一直在调模型
 *   · 只有「听到一句人话」或「WorkBuddy 有事件」时才调 LLM，空闲时零调用
 *   · 娃娃自己在说话时 mute 掉采集，避免自听自答
 */
let alwaysOn = false;
let asrStartedAt = 0;    // 上一次 ASR 进程起来的时刻：用来判"秒死"并退避
let asrFailStreak = 0;
let listenRestartTimer = null;
let lastLiveAt = 0;        // 实时字幕节流
let lastLiveText = '';
let micPeak = 0;           // 麦克风电平峰值（自检用）
let micPeakAt = Date.now();
let micQuietLoggedAt = 0;
let lastPartialLogAt = 0;  // "半句"日志节流（漏声明过一次，导致每次 partial 都抛 ReferenceError）

function asrOpts(always) {
  const c = config.load();
  return {
    lang: c.asr.lang,
    silenceMs: c.asr.silenceMs,
    maxSeconds: c.asr.maxSeconds,
    always,
    maxUtterances: c.asr.recycleUtterances || 30,
    device: c.asr.device || '',
    // 授权只由应用自己问一次，子进程绝不再问 —— 否则 TCC 会被两个身份来回问
    noMicAsk: true,
  };
}

function startListen(reason) {
  if (!asr) return;
  const c = config.load();
  if (!c.voice.alwaysListen) return;
  if (!fs.existsSync(ASR_BIN)) { send('listen', { on: false, error: '缺少 bin/asr' }); return; }
  alwaysOn = true;
  send('listen', { on: true, reason: reason || '' });
  if (asr.running) return;
  asrStatus = { ...asrStatus, captureReady: false, note: 'starting' };
  send('asrStatus', asrStatus);
  asrStartedAt = Date.now();
  asr.start(asrOpts(true));
  send('listen', { on: true, reason: reason || '' });
  log('[listen] start (' + (reason || 'boot') + ')');
}

function stopListen() {
  voiceTurns.reset();
  alwaysOn = false;
  if (listenRestartTimer) { clearTimeout(listenRestartTimer); listenRestartTimer = null; }
  if (asr && asr.running) asr.stop();
  send('listen', { on: false });
  log('[listen] stop');
}

function scheduleListenRestart(delay) {
  if (!alwaysOn) return;
  if (listenRestartTimer) clearTimeout(listenRestartTimer);
  listenRestartTimer = setTimeout(() => {
    listenRestartTimer = null;
    if (alwaysOn && asr && !asr.running) {
      log('[listen] restart');
      asr.start(asrOpts(true));
    }
  }, delay || 900);
}

/** 本地小门槛：挡掉气泡音、单字噪声、明显的自己人声残留，不花一次模型调用 */
function worthJudging(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  const meaningful = t.replace(/[^\p{L}\p{N}]/gu, '');
  return meaningful.length >= 2;
}

/** 听见有人叫我名字（含常见误听写法）→ 直接当在跟我说话，省一次判断 */
function nameHit(text) {
  const t = String(text || '').toLowerCase();
  const c = config.load();
  const hints = [
    c.buddy.name, 'baby', 'bab', '贝比', '贝贝', '宝贝', '小伴', '小曼', '小班', '小半', '小帮',
  ];
  return hints.some((h) => h && t.includes(String(h).toLowerCase()));
}

/** 每听到一句 → 先判断是不是在对我说，是就回，不是就闭嘴（一次调用搞定） */
const voiceTurns = require('./voice-turns').createVoiceTurns({
  onRequest: (turn) => handleUtterance(turn.text, turn),
  onInvalidate: () => stopSpeaking(),
  onRemember: (text) => pushHistory('user', text),
  onError: (message) => { log('[listen] ' + message); send('toast', { text: message }); },
  onLive: (text, state) => state.final && state.pending
    ? send('heard', { text }) : send('asrLive', { text }),
});

async function handleUtterance(text, voiceTurn) {
  const t = String(text || '').trim();
  if (!worthJudging(t)) { log('[listen] drop noise: ' + t.slice(0, 20)); return; }
  // 这句可能就是我自己刚说的（回声消除没吃干净）→ 当没听见
  if (echoLike(t) && Date.now() - lastSpokeAt < 2600) {
    log('[listen] drop self echo: ' + t.slice(0, 24));
    return;
  }
  if (speaking) {
    // 主人在我说话的时候开口 → 立刻收声，听他说完
    log('[listen] barge-in: ' + t.slice(0, 24));
    stopSpeaking();
  }
  const c = config.load();
  turnT0 = voiceTurn?.heardAt || Date.now();
  lastHeardAt = Date.now();
  send('heard', { text: t });
  if (voiceTurn) log(`[listen] 预请求：停顿 ${Date.now() - voiceTurn.heardAt}ms`);
  log('[listen] heard: ' + t.slice(0, 60));

  // 「别烦我」→ 立刻静音 10 分钟。这是主人的明确指令，优先级高于一切。
  // 只在气泡里回一句字，不出声、不撒娇 —— 这时候出声本身就是烦人的一部分。
  if (QUIET_WORDS.test(t)) {
    quietUntil = Date.now() + 10 * 60e3;
    stopSpeaking();
    send('chat', { role: 'assistant', text: '（好，我安静。）' });
    log('[quiet] 主人让我安静 10 分钟');
    send('heard', { text: t, replied: true });
    return;
  }

  // 叫名字时直接回答，不附加跳过规则；仍然只调用一次模型。
  if (nameHit(t)) {
    if (!voiceTurn) pushHistory('user', t);
    log('[listen] name hit -> direct reply');
    const r = await think({ userText: t, voiceTurn });
    if (r && (!voiceTurn || voiceTurn.isCurrent())) send('heard', { text: t, replied: true });
    return;
  }

  if (!c.asr.judge) {
    if (!voiceTurn) pushHistory('user', t);
    send('chat', { role: 'user', text: t });
    think({ userText: t, voiceTurn });
    return;
  }
  // 一次模型输出：要回复就直接给正文；否则只输出 <skip>。
  const r = await think({ userText: t, judge: true, voiceTurn });
  if (!r || (voiceTurn && !voiceTurn.isCurrent())) return;
  const skipped = /<\s*skip\s*\/?>/i.test(r.text || '');
  send('heard', { text: t, replied: !skipped });
}

/** 主动要权限：会真的弹系统窗，所以只在用户点「检查权限」时调用 */
async function requestAsrPermission() {
  if (global.__refreshAsrStatus) return global.__refreshAsrStatus({ timeoutMs: 25000, requestMic: true });
  return asrStatus;
}

/* ── IPC ── */
ipcMain.handle('pet:init', async () => {
  const c = config.load();
  const hasAsr = fs.existsSync(ASR_BIN);
  const list = avatars.scan();
  const current = avatars.resolve(c.avatar, list);
  // 老配置存的是 'D' 这种短键，第一次跑顺手改写成文件名，之后就不用再换算
  if (current && current !== c.avatar) { try { config.save({ avatar: current }); c.avatar = current; } catch {} }
  return {
    config: config.publicConfig(c),
    motions: config.MOTIONS,
    motionGroups: config.MOTION_GROUPS,
    avatar: current,
    avatars: list,
    monitor: monitor ? snapshotForUi(monitor.view) : null,
    asrAvailable: hasAsr,
    versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome },
    paths: { userData: USER_DIR },
  };
});

/* 角色大小三档：只改取景倍数与（放大时的）窗口尺寸，UI 一律不动 */
ipcMain.handle('pet:scale', (_e, { scale } = {}) => {
  const k = clampScale(scale);
  config.save({ window: { scale: k } });
  applyWindowScale(k);
  send('scale', { scale: k });
  rebuildTray();
  sendConfig(config.load());
  return { scale: k, config: config.publicConfig() };
});

/* 重扫形象目录：主人往 assets/models/ 丢一个 .vrm，打开设置就能看见，不用重启 */
ipcMain.handle('pet:avatars', () => avatars.scan());

ipcMain.on('pet:stop-speak', () => {
  // 点她一下 = 打断。没有回声消除时，主人"开口"她听不见（说着话是闭麦的），
  // 所以必须给一个不需要她听见的打断方式 —— 点一下最直觉。
  if (speaking || speechQueue.length || busy) {
    log('[speak] 主人点了一下，收声');
    voiceTurns.reset(); stopSpeaking();
  }
});

ipcMain.handle('pet:say', async (_e, { text, internal = false }) => {
  const t = String(text || '').trim();
  if (!t) return { ok: false };
  voiceTurns.reset();
  stopSpeaking();
  pushHistory('user', t);
  send('chat', { role: 'user', text: t });
  think({ userText: t });
  return { ok: true };
});

ipcMain.handle('pet:config', (_e, patch) => {
  const previous = config.load();
  if (patch?.window && Object.hasOwn(patch.window, 'scale')) patch = { ...patch, window: { ...patch.window, scale: clampScale(patch.window.scale) } };
  const c = config.save(patch || {});
  if (patch?.monitor && JSON.stringify(previous.monitor) !== JSON.stringify(c.monitor)) startMonitor();
  if (patch?.avatar && c.avatar !== previous.avatar) send('avatar', { key: c.avatar });
  if (patch?.voice && c.voice.alwaysListen !== previous.voice.alwaysListen) {
    if (c.voice.alwaysListen) startListen('settings'); else stopListen();
  }
  if (patch?.tts && JSON.stringify(previous.tts) !== JSON.stringify(c.tts)) { ttsChanged(c); }
  if (patch?.window && c.window.scale !== previous.window.scale) {
    applyWindowScale(c.window.scale); send('scale', { scale: c.window.scale });
  }
  sendConfig();
  rebuildTray();
  return config.publicConfig();
});

ipcMain.handle('pet:probe', async () => {
  const c = config.load();
  const out = {};
  // LLM
  const t0 = Date.now();
  try {
    const r = await llm.chat({
      ...config.resolveLLM(c), messages: [{ role: 'user', content: '回一个字：好' }], maxTokens: 12, timeoutMs: 20000,
    });
    out.llm = { ok: true, ms: Date.now() - t0, text: (r.text || '').slice(0, 40) };
  } catch (e) {
    out.llm = { ok: false, ms: Date.now() - t0, error: e.message };
  }
  try {
    const r = await ttsSession.synthesize('让我试试这个声音。', c.tts);
    out.tts = { ok: true, ms: r.ms, engine: r.engine, degraded: r.degraded, reason: r.reason };
  } catch (e) { out.tts = { ok: false, error: e.message }; }
  out.asr = { ok: fs.existsSync(ASR_BIN), path: ASR_BIN };
  out.monitor = {
    file: monitor ? monitor.file : null,
    files: monitor ? monitor.sessions.size : 0,
    snap: monitor ? snapshotForUi(monitor.view) : null,
  };
  return out;
});

ipcMain.on('pet:hit', (_e, v) => setInteractive(!!v));
ipcMain.on('pet:log', (_e, m) => log('[ui] ' + String(m).slice(0, 2400)));
ipcMain.on('pet:audio-done', () => finishSpeech());
ipcMain.on('pet:audio-started', () => {
  if (turnT0 && speaking) { log(`[turn] 停顿→开始播放 ${Date.now() - turnT0}ms`); turnT0 = 0; }
});
ipcMain.on('pet:record', () => toggleRecord());
ipcMain.on('pet:listen', (_e, v) => {
  const want = v === 'toggle' ? !alwaysOn : !!v;
  if (want) { config.save({ voice: { alwaysListen: true } }); startListen('user'); }
  else { stopListen(); config.save({ voice: { alwaysListen: false } }); }
  send('listen', { on: alwaysOn });
  sendConfig(config.load());
});
ipcMain.handle('pet:asr-status', async (_e, opts) => {
  if (opts && opts.request) return requestAsrPermission();
  if (global.__refreshAsrStatus) return global.__refreshAsrStatus({ timeoutMs: 4000 });
  return asrStatus;
});
ipcMain.on('pet:open-privacy', (_e, kind) => {
  const pane = kind === 'mic'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    : 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition';
  shell.openExternal(pane);
});
ipcMain.on('pet:vis', (_e, v) => (v ? showWindow() : hideWindow()));
ipcMain.on('pet:quit', () => { quitting = true; app.quit(); });
ipcMain.on('pet:open', (_e, what) => {
  if (what === 'settings') openPanel('settings');
  else if (what === 'motions') openPanel('motions');
  else if (what === 'workbuddy') require('./workbuddy').openApplication().catch(e => log('[workbuddy] ' + e.message));
  else if (what === 'userData') shell.openPath(USER_DIR);
});

/* 独立面板的初始数据。和 pet:init 分开：那边还要带监控快照、ASR 就绪状态，
 * 面板只要配置和动作表就够了，别把一堆无关的东西塞进一个新窗口。 */
ipcMain.handle('pet:panel-init', async () => {
  const c = config.load();
  const list = avatars.scan();
  return {
    config: config.publicConfig(c),
    avatars: list,
    motions: config.MOTIONS,
    motionGroups: config.MOTION_GROUPS,
    avatar: avatars.resolve(c.avatar, list),
    asr: asrStatus,
  };
});

/* 面板点了一个动作 → 转给角色窗口去演。
 * 面板自己没有 3D，也不该有：演的地方永远只有一处。 */
ipcMain.on('pet:panel-motion', (_e, key) => {
  if (key === '__idle__') { send('toidle', {}); return; }
  send('motion', { key });
});

/* ═══════════ 大脑 / 嘴巴：给设置面板的补充接口 ═══════════ */
const MODELS_DIR = path.join(USER_DIR, 'models', 'qwen-customvoice');

ipcMain.handle('pet:brain-info', () => ({
  providers: config.PROVIDERS,
  catalogs: Object.fromEntries(['workbuddy', ...config.PROVIDERS.map(p => p.id)].map(id => [id, require('./model-catalog').get(id)])),
  thinkingLevels: config.THINKING_LEVELS,
  workbuddyModels: config.listWorkBuddyModels(),
  workbuddyThinking: config.thinkingOptions('workbuddy', 'hy3'),
  thinkingByModel: Object.fromEntries(config.PROVIDERS.flatMap((p) => p.models.map((m) => [m, config.thinkingOptions(p.id, m)]))),
}));

ipcMain.handle('pet:workbuddy-open', async () => {
  try { await require('./workbuddy').openApplication(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('pet:brain-models', async (_e, brain) => {
  const L = config.resolveLLM(config.preview({ brain: brain || {} }));
  try {
    const catalog = await require('./model-catalog').refresh(L.provider, L.apiKey);
    return { ok: true, provider: L.provider, catalog };
  } catch (e) { return { ok: false, provider: L.provider, error: e.message }; }
});

ipcMain.handle('pet:brain-test', async (_e, brain) => {
  const c = config.preview({ brain: brain || {} });
  const L = config.resolveLLM(c), t0 = Date.now();
  if (L.transport !== 'workbuddy' && !L.apiKey) return { ok: false, error: '请先填写这个服务商的 API Key。' };
  try {
    const r = await llm.chat({ ...L, messages: [{ role: 'user', content: '只回复“连接成功”。' }] });
    return { ok: true, provider: L.provider, model: r.model || L.model, text: r.text,
      ms: Date.now() - t0, credit: r.usage?.credit };
  } catch (e) { return { ok: false, error: e.message, ms: Date.now() - t0 }; }
});

ipcMain.handle('pet:tts-info', () => {
  let c = config.load();
  const dir = (c.tts.qwen && c.tts.qwen.dir) || MODELS_DIR;
  const normalized = voiceFiles.normalize(c.tts.qwen);
  if (JSON.stringify(normalized) !== JSON.stringify(c.tts.qwen)) {
    c = config.save({ tts: { qwen: normalized } }); ttsChanged(c);
  }
  const downloaded = tts.qwenReady(dir), hasRuntime = !!tts.findSpeechRuntime();
  const voices = tts.qwenVoices({ ...c.tts.qwen, dir });
  if (voices.length && (!c.tts.qwen.ready || c.tts.qwen.dir !== dir || !voices.some((v) => v.id === c.tts.qwen.voice))) {
    c = config.save({ tts: { qwen: { dir, ready: true,
      voice: voices.some((v) => v.id === c.tts.qwen.voice) ? c.tts.qwen.voice : voices[0].id } } });
    ttsChanged(c);
  }
  return {
    config: config.publicConfig(c),
    engines: config.TTS_ENGINES,
    systemVoices: tts.systemVoices(),
    chp: require('./chp-tts').cached(c.tts),
    qwen: {
      dir,
      ready: downloaded && hasRuntime,
      downloaded,
      hasRuntime,
      files: tts.QWEN_FILES.map((f) => f.name),
      voices,
      hasFiles: tts.QWEN_FILES.some((f) => fs.existsSync(path.join(dir, f.name)) || fs.existsSync(path.join(dir, f.name + '.part'))),
      runtime: tts.runtimeStatus(),
    },
    dl: tts.downloadState(),
  };
});

ipcMain.handle('pet:chp-discover', async (_e, patch) => {
  const t = config.preview({ tts: patch || {} }).tts;
  try { return { ok: true, catalog: await require('./chp-tts').discover(t) }; }
  catch (e) { log(`[chp] 获取失败 ${e.code || ''} ${e.message}`); return { ok: false, error: e.message }; }
});
ipcMain.on('pet:chp-help', () => shell.openExternal('https://github.com/zhyuzh3d/haminn-chp'));

ipcMain.handle('pet:tts-download', () => {
  try { fs.mkdirSync(MODELS_DIR, { recursive: true }); } catch {}
  const r = tts.downloadQwen(MODELS_DIR);
  // 下完自动把目录和就绪状态写回配置，省得主人再点一次"应用"
  if (r.started) {
    const watch = setInterval(() => {
      const st = tts.downloadState();
      if (!st.running) {
        clearInterval(watch);
        if (!st.err) {
          config.save({ tts: { qwen: { dir: MODELS_DIR, ready: tts.qwenReady(MODELS_DIR) } } });
          synthCache.clear();
          tts.reset(); syncQwenRuntime(); sendConfig();
        }
      }
    }, 1500);
  }
  return r;
});
ipcMain.handle('pet:tts-dl-state', () => tts.downloadState());
ipcMain.on('pet:tts-cancel', () => tts.cancelDownload());
ipcMain.handle('pet:tts-delete', async () => {
  const result = await dialog.showMessageBox(panels.get('settings') || win, {
    type: 'warning', message: '删除本地语音模型？',
    detail: '将删除约 1.33GB 的 CustomVoice 模型文件，并停止正在进行的下载。再次使用本地语音需要重新下载。原有用户文件会保留。',
    buttons: ['取消', '删除模型'], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (result.response !== 1) return { ok: false, cancelled: true };
  try {
    tts.shutdown();
    const c = config.load(), dir = c.tts.qwen.dir || MODELS_DIR;
    const removed = await tts.deleteQwen(dir);
    ttsSession.useSystem('本地语音模型已删除', 'qwen', tts.pickSystemVoice());
    const updated = config.save({ tts: { qwen: { ready: false, voice: 'serena', activeTrack: null } } });
    ttsChanged(updated);
    return removed;
  } catch (e) { return { ok: false, error: '删除模型失败：' + e.message }; }
});
ipcMain.handle('pet:tts-check', async () => {
  const c = config.load(), dir = c.tts.qwen?.dir || MODELS_DIR;
  const result = await tts.checkQwen(dir);
  if (!result.ok) {
    ttsSession.useSystem(result.error, 'qwen', tts.pickSystemVoice());
    return result;
  }
  if (!tts.findSpeechRuntime()) {
    const error = '模型完整，但本地语音引擎缺失，请重新安装应用。';
    ttsSession.useSystem(error, 'qwen', tts.pickSystemVoice());
    return { ...result, ok: false, error };
  }
  config.save({ tts: { qwen: { dir, ready: true } } });
  synthCache.clear();
  return result;
});

/* 试听：真的合成一句，交给角色窗口播出来 —— 主人听的是真嗓子，不是"设置已保存"。
 * 顺手把用的哪个引擎、哪个音色回给面板，日志和界面都能自证。 */
ipcMain.handle('pet:tts-test', async () => {
  const c = config.load();
  stopSpeaking();
  const gen = speechGen;
  speaking = true;
  send('speaking', { on: true, text: '' });
  speakWatchdog = setTimeout(() => { if (gen === speechGen) finishSpeech(); }, c.tts.engine === 'qwen' ? 145000 : c.tts.engine === 'remote' ? 90000 : 30000);
  try {
    const text = '让我试试这个声音，你觉得顺耳吗？';
    const playback = streamingPlayback(c, gen, text);
    const r = await ttsSession.synthesize(text, c.tts, playback.options);
    if (gen !== speechGen) return { ok: false, error: '试听已停止' };
    clearTimeout(speakWatchdog);
    if (!playback.finish(r)) {
      noteSpoken(text);
      if (asr && !asr.aec) muteAsr('开始试听');
      send('audio', { buffer: r.buffer, text: '' });
    }
    speakWatchdog = setTimeout(() => { if (gen === speechGen) finishSpeech(); }, Math.max(1500, ((r.buffer.length - 44) / 48000) * 1000) + 2500);
    return { ok: true, engine: r.engine, voice: r.voice, ms: r.ms, bytes: r.buffer.length,
      degraded: r.degraded, reason: r.reason };
  } catch (e) {
    if (gen === speechGen) finishSpeech();
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('pet:resize', (_e, { w, h }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width: Math.round(w), height: Math.round(h) });
  config.save({ window: { w: Math.round(w), h: Math.round(h) } });
});

/* ── 自检：定时截图后退出，用于无头验证真实画面 ──
 *  两种驱动方式：
 *   1) 环境变量 BUDDY_PET_SHOT / _SCRIPT / _SHOT_MS / _SHOT_DELAY / _SHOT_EXTRA
 *   2) <userData>/selftest.json（打包版用 open 启动时拿不到环境变量，只能走这个）
 *      { "shotDir": "/tmp/ps", "script": ["window.pet.record()"], "delay": 5000, "every": 2500, "extra": 0 }
 */
function readSelfTestSpec() {
  const env = process.env.BUDDY_PET_SHOT;
  if (env) {
    return {
      shotDir: env,
      script: (process.env.BUDDY_PET_SCRIPT || '').split('|').filter(Boolean),
      every: Number(process.env.BUDDY_PET_SHOT_MS || 3000),
      delay: Number(process.env.BUDDY_PET_SHOT_DELAY || 4000),
      extra: Number(process.env.BUDDY_PET_SHOT_EXTRA || 1),
    };
  }
  const f = path.join(USER_DIR, 'selftest.json');
  try {
    if (!fs.existsSync(f)) return null;
    const spec = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.unlinkSync(f);              // 一次性：跑完就删，避免每次启动都自检
    return {
      shotDir: spec.shotDir || path.join(USER_DIR, 'shots'),
      script: Array.isArray(spec.script) ? spec.script : (spec.script ? String(spec.script).split('|') : []),
      every: Number(spec.every || 3000),
      delay: Number(spec.delay || 4000),
      extra: Number(spec.extra ?? 1),
    };
  } catch (e) {
    log('[selftest] bad spec', e.message);
    return null;
  }
}

function scheduleSelfTest() {
  const spec = readSelfTestSpec();
  if (!spec) return;
  const { shotDir, script, every, delay, extra } = spec;
  log('[selftest] spec', spec);
  let step = 0;

  const tick = async () => {
    try {
      if (script[step]) {
        // 以 "@panel:<kind>:" 开头的脚本在对应面板窗口里跑，用来验收设置/动作库面板
        const m = /^@panel:([a-z]+):([\s\S]*)$/.exec(script[step]);
        let js = script[step], target = win;
        if (m) {
          const pw = panels.get(m[1]);
          if (!pw || pw.isDestroyed()) { log('[selftest] no panel ' + m[1]); }
          else { js = m[2]; target = pw; }
        }
        log('[selftest] eval: ' + js.slice(0, 120));
        const r = await target.webContents.executeJavaScript(js, true).catch((e) => 'ERR:' + e.message);
        if (r !== undefined) log('[selftest] => ' + JSON.stringify(r).slice(0, 900));
      }
      step++;
      const img = await win.webContents.capturePage();
      const p = path.join(shotDir, `shot-${String(step).padStart(2, '0')}.png`);
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(p, img.toPNG());
      const sz = img.getSize();
      log(`[selftest] shot ${p}  ${sz.width}x${sz.height}`);
      // 开着的面板窗口也各拍一张：整屏截屏在显示器睡着时是全黑的，抓窗口内容永远有效
      for (const [kind, pw] of panels) {
        if (pw.isDestroyed() || !pw.isVisible()) continue;
        try {
          const pi = await pw.webContents.capturePage();
          const pp = path.join(shotDir, `panel-${kind}-${String(step).padStart(2, '0')}.png`);
          fs.writeFileSync(pp, pi.toPNG());
          const ps = pi.getSize();
          log(`[selftest] shot ${pp}  ${ps.width}x${ps.height}`);
        } catch (e) { log(`[selftest] panel shot fail ${kind}: ${e.message}`); }
      }
      if (step >= Math.max(script.length, 1) + extra) {
        log('[selftest] done');
        quitting = true;
        markCleanExit();
        app.exit(0);
        return;
      }
      setTimeout(tick, every);
    } catch (e) {
      log('[selftest] fail ' + e.message);
      quitting = true;
      markCleanExit();
      app.exit(1);
    }
  };
  setTimeout(tick, delay);
}

/* ── 麦克风体检：哪个麦能收得到，测出来而不是猜 ── */
function runMicProbeAll(sec) {
  return new Promise((resolve) => {
    log(`[probe] 逐个麦克风测电平，每个 ${sec} 秒`);
    const p = spawn(ASR_BIN, ['--probe-all', '--probe-sec', String(sec)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let best = { name: '', peak: 0, id: 0 };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.t === 'probe') {
            log(`[probe] ${m.name} 峰值=${Number(m.peak).toFixed(4)} 绑定=${m.bound}${m.err ? ' 错误=' + m.err : ''}`);
            if (m.peak > best.peak) best = { name: m.name, peak: m.peak, id: m.id };
          }
          if (m.t === 'probeBegin') log(`[probe] 共 ${m.v} 个输入设备`);
        } catch {}
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) log('[probe stderr] ' + s.slice(0, 200));
    });
    const done = () => {
      if (best.name) {
        log(`[probe] 最适合收人声的是「${best.name}」（峰值 ${best.peak.toFixed(4)}），已记进配置`);
        config.save({ asr: { device: best.name } });
      } else {
        log('[probe] 所有设备都没收到声音');
      }
      resolve(best);
    };
    p.on('exit', done);
    p.on('error', () => resolve(null));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, (sec * 8 + 15) * 1000);
  });
}

/* ── 启动 ── */
const lock = app.requestSingleInstanceLock();
if (!lock) {
  log('[boot] single-instance lock 未拿到，退出（已有实例在跑）');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    createWindow();
    syncQwenRuntime();

    app.on('child-process-gone', (_e, d) => {
      log('[child-gone] ' + JSON.stringify({ type: d.type, name: d.name, reason: d.reason, exitCode: d.exitCode }));
    });
    app.on('gpu-process-crashed', () => log('[gpu] 进程崩了（会自己恢复，只是画面会顿一下）'));
    try {
      tray = new Tray(trayImage());
      tray.setToolTip('workbunny · 你的桌面伙伴');
      tray.setContextMenu(buildTrayMenu());
      tray.on('click', () => (win && win.isVisible() ? hideWindow() : showWindow()));
    } catch (e) {
      console.error('[tray]', e.message);
    }

    // ── 麦克风授权：由**应用自己**去要，不让子进程 asr 去要 ──────────
    // 为什么：TCC 记授权，记的是"谁去要的"。让 bin/asr 去要，责任进程可能
    // 被解析成那个裸可执行文件，于是授权记在一个既没有 bundle id、路径又随
    // 打包变化的身份上 —— 表现就是每次启动都重新弹框。
    // 应用自己 askForMediaAccess 一次，授权就牢牢记在 cn.haminn.workbunny 上；
    // 再配合固定证书签名（tools/make-signing-cert.sh），重打包多少次都不会再问。
    (async () => {
      try {
        const before = systemPreferences.getMediaAccessStatus('microphone');
        log('[mic] 系统授权状态=' + before);
        if (before !== 'granted') {
          const ok = await systemPreferences.askForMediaAccess('microphone');
          log('[mic] 申请结果=' + ok + '，之后状态=' + systemPreferences.getMediaAccessStatus('microphone'));
        }
      } catch (e) {
        log('[mic] 申请授权出错：' + e.message);
      }
    })();

    asr = new Asr(ASR_BIN, log);
    const SPEECH_ZH = ['待授权', '缺语言包', '不可用', '可用'];
    function applyStatus(st) {
      asrStatus = { ...asrStatus, ...st, checkedAt: Date.now() };
      send('asrStatus', asrStatus);
      log('[asr] status', asrStatus);
      return asrStatus;
    }

    /** 静默查一次状态：不采集、默认不弹窗（SpeechAnalyzer 不需要 Siri/听写） */
    let firstProbe = true;
    async function refreshAsrStatus({ timeoutMs = 4000, requestMic = false } = {}) {
      if (asr?.installing && !requestMic) return asrStatus;
      if (!fs.existsSync(ASR_BIN)) {
        return applyStatus({ speech: -1, mic: false, note: '缺少 bin/asr' });
      }
      let mic = null;
      try { mic = systemPreferences.getMediaAccessStatus('microphone'); } catch {}
      const r = await probeAccess(ASR_BIN, { timeoutMs, requestMic });
      if (r.timedOut) {
        return applyStatus({ speech: 0, mic, note: 'pending', micSystem: mic });
      }
      firstProbe = false;
      const ok = r.speech === 3 && r.mic;
      if (!ok && firstProbe === false && !requestMic) { /* 静默，不打扰 */ }
      return applyStatus({
        speech: r.speech,
        mic: r.mic,
        micSystem: mic,
        locale: r.locale || '',
        engine: r.engine || '',
        note: ok ? 'ok' : (r.mic ? (SPEECH_ZH[r.speech] || '未知') : '待授权'),
        error: r.error || '',
      });
    }
    global.__refreshAsrStatus = refreshAsrStatus;

    asr.on('auth', (a) => {
      applyStatus({
        speech: a.speech, mic: a.mic, locale: a.locale || '', engine: a.engine || '',
        note: a.speech === 3 && a.mic ? 'ok' : 'denied',
      });
      if (a.speech !== 3) {
        send('asrError', {
          message: '这台机器的「' + (a.locale || 'zh-CN') + '」语音模型还没装好，装完我才能听懂你。',
        });
      } else if (!a.mic) {
        send('asrError', { message: '麦克风被关了，去「系统设置 → 隐私与安全性 → 麦克风」勾上我。' });
      }
    });
    asr.on('ready', () => {
      applyStatus({ captureReady: true, note: 'ok', error: '' });
      if (mutedSince) asr.mute();
      log('[asr] ready' + (alwaysOn ? ' (always)' : ''));
      if (alwaysOn) send('listen', { on: true, ready: true });
      else send('record', { state: 'listening' });
    });
    asr.on('capture', message => {
      if (message.t === 'tap') log(`[asr] 已收到真实音频输入（${message.frames} 帧）`);
    });
    asr.on('installing', ({ locale }) => {
      applyStatus({ speech: 1, mic: true, locale, captureReady: false, note: 'installing', error: '' });
      log('[asr] 正在准备本机语音资源 ' + locale);
    });
    asr.on('audioPlan', (plan) => {
      log('[asr] 音频链路就绪（方案：' + (plan || '?') + '）');
      send('aec', { on: !!asr.aec, plan });
    });
    asr.on('aec', (on) => {
      log('[asr] 回声消除 ' + (on ? '已开启 —— 我说话时也能听见你（可随时打断）' : '不可用 —— 我说话时会闭麦'));
      send('aec', { on });
    });
    asr.on('micDevice', (d) => {
      if (d.on) log(`[asr] 输入设备已钉到「${d.name}」`);
      else if (d.note) log(`[asr] 输入设备：${d.note}`);
      else if (d.name) log(`[asr] 想钉到「${d.name}」但绑定失败，先用系统默认`);
    });
    asr.on('fmt', (f) => log(`[asr] 格式 硬件=${f.hw} → 识别=${f.tgt}`));
    asr.on('partial', (t) => {
      send('asrPartial', { text: t });
      // 调试用：能听到"半句"就说明识别真的在工作（限流，别刷屏）
      const now0 = Date.now();
      if (t && now0 - lastPartialLogAt > 1800) {
        lastPartialLogAt = now0;
        log('[asr] 半句: ' + String(t).slice(0, 40));
      }
      // 一秒停顿即可预请求，无需等待原生识别器最终收句。
      if (!alwaysOn) return;
      lastLiveText = t;
      if (!echoLike(t) || Date.now() - lastSpokeAt >= 2600) voiceTurns.partial(t);
    });
    asr.on('level', (v) => {
      send('asrLevel', { v });
      // 麦克风电平自检：安静时也会走动，方便判断"到底有没有收到声音"。
      // 但不能每 5 秒写一行 —— 常驻一整天就是几万行垃圾。只在这两种时候记：
      //   · 真的有人声（峰值 > 0.3，正常说话就是这个量级）
      //   · 或者安静满 5 分钟，留一条心跳证明链路还活着
      if (v > micPeak) micPeak = v;
      const now = Date.now();
      if (now - micPeakAt > 5000) {
        const loud = micPeak > 0.3;
        if (loud || now - micQuietLoggedAt > 300000) {
          log(`[asr] lvl 峰值 ${micPeak.toFixed(3)}`);
          micQuietLoggedAt = now;
        }
        micPeak = 0;
        micPeakAt = now;
      }
    });
    asr.on('utterance', (t) => {
      lastLiveText = '';
      if (!alwaysOn) return;
      log(`[asr] 收句确认 ${String(t).length} 字`);
      if (!echoLike(t) || Date.now() - lastSpokeAt >= 2600) voiceTurns.final(t);
    });
    asr.on('final', (t) => {
      log('[asr] final', t);
      send('asrFinal', { text: t });
      if (!alwaysOn && t && t.trim().length >= 1) {
        pushHistory('user', t.trim());
        send('chat', { role: 'user', text: t.trim() });
        think({ userText: t.trim() });
      }
    });
    asr.on('recycle', (n) => log('[asr] recycled after ' + n + ' utterances'));
    asr.on('error', (m) => {
      applyStatus({ captureReady: false, note: 'reconnecting', error: m });
      log('[asr] error', m); send('asrError', { message: m });
    });
    asr.on('end', () => { if (!alwaysOn) send('record', { state: 'idle' }); });
    asr.on('exit', () => {
      applyStatus({ captureReady: false, note: alwaysOn ? 'reconnecting' : 'off' });
      voiceTurns.recognizerStopped();
      if (!alwaysOn) { send('record', { state: 'idle' }); return; }
      // 起来 3 秒内就死的算一次失败。连续失败就退避，否则「授权没了」这种情况
      // 会每 1.2 秒刷一次日志、把 CPU 白烧掉。
      const lived = Date.now() - (asrStartedAt || 0);
      asrFailStreak = lived < 3000 ? asrFailStreak + 1 : 0;
      if (asrFailStreak >= 3) {
        const wait = Math.min(60000, 4000 * asrFailStreak);
        log(`[listen] 连续失败 ${asrFailStreak} 次，${Math.round(wait / 1000)} 秒后再试`);
        if (asrFailStreak === 3) {
          send('asrError', { message: '我听不见了（麦克风可能被系统关掉），去「系统设置 → 隐私与安全性 → 麦克风」把 workbunny 勾上。' });
        }
        scheduleListenRestart(wait);
      } else {
        scheduleListenRestart(1200);
      }
    });

    startMonitor();

    /* ── 心跳自愈：每 20 秒检查自己有没有坏掉 ─────────────────────────
     * 桌宠没人看着。坏了就自己修，别等主人发现"它又不理我了"。
     * 检查项都只看"该在的东西还在不在"，不做昂贵操作。 */
    selfHealTimer = setInterval(() => {
      try {
        const now = Date.now();
        // 1) 该在听却没在听（既没进程也没排着重启）→ 拉起来
        if (alwaysOn && asr && !asr.running && !listenRestartTimer) {
          log('[heal] 语音进程不见了，重新拉起');
          startListen('heal');
        }
        // 2) 窗口被毁了 → 重建
        if (!win || win.isDestroyed()) {
          log('[heal] 窗口没了，重建');
          createWindow();
          return;
        }
        // 3) 渲染进程死了 30 秒还没活过来（reload 也失败）→ 重建窗口
        if (rendererGoneAt && now - rendererGoneAt > 30000) {
          log('[heal] 渲染进程超过 30 秒没恢复，重建窗口');
          rendererGoneAt = 0;
          try { win.destroy(); } catch {}
          createWindow();
          return;
        }
        // 4) 闭麦卡住：说了半分钟还没开麦 → 强制开
        if (mutedSince && now - mutedSince > 30000) unmuteAsr('心跳超时');

        // 5) 看门狗自己掉队了 → 补一个。它和我们是互相兜底的关系：
        //    它看着我崩了就拉我，我看着它没了就重布防。
        ensureWatchdog();

      } catch (e) {
        log('[heal] 自检出错（忽略，继续跑）：' + e.message);
      }
    }, 20000);

    /* ── 看门狗：进程崩了得有人在场地外把它拉回来 ───────────────────
     * launchd 用不了（bootstrap 报 EIO），所以自己带一个脱离进程组的影子。
     * 它靠"父进程活着吗"来判断，主进程被 -9 / 段错误都拦不住它。 */
    startWatchdog();

    setTimeout(() => {
      // 一次性麦克风体检：把每个能收音的设备各开几秒，看谁的峰值高
      const c0 = config.load();
      if (c0.asr && c0.asr.probeAll) {
        config.save({ asr: { probeAll: false } });
        runMicProbeAll(Number(c0.asr.probeSec) || 3).then(() => {
          refreshAsrStatus({ timeoutMs: 4000 }).then((st) => { if (st && st.speech === 3) startListen('after-probe'); });
        });
        return;
      }
      refreshAsrStatus({ timeoutMs: 4000 })
        .then((st) => {
          if (st && st.speech === 3) startListen('boot');
        })
        .catch(() => {});
    }, 2200);

    try {
      globalShortcut.register('CommandOrControl+Shift+Space', () => {
        if (alwaysOn) stopListen();
        else startListen('hotkey');
      });
      globalShortcut.register('CommandOrControl+Shift+B', () => (win && win.isVisible() ? hideWindow() : showWindow()));
    } catch (e) {
      console.error('[hotkey]', e.message);
    }

    app.on('activate', () => showWindow());
  });
}

app.on('before-quit', () => {
  quitting = true;
  markCleanExit();
  closePanels();          // 面板是普通窗口，不关会拖住退出
  if (monitor) monitor.stop();
  voiceTurns.reset();
  if (asr) asr.kill();
  tts.shutdown();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
  // 桌宠常驻，不退出
  e.preventDefault?.();
});
