'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTTSSession } = require('../src/main/tts-session');

function fixture(synthesize) {
  let config = { tts: { engine: 'qwen', voice: 'old', qwen: { voice: 'default' } }, brain: { source: 'workbuddy' } };
  const events = [];
  const getConfig = () => config;
  const saveConfig = (patch) => (config = { ...config, tts: { ...config.tts, ...patch.tts } });
  const session = createTTSSession({ getConfig, saveConfig, synthesize, onFallback: (c) => events.push(c) });
  return { session, getConfig, saveConfig, events };
}
const fallback = { engine: 'system', voice: 'Tingting', degraded: true, reason: '本地引擎不可用' };

test('actual fallback persists system default and broadcasts it; next request uses system', async () => {
  const requested = [];
  const f = fixture(async (_text, cfg) => {
    requested.push(cfg.engine);
    return cfg.engine === 'qwen' ? fallback : { engine: 'system', degraded: false };
  });
  await f.session.synthesize('hello');
  assert.equal(f.getConfig().tts.engine, 'system'); assert.equal(f.getConfig().tts.voice, 'Tingting');
  assert.equal(f.getConfig().tts.lastFallback.from, 'qwen'); assert.equal(f.events.length, 1);
  assert.equal(f.getConfig().brain.source, 'workbuddy');
  await f.session.synthesize('again'); assert.deepEqual(requested, ['qwen', 'system']);
});

test('an old failure cannot overwrite a newly selected engine', async () => {
  let complete;
  const f = fixture(() => new Promise((r) => { complete = r; }));
  const pending = f.session.synthesize('hello');
  f.saveConfig({ tts: { engine: 'remote' } }); f.session.changed();
  complete(fallback); await pending;
  assert.equal(f.getConfig().tts.engine, 'remote'); assert.equal(f.events.length, 0);
});

test('an old failure cannot overwrite a newer voice on the same engine', async () => {
  let complete;
  const f = fixture(() => new Promise((r) => { complete = r; }));
  const pending = f.session.synthesize('hello');
  f.saveConfig({ tts: { qwen: { voice: 'clone' } } }); f.session.changed();
  complete(fallback); await pending;
  assert.equal(f.getConfig().tts.engine, 'qwen'); assert.equal(f.getConfig().tts.qwen.voice, 'clone');
  assert.equal(f.events.length, 0);
});

test('successful local synthesis retains selection; unrelated model check does not reset remote', async () => {
  const f = fixture(async () => ({ engine: 'qwen', degraded: false }));
  await f.session.synthesize('hello'); assert.equal(f.getConfig().tts.engine, 'qwen');
  f.saveConfig({ tts: { engine: 'remote' } }); f.session.changed();
  f.session.useSystem('local check failed', 'qwen', 'Tingting');
  assert.equal(f.getConfig().tts.engine, 'remote'); assert.equal(f.events.length, 0);
});
