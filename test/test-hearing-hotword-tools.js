'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ToolRegistry } = require('../src/main/agent-tools');
const { OperationLedger } = require('../src/main/operation-ledger');
const { snapshot, update } = require('../src/main/hearing-hotwords');
const { ACTION_SCHEMA, UPDATE_SCHEMA, validateAction, registerHearingHotwordTools, contextFragment, READ, MANAGE } = require('../src/main/hearing-hotword-tools');

function fixture() {
  let config = { buddy: { name: 'Bunny' }, asr: { wakeAliases: ['小兔'], hotwords: ['WorkBunny'] } }, writes = 0, reads = 0;
  const store = { load: () => structuredClone(config), save: patch => { config.asr = { ...config.asr, ...patch.asr }; writes++; } };
  const hearingHotwords = { read: () => { reads++; return snapshot(store.load()); }, update: (request, { isCurrent }) => {
    if (!isCurrent()) throw Object.assign(Error('cancelled before save'), { dispatched: false });
    return update(store, request);
  } };
  const task = { id: 'test-hotwords', skill: 'system.operate', status: 'running', scene: 'life', subjects: [{ application: 'system' }],
    authority: { role: 'owner', verified: true, channel: 'dialogue' }, capabilities: [READ, MANAGE], state: {}, operations: {}, counters: { reads: 0, writes: 0 }, inbox: [] };
  const request = () => ({ expectedRevision: snapshot(store.load()).revision, ops: [{ op: 'add', word: '月桂项目' }] });
  return { task, hearingHotwords, request, value: () => snapshot(store.load()), writes: () => writes, reads: () => reads };
}

test('hotword actions share strict update validation and never emit their pending reply', () => {
  const { validateIntent, makeActionGate } = require('../src/main/dialogue-actions');
  const { schema, validateReply } = require('../src/main/reply-format');
  const action = { action: 'hearing_hotwords', expectedRevision: 'fixture-revision', ops: [{ op: 'replace', word: 'Old', replacement: ' Ｎｅｗ ' }], reply: '这个名字我记住了。' };
  assert.equal(validateIntent(action).ops[0].replacement, 'New');
  assert(schema.anyOf[1].properties.intent.anyOf.includes(ACTION_SCHEMA));
  assert.equal(UPDATE_SCHEMA.properties.ops.maxItems, 512);
  const raw = JSON.stringify({ kind: 'action', intent: action });
  for (let split = 0; split <= raw.length; split++) {
    let shown = ''; const gate = makeActionGate(s => { shown += s; }, { requireEnvelope: true });
    gate.push(raw.slice(0, split)); gate.push(raw.slice(split)); gate.flush();
    assert.equal(shown, ''); assert.equal(gate.error, null); assert.deepEqual(gate.intent, validateAction(action));
  }
  assert.equal(validateReply(raw).intent.reply, action.reply);
  assert.throws(() => validateReply(raw, { allowActions: false }), { code: 'E_REPLY_PROTOCOL' });
  for (const change of [{ unknown: true }, { name: 'Changed identity' }, { reply: '' }, { reply: 'x'.repeat(601) }, { reply: 'two\nlines' }, { expectedRevision: '' },
    { ops: [{ op: 'replace', word: 'old' }] }, { ops: [{ op: 'add', word: 'Password: fixture-secret' }] }, { ops: [{ op: 'add', word: 'safe', extra: true }] }]) {
    assert.throws(() => validateAction({ ...action, ...change }));
  }
  assert.throws(() => validateReply(raw.slice(0, -1)), { code: 'E_REPLY_PROTOCOL' });
  assert.equal(validateReply('{"kind":"skip"}').intent, null);
});

