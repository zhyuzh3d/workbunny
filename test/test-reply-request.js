'use strict';

const assert = require('node:assert/strict');
const { requestReply } = require('../src/main/reply-request');

const envelope = text => JSON.stringify({ kind: 'chat', text });
const requestBase = () => ({
  provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key', baseURL: 'https://example.invalid/v1',
  temperature: 0.2, maxTokens: 512, signal: new AbortController().signal,
  extraBody: { reasoning_effort: 'high' },
  messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: '请记住我的偏好。' }],
});

async function testInvalidRepliesRepairOnceWithoutLeakingCallbacksOrHistory() {
  for (const bad of [
    '1', '普通口语回复', '```json\n{"kind":"chat","text":"好"}\n```',
    '{"kind":"chat","text":"好","unexpected":true}',
    '{"kind":"action","intent":{"action":"start","target":"bad","goal":"x","criteria":"y"}}',
  ]) {
    const request = requestBase();
    const originalMessages = structuredClone(request.messages);
    const deltas = [], sentences = [], actionCallbacks = [];
    request.onDelta = value => deltas.push(value);
    request.onSentence = value => sentences.push(value);
    request.onAction = value => actionCallbacks.push(value);
    const calls = [];
    const answer = await requestReply({
      chat: async opts => {
        calls.push(opts);
        assert.equal(typeof opts.onDelta, 'undefined');
        assert.equal(typeof opts.onSentence, 'undefined');
        assert.equal(typeof opts.onAction, 'undefined');
        return { raw: calls.length === 1 ? bad : envelope('1.1。'), text: 'transport text', usage: { total_tokens: 4 } };
      }, request,
    });
    assert.equal(calls.length, 2, `one repair for ${bad}`);
    assert.equal(answer.attempts, 2);
    assert.equal(answer.protocolVerified, true);
    assert.equal(answer.reply.text, '1.1。');
    assert.deepEqual(deltas, [envelope('1.1。')]);
    assert.deepEqual(sentences, ['1.1。']);
    assert.deepEqual(actionCallbacks, []);
    assert.deepEqual(request.messages, originalMessages, 'caller history stays unchanged');
    assert.match(calls[0].messages.at(-1).content, /应用外层回复协议/);
    assert.match(calls[1].messages.at(-1).content, /上一输出未通过/);
    assert.equal(calls[0].messages.length, request.messages.length, 'bad output was not appended as assistant history');
    assert.equal(calls[1].model, request.model);
    assert.equal(calls[1].apiKey, request.apiKey);
    assert.equal(calls[1].temperature, request.temperature);
    assert.deepEqual(calls[1].extraBody, { reasoning_effort: 'high', response_format: { type: 'json_object' } });
    assert.equal(calls[1].signal, request.signal);
  }
}

async function testValidImmediateCommitAndAllowActions() {
  const request = requestBase();
  const delivered = [];
  request.onDelta = raw => delivered.push(raw);
  const raw = envelope('我记下了。');
  const result = await requestReply({ chat: async () => ({ raw, text: raw, model: request.model }), request, maxRepairs: 0 });
  assert.deepEqual(delivered, [raw]);
  assert.equal(result.attempts, 1);
  assert.equal(result.repaired, false);

  const intent = { action: 'stop' };
  const actionRaw = JSON.stringify({ kind: 'action', intent });
  const actionResult = await requestReply({ chat: async () => ({ raw: actionRaw }), request: requestBase(), allowActions: true });
  assert.deepEqual(actionResult.reply.intent, intent);
}

async function testTwoInvalidResultsFailWithoutBodyOrCallbacks() {
  const request = requestBase();
  let calls = 0, emitted = 0;
  request.onDelta = () => emitted++;
  await assert.rejects(requestReply({
    chat: async () => { calls++; return { raw: calls === 1 ? 'plain' : 'false' }; }, request,
  }), error => error.code === 'E_REPLY_PROTOCOL' && !Object.hasOwn(error, 'body') && !Object.hasOwn(error, 'responseBody'));
  assert.equal(calls, 2);
  assert.equal(emitted, 0);
}

