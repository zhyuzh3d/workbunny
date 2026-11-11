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
  vm.runInContext(section('async function committedVoice(', '/* ── 主动播报') + '\n' + section("ipcMain.handle('pet:say'", 'async function applySettings('), context);
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
