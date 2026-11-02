'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DesktopService } = require('../src/main/desktop-service');
const bundleId = 'com.tencent.xinWeChat', scope = { bundleId, pid: 123, windowId: 7 };
const screen = { x: 0, y: 0, width: 1920, height: 1080 };
function fixture({ backend = 'CGDisplayStream', stale = false, move = false, switchApp = false } = {}) {
  let rect = { x: 100, y: 80, width: 800, height: 600 }, captures = 0, captured = false;
  const calls = [], crops = [];
  const native = { async request(op, payload) {
    calls.push({ op, payload });
    if (op === 'frontmost') return { application: { bundleId: captured && switchApp ? 'other.app' : bundleId, pid: 123 },
      windows: [{ windowId: 7, pid: 123, layer: 0, rect: { ...rect } }] };
    if (op === 'capture') {
      captured = true; captures++;
      if (move && captures === 1) rect = { ...rect, x: 200 };
      return { backend, capturedAt: Date.now() - (stale ? 6000 : 0), desktopRect: screen, width: 3840, height: 2160, pngBase64: Buffer.from('full-display').toString('base64') };
    }
    if (op === 'recognize') return { texts: [{ text: '文件传输助手', x: .4, y: .08, confidence: 1 }] };
    throw Error('unexpected native operation: ' + op);
  } };
  const service = new DesktopService({ native, imageCrop: (data, rect) => { crops.push(rect); assert.equal(data.toString(), 'full-display'); return Buffer.from('crop'); } });
  service.running = true; service.generation = 1;
  return { service, calls, crops };
}
test('WeChat captures full-display pixels without a window ID and crops in pixel coordinates', async () => {
  const { service, calls, crops } = fixture();
  const shot = await service.capture(scope, 1);
  assert.deepEqual(calls.find(c => c.op === 'capture').payload, { captureMode: 'displayStream', output: 'base64' });
  assert.deepEqual(crops, [{ x: 200, y: 160, width: 1600, height: 1200 }]);
  assert.equal(shot.captureSource, 'CGDisplayStream'); assert.deepEqual(shot.rect, { x: 100, y: 80, width: 800, height: 600 });
  assert.deepEqual(shot.sourceRect, screen);
});
test('Unverified and stale display frames cannot authorize WeChat input', async () => {
  for (const options of [{ backend: 'ScreenCaptureKit' }, { stale: true }]) {
    const { service, calls, crops } = fixture(options);
    await assert.rejects(service.capture(scope, 1), /可靠的外部全屏新画面/);
    assert.equal(crops.length, 0); assert(!calls.some(c => ['click', 'type', 'key'].includes(c.op)));
  }
});
test('Window movement reacquires the full display and uses the new region', async () => {
  const { service, calls, crops } = fixture({ move: true });
  const shot = await service.capture(scope, 1);
  assert.equal(calls.filter(c => c.op === 'capture').length, 2);
  assert.deepEqual(crops, [{ x: 400, y: 160, width: 1600, height: 1200 }]); assert.equal(shot.rect.x, 200);
});
test('A foreground switch stops before cropping or input', async () => {
  const { service, crops } = fixture({ switchApp: true });
  await assert.rejects(service.capture(scope, 1), /目标应用切换/); assert.equal(crops.length, 0);
});
