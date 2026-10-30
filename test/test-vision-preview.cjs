'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, nativeImage } = require('electron');
const { prepareVisionPreview } = require('../src/main/vision-preview');

function bitmap(width, height, pixelAt) {
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const [r, g, b] = pixelAt(x, y);
    bytes[i] = r; bytes[i + 1] = g; bytes[i + 2] = b; bytes[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(bytes, { width, height, scaleFactor: 1 });
}

function createTextImage() {
  const width = 1400, height = 850;
  const rows = [
    'WORKBUNNY DESKTOP VISION TEST',
    'White background with visible text lines',
    '1234567890  TASK STATUS  READY',
    'This image checks OCR PNG sizing and decoding.',
  ];
  return bitmap(width, height, (x, y) => {
    if (x < 50 || x >= width - 50 || y < 40 || y >= height - 40) return [255, 255, 255];
    const row = Math.floor((y - 100) / 150);
    if (row < 0 || row >= rows.length) return [255, 255, 255];
    const col = Math.floor((x - 70) / 14);
    const char = rows[row][col];
    if (!char || char === ' ') return [255, 255, 255];
    const gx = Math.floor(((x - 70) % 14) / 2);
    const gy = Math.floor(((y - 100 - row * 150) % 14) / 2);
    const seed = char.charCodeAt(0) * 1103515245 + gx * 12345 + gy * 2654435761;
    const ink = ((seed >>> ((gx + gy) % 16)) & 3) !== 0 && gx < 6 && gy < 6;
    return ink ? [35, 40, 46] : [255, 255, 255];
  });
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-vision-test-'));
  app.setPath('userData', userData);
  await app.whenReady();
  try {
    const texture = bitmap(2048, 1365, (x, y) => {
      const n = Math.sin(x * 0.081 + Math.sin(y * 0.017) * 2.1) + Math.cos(y * 0.073 + Math.sin(x * 0.013) * 1.7);
      const grain = ((Math.floor(x / 3) * 17 + Math.floor(y / 2) * 29 + (x * y) % 31) % 29) - 14;
      return [
        Math.max(0, Math.min(255, 124 + n * 34 + grain)),
        Math.max(0, Math.min(255, 116 + n * 29 - grain)),
        Math.max(0, Math.min(255, 108 + n * 25 + grain * 0.5)),
      ];
    });
    const result = prepareVisionPreview(texture);
    assert.equal(result.mime, 'image/jpeg');
    assert.ok(result.preview.length > 0 && result.preview.length <= 180 * 1024, 'JPEG preview stays inside 180 KiB');
    const jpeg = nativeImage.createFromBuffer(result.preview);
    assert.equal(jpeg.isEmpty(), false, 'JPEG is decodable');
    const jpegSize = jpeg.getSize();
    assert.ok(jpegSize.width <= 1536 && jpegSize.width > 0);
    assert.ok(Math.abs(jpegSize.width / jpegSize.height - 2048 / 1365) < 0.01, 'JPEG keeps the source aspect ratio');
    const ocr = nativeImage.createFromBuffer(result.ocr);
    assert.equal(ocr.isEmpty(), false, 'OCR PNG is decodable');
    assert.ok(result.ocr.length > 8 && result.ocr.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.deepEqual(ocr.getSize(), { width: 1536, height: 1024 }, 'OCR PNG is independently scaled to max 1536 width');

    const text = createTextImage();
    const textResult = prepareVisionPreview(text);
    const textPng = nativeImage.createFromBuffer(textResult.ocr);
    assert.deepEqual(textPng.getSize(), { width: 1400, height: 850 }, 'small text image is not enlarged');
    assert.equal(textResult.mime, 'image/jpeg');

    const tiny = bitmap(320, 180, () => [245, 245, 245]);
    const tinyResult = prepareVisionPreview(tiny);
    assert.deepEqual(nativeImage.createFromBuffer(tinyResult.ocr).getSize(), { width: 320, height: 180 });

    let rng = 0x2f6e2b1;
    const incompressible = bitmap(256, 256, () => {
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
      return [rng & 255, (rng >>> 8) & 255, (rng >>> 16) & 255];
    });
    assert.throws(() => prepareVisionPreview(incompressible, { maxBytes: 1024 }), /无法压到 1024 字节以内/);

    assert.throws(() => prepareVisionPreview(nativeImage.createEmpty()), /为空/);
    assert.throws(() => prepareVisionPreview({ getSize: () => ({ width: Infinity, height: 1 }), resize() {}, toPNG() {}, toJPEG() {} }), /尺寸无效/);
    console.log(JSON.stringify({ jpegBytes: result.preview.length, jpegSize, ocrBytes: result.ocr.length, ocrSize: ocr.getSize(), textSize: textPng.getSize(), tinySize: nativeImage.createFromBuffer(tinyResult.ocr).getSize() }));
  } finally {
    app.quit();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); app.exit(1); });
