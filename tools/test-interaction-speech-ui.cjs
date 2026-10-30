'use strict';
// Actual interaction IPC, speech queue, TTS/cache, preload and WebAudio player.
// A loopback CHP serves a test WAV; the isolated window's output is muted.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), http = require('node:http'), assert = require('node:assert/strict');
const config = require('../src/main/config'), avatars = require('../src/main/avatars'), tts = require('../src/main/tts');
const { createTTSSession } = require('../src/main/tts-session');
const { Interactions, InteractionAudio } = require('../src/main/interaction');
const { presentConversation } = require('../src/main/conversation-text');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-interaction-speech-'));
app.setPath('userData', path.join(root, 'electron')); config.setPath(path.join(root, 'config.json'));
let win, server, context, now = 100000, syntheses = 0, cacheHits = 0, started = 0, finished = 0;
const events = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(script) {
  let timer; try { return await Promise.race([win.webContents.executeJavaScript(script, true), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer request timed out: ' + script.slice(0, 120))), 6000); })]); } finally { clearTimeout(timer); }
}
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; if (errors.length) throw new Error(errors.join('; ')); await delay(25); }
  throw new Error(`Timeout: ${label}; bubbles=${events.filter(e => e.type === 'say').length}, started=${started}, finished=${finished}`);
}
function wav() {
  const bytes = 19200, b = Buffer.alloc(44 + bytes);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes / 2; i++) b.writeInt16LE(Math.round(800 * Math.sin(2 * Math.PI * 220 * i / 24000)), 44 + i * 2);
  return b;
}
async function checkStatusWidth() {
  for (const width of [340, 420, 630]) {
    win.setContentSize(width, 660); await delay(80);
    const measure = () => evaluate(`(() => {
      const a=document.getElementById('activity'),r=a.getBoundingClientRect(),s=document.getElementById('statusRow').getBoundingClientRect();
      const text=document.getElementById('activityText'),done=document.getElementById('actDone').getBoundingClientRect();
      const logo=document.querySelector('#activity .workbuddy-logo'),logoStyle=getComputedStyle(logo);
      return {width:r.width,left:r.left,right:r.right,rowWidth:s.width,text:text.textContent,clipped:text.scrollWidth>text.clientWidth,doneRight:done.right,logoLoaded:logo.complete&&logo.naturalWidth>0,logoFilter:logoStyle.filter};
    })()`);
    win.webContents.send('pet:ev', { type: 'monitor', tasks: [] });
    await until(async () => (await measure()).text === '空闲中', 'idle status');
    await until(async () => { const m = await measure(); return m.logoLoaded && m.logoFilter === 'grayscale(1)'; }, 'idle logo settles to gray');
    const idle = await measure(); assert(idle.width < idle.rowWidth / 2, 'short status shrinks to content');
    assert(idle.logoLoaded && idle.logoFilter === 'grayscale(1)', 'idle uses the actual WorkBuddy logo in gray');
    if (width === 420 && process.env.WORKBUNNY_STATUS_SHOTS) {
      fs.mkdirSync(process.env.WORKBUNNY_STATUS_SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.WORKBUNNY_STATUS_SHOTS, 'idle.png'), (await win.webContents.capturePage()).toPNG());
    }
    win.webContents.send('pet:ev', { type: 'monitor', tasks: [{ sessionId: 'short', taskId: 1, name: '整理', status: 'running' }] });
    await until(async () => (await measure()).text.includes('整理'), 'short task status');
    await until(async () => (await measure()).logoFilter === 'none', 'busy logo settles to original color');
    const short = await measure(); assert(short.width > idle.width && short.width < short.rowWidth, 'task content determines width');
    assert.equal(short.logoFilter, 'none', 'busy uses the original colored logo');
    if (width === 420 && process.env.WORKBUNNY_STATUS_SHOTS) fs.writeFileSync(path.join(process.env.WORKBUNNY_STATUS_SHOTS, 'busy.png'), (await win.webContents.capturePage()).toPNG());
    win.webContents.send('pet:ev', { type: 'monitor', tasks: [{ sessionId: 'long', taskId: 2, name: '检查并整理这份很长的合成资料'.repeat(12), status: 'running' }] });
    await until(async () => (await measure()).text.includes('合成资料'), 'long task status');
    const long = await measure();
    assert(long.width <= long.rowWidth + 1 && long.width > short.width, 'long status is capped at the existing UI column');
    assert(long.clipped && long.doneRight <= long.right, 'long text truncates while the done button stays visible');
    win.webContents.send('pet:ev', { type: 'monitor', tasks: [] });
    await until(async () => (await measure()).text === '空闲中', 'status shrinks again');
    assert(Math.abs((await measure()).width - idle.width) < 1, 'clearing a long task restores content width');
  }
}
async function main() {
  await app.whenReady();
  server = http.createServer((req, res) => {
    if (req.method === 'POST') { syntheses++; res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav()); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ spec: 'chp/2', plugin: { version: 'fixture' }, endpoints: { speech: '/speech' },
      speech: { rules: [{ signature: 'txt-2-sph', input: 'txt-2-sph/v1' }], input_schemas: { 'txt-2-sph/v1': { properties: { text: {}, voice: {} } } },
        abilities: [{ name: 'fixture-tts', ready: true, files: { engine: 'fixture.gguf' }, voices: [{ id: 'test-voice' }], audio: { sample_rate: 24000, channels: 1, formats: ['wav'] } }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.save({ avatar: 'AvatarSample_D.vrm', tts: { enabled: true, engine: 'remote', baseURL: `http://127.0.0.1:${server.address().port}`, chp: { voice: 'test-voice' } }, voice: { enabled: true, alwaysListen: false }, memory: { enabled: false } });
  const idle = config.MOTIONS.find(m => m.key === 'idle_loop'), greet = config.MOTIONS.find(m => m.slot === 'greet');
  const motions = [idle, greet];
  ipcMain.handle('pet:init', () => ({ config: config.publicConfig(), avatars: avatars.scan(), avatar: 'AvatarSample_D.vrm', motions, motionGroups: config.MOTION_GROUPS, versions: {} }));
  ipcMain.handle('pet:config', (_event, patch) => config.publicConfig(config.save(patch)));
  ipcMain.handle('pet:scale', (_event, { scale }) => ({ scale }));
  ipcMain.handle('pet:asr-status', () => ({ speech: 0, mic: false }));
  win = new BrowserWindow({ show: false, width: 420, height: 660, webPreferences: { preload: path.resolve('src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  win.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text); });
  const audio = new InteractionAudio(path.join(root, 'audio'));
  context = vm.createContext({ config, tts, createTTSSession, presentConversation, win, setTimeout, clearTimeout, setImmediate, console,
    Date: class extends Date { static now() { return now; } }, Map, Set,
    activeAudioId: null, playbackTest: null,
    voiceFor: (_emotion, base) => base, MODELS_DIR: '', sendConfig() {}, log() {}, asr: null, muteAsr() {}, unmuteAsr() {},
    memory: { scheduleExtraction() {} }, presentedReplies: new Map(), busy: false, desktop: null, quietUntil: 0,
    interactions: new Interactions({ clock: () => now, random: () => 0 }), publishWebSources() {}, ipcMain,
    interactionAudio: { async audio(...args) { const result = await audio.audio(...args); if (result.cached) cacheHits++; return result; } },
    send(type, data) { events.push({ type, ...data }); win.webContents.send('pet:ev', { type, ...data }); },
  });
  const mainSource = fs.readFileSync(path.resolve('src/main/index.js'), 'utf8');
  const state = mainSource.slice(mainSource.indexOf('const speechQueue = []'), mainSource.indexOf('/** 这句识别结果是不是'));
  const pipeline = mainSource.slice(mainSource.indexOf('const synthCache = new Map()'), mainSource.indexOf('\nfunction speak('));
  const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('pet:interact'"), mainSource.indexOf("ipcMain.handle('pet:init'"));
  vm.runInContext(state + pipeline + handler, context);
  ipcMain.on('pet:audio-started', () => { started++; });
  ipcMain.on('pet:audio-done', (_event, value) => { if (!value.success) errors.push('WAV playback failed'); finished++; context.finishSpeech(value.success); });
  await win.loadFile(path.resolve('src/renderer/index.html'));
  await until(() => evaluate('window.__pet?.().vrm && window.__pet().clips > 0'), 'renderer loaded');
  for (let n = 1; n <= 4; n++) {
    now = 100000 + (n - 1) * 1500;
    const reaction = await evaluate(`window.pet.interact({region:'head',motions:${JSON.stringify(motions.map(m => m.key))}})`);
    assert(reaction, 'click is accepted after the prior playback completes');
    await until(() => started === n, `click ${n} starts WebAudio`);
    await until(() => finished === n && !vm.runInContext('speaking', context), `click ${n} finishes playback`);
    assert.equal(events.filter(event => event.type === 'say').length, n);
    assert.equal(events.filter(event => event.type === 'audio' && event.buffer).length, n);
  }
  assert.equal(syntheses, 1, 'later accepted clicks play the saved audio without another TTS request');
  assert.equal(cacheHits, 3); assert.equal(config.load().tts.engine, 'remote', 'there was no fallback masking a failure');
  await checkStatusWidth();
  assert.equal(errors.length, 0, errors.join('; '));
  console.log('Actual speech pipeline passed: 4 accepted clicks within 4.5s -> 4 bubbles, 4 WebAudio starts/completions, 1 synthesis + 3 disk-cache hits. Status width adapts at 340/420/630px; logo is gray when idle and colored when busy.');
}
main().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  if (context) { try { vm.runInContext('if(speakWatchdog)clearTimeout(speakWatchdog)', context); } catch {} }
  tts.cancel(); tts.shutdown(); if (win && !win.isDestroyed()) win.destroy(); server?.closeAllConnections(); server?.close();
  fs.rmSync(root, { recursive: true, force: true }); app.exit(code);
}
