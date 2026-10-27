'use strict';
const assert = require('node:assert/strict');
const { chatPayload, parseChatBody, chatWithTransport } = require('../src/main/workbuddy');

const content = '你好，主人。';
const message = { model: 'deepseek-v4.1-flash', choices: [{ message: { content, reasoning_content: 'internal reasoning must not be spoken' }, finish_reason: 'stop' }], usage: { total_tokens: 31, prompt_tokens: 12, completion_tokens: 19, private_field: 'omit' } };
for (const object of [message, { data: message }]) {
  const result = parseChatBody(JSON.stringify(object));
  assert.equal(result.raw, content);
  assert.equal(result.model, 'deepseek-v4.1-flash');
  assert.deepEqual(result.usage, { total_tokens: 31, prompt_tokens: 12, completion_tokens: 19 });
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.hasReasoning, true);
}
const events = [
  { model: 'deepseek-v4.1-flash', choices: [{ delta: { reasoning_content: 'private reasoning' } }] },
  { choices: [{ delta: { content: '你好，' } }] },
  { data: { choices: [{ delta: { content: '主人。', reasoning: 'hidden' }, finish_reason: 'stop' }], usage: { total_tokens: 31 } } },
];
const sse = ': keepalive\n' + events.map(event => 'data: ' + JSON.stringify(event)).join('\n\n') + '\n\ndata: [DONE]\n';
assert.deepEqual(parseChatBody(sse), { raw: content, model: 'deepseek-v4.1-flash', usage: { total_tokens: 31 }, finishReason: 'stop', hasReasoning: true });

const calls = [{ id: 'call_search1', type: 'function', function: { name: 'conversation_search', arguments: '{"query":"公开信息","type":"text2text","max_results":3}' } }];
for (const response of [
  { model: 'deepseek-v4.1-flash', choices: [{ message: { tool_calls: calls, content: '隐藏的工具前言' }, finish_reason: 'tool_calls' }], usage: { total_tokens: 13 } },
  { data: { model: 'deepseek-v4.1-flash', choices: [{ message: { tool_calls: calls }, finish_reason: 'tool_calls' }], usage: { total_tokens: 13 } } },
]) {
  const result = parseChatBody(JSON.stringify(response));
  assert.deepEqual(result, { raw: '', model: 'deepseek-v4.1-flash', usage: { total_tokens: 13 },
    finishReason: 'tool_calls', hasReasoning: false, toolCalls: calls });
}

const fragmentedToolSSE = [
  { choices: [{ delta: { tool_calls: [
    { index: 0, id: 'call_', type: 'function', function: { name: 'conversation_', arguments: '{"query":"公开' } },
  ] } }] },
  { choices: [{ delta: { tool_calls: [
    { index: 0, id: 'search1', function: { name: 'search', arguments: '信息","type":"text2text","max_results":3}' } },
  ] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 13 } },
];
const fragmentedResult = parseChatBody(fragmentedToolSSE.map(event => 'data: ' + JSON.stringify(event)).join('\n\n') + '\n\ndata: [DONE]\n');
assert.deepEqual(fragmentedResult.toolCalls, calls, 'tool IDs, names, and JSON arguments assemble across SSE fragments');
assert.equal(fragmentedResult.raw, '', 'tool preamble is not exposed as assistant speech');

const twoCalls = [calls[0], { id: 'call_search2', type: 'function', function: { name: 'conversation_search', arguments: '{"query":"另一个公开问题"}' } }];
assert.equal(parseChatBody(JSON.stringify({ choices: [{ message: { tool_calls: twoCalls } }] })).toolCalls.length, 2);
for (const malformed of [
  { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'conversation_search', arguments: '{}' } }] } }] },
  { choices: [{ message: { tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'conversation_search', arguments: '{"query":' } }] } }] },
  { choices: [{ message: { tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'conversation_search', arguments: '[]' } }] } }] },
  { choices: [{ message: { tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'search', arguments: '{"q":"' + 'x'.repeat(8000) + '"}' } }] } }] },
  { choices: [{ message: { tool_calls: Array.from({ length: 5 }, (_, i) => ({ id: 'call_' + i, type: 'function', function: { name: 'search', arguments: '{}' } })) } }] },
]) assert.throws(() => parseChatBody(JSON.stringify(malformed)), error => error.code === 'E_TOOL_PROTOCOL');
assert.throws(() => parseChatBody([
  'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'search', arguments: '{}' } }] } }] }),
  'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
].join('\n\n')), error => error.code === 'E_TOOL_PROTOCOL', 'incomplete streamed call without an id is rejected');
assert.throws(() => parseChatBody(JSON.stringify({ choices: [{ message: { tool_calls: [] }, finish_reason: 'tool_calls' }] })),
  error => error.code === 'E_TOOL_PROTOCOL', 'tool_calls finish without a call is rejected');
