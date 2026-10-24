'use strict';

const assert = require('assert/strict');
const { DesktopService, WECHAT_RULE, validateAction, dispatchGuard } = require('../src/main/desktop-service');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting for desktop task');
    await delay(10);
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const rect = { x: 10, y: 20, width: 800, height: 600 };
class FakeNative {
  constructor({ bundleId = 'cn.haminn.workbunny.fixture', permissionsGate, activateGate, moveAfterCapture = false, events = [] } = {}) {
    this.app = { pid: 123, bundleId, name: 'Fixture' };
    this.rect = { ...rect }; this.permissionsGate = permissionsGate; this.activateGate = activateGate;
    this.moveAfterCapture = moveAfterCapture; this.calls = []; this.cancelled = 0; this.events = events;
  }
  async request(op, payload = {}, timeoutMs = 12000) {
    this.calls.push({ op, payload, timeoutMs });
    this.events.push({ type: 'native', op, payload, timeoutMs });
    if (op === 'permissions') return this.permissionsGate ? this.permissionsGate.promise : { accessibilityTrusted: true, screenCaptureAllowed: true, postEventAllowed: true };
    if (op === 'activate') {
      if (this.activateGate) await this.activateGate.promise;
      this.app = { pid: 234, bundleId: payload.bundleId, name: 'Target' };
      this.rect = { ...rect }; return { activated: true };
    }
    if (op === 'frontmost') return { application: { ...this.app }, windows: [{ windowId: 7, pid: this.app.pid, layer: 0, rect: { ...this.rect } }] };
    if (op === 'capture') {
      const desktopRect = { ...this.rect };
      if (this.moveAfterCapture) this.rect = { ...this.rect, x: this.rect.x + 5 };
      return { pngBase64: Buffer.from('test-image').toString('base64'), desktopRect };
    }
    if (op === 'recognize') return { texts: [{ text: 'Hy3', confidence: 1, x: 0.4, y: 0.9 }, { text: '限时免费', confidence: 1, x: 0.5, y: 0.9 }] };
    return { performed: true };
  }
  cancel() { this.cancelled++; }
  close() {}
}

function service(native, planner, events = [], options = {}) {
  return new DesktopService({ native, planner, emit: value => events.push({ type: 'emit', status: value.task?.status }),
    persist: async task => events.push({ type: 'persist', status: task.status, steps: task.steps.map(x => ({ ...x })) }),
    imageResize: data => data, ...options });
}

async function testStartRaceAndStopDuringPermission() {
  const gate = deferred(), native = new FakeNative({ permissionsGate: gate }), events = [];
  const svc = service(native, async () => ({ action: 'done', completed: true, evidence: 'visible result' }), events);
  const first = svc.start({ goal: 'fixture task', target: 'current' });
  const second = await svc.start({ goal: 'duplicate task', target: 'current' });
  assert.equal(second.ok, false, 'concurrent starts must be serialized before permission await');
  await svc.stop('test stop');
  gate.resolve({ accessibilityTrusted: true, screenCaptureAllowed: true, postEventAllowed: true });
  assert.equal((await first).ok, false, 'stopped preflight must not launch');
  assert.equal(svc.starting, false);
  assert.equal(native.calls.some(x => x.op === 'activate' || x.op === 'capture'), false);
  assert.equal(native.cancelled, 1);
  assert(native.calls.every(call => call.timeoutMs <= 10000));
}

async function testStopDuringActivateDoesNotContinue() {
  const gate = deferred(), native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', activateGate: gate }), events = [];
  native.events = events;
  const svc = service(native, async () => ({ action: 'done', completed: true, evidence: '交付结果可见' }), events);
  const start = await svc.start({ goal: '检查交付状态', target: 'workbuddy' });
  assert(start.ok);
  await until(() => native.calls.some(x => x.op === 'activate'));
  const firstNativeSideEffect = events.findIndex(x => x.type === 'native' && x.op === 'activate');
  const firstJournal = events.findIndex(x => x.type === 'persist');
  assert(firstJournal >= 0 && firstJournal < firstNativeSideEffect, 'task journal must precede application activation');
  await svc.stop('cancel activation');
  gate.resolve();
  await delay(30);
  assert.equal(native.calls.some(x => x.op === 'frontmost' || x.op === 'capture' || x.op === 'click' || x.op === 'type'), false);
  assert.equal(svc.task.status, 'stopped');
}

