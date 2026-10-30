#!/usr/bin/env node
'use strict';

// Isolated protocol tests. All transports are local stubs; no account or
// public-network request is made by this file.
const assert = require('node:assert/strict');
const { chatWithSearch, TOOL_NAME, mayUseWebSearch } = require('../src/main/conversation-search');
const { searchPublicWeb, publicURL } = require('../src/main/workbuddy-search');

function toolCall(id, query, name = TOOL_NAME) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify({ query }) } };
}
function final(text = '根据已有资料作答。') { return { text, raw: text, model: 'fixture-model' }; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function testOrdinaryReplyDoesNotSearch() {
  let chatCalls = 0, searchCalls = 0;
  const result = await chatWithSearch({ messages: [{ role: 'user', content: '你好' }] }, {
    chat: async () => { chatCalls++; return final('你好。'); },
    search: async () => { searchCalls++; return { results: [] }; },
  });
  assert.equal(chatCalls, 1);
  assert.equal(searchCalls, 0);
  assert.deepEqual(result.webSearch, { enabled: true, searched: false, calls: 0, modelCalls: 1, sources: [] });
  assert.equal(result.text, '你好。');
}

async function testToolRoundStructureAndSpeechIsolation() {
  const query = '2026年东京天气预报';
  const published = [], spoken = [], searches = [];
  let chatCalls = 0;
  const result = await chatWithSearch({ messages: [{ role: 'user', content: '帮我查东京天气' }],
    onSearch: value => published.push(value), onDelta: value => spoken.push(['delta', value]),
    onSentence: value => spoken.push(['sentence', value]) }, {
    chat: async options => {
      chatCalls++;
      assert.equal(options.onDelta, undefined, 'intermediate model tool text is never emitted');
      assert.equal(options.onSentence, undefined);
      if (chatCalls === 1) {
        assert.equal(options.extraBody.tools[0].function.name, TOOL_NAME);
        return { text: '不得朗读工具前言', raw: '不得朗读工具前言', toolCalls: [toolCall('call-1', query)] };
      }
      const assistant = options.messages.at(-2), tool = options.messages.at(-1);
      assert.equal(assistant.role, 'assistant');
      assert.equal(assistant.content, null);
      assert.equal(assistant.tool_calls[0].id, 'call-1');
      assert.equal(tool.role, 'tool');
      assert.equal(tool.tool_call_id, 'call-1');
      const reference = JSON.parse(tool.content);
      assert.equal(reference.trust, 'untrusted-public-reference-data');
      assert.equal(reference.results[0].title, '天气参考');
      assert.equal(reference.results[0].snippet, '公开预报摘要');
      return final('东京天气请参考最新预报。');
    },
    search: async input => {
      searches.push(input);
      assert.equal(input.query, query);
      assert.equal(Object.hasOwn(input, 'messages'), false, 'search never receives chat history');
      return { query, searchedAt: 123, results: [
        { title: '天气参考', url: 'https://weather.example.com/tokyo', snippet: '公开预报摘要' },
      ] };
    },
  });
  assert.equal(chatCalls, 2);
  assert.equal(searches.length, 1);
  assert.deepEqual(published.map(row => row.status), ['searching', 'done']);
  assert.deepEqual(spoken, [['delta', '东京天气请参考最新预报。'], ['sentence', '东京天气请参考最新预报。']]);
  assert.equal(result.webSearch.calls, 1);
  assert.equal(result.webSearch.modelCalls, 2);
  assert.deepEqual(result.webSearch.sources, [{ url: 'https://weather.example.com/tokyo', title: '天气参考' }]);
}

function testPublicURLPolicy() {
  assert.equal(publicURL('https://example.com/path'), 'https://example.com/path');
  for (const url of [
    'http://127.0.0.1/private',
    'http://chp.example.invalid/',
    'https://10.0.0.8/',
    'http://[::1]/',
    'https://user:pass@example.com/private',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://host.local/',
  ]) assert.equal(publicURL(url), null, 'private or unsafe address rejected');
}

async function testSearchTransportContractAndSecretQueryRejection() {
  let captured, requestCount = 0;
  const result = await searchPublicWeb({ query: '公开主题查询', timeoutMs: 40000 }, {
    request: async (params, options) => {
      requestCount++;
      captured = { params, options };
      return { status: 200, body: JSON.stringify({ code: 0, results: [
        { title: '公开页面', url: 'https://public.example.org/a', snippet: '普通公开摘要' },
        { title: '内网页面', url: 'http://10.0.0.2/', snippet: '不应显示' },
        { title: '敏感摘要', url: 'https://other.example.org/', snippet: 'api_key=abcdabcdabcdabcd' },
      ] }) };
    },
  });
  assert.equal(requestCount, 1);
  assert.equal(captured.params.method, 'POST');
  assert.equal(captured.params.path, '/agenttool/v1/search');
  assert.deepEqual(JSON.parse(Buffer.from(captured.params.body_b64, 'base64').toString('utf8')),
    { query: '公开主题查询', type: 'text2text', max_results: 3 });
  assert.equal(captured.options.timeoutMs, 22000, 'search timeout is capped at 22 seconds');
  assert.deepEqual(result.results.map(row => row.title), ['公开页面'], 'private URLs and secret-bearing snippets are removed');

  let secretRequests = 0;
  await assert.rejects(searchPublicWeb({ query: 'api_key=abcdabcdabcdabcd' }, {
    request: async () => { secretRequests++; throw new Error('must not run'); },
  }), error => error.code === 'E_SEARCH_QUERY');
  assert.equal(secretRequests, 0, 'secret query is rejected before outbound request construction');
}

async function testModelSecretQueryDoesNotLeaveProcess() {
  let searchCalls = 0, toolReply;
  const result = await chatWithSearch({ messages: [{ role: 'user', content: 'private chat' }] }, {
    chat: async options => {
      if (options.messages.some(row => row.role === 'tool')) {
        toolReply = JSON.parse(options.messages.at(-1).content);
        return final('我没有联网核实这条信息。');
      }
      return { toolCalls: [toolCall('secret-call', 'api_key=abcdabcdabcdabcd')] };
    },
    search: async () => { searchCalls++; return { results: [] }; },
  });
  assert.equal(searchCalls, 0);
  assert.match(toolReply.error, /不适合外发|格式无效/u);
  assert.doesNotMatch(JSON.stringify(toolReply), /abcdabcdabcdabcd/u);
  assert.deepEqual(result.webSearch.sources, []);
}

async function testUnknownToolAndSearchFailure() {
  let searches = 0, finalCalls = 0;
  await assert.rejects(chatWithSearch({ messages: [] }, {
    chat: async () => ({ toolCalls: [toolCall('bad-tool', '公开查询', 'shell_exec')] }),
    search: async () => { searches++; return { results: [] }; },
  }), error => error.code === 'E_TOOL_PROTOCOL');
  assert.equal(searches, 0);

  let modelSawError;
  const failed = await chatWithSearch({ messages: [] }, {
    chat: async options => {
      if (options.messages.some(row => row.role === 'tool')) {
        finalCalls++;
        modelSawError = JSON.parse(options.messages.at(-1).content);
        return final('我现在无法核实该信息。');
      }
      return { toolCalls: [toolCall('failure-call', '公开查询')] };
    },
    search: async () => { throw Object.assign(new Error('private upstream detail'), { code: 'E_WEB_SEARCH' }); },
  });
  assert.equal(finalCalls, 1, 'search failure goes back to the model for a grounded final response');
  assert.match(modelSawError.error, /暂不可用/u);
  assert.deepEqual(failed.webSearch.sources, [], 'failure creates no clickable or fabricated source');
}

async function testAbortSuppressesFinalCallbacks() {
  const controller = new AbortController();
  let searchStartedResolve, releaseSearch;
  const searchStarted = new Promise(resolve => { searchStartedResolve = resolve; });
  const searchGate = new Promise(resolve => { releaseSearch = resolve; });
  const callbacks = [];
  const pending = chatWithSearch({ messages: [], signal: controller.signal, onDelta: value => callbacks.push(value),
    onSentence: value => callbacks.push(value) }, {
    chat: async () => ({ toolCalls: [toolCall('abort-call', '公开查询')] }),
    search: async () => { searchStartedResolve(); await searchGate; return { results: [] }; },
  });
  await searchStarted;
  controller.abort();
  releaseSearch();
  await assert.rejects(pending, error => error.code === 'E_ABORTED');
  assert.deepEqual(callbacks, [], 'aborted tool round emits no final speech callbacks');
}

async function testSearchAndRoundLimits() {
  let chatCalls = 0, searchCalls = 0, speech = 0;
  const queryCalls = round => Array.from({ length: 2 }, (_, i) => toolCall('r' + round + '-' + i, '公开主题' + round + '-' + i));
  await assert.rejects(chatWithSearch({ messages: [], onDelta: () => speech++ }, {
    chat: async () => {
      chatCalls++;
      if (chatCalls <= 2) return { toolCalls: queryCalls(chatCalls) };
      return { toolCalls: [toolCall('too-late', 'another public query')] };
    },
    search: async ({ query }) => { searchCalls++; return { results: [{ title: query,
      url: 'https://' + searchCalls + '.example.org/', snippet: 'public' }] }; },
  }), error => error.code === 'E_TOOL_PROTOCOL');
  assert.equal(chatCalls, 3, 'loop permits initial response and two follow-up rounds');
  assert.equal(searchCalls, 3, 'search execution is globally limited to three calls per reply');
  assert.equal(speech, 0, 'over-limit loop emits no partial final answer');
}

async function testSearchCacheRetainsDeduplicatedSources() {
  const query = '缓存查询主题';
  const cached = { query, results: [
    { title: '缓存来源', url: 'https://cached.example.net/page', snippet: 'cached' },
    { title: '重复来源标题', url: 'https://cached.example.net/page', snippet: 'same URL' },
  ] };
  let searches = 0;
  const result = await chatWithSearch({ messages: [], searchCache: new Map([[query, cached]]) }, {
    chat: async options => options.messages.some(row => row.role === 'tool') ? final('使用已缓存资料回答。')
      : { toolCalls: [toolCall('cached-1', query), toolCall('cached-2', query)] },
    search: async () => { searches++; return { results: [] }; },
  });
  assert.equal(searches, 0, 'same-query references reuse the supplied cache');
  assert.equal(result.webSearch.calls, 0);
  assert.equal(result.webSearch.searched, true, 'cached results still count as search-backed');
  assert.equal(result.webSearch.sources.length, 1, 'repeated cached references deduplicate by canonical public URL');
  assert.deepEqual(result.webSearch.sources[0], { url: 'https://cached.example.net/page', title: '缓存来源' },
    'cached reuse preserves the first real title for a repeated URL');
}

async function testModelCallUsageAggregation() {
  let modelCalls = 0;
  const result = await chatWithSearch({ messages: [] }, {
    chat: async () => {
      modelCalls++;
      if (modelCalls === 1) return { toolCalls: [toolCall('usage-call', '公开用量主题')],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, input_tokens: 9, output_tokens: -2, credit: 0.1 } };
      return { ...final('已核实。'),
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9, input_tokens: 4, output_tokens: 4, credit: 0.2,
          ignored: 999, invalid: Infinity } };
    },
    search: async () => ({ results: [] }),
  });
  assert.equal(result.webSearch.modelCalls, 2);
  assert.deepEqual(result.usage, { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22,
    input_tokens: 13, output_tokens: 4, credit: 0.30000000000000004 });
}

