#!/usr/bin/env node
/* 离屏渲染动作定帧：给「脚有没有钉住、腿有没有被 IK 拉歪」留一份可以看的证据。
 * 用法：npx electron tools/anim-shots.cjs [动作名[:时间] ...]
 * 产物：shots/anim/<动作>-<模式>-<时间>.png
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'shots', 'anim');

const args = process.argv.slice(2).filter((a) => !a.startsWith('-') && !/\.(c|m)?js$/.test(a));
const modelArg = (process.argv.slice(2).find((a) => a.startsWith('--model=')) || '').replace('--model=', '');
const model = modelArg || 'AvatarSample_D.vrm';
const tag = modelArg ? model.replace(/\.vrm$/i, '') + '-' : '';
const jobs = [];
if (args.length) {
  for (const a of args) {
    const [name, t] = a.includes(':') ? a.split(':') : [a, '1.2'];
    jobs.push({ name, t: Number(t) });
  }
} else {
  for (const n of ['Angry', 'LookAround', 'Jump', 'Relax']) {
    for (const t of [0.4, 1.6, 2.8]) jobs.push({ name: n, t });
  }
}

console.log('[shots] 启动');
app.whenReady().then(async () => {
  console.log('[shots] ready');
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 420, height: 660, show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  const page = path.join(ROOT, 'src/renderer/dev-anim.html');
  await win.loadFile(page, { query: { m: model } });

  // 等就绪
  for (let i = 0; i < 120; i++) {
    const st = await win.webContents.executeJavaScript('({ ready: !!window.__ready, err: window.__error || null, rep: window.__report || "" })');
    if (st.err) { console.error('页面报错：', st.err); app.exit(1); return; }
    if (st.ready) { console.log('检视台就绪 |', st.rep); break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  for (const j of jobs) {
    for (const mode of ['raw', 'ik']) {
      const ok = await win.webContents.executeJavaScript(`window.__shot(${JSON.stringify(j.name)}, ${j.t}, ${JSON.stringify(mode)})`);
      if (ok !== true) { console.error(j.name, mode, ok); continue; }
      await new Promise((r) => setTimeout(r, 120));
      const img = await win.capturePage();
      const f = path.join(OUT, `${tag}${j.name}-${mode}-${j.t.toFixed(1)}.png`);
      fs.writeFileSync(f, img.toPNG());
      console.log('  ', path.relative(ROOT, f));
    }
  }
  app.exit(0);
});
