/* 设置面板截图：把 index.html 原样加载起来，但用一个假的 pet 桥喂配置，
 * 这样不用真启动应用也能拍到面板长什么样（含形象切换那一行）。
 * 用法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox \
 *        --use-angle=swiftshader --disable-gpu-sandbox tools/ui-shot.cjs [面板名]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const avatars = require('../src/main/avatars');

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
      window: { w: 400, h: 620 },
    },
    motions: [],
    avatar: '58.vrm',
    avatars: ${JSON.stringify(avatars.scan())},
    monitor: null, asrAvailable: true,
    versions: { electron: '', chrome: '' }, paths: { userData: '/tmp' },
  }),
  config: async (p) => p || {}, probe: async () => ({}), log: () => {},
  avatars: async () => ${JSON.stringify(avatars.scan())},
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
