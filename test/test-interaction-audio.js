'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { InteractionAudio, Interactions } = require('../src/main/interaction');
const tts = require('../src/main/tts'), chp = require('../src/main/chp-tts');
function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-interaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, 'audio'), audio: new InteractionAudio(path.join(root, 'audio'), options) };
}
function wav() {
  const b = Buffer.alloc(44 + 480);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(480, 40);
  return b;
}
const profile = { engine: 'qwen', model: 'model-a', voice: 'serena' };
const result = () => ({ buffer: wav(), engine: 'qwen', voice: 'serena', degraded: false });
test('first action is synthesized once; the same action/model/voice survives restart and age', async t => {
  const { audio, dir } = fixture(t); let calls = 0;
  const generate = async () => { calls++; return result(); };
  const first = await audio.audio('greet_hello', '你好呀。', profile, generate);
  assert.equal(first.cached, undefined); assert.equal(calls, 1);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const old = new Date(Date.now() - 80 * 86400000); fs.utimesSync(file, old, old);
  const reused = await new InteractionAudio(dir).audio('greet_hello', '你好呀。', profile, generate);
  assert.equal(reused.cached, true); assert.equal(reused.streamed, false); assert.deepEqual(reused.buffer, first.buffer); assert.equal(calls, 1);
  for (const [action, phrase, voice] of [
    ['greet_hello', '你好呀。', { ...profile, voice: 'vivian' }],
    ['greet_hello', '你好呀。', { ...profile, model: 'model-b' }],
    ['greet_wave', '你好呀。', profile], ['greet_hello', '嗯？我在呢。', profile],
  ]) await audio.audio(action, phrase, voice, generate);
  assert.equal(calls, 5); assert.equal(fs.readdirSync(dir).length, 5, 'all action/model/voice/phrase variants coexist');
  await audio.audio('greet_hello', '你好呀。', profile, generate); assert.equal(calls, 5, 'switching back reuses the original variant');
});
test('concurrent requests share synthesis; corrupt, failed and degraded results do not poison the cache', async t => {
  const { audio, dir } = fixture(t); let release, calls = 0;
  const generate = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const a = audio.audio('greet_hello', '你好呀。', profile, generate), b = audio.audio('greet_hello', '你好呀。', profile, generate);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(result()); await Promise.all([a, b]); assert.equal(calls, 1);
  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{broken');
  await audio.audio('greet_hello', '你好呀。', profile, async () => { calls++; return result(); }); assert.equal(calls, 2);
  await assert.rejects(audio.audio('shy', '轻一点。', profile, async () => { throw new Error('synthetic failure'); }), /synthetic failure/);
  await audio.audio('shy', '轻一点。', profile, async () => ({ ...result(), engine: 'system', degraded: true }));
  assert.equal(fs.readdirSync(dir).length, 1, 'system fallback is never stored under a Qwen key');
  await audio.audio('shy', '轻一点。', profile, async () => result()); assert.equal(fs.readdirSync(dir).length, 2);
});
test('cache storage failure preserves live audio; size limits evict old variants instead of expiring all audio', async t => {
  const { root, audio, dir } = fixture(t, { maxEntries: 2 });
  const blocked = path.join(root, 'blocked'); fs.writeFileSync(blocked, 'file');
  assert.deepEqual((await new InteractionAudio(blocked).audio('hello', '你好。', profile, async () => result())).buffer, wav());
  await audio.audio('one', '你好。', profile, async () => result());
  const oldest = path.join(dir, fs.readdirSync(dir)[0]); fs.utimesSync(oldest, new Date(0), new Date(0));
  await audio.audio('two', '你好。', profile, async () => result()); await audio.audio('three', '你好。', profile, async () => result());
  assert.equal(fs.readdirSync(dir).length, 2); assert(!fs.existsSync(oldest));
  const tiny = new InteractionAudio(path.join(root, 'tiny'), { maxBytes: 10 });
  await tiny.audio('one', '你好。', profile, async () => result()); assert.equal(fs.readdirSync(tiny.dir).length, 0);
});
test('voice identities ignore appearance, credentials and settings for inactive engines', async () => {
  const cfg = { engine: 'qwen', qwen: { voice: 'serena', dir: '/first' }, voice: 'irrelevant', model: 'legacy', apiKey: 'synthetic-secret', timeoutMs: 10 };
  const a = await tts.voiceIdentity(cfg);
  assert.deepEqual(await tts.voiceIdentity({ ...cfg, qwen: { ...cfg.qwen, dir: '/elsewhere', ready: true, streaming: true }, voice: 'other', model: 'unused', apiKey: 'rotated', timeoutMs: 999 }), a);
  assert.notDeepEqual(await tts.voiceIdentity({ ...cfg, qwen: { voice: 'vivian' } }), a);
  assert(!JSON.stringify(a).includes('synthetic-secret'));
});
test('remote identity uses the discovered speech model and voice, including refreshed model changes', async t => {
  let name = 'model-a';
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ spec: 'chp/2', plugin: { version: 'test' }, endpoints: { speech: '/speech' },
    speech: { rules: [{ signature: 'txt-2-sph', input: 'txt-2-sph/v1' }], input_schemas: { 'txt-2-sph/v1': { properties: { text: {}, voice: {} } } },
      abilities: [{ name, ready: true, files: { engine: name + '.gguf' }, voices: [{ id: 'voice-a' }, { id: 'voice-b' }], audio: { sample_rate: 24000, channels: 1, formats: ['wav'] } }] } })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const cfg = { engine: 'remote', baseURL: `http://127.0.0.1:${server.address().port}`, chp: { voice: 'voice-a' } };
  const first = await tts.voiceIdentity(cfg); assert.equal(first.model[0], 'model-a');
  assert.notDeepEqual(await tts.voiceIdentity({ ...cfg, chp: { voice: 'voice-b' } }), first);
  name = 'model-b'; await chp.discover(cfg); assert.notDeepEqual(await tts.voiceIdentity(cfg), first);
});
test('touch feedback selects a concrete enabled, loaded action while retaining throttling', () => {
  let now = 0;
  const touch = new Interactions({ clock: () => now, random: () => 0 });
  const motions = [{ key: 'greet_wave', slot: 'greet' }, { key: 'greet_hello', slot: 'greet' }];
  const first = touch.pick('head', { motions }); assert.equal(first.motion, 'greet_wave'); assert(first.sound);
  now += 100; assert.equal(touch.pick('head', { motions }), null);
  now += 7000; const second = touch.pick('head', { motions }); assert.equal(second.motion, 'greet_wave', 'weighted selection uses the same cumulative distribution on every tap');
  const single = [{ key: 'greet_hello', slot: 'greet' }];
  now += 9000; const head = touch.pick('head', { motions: single });
  now += 9000; const upper = touch.pick('upper', { motions: single });
  assert.equal(head.text, upper.text, 'one concrete action keeps a stable phrase so the same voice tuple always reuses audio');
});
test('accepted taps keep speaking at normal repeated intervals instead of extending a silent cooldown', () => {
  let now = 10000;
  const touch = new Interactions({ clock: () => now, random: () => 0 });
  for (const gap of [0, 1500, 1500, 2000, 3000, 5000, 1000]) {
    now += gap;
    const reaction = touch.pick('head');
    assert(reaction, 'a normal tap is accepted');
    assert.equal(reaction.sound, true, `accepted tap at ${now} must be read aloud`);
    now += 100;
    assert.equal(touch.pick('head'), null, 'rapid duplicate taps are rejected together with their bubble');
  }
  now += 1500;
  assert.equal(touch.pick('head', { quiet: true }).sound, false, 'an explicit quiet request still suppresses sound');
  now += 1500;
  assert.equal(touch.pick('head').sound, true, 'ending quiet mode does not inherit a hidden voice cooldown');
});
test('real system TTS populates a persistent interaction cache without playing audio', { skip: process.platform !== 'darwin' }, async t => {
  const { audio, dir } = fixture(t); let calls = 0;
  const cfg = { enabled: true, engine: 'system', voice: 'Tingting', rate: 200 }, identity = await tts.voiceIdentity(cfg);
  const generate = async () => { calls++; return tts.synthesize('你好呀，我在呢。', cfg); };
  const first = await audio.audio('greet_hello', '你好呀，我在呢。', identity, generate);
  assert(first.buffer.length > 44); assert.equal(fs.readdirSync(dir).length, 1, 'real system WAV passed the disk cache validator');
  const reused = await new InteractionAudio(dir).audio('greet_hello', '你好呀，我在呢。', identity, generate);
  assert.equal(reused.cached, true); assert.equal(calls, 1); assert.deepEqual(reused.buffer, first.buffer);
});
