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
    assert.equal(captured.maxTokens, 4096);
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
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, calls);
  assert.deepEqual(callbacks, [], 'tool requests do not enter speech or sentence callbacks');
}

async function testCompletionDiagnosticsUseActualWirePayload() {
  const privateCanaries = ['private-response-body', 'private-reasoning-body', 'private-tool-arguments', 'private-usage-field'];
  for (const [code, finishReason, withTools] of [['E_OUTPUT_LIMIT', 'length', true], ['E_EMPTY_RESPONSE', 'stop', false]]) {
    let requests = 0, captured;
    await assert.rejects(chatWithTransport({ model: 'fixture-request-model', messages: [{ role: 'user', content: 'private-input-body' }],
      maxTokens: 8192, maxOutputTokens: 1536, extraBody: { model: 'fixture-wire-model' } }, async params => {
      requests++;
      captured = JSON.parse(Buffer.from(params.body_b64, 'base64').toString('utf8'));
      assert.equal(captured.model, 'fixture-wire-model');
      assert.equal(captured.max_tokens, 1536, 'context/model output ceiling is applied before transport');
      return { body: JSON.stringify({ model: 'fixture-upstream-model', choices: [{ message: {
        content: withTools ? privateCanaries[0] : '', reasoning_content: privateCanaries[1],
        ...(withTools ? { tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'fixture_tool', arguments: JSON.stringify({ query: privateCanaries[2] }) } }] } : {}),
      }, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 1536, total_tokens: 1556, private_field: privateCanaries[3] } }) };
    }), error => {
      assert.equal(error.code, code);
      assert.deepEqual(error.diagnostic.completion, { model: captured.model, maxOutputTokens: captured.max_tokens,
        finishReason, hasReasoning: true, usage: { prompt_tokens: 20, completion_tokens: 1536, total_tokens: 1556 } });
      const diagnostic = JSON.stringify(error.diagnostic);
      for (const value of [...privateCanaries, 'private-input-body', 'fixture-upstream-model']) assert(!diagnostic.includes(value));
      return true;
    });
    assert.equal(requests, 1, 'completion diagnostics do not retry inference');
  }
  let captured;
  await assert.rejects(chatWithTransport({ model: 'fixture-request-model', messages: [], maxTokens: 8192, maxOutputTokens: 1536,
    extraBody: { model: 'fixture-wire-model', max_tokens: 777 } }, async params => {
    captured = JSON.parse(Buffer.from(params.body_b64, 'base64').toString('utf8'));
    return { body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) };
  }), error => error.diagnostic.completion.model === captured.model && error.diagnostic.completion.maxOutputTokens === 777 && captured.max_tokens === 777);
  const catalog = require('../src/main/model-catalog'), originalGet = catalog.get;
  try {
    catalog.get = () => ({ models: [{ id: 'fixture-capped-model', maxOutputTokens: 512, contextWindow: 32768, maxInputTokens: 32768 }] });
    await assert.rejects(chatWithTransport({ model: 'fixture-capped-model', messages: [{ role: 'user', content: 'fixture request' }], maxTokens: 4096 }, async params => {
      captured = JSON.parse(Buffer.from(params.body_b64, 'base64').toString('utf8'));
      assert.equal(captured.max_tokens, 512, 'actual model capacity clamps the wire output budget');
      return { body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) };
    }), error => error.diagnostic.completion.model === 'fixture-capped-model' && error.diagnostic.completion.maxOutputTokens === captured.max_tokens);
  } finally { catalog.get = originalGet; }
  for (const finishReason of ['stop', null]) {
    const result = await chatWithTransport({ model: 'fixture-request-model', messages: [{ role: 'user', content: 'fixture request' }], maxTokens: 8192, maxOutputTokens: 1536 }, async () => ({
      body: JSON.stringify({ choices: [{ message: { content: 'fixture answer' }, ...(finishReason ? { finish_reason: finishReason } : {}) }] }),
    }));
    assert.equal(result.finishReason, finishReason, 'success keeps the parsed finish reason without inventing one');
    assert(result.contextBudget && typeof result.contextBudget === 'object', 'success retains context budgeting evidence');
  }
}

async function testNoFreeModelHasStableCodeWithoutPaidFallback() {
  const { spawnSync } = require('node:child_process');
  const script = `const wb=require('./src/main/workbuddy'); wb.request=async()=>({body:JSON.stringify({code:0,data:{models:[{id:'paid-model',credits:'x1'}]}})}); require('./src/main/workbuddy-free').freeModel().then(()=>process.exit(2),e=>{if(e.code!=='E_FREE_MODEL_UNAVAILABLE')process.exit(3); process.stdout.write(e.message);});`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /没有确认免费的 WorkBuddy 模型/);
  assert.doesNotMatch(result.stdout, /paid-model/);
}

