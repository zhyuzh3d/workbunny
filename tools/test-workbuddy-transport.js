'use strict';
const assert = require('node:assert/strict');
const { chatPayload, parseChatBody } = require('../src/main/workbuddy');

const content = '你好，主人。';
const message = { model: 'deepseek-v4.1-flash', choices: [{ message: { content, reasoning_content: 'internal reasoning must not be spoken' } }], usage: { total_tokens: 31 } };
for (const object of [message, { data: message }]) {
  const result = parseChatBody(JSON.stringify(object));
  assert.equal(result.raw, content);
  assert.equal(result.model, 'deepseek-v4.1-flash');
  assert.equal(result.usage.total_tokens, 31);
}
const events = [
  { model: 'deepseek-v4.1-flash', choices: [{ delta: { reasoning_content: 'private reasoning' } }] },
  { choices: [{ delta: { content: '你好，' } }] },
  { data: { choices: [{ delta: { content: '主人。' } }], usage: { total_tokens: 31 } } },
];
const sse = ': keepalive\n' + events.map(event => 'data: ' + JSON.stringify(event)).join('\n\n') + '\n\ndata: [DONE]\n';
assert.deepEqual(parseChatBody(sse), { raw: content, model: 'deepseek-v4.1-flash', usage: { total_tokens: 31 } });
for (const empty of ['', 'data: [DONE]\n', '{"choices":[{"message":{"reasoning_content":"only reasoning"}}]}', '{"error":{"message":"must not expose upstream secrets"}}']) {
  assert.throws(() => parseChatBody(empty), /^Error: WorkBuddy 没有返回回答/);
}
const payload = chatPayload({ model: 'deepseek-v4.1-flash', messages: [], thinking: 'high', maxTokens: 2048 });
assert.equal(payload.stream, true, 'the real WorkBuddy endpoint requires streaming requests');
assert.equal(payload.max_tokens, 2048);
assert.equal(payload.reasoning_effort, 'high');
assert.equal(chatPayload({ messages: [], extraBody: { stream: false } }).stream, true, 'provider-specific extras cannot select the unsupported non-stream mode');
console.log('WorkBuddy transport response checks passed');
