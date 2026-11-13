'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateIntent, makeActionGate, RULE, AVATAR_SELECT_RULE } = require('../src/main/dialogue-actions');
const { responseFormat, validateReply, recoverCognitiveChat } = require('../src/main/reply-format');
const { requestReply } = require('../src/main/reply-request');
const cognition = require('../src/main/dialogue-cognition');
const envelope = intent => JSON.stringify({ kind: 'action', intent });
const cognitive = intent => ({ protocol: 'dialogue-v2', stages: [
  { stage: 'review', grade: 'unassessed', note: '', grasp: 'steady', pace: 'listen' },
  { stage: 'reply', reply: { kind: 'action', intent } },
  { stage: 'prediction', expect: null, basis: [] },
] });

test('avatar selection uses strict bounded integer intent and an optional short plain reply', () => {
  for (const avatar of [1, 7, 512]) {
    const minimal = { action: 'avatar_select', avatar };
    assert.deepEqual(validateIntent(minimal), minimal);
    assert.deepEqual(validateIntent({ ...minimal, reply: '  换个样子陪你聊。  ' }), { ...minimal, reply: '换个样子陪你聊。' });
    assert.deepEqual(validateReply(envelope(minimal)), { text: '', intent: minimal, skipped: false });
    assert.equal(validateIntent({ ...minimal, reply: '字'.repeat(500) }).reply.length, 500);
    assert.throws(() => validateReply(envelope(minimal), { allowActions: false }), { code: 'E_REPLY_PROTOCOL' });
  }
  const wire = responseFormat('grok', undefined, { cognitive: true });
  const action = wire.json_schema.schema.properties.stages.items.anyOf[1].properties.reply.anyOf.find(value => value.properties.kind.const === 'action');
  const intent = action.properties.intent.anyOf.find(value => value.properties.action.const === 'avatar_select');
  assert.deepEqual(intent.required, ['action', 'avatar']);
  assert.equal(intent.additionalProperties, false);
  assert.deepEqual(intent.properties.avatar, { type: 'integer', minimum: 1, maximum: 512 });
  assert.deepEqual(intent.properties.reply, { type: 'string', minLength: 1, maxLength: 500 });
});

test('bad avatar numbers, mixed controls and program or secret replies are rejected', () => {
  const valid = { action: 'avatar_select', avatar: 1 };
  for (const avatar of [undefined, null, 0, -1, 513, 1.5, NaN, Infinity, '1', true, {}, []]) assert.throws(() => validateIntent({ ...valid, avatar }));
  for (const reply of [undefined, null, 1, true, {}, [], '', '  ', '字'.repeat(501),
    'password: synthetic-secret', 'sk-' + 'x'.repeat(20), '你好。<m>wave</m>', '你好。<e>happy</e>',
    '<script>program</script>', '```code```', '{"action":"stop"}', 'assistant: private-format', '你好\u0000']) {
    assert.throws(() => validateIntent({ ...valid, reply }), `${String(reply)} is not a short plain reply`);
  }
  for (const extra of [{ performance: 'another action' }, { avatarId: 'synthetic-id' }, { intent: { action: 'stop' } }, { ops: [] }]) assert.throws(() => validateIntent({ ...valid, ...extra }));
  for (const raw of [
    JSON.stringify({ kind: 'action', intent: valid, performance: 'another action' }),
    JSON.stringify({ kind: 'action', intent: valid, text: '不应提前说。' }),
    JSON.stringify({ kind: 'action', intent: valid, turnDisposition: 'keep' }),
    JSON.stringify({ kind: 'chat', text: '不应混合。', intent: valid }),
    '{"kind":"action","intent":{"action":"avatar_select","avatar":1,"avatar":2}}',
    '{"kind":"action","intent":{"action":"avatar_select","action":"stop","avatar":1}}',
  ]) assert.throws(() => validateReply(raw, { allowTurnDisposition: true }), { code: 'E_REPLY_PROTOCOL' });
});

test('every avatar-action chunk boundary withholds the supplied reply from UI and TTS', () => {
  const intent = { action: 'avatar_select', avatar: 7, reply: '这是切换成功后才说的话。' }, raw = envelope(intent);
  for (let split = 0; split <= raw.length; split++) {
    const shown = [], gate = makeActionGate(text => shown.push(text), { requireEnvelope: true });
    gate.push(raw.slice(0, split)); gate.push(raw.slice(split)); gate.flush();
    assert.equal(gate.error, null); assert.deepEqual(gate.intent, intent);
    assert.equal(gate.controlled, true); assert.equal(gate.skipped, false);
    assert.deepEqual(shown, []);
  }
});

test('one cognitive request returns an avatar intent without speaking its unexecuted reply', async () => {
  const intent = { action: 'avatar_select', avatar: 2, reply: '新的样子也陪着你。' }, raw = JSON.stringify(cognitive(intent));
  const shown = [], spoken = []; let calls = 0;
  const result = await requestReply({ request: { cognitive: true, streamText: true, deferPresentation: true,
    messages: [{ role: 'system', content: RULE + '\n' + cognition.RULE }, { role: 'user', content: '换个合适的样子' }],
    onTextDelta: text => shown.push(text), onTextSentence: text => spoken.push(text) }, chat: async options => {
    calls++; for (const char of raw) options.onDelta(char); return { raw };
  } });
  assert.equal(calls, 1); assert.deepEqual(result.reply.intent, intent); assert.equal(result.text, '');
  assert.equal(result.cognition.prediction, null); assert.deepEqual(shown, []); assert.deepEqual(spoken, []);
});

test('invalid cognitive metadata never salvages an avatar selection', async () => {
  const value = cognitive({ action: 'avatar_select', avatar: 2, reply: '不能提前执行。' });
  value.stages[0].grade = 'invalid';
  const raw = JSON.stringify(value);
  assert.equal(recoverCognitiveChat(raw), null);
  assert.throws(() => validateReply(raw, { cognitive: true }), { code: 'E_REPLY_PROTOCOL', protocolStage: 'review' });
  let calls = 0;
  const result = await requestReply({ request: { cognitive: true, messages: [{ role: 'user', content: '合成请求' }] }, chat: async options => {
    if (++calls < 3) return { raw };
    assert.equal(options.cognitive, false);
    return { raw: '{"kind":"chat","text":"重新生成的普通回答。"}' };
  } });
  assert.equal(calls, 3); assert.equal(result.reply.intent, null); assert.equal(result.text, '重新生成的普通回答。');
});

test('effective persona and cognition prompts describe same-call local avatar selection with current names', t => {
  const config = require('../src/main/config'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-avatar-protocol-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  config.setPath(path.join(dir, 'config.json'));
  const motionView = { categories: [], motions: [] };
  for (const roleView of [undefined, { revision: 1, text: '合成角色设定' }]) {
    const prompt = config.buildSystemPrompt('', { scene: 'life', roleView, motionView });
    for (const phrase of ['body-state.availableAvatars', '官方与自定义形象', '编号和名字', '本机身体能力', '尊重主人偏好', '不无意义地来回切换', '本次主脑回复', '无须另调模型', '实际切换成功后才显示和朗读']) assert(prompt.includes(phrase), phrase);
  }
  assert(RULE.includes(AVATAR_SELECT_RULE));
  assert(AVATAR_SELECT_RULE.includes('"action":"avatar_select"'));
  assert(cognition.RULE.includes('stages[1].reply可直接使用{"kind":"action","intent":{"action":"avatar_select"'));
  assert(cognition.RULE.includes('根对象严格只有protocol和stages两个字段'));
});