test('task vocabulary tools have narrow capabilities and exclude ordinary-contact conversations', async () => {
  const f = fixture(), tools = new ToolRegistry(); registerHearingHotwordTools(tools, f);
  assert.deepEqual(tools.catalog(undefined, f.task).map(t => t.name), [READ, 'hearing.hotwords.update']);
  for (const task of [{ ...f.task, skill: 'conversation.manage' }, { ...f.task, authority: { role: 'contact', verified: true } },
    { ...f.task, authority: { role: 'owner', verified: false } }, { ...f.task, capabilities: [] },
    { ...f.task, authority: { ...f.task.authority, capabilities: [] } }]) {
    assert.equal(tools.catalog(undefined, task).length, 0);
    assert.throws(() => tools.check('hearing.hotwords.update', f.request(), task), /未授权/);
    await assert.rejects(tools.get('hearing.hotwords.update').execute(f.request(), { task }), { dispatched: false });
  }
  const readOnly = { ...f.task, capabilities: [READ], authority: { ...f.task.authority, capabilities: [READ] } };
  assert.equal(tools.catalog(undefined, readOnly).length, 1);
  assert.throws(() => tools.check(READ, { application: 'system' }, readOnly));
  const result = await tools.get(READ).execute({}, { task: readOnly }); assert.equal(result.snapshot.name, 'Bunny'); assert.equal(f.writes(), 0);
  const absent = new ToolRegistry(); registerHearingHotwordTools(absent); assert.equal(absent.catalog().length, 0);
});

test('cancelled or superseded tasks cannot reach the vocabulary save boundary', async () => {
  const f = fixture(); let current = true;
  const tools = new ToolRegistry(); registerHearingHotwordTools(tools, { ...f, isCurrent: () => current });
  const tool = tools.get('hearing.hotwords.update'), controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute(f.request(), { task: f.task, signal: controller.signal }), { dispatched: false });
  current = false; await assert.rejects(tool.execute(f.request(), { task: f.task }), { dispatched: false });
  current = true;
  await assert.rejects(tool.execute(f.request(), { task: f.task, action: { protect: async () => { f.task.state.goalRevision = 1; } } }), { dispatched: false });
  assert.equal(f.writes(), 0);
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const deferred = { ...f.hearingHotwords, update: async (request, options) => { enter(); await gate; return f.hearingHotwords.update(request, options); } };
  const lateTools = new ToolRegistry(); registerHearingHotwordTools(lateTools, { hearingHotwords: deferred });
  const pending = lateTools.get('hearing.hotwords.update').execute(f.request(), { task: f.task });
  await entered; f.task.authority.capabilities = [READ]; finish(); await assert.rejects(pending, { dispatched: false }); assert.equal(f.writes(), 0);
});

test('the operation ledger saves verified vocabulary receipts and reuses a confirmed write', async () => {
  const f = fixture(), tools = new ToolRegistry(), journal = [];
  registerHearingHotwordTools(tools, f);
  const ledger = new OperationLedger({ tools, authorize: async () => {}, save: async task => journal.push(structuredClone(task)), clock: Date.now });
  const call = { tool: 'hearing.hotwords.update', key: 'add-confirmed-vocabulary', args: f.request() };
  const result = await ledger.execute({ task: f.task, call, isCurrent: () => true });
  assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(result.receipt.saved, true);
  assert.deepEqual(result.snapshot.hotwords, ['WorkBunny', '月桂项目']);
  const operation = Object.values(f.task.operations)[0]; assert.equal(operation.status, 'confirmed'); assert.deepEqual(operation.result, result);
  assert(journal.some(task => Object.values(task.operations)[0]?.status === 'intent'));
  assert.equal(Object.values(journal.at(-1).operations)[0].result.receipt.snapshot.revision, f.value().revision);
  assert.deepEqual(await ledger.execute({ task: f.task, call, isCurrent: () => true }), result); assert.equal(f.writes(), 1); assert.equal(f.task.counters.writes, 1);
});

test('a saved update remains confirmed when the task is cancelled immediately afterward', async () => {
  const f = fixture(), tools = new ToolRegistry(); let current = true;
  const service = { ...f.hearingHotwords, update: (...args) => { const receipt = f.hearingHotwords.update(...args); current = false; return receipt; } };
  registerHearingHotwordTools(tools, { hearingHotwords: service, isCurrent: () => current });
  const ledger = new OperationLedger({ tools, authorize: async () => {}, save: async () => {}, clock: Date.now });
  const call = { tool: 'hearing.hotwords.update', key: 'saved-before-cancel', args: f.request() };
  await assert.rejects(ledger.execute({ task: f.task, call, isCurrent: () => current }), /实际结果已核实并保存/);
  assert.equal(Object.values(f.task.operations)[0].status, 'confirmed'); assert.equal(f.writes(), 1);
  current = true; await ledger.execute({ task: f.task, call, isCurrent: () => current }); assert.equal(f.writes(), 1);
});

