'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateReply, recoverCognitiveChat, responseFormat, schema } = require('../src/main/reply-format');
const { makeActionGate, RULE, PERFORMANCE_RULE } = require('../src/main/dialogue-actions');
const { createReplyStream } = require('../src/main/reply-stream');
const { requestReply } = require('../src/main/reply-request');

const performance = '请自然展示跑步动作，称呼主人；表演时再接话。';
const review = { stage: 'review', grade: 'unassessed', note: '', grasp: 'steady', pace: 'listen' };
const cognitive = reply => ({ protocol: 'dialogue-v2', stages: [review, { stage: 'reply', reply }, { stage: 'prediction', expect: null, basis: [] }] });
const request = extra => ({ timeoutMs: 5000, messages: [{ role: 'user', content: '合成表演请求' }], ...extra });

test('cognition instructions include a complete valid performance example inside reply and retain strict root fields', async () => {
  const rule = require('../src/main/dialogue-cognition').RULE;
  assert(rule.includes('根对象严格只有protocol和stages两个字段'));
  assert(rule.includes('只能放在stages[1].reply内部'));
  assert(rule.includes('普通回复省略performance'));
  const raw = rule.match(/完整合法示例：(\{.*\})。此示例/u)?.[1];
  assert(raw, 'give the main model a complete, directly valid envelope rather than a bare chat example');
  const value = JSON.parse(raw);
  assert.deepEqual(Object.keys(value), ['protocol', 'stages']);
  const reply = validateReply(raw, { cognitive: true });
  assert.equal(reply.text, ''); assert(reply.performance); assert.equal(reply.skipped, false);
  for (const extra of [{ performance }, { turnDisposition: 'keep' }, { text: '额外根正文' }]) {
    assert.throws(() => validateReply(JSON.stringify({ ...value, ...extra }), { cognitive: true, allowTurnDisposition: true }), { code: 'E_REPLY_PROTOCOL', protocolStage: 'envelope' });
  }
  const answer = await requestReply({ request: request({ cognitive: true }), chat: async options => {
    const reminder = options.messages.at(-1).content;
    assert(reminder.includes(raw)); assert(reminder.includes('根对象严格只有protocol和stages两个字段'));
    return { raw };
  } });
  assert.equal(answer.performance, reply.performance);
});

test('performance is an optional validated chat field, including silent chat and ASR disposition', () => {
  for (const text of ['', '  ', '你好。<m>wave</m>']) {
    const raw = JSON.stringify({ kind: 'chat', text, performance: ` ${performance} `, turnDisposition: 'replace' });
    const reply = validateReply(raw, { allowEmptyVoiceDecision: true, allowTurnDisposition: true });
    assert.equal(reply.performance, performance);
    assert.equal(reply.text, text.trim() ? '你好。' : '');
    assert.equal(reply.taggedText, text === '' ? undefined : text);
    assert.equal(reply.skipped, false);
    assert.equal(reply.intent, null);
    assert.equal(reply.turnDisposition, 'replace');
    assert.throws(() => validateReply(raw, { allowActions: false, allowTurnDisposition: true }), { code: 'E_REPLY_PROTOCOL' });
  }
  const reply = validateReply(JSON.stringify(cognitive({ kind: 'chat', text: '', performance })), { cognitive: true });
  assert.equal(reply.performance, performance);
  assert.equal(reply.cognition.review.grade, 'unassessed');
  assert.equal(reply.cognition.prediction, null);
  assert.equal(validateReply(JSON.stringify({ kind: 'chat', text: '', performance: '字'.repeat(600) })).performance.length, 600);
  assert.throws(() => validateReply('{"kind":"chat","text":""}'), { code: 'E_REPLY_PROTOCOL' });
  assert.deepEqual(validateReply('{"kind":"chat","text":""}', { allowEmptyVoiceDecision: true }), { text: '', skipped: true });
  assert.equal(validateReply('{"kind":"skip"}').skipped, true);
  assert(RULE.includes(PERFORMANCE_RULE));
  assert.equal(schema.anyOf[0].properties.performance.maxLength, 600);
  const wire = responseFormat('grok', undefined, { cognitive: true, allowTurnDisposition: true });
  const chatSchema = wire.json_schema.schema.properties.stages.items.anyOf[1].properties.reply.anyOf[0];
  assert.equal(chatSchema.properties.performance.maxLength, 600);
  assert.deepEqual(chatSchema.anyOf, schema.anyOf[0].anyOf, 'ASR schema keeps the conditional empty-text rule');
});

