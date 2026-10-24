/* 设置面板截图：把 index.html 原样加载起来，但用一个假的 pet 桥喂配置，
 * 这样不用真启动应用也能拍到面板长什么样（含形象切换那一行）。
 * 用法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox \
 *        --use-angle=swiftshader --disable-gpu-sandbox tools/ui-shot.cjs [面板名]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const avatars = require('../src/main/avatars');
const appConfig = require('../src/main/config');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'shots', 'ui');
const want = process.argv.slice(2).find((a) => !a.startsWith('-') && !/\.(c|m)?js$/.test(a)) || 'settings';

const STUB = `
window.pet = {
  init: async () => ({
    config: {
      avatar: '58.vrm',
      buddy: { name: 'baby' },
      llm: { baseURL: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-bolt-e4b', apiKey: '' },
      tts: { enabled: true, baseURL: '', apiKey: '', instructions: '' },
      voice: { enabled: true, alwaysListen: true, device: '' },
      monitor: { speakOnDone: true, speakOnLong: true, speakOnStall: true, speakOnRest: true, minGapMs: 40000 },
      window: { w: 400, h: 620, scale: 1 },
    },
    motions: ${JSON.stringify(appConfig.MOTIONS)},
    motionGroups: ${JSON.stringify(appConfig.MOTION_GROUPS)},
    avatar: '58.vrm',
    avatars: ${JSON.stringify(avatars.scan())},
    monitor: null, asrAvailable: true,
    versions: { electron: '', chrome: '' }, paths: { userData: '/tmp' },
  }),
  config: async (p) => p || {}, probe: async () => ({}), log: () => {},
  avatars: async () => ${JSON.stringify(avatars.scan())},
  scale: async (k) => { window.__scaleAsked = k; return { scale: k }; },
  hit: () => {}, asrStatus: async () => ({ speech: 3, mic: true, note: 'ok' }),
  openPrivacy: () => {}, audioDone: () => {},
  on: (cb) => { window.__emit = (d) => cb(d); },
  send: () => {},
};
`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // 预加载脚本得在窗口创建前落盘（Electron 在 loadFile 时才读，但别赌顺序）
  const preloadFile = path.join(__dirname, 'ui-shot-preload.cjs');
  fs.writeFileSync(preloadFile, STUB);

  const win = new BrowserWindow({
    width: 400, height: 620, show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      webgl: true,
      preload: preloadFile,
    },
  });

  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  // 等 boot 跑完（loadMotions 是假数据，很快；模型要真加载）
  for (let i = 0; i < 60; i++) {
    const st = await win.webContents.executeJavaScript('({ ready: !!window.__pet && window.__pet().vrm, err: window.__err || null, boot: window.__bootErr || null, clips: window.__pet ? window.__pet().clips : -1 })');
    if (st.boot) { console.error('启动失败：', st.boot); break; }
    if (st.err) { console.error('渲染层报错：', st.err); break; }
    if (st.ready) break;
    if (i % 10 === 9) console.log('   …等模型', i + 1, 'clips=', st.clips);
    await new Promise((r) => setTimeout(r, 400));
  }

  if (want === 'settings') {
    await win.webContents.executeJavaScript('window.__openSettings && window.__openSettings()');
    // 注意：这个环境里，一旦 WebGL 画布画出过东西，capturePage 有时拿不到
    // 压在画布上的大面积面板（软件渲染 + backdrop-filter 的老毛病，真机没有）。
    // 所以面板的验收以 DOM 断言为准（dbg 里的 btnCount/classes/settingsCls），别只看图。
  }

  if (want === 'dismiss') {
    // ✓ 逐条收起 → 最后「空闲中」：一条一条点掉，每一步都记下横幅文字和 class
    await win.webContents.executeJavaScript(`window.__emit({
      type: 'monitor', sessionId: 's1', phase: 'running', runningCount: 2,
      tasks: [
        { sessionId: 's1', taskId: 11, name: '把这个项目的打包脚本和图标一起改一遍顺便看看日志有没有问题', status: 'running', durationMs: 380000 },
        { sessionId: 's2', taskId: 12, name: '把测试全跑一遍', status: 'running', durationMs: 125000 },
        { sessionId: 's3', taskId: 13, name: '修好打包脚本', status: 'ok', durationMs: 96000 },
      ],
    })`);
    await new Promise((r) => setTimeout(r, 600));
    const shot = async (n) => {
      const st = await win.webContents.executeJavaScript(`({
        text: document.getElementById('activityText').textContent,
        cls: document.getElementById('activity').className,
        dot: getComputedStyle(document.querySelector('#activity .dot')).animationName,
        act: window.__act ? window.__act() : null,
      })`);
      console.log(`   [${n}] ${st.text}  · class="${st.cls}" dot=${st.dot}`);
      if (st.act) console.log(`        keys=${JSON.stringify(st.act.keys)} idx=${st.act.idx} seen=${JSON.stringify(st.act.seen)}`);
      const geo = await win.webContents.executeJavaScript(`(() => {
        const a = document.getElementById('activity').getBoundingClientRect();
        const f = document.getElementById('fab').getBoundingClientRect();
        const g = document.getElementById('gearBtn').getBoundingClientRect();
        return { actW: Math.round(a.width), actRight: Math.round(a.right),
                 gearLeft: Math.round(g.left), gap: Math.round(g.left - a.right), vw: innerWidth };
      })()`);
      console.log(`        状态条宽 ${geo.actW}px · 右边缘 ${geo.actRight} · 齿轮左边缘 ${geo.gearLeft} · 间隙 ${geo.gap}px (窗口 ${geo.vw})`);
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, `dismiss-${n}.png`), (await win.capturePage()).toPNG());
      return st;
    };
    await shot(0);
    for (const i of [1, 2, 3]) {
      await win.webContents.executeJavaScript(`document.getElementById('actDone').click()`);
      await new Promise((r) => setTimeout(r, 450));
      await shot(i);
    }
  }

  if (want === 'activity') {
    // 三件同时在跑：状态条应该自己轮播，隔 4 秒拍两张看是不是换了行
    await win.webContents.executeJavaScript(`window.__emit({
      type: 'monitor', sessionId: 's1', phase: 'running', runningCount: 3,
      tasks: [
        { sessionId: 's1', name: '改一下登录页的样式', status: 'running', durationMs: 380000 },
        { sessionId: 's2', name: '把测试全跑一遍', status: 'running', durationMs: 125000 },
        { sessionId: 's3', name: '整理接口文档', status: 'running', durationMs: 40000 },
        { sessionId: 's4', name: '修好打包脚本', status: 'ok', durationMs: 96000 },
      ],
    })`);
    await new Promise((r) => setTimeout(r, 700));
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'activity-1.png'), (await win.capturePage()).toPNG());
    // 等到下一次轮播（3.8 秒一轮）
    await new Promise((r) => setTimeout(r, 4200));
    fs.writeFileSync(path.join(OUT, 'activity-2.png'), (await win.capturePage()).toPNG());
    const line = await win.webContents.executeJavaScript('document.getElementById("activityText").textContent');
    console.log('   第二帧：', line);
  }

  if (want === 'motions') {
    /* 新接入的动作逐个过一遍真实的渲染层（window.__emit → app.js → 切段 → 锁脚）。
     * 这是"接线通了"的证据：动作名能播、切段后的时长对、待机会随场景切换。 */
    const extra = process.argv.slice(2).filter((a) => !a.startsWith('-') && !/\.(c|m)?js$/.test(a));
    const list = extra.slice(1);        // 第一个位置是模式名 'motions'
    const keys = list.length ? list : ['greeting2', 'peace_sign', 'spin', 'hello', 'show_full_body',
      'VRMA_07', 'shoot', 'model_pose', 'motion_pose', 'greeting', 'grabbed'];
    fs.mkdirSync(OUT, { recursive: true });
    const emit = (o) => win.webContents.executeJavaScript(`window.__emit(${JSON.stringify(o)})`);
    const cur = async () => (await win.webContents.executeJavaScript('window.__pet()')).currentMotion;
    const snap = async (n) => {
      fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG());
    };
    const clips = (await win.webContents.executeJavaScript('window.__pet()')).clips;
    console.log(`   载入动作 ${clips} 条`);

    // ① 闲着：待机应该是 idle_loop
    await emit({ type: 'phase', phase: 'idle' });
    await new Promise((r) => setTimeout(r, 700));
    console.log(`   phase=idle    → ${await cur()}  (期望 idle_loop)`);
    await snap('idle-idle_loop');

    // ② 主人在干活：待机应该换成 idle-maid
    await emit({ type: 'phase', phase: 'work' });
    await new Promise((r) => setTimeout(r, 900));
    console.log(`   phase=work    → ${await cur()}  (期望 idle-maid)`);
    await snap('idle-work');
    await new Promise((r) => setTimeout(r, 1200));
    await snap('idle-work-2');

    // ③ 逐个动作
    for (const k of keys) {
      await emit({ type: 'motion', key: k, once: true });
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 1150));
      const m = await cur();
      await snap(`motion-${k}`);
      console.log(`   ${k.padEnd(14)} → ${m}  (${Date.now() - t0}ms 后)`);
      await new Promise((r) => setTimeout(r, 800));
    }

    // ④ 收工：phase=done 应该播庆祝（spin），且重复上报不再反复播
    await new Promise((r) => setTimeout(r, 1500));
    await emit({ type: 'phase', phase: 'done' });
    await new Promise((r) => setTimeout(r, 800));
    console.log(`   phase=done    → ${await cur()}  (期望 spin 或 Clapping)`);
    await snap('phase-done');

    // ⑤ 离开半小时后回来说第一句话 → 起身迎接
    await win.webContents.executeJavaScript('window.__away(40*60e3)');
    await emit({ type: 'chat', role: 'user', text: '我回来了' });
    await new Promise((r) => setTimeout(r, 900));
    console.log(`   回来第一句    → ${await cur()}  (期望 greeting)`);
    await snap('greeting-return');
  }

  if (want === 'ui') {
    /* UI 整体验收：顶栏对齐、脚下那条的三种状态、半身/全身/加宽三档构图、
     * 动作面板能不能点、切换角色时是不是转圈而不是空白。 */
    fs.mkdirSync(OUT, { recursive: true });
    const shot = async (n) => fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.capturePage()).toPNG());
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    /* 这个离屏窗口里 compositor 不推进：CSS 过渡/动画停在第一帧，
     * 带 backdrop-filter 的面板也经常拍不到。所以量数值前先关掉过渡，
     * 拍面板前先停渲染循环（和 window.__freeze 的用途一样）。 */
    const noAnim = () => js(`(() => {
      if (document.getElementById('__test')) return true;
      const s = document.createElement('style');
      s.id = '__test';
      s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
      document.head.appendChild(s);
      return true;
    })()`);
    // __freeze(true) = 停渲染循环；__freeze(false) = 继续
    const shotPanel = async (n) => {
      await js('window.__freeze && window.__freeze(true)');
      await wait(120);
      await shot(n);
      await js('window.__freeze && window.__freeze(false)');
    };
    await noAnim();

    const frame = async (tag) => {
      const f = await js('window.__frame()');
      console.log(`   [${tag}] 窗口 ${f.w}×${f.h} · scale=${f.scale}${f.bust ? ' (半身)' : ' (全身)'} · ` +
        `头顶 y=${f.top} 脚底 y=${f.bottom} · 头骨 y=${f.head ? f.head.y : '-'}`);
      return f;
    };

    // ① 顶栏三件是否同一条中线（状态条要有任务才显示，先喂一条）
    await js(`window.__emit({ type: 'monitor', sessionId: 's1', phase: 'running', runningCount: 1,
      tasks: [{ sessionId: 's1', taskId: 1, name: '把登录页的样式再顺一遍', status: 'running', durationMs: 62000 }] })`);
    await wait(500);
    const align = await js(`(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const a = r('activity'), g = r('gearBtn'), m = r('muteBtn'), b = r('motionBtn');
      const c = (x) => Math.round(x.top + x.height / 2);
      return { act: c(a), gear: c(g), mute: c(m), motion: c(b),
               hAct: Math.round(a.height), hBtn: Math.round(g.height) };
    })()`);
    console.log(`   顶栏中线：状态条 ${align.act} · 动作钮 ${align.motion} · 喇叭 ${align.mute} · 齿轮 ${align.gear}` +
      `  （高度 ${align.hAct} / ${align.hBtn}）`);

    // ② 光标：所有能点的地方必须是手型
    const cursors = await js(`(() => {
      const q = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).cursor : 'missing'; };
      return { gear: q('#gearBtn'), mute: q('#muteBtn'), motion: q('#motionBtn'),
               ear: q('#ear'), done: q('#actDone'), av: q('#avRow button'), seg: q('#sizeRow button') };
    })()`);
    console.log('   光标：', JSON.stringify(cursors));

    // ③ 脚下那条：关着 = 灰、在听 = 绿、有声音 = 电平条在跳、有话说 = 撑满并滚动
    const earStates = await js(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const ear = document.getElementById('ear');
      const dotC = () => getComputedStyle(document.querySelector('#ear .earDot')).backgroundColor;
      const barsD = () => getComputedStyle(document.querySelector('#ear .bars')).display;
      const out = {};
      window.__listen(false);
      await sleep(320);
      out.off = { cls: ear.className, dot: dotC(), bars: barsD() };
      window.__listen(true);
      await sleep(320);
      out.on = { cls: ear.className, dot: dotC(), bars: barsD() };
      window.__level(0.85);
      await sleep(200);
      out.loud = { cls: ear.className, dot: dotC(), h: Math.round(document.querySelector('#ear .bars i').getBoundingClientRect().height) };
      window.__heard('这是一个很长很长很长很长的句子，用来验证超出宽度的时候会自动向右滚动而不是打省略号', true);
      await sleep(460);
      const win_ = document.getElementById('earTxt').parentElement;
      out.text = { cls: ear.className, w: Math.round(ear.getBoundingClientRect().width), vw: innerWidth,
                   textW: document.getElementById('earTxt').scrollWidth, winW: Math.round(win_.clientWidth),
                   anims: document.getElementById('earTxt').getAnimations().length };
      return out;
    })()`);
    console.log('   脚下条 关:', earStates.off.cls, earStates.off.dot, `bars=${earStates.off.bars}`);
    console.log('   脚下条 听:', earStates.on.cls, earStates.on.dot, `bars=${earStates.on.bars}`);
    console.log(`   脚下条 大声: bars 高 ${earStates.loud.h}px  class=${earStates.loud.cls}`);
    console.log(`   脚下条 说话: 宽 ${earStates.text.w}/${earStates.text.vw} · 文字 ${earStates.text.textW} / 窗口 ${earStates.text.winW} · 滚动动画 ${earStates.text.anims}`);
    await shot('ear-live');

    // ④ 三档构图
    await js('window.__dock("close"); window.__heard("", false)');
    await js('window.__listen(true)');
    await wait(400);
    await frame('100%');
    await shot('scale-100');

    await js('window.__scale(0.5)');
    await wait(700);
    await frame('50%');
    await shot('scale-50');

    await js('window.__scale(1.5)');
    await wait(300);
    win.setContentSize(600, 930);
    await wait(900);
    await frame('150%');
    await shot('scale-150');
    win.setContentSize(400, 620);
    await js('window.__scale(1)');
    await wait(800);

    // ⑤ 动作库（独立窗口）：这边只能验"槽位随机能不能挑出真动作"，
    //    面板本身的渲染要看 panel.html，不在本窗口里。
    const slots = await js('window.__motions()');
    console.log(`   动作库：${slots.count} 条 · ${slots.groups} 组 · 槽位 ${slots.slots.length} 个`);
    const picked = [];
    for (const sl of ['cheer', 'think', 'shy']) picked.push(await js(`window.__playSlot('${sl}')`));
    await wait(700);
    const playing = await js('window.__pet().currentMotion');
    console.log(`   槽位随机 cheer/think/shy → ${JSON.stringify(picked)} · 当前播 ${playing}`);
    await shot('slot-random');

    // ⑥ 设置面板：底部抽屉，头必须露在上面
    await js('window.__openSettings()');
    await wait(700);
    const cover = await js(`(() => {
      const s = document.getElementById('settings').getBoundingClientRect();
      const f = window.__frame();
      const cur = (q) => { const e = document.querySelector(q); return e ? getComputedStyle(e).cursor : 'missing'; };
      return { panelTop: Math.round(s.top), panelLeft: Math.round(s.left), panelRight: Math.round(s.right),
               vw: innerWidth, vh: innerHeight, headTop: f.top, modelX: f.modelX,
               curAv: cur('#avRow button'), curSeg: cur('#sizeRow button'), curMini: cur('#openMotions'), curWide: cur('#saveBtn') };
    })()`);
    console.log(`   设置抽屉 top=${cover.panelTop}（左 ${cover.panelLeft} 右 ${cover.panelRight} / 窗 ${cover.vw}）· 头顶 y=${cover.headTop} · 角色让位 x=${cover.modelX}`);
    console.log(`   设置里光标：形象=${cover.curAv} 大小=${cover.curSeg} 动作=${cover.curMini} 保存=${cover.curWide}`);
    await shotPanel('settings-sheet');

    // ⑦ 换角色：转圈 + 文案，其他 UI 仍在
    await js('window.__avatar("AvatarSample_G.vrm")');
    await wait(90);
    const during = await js(`(() => {
      const l = document.getElementById('loading');
      return { loading: !l.classList.contains('hidden'), txt: document.getElementById('loadingTxt').textContent,
               settings: !document.getElementById('settings').classList.contains('hidden'),
               activity: !document.getElementById('activity').classList.contains('hidden'),
               ear: document.getElementById('ear').className,
               fab: document.getElementById('fab').className };
    })()`);
    console.log(`   换角色中：转圈=${during.loading} 「${during.txt}」 设置抽屉在=${during.settings} 状态条在=${during.activity} 脚下条=${during.ear} 顶栏=${during.fab}`);
    await shotPanel('avatar-loading');
    await wait(5000);
    const after = await js(`({ avatar: window.__pet().avatarKey, loading: !document.getElementById('loading').classList.contains('hidden'),
      light: window.__light ? window.__light() : null })`);
    console.log(`   换完：${after.avatar} · 转圈已收=${!after.loading} · 灯光 ${JSON.stringify(after.light)}`);
    await js('window.__closeSettings ? window.__closeSettings() : document.getElementById("closeSettings").click()');
    await wait(400);
    await shot('avatar-last-dark');
  }

  await new Promise((r) => setTimeout(r, 900));
  const dbg = await win.webContents.executeJavaScript(`({
    href: location.href,
    hasPet: !!window.pet, hasPetHook: !!window.__pet, hasOpen: !!window.__openSettings,
    avatarKey: (window.__pet ? window.__pet().avatarKey : 'NO-HOOK'),
    bootErr: window.__bootErr || null,
    settingsCls: document.getElementById('settings').className,
    btnCount: document.querySelectorAll('#avRow button').length,
    classes: [...document.querySelectorAll('#avRow button')].map(b => b.className).join(','),
  })`);
  console.log('   dbg:', JSON.stringify(dbg));
  const img = await win.capturePage();
  const f = path.join(OUT, `${want}.png`);
  fs.writeFileSync(f, img.toPNG());
  console.log('  ', path.relative(ROOT, f));
  app.exit(0);
});
