'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual main-process entrypoints with fake engines and timers;
// never load Electron or start speech/audio processes.
const source = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture({ streaming = false } = {}) {
  let next = 0, cancellations = 0;
  const timers = new Map(), allTimers = new Map(), calls = [], events = [], handlers = new Map();
  const synthesize = (text, cfg, options) => new Promise((resolve, reject) => calls.push({ text, options, resolve, reject }));
  const context = {
    AbortController, Buffer, Date, Promise,
    speechAbort: null, speechGen: 0, speechQueue: [], speaking: false, speakWatchdog: null,
    activeSpeechReplyId: null, activeInteractionAvatar: null, activeAudioId: null, playbackTest: null,
    lastSpokeAt: 0, lastInterruption: null, activeThought: null, memory: null,
    presentedReplies: new Set(), synthCache: new Map(), speakerFilter: {}, asr: null,
    win: { webContents: {} },
    config: { load: () => ({ tts: { enabled: true, engine: streaming ? 'qwen' : 'system', qwen: { streaming } }, voice: { enabled: true } }) },
    tts: { synthesize, cancel: () => { cancellations++; } },
    synthBuffer: (text, emo, options) => synthesize(text, null, options),
    presentConversation: text => text, prefetchNext() {}, noteSpoken() {}, muteAsr() {}, unmuteAsr() {}, log() {},
    send: (type, value) => events.push({ type, value }), console: { error() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); allTimers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), setImmediate: fn => fn(),
  };
  vm.createContext(context);
  vm.runInContext([
    section('function waitForSpeech(', 'let recentSpeech'),
    section('function stopSpeaking(', '/* ── 闭麦'),
    section('let streamSequence = 0;', 'function prefetchNext('),
    section('async function pumpSpeech()', 'function speak(text,'),
    section("ipcMain.handle('pet:tts-test'", "ipcMain.handle('pet:resize'"),
    section("ipcMain.on('pet:audio-done'", "ipcMain.on('pet:audio-started'"),
  ].join('\n'), context);
  const fire = id => { const callback = allTimers.get(id); timers.delete(id); callback(); };
  const nextSentence = () => { const entry = [...timers].find(([, timer]) => timer.ms === 60); assert(entry); fire(entry[0]); };
  const audio = () => events.filter(e => e.type === 'audio' && e.value.buffer);
  return { context, calls, events, handlers, fire, nextSentence, audio, cancellations: () => cancellations };
}
const result = () => ({ buffer: Buffer.alloc(48044), engine: 'system' });

for (const late of ['resolve', 'reject']) test(`speech timeout releases its waiter and ignores a late ${late}`, async () => {
  const f = fixture(), c = f.context;
  c.speechQueue.push({ text: 'old' }, { text: 'new' });
  let released = false;
  c.pumpSpeech().then(() => { released = true; });
  const oldTimer = c.speakWatchdog;
  f.fire(oldTimer); await flush();
  assert(released, 'an engine ignoring cancellation cannot retain the pump waiter');
  assert.equal(f.calls[0].options.signal.aborted, true);
  f.nextSentence(); f.calls[1].resolve(result()); await flush();
  const activeId = c.activeAudioId, watchdog = c.speakWatchdog, cancels = f.cancellations();
  if (late === 'resolve') f.calls[0].resolve(result()); else f.calls[0].reject(Error('late engine failure'));
  await flush(); f.fire(oldTimer);
  assert.equal(c.activeAudioId, activeId);
  assert.equal(c.speakWatchdog, watchdog);
  assert.equal(c.speaking, true);
  assert.equal(f.cancellations(), cancels, 'old cleanup cannot cancel the new engine');
  assert.deepEqual(f.audio().map(e => e.value.text), ['new']);
});

test('retired stream callbacks and audio-done cannot end the next sentence', async () => {
  const f = fixture({ streaming: true }), c = f.context;
  c.speechQueue.push({ text: 'old' }, { text: 'new' });
  c.pumpSpeech();
  f.calls[0].options.onChunk(Buffer.alloc(4));
  const oldId = c.activeAudioId;
  f.fire(c.speakWatchdog); await flush(); f.nextSentence();
  f.calls[1].resolve(result()); await flush();
  const count = f.events.length, currentId = c.activeAudioId;
  f.calls[0].options.onChunk(Buffer.alloc(4));
  assert.equal(f.events.length, count, 'retired chunk cannot restart the old stream');
  f.handlers.get('pet:audio-done')({ sender: c.win.webContents }, { id: oldId, success: true });
  assert.equal(c.activeAudioId, currentId); assert.equal(c.speaking, true);
  f.handlers.get('pet:audio-done')({ sender: c.win.webContents }, { id: currentId, success: true });
  assert.equal(c.speaking, false);
});

test('stopping synthesis immediately releases the old waiter while a replacement speaks', async () => {
  const f = fixture(), c = f.context;
  c.speechQueue.push({ text: 'old' }); let released = false;
  c.pumpSpeech().then(() => { released = true; });
  c.stopSpeaking('user'); await flush(); assert(released);
  c.speechQueue.push({ text: 'new' }); c.pumpSpeech();
  f.calls[1].resolve(result()); await flush();
  const id = c.activeAudioId;
  f.calls[0].reject(Error('late cancellation')); await flush();
  assert.equal(c.activeAudioId, id); assert.equal(c.speaking, true);
});

test('voice preview timeout returns even when synthesis ignores cancellation', async () => {
  const f = fixture(), c = f.context;
  const preview = f.handlers.get('pet:tts-test')();
  f.fire(c.speakWatchdog);
  const reply = await preview;
  assert.equal(reply.ok, false); assert.equal(f.calls[0].options.signal.aborted, true);
  c.speechQueue.push({ text: 'new' }); c.pumpSpeech();
  f.calls[1].resolve(result()); await flush();
  const id = c.activeAudioId;
  f.calls[0].resolve(result()); await flush();
  assert.equal(c.activeAudioId, id); assert.equal(c.speaking, true);
  assert.deepEqual(f.audio().map(e => e.value.text), ['new']);
});