async function testWindowMotionAndStaleScreenshot() {
  const moving = new FakeNative({ moveAfterCapture: true });
  const movingService = service(moving, async () => ({ action: 'click', x: 0.5, y: 0.5 }));
  assert((await movingService.start({ goal: 'observe', target: 'current' })).ok);
  await until(() => movingService.task.status === 'paused');
  assert.equal(moving.calls.some(x => x.op === 'click'), false);

  const native = new FakeNative(); const plannerGate = deferred(); let planned;
  const svc = service(native, async (goal, shot, signal, task) => { planned = { goal, shot, signal, task }; return plannerGate.promise; });
  assert((await svc.start({ goal: 'unchanged goal', target: 'current' })).ok);
  await until(() => planned);
  assert.equal(planned.goal, 'unchanged goal');
  assert.equal(planned.task.target, 'current');
  native.rect = { ...native.rect, x: native.rect.x + 10 };
  plannerGate.resolve({ action: 'click', x: 0.5, y: 0.5, reason: 'stale screenshot' });
  await until(() => svc.task.status === 'paused');
  assert.equal(native.calls.some(x => x.op === 'click'), false, 'a moved window invalidates the planner screenshot');

  const stopNative = new FakeNative(), stopPlanner = deferred(); let plannerStarted = false;
  const stopService = service(stopNative, async () => { plannerStarted = true; return stopPlanner.promise; });
  assert((await stopService.start({ goal: 'stop before input', target: 'current' })).ok);
  await until(() => plannerStarted);
  await stopService.stop('stop during planning');
  stopPlanner.resolve({ action: 'type', text: 'must not be sent' });
  await delay(20);
  assert.equal(stopNative.calls.some(x => x.op === 'type' || x.op === 'click' || x.op === 'key'), false);

  const expiredNative = new FakeNative();
  const expiredService = service(expiredNative, async (goal, shot) => {
    shot.at = Date.now() - 60001;
    return { action: 'click', x: 0.5, y: 0.5, reason: 'expired screenshot' };
  });
  assert((await expiredService.start({ goal: 'expired image', target: 'current' })).ok);
  await until(() => expiredService.task.status === 'paused');
  assert.equal(expiredNative.calls.some(x => x.op === 'click'), false, 'expired screenshots cannot authorize input');
}

async function testJournalBeforeActionScopeAndReview() {
  const events = [], native = new FakeNative({ events }); let turns = 0;
  const svc = service(native, async (goal, shot, signal, task) => {
    turns++;
    if (turns === 1) return { action: 'type', text: 'search phrase', reason: 'enter a search query' };
    assert.equal(task.goal, 'search for a task');
    assert.equal(task.target, 'current');
    assert(Object.isFrozen(task));
    assert(Object.isFrozen(task.steps));
    return { action: 'done', completed: true, evidence: '看见目标任务卡片', reason: '截图显示目标卡片' };
  }, events);
  const started = await svc.start({ goal: 'search for a task', target: 'current' });
  assert(started.ok);
  await until(() => svc.task.status === 'review');
  const typeIndex = events.findIndex(x => x.type === 'native' && x.op === 'type');
  const intentIndex = events.findIndex(x => x.type === 'persist' && x.steps.some(s => s.state === 'intent'));
  assert(intentIndex >= 0 && intentIndex < typeIndex, 'persist intent before the external key input');
  const textPayload = events[typeIndex].payload;
  assert.equal(textPayload.text, 'search phrase', 'fixture current loop must retain immutable task target behavior');
  assert.equal((await svc.accept()).ok, true);
  assert.equal(svc.task.status, 'accepted');
}

async function testDoneWithoutVisibleCompletionPauses() {
  const native = new FakeNative();
  const svc = service(native, async () => ({ action: 'done', completed: false, reason: '截图看不清，无法确认' }));
  assert((await svc.start({ goal: 'check result', target: 'current' })).ok);
  await until(() => svc.task.status === 'paused');
  assert.equal((await svc.accept()).ok, false);
}

async function testWorkBuddyTypePurposeAndCurrentScope() {
  for (const [purpose, expectedRule] of [['navigation', false], ['task', true]]) {
    const native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac' }); let turns = 0;
    const svc = service(native, async () => {
      turns++;
      if (turns === 1) return { action: 'type', purpose, text: purpose === 'navigation' ? 'inbox' : '请检查当前任务进度' };
      return { action: 'done', completed: true, evidence: '任务名称和状态清晰可见' };
    });
    assert((await svc.start({ goal: purpose, target: 'workbuddy' })).ok);
    await until(() => svc.task.status === 'review');
    const type = native.calls.find(x => x.op === 'type');
    assert(type);
    assert.equal(type.payload.text.includes(WECHAT_RULE), expectedRule);
  }
  assert.throws(() => validateAction({ action: 'type', purpose: 'navigation', text: 'x'.repeat(81) }), /80 字/);
  assert.throws(() => validateAction({ action: 'type', purpose: 'navigation', text: 'line\nbreak' }), /单行/);

  const terminal = new FakeNative({ bundleId: 'com.apple.Terminal' });
  const denied = service(terminal, async () => ({ action: 'done', completed: true, evidence: 'n/a' }));
  assert((await denied.start({ goal: 'use the current window', target: 'current' })).ok);
  await until(() => denied.task.status === 'paused');
  assert.equal(terminal.calls.some(x => x.op === 'capture' || x.op === 'type' || x.op === 'key'), false);

  const electron = new FakeNative({ bundleId: 'com.github.Electron' });
  const noFixture = service(electron, async () => ({ action: 'done', completed: true, evidence: 'n/a' }));
  assert((await noFixture.start({ goal: 'current window', target: 'current' })).ok);
  await until(() => noFixture.task.status === 'paused');
  assert.equal(electron.calls.some(x => x.op === 'capture'), false);

  const injected = new FakeNative({ bundleId: 'com.github.Electron' }); injected.app.pid = 456;
  const fixture = service(injected, async () => ({ action: 'done', completed: true, evidence: 'visible fixture result' }), [], { fixturePid: 456 });
  assert((await fixture.start({ goal: 'verify fixture', target: 'current' })).ok);
  await until(() => fixture.task.status === 'review');
}