async function testBrokerCannotReceiveRequestsWithoutProof() {
  const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
  const dir = fs.mkdtempSync('/tmp/bunny-broker-');
  const endpoint = path.join(dir, 'fixture.sock'), requests = [];
  const server = net.createServer(socket => {
    const lines = new (require('../src/main/json-lines').JsonLines)(4096);
    socket.on('data', chunk => lines.push(chunk, frame => {
      requests.push(frame);
      if (frame.type === 'session_hello') socket.write('{"type":"session_hello_ack","pipes":["wb.request"]}\n');
    }));
  });
  try {
    await new Promise(resolve => server.listen(endpoint, resolve));
    await assert.rejects(require('../src/main/workbuddy').request({ method: 'POST', path: '/fixture', body_b64: 'private' },
      { discover: () => ({ endpoint, ticket: 'fixture-ticket' }), timeoutMs: 1000 }), /身份验证|顺序/);
    assert.deepEqual(requests.map(frame => frame.type), ['session_hello']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testSafeTransportOriginsWithoutConnections() {
  const net = require('node:net'), crypto = require('node:crypto'), { EventEmitter } = require('node:events');
  const originalConnect = net.connect, endpoint = 'fixture-origin-endpoint', ticket = 'synthetic-fixture-ticket';
  async function rejectProtocol({ id = 2, error, oversized = false, requestPath='/fixture' }) {
    net.connect = () => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      const emit = frame => socket.emit('data', Buffer.isBuffer(frame) ? frame : Buffer.from(JSON.stringify(frame) + '\n'));
      socket.write = wire => queueMicrotask(() => {
        const frame = JSON.parse(wire);
        if (frame.type === 'session_hello') {
          const serverNonce = 'synthetic-server-nonce', parts = [];
          for (const value of ['wbipc-s', '1', endpoint, frame.client_nonce, serverNonce]) {
            const bytes = Buffer.from(value), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); parts.push(length, bytes);
          }
          emit({ type: 'session_challenge', server_nonce: serverNonce, server_proof: crypto.createHmac('sha256', ticket).update(Buffer.concat(parts)).digest('base64url') });
        } else if (frame.type === 'session_prove') emit({ type: 'session_hello_ack', pipes: ['wb.request'] });
        else if (frame.id === 1 && id === 2) emit({ id: 1, result: { channel: 'fixture', methods: ['http.fetch'] } });
        else if (oversized) emit(Buffer.alloc(2 * 1024 * 1024 + 1, 120));
        else emit({ id, error });
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    };
    try { await require('../src/main/workbuddy').request({ method: 'POST', path: requestPath }, { discover: () => ({ endpoint, ticket }), timeoutMs: 1000 }); }
    catch (failure) { return failure; }
    finally { net.connect = originalConnect; }
    assert.fail('synthetic protocol must reject');
  }
  const privateValue = 'private-upstream-error-canary';
  for (const [frame, expected] of [
    [{ id: 2, requestPath:'/v2/chat/completions', error: { code: 'E_PAYLOAD_TOO_LARGE', message: 'response exceeds inline limit of 655360 bytes', data: { private: privateValue } } }, { source: 'broker', stage: 'http-response', limitBytes: 655360,requestKind:'model-completion' }],
    [{ id: 1, error: { code: 'E_PAYLOAD_TOO_LARGE', message: privateValue, data: { limitBytes: 1234, private: privateValue } } }, { source: 'broker', stage: 'pipe-discovery', limitBytes: 1234 }],
    [{ id: 2, error: { code: 'E_PAYLOAD_TOO_LARGE', message: 'response exceeds inline limit of 655360 bytes ' + privateValue, data: { limitBytes: -1 } } }, { source: 'broker', stage: 'http-response' }],
    [{ id: 2, error: { code: 'E_PAYLOAD_TOO_LARGE', message: privateValue, data: { limitBytes: '655360' } } }, { source: 'broker', stage: 'http-response' }],
    [{ id: 2, error: { code: 'E_PAYLOAD_TOO_LARGE', message: 'response exceeds inline limit of 9007199254740992 bytes' } }, { source: 'broker', stage: 'http-response' }],
    [{ id: 2, oversized: true }, { source: 'local-jsonl', stage: 'frame', limitBytes: 2 * 1024 * 1024 }],
  ]) {
    const failure = await rejectProtocol(frame);
    assert.equal(failure.code, 'E_PAYLOAD_TOO_LARGE');
    assert.deepEqual(failure.diagnostic.transport, expected);
    for (const secret of [privateValue, ticket, endpoint]) assert(!JSON.stringify(failure).includes(secret));
  }
  const rejected = await rejectProtocol({ id: 2, error: { code: 'E_PAYLOAD_TOO_LARGE', message: 'response exceeds inline limit of 655360 bytes' } });
  let captured, requests = 0;
  await assert.rejects(chatWithTransport({ model: 'fixture-model', messages: [{ role: 'user', content: privateValue }], maxTokens: 4096 }, async params => {
    requests++; captured = JSON.parse(Buffer.from(params.body_b64, 'base64').toString('utf8')); throw rejected;
  }), error => {
    assert.equal(error, rejected);
    assert.deepEqual(error.diagnostic.transport, { source: 'broker', stage: 'http-response', limitBytes: 655360 });
    assert.deepEqual(error.diagnostic.completion, { model: captured.model, maxOutputTokens: captured.max_tokens });
    assert(error.diagnostic.budget && Number.isSafeInteger(error.diagnostic.budget.output));
    for (const key of ['finishReason', 'usage', 'hasReasoning']) assert(!Object.hasOwn(error.diagnostic.completion, key), 'unreceived completion metadata must remain absent');
    assert(!JSON.stringify(error.diagnostic).includes(privateValue));
    return true;
  });
  assert.equal(requests, 1);
}

(async () => {
  await testFreeMemoryExtractionUsesOneBoundedFreeCall();
  await testToolCallProducesNoSpeechCallbacks();
  await testCompletionDiagnosticsUseActualWirePayload();
  await testNoFreeModelHasStableCodeWithoutPaidFallback();
  await testBrokerCannotReceiveRequestsWithoutProof();
  await testSafeTransportOriginsWithoutConnections();
  assert.throws(() => require('../src/main/workbuddy-free').parseObject(''), error => error.code === 'E_EMPTY_RESPONSE');
  console.log('WorkBuddy transport response checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
