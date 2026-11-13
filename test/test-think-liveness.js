'use strict';
const actualReplyPolicy=()=>require('../src/main/reply-policy');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createBoundedWait } = require('../src/main/bounded-wait');
const mainPath = path.join(__dirname, '../src/main/index.js'), source = fs.readFileSync(mainPath, 'utf8'), mainRequire = createRequire(mainPath);
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const owner = id => ({ id, value: { turnId: id } });
function fixture() {
  let sequence = 0, contexts = 0;
  const timers = new Map(), events = [], dispatches = [], receipts = [], handlers = new Map();
  const setTimer = (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; };
  const clearTimer = id => timers.delete(id);
  const memory = { generation: 1, ready: true,
    getSettings: () => ({ enabled: true, scene: 'work' }), scene: () => 'work',
    db: { request: async () => ({ rows: [] }) }, decode: row => row,
    cognition: { loadRoleView: async () => ({ revision: 1 }) },
    context: async () => { contexts++; return { text: '', messages: [], sourceIds: [] }; },
    growth: { view: async () => ({ text: '', entries: [], sourceIds: [] }) },
    sensitiveValues: async () => [], query: async () => [],
    cancelExtraction() {}, scheduleExtraction() {},
    addMessageOnce: async (id, role, text, details) => { receipts.push({ id, text, details }); return { record: owner(id) }; },
  };
  const context = {
    AbortController, Promise, Date, memory, contextEpoch: 0, activeThought: null, busy: false, storageBusy: false, storageError: null,
    screenLocked: false, agent: null, desktop: { task: { id: 'task', status: 'running' } }, monitor: null,
    dialogueActions: mainRequire('./dialogue-actions'), dialogueReady: () => true,
    config: { load: () => ({ memory: { enabled: true }, brain: { source: 'apikey' } }), resolveLLM: () => ({ transport: 'apikey', apiKey: 'fixture' }), buildSystemPrompt: () => '' },
    currentScene: () => 'work', secretary: { contextSnapshot: () => ({ text: '', sourceIds: [] }), dispatch: async (intent, metadata) => {
      assert(metadata.isCurrent()); assert.equal(metadata.signal.aborted, false); dispatches.push({ intent, metadata }); return { text: '任务控制已接收。' };
    } }, taskNotifications: null, taskSupervision: { context: () => '', key: row => row.id },
    embodiment: { context: () => ({}) }, avatarCatalog: { prompt: () => [], catalog: () => [] }, activeAvatarPack: () => null,
    avatarList: () => [], buildAvatarSnapshot: list => mainRequire('./avatar-capability').buildAvatarSnapshot(list),
    inputAdmission: { containsSecret: () => false }, presentedReplies: new Set(), lastInterruption: null,
    JUDGE_RULE: '', SELF_RULE: '', history: [], dialogueHistory: rows => rows,
    llm: { extractTags: mainRequire('./llm').extractTags, chat: async () => ({ text: 'fresh reply' }) },
    requestReply: async () => ({ text: 'fresh reply', reply: { text: 'fresh reply' } }),
    send: (type, value) => events.push({ type, value }), publishWebSources() {}, publishRecall() {}, log() {}, speak() {},
    presentConversation: text => text, conversationText: text => text, scopePolicy: { rank: () => 0 }, lastDialogueAt: 0,
    randomUUID: () => 'fixture-request', pushHistory: () => Promise.resolve(owner('keyboard-input')),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, composing: false,
    stopSpeaking(_reason, { keepThought = false } = {}) { if(!keepThought)context.activeThought?.abort(); }, voiceTurns: { reset() {} }, lastHeardAt: 0, autonomy: null, speaking:false,turnT0:0,
    QUIET_WORDS: /never-match-fixture/u,voiceMetadata(){},asrFailStreak:0,
    require: name => name === './bounded-wait' ? { createBoundedWait: opts => createBoundedWait({ ...opts, setTimer, clearTimer }) } : mainRequire(name),
  };
  Object.assign(context,{voiceThoughts:new Map(),speechAbort:null,speechQueue:[],speechGen:0,activeAudioId:null,lastAcceptedOwnerAt:0,replyPolicy:actualReplyPolicy(),speechEcho:context.speechEcho||{rows:[]}});
 vm.createContext(context);
  vm.runInContext(section('async function committedVoice(', '/* ── 主动播报') + '\n' + section('async function submitTypedDialogue(', 'async function applySettings('), context);
  const fire = ms => { const entry = [...timers].find(([, timer]) => timer.ms === ms); assert(entry, `missing ${ms}ms timer`); timers.delete(entry[0]); entry[1].fn(); };
  return { context, memory, events, dispatches, receipts, handlers, fire, contexts: () => contexts };
}
function hotwordFixture() {
 const f=fixture(),c=f.context,words=mainRequire('./hearing-hotwords');let writes=0,calls=0,queued=0;
 const settings={...c.config.load(),buddy:{name:'芭尼'},asr:{wakeAliases:[],hotwords:['WorkBunny','Workbuddy']}};
 c.config.load=()=>settings;c.config.save=patch=>{writes++;settings.asr={...settings.asr,...patch.asr};return settings;};
 c.asr={updateContext:()=>{queued++;return {queued:true,nextSegment:true};}};c.sendConfig=()=>{};
 vm.runInContext(section('function hearingHotwordService(', 'function asrOpts('),c);
 // The production main process has one realm; bridge this isolated VM's
 // newly constructed request to the host module's plain-object validator.
 const service=c.hearingHotwordService(),save=service.update;
 service.update=(request,options)=>save(structuredClone(request),options);
 c.requestReply=mainRequire('./reply-request').requestReply;
 c.llm.chat=async()=>{calls++;return {raw:JSON.stringify({protocol:'dialogue-v2',stages:[
  {stage:'review',grade:'opposite',note:'使用本轮词表版本。',grasp:'adjust',pace:'listen'},
  {stage:'reply',reply:{kind:'action',intent:{action:'hearing_hotwords',expectedRevision:words.snapshot(settings).revision,ops:[{op:'add',word:'月桂项目'}],reply:'月桂项目，我记住这个叫法了。'}}},
  {stage:'prediction',expect:null,basis:[]},
 ]})};};
 return {...f,settings,writes:()=>writes,calls:()=>calls,queued:()=>queued};
}
test('actual foreground hotword management uses one model request and presents only the saved receipt',async()=>{
 const f=hotwordFixture();
 const result=await f.context.think({userText:'这个项目叫月桂项目，记到热词里',userMessage:owner('word-request'),allowSpeech:false});
 assert(result,JSON.stringify(f.events));assert.equal(result.text,'月桂项目，我记住这个叫法了。');
 assert.equal(f.calls(),1);assert.equal(f.writes(),1);assert.equal(f.queued(),1);
 assert(f.settings.asr.hotwords.includes('月桂项目'));assert.equal(f.settings.buddy.name,'芭尼');
});
test('an actual hotword action from voice cannot save before the existing acoustic commit gate',async()=>{
 const f=hotwordFixture(),voice={accepted:true,isCurrent:()=>true,canCommit:()=>false,waitForCommit:async()=>false,
  remember:()=>owner('unconfirmed-word-request'),rememberConversation:()=>owner('unconfirmed-word-request'),hold(){},recognize:()=>true};
 const result=await f.context.think({userText:'把月桂项目加到热词',voiceTurn:voice,judge:true,allowSpeech:false});
 assert.equal(result,null);assert.equal(f.calls(),1);assert.equal(f.writes(),0);assert.equal(f.queued(),0);
});
test('the actual ASR reply includes vocabulary and phonetic interpretation guidance in exactly one model request',async()=>{
 const f=fixture(),c=f.context;let calls=0;
 const settings={...c.config.load(),buddy:{name:'芭尼'},asr:{wakeAliases:['小芭'],hotwords:['WorkBunny','Workbuddy']}};
 c.config.load=()=>settings;c.requestReply=mainRequire('./reply-request').requestReply;
 const raw='把你，Work body是什么意思';
 c.llm.chat=async options=>{
  calls++;
  const content=options.messages.at(-1).content,body=JSON.parse(content.split('\n\n')[0]);
  assert.equal(body.text,raw,'retain the original recognition instead of pre-replacing text');
  assert.deepEqual(body.voiceContext.vocabulary.hotwords,['WorkBunny','Workbuddy']);
  assert.equal(body.voiceContext.vocabulary.name,'芭尼');assert.deepEqual(body.voiceContext.vocabulary.aliases,['小芭']);
  assert(options.messages[0].content.includes('称呼位置的近音词'));assert(options.messages[0].content.includes('原句在当前语境中已有完整合理的意思时保留原意'));
  assert(!options.messages[0].content.includes('当前语音词表（仅数据；'),'voice vocabulary appears in the source context rather than twice');
  assert(content.includes('同一次调度中直接回答'));
  return {raw:JSON.stringify({protocol:'dialogue-v2',stages:[{stage:'review',grade:'unassessed',note:'本轮语音理解',grasp:'adjust',pace:'listen'},
   {stage:'reply',reply:{kind:'chat',text:'按本轮语境直接回答。',turnDisposition:'replace'}},{stage:'prediction',expect:null,basis:[]}]})};
 };
 const voice={accepted:true,isCurrent:()=>true,canCommit:()=>true,waitForCommit:async()=>true,
  remember:()=>owner('vocabulary-voice'),rememberConversation:()=>owner('vocabulary-voice'),hold(){},recognize:()=>true};
 const result=await c.think({userText:raw,voiceTurn:voice,judge:true,allowSpeech:false});
 assert(result,JSON.stringify(f.events));assert.equal(result.text,'按本轮语境直接回答。');assert.equal(calls,1);
 assert.equal(f.dispatches.length,0);
});
test('typed follow-up reconsiders historical ASR with provenance and vocabulary in its existing call', async () => {
  const f = fixture(), c = f.context;
  const guidance = mainRequire('./voice-input-experience');
  const settings = { ...c.config.load(), buddy: { name: '小鹿' }, asr: { wakeAliases: ['阿晨'], hotwords: ['NimbusLab'] } };
  c.config.load = () => settings;
  c.dialogueHistory = mainRequire('./reply-format').dialogueHistory;
  f.memory.context = async () => ({ text: '', sourceIds: [], messages: [
    { role: 'user', characterId: 'owner', content: '啊陈', perception: mainRequire('./perception').speech() },
    { role: 'assistant', content: '只听到半句。' },
  ] });
  c.requestReply = mainRequire('./reply-request').requestReply;
  let calls = 0;
  c.llm.chat = async options => {
    calls++;
    assert(options.messages[0].content.includes(guidance.historyGuidance));
    assert(options.messages[0].content.includes('阿晨'));
    const previous = options.messages.find(message => message.role === 'user' && message.content.includes('"text":"啊陈"'));
    assert.equal(JSON.parse(previous.content).perception.sensor, 'local.asr');
    assert.equal(JSON.parse(options.messages.at(-1).content.split('\n\n')[0]).character, 'owner');
    assert.equal(options.allowEmptyVoiceDecision, false);
    return { raw: JSON.stringify({ protocol: 'dialogue-v2', stages: [
      { stage: 'review', grade: 'unassessed', note: '', grasp: 'adjust', pace: 'listen' },
      { stage: 'reply', reply: { kind: 'chat', text: '按历史来源重新理解。' } },
      { stage: 'prediction', expect: null, basis: [] },
    ] }) };
  };
  const result = await c.think({ userText: '我上一句是什么意思', userMessage: owner('typed-follow-up'), allowSpeech: false });
  assert.equal(result.text, '按历史来源重新理解。');
  assert.equal(calls, 1);
});

