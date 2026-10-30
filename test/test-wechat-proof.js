const assert = require('node:assert/strict');
const { wechatMessageVisible } = require('../src/main/desktop-service');
const message = '你好，这是 assistant 的测试。请回复“收到”，谢谢！';
const ocr = [{ text: '你好，这是assistant 的测试。', confidence: 0.5, x: 0.45, y: 0.74 },
 { text: '请回复一句“收到”，谢谢！', confidence: 1, x: 0.45, y: 0.76 }];
assert(!wechatMessageVisible({ocr}, message, 'conversation'), 'different message text remains rejected');
ocr[1].text = '请回复“收到”，谢谢！';
assert(wechatMessageVisible({ocr}, message, 'conversation'), 'wrapped bilingual OCR is matched without inventing a word boundary');
assert(!wechatMessageVisible({ocr}, message+'还有别的', 'conversation'));
assert(!wechatMessageVisible({ocr:ocr.map(r=>({...r,y:r.y+.2}))}, message, 'conversation'), 'composer text is not conversation proof');
assert(!wechatMessageVisible({ocr:ocr.map(r=>({...r,confidence:.3}))}, message, 'conversation'));
console.log('WeChat visual text proof checks passed');
