'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { requestReply } = require('../src/main/reply-request');
const { createReplyStream } = require('../src/main/reply-stream');
const llm = require('../src/main/llm');
const security = require('../src/main/owner-security');
const workbuddy = require('../src/main/workbuddy');
const { chatWithSearch } = require('../src/main/conversation-search');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const review = { stage: 'review', grade: 'unassessed', note: 'internal review', grasp: 'steady', pace: 'listen' };
const cognition = reply => JSON.stringify({ protocol: 'dialogue-v2', stages: [review, { stage: 'reply', reply }, { stage: 'prediction', expect: 'internal prediction' }] });
const base = () => ({ streamText: true, cognitive: true, timeoutMs: 5000, messages: [{ role: 'user', content: 'hello' }] });
const workbuddyBody = raw => 'data: ' + JSON.stringify({ choices: [{ delta: { content: raw } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';

test('real HTTP SSE exposes chat text and its first sentence before model completion', async t => {
  const finish = gate(), sentence = gate(); const deltas = [], sentences = [];
  const raw = cognition({ kind: 'chat', text: '先回答一句。后续还在生成。' });
  const cut = raw.indexOf('后续');
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = content => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
    send(raw.slice(0, cut)); await finish.promise; send(raw.slice(cut));
    res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { finish.resolve(); server.closeAllConnections(); server.close(); });
  let settled = false;
  const pending = requestReply({ chat: llm.chat, request: { ...base(), transport: 'apikey', provider: 'openai', apiKey: 'fixture', model: 'fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    onTextDelta: text => deltas.push(text), onTextSentence: text => { sentences.push(text); sentence.resolve(); } } }).then(value => { settled = true; return value; });
  await Promise.race([sentence.promise, new Promise((_, reject) => setTimeout(() => reject(Error('first sentence did not stream')), 2000))]);
  assert.equal(settled, false); assert.equal(deltas.join(''), '先回答一句。'); assert.deepEqual(sentences, ['先回答一句。']);
  finish.resolve(); const result = await pending;
  assert.equal(result.text, '先回答一句。后续还在生成。');
  assert.equal(deltas.join(''), result.text); assert.deepEqual(sentences, ['先回答一句。', '后续还在生成。']);
});

test('all chunk boundaries keep metadata, escaped JSON, tags, skip and intents out of the visible stream', async () => {
  const text = '你好😀。<m>wave</m>再聊聊。';
  for (const size of [1, 2, 7, 43]) {
    const deltas = [], sentences = [], raw = cognition({ kind: 'chat', text });
    const stream = createReplyStream({ cognitive: true, onDelta: value => deltas.push(value), onSentence: value => sentences.push(value) });
    for (let i = 0; i < raw.length; i += size) stream.push(raw.slice(i, i + size));
    stream.finish(text); assert.equal(deltas.join(''), '你好😀。再聊聊。'); assert.deepEqual(sentences, ['你好😀。', '再聊聊。']);
  }
  for (const reply of [{ kind: 'skip' }, { kind: 'chat', text: '' }, { kind: 'action', intent: { action: 'agent' } }]) {
    const deltas = [], sentences = [], raw = cognition(reply);
    const result = await requestReply({ request: { ...base(), allowEmptyVoiceDecision: true, onTextDelta: text => deltas.push(text), onTextSentence: text => sentences.push(text) }, chat: async options => {
      for (const char of raw) options.onDelta(char); return { raw };
    } });
    assert(result.reply.skipped || result.reply.intent); assert.deepEqual(deltas, []); assert.deepEqual(sentences, []);
  }
});

test('cancelled provider callbacks and reset tool rounds cannot append to a presented reply', async () => {
  const controller = new AbortController(), finish = gate(), entered = gate(), deltas = [], sentences = [];
  const raw = cognition({ kind: 'chat', text: '先说一句。迟到的旧句。' }), cut = raw.indexOf('迟到'); let options;
  const pending = requestReply({ request: { ...base(), signal: controller.signal, onTextDelta: text => deltas.push(text), onTextSentence: text => sentences.push(text) }, chat: async value => {
    options = value; options.onStreamReset(); options.onDelta(raw.slice(0, cut)); entered.resolve(); await finish.promise; options.onDelta(raw.slice(cut)); return { raw };
  } });
  await entered.promise; assert.throws(() => options.onStreamReset(), { code: 'E_REPLY_PROTOCOL' });
  controller.abort(); await assert.rejects(pending); finish.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(deltas.join(''), '先说一句。'); assert.deepEqual(sentences, ['先说一句。']);
});

test('a protected owner key is withheld and redacted across provider chunks', () => {
  security.activate({ protectedValues: new Set(['private-test-key']) });
  try {
    const deltas = [], stream = createReplyStream({ onDelta: text => deltas.push(text) });
    stream.push('{"kind":"chat","text":"你好 private-test-'); assert.equal(deltas.join(''), '你好');
    stream.push('key，继续。"}'); stream.finish('你好 private-test-key，继续。');
    assert.equal(deltas.join(''), '你好 ********，继续。');
  } finally { security.activate(null); }
});

test('a malformed suffix after visible speech fails once without replaying a repair', async () => {
  const deltas = []; let calls = 0;
  await assert.rejects(requestReply({ selfRepair: true, request: { streamText: true, messages: [{ role: 'user', content: 'hi' }], onTextDelta: text => deltas.push(text) }, chat: async options => {
    calls++; options.onDelta('{"kind":"chat","text":"可见的一句。'); options.onDelta('","extra":true}'); return { raw: '{"kind":"chat","text":"可见的一句。","extra":true}' };
  } }), { code: 'E_REPLY_PROTOCOL' });
  assert.equal(calls, 1); assert.equal(deltas.join(''), '可见的一句。');
});

test('a complete malformed packet never presents its chat-looking text', async () => {
  const deltas = [], raw = '{"kind":"chat","text":"不该显示。","extra":true}';
  await assert.rejects(requestReply({ maxRepairs: 0, request: { streamText: true, messages: [{ role: 'user', content: 'hi' }], onTextDelta: text => deltas.push(text) }, chat: async options => {
    options.onDelta(raw); return { raw };
  } }), { code: 'E_REPLY_PROTOCOL' });
  assert.deepEqual(deltas, []);
});

test('legal ASR chat disposition fields may arrive in any order without duplicate text or lost speech', async () => {
  const orderings = [['kind', 'text', 'turnDisposition'], ['kind', 'turnDisposition', 'text'], ['text', 'kind', 'turnDisposition'],
    ['text', 'turnDisposition', 'kind'], ['turnDisposition', 'kind', 'text'], ['turnDisposition', 'text', 'kind']];
  for (const order of orderings) for (const size of [1, 1000]) {
    const values = { kind: 'chat', text: '合法的语音回复。', turnDisposition: 'replace' }, deltas = [], sentences = [];
    const raw = cognition(Object.fromEntries(order.map(key => [key, values[key]])));
    const result = await requestReply({ request: { ...base(), allowTurnDisposition: true, onTextDelta: text => deltas.push(text), onTextSentence: text => sentences.push(text) }, chat: async options => {
      for (let i = 0; i < raw.length; i += size) options.onDelta(raw.slice(i, i + size)); return { raw };
    } });
    assert.equal(result.reply.turnDisposition, 'replace'); assert.equal(deltas.join(''), values.text); assert.deepEqual(sentences, [values.text]);
  }
});

test('buffered WorkBuddy malformed JSON/envelopes retain repair before any text or audio is presented', async () => {
  const good = cognition({ kind: 'chat', text: '完整校验后的回复。' });
  for (const bad of [good.slice(0, -1), good + ' trailing prose', JSON.stringify({ ...JSON.parse(good), extra: true })]) {
    const deltas = [], sentences = [], diagnostics = []; let calls = 0;
    const result = await requestReply({ request: { ...base(), transport: 'workbuddy', provider: 'workbuddy', onTextDelta: text => deltas.push(text), onTextSentence: text => sentences.push(text), onProtocolDiagnostic: stats => diagnostics.push(stats) },
      chat: options => workbuddy.chatWithTransport(options, async () => {
        assert.deepEqual(deltas, []); assert.deepEqual(sentences, []);
        return { body: workbuddyBody(++calls === 1 ? bad : good) };
      }) });
    assert.equal(calls, 2); assert.equal(result.attempts, 2); assert.equal(result.repaired, true);
    assert.deepEqual(deltas, ['完整校验后的回复。']); assert.deepEqual(sentences, ['完整校验后的回复。']);
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].delivery, 'complete'); assert.equal(diagnostics[0].streamPresented, false);
    assert.equal(diagnostics[0].attempt, 1); assert.equal(diagnostics[0].charCount, bad.length); assert(['json', 'envelope'].includes(diagnostics[0].stage));
  }
});

test('buffered WorkBuddy still degrades valid core chat and keeps skip/action out of presentation', async () => {
  for (const reply of [{ kind: 'chat', text: '核心回复仍可使用。' }, { kind: 'skip' }, { kind: 'action', intent: { action: 'agent' } }]) {
    const deltas = [], sentences = [], raw = reply.kind === 'chat' ? JSON.stringify(reply) : cognition(reply);
    const result = await requestReply({ request: { ...base(), transport: 'workbuddy', provider: 'workbuddy', onTextDelta: text => deltas.push(text), onTextSentence: text => sentences.push(text) },
      chat: options => workbuddy.chatWithTransport(options, async () => ({ body: workbuddyBody(raw) })) });
    if (reply.kind === 'chat') { assert.equal(result.cognitionDegraded, true); assert.deepEqual(deltas, [reply.text]); assert.deepEqual(sentences, [reply.text]); }
    else { assert.deepEqual(deltas, []); assert.deepEqual(sentences, []); assert(result.reply.skipped || result.reply.intent); }
  }
});

test('WorkBuddy completion delivery survives search rounds and malformed final recovery', async () => {
  const good = cognition({ kind: 'chat', text: '搜索后校验通过的回复。' }), bad = good.slice(0, -1);
  const deltas = [], sentences = []; let calls = 0, searches = 0;
  const result = await requestReply({ request: { ...base(), transport: 'workbuddy', provider: 'workbuddy', webSearch: true,
    onTextDelta: text => deltas.push(text), onTextSentence: text => sentences.push(text) }, chat: options => chatWithSearch(options, {
    chat: input => workbuddy.chatWithTransport(input, async () => {
      assert.deepEqual(deltas, []); assert.deepEqual(sentences, []); calls++;
      if (calls === 1) return { body: JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'workbunny_web_search', arguments: '{"query":"fixture topic"}' } }] }, finish_reason: 'tool_calls' }] }) };
      return { body: workbuddyBody(calls === 2 ? bad : good) };
    }), search: async () => { searches++; return { results: [] }; },
  }) });
  assert.equal(calls, 3); assert.equal(searches, 1); assert.equal(result.repaired, true);
  assert.deepEqual(deltas, ['搜索后校验通过的回复。']); assert.deepEqual(sentences, ['搜索后校验通过的回复。']);
});