test('a new voice turn releases a stuck old preparation and late completion cannot present the old reply', async () => {
  const f = fixture(), c = f.context; let complete, calls = 0;
  f.memory.cognition.loadRoleView = () => ++calls === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ revision: 1 });
  const old = c.think({ userText: 'old', userMessage: owner('old'), allowSpeech: false });
  await flush(); assert.equal(c.busy, true);
  const voice = { accepted:true,canCommit:()=>true,isCurrent: () => true, waitForCommit: async () => true, remember: () => owner('voice'),rememberConversation:()=>owner('voice') };
  const fresh = c.think({ userText: 'new', voiceTurn: voice, allowSpeech: false });
  assert.equal(await old, null); const reply = await fresh; assert(reply, JSON.stringify(f.events)); assert.equal(reply.text, 'fresh reply'); assert.equal(c.busy, false);
  const count = f.events.length; complete({ revision: 0 }); await flush();
  assert.equal(f.events.length, count); assert.equal(f.contexts(), 1);
});
test('local dependency timeout reports unavailable memory, frees busy, and the actual new-message entrypoint still responds', async () => {
  const f = fixture(), c = f.context;
  f.memory.cognition.loadRoleView = () => new Promise(() => {});
  const old = c.think({ userText: 'old', userMessage: owner('old'), allowSpeech: false });
  f.fire(8000); assert.equal(await old, null); assert.equal(c.busy, false);
  assert(f.events.some(e => e.type === 'chat' && /记忆或本地资料暂时忙/u.test(e.value.text)));
  f.memory.cognition.loadRoleView = async () => ({ revision: 1 });
  assert.equal((await f.handlers.get('pet:say')({}, { text: 'new message' })).ok, true);
  await flush(); assert.equal(c.busy, false);
  assert(f.events.some(e => e.type === 'chat' && e.value.text === 'fresh reply'), JSON.stringify(f.events));
});
test('trusted local stop bypasses role preparation and pending persistence using the existing dispatcher once', async () => {
  const f = fixture(), c = f.context;
  f.memory.cognition.loadRoleView = () => { throw Error('stop must not load role'); };
  const result = await c.think({ userText: '停止当前代办', userMessage: new Promise(() => {}), allowSpeech: false });
  assert.equal(result.taskControl, true); assert.equal(c.busy, false); assert.equal(f.dispatches.length, 1);
  assert.equal(f.dispatches[0].intent.action, 'stop');
  assert.equal(f.dispatches[0].metadata.requestSourceId, undefined); assert.equal(f.dispatches[0].metadata.sources.length, 0);
  assert.equal(f.receipts.length, 0, 'no fabricated durable source or receipt');
});
test('resume cannot bypass a missing real owner input receipt', async () => {
  const f = fixture(), c = f.context; c.desktop.task.status = 'paused';
  const pending = c.think({ userText: '继续原任务', userMessage: new Promise(() => {}), allowSpeech: false });
  f.fire(8000); assert.equal(await pending, null); assert.equal(f.dispatches.length, 0); assert.equal(c.busy, false);
});
test('a speculative voice stop remains unexecuted until commit and is cancelled by a newer turn', async () => {
  const f = fixture(), c = f.context; let commit;
  const voice = { accepted:true,canCommit:()=>false,isCurrent: () => true, waitForCommit: () => new Promise(resolve => { commit = resolve; }), remember: () => owner('voice'),rememberConversation:()=>owner('voice') };
  const pending = c.think({ userText: '停止当前代办', voiceTurn: voice, allowSpeech: false });
  assert.equal(f.dispatches.length, 0); c.activeThought.abort(); assert.equal(await pending, null);
  commit(true); await flush(); assert.equal(f.dispatches.length, 0); assert.equal(c.busy, false);
});
test('the real shared task-review entry stays pending while the real foreground think accepts voice and replies',async()=>{
 const f=fixture(),c=f.context,gate=Promise.withResolvers(),entered=Promise.withResolvers();let reviewSignal;
 c.llm.chat=async options=>{assert.equal(options.priority,'background');reviewSignal=options.signal;entered.resolve();return gate.promise;};
 const task={id:'synthetic-task',goal:'continue the original goal',criteria:'actual fixture evidence',scene:'work',domain:'work',visibilityFloor:0,
  authority:{role:'owner',verified:true,sources:['synthetic-owner']},sources:['synthetic-owner'],subjects:[{application:'system'}],state:{},operations:{},actionRuns:{}};
 const review=c.selfSystem().reviewTask({task,reviewId:'synthetic-review'});await entered.promise;
 assert.equal(c.busy,false);assert.equal(c.activeThought,null);
 const voice={accepted:true,canCommit:()=>true,isCurrent:()=>true,waitForCommit:async()=>true,remember:()=>owner('voice-during-review'),rememberConversation:()=>owner('voice-during-review')};
 const reply=await c.think({userText:'A new accepted voice message',voiceTurn:voice,allowSpeech:false});
 assert.equal(reply.text,'fresh reply');assert.equal(c.busy,false);assert.equal(reviewSignal.aborted,false);
 gate.resolve({text:JSON.stringify({type:'continue',rationaleSummary:'Keep the original goal and verify the alternate explanation',sourceRefs:[],guidance:{verificationIdeas:['read the retained fixture evidence']}})});
 assert.equal((await review).type,'continue');assert.equal(c.busy,false);assert.equal(c.activeThought,null);assert.equal(f.dispatches.length,0);
});

