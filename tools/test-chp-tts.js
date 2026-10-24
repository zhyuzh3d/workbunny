'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const chp = require('../src/main/chp-tts');
function document() { return { spec: 'chp/2', plugin: { version: '3.2.0' }, endpoints: { speech: '/custom/speak' }, speech: {
  rules: [{ signature: 'txt-2-sph', input: 'txt-2-sph/v1' }],
  input_schemas: { 'txt-2-sph/v1': { properties: { text: { maxLength: 2000 }, voice: { type: 'string' } } } },
  abilities: [{ name: 'qwen3-tts-0.6b', ready: true, files: { engine: 'customvoice.gguf' }, audio: { sample_rate: 24000, channels: 1, formats: ['pcm', 'wav'] },
    voices: [{ id: 'vivian', label: 'Vivian' }, { id: 'serena', label: 'Serena' }] }],
} }; }
function wav() { const b = Buffer.alloc(4844); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4800, 40); return b; }
async function server(t, handler) { const s = http.createServer(handler); await new Promise(r => s.listen(0, '127.0.0.1', r)); t.after(() => { chp.cancel(); s.closeAllConnections(); return new Promise(r => s.close(r)); }); return 'http://127.0.0.1:' + s.address().port; }
test('root fallback, exact published endpoint, deployed voice menu, body-only POST key, and unchanged Chinese text', async t => {
  const calls = [], key = 'private-key';
  const baseURL = await server(t, (req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/') { res.writeHead(404).end(); return; }
    if (req.url === '/chp/info') { assert.equal(req.headers.authorization, 'Bearer ' + key); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(document())); return; }
    assert.equal(req.url, '/custom/speak'); assert.equal(req.headers.authorization, undefined);
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { text: '请原样朗读：你好。', voice: 'serena', stream: false, response_format: 'wav', chp_params: { password: key } });
      res.setHeader('Content-Type', 'audio/wav'); res.end(wav());
    });
  });
  const cfg = { baseURL, apiKey: key, chp: { voice: 'serena' } };
  const list = await chp.discover(cfg); assert.equal(list.model, 'qwen3-tts-0.6b'); assert.equal(list.voices.length, 2);
  const result = await chp.synthesize('请原样朗读：你好。', cfg); assert.equal(result.voice, 'serena'); assert.equal(result.buffer.length, 4844);
  assert.deepEqual(calls.map(c => c.url), ['/', '/chp/info', '/custom/speak']);
  assert.equal(chp.cached({ ...cfg, apiKey: 'another-key' }), null);
  await assert.rejects(chp.synthesize('hello', { ...cfg, chp: { voice: 'unknown' } }), /重新获取/);
});
test('CHP 401 is not hidden by URL fallback and raw errors never expose credentials', async t => {
  let count = 0; const baseURL = await server(t, (_req, res) => { count++; res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ spec: 'chp/2', secret: 'do-not-echo' })); });
  await assert.rejects(chp.discover({ baseURL }), e => /密钥/.test(e.message) && !/do-not-echo/.test(e.message)); assert.equal(count, 1);
});
test('a full path is not rewritten; image-only, unready, cross-host and incompatible audio cannot enter the menu', async t => {
  let count = 0; const baseURL = await server(t, (_req, res) => { count++; res.writeHead(404).end('not CHP'); });
  await assert.rejects(chp.discover({ baseURL: baseURL + '/specific' }), /不是 CHP/); assert.equal(count, 1);
  const url = new URL(baseURL), d = document();
  assert.throws(() => chp.parse({ spec: 'chp/2' }, url), /版本/);
  d.speech.rules = []; assert.throws(() => chp.parse(d, url), /TTS/);
  const unready = document(); unready.speech.abilities[0].ready = false; assert.throws(() => chp.parse(unready, url), /未就绪/);
  const cross = document(); cross.endpoints.speech = 'https://elsewhere.example/speech'; assert.throws(() => chp.parse(cross, url), /同一服务/);
  const stereo = document(); stereo.speech.abilities[0].audio.channels = 2; assert.throws(() => chp.parse(stereo, url), /单声道/);
  const bad = wav(); bad.writeUInt32LE(48000, 24); assert.throws(() => chp.validateWav(bad), /24 kHz/);
  assert.throws(() => chp.validateWav(wav().subarray(0, 100)), /不完整/);
});
test('cancelling a live request returns AbortError instead of playing a system fallback', async t => {
  let arrived; const started = new Promise(r => arrived = r);
  const baseURL = await server(t, (req, res) => { if (req.method === 'GET') res.end(JSON.stringify(document())); else arrived(); });
  const cfg = { baseURL }; await chp.discover(cfg);
  const pending = chp.synthesize('取消这一句。', cfg); await started; chp.cancel();
  await assert.rejects(pending, { name: 'AbortError' });
});
