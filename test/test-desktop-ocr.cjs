'use strict';
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (!process.versions.electron) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-ocr-'));
  const electron = require('electron');
  const child = childProcess.spawn(electron, [
    `--user-data-dir=${path.join(tempDir, 'profile')}`, __filename, '--worker',
  ], { stdio: 'inherit', env: { ...process.env, WORKBUNNY_OCR_TMPDIR: tempDir } });
  child.on('error', error => { console.error(error); fs.rmSync(tempDir, { recursive: true, force: true }); process.exitCode = 1; });
  child.on('close', (code, signal) => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exitCode = code === 0 ? 0 : 1;
    if (signal) console.error(`Electron OCR fixture exited with ${signal}`);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const { DesktopNative } = require('../src/main/desktop-native');
  const tempDir = process.env.WORKBUNNY_OCR_TMPDIR;
  app.setPath('userData', path.join(tempDir, 'profile'));

  async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
    show: false,
    offscreen: true,
    width: 1000,
    height: 360,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true },
    });
    const native = new DesktopNative(path.join(__dirname, '..', 'bin', 'desktop'));
    try {
    const html = `<!doctype html><meta charset="utf-8"><canvas id="c" width="1000" height="360"></canvas>
      <script>
        const c=document.getElementById('c'),x=c.getContext('2d');
        x.fillStyle='#fff';x.fillRect(0,0,1000,360);x.fillStyle='#111';
        x.font='bold 48px -apple-system, sans-serif';
        x.fillText('文件传输助手',40,90);x.fillText('Hy3',40,190);x.fillText('0.00x',300,190);x.fillText('workbunny 你好',40,290);
      </script>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(requestAnimationFrame))');
    const png = await win.webContents.capturePage();
    const pngBytes = png.toPNG();
    const pngSize = png.getSize();
    assert.ok(pngBytes.length > 100 && pngBytes.length <= 8 * 1024 * 1024, `fixture PNG bytes=${pngBytes.length}`);
    const result = await native.request('recognize', { pngBase64: pngBytes.toString('base64') }, 30_000);
    assert.equal(result.width, pngSize.width);
    assert.equal(result.height, pngSize.height);
    assert.equal(result.width, 1000);
    assert.ok(Array.isArray(result.texts));
    const joined = result.texts.map(item => item.text).join('\n');
    for (const text of ['文件传输助手', 'Hy3', 'workbunny', '你好']) {
      assert.ok(joined.toLowerCase().includes(text.toLowerCase()), `OCR missing ${text}; got: ${joined}`);
    }
    const modelRow = result.texts.find(item => /^Hy3$/i.test(item.text.trim()));
    const freePrice = result.texts.find(item => /^0\.00x$/i.test(item.text.trim()));
    assert.ok(modelRow, `OCR missing exact Hy3 model label; got: ${joined}`);
    assert.ok(freePrice, `OCR missing exact 0.00x price; got: ${joined}`);
    assert.ok(Math.abs((modelRow.y + modelRow.height / 2) - (freePrice.y + freePrice.height / 2)) < 0.03,
      `Hy3 and 0.00x should map to the same original screenshot row: ${JSON.stringify({ modelRow, freePrice })}`);
    for (const item of result.texts) {
      assert.ok(item.confidence >= 0 && item.confidence <= 1);
      assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.width <= 1.001 && item.y + item.height <= 1.001);
      assert.ok(item.width > 0 && item.height > 0);
    }
    await assert.rejects(native.request('recognize', { pngBase64: 'bm90LWEtUE5H' }), /合法 PNG/);
    if (process.env.WORKBUNNY_VISION_LIVE === '1') {
      const { freeModel } = require('../src/main/workbuddy-free');
      const wb = require('../src/main/workbuddy');
      const model = await freeModel({ vision: true }), started = Date.now();
      const answer = await wb.chat({ model, thinking: 'low', maxTokens: 2300, messages: [
        { role: 'system', content: '只读取图片里的文字，按原文输出，不推测，不加说明。' },
        { role: 'user', content: [{ type: 'text', text: '列出图片中的三行文字。' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + pngBytes.toString('base64') } }] },
      ] });
      for (const word of ['文件传输助手', 'Hy3', 'workbunny']) assert.ok(answer.text.includes(word), `real vision missed ${word}`);
      const file = path.join(os.tmpdir(), 'workbunny-030-vision-live-result.json');
      fs.writeFileSync(file, JSON.stringify({ model, synthetic: true, ms: Date.now() - started, answer: answer.text, passed: true }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ vision: true, model, file }));
    }
      console.log(JSON.stringify({ ok: true, pngBytes: pngBytes.length, recognized: result.texts }));
    } finally {
      win.destroy();
      await native.close();
      app.quit();
    }
  }

  main().catch(error => { console.error(error); app.exit(1); });
}
