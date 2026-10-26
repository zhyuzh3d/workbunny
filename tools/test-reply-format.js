'use strict';

const assert = require('node:assert/strict');
const { responseFormat, validateReply, CAPABILITIES } = require('../src/main/reply-format');
const { makeActionGate } = require('../src/main/dialogue-actions');

const wbIntent = { action: 'start', target: 'workbuddy', goal: '检查项目', criteria: '给出可读报告' };
const validChat = JSON.stringify({ kind: 'chat', text: '你好，今天可以一起看看。' });
const validAction = JSON.stringify({ kind: 'action', intent: wbIntent });
const validSkip = JSON.stringify({ kind: 'skip' });

function runGate(parts) {
  const shown = [];
  const gate = makeActionGate(value => shown.push(value), { requireEnvelope: true });
  for (const part of parts) gate.push(part);
  const beforeFlush = shown.join('');
  gate.flush();
  return { gate, beforeFlush, shown: shown.join('') };
}

function expectRejected(raw, label) {
  let calls = 0;
  const gate = makeActionGate(() => { calls++; }, { requireEnvelope: true });
  // Feed in small pieces to catch accidental early emission before the bad tail
  // or before flush has validated the complete envelope.
  for (let i = 0; i < raw.length; i += 3) gate.push(raw.slice(i, i + 3));
  assert.equal(calls, 0, `${label}: no text is emitted before final validation`);
  gate.flush();
  assert.equal(calls, 0, `${label}: invalid reply never reaches UI/TTS`);
  assert.ok(gate.error, `${label}: strict gate must reject`);
  assert.throws(() => validateReply(raw), undefined, `${label}: shared validator rejects`);
}

function testProviderWireFormatsShareOneStrictValidator() {
  assert.deepEqual(CAPABILITIES, { workbuddy: 'json_object', deepseek: 'json_object', grok: 'json_schema' });
  assert.deepEqual(responseFormat('grok'), {
    type: 'json_schema',
    json_schema: { name: 'workbunny_reply', strict: true, schema: require('../src/main/reply-format').schema },
  });
  assert.deepEqual(responseFormat('deepseek'), { type: 'json_object' });
  assert.deepEqual(responseFormat('workbuddy'), { type: 'json_object' });

  // A provider's transport mode does not weaken local validation.
  for (const provider of ['grok', 'deepseek', 'workbuddy']) {
    assert.equal(validateReply(validChat).text, '你好，今天可以一起看看。', `${provider} valid chat`);
    for (const invalid of ['1', 'true', 'null', '[]', 'plain text', '```json\n{}\n```']) {
      assert.throws(() => validateReply(invalid), undefined, `${provider} rejects ${invalid}`);
    }
  }
}

function testValidChatActionAndSkip() {
  const chat = validateReply(validChat);
  assert.deepEqual(chat, { text: '你好，今天可以一起看看。', intent: null, skipped: false });
  const action = validateReply(validAction);
  assert.deepEqual(action, { text: '', intent: wbIntent, skipped: false });
  const skip = validateReply(validSkip);
  assert.deepEqual(skip, { text: '', intent: null, skipped: true });
  assert.throws(() => validateReply(validAction, { allowActions: false }), { code: 'E_REPLY_PROTOCOL' });
  assert.throws(() => validateReply(validSkip, { allowActions: false }), { code: 'E_REPLY_PROTOCOL' });
}

function testValidNumericChatIsNotMistakenForScalarJson() {
  const raw = JSON.stringify({ kind: 'chat', text: '1.1' });
  assert.deepEqual(validateReply(raw), { text: '1.1', intent: null, skipped: false });
  const result = runGate([...raw]);
  assert.equal(result.beforeFlush, '', 'requireEnvelope holds all content until full validation');
  assert.equal(result.shown, '1.1');
  assert.equal(result.gate.error, null);
  assert.equal(result.gate.controlled, false);
}

function testStrictGateChunkBoundariesAndControlIsolation() {
  for (let split = 0; split <= validChat.length; split++) {
    const result = runGate([validChat.slice(0, split), validChat.slice(split)]);
    assert.equal(result.beforeFlush, '', `chat split ${split} is not spoken before flush`);
    assert.equal(result.shown, '你好，今天可以一起看看。');
    assert.equal(result.gate.controlled, false);
    assert.equal(result.gate.error, null);
  }
  for (const [raw, expected] of [[validAction, wbIntent], [validSkip, null]]) {
    for (let split = 0; split <= raw.length; split++) {
      const result = runGate([raw.slice(0, split), raw.slice(split)]);
      assert.equal(result.shown, '', 'action and skip never reach UI/TTS');
      assert.equal(result.gate.controlled, true);
      assert.equal(result.gate.error, null);
      assert.deepEqual(result.gate.intent, expected);
      assert.equal(result.gate.skipped, raw === validSkip);
    }
  }
}

function testScalarsUnknownsDuplicatesTruncationAndTrailingGarbageReject() {
  const invalid = [
    '1', 'false', 'null', '[]', '"text"', 'plain text', '```json\n{"kind":"chat","text":"ok"}\n```',
    '{"kind":"chat","text":"ok","extra":true}',
    '{"kind":"action","intent":{"action":"stop"},"extra":0}',
    '{"kind":"chat","kind":"chat","text":"ok"}',
    '{"kind":"chat","text":"ok","text":"second"}',
    '{"kind":"action","intent":{"action":"stop","action":"status"}}',
    '{"kind":"chat","text":"unfinished"',
    '{"kind":"chat","text":"ok"} trailing',
    '{"kind":"chat","text":"ok"}{"kind":"skip"}',
    '{"kind":"chat","text":""}',
  ];
  invalid.forEach((raw, index) => expectRejected(raw, `invalid reply ${index}: ${raw}`));
}

testProviderWireFormatsShareOneStrictValidator();
testValidChatActionAndSkip();
testValidNumericChatIsNotMistakenForScalarJson();
testStrictGateChunkBoundariesAndControlIsolation();
testScalarsUnknownsDuplicatesTruncationAndTrailingGarbageReject();
console.log('reply format tests passed');