for (const empty of ['', 'data: [DONE]\n', '{"choices":[{"message":{"reasoning_content":"only reasoning"}}]}', '{"error":{"message":"must not expose upstream secrets"}}']) {
  assert.throws(() => parseChatBody(empty), error => error.code === 'E_EMPTY_RESPONSE' && error.message === 'WorkBuddy 没有返回可用回答，请重试。');
}
assert.throws(() => parseChatBody(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 90, completion_tokens: 200, total_tokens: 290, prompt_tokens_details: { sensitive: 'discard' } } })), error => {
  assert.equal(error.code, 'E_OUTPUT_LIMIT');
  assert.equal(error.finishReason, 'length');
  assert.deepEqual(error.usage, { prompt_tokens: 90, completion_tokens: 200, total_tokens: 290 });
  assert.equal(error.hasReasoning, false);
  assert.doesNotMatch(error.message, /sensitive|content|reasoning/i);
  assert.equal(Object.hasOwn(error, 'body'), false);
  return true;
});
assert.throws(() => parseChatBody('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'max_tokens' }], usage: { total_tokens: 4 } }) + '\n'), error => error.code === 'E_OUTPUT_LIMIT' && error.finishReason === 'max_tokens');
assert.throws(() => parseChatBody(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'not copied to error' }, finish_reason: 'stop' }], usage: { total_tokens: 8 } })), error => error.code === 'E_EMPTY_RESPONSE' && error.hasReasoning && !JSON.stringify(error).includes('not copied'));
const payload = chatPayload({ model: 'deepseek-v4.1-flash', messages: [], thinking: 'high', maxTokens: 2048 });
assert.equal(parseChatBody(JSON.stringify({ ...message, usage: { total_tokens: 31, credit: 0.04, ignoredAccountData: 'fixture-only' } })).usage.credit, 0.04,
  'fractional account usage remains visible while unrelated usage fields are dropped');
assert.equal(payload.stream, true, 'the real WorkBuddy endpoint requires streaming requests');
assert.equal(payload.max_tokens, 2048);
assert.equal(payload.reasoning_effort, 'high');
assert.equal(chatPayload({ messages: [], extraBody: { stream: false } }).stream, true, 'provider-specific extras cannot select the unsupported non-stream mode');
assert.equal(chatPayload({ messages: [], thinking: 'low', extraBody: { response_format: { type: 'json_object' } } }).reasoning_effort, 'low', 'thinking is added when extraBody lacks it');
assert.equal(chatPayload({ messages: [], thinking: 'high', extraBody: { reasoning_effort: 'low', response_format: { type: 'json_object' } } }).reasoning_effort, 'low', 'explicit extraBody thinking setting is preserved');

async function testFreeMemoryExtractionUsesOneBoundedFreeCall() {
  const wb = require('../src/main/workbuddy');
  const free = require('../src/main/workbuddy-free');
  const oldRequest = wb.request, oldChat = wb.chat;
  let chatCalls = 0, captured;
  wb.request = async () => ({ body: JSON.stringify({ code: 0, data: { models: [{ id: 'hy3', credits: 'x0' }] } }) });
  wb.chat = async options => { chatCalls++; captured = options; return { text: '{"memories":[],"excerpts":[]}' }; };
  try {
    const result = await free.extractMemories([{ id: 'm1', role: 'user', content: '公开合成消息' }]);
    assert.deepEqual(result, { memories: [], excerpts: [] });
    assert.equal(chatCalls, 1, 'does not hide a retry that consumes worker budget');
    assert.equal(captured.model, 'hy3');
    assert.equal(captured.maxTokens, 8192);
    assert.equal(captured.thinking, 'low');
    assert.deepEqual(captured.extraBody, { reasoning_effort: 'low', response_format: { type: 'json_object' } });
  } finally { wb.request = oldRequest; wb.chat = oldChat; }
}

async function testToolCallProducesNoSpeechCallbacks() {
  const callbacks = [];
  let requests = 0;
  const result = await chatWithTransport({ messages: [], onDelta: value => callbacks.push(['delta', value]),
    onSentence: value => callbacks.push(['sentence', value]) }, async (params, options) => {
      requests++;
      assert.equal(params.path, '/v2/chat/completions');
      assert.equal(options.timeoutMs, undefined);
      return { body: JSON.stringify({ choices: [{ message: { content: '不可见的工具前言', tool_calls: calls }, finish_reason: 'tool_calls' }] }) };
    });
  assert.equal(requests, 1);
  assert.equal(result.text, '');
  assert.equal(result.raw, '');
  assert.deepEqual(result.toolCalls, calls);
  assert.deepEqual(callbacks, [], 'tool requests do not enter speech or sentence callbacks');
}

async function testNoFreeModelHasStableCodeWithoutPaidFallback() {
  const { spawnSync } = require('node:child_process');
  const script = `const wb=require('./src/main/workbuddy'); wb.request=async()=>({body:JSON.stringify({code:0,data:{models:[{id:'paid-model',credits:'x1'}]}})}); require('./src/main/workbuddy-free').freeModel().then(()=>process.exit(2),e=>{if(e.code!=='E_FREE_MODEL_UNAVAILABLE')process.exit(3); process.stdout.write(e.message);});`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /没有确认免费的 WorkBuddy 模型/);
  assert.doesNotMatch(result.stdout, /paid-model/);
}

(async () => {
  await testFreeMemoryExtractionUsesOneBoundedFreeCall();
  await testToolCallProducesNoSpeechCallbacks();
  await testNoFreeModelHasStableCodeWithoutPaidFallback();
  assert.throws(() => require('../src/main/workbuddy-free').parseObject(''), error => error.code === 'E_EMPTY_RESPONSE');
  console.log('WorkBuddy transport response checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