async function testInsertBackendDelayAndJournal() {
  const events = [], native = new FakeNative({ bundleId: 'com.apple.Notes', events });
  const svc = service(native, async () => ({}), events);
  const realTimeout = global.setTimeout, delays = [];
  global.setTimeout = (fn, ms, ...args) => { delays.push(ms); return realTimeout(fn, ms === 3000 ? 0 : ms, ...args); };
  try { assert.equal((await svc.insert('ordinary text')).ok, true); }
  finally { global.setTimeout = realTimeout; }
  assert(delays.includes(3000), 'the backend owns the required three-second delay');
  const typeIndex = events.findIndex(x => x.type === 'native' && x.op === 'type');
  const intentIndex = events.findIndex(x => x.type === 'persist' && x.steps.some(s => s.state === 'intent'));
  assert(intentIndex >= 0 && intentIndex < typeIndex, 'insert intent is journaled before typing');
  assert.equal(svc.task.steps[0].state, 'input-sent');
  assert(native.calls.every(call => call.timeoutMs <= 10000), 'the native client timeout ceiling is ten seconds');
}

async function testFreeModelIsStrictlyZeroCostAndStubbed() {
  const wb = require('../src/main/workbuddy');
  const original = { request: wb.request, chat: wb.chat };
  let catalog = [{ id: 'hy3', credits: 'x0', supportsImages: true }, { id: 'paid-model', credits: 'x1', supportsImages: true }];
  let calls = [];
  wb.request = async request => { calls.push({ type: 'catalog', request }); return { body: JSON.stringify({ code: 0, data: { models: catalog } }) }; };
  wb.chat = async opts => { calls.push({ type: 'chat', model: opts.model }); return { text: '{"memories":[],"excerpts":[]}' }; };
  const modulePath = require.resolve('../src/main/workbuddy-free');
  const fresh = () => { delete require.cache[modulePath]; return require('../src/main/workbuddy-free'); };
  try {
    const api = fresh();
    assert.equal(await api.freeModel({ vision: true }), 'hy3');
    assert.deepEqual(await api.extractMemories([{ id: 'message-1', role: 'user', content: 'ordinary' }]), { memories: [], excerpts: [] });
    assert(calls.some(x => x.type === 'chat' && x.model === 'hy3'));
    catalog = [{ id: 'paid-model', credits: 'x1', supportsImages: true }];
    const paidOnly = fresh();
    await assert.rejects(paidOnly.freeModel({ vision: true }), /没有确认免费的/);
    assert.equal(calls.filter(x => x.type === 'chat').length, 1, 'paid-only catalog must never trigger a model request');
    catalog = [{ id: 'disabled-free', credits: 'x0', disabled: true, supportsImages: true }];
    await assert.rejects(fresh().freeModel({ vision: true }), /没有确认免费的/);
    assert.equal(calls.filter(x => x.type === 'chat').length, 1);
  } finally {
    wb.request = original.request; wb.chat = original.chat; delete require.cache[modulePath];
  }
}

async function main() {
  const taskType = validateAction({ action: 'type', text: 'hello', purpose: 'task' });
  assert.throws(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: '文件传输助手', confidence: 1, x: 0.05, y: 0.2 }] }), /尚未确认/);
  assert.doesNotThrow(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: '文件传输助手', confidence: 1, x: 0.4, y: 0.08 }] }));
  assert.throws(() => dispatchGuard(taskType, 'workbuddy', { ocr: [{ text: 'Hy3', confidence: 1, x: 0.4, y: 0.9 }, { text: 'x0.05', confidence: 1, x: 0.5, y: 0.9 }] }), /尚未确认/);
  assert.doesNotThrow(() => dispatchGuard(taskType, 'workbuddy', { ocr: [{ text: 'Hy3', confidence: 1, x: 0.4, y: 0.9 }, { text: '限时免费', confidence: 1, x: 0.5, y: 0.9 }] }));
  await testStartRaceAndStopDuringPermission();
  await testStopDuringActivateDoesNotContinue();
  await testWindowMotionAndStaleScreenshot();
  await testJournalBeforeActionScopeAndReview();
  await testDoneWithoutVisibleCompletionPauses();
  await testWorkBuddyTypePurposeAndCurrentScope();
  await testInsertBackendDelayAndJournal();
  await testFreeModelIsStrictlyZeroCostAndStubbed();
  console.log('DesktopService integration checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