test('actual text and voice entries cancel immediately, merge unanswered words once, and keep source receipts', async () => {
  const f=fixture(),c=f.context,requests=[];
  c.requestReply=options=>new Promise(resolve=>requests.push({request:options.request,resolve}));
  const first=c.think({userText:'first typed request',userMessage:owner('first'),allowSpeech:false});await flush();
  for(let i=0;i<5;i++)c.interruptDialogue('voice');
  assert.equal(await first,null);assert(requests[0].request.signal.aborted);
  const second=c.think({userText:'second typed detail',userMessage:owner('second'),allowSpeech:false});await flush();
  const voice={accepted:true,id:3,turnId:'voice:3',isCurrent:()=>true,canCommit:()=>true,waitForCommit:async()=>true,
    recognize:()=>true,remember:()=>owner('voice:3'),rememberConversation:()=>owner('voice:3'),complete(){}};
  const third=c.think({userText:'spoken final detail',voiceTurn:voice,judge:true,allowSpeech:false});await flush();
  assert.equal(await second,null);assert(requests[1].request.signal.aborted);
  const current=JSON.parse(requests[2].request.messages.at(-1).content);
  assert.equal(current.text,'first typed request\nsecond typed detail\nspoken final detail');
  assert.deepEqual(Array.from(current.inputParts,row=>row.source),['keyboard','keyboard','microphone']);
  assert.deepEqual(Array.from(current.inputParts,row=>row.trust),['current-owner-request','current-owner-request','unconfirmed-speaker-and-intent']);
  requests[2].resolve({text:'combined answer',reply:{text:'combined answer'}});assert.equal((await third).text,'combined answer');
  assert(f.receipts[0].details.sources.includes('first'));assert(f.receipts[0].details.sources.includes('second'));assert(f.receipts[0].details.sources.includes('voice:3'));
  const heard=f.events.filter(row=>row.type==='heard'&&row.value.replied).at(-1);assert.equal(heard.value.text,'spoken final detail');
  const count=f.events.filter(row=>row.type==='chat').length;
  requests[0].resolve({reply:{text:'late first'}});requests[1].resolve({reply:{text:'late second'}});await flush();
  assert.equal(f.events.filter(row=>row.type==='chat').length,count);assert.equal(c.busy,false);
});