async function testAbortAndNetworkErrorsDoNotRetry() {
  const controller = new AbortController();
  const request = { ...requestBase(), signal: controller.signal };
  let calls = 0, emitted = 0;
  request.onDelta = () => emitted++;
  await assert.rejects(requestReply({
    chat: async () => { calls++; controller.abort(); return { raw: 'plain' }; }, request,
  }), error => error.code === 'ABORT_ERR');
  assert.equal(calls, 1);
  assert.equal(emitted, 0);

  calls = 0;
  const networkError = new Error('network/credit failure');
  await assert.rejects(requestReply({ chat: async () => { calls++; throw networkError; }, request: requestBase() }), error => error === networkError);
  assert.equal(calls, 1, 'transport errors are not retried');

  let current = true;
  calls = 0;
  await assert.rejects(requestReply({
    chat: async () => { calls++; current = false; return { raw: 'plain' }; },
    request: { ...requestBase(), isCurrent: () => current },
  }), error => error.code === 'ABORT_ERR');
  assert.equal(calls, 1, 'stale context is not retried');
}

async function testOriginalContentArrayAndHardRepairLimit() {
  const request = requestBase();
  request.messages[1].content = [{ type: 'text', text: '原始消息' }];
  const original = structuredClone(request.messages);
  const received = [];
  await assert.rejects(requestReply({
    maxRepairs: 10,
    chat: async opts => { received.push(opts.messages); return { raw: 'bad' }; },
    request,
  }), error => error.code === 'E_REPLY_PROTOCOL');
  assert.equal(received.length, 2, 'repair attempts are capped at one');
  assert.deepEqual(request.messages, original);
  assert.deepEqual(received[0].at(-1).content[0], original[1].content[0]);
  assert.deepEqual(received[1].at(-1).content[0], original[1].content[0]);
}

async function testOneSharedTimeoutBudgetAcrossRepair() {
  const request = { ...requestBase(), timeoutMs: 5000 };
  let now = 100, calls = 0;
  const timeouts = [];
  const result = await requestReply({
    clock: () => now,
    chat: async options => {
      calls++;
      timeouts.push(options.timeoutMs);
      if (calls === 1) { now += 1700; return { raw: 'plain' }; }
      return { raw: envelope('完成。') };
    },
    request,
  });
  assert.equal(result.attempts, 2);
  assert.deepEqual(timeouts, [5000, 3300], 'repair receives only the remaining total budget');

  now = 0; calls = 0;
  await assert.rejects(requestReply({
    clock: () => now,
    chat: async options => {
      calls++;
      assert.equal(options.timeoutMs, 5000);
      now = 5000;
      return { raw: 'plain' };
    },
    request,
  }), error => error.code === 'E_REPLY_TIMEOUT' && !Object.hasOwn(error, 'body'));
  assert.equal(calls, 1, 'expired overall budget prevents the repair request');

  now = 0; calls = 0;
  let emitted = 0;
  request.onDelta = () => emitted++;
  await assert.rejects(requestReply({
    clock: () => now,
    chat: async options => {
      calls++;
      assert.equal(options.timeoutMs, 5000);
      now = 5001;
      return { raw: envelope('迟到的成功。') };
    },
    request,
  }), error => error.code === 'E_REPLY_TIMEOUT');
  assert.equal(calls, 1);
  assert.equal(emitted, 0, 'late successful output is not committed to callbacks');
}

(async () => {
  await testInvalidRepliesRepairOnceWithoutLeakingCallbacksOrHistory();
  await testValidImmediateCommitAndAllowActions();
  await testTwoInvalidResultsFailWithoutBodyOrCallbacks();
  await testAbortAndNetworkErrorsDoNotRetry();
  await testOriginalContentArrayAndHardRepairLimit();
  await testOneSharedTimeoutBudgetAcrossRepair();
  console.log('reply request tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