function testSearchIntentOptOutAndFreshness() {
  assert.equal(mayUseWebSearch('不要联网，基于聊天回答'), false);
  assert.equal(mayUseWebSearch("don't browse; answer from the conversation", ), false);
  assert.equal(mayUseWebSearch('今天上海下雨吗'), true);
}

async function testOverallDeadlineDecreases() {
  const timeouts = [];
  let chatCalls = 0;
  const result = await chatWithSearch({ messages: [], timeoutMs: 2000 }, {
    chat: async options => {
      timeouts.push(options.timeoutMs);
      chatCalls++;
      if (chatCalls === 1) { await wait(40); return { toolCalls: [toolCall('timeout-call', '时效公开查询')] }; }
      return final('最终回复。');
    },
    search: async options => { timeouts.push(options.timeoutMs); await wait(40); return { results: [] }; },
  });
  assert.equal(result.text, '最终回复。');
  assert.equal(timeouts.length, 3);
  assert(timeouts[0] > timeouts[1] && timeouts[1] > timeouts[2] && timeouts[2] > 0,
    'chat, search, and final chat each receive the decreasing remaining overall deadline');
}

async function main() {
  await testOrdinaryReplyDoesNotSearch();
  await testToolRoundStructureAndSpeechIsolation();
  testPublicURLPolicy();
  await testSearchTransportContractAndSecretQueryRejection();
  await testModelSecretQueryDoesNotLeaveProcess();
  await testUnknownToolAndSearchFailure();
  await testAbortSuppressesFinalCallbacks();
  await testSearchAndRoundLimits();
  await testSearchCacheRetainsDeduplicatedSources();
  await testModelCallUsageAggregation();
  testSearchIntentOptOutAndFreshness();
  await testOverallDeadlineDecreases();
  console.log('Conversation search protocol checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