test('ignoring a new voice candidate automatically resumes the interrupted owner input',async()=>{
  const f=fixture(),c=f.context,requests=[];
  c.requestReply=options=>new Promise(resolve=>requests.push({request:options.request,resolve}));
  const old=c.think({userText:'unfinished owner question',userMessage:owner('owner-question'),allowSpeech:false});await flush();
  const token={accepted:true,id:2,turnId:'candidate:2',isCurrent:()=>true,canCommit:()=>true,skip(){},complete(){}};
  const candidate=c.think({userText:'ambient fragment',voiceTurn:token,judge:true,allowSpeech:false});await flush();
  assert.equal(await old,null);requests[1].resolve({reply:{skipped:true}});assert.equal((await candidate).ignored,true);await flush();
  assert.equal(requests.length,3);assert.equal(JSON.parse(requests[2].request.messages.at(-1).content).text,'unfinished owner question');
  requests[2].resolve({reply:{text:'resumed owner answer'}});await flush();assert.equal(c.busy,false);
  assert(f.events.some(row=>row.type==='chat'&&row.value.text==='resumed owner answer'));
  requests[0].resolve({reply:{text:'obsolete answer'}});await flush();assert(!f.events.some(row=>row.type==='chat'&&row.value.text==='obsolete answer'));
});

test('already presented input is consumed before later speech interruption and is not merged again',async()=>{
  const f=fixture(),c=f.context,requests=[];
  c.requestReply=async options=>{requests.push(options.request);return {reply:{text:'presented answer'}};};
  assert(await c.think({userText:'answered question',userMessage:owner('answered'),allowSpeech:true}));
  c.interruptDialogue('voice');
  assert(await c.think({userText:'next question',userMessage:owner('next'),allowSpeech:false}));
  const current=JSON.parse(requests[1].messages.at(-1).content);assert.equal(current.text,'next question');assert.equal(current.inputParts,undefined);
});

test('an invalid intent suffix after streamed chat cannot persist or report a completed answer', async () => {
  const f = fixture(), c = f.context;
  c.requestReply = mainRequire('./reply-request').requestReply;
  const text = '已经流出的普通正文。';
  const raw = JSON.stringify({ protocol: 'dialogue-v2', stages: [
    { stage: 'review', grade: 'unassessed', note: '', grasp: 'steady', pace: 'listen' },
    { stage: 'reply', reply: { kind: 'chat', text, intent: { action: 'agent' } } }, { stage: 'prediction', expect: null },
  ] });
  let calls = 0;
  c.llm.chat = async options => { calls++; const cut = raw.indexOf(text) + text.length; options.onDelta(raw.slice(0, cut)); options.onDelta(raw.slice(cut)); return { raw }; };
  assert.equal(await c.think({ userText: 'normal question', userMessage: owner('stream-failure'), allowSpeech: false }), null);
  assert.equal(calls, 1); assert.equal(f.receipts.length, 0); assert.equal(c.busy, false);
  assert(f.events.some(event => event.type === 'delta' && event.value.text === text));
  assert(!f.events.some(event => event.type === 'chat' && event.value.final === true));
});

function performanceFixture() {
  const f = fixture(), c = f.context;
  const { AvatarCatalogRouter } = mainRequire('./avatar-catalog-router');
  const motions = [
    { key: 'synthetic-run', label: '原地跑', slot: 'motion', enabled: true, autonomous: false, posture: 'standing' },
    { key: 'synthetic-wave', label: '挥手', slot: 'greeting', enabled: true, posture: 'standing' },
  ];
  const avatar = { key: 'synthetic-avatar', kind: 'vrm', name: '合成形象' };
  const catalog = { catalog: () => ({ categories: [{ id: 'greeting', label: '问候' }], motions }), prompt: () => [], select: key => motions.find(motion => motion.key === key) };
  c.currentAvatar = () => avatar;
  c.avatarCatalog = new AvatarCatalogRouter(catalog, () => null);
  c.requestReply = mainRequire('./reply-request').requestReply;
  const performed = [], spoken = [], calls = [];
  c.embodiment.posture = 'standing';
  c.embodiment.perform = async (key, reason, options) => {
    assert(!options.signal?.aborted);
    performed.push({ key, reason, options });
    return { ok: true };
  };
  c.embodiment.cancelPerformance = () => {};
  c.speak = (text, options = {}) => {
    spoken.push({ text, options });
    c.speechQueue.push({ text, ...options });
  };
  const mainReply = (text, extra = {}) => JSON.stringify({ protocol: 'dialogue-v2', stages: [
    { stage: 'review', grade: 'unassessed', note: '', grasp: 'steady', pace: 'listen' },
    { stage: 'reply', reply: { kind: 'chat', text, ...extra } },
    { stage: 'prediction', expect: null, basis: [] },
  ] });
  const stream = (options, raw, complete = false) => {
    if (complete) options.onDelta?.(raw, { complete: true });
    else for (const char of raw) options.onDelta?.(char);
    return { raw };
  };
  return { ...f, performed, spoken, calls, mainReply, stream, avatar, motions };
}

test('actual think with empty primary text calls the performance model once and records only its visible segment', async () => {
  const f = performanceFixture(), c = f.context, prompt = '用一个合适的跑步动作回应，展示时自然接话。';
  c.llm.chat = async options => {
    f.calls.push(options);
    if (options.cognitive) return f.stream(options, f.mainReply('', { performance: prompt }));
    assert.equal(options.messages.length, 2);
    assert.equal(options.messages[1].content, prompt);
    assert(options.messages[0].content.includes('1 原地跑'));
    assert(options.messages[0].content.includes('2 挥手'));
    assert.equal(f.performed.length, 0);
    return f.stream(options, '{"motion":1,"text":"我来试试。"}');
  };
  const reply = await c.think({ userText: '跑跑看', userMessage: owner('empty-primary'), allowSpeech: true });
  assert(reply, JSON.stringify(f.events));
  assert.equal(reply.text, '我来试试。');
  assert.equal(f.calls.length, 2);
  assert.equal(f.performed.length, 1);
  assert.equal(f.performed[0].key, 'synthetic-run');
  assert.equal(f.performed[0].reason, 'performance');
  assert.deepEqual(f.spoken.map(row => row.text), ['我来试试。']);
  assert.deepEqual(f.receipts.map(row => row.text), ['我来试试。']);
  assert.deepEqual(f.events.filter(row => row.type === 'chat').map(row => row.value.text), ['我来试试。']);
  assert.equal(f.events.filter(row => row.type === 'delta').map(row => row.value.text).join(''), '我来试试。');
  assert.equal(f.receipts[0].id, 'reply:empty-primary:performance');
  assert.equal(f.dispatches.length, 0);
  assert.equal(c.busy, false);
});

