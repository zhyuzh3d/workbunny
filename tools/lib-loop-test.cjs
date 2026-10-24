#!/usr/bin/env node
/* 复刻动作库浏览页的逐帧贴地回路，看它会不会把「静止的动作」抖起来。
 * 用法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox tools/lib-loop-test.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const cm = (x) => (x * 100).toFixed(2);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 420, height: 660, show: false, webPreferences: { contextIsolation: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/dev-anim.html'), { query: { m: 'AvatarSample_D.vrm' } });
  for (let i = 0; i < 160; i++) {
    const st = await win.webContents.executeJavaScript('({ ready: !!window.__ready, err: window.__error || null })');
    if (st.err) { console.error('页面报错：', st.err); app.exit(1); return; }
    if (st.ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const name of ['idle-maid', 'idle-sitting', 'grabbed']) {
    const r = await win.webContents.executeJavaScript(`window.__libLoop(${JSON.stringify(name)}, 3)`);
    if (r.error) { console.log(name, r.error); continue; }
    console.log(`${name.padEnd(13)} 头 Y ${cm(r.lo)}~${cm(r.hi)}  振幅 ${cm(r.amp)}cm  单帧最大跳 ${cm(r.stepMax)}cm`);
    console.log('   末 12 帧头高: ' + r.tail.map(cm).join(' '));
  }
  app.exit(0);
});
