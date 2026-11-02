const assert = require('node:assert/strict');
const { wechatMessageVisible, validateWechatAction, validateAction } = require('../src/main/desktop-service');
const message = '你好，这是 assistant 的测试。请回复“收到”，谢谢！';
const ocr = [{ text: '你好，这是assistant 的测试。', confidence: 0.5, x: 0.45, y: 0.54 },
 { text: '请回复一句“收到”，谢谢！', confidence: 1, x: 0.45, y: 0.56 }];
assert(!wechatMessageVisible({ocr}, message, 'conversation'), 'different message text remains rejected');
ocr[1].text = '请回复“收到”，谢谢！';
assert(wechatMessageVisible({ocr}, message, 'conversation'), 'wrapped bilingual OCR is matched without inventing a word boundary');
assert(!wechatMessageVisible({ocr}, message+'还有别的', 'conversation'));
assert(!wechatMessageVisible({ocr:ocr.map(r=>({...r,y:r.y+.2}))}, message, 'conversation'), 'composer text is not conversation proof');
assert(!wechatMessageVisible({ocr:ocr.map(r=>({...r,confidence:.3}))}, message, 'conversation'));
assert(!wechatMessageVisible({ ocr: [{ text: message, confidence: 1, x: .5, y: .75 }] }, message, 'conversation'), 'composer cannot prove a sent message');
const receipt = { outgoing: true, composerEmpty: true, newBubble: true, text: message,
 bubble: { x: .6, y: .5, width: .3, height: .1 }, composer: { x: .25, y: .7, width: .7, height: .28 } };
const done = validateAction({ action: 'done', completed: true, evidence: '新增右侧气泡与清空编辑区', receipt });
const task = { operation: 'send', recipient: 'Alice', message, submitAttemptedAt: 100, hasBeforeSubmit: true,
 screenshot: { at: 200, ocr: [{ text: 'Alice', confidence: 1, x: .4, y: .08 },
  { text: message, confidence: 1, x: .62, y: .53, width: .24, height: .02 }] } };
assert.doesNotThrow(() => validateWechatAction(done, task));
for (const change of [{ submitAttemptedAt: undefined }, { hasBeforeSubmit: false }, { screenshot: { ...task.screenshot, at: 99 } }]) {
 assert.throws(() => validateWechatAction(done, { ...task, ...change }), /本次提交后/);
}
for (const change of [{ text: message + "其他" }, { outgoing: false }, { newBubble: false }, { composerEmpty: false }, { bubble: { x: .3, y: .72, width: .3, height: .1 } }]) {
 assert.throws(() => validateWechatAction({ ...done, receipt: { ...receipt, ...change } }, task), /本次提交后/);
}
assert.throws(() => validateWechatAction({ ...done, receipt: undefined }, task), /本次提交后/);
assert.throws(() => validateWechatAction({ action: 'type', purpose: 'task', text: message }, { ...task, submitAttemptedAt: undefined, draftInserted: true }), /重复填写/);
console.log('WeChat visual text proof checks passed');