test('protocol diagnostics contain only fixed categories and counts', async () => {
  const diagnostics = [], raw = '{"private-field-name":"private-user-words"}';
  await assert.rejects(requestReply({ maxRepairs: 0, request: { ...base(), provider: 'private-provider-value', onProtocolDiagnostic: stats => diagnostics.push(stats) }, chat: async () => ({ raw }) }), { code: 'E_REPLY_PROTOCOL' });
  assert.deepEqual(diagnostics, [{ stage: 'envelope', attempt: 1, charCount: raw.length, streamPresented: false, provider: 'other', delivery: 'none',
    cognitive: true, coreFallback: false, jsonValid: true, rootType: 'object', rootFieldCount: 1, stageCount: 0,
    hasRootPerformance: false, hasRootTurnDisposition: false, replyKind: 'other', replyFieldCount: 0, hasReplyPerformance: false }]);
  assert(!JSON.stringify(diagnostics).includes('private-'));
});

test('protocol diagnostics distinguish misplaced performance without exposing field names or values', async () => {
  const cases = [
    [Object.assign(JSON.parse(cognition({ kind: 'chat', text: 'private-body' })), { performance: 'private-root-performance' }),
      { hasRootPerformance: true, hasRootTurnDisposition: false, replyKind: 'chat', replyFieldCount: 2, hasReplyPerformance: false }],
    [Object.assign(JSON.parse(cognition({ kind: 'chat', text: '', performance: 'private-inner-performance' })), { turnDisposition: 'private-disposition' }),
      { hasRootPerformance: false, hasRootTurnDisposition: true, replyKind: 'chat', replyFieldCount: 3, hasReplyPerformance: true }],
    [JSON.parse(cognition({ kind: 'private-kind', text: 'private-body', performance: 'private-inner-performance', 'private-field-name': true })),
      { hasRootPerformance: false, hasRootTurnDisposition: false, replyKind: 'other', replyFieldCount: 4, hasReplyPerformance: true }],
  ];
  for (const [value, expected] of cases) {
    const diagnostics = [];
    await assert.rejects(requestReply({ maxRepairs: 0, request: { ...base(), onProtocolDiagnostic: stats => diagnostics.push(stats) },
      chat: async () => ({ raw: JSON.stringify(value) }) }), { code: 'E_REPLY_PROTOCOL' });
    assert.equal(diagnostics.length, 1);
    for (const [key, expectedValue] of Object.entries(expected)) assert.equal(diagnostics[0][key], expectedValue, key);
    assert(!JSON.stringify(diagnostics).includes('private-'));
  }
});

test('unfinished typed control containers never leak payload words or invalidate a valid streamed answer', async () => {
  for (const control of ['<m>slow wave</m>', '<e>not a valid emotion</e>', '<M data="fixture">slow wave</M>']) {
    const deltas = [], sentences = [], raw = cognition({ kind: 'chat', text: '你好' + control + '。再聊聊。' });
    const result = await requestReply({ request: { ...base(), onTextDelta: text => deltas.push(text), onTextSentence: text => sentences.push(text) }, chat: async options => {
      for (const char of raw) options.onDelta(char); return { raw };
    } });
    assert.equal(result.text, '你好。再聊聊。'); assert.equal(deltas.join(''), result.text); assert.deepEqual(sentences, ['你好。', '再聊聊。']);
    assert(!deltas.some(text => /slow|wave|valid|emotion|fixture|[<>]/u.test(text)));
  }
});
