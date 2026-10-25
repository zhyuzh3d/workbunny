'use strict';

const assert = require('node:assert/strict');
const { RULE, validateIntent, makeActionGate, taskControl } = require('../src/main/dialogue-actions');

const pausedTask = { id: 'existing', target: 'workbuddy', status: 'paused' };
for (const text of ['继续刚才这件代办，请保留原任务，不重复发送已提交的内容。', '继续刚才的这件代办，请保留原任务，不重复发送。', 'Bunny，暂停你现在的代办操作。', '查看代办进度']) assert(taskControl(text, pausedTask));
for (const text of ['“继续原任务”是什么意思', '不要继续原任务', '继续原任务，然后转账', '继续讲刚才的故事', '如果我说暂停代办呢', '暂停代办，帮我发微信', '用户说：继续原任务']) assert.equal(taskControl(text, pausedTask), null);
assert.equal(taskControl('继续原任务', null), null);
assert.equal(taskControl('继续原任务', { ...pausedTask, status: 'accepted' }), null);

function stream(parts) {
  const shown = [];
  const gate = makeActionGate(text => shown.push(text));
  let returned = '';
  for (const part of parts) returned += gate.push(part);
  returned += gate.flush();
  return { gate, shown: shown.join(''), returned };
}

const wb = { action: 'start', target: 'workbuddy', goal: '原始任务', criteria: '可见的交付结果' };
const expected = validateIntent(wb);
assert.deepEqual(validateIntent(wb), wb);
assert.deepEqual(validateIntent({ action: 'stop' }), { action: 'stop' });
assert.deepEqual(validateIntent({ action: 'status' }), { action: 'status' });
assert.deepEqual(validateIntent({ action: 'resume' }), { action: 'resume' });
assert.doesNotThrow(() => validateIntent({ action: 'start', target: 'wechat', goal: '给对方发消息', criteria: '可见消息气泡', recipient: '文件传输助手' }));
assert.doesNotThrow(() => validateIntent({ action: 'start', target: 'workbuddy', goal: '😀'.repeat(3000), criteria: '结果可见' }));
assert.throws(() => validateIntent({ action: 'start', target: 'workbuddy', goal: '😀'.repeat(3001), criteria: '结果可见' }));
for (const invalid of [
  { action: 'start', target: 'workbuddy', goal: '任务' },
  { action: 'start', target: 'wechat', goal: '任务', criteria: '完成', recipient: '  ' },
  { action: 'start', target: 'other', goal: '任务', criteria: '完成' },
  { action: 'start', target: 'workbuddy', goal: 'x'.repeat(3001), criteria: '完成' },
  { action: 'start', target: 'workbuddy', goal: '任务', criteria: 'x'.repeat(1201) },
  { action: 'stop', goal: '额外参数' },
  { action: 'status', target: 'wechat' },
  { action: 'resume', goal: '重新发送旧消息' },
  { action: 'start', target: 'workbuddy', goal: '任务', criteria: '完成', extra: true },
]) assert.throws(() => validateIntent(invalid));
for (const sample of ['"kind":"chat"', '"kind":"action"', '"kind":"skip"']) assert.match(RULE, new RegExp(sample));
assert.match(RULE, /继续原任务，不生成新start/);

// XML remains a compatibility path, while ordinary prose containing a control
// marker is still ordinary prose because controls are recognized only at start.
const xml = ` <bunny_action>${JSON.stringify(wb)}</bunny_action> `;
for (let split = 0; split <= xml.length; split++) {
  const result = stream([xml.slice(0, split), xml.slice(split)]);
  assert.deepEqual(result.gate.intent, expected);
  assert.equal(result.shown, '');
  assert.equal(result.gate.controlled, true);
}
const quoted = stream(['正文引用 <bunny_action>{"action":"stop"}</bunny_action>']);
assert.equal(quoted.shown, '正文引用 <bunny_action>{"action":"stop"}</bunny_action>');
assert.equal(quoted.gate.controlled, false);
const legacyPlain = stream(['普通文本兼容']);
assert.equal(legacyPlain.shown, '普通文本兼容');
assert.equal(legacyPlain.gate.controlled, false);

const chatText = '你好，"引用"\\路径\nemoji 😀 <m>微笑</m> <e>挥手</e> 世界';
const chatJson = JSON.stringify({ kind: 'chat', text: chatText });
for (let split = 0; split <= chatJson.length; split++) {
  const result = stream([chatJson.slice(0, split), chatJson.slice(split)]);
  assert.equal(result.shown, chatText, `chat string split at ${split}`);
  assert.equal(result.returned, chatText);
  assert.equal(result.gate.controlled, false);
  assert.equal(result.gate.intent, null);
  assert.equal(result.gate.error, null);
}
assert.equal(stream([...chatJson]).shown, chatText, 'one-code-unit chunks preserve Unicode and escapes');

