'use strict';
// Exercise the actual generic OpenAI-compatible SSE transport, not just the
// broker double. An ephemeral loopback server returns fragmented tool calls.
const assert = require('node:assert/strict'), http = require('node:http');
const { requestReply } = require('../src/main/reply-request');
const llm = require('../src/main/llm');
const { FIND, READ, TOOLS } = require('../src/main/conversation-recall');
const server = http.createServer();
let round = 0, reads = 0;
server.on('request', (req, res) => {
  let body = ''; req.on('data', p => { body += p; }); req.on('end', () => {
    try {
      const input = JSON.parse(body); round++;
      assert.equal(req.url, '/chat/completions');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
      if (round < 3) {
        assert(input.tools.some(t => t.function.name === FIND));
        assert(!input.tools.some(t => t.function.name === 'workbunny_web_search'));
        const name = round === 1 ? FIND : READ, args = JSON.stringify(round === 1 ? { query: '海风方案' } : { id: 'original-one' });
        emit({ tool_calls: [{ index: 0, id: 'call-' + round, type: 'function', function: { name: name.slice(0, 8), arguments: args.slice(0, 5) } }] });
        emit({ tool_calls: [{ index: 0, function: { name: name.slice(8), arguments: args.slice(5) } }] });
      } else {
        assert.equal(input.messages.at(-1).role, 'tool'); assert(input.messages.at(-1).content.includes('深蓝色'));
        emit({ content: JSON.stringify({ protocol: 'dialogue-v2', stages: [
          { stage: 'review', grade: 'unassessed', note: '核对了原话。', grasp: 'steady', pace: 'advance' },
          { stage: 'reply', reply: { kind: 'chat', text: '当时决定用深蓝色封面。' } }, { stage: 'prediction', expect: null, basis: [] },
        ] }) });
      }
      res.end('data: [DONE]\n\n');
    } catch (e) { res.destroy(e); }
  });
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = await requestReply({ chat: llm.chat, request: { baseURL: 'http://127.0.0.1:' + server.address().port,
    apiKey: 'synthetic', provider: 'deepseek', model: 'synthetic', cognitive: true, timeoutMs: 5000, maxTokens: 4096,
    webSearch: false, messages: [{ role: 'user', content: '查找并读取海风方案原话。' }],
    recallSession: { tools: TOOLS, sourceIds: ['original-one'], run: async (name, args) => {
      reads++; if (name === FIND) { assert.equal(args.query, '海风方案'); return { results: [{ id: 'original-one' }] }; }
      assert.equal(name, READ); assert.equal(args.id, 'original-one'); return { content: '深蓝色' };
    } } } });
  assert.equal(round, 3); assert.equal(reads, 2); assert.equal(result.reply.text, '当时决定用深蓝色封面。'); assert.equal(result.memoryRecall.calls, 2);
  assert(!result.raw.includes('prediction')); console.log('generic SSE recall transport passed: fragmented find/read tools, final ordered protocol, private data and speech boundary');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => server.close());
