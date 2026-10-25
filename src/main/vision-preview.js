'use strict';

const DEFAULT_MAX_BYTES = 180 * 1024;
const DEFAULT_MAX_WIDTH = 1536;
const MAX_INPUT_EDGE = 32768;
const MAX_INPUT_PIXELS = 100_000_000;
const JPEG_QUALITIES = [82, 70, 58];
const WIDTH_STEPS = [1536, 1280, 1024, 768, 512, 384, 256];

function dimensionsForWidth(size, maxWidth) {
  const scale = Math.min(1, maxWidth / size.width);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

function scaled(image, size, maxWidth) {
  const target = dimensionsForWidth(size, maxWidth);
  if (target.width === size.width && target.height === size.height) return image;
  return image.resize({ ...target, quality: 'best' });
}

function prepareVisionPreview(nativeImage, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error('预览字节预算无效');
  if (!Number.isSafeInteger(maxWidth) || maxWidth < 1 || maxWidth > DEFAULT_MAX_WIDTH) throw new Error('预览宽度上限无效');
  if (!nativeImage || typeof nativeImage.getSize !== 'function' || typeof nativeImage.resize !== 'function' || typeof nativeImage.toPNG !== 'function' || typeof nativeImage.toJPEG !== 'function') {
    throw new Error('图像对象无效');
  }
  if (typeof nativeImage.isEmpty === 'function' && nativeImage.isEmpty()) throw new Error('截图为空');

  const size = nativeImage.getSize();
  const { width, height } = size || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE || width * height > MAX_INPUT_PIXELS) {
    throw new Error('截图尺寸无效或超出处理范围');
  }

  const ocrImage = scaled(nativeImage, size, maxWidth);
  const ocr = ocrImage.toPNG();
  if (!Buffer.isBuffer(ocr) || ocr.length === 0) throw new Error('OCR 图片编码失败');

  const candidateWidths = [...new Set([maxWidth, ...WIDTH_STEPS].filter(step => step <= maxWidth && step <= width))];
  if (!candidateWidths.includes(Math.min(width, maxWidth))) candidateWidths.unshift(Math.min(width, maxWidth));
  for (const candidateWidth of candidateWidths) {
    const previewImage = scaled(nativeImage, size, candidateWidth);
    for (const quality of JPEG_QUALITIES) {
      const preview = previewImage.toJPEG(quality);
      if (Buffer.isBuffer(preview) && preview.length > 0 && preview.length <= maxBytes) {
        return { ocr, preview, mime: 'image/jpeg' };
      }
    }
  }
  throw new Error(`预览图片无法压到 ${maxBytes} 字节以内`);
}

module.exports = { prepareVisionPreview };
