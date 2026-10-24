#!/usr/bin/env node
/* 竖直轨迹探针：逐帧记下头/髋/脚的世界高度，用来判决「上下抖动」抖在哪一节。
 * 用法：npx electron tools/trace-anim.cjs [动作名 ...] [--model=xx.vrm]
 * 输出：每条动作的 Y 振幅、单帧最大跳变、以及 12 点采样（cm）
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('-') && !/\.(c|m)?js$/.test(a));
const modelArg = (process.argv.slice(2).find((a) => a.startsWith('--model=')) || '').replace('--model=', '');
const model = modelArg || 'AvatarSample_D.vrm';
const jobs = args.length ? args : ['idle_loop', 'idle-maid', 'idle-sitting', 'grabbed'];

const cm = (x) => (x * 100).toFixed(1);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 660, show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/dev-anim.html'), { query: { m: model } });

  for (let i = 0; i < 160; i++) {
    const st = await win.webContents.executeJavaScript('({ ready: !!window.__ready, err: window.__error || null, rep: window.__report || "" })');
    if (st.err) { console.error('页面报错：', st.err); app.exit(1); return; }
    if (st.ready) { console.log('就绪 |', st.rep, '\n'); break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  for (const name of jobs) {
    for (const mode of ['raw', 'ik']) {
      const t = await win.webContents.executeJavaScript(`window.__trace(${JSON.stringify(name)}, ${JSON.stringify(mode)})`);
      if (!t || t.error) { console.log(`${name} [${mode}] 无此动作`); continue; }
      const s = t.summary;
      const f = (k) => (s[k] ? `Y ${cm(s[k].lo)}~${cm(s[k].hi)} 振幅${cm(s[k].amp)} 单帧跳${cm(s[k].stepMax)}` : '—');
      console.log(`${name.padEnd(14)} [${mode}] ${String(t.dur).padStart(5)}s`);
      console.log(`   头  ${f('head')}`);
      console.log(`   髋  ${f('hips')}`);
      console.log(`   左脚 ${f('lf')}   右脚 ${f('rf')}`);
      const step = Math.max(1, Math.floor(t.series.head.length / 12));
      console.log('   头采样 ' + t.series.head.filter((v, i) => i % step === 0).map(cm).join(' '));
      const hstep = Math.max(1, Math.floor(t.series.hips.length / 12));
      console.log('   髋采样 ' + t.series.hips.filter((v, i) => i % hstep === 0).map(cm).join(' '));
      console.log('');
    }
  }
  app.exit(0);
});
