'use strict';
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
    stopSpeaking() { context.activeThought?.abort(); }, voiceTurns: { reset() {} }, lastHeardAt: 0, autonomy: null,
    QUIET_WORDS: /never-match-fixture/u,voiceMetadata(){},asrFailStreak:0,
    require: name => name === './bounded-wait' ? { createBoundedWait: opts => createBoundedWait({ ...opts, setTimer, clearTimer }) } : mainRequire(name),
  };
  vm.createContext(context);
  vm.runInContext(section('async function committedVoice(', '/* ── 主动播报') + '\n' + section("ipcMain.handle('pet:say'", 'async function applySettings('), context);
  const fire = ms => { const entry = [...timers].find(([, timer]) => timer.ms === ms); assert(entry, `missing ${ms}ms timer`); timers.delete(entry[0]); entry[1].fn(); };
  return { context, memory, events, dispatches, receipts, handlers, fire, contexts: () => contexts };
}
test('a new voice turn releases a stuck old preparation and late completion cannot present the old reply', async () => {
  const f = fixture(), c = f.context; let complete, calls = 0;
  f.memory.cognition.loadRoleView = () => ++calls === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ revision: 1 });
  const old = c.think({ userText: 'old', userMessage: owner('old'), allowSpeech: false });
  await flush(); assert.equal(c.busy, true);
  const voice = { accepted:true,canCommit:()=>true,isCurrent: () => true, waitForCommit: async () => true, remember: () => owner('voice') };
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
  const voice = { accepted:true,canCommit:()=>false,isCurrent: () => true, waitForCommit: () => new Promise(resolve => { commit = resolve; }), remember: () => owner('voice') };
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
 const voice={accepted:true,canCommit:()=>true,isCurrent:()=>true,waitForCommit:async()=>true,remember:()=>owner('voice-during-review')};
 const reply=await c.think({userText:'A new accepted voice message',voiceTurn:voice,allowSpeech:false});
 assert.equal(reply.text,'fresh reply');assert.equal(c.busy,false);assert.equal(reviewSignal.aborted,false);
 gate.resolve({text:JSON.stringify({type:'continue',rationaleSummary:'Keep the original goal and verify the alternate explanation',sourceRefs:[],guidance:{verificationIdeas:['read the retained fixture evidence']}})});
 assert.equal((await review).type,'continue');assert.equal(c.busy,false);assert.equal(c.activeThought,null);assert.equal(f.dispatches.length,0);
});