test('actual primary and performance streams share one speech owner and ordered message IDs without replay', async () => {
  for (const complete of [false, true]) {
    const f = performanceFixture(), c = f.context;
    c.llm.chat = async options => {
      f.calls.push(options);
      return options.cognitive
        ? f.stream(options, f.mainReply('先聊一句。', { performance: '接着展示跑步，并说另一句话。' }), complete)
        : f.stream(options, '{"motion":1,"text":"边做边聊。"}', complete);
    };
    const reply = await c.think({ userText: '给我展示一下', userMessage: owner('two-segments'), allowSpeech: true });
    assert(reply, JSON.stringify(f.events));
    assert.equal(reply.text, '先聊一句。\n边做边聊。');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.spoken.map(row => row.text), ['先聊一句。', '边做边聊。']);
    assert.equal(f.spoken[0].options.responseOwner, f.spoken[1].options.responseOwner);
    assert.equal(c.speechQueue[0].messageId, 'reply:two-segments');
    assert.equal(c.speechQueue[1].messageId, 'reply:two-segments:performance');
    assert.deepEqual(f.receipts.map(row => row.text), ['先聊一句。', '边做边聊。']);
    assert.deepEqual(f.events.filter(row => row.type === 'chat').map(row => row.value.text), ['先聊一句。', '边做边聊。']);
    assert.equal(f.events.filter(row => row.type === 'delta').map(row => row.value.text).join(''), '先聊一句。边做边聊。');
    assert.equal(f.dispatches.length, 0);
  }
});

test('ordinary actual think does not automatically call the performance model', async () => {
  const f = performanceFixture(), c = f.context;
  c.llm.chat = async options => {
    f.calls.push(options);
    assert.equal(options.cognitive, true);
    return f.stream(options, f.mainReply('普通交流。'));
  };
  assert.equal((await c.think({ userText: '聊聊今天', userMessage: owner('ordinary-no-performance'), allowSpeech: true })).text, '普通交流。');
  assert.equal(f.calls.length, 1); assert.equal(f.performed.length, 0); assert.equal(f.dispatches.length, 0);
  assert.deepEqual(f.spoken.map(row => row.text), ['普通交流。']);
});

test('actual voice performance cannot call its second model or dispatch an action before acoustic commit', async () => {
  const f = performanceFixture(), c = f.context, waiting = Promise.withResolvers(), commit = Promise.withResolvers();
  let committed = false, remembered = 0;
  const voice = { accepted: true, isCurrent: () => true, canCommit: () => committed,
    waitForCommit: () => { waiting.resolve(); return commit.promise; },
    remember: () => { remembered++; return owner('committed-performance'); }, rememberConversation: () => owner('conversation-performance'), hold() {}, recognize: () => true };
  c.llm.chat = async options => {
    f.calls.push(options);
    if (options.cognitive) return f.stream(options, f.mainReply('', { performance: '用跑步动作回应。', turnDisposition: 'keep' }));
    assert.equal(committed, true); assert.equal(remembered, 1);
    return f.stream(options, '{"motion":1,"text":""}');
  };
  const pending = c.think({ userText: '跑跑看', voiceTurn: voice, judge: true, allowSpeech: true });
  await waiting.promise;
  assert.equal(f.calls.length, 1); assert.equal(f.performed.length, 0); assert.equal(f.spoken.length, 0); assert.equal(f.receipts.length, 0);
  committed = true; commit.resolve(true);
  const reply = await pending;
  assert(reply, JSON.stringify(f.events)); assert.equal(reply.performanceReceipt.started, true);
  assert.equal(f.calls.length, 2); assert.equal(f.performed.length, 1); assert.equal(f.dispatches.length, 0);
  assert.equal(f.receipts.length, 0, 'silent performance writes no empty assistant message');
});

test('actual think cancels a performance model that ignores abort and discards all its late output', async () => {
  const f = performanceFixture(), c = f.context, entered = Promise.withResolvers(), late = Promise.withResolvers();
  let oldOptions;
  c.llm.chat = async options => {
    f.calls.push(options);
    if (options.cognitive) {
      const body = JSON.parse(options.messages.at(-1).content.split('\n\n')[0]);
      return f.stream(options, body.text.includes('new input') ? f.mainReply('新的回答。') : f.mainReply('', { performance: '跑步回应。' }));
    }
    oldOptions = options; entered.resolve();
    await late.promise;
    return f.stream(options, '{"motion":1,"text":"迟到的旧表演。"}');
  };
  const old = c.think({ userText: 'old performance', userMessage: owner('old-performance'), allowSpeech: true });
  await entered.promise;
  const fresh = c.think({ userText: 'new input', userMessage: owner('new-input'), allowSpeech: true });
  assert.equal(await old, null);
  assert.equal(oldOptions.signal.aborted, true);
  assert.equal((await fresh).text, '新的回答。');
  const eventCount = f.events.length, receiptCount = f.receipts.length, spokenCount = f.spoken.length;
  late.resolve(); await flush(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.length, eventCount); assert.equal(f.receipts.length, receiptCount); assert.equal(f.spoken.length, spokenCount);
  assert.equal(f.performed.length, 0); assert.equal(f.dispatches.length, 0); assert.equal(c.busy, false);
  assert(!f.events.some(row => row.type === 'chat' && row.value.text.includes('迟到')));
});