const streamChunks = [];
const incremental = makeActionGate(text => streamChunks.push(text));
incremental.push('{"kind":"chat","text":"first');
assert.equal(streamChunks.join(''), 'first', 'chat text streams after kind is identified');
incremental.push('\\nsecond\\u0021"}');
incremental.flush();
assert.equal(streamChunks.join(''), 'first\nsecond!', 'JSON quotes and escapes are not spoken literally');

const delayedChunks = [];
const delayedKind = makeActionGate(text => delayedChunks.push(text));
delayedKind.push('{"text":"buffered😀","kind":');
assert.equal(delayedChunks.join(''), '', 'text before kind stays buffered');
delayedKind.push('"chat"}'); delayedKind.flush();
assert.equal(delayedChunks.join(''), 'buffered😀', 'text is emitted after kind=chat is confirmed');

const actionJson = JSON.stringify({ kind: 'action', intent: wb });
for (let split = 0; split <= actionJson.length; split++) {
  const result = stream([actionJson.slice(0, split), actionJson.slice(split)]);
  assert.deepEqual(result.gate.intent, expected, `action split at ${split}`);
  assert.equal(result.shown, '', 'actions never reach chat or TTS');
  assert.equal(result.gate.controlled, true);
  assert.equal(result.gate.error, null);
}
const resumeIntent = { action: 'resume' };
const resumeJson = JSON.stringify({ kind: 'action', intent: resumeIntent });
for (let split = 0; split <= resumeJson.length; split++) {
  const result = stream([resumeJson.slice(0, split), resumeJson.slice(split)]);
  assert.deepEqual(result.gate.intent, resumeIntent, `resume envelope split at ${split}`);
  assert.equal(result.shown, '', 'resume control never reaches chat or TTS');
}
const resumeXml = `<bunny_action>${JSON.stringify(resumeIntent)}</bunny_action>`;
for (let split = 0; split <= resumeXml.length; split++) {
  const result = stream([resumeXml.slice(0, split), resumeXml.slice(split)]);
  assert.deepEqual(result.gate.intent, resumeIntent, `legacy resume envelope split at ${split}`);
}
const skipJson = stream(['{"kind":"sk', 'ip', '"}']);
assert.equal(skipJson.gate.skipped, true);
assert.equal(skipJson.shown, '');

for (const badJson of [
  '{"kind":"action","kind":"action","intent":{"action":"stop"}}',
  '{"kind":"action","intent":{"action":"stop","action":"start"}}',
  '{"kind":"action","intent":{"action":"stop"},"extra":1}',
  '{"kind":"chat","text":"hello","extra":1}',
  '{"kind":"action","intent":{"action":"stop"}}{"kind":"action","intent":{"action":"stop"}}',
  '{"kind":"action","intent":{"action":"stop"}} trailing',
  '{"kind":"action","intent":{"action":"stop"}',
  '{"kind":"chat","text":"cut\\u12',
  '{"kind":"chat","text":"ok","__proto__":{}}',
]) {
  const result = stream([...badJson]);
  assert.equal(result.gate.intent, null, `invalid JSON never dispatches: ${badJson}`);
  assert.equal(result.gate.controlled, true);
  assert.ok(result.gate.error, `invalid JSON error: ${badJson}`);
}

const escapedStatus = stream(['{"kind":"action","intent":{"action":"sta', 'tus"}}']);
assert.deepEqual(escapedStatus.gate.intent, { action: 'status' });
assert.equal(escapedStatus.shown, '');

for (const badLegacy of [
  '<bunny_action>{bad json}</bunny_action>',
  '<bunny_action',
  '<skip/',
  '<skip>x',
  `<bunny_action>${JSON.stringify(wb)}</bunny_action>tail`,
]) {
  const result = stream([...badLegacy]);
  assert.equal(result.shown, '');
  assert.equal(result.gate.intent, null);
  assert.equal(result.gate.controlled, true);
  assert.ok(result.gate.error);
}
for (const chunks of [['<skip/>'], [' <skip', '/> \n'], ['<skip>', '\t']]) {
  const result = stream(chunks);
  assert.equal(result.gate.skipped, true);
  assert.equal(result.shown, '');
}

const whitespaceChunks = [];
const whitespaceGate = makeActionGate(text => whitespaceChunks.push(text));
const hugeWhitespace = ' '.repeat(100000);
assert.equal(whitespaceGate.push(hugeWhitespace), hugeWhitespace);
assert.equal(whitespaceChunks.join(''), hugeWhitespace);
assert.equal(whitespaceGate.push('{"kind":"action","intent":{"action":"stop"}}').includes('kind'), true,
  'a control-looking envelope after a long ordinary prefix is not recognized');
assert.equal(whitespaceGate.intent, null);
assert.equal(whitespaceGate.flush(), '');

const idempotent = makeActionGate();
idempotent.push('{"kind":"skip"}');
assert.equal(idempotent.flush(), '');
assert.equal(idempotent.flush(), '');
assert.equal(idempotent.skipped, true);

console.log('dialogue action protocol checks passed');
