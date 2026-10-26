'use strict';
const assert = require('node:assert/strict');
const { chatPayload, parseChatBody } = require('../src/main/workbuddy');

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
  await testNoFreeModelHasStableCodeWithoutPaidFallback();
  assert.throws(() => require('../src/main/workbuddy-free').parseObject(''), error => error.code === 'E_EMPTY_RESPONSE');
  console.log('WorkBuddy transport response checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
