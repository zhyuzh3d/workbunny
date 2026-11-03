'use strict';
// Explicit live acceptance: the real Bunny planner and native input path send
// one identified test message to File Transfer Assistant. Never auto-retry it.
const { app, nativeImage } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { DesktopNative } = require('../src/main/desktop-native');
const { DesktopService } = require('../src/main/desktop-service');
const { prepareVisionPreview } = require('../src/main/vision-preview');
const wb = require('../src/main/workbuddy');
const { parseObject } = require('../src/main/workbuddy-free');
const resumeAt = process.argv.indexOf('--resume');
const resumeDirectory = resumeAt >= 0 ? process.argv[resumeAt + 1] : null;
const temporary = resumeDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wechat-fullscreen-live-'));
fs.chmodSync(temporary, 0o700); app.setPath('userData', path.join(temporary, 'electron'));
const message = '［Bunny］ Bunny 外部全屏截图实测 2026-11-02 A1';
const recipient = '文件传输助手';
let service, finalReceipt;
const captures = [], phases = [], plans = [];
function save(name, value) { fs.writeFileSync(path.join(temporary, name), JSON.stringify(value, null, 2), { mode: 0o600 }); }
async function run() {
  await app.whenReady();
  await require('../src/main/model-catalog').refresh('workbuddy');
  const native = new DesktopNative(path.resolve('bin/desktop'));
  const request = native.request.bind(native);
  native.request = async (op, payload, timeout) => {
    if (op === 'capture') assert(!payload?.windowId && payload?.captureMode === 'displayStream', 'WeChat must use full-display capture only');
    const result = await request(op, payload, timeout);
    if (op === 'capture') {
      captures.push({ backend: result.backend, width: result.width, height: result.height, capturedAt: result.capturedAt });
      console.log(JSON.stringify({ fullDisplayFrame: captures.length, backend: result.backend, width: result.width, height: result.height }));
    }
    return result;
  };
  service = new DesktopService({ native,
    imageResize: png => prepareVisionPreview(nativeImage.createFromBuffer(png)),
    imageCrop: (png, rect) => nativeImage.createFromBuffer(png).crop(rect).toPNG(),
    persist: async task => save('task.json', task),
    modelRequest: async opts => {
      const result = await wb.chat({ ...opts, thinking: 'low', timeoutMs: 25000 });
      try {
        const value = parseObject(result.text);
        plans.push({ action: value.action, purpose: value.purpose, completed: value.completed });
        if (value.action === 'done' && value.completed) finalReceipt = value.receipt;
        console.log(JSON.stringify({ bunnyPlan: value.action, purpose: value.purpose, completed: value.completed }));
      } catch { /* Service validates and may repeat read-only planning. */ }
      return result;
    },
    emit: status => {
      if (phases.at(-1) !== status.task?.status) {
        phases.push(status.task?.status); console.log(JSON.stringify({ phase: status.task?.status }));
      }
    },
  });
  if (resumeDirectory) {
    const saved = JSON.parse(fs.readFileSync(path.join(temporary, 'task.json'), 'utf8'));
    assert.equal(saved.target, 'wechat'); assert.equal(saved.recipient, recipient); assert.equal(saved.message, message);
    service.task = saved;
  }
  const start = resumeDirectory ? await service.resume({ sources: [] }) : await service.start({ target: 'wechat', recipient, operation: 'send', origin: 'panel', inputSource: 'text',
    goal: `只向文件传输助手发送这条测试消息一次：${message}。核对本次新增的完整已发送气泡和清空的输入框。`,
    message, criteria: '本次新增右侧气泡逐字等于 message，输入框已清空；没有重复发送。', workModel: 'deepseek-v4.1-flash' });
  assert(start.ok, start.error);
  const until = Date.now() + 150000;
  while (service.running && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 150));
  if (service.running) await service.stop('真实验收达到时限，保留发送状态，禁止自动重试');
  const task = service.task;
  save('result.json', { taskId: task.id, recipient, message, status: task.status, sendState: task.sendState,
    submitAttemptedAt: task.submitAttemptedAt, note: task.note, steps: task.steps, captures, phases, plans });
  assert.equal(task.status, 'review', task.note);
  assert.equal(task.sendState, 'confirmed', 'the new outgoing bubble was not confirmed');
  assert.equal(task.steps.filter(s => s.purpose === 'submit' && s.state === 'input-sent').length, 1);
  assert(finalReceipt?.bubble, 'visual bubble receipt missing');
  const normalize = text => String(text).normalize('NFKC').replace(/\s/gu, '');
  const rows = service.screenshot.ocr.filter(row => row.x > .25 && row.y > .15 &&
    row.y + row.height < finalReceipt.composer.y && normalize(row.text) === normalize(message));
  assert(rows.length, 'local pixel OCR did not independently confirm the exact new message above the composer');
  save('visual-receipt.json', { receipt: finalReceipt, exactOCRRows: rows, backend: service.screenshot.captureSource });
  const image = nativeImage.createFromDataURL(service.screenshot.preview), size = image.getSize();
  // Model boxes can be coarse. Export evidence around the independently read
  // text, so a successful run never produces a picture of an empty bubble edge.
  const x = Math.max(0, Math.floor(Math.min(...rows.map(r => r.x)) * size.width) - 9);
  const y = Math.max(0, Math.floor(Math.min(...rows.map(r => r.y)) * size.height) - 9);
  const right = Math.min(size.width, Math.ceil(Math.max(...rows.map(r => r.x + r.width)) * size.width) + 9);
  const bottom = Math.min(size.height, Math.ceil(Math.max(...rows.map(r => r.y + r.height)) * size.height) + 9);
  const width = right - x, height = bottom - y;
  fs.writeFileSync(path.join(temporary, 'confirmed-bubble.png'), image.crop({ x, y, width, height }).toPNG(), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, recipient, message, sendState: task.sendState, steps: task.steps.length, evidenceDirectory: temporary }));
}
run().then(() => finish(0), error => {
  console.error(JSON.stringify({ passed: false, reason: error.message, evidenceDirectory: temporary, sendState: service?.task?.sendState }));
  return finish(1);
});
async function finish(code) { await service?.close(); app.exit(code); }