test('bad performance combinations remain strict and cannot emit buffered text or retain an intent', () => {
  const candidates = [
    ...[null, 2, false, {}, [], '', '  ', '字'.repeat(601), 'password: synthetic-secret', 'sk-' + 'x'.repeat(20)]
      .map(value => JSON.stringify({ kind: 'chat', text: '不能提前展示。', performance: value })),
    JSON.stringify({ kind: 'chat', performance }),
    JSON.stringify({ kind: 'chat', text: null, performance }),
    JSON.stringify({ kind: 'chat', text: '可以。', performance, extra: true }),
    JSON.stringify({ kind: 'action', intent: { action: 'stop' }, performance }),
    JSON.stringify({ kind: 'skip', performance }),
    JSON.stringify({ kind: 'chat', text: '', performance, turnDisposition: 'drop' }),
    '{"kind":"chat","text":"可以。","performance":"one","performance":"two"}',
    JSON.stringify({ kind: 'chat', text: '可以。', performance }) + ' trailing',
  ];
  for (const raw of candidates) {
    const shown = [], gate = makeActionGate(text => shown.push(text), { requireEnvelope: true });
    for (const char of raw) gate.push(char);
    assert.deepEqual(shown, [], 'strict gate waits for the whole envelope');
    gate.flush();
    assert(gate.error);
    assert.equal(gate.performance, undefined);
    assert.equal(gate.intent, null);
    assert.deepEqual(shown, []);
    assert.throws(() => validateReply(raw, { allowEmptyVoiceDecision: true, allowTurnDisposition: true }), { code: 'E_REPLY_PROTOCOL' });
  }
});

test('every chunk boundary and field ordering streams only text and keeps silent performance silent', () => {
  const internal = '只作为要求，不可朗读："text":"内部台词😀"。';
  for (const text of ['', '你好😀。<m>wave</m>再聊聊。']) {
    for (const order of [['kind', 'text', 'performance'], ['kind', 'performance', 'text'], ['performance', 'text', 'kind'],
      ['performance', 'kind', 'text'], ['text', 'performance', 'kind'], ['text', 'kind', 'performance']]) {
      const values = { kind: 'chat', text, performance: internal };
      const reply = Object.fromEntries(order.map(key => [key, values[key]]));
      for (const cognition of [false, true]) {
        const raw = JSON.stringify(cognition ? cognitive(reply) : reply);
        for (let split = 0; split <= raw.length; split++) {
          const shown = [], spoken = [], stream = createReplyStream({ cognitive: cognition, onDelta: value => shown.push(value), onSentence: value => spoken.push(value) });
          stream.push(raw.slice(0, split)); stream.push(raw.slice(split)); stream.finish(text);
          assert.equal(shown.join(''), text ? '你好😀。再聊聊。' : '', `text projection at split ${split}`);
          assert.deepEqual(spoken, text ? ['你好😀。', '再聊聊。'] : []);
          assert(!shown.join('').includes('内部'));
          const held = [], strict = makeActionGate(value => held.push(value), { requireEnvelope: true });
          const innerRaw = JSON.stringify(reply);
          strict.push(innerRaw.slice(0, split)); strict.push(innerRaw.slice(split));
          assert.deepEqual(held, []);
          strict.flush();
          assert.equal(strict.error, null);
          assert.equal(strict.performance, internal);
          assert.equal(held.join(''), text ? '你好😀。再聊聊。' : '');
        }
      }
    }
  }
});

test('a cancelled text projection never resumes at any performance chunk boundary', () => {
  const text = '先说一句。后续不能迟到。', raw = JSON.stringify(cognitive({ kind: 'chat', text, performance }));
  for (let split = 0; split <= raw.length; split++) {
    let current = true;
    const shown = [], spoken = [], stream = createReplyStream({ cognitive: true, isCurrent: () => current, onDelta: value => shown.push(value), onSentence: value => spoken.push(value) });
    stream.push(raw.slice(0, split));
    const before = [shown.join(''), spoken.join('')];
    current = false; stream.push(raw.slice(split)); stream.finish(text);
    assert.deepEqual([shown.join(''), spoken.join('')], before);
    assert(!shown.join('').includes(performance));
  }
});

