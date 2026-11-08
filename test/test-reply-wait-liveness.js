'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestReply } = require('../src/main/reply-request');
const { chatWithSearch } = require('../src/main/conversation-search');
const request = { timeoutMs: 10, messages: [{ role: 'user', content: 'fixture' }] };
test('requestReply total deadline releases a model that ignores cancellation and suppresses late presentation', async () => {
  let complete, published = 0;
  const pending = requestReply({ request: { ...request, onDelta: () => published++ }, chat: () => new Promise(resolve => { complete = resolve; }) });
  await assert.rejects(pending, { code: 'E_REPLY_TIMEOUT' });
  complete({ raw: JSON.stringify({ kind: 'chat', text: 'old' }) }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(published, 0);
});
test('requestReply cancellation releases a local recall tool that never returns', async () => {
  const controller = new AbortController(); let entered, complete;
  const started = new Promise(resolve => { entered = resolve; });
  const recall = { tools: [{ type: 'function', function: { name: 'fixture_recall' } }], run: () => { entered(); return new Promise(resolve => { complete = resolve; }); } };
  const pending = requestReply({ request: { ...request, timeoutMs: 1000, signal: controller.signal, recallSession: recall, webSearch: false },
    chat: opts => chatWithSearch(opts, { chat: async () => ({ toolCalls: [{ id: 'fixture', function: { name: 'fixture_recall', arguments: '{}' } }] }) }) });
  await started; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  complete({ rows: [] }); await new Promise(resolve => setImmediate(resolve));
});