test('new input after an acknowledged silent performance contains only new words and cannot regenerate the old goal', async () => {
  const f = performanceFixture(), c = f.context, entered = Promise.withResolvers(), late = Promise.withResolvers();
  const original = '请无声展示下雪表演', latest = '只回答一加一，不要动作';
  let oldOptions, completed = false;
  const voice = { accepted: true, turnId: 'old-silent-performance', isCurrent: () => !completed,
    canCommit: () => true, waitForCommit: async () => true, remember: () => owner('old-silent-performance'),
    rememberConversation: () => owner('old-silent-performance'), hold() {}, recognize: () => true, complete() { completed = true; } };
  c.llm.chat = async options => {
    f.calls.push(options);
    if (options.cognitive) {
      const body = JSON.parse(options.messages.at(-1).content.split('\n\n')[0]);
      if (body.text === original) return f.stream(options, f.mainReply('', { performance: '安静地展示一个下雪动作。', turnDisposition: 'keep' }));
      assert.equal(body.text, latest, 'acknowledged old words must not be merged into the new owner request');
      assert.equal(body.inputParts, undefined);
      return f.stream(options, f.mainReply('一加一等于二。'));
    }
    assert.equal(f.calls.length, 2, 'only the old request may start a performance model');
    oldOptions = options; entered.resolve(); await late.promise;
    return f.stream(options, '{"motion":1,"text":""}');
  };
  const old = c.think({ userText: original, voiceTurn: voice, judge: true, allowSpeech: true });
  await entered.promise;
  const oldLease = c.dialogueScheduler().channels.get('local').active;
  assert.equal(oldLease.consumed, true);
  assert.equal(oldLease.finished, undefined);
  assert(oldLease.isCurrent());
  assert.equal(completed, false, 'acknowledgement retains the live voice token while the optional stage is active');
  const fresh = c.think({ userText: latest, userMessage: owner('new-math-only'), allowSpeech: true });
  assert.equal(await old, null);
  assert.equal(oldOptions.signal.aborted, true);
  assert.equal(completed, true, 'cancelled acknowledged voice input is retired instead of retained for automatic resume');
  const reply = await fresh;
  assert(reply, JSON.stringify(f.events)); assert.equal(reply.text, '一加一等于二。');
  assert.equal(f.calls.length, 3, 'two main calls and only the cancelled old performance call');
  assert.equal(c.dialogueScheduler().resumable({ scope: c.dialogueScope() }), null);
  late.resolve(); await flush(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 3); assert.equal(f.performed.length, 0); assert.equal(f.dispatches.length, 0);
  assert.deepEqual(f.spoken.map(row => row.text), ['一加一等于二。']);
});

test('a failed actual second stage with no output does not report a completed voice response or start tasks', async () => {
  const f = performanceFixture(), c = f.context; let completed = 0;
  const voice = { accepted: true, isCurrent: () => true, canCommit: () => true, waitForCommit: async () => true,
    remember: () => owner('failed-performance'), rememberConversation: () => owner('failed-performance'), hold() {}, recognize: () => true, complete() { completed++; } };
  c.llm.chat = async options => {
    f.calls.push(options);
    if (options.cognitive) return f.stream(options, f.mainReply('', { performance: '展示跑步。', turnDisposition: 'keep' }));
    throw Object.assign(new Error('synthetic transport failure'), { code: 'E_NETWORK' });
  };
  const reply = await c.think({ userText: '跑跑看', voiceTurn: voice, judge: true, allowSpeech: true });
  assert.equal(reply, null, 'failed second stage cannot be returned as a completed empty answer');
  assert.equal(f.calls.length, 2); assert.equal(f.performed.length, 0); assert.equal(f.dispatches.length, 0);
  assert.equal(f.receipts.length, 0); assert.equal(f.spoken.length, 0);
  assert(!f.events.some(row => row.type === 'heard' && row.value.replied === true));
  assert(!f.events.some(row => row.type === 'chat' && row.value.final === true));
  assert(f.events.some(row => row.type === 'toast' && /表演/u.test(row.value.text)));
  assert(completed > 0, 'failed voice ownership is still retired');
  assert.equal(c.busy, false);
});

test('actual secondary stream failure keeps only its visible partial once and never dispatches its motion', async () => {
  const f = performanceFixture(), c = f.context, stops = [], originalStop = c.stopSpeaking;
  c.stopSpeaking = (reason, options) => { stops.push(reason); return originalStop(reason, options); };
  c.llm.chat = async options => {
    f.calls.push(options);
    return options.cognitive
      ? f.stream(options, f.mainReply('', { performance: '展示动作时自然回应。' }))
      : f.stream(options, '{"motion":1,"text":"已经展示的半句话。","unexpected":true}');
  };
  const reply = await c.think({ userText: '展示动作', userMessage: owner('bad-secondary'), allowSpeech: true });
  assert(reply, JSON.stringify(f.events));
  assert.equal(f.calls.length, 2, 'already visible secondary speech is not repaired or replayed');
  assert.equal(reply.performanceReceipt.started, false);
  assert.equal(reply.performanceReceipt.error, 'E_PERFORMANCE_PROTOCOL');
  assert.equal(reply.text, '已经展示的半句话。');
  assert.equal(f.performed.length, 0); assert.equal(f.dispatches.length, 0);
  assert.deepEqual(f.receipts.map(row => row.text), ['已经展示的半句话。']);
  assert.equal(f.receipts[0].id, 'reply:bad-secondary:performance-partial');
  assert.deepEqual(f.spoken.map(row => row.text), ['已经展示的半句话。']);
  assert.equal(stops.filter(reason => reason === 'response-error').length, 1);
  assert.equal(f.events.filter(row => row.type === 'chat' && row.value.final === true).length, 1);
  assert(f.events.some(row => row.type === 'toast' && /未能完成/u.test(row.value.text)));
  assert.equal(c.busy, false);
});

test('an actual secondary failure after a primary segment retains that segment and an honest error receipt', async () => {
  const f = performanceFixture(), c = f.context;
  c.llm.chat = async options => {
    f.calls.push(options);
    if (options.cognitive) return f.stream(options, f.mainReply('我看看能怎么展示。', { performance: '展示合适的跑步动作。' }));
    throw Object.assign(new Error('synthetic failure'), { code: 'E_NETWORK' });
  };
  const reply = await c.think({ userText: '跑跑看', userMessage: owner('primary-before-error'), allowSpeech: true });
  assert(reply, JSON.stringify(f.events));
  assert.equal(reply.text, '我看看能怎么展示。');
  assert.equal(reply.performanceReceipt.started, false); assert.equal(reply.performanceReceipt.error, 'E_NETWORK');
  assert.equal(f.calls.length, 2); assert.equal(f.performed.length, 0); assert.equal(f.dispatches.length, 0);
  assert.deepEqual(f.receipts.map(row => row.text), ['我看看能怎么展示。']);
  assert.deepEqual(f.spoken.map(row => row.text), ['我看看能怎么展示。']);
  assert.deepEqual(f.events.filter(row => row.type === 'chat').map(row => row.value.text), ['我看看能怎么展示。']);
  assert.equal(c.busy, false);
});

