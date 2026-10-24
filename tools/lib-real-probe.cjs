#!/usr/bin/env node
/* 直接打开动作库浏览页（真页面，不是复刻），连续采样 3 秒，看 idle-maid / idle-sitting 到底抖不抖。
 * 用法：node -> env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox tools/lib-real-probe.cjs [port]
 */
const { app, BrowserWindow } = require('electron');

const port = process.argv[2] || '8788';
const cm = (x) => (x * 100).toFixed(2);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { contextIsolation: false, webSecurity: false } });
  await win.loadURL(`http://127.0.0.1:${port}/vrma-library/index.html`);

  for (let i = 0; i < 120; i++) {
    const ok = await win.webContents.executeJavaScript('!!(window.__dbg && window.__dbg().ready)').catch(() => false);
    if (ok) { console.log('页面就绪'); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }

  for (const id of ['idle-maid', 'idle-sitting', 'grabbed', 'LookAround']) {
    const r = await win.webContents.executeJavaScript(`(async () => {
      window.__play(${JSON.stringify(id)});
      await new Promise(r => setTimeout(r, 400));      // 让它先稳定一下
      const hips = () => { const h = window.__dbg().hips; return h[1]; };
      const ys = [];
      await new Promise((done) => {
        let n = 0;
        const tick = () => { ys.push(hips()); if (++n < 180) requestAnimationFrame(tick); else done(); };
        requestAnimationFrame(tick);
      });
      let lo = Math.min(...ys), hi = Math.max(...ys), step = 0;
      for (let i = 1; i < ys.length; i++) step = Math.max(step, Math.abs(ys[i] - ys[i-1]));
      return { id: ${JSON.stringify(id)}, lo, hi, amp: hi - lo, step, tail: ys.slice(-10) };
    })()`);
    console.log(`${r.id.padEnd(13)} hips Y ${cm(r.lo)}~${cm(r.hi)}  振幅 ${cm(r.amp)}cm  单帧最大跳 ${cm(r.step)}cm`);
    console.log('   末 10 帧: ' + r.tail.map(cm).join(' '));
  }
  app.exit(0);
});