test('requestReply forwards validated silent performance without an empty TTS or a skip decision', async () => {
  for (const cognition of [false, true]) {
    const shown = [], spoken = [], reply = { kind: 'chat', text: '', performance }, raw = JSON.stringify(cognition ? cognitive(reply) : reply);
    const answer = await requestReply({ request: request({ cognitive: cognition, streamText: true, allowEmptyVoiceDecision: true,
      onTextDelta: text => shown.push(text), onTextSentence: text => spoken.push(text) }), chat: async options => {
      assert(options.messages.at(-1).content.includes(PERFORMANCE_RULE));
      for (const char of raw) options.onDelta(char);
      return { raw, performance: 'untrusted transport metadata' };
    } });
    assert.equal(answer.performance, performance);
    assert.equal(answer.reply.performance, performance);
    assert.equal(answer.reply.skipped, false);
    assert.equal(answer.text, '');
    assert.deepEqual(shown, []); assert.deepEqual(spoken, []);
  }
  const normal = await requestReply({ request: request(), chat: async () => ({ raw: '{"kind":"chat","text":"正常。"}', performance: 'untrusted transport metadata' }) });
  assert.equal(normal.performance, undefined, 'transport metadata cannot manufacture a performance');
});

test('invalid cognition never salvages a performance; fresh core regeneration can return a silent performance', async () => {
  for (const text of ['', '已生成正文。']) {
    const value = cognitive({ kind: 'chat', text, performance });
    value.stages[0] = { ...review, grade: 'invalid' };
    const bad = JSON.stringify(value);
    assert.equal(recoverCognitiveChat(bad), null);
    assert.equal(recoverCognitiveChat(JSON.stringify({ kind: 'chat', text, performance })), null);
    let calls = 0;
    const delivered = [], fresh = '全新恢复生成的要求。';
    const answer = await requestReply({ request: request({ cognitive: true, onDelta: value => delivered.push(value) }), chat: async options => {
      assert.deepEqual(delivered, []);
      if (++calls < 3) return { raw: bad };
      assert.equal(options.cognitive, false);
      assert(!JSON.stringify(options.messages).includes('已生成正文'));
      return { raw: JSON.stringify({ kind: 'chat', text: '', performance: fresh }) };
    } });
    assert.equal(calls, 3); assert.equal(answer.performance, fresh);
    assert.equal(answer.cognitionDegraded, true); assert.equal(answer.attempts, 3);
    assert.equal(delivered.length, 1);
  }
  let calls = 0, emitted = 0;
  const bad = JSON.stringify({ ...cognitive({ kind: 'chat', text: '', performance }), extra: true });
  await assert.rejects(requestReply({ allowActions: false, request: request({ cognitive: true, onDelta: () => emitted++ }), chat: async () => {
    calls++; return { raw: calls < 3 ? bad : JSON.stringify({ kind: 'chat', text: '自然正文。', performance }) };
  } }), { code: 'E_REPLY_PROTOCOL' });
  assert.equal(calls, 3); assert.equal(emitted, 0);
});

test('abort and stale responses cannot return a performance even when the provider ignores cancellation', async () => {
  for (const interruption of ['abort', 'stale']) for (const text of ['', '还在生成。']) {
    const controller = new AbortController(); let current = true, release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const finish = new Promise(resolve => { release = resolve; });
    const raw = JSON.stringify(cognitive({ kind: 'chat', text, performance })), shown = [], spoken = [], delivered = [];
    const pending = requestReply({ request: request({ signal: controller.signal, isCurrent: () => current, cognitive: true, streamText: true,
      onDelta: value => delivered.push(value), onTextDelta: value => shown.push(value), onTextSentence: value => spoken.push(value) }), chat: async options => {
      options.onDelta(raw.slice(0, raw.indexOf('"reply"'))); entered(); await finish;
      options.onDelta(raw); return { raw };
    } });
    await started;
    if (interruption === 'abort') controller.abort(); else current = false;
    const rejection = assert.rejects(pending, error => ['ABORT_ERR', 'AbortError'].includes(error.code || error.name));
    release(); await rejection; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delivered, []); assert.deepEqual(shown, []); assert.deepEqual(spoken, []);
  }
});

test('already streamed chat cannot salvage or replay performance when its cognition fails', async () => {
  const value = cognitive({ kind: 'chat', text: '先说一句。', performance });
  value.stages[2].expect = { invalid: true };
  const raw = JSON.stringify(value), shown = [], delivered = []; let calls = 0;
  await assert.rejects(requestReply({ request: request({ cognitive: true, streamText: true, onTextDelta: value => shown.push(value), onDelta: value => delivered.push(value) }),
    chat: async options => { calls++; for (const char of raw) options.onDelta(char); return { raw }; } }), { code: 'E_REPLY_PROTOCOL' });
  assert.equal(calls, 1);
  assert.equal(shown.join(''), '先说一句。');
  assert.deepEqual(delivered, []);
});
