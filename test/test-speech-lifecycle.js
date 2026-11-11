'use strict';
const actualReplyPolicy=()=>require('../src/main/reply-policy');
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
function fixture({ streaming = false, prefetch = false } = {}) {
  let next = 0, cancellations = 0;
  const timers = new Map(), allTimers = new Map(), calls = [], events = [], handlers = new Map();
  const synthesize = (text, cfg, options) => new Promise((resolve, reject) => calls.push({ text, options, resolve, reject }));
  const context = {
    AbortController, Buffer, Date, Promise,
    speechAbort: null, speechGen: 0, speechQueue: [], speaking: false, speakWatchdog: null,
    activeSpeechReplyId: null, activeInteractionAvatar: null, activeAudioId: null, playbackTest: null,
    speechEcho: new (require('../src/main/speech-echo').SpeechEcho)(), lastSpokeAt: 0, lastInterruption: null, activeThought: null, memory: null,
    presentedReplies: new Set(), synthCache: new Map(), SYNTH_CACHE_MAX:8, speakerFilter: {}, suppressEnrollmentFinal:false, asr: null,
    win: { webContents: {} },
    config: { load: () => ({ tts: { enabled: true, engine: streaming ? 'qwen' : 'system', qwen: { streaming } }, voice: { enabled: true } }) },
    tts: { synthesize, durationMs: require('../src/main/tts').durationMs, cancel: () => { cancellations++; } },
    synthBuffer: (text, emo, options) => synthesize(text, null, options),
    ttsSession:{synthesize},voiceFor:(_emo,instructions)=>instructions,
    llm:{makeSentenceSplitter:require('../src/main/llm').makeSentenceSplitter},require:()=>({redact:text=>text}),
    inputAdmission:{containsSecret:()=>false},publishWebSources(){},embodiment:{perform(){}},
    dialogueScope:()=> 'fixture',dialogueScheduler:()=>({interrupt(){}}),
    presentConversation: text => text, prefetchNext() {}, noteSpoken() {}, muteAsr() {}, unmuteAsr() {}, log() {},
    voiceMetadata() {}, send: (type, value) => events.push({ type, value }), console: { error() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); allTimers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), setImmediate: fn => fn(),
  };
  Object.assign(context,{voiceThoughts:new Map(),lastAcceptedOwnerAt:0,contextEpoch:0,replyPolicy:actualReplyPolicy(),speechEcho:context.speechEcho||{rows:[]}});
 vm.createContext(context);
  vm.runInContext([
    section('function waitForSpeech(', 'const speechEcho'),
    section('function stopSpeaking(', '/* ── 闭麦'),
    prefetch ? section('function synthBuffer(', 'let streamSequence = 0;') : '',
    section('let streamSequence = 0;', 'function prefetchNext('),
    prefetch ? section('function prefetchNext()', 'async function pumpSpeech()') : '',
    section('async function pumpSpeech()', 'function speak(text,'),
    section('function speak(text,', '/* ── 大脑'),
    section("ipcMain.handle('pet:tts-test'", "ipcMain.handle('pet:resize'"),
    section("ipcMain.on('pet:audio-done'", "ipcMain.on('pet:audio-started'"),
  ].join('\n'), context);
  const fire = id => { const callback = allTimers.get(id); timers.delete(id); callback(); };
  const nextSentence = () => { const entry = [...timers].find(([, timer]) => timer.ms === 60); assert(entry); fire(entry[0]); };
  const audio = () => events.filter(e => e.type === 'audio' && e.value.buffer);
  return { context, calls, events, handlers, fire, nextSentence, audio, cancellations: () => cancellations };
}
const result = () => ({ buffer: Buffer.alloc(48044), engine: 'system' });

test('a complete opening sentence plays before the longer prefetched continuation has synthesized', async () => {
  const f=fixture({prefetch:true}),c=f.context,opening='在呢！',rest='我已经听到你的问题。接下来一起看具体细节。';
  c.speak(opening+rest,{emo:'happy',messageId:'synthetic-reply'});
  assert.deepEqual(f.calls.map(call=>call.text),[opening,rest]);
  assert.equal(c.speechQueue[0].messageId,'synthetic-reply');assert.equal(c.speechQueue[0].emo,'happy');
  f.calls[0].resolve(result());await flush();assert.deepEqual(f.audio().map(event=>event.value.text),[opening]);
  f.calls[1].resolve(result());await flush();f.handlers.get('pet:audio-done')({sender:c.win.webContents},{id:c.activeAudioId,success:true});f.nextSentence();await flush();
  assert.equal(f.calls.length,2,'the continuation reuses the existing prefetch cache');assert.deepEqual(f.audio().map(event=>event.value.text),[opening,rest]);
  c.stopSpeaking('user');
});

test('later speech blocks retain the existing longer grouping without losing words or changing privacy',()=>{
  const f=fixture(),c=f.context,opening='好的。',sentences=['甲'.repeat(70)+'。','乙'.repeat(70)+'。','丙'.repeat(70)+'。'];
  c.speaking=true;c.speak(opening+sentences.join(''),{privateSpeech:true,messageId:'synthetic-private'});
  assert.deepEqual(Array.from(c.speechQueue,item=>item.text),[opening,sentences[0]+sentences[1],sentences[2]]);
  assert(c.speechQueue.every(item=>item.privateSpeech&&item.messageId==='synthetic-private'));assert.equal(f.calls.length,0);
});

test('interruption cancels the opening block and discards late prefetched continuation without playback',async()=>{
  const f=fixture({prefetch:true}),c=f.context;c.speak('先回答这一句。后续内容也在准备。');assert.equal(f.calls.length,2);
  c.stopSpeaking('voice');f.calls[0].resolve(result());f.calls[1].resolve(result());await flush();
  assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(c.speechQueue.length,0);assert.deepEqual(f.audio(),[]);assert.equal(c.speaking,false);
});

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
test('appending a keep response preserves the active synthesis and all original story blocks with their message ids',async()=>{
 const f=fixture(),c=f.context;c.speak('故事开头。故事余下的完整正文。',{messageId:'original-story'});const signal=f.calls[0].options.signal;
 c.speak('礼貌回应。',{messageId:'courtesy'});assert.equal(signal.aborted,false);assert.deepEqual(Array.from(c.speechQueue,item=>[item.text,item.messageId]),[['故事余下的完整正文。','original-story'],['礼貌回应。','courtesy']]);
 f.calls[0].resolve(result());await flush();f.handlers.get('pet:audio-done')({sender:c.win.webContents},{id:c.activeAudioId,success:true});f.nextSentence();f.calls[1].resolve(result());await flush();
 assert.deepEqual(f.audio().map(event=>event.value.text),['故事开头。','故事余下的完整正文。']);assert.equal(c.activeSpeechReplyId,'original-story');assert.equal(c.speechQueue[0].messageId,'courtesy');
 c.stopSpeaking('user');assert.equal(c.speechQueue.length,0);
});
test('explicit stop cancels both isolated keep/older inferences as well as pending audio without reviving late work',()=>{
 const f=fixture(),c=f.context,a=new AbortController(),b=new AbortController();c.voiceThoughts.set('older',a);c.voiceThoughts.set('keep',b);c.speak('pending story',{messageId:'old'});c.stopSpeaking('user');assert(a.signal.aborted);assert(b.signal.aborted);assert.equal(c.speechQueue.length,0);assert.equal(c.speaking,false);
});