test('actual performance retains main cognition on its final visible segment for the next dialogue', async () => {
  const f = performanceFixture(), c = f.context;
  c.llm.chat = async options => {
    if (!options.cognitive) return f.stream(options, '{"motion":1,"text":"边做边回应。"}');
    const value = JSON.parse(f.mainReply('先回答。', { performance: '再自然展示跑步。' }));
    value.stages[2].expect = '主人评价这次动作是否合适。';
    return f.stream(options, JSON.stringify(value));
  };
  const reply = await c.think({ userText: '展示一下', userMessage: owner('cognition-performance'), allowSpeech: false });
  assert(reply, JSON.stringify(f.events));
  assert.equal(f.receipts.length, 2);
  const saved = f.receipts.at(-1).details.cognition;
  assert(saved, 'the latest Bunny segment must preserve the validated main cognition');
  assert.equal(saved.dialogueId, 'owner:work');
  assert.equal(saved.selfRevision, 1);
  assert.equal(saved.review.grade, 'unassessed');
  assert.equal(saved.prediction, '主人评价这次动作是否合适。');
  assert.equal(saved.review.grade, 'unassessed', 'a second output segment does not count as a second graded dialogue turn');
});

function avatarSelectionFixture() {
  const f = performanceFixture(), c = f.context;
  const rows = Array.from({ length: 7 }, (_, index) => ({ key: 'official-' + (index + 1), label: '官方形象' + (index + 1), kind: 'vrm' }));
  rows.push({ key: 'custom-character', label: '自定义形象', kind: 'avatar-pack' });
  const switches = [];
  c.avatarList = () => rows;
  c.avatarCapability = () => ({ select: async (key, options) => {
    switches.push({ key, options });
    assert(options.isCurrent()); assert.equal(options.signal.aborted, false);
    return { ok: true, key, label: rows.find(row => row.key === key).label, changed: true, ready: true };
  } });
  const avatarReply = (avatar, reply) => {
    const value = JSON.parse(f.mainReply(''));
    value.stages[1].reply = { kind: 'action', intent: { action: 'avatar_select', avatar, ...(reply === undefined ? {} : { reply }) } };
    return JSON.stringify(value);
  };
  return { ...f, avatars: rows, switches, avatarReply };
}

test('actual main request anchors loaded appearance and pending target from one shared body snapshot', async () => {
  for (const appearance of [{ name: '合成当前形象', ready: true }, { name: '合成当前形象', ready: false, requestedName: '合成目标形象' }]) {
    const f = avatarSelectionFixture(), c = f.context; let reads = 0;
    c.embodiment.context = () => { reads++; return { appearance }; };
    c.llm.chat = async options => {
      const body = JSON.parse(options.messages.find(message => message._contextLane === 'body').content);
      assert.deepEqual(body.appearance, appearance);
      assert(options.messages[0].content.includes(JSON.stringify(appearance)));
      assert(options.messages[0].content.includes('区别于人格名字、用户的称呼和历史形象'));
      return f.stream(options, f.mainReply('当前是合成当前形象。'));
    };
    const reply = await c.think({ userText: '另一个称呼，你现在是什么形象？', userMessage: owner('appearance-' + appearance.ready), allowSpeech: false });
    assert(reply); assert.equal(reads, 1); assert.equal(f.switches.length, 0);
  }
});

