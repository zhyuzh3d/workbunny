'use strict';
// Actual interaction IPC, speech queue, TTS/cache, preload and WebAudio player.
// A loopback CHP serves a test WAV; the isolated window's output is muted.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), http = require('node:http'), assert = require('node:assert/strict');
const config = require('../src/main/config'), avatars = require('../src/main/avatars'), tts = require('../src/main/tts');
const { createTTSSession } = require('../src/main/tts-session');
const { Embodiment } = require('../src/main/embodiment');
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
async function checkListeningClicks(listenRequests, inputStates) {
  const mode=()=>evaluate('window.__dock().mode');
  const click=async(selector,fraction=.5)=>{
    const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width*${fraction}),y:Math.round(r.top+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
  };
  assert.equal(await evaluate("document.querySelector('#ear .bars').closest('button').id"),'listenToggle');
  const initial=listenRequests.length;
  // Dot, gap, bars and button padding must all hit the same toggle.
  for(const [selector,fraction] of [['#listenToggle',.2],['#listenToggle',.5],['#listenToggle .bars',.5],['#listenToggle .bars i:first-child',.5],['#listenToggle .bars i:last-child',.5],['#listenToggle',.95]]){
    const before=listenRequests.length;
    await click(selector,fraction);
    await until(()=>listenRequests.length===before+1,'combined listening control toggles once');
    const on=(listenRequests.length-initial)%2===1;
    await until(async()=>await evaluate("document.getElementById('listenToggle').getAttribute('aria-pressed')")===String(on),'listening toggle acknowledgement');
    assert.equal(listenRequests.at(-1),'toggle');
    assert.equal(await mode(),'mini','dot and bars never open the text input');
  }
  const afterToggles=listenRequests.length;
  for(const [selector,fraction] of [['#earTxt',.5],['#earTxt',.5],['#ear',.99],['#ear',.99]]){
    const open=await mode()!=='open';
    await click(selector,fraction);
    await until(async()=>(await mode())===(open?'open':'mini')&&inputStates.at(-1)===open,'remaining listening bar toggles the input window');
    assert.equal(listenRequests.length,afterToggles,'input area never toggles listening');
    assert.equal(await evaluate("document.getElementById('dock').classList.contains('hidden')"),!open);
  }
}
function wav() {
  const bytes = 19200, b = Buffer.alloc(44 + bytes);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes / 2; i++) b.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 220 * i / 24000)), 44 + i * 2);
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
    const idle = await measure(); assert(idle.width < idle.rowWidth - 16, 'short status shrinks to content: ' + JSON.stringify({ viewportWidth: width, ...idle }));
    assert(idle.logoLoaded && idle.logoFilter === 'grayscale(1)', 'idle uses the actual WorkBuddy logo in gray');
    win.webContents.send('pet:ev', { type: 'monitor', tasks: [{ sessionId: 'short', taskId: 1, name: '整理', status: 'running' }] });
    await until(async () => (await measure()).text.includes('整理'), 'short task status');
    await until(async () => (await measure()).logoFilter === 'none', 'busy logo settles to original color');
    const short = await measure(); assert(short.width > idle.width && short.width < short.rowWidth && !short.clipped, 'short task fits at its natural width');
    assert.equal(short.logoFilter, 'none', 'busy uses the original colored logo');
    win.webContents.send('pet:ev', { type: 'monitor', tasks: [{ sessionId: 'long', taskId: 2, name: '检查并整理这份很长的合成资料'.repeat(12), status: 'running' }] });
    await until(async () => (await measure()).text.includes('合成资料'), 'long task status');
    const long = await measure();
    assert(long.width <= long.rowWidth + 1 && long.width > short.width, 'long status is capped at the existing UI column: ' + JSON.stringify({ width, short, long }));
    assert(long.clipped && long.doneRight <= long.right, 'long text truncates while the done button stays visible');
    win.webContents.send('pet:ev', { type: 'monitor', tasks: [] });
    await until(async () => (await measure()).text === '空闲中', 'status shrinks again');
    assert(Math.abs((await measure()).width - idle.width) < 1, 'clearing a long task restores content width');
  }
}
async function checkListeningResponse(mainSource) {
  const mainRequire = require('node:module').createRequire(path.resolve('src/main/index.js'));
  const section = (from, to) => mainSource.slice(mainSource.indexOf(from), mainSource.indexOf(to, mainSource.indexOf(from)));
  Object.assign(context, { storageBusy: false, storageError: null, screenLocked: false, agent: null, monitor: null,
    dialogueReady: () => true, dialogueActions: mainRequire('./dialogue-actions'), replyPolicy: mainRequire('./reply-policy'),
    currentScene: () => 'life', history: [], JUDGE_RULE: '', SELF_RULE: '', lastAcceptedOwnerAt: 0, lastDialogueAt: 0,
    secretary: { contextSnapshot: () => ({ text: '', sourceIds: [] }) }, taskSupervision: { context: () => '' },
    avatarCatalog: { prompt: () => [], catalog: () => [] }, activeAvatarPack: () => null, inputAdmission: { containsSecret: () => false },
    dialogueHistory: mainRequire('./reply-format').dialogueHistory, conversationText: mainRequire('./conversation-text').conversationText,
    scopePolicy: mainRequire('./memory-scope'), publishRecall() {}, traceSpeech() {}, asrFailStreak: 0,
    voiceInputOwner: null, speechTraceEnabled: false, suppressEnrollmentFinal: false, asrMode: 'continuous', nameHit: () => false, QUIET_WORDS: /never-match-fixture/u,
    pushHistory: () => Promise.resolve({ id: 'fixture-owner', value: { turnId: 'fixture-owner' } }),
    requestReply: mainRequire('./reply-request').requestReply, randomUUID: () => 'fixture-response',
    llm: { ...mainRequire('./llm') },
  });
  context.memory.context = async () => ({ text: '', messages: [], sourceIds: [] });
  context.memory.cancelExtraction = () => {};
  vm.runInContext(section('function speak(', '/* ── 大脑') + section('async function committedVoice(', '/* ── 主动播报') +
    section('function handleVoiceInputFailure(', '// Private diagnostics') + section('async function handleUtterance(', '/** 主动要权限'), context);
  const turns = vm.runInContext('voiceTurns', context), requests = [];
  context.llm.chat = options => new Promise(resolve => requests.push({ options, resolve }));
  const pipeline = mainRequire('./asr-input-pipeline').createAsrInputPipeline({
    speakerFilter: { acceptsText: () => true }, state: () => ({ alwaysOn: true, speaking: vm.runInContext('speaking', context), asrMode: 'continuous' }),
    recentEcho: () => false, turns: () => turns, onAcceptedPartial: () => context.interruptDialogue('voice'),
  });
  const body = text => JSON.stringify({ protocol: 'dialogue-v2', stages: [
    { stage: 'review', grade: 'unassessed', note: '', grasp: 'steady', pace: 'listen' },
    { stage: 'reply', reply: { kind: 'chat', text, turnDisposition: 'replace' } }, { stage: 'prediction', expect: null },
  ] });
  const caption = () => evaluate("document.getElementById('earTxt').textContent");
  const bubble = () => evaluate("document.getElementById('bubbleText').textContent");
  win.webContents.send('pet:ev', { type: 'listen', on: true });
  const metadata = { recognizer: 1, sourceGen: 1, speechSupported: true, audioStartAtMs: now - 1000, audioEndAtMs: now };
  pipeline.partial('请接着听我说', metadata);
  await until(async () => (await caption()) === '请接着听我说', 'production partial caption');
  pipeline.utterance('请接着听我说', metadata);
  pipeline.activity({ recognizer: 1, sourceGen: 1, seq: 1, state: 'quiet', quietSeconds: 1, at: Date.now() });
  await until(() => requests.length === 1, 'production voice model request');
  await until(async () => (await caption()).includes('正在回应'), 'candidate keeps pending during actual think');
  assert.equal(await caption(), '请接着听我说 · 正在回应');
  const raw = body('第一句已经生成。下一句还没返回。'), cut = raw.indexOf('下一句');
  const beforeStarted = started, beforeFinished = finished;
  requests[0].options.onDelta(raw.slice(0, cut));
  await until(async () => (await bubble()) === '第一句已经生成。', 'model text streams into the real bubble');
  await until(() => started === beforeStarted + 1, 'first sentence plays while the model is pending');
  await until(async () => (await caption()).includes('正在说话'), 'caption follows actual audio start');
  assert.equal(await caption(), '正在说话', 'playback hides the previous user transcript');
  await until(() => finished === beforeFinished + 1, 'first streamed sentence completes');
  await until(async () => (await caption()).includes('正在回应'), 'model still pending after its first sentence');
  pipeline.partial('最新的补充内容', { ...metadata, sourceGen: 2 });
  await until(async () => (await caption()) === '最新的补充内容', 'new production partial replaces the previous response');
  const oldBubble = await bubble(); requests[0].options.onDelta(raw.slice(cut)); requests[0].resolve({ raw });
  await delay(60); assert.equal(await caption(), '最新的补充内容'); assert.equal(await bubble(), oldBubble, 'late old model text is suppressed');
  pipeline.utterance('最新的补充内容', { ...metadata, sourceGen: 2 });
  pipeline.activity({ recognizer: 1, sourceGen: 2, seq: 2, state: 'quiet', quietSeconds: 1, at: Date.now() });
  await until(() => requests.length === 2, 'replacement voice model request');
  await until(async () => (await caption()).includes('正在回应'), 'replacement request is pending');
  const fresh = body('补充已经听见。'), freshCut = fresh.indexOf('补充已经听见。') + '补充已经听见。'.length;
  requests[1].options.onDelta(fresh.slice(0, freshCut));
  await until(() => started === beforeStarted + 2, 'replacement playback starts before its model finishes');
  requests[1].options.onDelta(fresh.slice(freshCut)); requests[1].resolve({ raw: fresh });
  await until(() => !context.busy, 'replacement model finishes during playback');
  assert((await caption()).includes('正在说话'), 'model completion cannot downgrade an already playing reply to audio preparation');
  await until(() => started === beforeStarted + 2 && finished === beforeFinished + 2, 'replacement sentence plays exactly once');
  await until(async () => !(await caption()).includes('正在回应') && !(await caption()).includes('正在说话'), 'completed response retires pending and playback state');
  assert(!(await caption()).includes('最新的补充内容'), 'completed response hides the user transcript');
  assert.equal(await bubble(), '补充已经听见。');
  assert.equal(started, beforeStarted + 2, 'streamed text is not spoken again at model completion');
  turns.reset(); win.webContents.send('pet:ev', { type: 'listen', on: false });
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
  config.save({ avatar: 'Bani.vrm', tts: { enabled: true, engine: 'remote', baseURL: `http://127.0.0.1:${server.address().port}`, chp: { voice: 'test-voice' } }, voice: { enabled: true, alwaysListen: false }, memory: { enabled: false } });
  const idle = config.MOTIONS.find(m => m.idle && !m.requiresProp && m.posture !== 'sitting'), greet = config.MOTIONS.find(m => m.slot === 'greet' && !m.requiresProp && m.posture !== 'sitting');
  const motions = [idle, greet];
  ipcMain.handle('pet:init', () => ({ config: config.publicConfig(), avatars: avatars.scan(), avatar: 'Bani.vrm', motions, motionGroups: config.MOTION_GROUPS, versions: {} }));
  ipcMain.handle('pet:config', (_event, patch) => config.publicConfig(config.save(patch)));
  ipcMain.handle('pet:scale', (_event, { scale }) => ({ scale }));
  ipcMain.handle('pet:asr-status', () => ({ speech: 3, mic: true, captureReady: true }));
  const listenRequests=[],inputStates=[];let listenerOn=false;
  ipcMain.on('pet:listen',(_event,value)=>{listenRequests.push(value);listenerOn=value==='toggle'?!listenerOn:value===true;win.webContents.send('pet:ev',{type:'listen',on:listenerOn});});
  ipcMain.on('pet:input-state',(_event,value)=>inputStates.push(value));
  win = new BrowserWindow({ show: false, width: 420, height: 660, webPreferences: { preload: path.resolve('src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  win.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text); });
  const audio = new InteractionAudio(path.join(root, 'audio'));
  context = vm.createContext({ config, tts, createTTSSession, presentConversation, win, setTimeout, clearTimeout, setImmediate, console,
    require: require('node:module').createRequire(path.resolve('src/main/index.js')), AbortController, contextEpoch: 0, voiceThoughts: new Map(),
    dialogueScheduler: () => ({ interrupt() {} }), dialogueScope: () => 'fixture', voiceMetadata() {},
    Date: class extends Date { static now() { return now; } }, Map, Set,
    activeAudioId: null, playbackTest: null,
    voiceFor: (_emotion, base) => base, MODELS_DIR: '', sendConfig() {}, log() {}, asr: null, muteAsr() {}, unmuteAsr() {},
    memory: { scheduleExtraction() {} }, composing:false,lastInterruption:null,activeThought:null,voiceTurns:{reset(){}},autonomy:null,taskNotifications:null,lastHeardAt:0, presentedReplies: new Map(), busy: false, desktop: null, quietUntil: 0,
    interactions: new Interactions({ clock: () => now, random: () => 0 }), speakerFilter: { enrollment: null }, publishWebSources() {}, ipcMain,
    interactionAudio: { async audio(...args) { const result = await audio.audio(...args); if (result.cached) cacheHits++; return result; } },
    send(type, data) { events.push({ type, ...data }); win.webContents.send('pet:ev', { type, ...data }); },
  });
  const embodiment = new Embodiment({ catalog: { select: key => motions.find(m => m.key === key), catalog: () => ({ motions: motions.map(m => ({ ...m, enabled: true })) }) },
    avatar: () => ({ key: config.load().avatar }), send: event => win.webContents.send('pet:ev', { type: 'motion', ...event }) });
  ipcMain.on('pet:motion-started', (_event, value) => embodiment.report(value));
  const mainSource = fs.readFileSync(path.resolve('src/main/index.js'), 'utf8');
  const state = mainSource.slice(mainSource.indexOf('const speechQueue = []'), mainSource.indexOf('function echoLike('));
  const pipeline = mainSource.slice(mainSource.indexOf('const synthCache = new Map()'), mainSource.indexOf('\nfunction speak('));
  const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('pet:interact'"), mainSource.indexOf("ipcMain.handle('pet:init'"));
  context.embodiment = embodiment;
  const stop = mainSource.slice(mainSource.indexOf('function stopSpeaking('), mainSource.indexOf('/* ── 闭麦/开麦'));
  const composing = mainSource.slice(mainSource.indexOf("ipcMain.on('pet:composing'"), mainSource.indexOf("ipcMain.handle('pet:say'"));
  vm.runInContext(state + pipeline + stop + handler + composing, context);
  ipcMain.on('pet:audio-started', () => { started++; });
  ipcMain.on('pet:audio-done', (_event, value) => { if (!value.success) errors.push('WAV playback failed'); finished++; context.finishSpeech(value.success); });
  await win.loadFile(path.resolve('src/renderer/index.html'));
  await until(() => evaluate('window.__pet?.().vrm && window.__pet().clips > 0'), 'renderer loaded');
  assert.equal(await evaluate("document.getElementById('hint').textContent"), '右击菜单打开更多功能');
  const meter=()=>evaluate(`(()=>{const el=document.getElementById('listenToggle'),style=getComputedStyle(el,'::before'),rect=el.getBoundingClientRect();return {color:style.backgroundColor,scale:new DOMMatrixReadOnly(style.transform).a,width:rect.width,height:rect.height,duration:style.transitionDuration,bars:[...document.querySelectorAll('#ear .bars i')].map(el=>({color:getComputedStyle(el).backgroundColor,height:el.getBoundingClientRect().height,duration:getComputedStyle(el).transitionDuration})),textColor:getComputedStyle(document.getElementById('earTxt')).color};})()`);
  const activeColor='rgb(39, 139, 76)', inactiveColor='rgb(144, 149, 154)';
  win.webContents.send('pet:ev',{type:'asrStatus',speech:3,mic:true,captureReady:true});
  win.webContents.send('pet:ev',{type:'listen',on:true});win.webContents.send('pet:ev',{type:'asrLevel',v:0});
  await until(async()=>{const m=await meter();return m.color===activeColor&&m.bars.length===4&&m.bars.every(b=>b.color===activeColor);}, 'open listener dot and bars are green');
  await until(async()=>(await meter()).textColor==='rgb(81, 88, 96)','original listening text color settles');
  const quietDot=await meter();assert.equal(quietDot.textColor,'rgb(81, 88, 96)','indicator changes preserve the original text color');
  assert(quietDot.bars.every(b=>b.height===3&&b.duration===quietDot.duration),'quiet bars share the dot response timing');
  const pulseAt=Date.now();win.webContents.send('pet:ev',{type:'asrLevel',v:.5});
  await until(async()=>{const m=await meter();return m.scale>1.8&&m.bars[1].height>14;}, 'input volume enlarges the dot and bars together');
  assert(Date.now()-pulseAt<300,'dot and bars respond within 300ms');
  const loudDot=await meter();assert.equal(loudDot.width,quietDot.width);assert.equal(loudDot.height,quietDot.height);
  assert(loudDot.bars.every(b=>b.color===activeColor),'loud input keeps bars green');
  win.webContents.send('pet:ev',{type:'asrLevel',v:0});
  await until(async()=>{const m=await meter();return m.scale<1.01&&m.bars.every(b=>b.height===3);}, 'quiet restores the dot and all bars');
  await evaluate("window.__heard('旁边的人聊天',false,'not-addressed')");
  assert.equal(await evaluate("document.getElementById('earTxt').textContent"),'在听');
  assert.equal((await meter()).color,activeColor,'skipping a response leaves the active dot green');
  win.webContents.send('pet:ev',{type:'asrStatus',captureReady:false,note:'starting'});
  await until(async()=>{const m=await meter();return m.color===activeColor&&m.bars.every(b=>b.color===activeColor);},'warning does not recolor active indicators');
  win.webContents.send('pet:ev',{type:'asrStatus',captureReady:true,note:'ok'});
  win.webContents.send('pet:ev',{type:'listen',on:false});
  win.webContents.send('pet:ev',{type:'asrLevel',v:1});
  await until(async()=>{const m=await meter();return m.color===inactiveColor&&m.scale===1&&m.bars.every(b=>b.color===inactiveColor&&b.height===3);}, 'closed listener stays gray and flat despite late levels');
  await checkListeningClicks(listenRequests,inputStates);
  for (let n = 1; n <= 4; n++) {
    now = 100000 + (n - 1) * 1500;
    const reaction = await evaluate(`window.pet.interact({region:'head',motions:${JSON.stringify(motions.map(m => m.key))}})`);
    assert(reaction, 'click is accepted after the prior playback completes');
    await until(() => started === n, `click ${n} starts WebAudio`);
    await until(async () => (await evaluate('window.__pet().mouth')) > 0.05, `click ${n} opens Bani's mouth`);
    await until(() => finished === n && !vm.runInContext('speaking', context), `click ${n} finishes playback`);
    await until(async () => (await evaluate('window.__pet().mouth')) === 0, `click ${n} closes Bani's mouth`);
    assert.equal(events.filter(event => event.type === 'say').length, n);
    assert.equal(events.filter(event => event.type === 'audio' && event.buffer).length, n);
  }
  assert.equal(syntheses, 1, 'later accepted clicks play the saved audio without another TTS request');
  assert.equal(cacheHits, 3); assert.equal(config.load().tts.engine, 'remote', 'there was no fallback masking a failure');
  now += 2000;
  await evaluate(`window.pet.interact({region:'head',motions:${JSON.stringify(motions.map(m => m.key))}})`);
  await until(() => started === 5, 'fifth playback starts before typing');
  await until(async () => (await evaluate('window.__pet().mouth')) > 0.05, 'mouth opens before interruption');
  const before = Date.now();
  await evaluate("(()=>{const el=document.getElementById('input');el.value='请等一下';el.dispatchEvent(new Event('input'));})()");
  await until(async () => !vm.runInContext('speaking', context) && !(await evaluate('window.__pet().audio')), 'typing stops real playback');
  await until(async () => (await evaluate('window.__pet().mouth')) === 0, 'interruption closes mouth');
  assert(Date.now() - before < 500, 'typing interrupts the main process and WebAudio promptly');
  assert(events.some(event => event.type === 'audio' && event.stop));
  const pcm = wav().subarray(44);
  win.webContents.send('pet:ev', { type: 'audio', stream: { start: true, id: 'pcm-test' } });
  win.webContents.send('pet:ev', { type: 'audio', stream: { pcm, id: 'pcm-test' } });
  win.webContents.send('pet:ev', { type: 'audio', stream: { end: true, id: 'pcm-test' } });
  await until(async () => (await evaluate('window.__pet().mouth')) > 0.05, 'PCM opens mouth');
  await until(async () => (await evaluate('window.__pet().mouth')) === 0, 'PCM completion closes mouth');
  win.webContents.send('pet:ev', { type: 'audio', stream: { start: true, id: 'pcm-stop' } });
  win.webContents.send('pet:ev', { type: 'audio', stream: { pcm, id: 'pcm-stop' } });
  await until(async () => (await evaluate('window.__pet().mouth')) > 0.05, 'PCM opens mouth before stop');
  win.webContents.send('pet:ev', { type: 'audio', stream: { stop: true, id: 'pcm-stop' } });
  await until(async () => (await evaluate('window.__pet().mouth')) === 0, 'PCM stop closes mouth');
  await checkListeningResponse(mainSource);
  await checkStatusWidth();
  assert.equal(errors.length, 0, errors.join('; '));
  console.log('Actual speech pipeline passed: 4 accepted clicks within 4.5s -> 4 bubbles, 4 WebAudio starts/completions, 1 synthesis + 3 disk-cache hits. Typing interrupts real playback within 500ms. Production ASR pipeline/voiceTurns/think/requestReply keeps pending visible, streams bubble/first-sentence audio before model completion, rejects late cancelled output and never repeats final speech. Status width adapts at 340/420/630px; logo is gray when idle and colored when busy.');
}
main().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  if (context) { try { vm.runInContext('if(speakWatchdog)clearTimeout(speakWatchdog)', context); } catch {} }
  tts.cancel(); tts.shutdown(); if (win && !win.isDestroyed()) win.destroy(); server?.closeAllConnections(); server?.close();
  fs.rmSync(root, { recursive: true, force: true }); app.exit(code);
}
