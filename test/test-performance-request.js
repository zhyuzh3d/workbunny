'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestPerformance, validatePerformance } = require('../src/main/performance-request');
const { buildPerformanceSnapshot } = require('../src/main/performance-catalog');
const snapshot = buildPerformanceSnapshot({ motions: [
  { key: 'motion_run', label: '原地跑', use: '展示跑步', enabled: true, autonomous: false },
  { key: 'wave', label: '挥手', enabled: true },
] }, { avatar: { key: 'Bani.vrm' }, posture: 'standing' });
const base = () => ({ prompt: '请展示跑步，可自然接话。', snapshot, llmOptions: { provider: 'deepseek', model: 'fixture' } });

test('numbered performance streams through every boundary without exposing numbers or requirements', async () => {
  for (const reply of [{ motion: 1, text: '来试试。看看这个～' }, { text: '来试试。看看这个～', motion: 1 }]) {
    const raw = JSON.stringify(reply);
    for (let at = 0; at <= raw.length; at++) {
      const deltas = [], sentences = [];
      const result = await requestPerformance({ ...base(), onTextDelta: x => deltas.push(x), onTextSentence: x => sentences.push(x),
        chat: async options => { options.onDelta(raw.slice(0, at)); options.onDelta(raw.slice(at)); return { raw }; } });
      assert.equal(result.motion, 1); assert.equal(deltas.join(''), reply.text); assert.equal(sentences.join(''), reply.text);
    }
  }
});

test('request has only fixed rules, complete catalog and owner-authored brief; silent and buffered replies work', async () => {
  for (const reply of [{ motion: 1, text: '' }, { motion: 0, text: '目前没有合适动作。' }]) {
    const deltas = [], sentences = [];
    const result = await requestPerformance({ ...base(), onTextDelta: x => deltas.push(x), onTextSentence: x => sentences.push(x),
      chat: async options => {
        assert.equal(options.messages.length, 2); assert(options.messages[0].content.includes('原地跑'));
        assert(!options.messages[0].content.includes('motion_run')); assert.equal(options.messages[1].content, base().prompt);
        const raw = JSON.stringify(reply); options.onDelta(raw, { complete: true });
        assert.equal(deltas.length, 0); return { raw };
      } });
    assert.equal(result.text, reply.text); assert.equal(deltas.join(''), reply.text); assert.equal(sentences.join(''), reply.text);
  }
});

test('invalid numbers and fields are not guessed; malformed complete packets get one bounded repair', async () => {
  for (const bad of [{ motion: '1', text: '' }, { motion: 3, text: '' }, { motion: 1.2, text: '' }, { motion: -1, text: '' },
    { motion: 1, text: '', extra: true }, { motion: 1, text: '<m>other</m>' }]) {
    assert.throws(() => validatePerformance(JSON.stringify(bad), snapshot), { code: 'E_PERFORMANCE_PROTOCOL' });
  }
  let calls = 0;
  const result = await requestPerformance({ ...base(), chat: async () => ({ raw: ++calls === 1 ? '{"motion":99,"text":""}' : '{"motion":1,"text":""}' }) });
  assert.equal(result.motion, 1); assert.equal(calls, 2);
});

test('already spoken text cannot be replayed to repair a malformed action', async () => {
  let calls = 0;
  await assert.rejects(requestPerformance({ ...base(), chat: async options => {
    calls++; options.onDelta('{"text":"开始试试。",'); return { raw: '{"text":"开始试试。","motion":99}' };
  } }), { code: 'E_PERFORMANCE_PROTOCOL' });
  assert.equal(calls, 1);
});

test('cancelled provider output and ignored abort do not deliver speech or a selected action', async () => {
  const controller = new AbortController(), deltas = [];
  await assert.rejects(requestPerformance({ ...base(), signal: controller.signal, onTextDelta: x => deltas.push(x),
    chat: async options => {
      controller.abort(); options.onDelta('{"motion":1,"text":"迟到了。"}'); return { raw: '{"motion":1,"text":"迟到了。"}' };
    } }), error => error.code === 'ABORT_ERR');
  assert.deepEqual(deltas, []);
  let current = true;
  await assert.rejects(requestPerformance({ ...base(), isCurrent: () => current,
    chat: async options => { current = false; options.onDelta('{"motion":1,"text":"迟到了。"}'); return { raw: '{"motion":1,"text":"迟到了。"}' }; }
  }), { code: 'ABORT_ERR' });
});

test('a provider that ignores cancellation still has a bounded wait and cannot finish late', async () => {
  await assert.rejects(requestPerformance({ ...base(), timeoutMs: 15, chat: () => new Promise(() => {}) }), { code: 'E_PERFORMANCE_TIMEOUT' });
});