test('vocabulary context is owner-only, read-only and loaded only on demand; normal chat remains one model call', async () => {
  const f = fixture(); assert.equal(contextFragment({ ...f, owner: false }), null); assert.equal(f.reads(), 0);
  const fragment = contextFragment(f); assert.equal(f.reads(), 0);
  const { createContextSession, CONTEXT_TOOL } = require('../src/main/context-assembler');
  const session = createContextSession({ fragments: [fragment] });
  const { chatWithSearch } = require('../src/main/conversation-search'); let calls = 0;
  await chatWithSearch({ messages: [{ role: 'user', content: '你好' }], contextSession: session, webSearch: false }, { chat: async () => { calls++; return { text: '{"kind":"chat","text":"你好。"}' }; } });
  assert.equal(calls, 1); assert.equal(f.reads(), 0); assert.equal(f.writes(), 0);
  const read = await session.run(CONTEXT_TOOL, { modules: [{ id: fragment.id }] });
  assert.equal(read.modules.hearing_hotwords.revision, f.value().revision); assert.match(read.modules.hearing_hotwords.rule, /不另发纠错模型请求/);
  assert.equal(f.reads(), 1); assert.equal(f.writes(), 0);
  await assert.rejects(contextFragment({ ...f, isCurrent: () => false }).load(), { dispatched: false }); assert.equal(f.reads(), 1);
});

test('AgentService optionally injects vocabulary tools without requiring operating-system configuration permission', async t => {
  const { AgentService } = require('../src/main/agent-service'), { AuthorizationService } = require('../src/main/authorization-service');
  const f = fixture(), records = new Map(); let modelCalls = 0;
  const agent = new AgentService({ hearingHotwords: f.hearingHotwords, ready: () => true, epoch: () => 1, autoSchedule: false,
    journal: { put: async task => records.set(task.id, structuredClone(task)), list: async () => [...records.values()], authorized: async () => true },
    scene: { metrics: {}, native: { request: async () => ({}) }, close: async () => {} },
    authorization: new AuthorizationService({ settings: () => ({ terminal: false, systemConfiguration: false }) }),
    request: async options => {
      const input = JSON.parse(options.messages[1].content[0].text); modelCalls++;
      assert(input.tools.some(tool => tool.name === 'hearing.hotwords.update'));
      return { response: { text: JSON.stringify(modelCalls === 1 ? { done: false, tool: 'hearing.hotwords.update', args: f.request() } : { done: true, summary: '额外热词已保存，识别效果待实际观察。' }) } };
    } });
  t.after(() => agent.close());
  assert(agent.contextModules().some(fragment => fragment.id === 'hearing_hotwords'));
  assert(!agent.contextModules({ owner: false }).some(fragment => fragment.id === 'hearing_hotwords'));
  const spec = { skill: 'system.operate', goal: '按本轮上下文维护正确的项目名', subjects: [{ application: 'system' }] };
  const restricted = { role: 'owner', verified: true, channel: 'dialogue', sources: ['fixture-owner'], scene: 'life', capabilities: ['terminal.execute', 'system.configure'] };
  const limited = await agent.start(spec, restricted); assert(limited.ok, limited.error); const task = agent.runtime.tasks.get(limited.id);
  assert(!task.capabilities.includes(READ)); assert(!task.capabilities.includes(MANAGE)); assert(!agent.tools.catalog(undefined, task).some(tool => tool.name.startsWith('hearing.')));
  const started = await agent.start(spec, { ...restricted, capabilities: [...restricted.capabilities, READ, MANAGE] }); assert(started.ok, started.error);
  await agent.runtime.tick(started.id); await agent.runtime.tick(started.id);
  const completed = agent.runtime.tasks.get(started.id); assert.equal(completed.status, 'completed', completed.note); assert.equal(f.writes(), 1); assert.equal(modelCalls, 2);
  const operation = Object.values(completed.operations).find(operation => operation.tool === 'hearing.hotwords.update');
  assert.equal(operation.status, 'confirmed'); assert.equal(operation.result.receipt.saved, true);
  assert(!completed.state.authorizationChecks.some(check => check.missing.length));
});