test('actual avatar selection sees all current names and speaks its reply only after local readiness without another model or task', async () => {
  const f = avatarSelectionFixture(), c = f.context, entered = Promise.withResolvers(), ready = Promise.withResolvers();
  const natural = '换个样子继续陪你聊。';
  c.avatarCapability = () => ({ select: async (key, options) => {
    f.switches.push({ key, options }); entered.resolve(); await ready.promise;
    return { ok: true, key, label: '自定义形象', changed: true, ready: true };
  } });
  c.llm.chat = async options => {
    f.calls.push(options);
    assert.equal(options.cognitive, true);
    const body = JSON.parse(options.messages.find(message => message._contextLane === 'body').content);
    assert.deepEqual(body.availableAvatars.map(row => row.name), f.avatars.map(row => row.label));
    assert.deepEqual(body.availableAvatars.map(row => row.number), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert(body.availableAvatars.every(row => !Object.hasOwn(row, 'key')));
    return f.stream(options, f.avatarReply(8, natural));
  };
  const pending = c.think({ userText: '你挑个合适的形象变身吧', userMessage: owner('avatar-ready'), allowSpeech: true });
  await entered.promise;
  assert.equal(f.switches[0].key, 'custom-character'); assert(f.switches[0].options.isCurrent());
  assert.deepEqual(f.spoken, []); assert.equal(f.receipts.length, 0);
  assert(!f.events.some(row => row.type === 'chat' && row.value.text === natural));
  ready.resolve(); const reply = await pending;
  assert(reply, JSON.stringify(f.events)); assert.equal(reply.text, natural);
  assert.equal(f.calls.length, 1); assert.equal(f.switches.length, 1); assert.equal(f.dispatches.length, 0); assert.equal(f.performed.length, 0);
  assert.deepEqual(f.spoken.map(row => row.text), [natural]); assert.deepEqual(f.receipts.map(row => row.text), [natural]);
  assert.equal(reply.actionReceipt.ok, true); assert.equal(reply.actionReceipt.avatar.key, 'custom-character'); assert.equal(reply.actionReceipt.avatar.ready, true);
  assert.equal(c.busy, false);
});

test('actual avatar selection cannot announce its supplied success reply on failed or unready receipts', async () => {
  for (const outcome of ['failed', 'unready', 'wrong-avatar', 'throws']) {
    const f = avatarSelectionFixture(), c = f.context, natural = '这个形象已经变好啦。';
    c.llm.chat = async options => { f.calls.push(options); return f.stream(options, f.avatarReply(2, natural)); };
    c.avatarCapability = () => ({ select: async (key, options) => {
      f.switches.push({ key, options });
      if (outcome === 'throws') throw Object.assign(Error('合成切换故障'), { code: 'E_AVATAR_LOAD' });
      return { ok: outcome !== 'failed', key: outcome === 'wrong-avatar' ? 'official-3' : key, label: '官方形象2', changed: true, ready: outcome !== 'unready', error: '合成切换尚未完成' };
    } });
    const reply = await c.think({ userText: '变成第二个形象', userMessage: owner('avatar-' + outcome), allowSpeech: true });
    assert(!reply?.actionReceipt?.ok, `${outcome} cannot be accepted as a successful avatar effect`);
    assert(!f.events.some(row => ['chat', 'delta'].includes(row.type) && row.value.text.includes(natural)));
    assert(!f.spoken.some(row => row.text === natural)); assert(!f.receipts.some(row => row.text === natural));
    assert.equal(f.calls.length, 1); assert.equal(f.switches.length, 1); assert.equal(f.dispatches.length, 0); assert.equal(c.busy, false);
  }
});

test('actual voice avatar selection waits for acoustic commitment in the same single model call', async () => {
  const f = avatarSelectionFixture(), c = f.context, waiting = Promise.withResolvers(), commit = Promise.withResolvers();
  let committed = false;
  const voice = { accepted: true, isCurrent: () => true, canCommit: () => committed,
    waitForCommit: () => { waiting.resolve(); return commit.promise; }, remember: () => owner('voice-avatar'),
    rememberConversation: () => owner('voice-avatar'), hold() {}, recognize: () => true };
  c.llm.chat = async options => { f.calls.push(options); return f.stream(options, f.avatarReply(2, '换个样子回应你。')); };
  const pending = c.think({ userText: '换个样子', voiceTurn: voice, judge: true, allowSpeech: true });
  await waiting.promise;
  assert.equal(f.calls.length, 1); assert.equal(f.switches.length, 0); assert.equal(f.spoken.length, 0); assert.equal(f.receipts.length, 0);
  committed = true; commit.resolve(true);
  const reply = await pending;
  assert(reply, JSON.stringify(f.events)); assert.equal(reply.actionReceipt.avatar.ready, true);
  assert.equal(f.calls.length, 1); assert.equal(f.switches.length, 1); assert.equal(f.dispatches.length, 0);
});

test('transient unclassified audio after avatar admission preserves loading ownership and gates only the later reply', async () => {
  const f = avatarSelectionFixture(), c = f.context, waiting = Promise.withResolvers(), quiet = Promise.withResolvers();
  let committed = true;
  const voice = { accepted: true, isCurrent: () => true, canCommit: () => committed,
    waitForCommit: () => { if (committed) return Promise.resolve(true); waiting.resolve(); return quiet.promise; }, remember: () => owner('voice-avatar-transient'),
    rememberConversation: () => owner('voice-avatar-transient'), hold() {}, recognize: () => true };
  c.llm.chat = async options => f.stream(options, f.avatarReply(2, '变好啦。'));
  c.avatarCapability = () => ({ select: async (key, options) => {
    assert(options.isCurrent()); committed = false;
    assert(options.isCurrent(), 'temporary raw activity is not a new accepted dialogue identity');
    assert.equal(options.signal.aborted, false);
    return { ok: true, key, label: '官方形象2', changed: true, ready: true };
  } });
  const pending = c.think({ userText: '变个样子', voiceTurn: voice, judge: true, allowSpeech: true });
  await waiting.promise; assert.equal(f.spoken.length, 0); assert.equal(f.receipts.length, 0);
  committed = true; quiet.resolve(true);
  const reply = await pending; assert.equal(reply.actionReceipt.avatar.ready, true);
  assert.deepEqual(f.spoken.map(row => row.text), ['变好啦。']);
});

test('new dialogue cancels a pending avatar switch and its late success cannot speak or restore the old input', async () => {
  const f = avatarSelectionFixture(), c = f.context, entered = Promise.withResolvers(), late = Promise.withResolvers();
  const latest = '现在只回答一加一'; let oldOptions;
  c.llm.chat = async options => {
    f.calls.push(options);
    const body = JSON.parse(options.messages.at(-1).content.split('\n\n')[0]);
    if (body.text === '变个样子') return f.stream(options, f.avatarReply(2, '迟到的变身回复。'));
    assert.equal(body.text, latest); assert.equal(body.inputParts, undefined);
    return f.stream(options, f.mainReply('一加一等于二。'));
  };
  c.avatarCapability = () => ({ select: async (key, options) => {
    f.switches.push({ key, options }); oldOptions = options; entered.resolve(); await late.promise;
    return { ok: true, key, label: '官方形象2', changed: true, ready: true };
  } });
  const old = c.think({ userText: '变个样子', userMessage: owner('old-avatar'), allowSpeech: true });
  await entered.promise;
  const fresh = c.think({ userText: latest, userMessage: owner('new-after-avatar'), allowSpeech: true });
  assert.equal(await old, null); assert.equal(oldOptions.signal.aborted, true); assert.equal(oldOptions.isCurrent(), false);
  assert.equal((await fresh).text, '一加一等于二。');
  const eventCount = f.events.length, receiptCount = f.receipts.length;
  late.resolve(); await flush(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.length, eventCount); assert.equal(f.receipts.length, receiptCount);
  assert.equal(f.calls.length, 2); assert.equal(f.switches.length, 1); assert.equal(f.dispatches.length, 0);
  assert.deepEqual(f.spoken.map(row => row.text), ['一加一等于二。']); assert.equal(c.busy, false);
});

test('an actual avatar decision cannot reinterpret a stale numbered catalog', async () => {
  const f = avatarSelectionFixture(), c = f.context;
  c.llm.chat = async options => {
    f.calls.push(options); f.avatars.reverse();
    return f.stream(options, f.avatarReply(2, '不应宣称切换成功。'));
  };
  assert.equal(await c.think({ userText: '换个形象', userMessage: owner('stale-avatar-catalog'), allowSpeech: true }), null);
  assert.equal(f.calls.length, 1); assert.equal(f.switches.length, 0); assert.equal(f.dispatches.length, 0);
  assert(!f.spoken.some(row => row.text === '不应宣称切换成功。'));
  assert.equal(c.busy, false);
});
