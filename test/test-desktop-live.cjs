'use strict';
// Explicit live acceptance: opens only our fixture window, uses free WorkBuddy vision,
// and sends CGEvents only after confirming this Electron PID is frontmost.
// Run: node_modules/.bin/electron test/test-desktop-live.cjs
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { DesktopNative } = require('../src/main/desktop-native');
const { DesktopService } = require('../src/main/desktop-service');
const { freeModel } = require('../src/main/workbuddy-free');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-desktop-live-'));
app.setPath('userData', path.join(tmp, 'userData'));
let native, service, win;
const pause = ms => new Promise(r => setTimeout(r, ms));
const resultFile = path.join(os.tmpdir(), 'workbunny-030-desktop-live-result.json');
async function run() {
  await app.whenReady();
  native = new DesktopNative(path.resolve(__dirname, '../bin/desktop'));
  const permissions = await native.request('permissions');
  assert.equal(permissions.sessionLocked, false, '电脑已锁屏，真实桌面验收暂停；没有发送输入');
  assert.ok(permissions.accessibilityTrusted && permissions.screenCaptureAllowed && permissions.postEventAllowed, 'live fixture requires existing desktop permissions');
  const model = await freeModel({ vision: true });
  win = new BrowserWindow({ width: 640, height: 480, title: 'workbunny 专用测试窗口', webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.setMenuBarVisibility(false);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{margin:36px;font:20px system-ui;background:#faf8f3;color:#272c31}h1{font-size:25px}textarea{display:block;width:500px;height:90px;font:22px system-ui;border:2px solid #999;border-radius:8px;padding:8px}button{background:#234e96;color:white;font:20px system-ui;padding:12px 30px;border:0;border-radius:8px;margin-top:24px}#result{margin-top:24px;font-size:24px;color:#187843}</style><h1>workbunny 视觉操作测试</h1><p>请在下面输入“workbunny视觉测试”，再点击核对。</p><textarea id="input" aria-label="测试输入框"></textarea><button id="check">核对</button><div id="result">等待输入</div><script>document.getElementById('check').onclick=()=>{document.getElementById('result').textContent=document.getElementById('input').value==='workbunny视觉测试'?'通过：文字完全正确':'未通过：内容不一致'}</script></html>`));
  win.show(); win.focus(); app.focus({ steal: true }); await pause(700);
  const front = await native.request('frontmost');
  assert.equal(front.application.pid, process.pid, 'never type into another process');
  const window = front.windows.find(w => w.pid === process.pid && w.layer === 0 && w.rect.width > 300);
  assert.ok(window);
  // Exercise Unicode and modifier handling separately from the model.
  await win.webContents.executeJavaScript("document.getElementById('input').focus()");
  const expected = front.application, unicode = 'abcdefghijklmnopqrs🙂中文测试🙂';
  await native.request('type', { expected, windowId: window.windowId, text: unicode }, 8000); await pause(250);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('input').value"), unicode);
  await native.request('key', { expected, windowId: window.windowId, key: 'a', modifiers: ['cmd'] }, 8000);
  await native.request('key', { expected, windowId: window.windowId, key: 'backspace' }, 8000); await pause(250);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('input').value"), '');
  await win.webContents.executeJavaScript("document.getElementById('input').blur()");
  const events = [], journals = [];
  service = new DesktopService({ native, fixturePid: process.pid, emit: status => { events.push({ status: status.task?.status, note: status.task?.note }); console.log(JSON.stringify({ status: status.task?.status, note: status.task?.note })); },
    persist: async task => journals.push(JSON.parse(JSON.stringify(task))),
    imageResize: png => { const image = nativeImage.createFromBuffer(png); return image.resize({ width: 1280 }).toPNG(); } });
  const started = Date.now();
  const response = await service.start({ target: 'current', goal: '这是独立测试窗口。请在唯一的文本框里输入完整准确的“workbunny视觉测试”，再点击“核对”按钮。只有截图看到绿色的“通过：文字完全正确”才能完成。不要操作任何其他窗口。' });
  assert.ok(response.ok, response.error);
  while (service.running && Date.now() - started < 180000) await pause(250);
  const value = await win.webContents.executeJavaScript("({value:document.getElementById('input').value,result:document.getElementById('result').textContent})");
  const result = { model, ms: Date.now() - started, status: service.task?.status, note: service.task?.note, steps: service.task?.steps, unicode: true, screenshotVerification: value.result === '通过：文字完全正确', value };
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  assert.equal(service.task?.status, 'review', JSON.stringify(result));
  assert.equal(value.result, '通过：文字完全正确');
  await service.accept(); assert.equal(service.task.status, 'accepted');
  console.log(JSON.stringify({ passed: true, model, ms: result.ms, steps: result.steps.length, resultFile }));
}
run().then(() => finish(0), e => { console.error(e.stack || e); finish(1); });
function finish(code) { service?.close(); native?.cancel?.(); native?.close(); win?.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); app.exit(code); }
