'use strict';

const assert = require('assert/strict');
const { DesktopService, WECHAT_RULE, validateAction, dispatchGuard, analyzeWorkBuddyOCR, selectedFlash, prepareOCR, promptOCR, preflightWorkModel } = require('../src/main/desktop-service');

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
  constructor({ bundleId = 'cn.haminn.workbunny.fixture', permissionsGate, activateGate, moveAfterCapture = false, events = [], modelMenu = false, selectedModel = 'hy3', workBuddyInspection = { available: false }, workBuddyInspectError = false, workBuddyFillError = false, workBuddySendError = false } = {}) {
    this.app = { pid: 123, bundleId, name: 'Fixture' };
    this.rect = { ...rect }; this.permissionsGate = permissionsGate; this.activateGate = activateGate;
    this.moveAfterCapture = moveAfterCapture; this.calls = []; this.cancelled = 0; this.events = events;
    this.modelMenu = modelMenu; this.modelMenuOpen = modelMenu; this.selectedModel = selectedModel;
    this.workBuddyInspection = workBuddyInspection; this.workBuddyInspectError = workBuddyInspectError;
    this.workBuddyFillError = workBuddyFillError; this.workBuddySendError = workBuddySendError;
    this.workBuddyFillResults = [];
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
    if (op === 'recognize') {
      if (this.modelMenu) return this.modelMenuOpen ? { texts: [
        { text: 'Hy3', confidence: 0.95, x: 0.52, y: 0.49, width: 0.06, height: 0.018 }, { text: '0.00x', confidence: 0.95, x: 0.65, y: 0.49, width: 0.03, height: 0.018 },
        { text: 'DeepSeek R1', confidence: 0.92, x: 0.52, y: 0.56, width: 0.1, height: 0.018 }, { text: '配置自定义模型', confidence: 0.94, x: 0.30, y: 0.72, width: 0.12, height: 0.018 },
      ] } : { texts: [this.selectedModel === 'flash' ? { text: 'DeepSeek-V4.1-Flash', confidence: 0.96, x: 0.52, y: 0.49, width: 0.12, height: 0.018 } : { text: '（Hy3', confidence: 0.3, x: 0.52, y: 0.49, width: 0.06, height: 0.018 }] };
      if (this.selectedModel === 'flash') return { texts: [{ text: 'DeepSeek-V4.1-Flash', confidence: 0.96, x: 0.52, y: 0.49, width: 0.12, height: 0.018 }] };
      return { texts: [{ text: 'Hy3', confidence: 1, x: 0.4, y: 0.9 }, { text: '限时免费', confidence: 1, x: 0.5, y: 0.9 }] };
    }
    if (op === 'workbuddyInspect') {
      if (this.workBuddyInspectError) throw new Error('fixture inspect unavailable');
      return this.workBuddyInspection;
    }
    if (op === 'workbuddyFill') {
      if (this.workBuddyFillError) throw new Error('fixture fill uncertainty');
      const result = { filled: true, idempotent: this.workBuddyInspection.draftMatchesRequest === true };
      this.workBuddyFillResults.push(result); return result;
    }
    if (op === 'workbuddySend') {
      if (this.workBuddySendError) throw new Error('fixture send uncertainty');
      return { pressed: true };
    }
    if (op === 'click' && this.modelMenu && this.modelMenuOpen && Math.abs(payload.y - (rect.y + 0.49 * rect.height)) < 20) this.modelMenuOpen = false;
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
  const first = svc.start({ goal: 'fixture task', target: 'current', workModel: 'hy3' });
  const second = await svc.start({ goal: 'duplicate task', target: 'current', workModel: 'hy3' });
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
  const start = await svc.start({ goal: '检查交付状态', target: 'workbuddy', workModel: 'hy3' });
  assert(start.ok);
  await until(() => native.calls.some(x => x.op === 'activate'));
  svc.freeChoice = true; svc.freeChoicePending = true;
  const firstNativeSideEffect = events.findIndex(x => x.type === 'native' && x.op === 'activate');
  const firstJournal = events.findIndex(x => x.type === 'persist');
  assert(firstJournal >= 0 && firstJournal < firstNativeSideEffect, 'task journal must precede application activation');
  await svc.stop('cancel activation');
  gate.resolve();
  await delay(30);
  assert.equal(native.calls.some(x => x.op === 'frontmost' || x.op === 'capture' || x.op === 'click' || x.op === 'type'), false);
  assert.equal(svc.task.status, 'stopped');
  assert.equal(svc.freeChoice, false, 'stop revokes task-scoped model selection proof');
  assert.equal(svc.freeChoicePending, false);
}

async function testWindowMotionAndStaleScreenshot() {
  const moving = new FakeNative({ moveAfterCapture: true });
  const movingService = service(moving, async () => ({ action: 'click', x: 0.5, y: 0.5 }));
  assert((await movingService.start({ goal: 'observe', target: 'current', workModel: 'hy3' })).ok);
  await until(() => movingService.task.status === 'paused');
  assert.equal(moving.calls.some(x => x.op === 'click'), false);

  const native = new FakeNative(); const plannerGate = deferred(); let planned;
  const svc = service(native, async (goal, shot, signal, task) => { planned = { goal, shot, signal, task }; return plannerGate.promise; });
  assert((await svc.start({ goal: 'unchanged goal', target: 'current', workModel: 'hy3' })).ok);
  await until(() => planned);
  assert.equal(planned.goal, 'unchanged goal');
  assert.equal(planned.task.target, 'current');
  native.rect = { ...native.rect, x: native.rect.x + 10 };
  plannerGate.resolve({ action: 'click', x: 0.5, y: 0.5, reason: 'stale screenshot' });
  await until(() => svc.task.status === 'paused');
  assert.equal(native.calls.some(x => x.op === 'click'), false, 'a moved window invalidates the planner screenshot');

  const stopNative = new FakeNative(), stopPlanner = deferred(); let plannerStarted = false;
  const stopService = service(stopNative, async () => { plannerStarted = true; return stopPlanner.promise; });
  assert((await stopService.start({ goal: 'stop before input', target: 'current', workModel: 'hy3' })).ok);
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
  assert((await expiredService.start({ goal: 'expired image', target: 'current', workModel: 'hy3' })).ok);
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
  const started = await svc.start({ goal: 'search for a task', target: 'current', workModel: 'hy3' });
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
  assert((await svc.start({ goal: 'check result', target: 'current', workModel: 'hy3' })).ok);
  await until(() => svc.task.status === 'paused');
  assert.equal((await svc.accept()).ok, false);
}

async function testWorkBuddyTypePurposeAndCurrentScope() {
  for (const [purpose, expectedRule] of [['navigation', false], ['task', true]]) {
    const native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', modelMenu: true }); let turns = 0;
    const originalText = '  请检查当前任务进度\n保留第二行原文  ';
    let sentGoal;
    const svc = service(native, async (goal, shot, _signal, task) => {
      sentGoal = goal;
      turns++;
      if (turns === 1) {
        assert.equal(task.agentGoal, goal, 'the fixed scheduling instruction is part of the immutable task scope');
        assert(Object.isFrozen(task));
        assert.equal(shot.ocr[0].confidence, 0.3, 'closed selector exposes only low-confidence Hy3 button text');
        assert.equal(task.workModel, 'hy3');
        assert.equal(task.thinking, 'low');
        assert.equal(task.taskText, originalText, 'the original user text is carried separately from the fixed UI-agent goal');
        return { action: 'type', purpose, text: purpose === 'navigation' ? 'inbox' : '请检查当前任务进度' };
      }
      return { action: 'done', completed: true, evidence: '任务名称和状态清晰可见' };
    });
    assert((await svc.start({ goal: originalText, target: 'workbuddy', workModel: 'hy3' })).ok);
    await until(() => svc.task.status === 'review');
    const type = native.calls.find(x => x.op === 'type');
    assert(type);
    assert.equal(native.calls.filter(x => x.op === 'click').length, 1, 'the service clicks the unique free Hy3 row center before planning input');
    if (purpose === 'task') {
      assert.equal(type.payload.text, originalText + '\n\n' + WECHAT_RULE, 'task typing is replaced by the exact original WorkBuddy request');
      assert.match(sentGoal, /在 WorkBuddy 新建对话/);
      assert.doesNotMatch(sentGoal, /请检查当前任务进度/);
    } else assert.equal(type.payload.text.includes(WECHAT_RULE), expectedRule);
  }

  const duplicateNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', modelMenu: true });
  let duplicateTurn = 0;
  const duplicate = service(duplicateNative, async () => ++duplicateTurn <= 2
    ? { action: 'type', purpose: 'task', text: 'rewritten planner output' }
    : { action: 'done', completed: true, evidence: '这不应被执行' });
  const duplicateText = '交给 WorkBuddy 的唯一原文';
  assert((await duplicate.start({ goal: duplicateText, target: 'workbuddy', workModel: 'hy3' })).ok);
  await until(() => duplicate.task.status === 'paused');
  assert.equal(duplicateNative.calls.filter(x => x.op === 'type').length, 1, 'a second WorkBuddy task type is blocked in the same run');
  assert.equal(duplicateNative.calls.find(x => x.op === 'type').payload.text, duplicateText + '\n\n' + WECHAT_RULE);
  assert.throws(() => validateAction({ action: 'type', purpose: 'navigation', text: 'x'.repeat(81) }), /80 字/);
  assert.throws(() => validateAction({ action: 'type', purpose: 'navigation', text: 'line\nbreak' }), /单行/);

  let wechatPlannerGoal;
  const wechatScope = Object.freeze({ id: 'wechat-goal', goal: '微信原始目标', taskText: '微信原始目标', agentGoal: '微信原始目标', target: 'wechat', workModel: 'hy3', thinking: 'low', startedAt: Date.now() });
  await service(new FakeNative(), async goal => { wechatPlannerGoal = goal; return { action: 'done', completed: false, reason: 'fixture' }; })
    .nextAction(wechatScope, { ocr: [], preview: 'data:image/png;base64,AA==' }, new AbortController().signal);
  assert.equal(wechatPlannerGoal, '微信原始目标', 'the WeChat visual goal remains unchanged');

  const terminal = new FakeNative({ bundleId: 'com.apple.Terminal' });
  const denied = service(terminal, async () => ({ action: 'done', completed: true, evidence: 'n/a' }));
  assert((await denied.start({ goal: 'use the current window', target: 'current', workModel: 'hy3' })).ok);
  await until(() => denied.task.status === 'paused');
  assert.equal(terminal.calls.some(x => x.op === 'capture' || x.op === 'type' || x.op === 'key'), false);

  const electron = new FakeNative({ bundleId: 'com.github.Electron' });
  const noFixture = service(electron, async () => ({ action: 'done', completed: true, evidence: 'n/a' }));
  assert((await noFixture.start({ goal: 'current window', target: 'current', workModel: 'hy3' })).ok);
  await until(() => noFixture.task.status === 'paused');
  assert.equal(electron.calls.some(x => x.op === 'capture'), false);

  const injected = new FakeNative({ bundleId: 'com.github.Electron' }); injected.app.pid = 456;
  const fixture = service(injected, async () => ({ action: 'done', completed: true, evidence: 'visible fixture result' }), [], { fixturePid: 456 });
  assert((await fixture.start({ goal: 'verify fixture', target: 'current', workModel: 'hy3' })).ok);
  await until(() => fixture.task.status === 'review');
}

async function testWorkBuddyFlashProfile() {
  const native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash' });
  let turns = 0;
  const svc = service(native, async (_goal, _shot, _signal, task) => {
    assert.equal(task.workModel, 'deepseek-v4.1-flash'); assert.equal(task.thinking, 'high');
    if (++turns === 1) return { action: 'type', text: '请检查当前任务进度' };
    return { action: 'done', completed: true, evidence: '任务状态可见' };
  });
  assert((await svc.start({ goal: 'flash fixture task', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => svc.task.status === 'review');
  assert.equal(native.calls.filter(call => call.op === 'click').length, 0, 'Flash profile does not run the Hy3 chooser');
  assert(native.calls.some(call => call.op === 'type'));
  assert.equal(svc.task.workModel, 'deepseek-v4.1-flash'); assert.equal(svc.task.thinking, 'high');

  const defaultSvc = service(new FakeNative(), async () => ({ action: 'done', completed: true, evidence: 'fixture result' }));
  assert.equal((await defaultSvc.start({ goal: 'default profile', target: 'current' })).ok, true);
  assert.equal(defaultSvc.task.workModel, 'deepseek-v4.1-flash'); assert.equal(defaultSvc.task.thinking, 'high');
  await until(() => defaultSvc.task.status === 'review');
  assert.equal((await defaultSvc.start({ goal: 'invalid profile', target: 'current', workModel: 'deepseek-v4-pro' })).ok, false);
}

async function testWorkBuddyAXHandoff() {
  const events = [];
  const native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash', events,
    workBuddyInspection: { available: true, editorCount: 1, draftEmpty: true, selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: false, homeReady: true } });
  const userText = '请在 WorkBuddy 中完成这项工作，保留原文。';
  let plannerCalls = 0;
  const svc = service(native, async (goal, _shot, _signal, task) => {
    plannerCalls++;
    assert(task.handoffSent);
    assert.match(goal, /只观察已经提交的 WorkBuddy 会话/);
    assert.equal(task.taskText, userText);
    assert.equal(task.submittedAt, svc.task.submittedAt);
    return { action: 'done', completed: true, evidence: 'WorkBuddy 回复在当前对话中可见' };
  }, events);
  assert((await svc.start({ goal: userText, target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => svc.task.status === 'review');
  const fillCall = native.calls.find(call => call.op === 'workbuddyFill');
  const sendCall = native.calls.find(call => call.op === 'workbuddySend');
  assert(fillCall && sendCall, 'ready Flash editor uses the dedicated fill and send path');
  assert.equal(fillCall.payload.text, userText + '\n\n' + WECHAT_RULE, 'fast path sends exact user text plus the existing safety policy');
  assert.equal(fillCall.payload.model, 'deepseek-v4.1-flash');
  assert.deepEqual(fillCall.payload.expected, { bundleId: 'com.tencent.workbuddy.mac', pid: 234 });
  assert.equal(fillCall.payload.windowId, 7);
  assert.deepEqual(sendCall.payload.text, fillCall.payload.text);
  assert.equal(svc.task.draftInserted, true);
  assert.equal(svc.task.handoffSent, true);
  assert(Number.isFinite(svc.task.submittedAt));
  assert.equal(plannerCalls, 1, 'planner resumes only after the handoff, to observe the reply');
  assert.equal(native.calls.filter(call => call.op === 'capture').length, 3, 'fresh screenshot is captured after filling and another observes the reply');
  assert.equal(native.calls.some(call => ['type', 'click', 'key'].includes(call.op)), false, 'fast path does not replay visual UI input');
  const inspect = native.calls.find(call => call.op === 'workbuddyInspect');
  assert.equal(inspect.payload.text, userText + '\n\n' + WECHAT_RULE, 'Inspect compares against the exact same outbound payload');
  assert.deepEqual(inspect.payload.expected, fillCall.payload.expected);
  const fillIntent = events.findIndex(event => event.type === 'persist' && event.steps.some(step => step.action === 'workbuddyFill' && step.state === 'intent'));
  const fillIndex = events.findIndex(event => event.type === 'native' && event.op === 'workbuddyFill');
  const sendIntent = events.findIndex(event => event.type === 'persist' && event.steps.some(step => step.action === 'workbuddySend' && step.state === 'intent'));
  const sendIndex = events.findIndex(event => event.type === 'native' && event.op === 'workbuddySend');
  const secondCapture = events.map((event, i) => event.type === 'native' && event.op === 'capture' ? i : -1).filter(i => i >= 0)[1];
  assert(fillIntent >= 0 && fillIntent < fillIndex, 'fill intent is journaled before the native fill');
  assert(fillIndex < secondCapture && secondCapture < sendIntent && sendIntent < sendIndex, 'fresh capture and send intent precede native send');

  for (const fail of ['fill', 'send']) {
    const badNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash',
      workBuddyInspection: { available: true, editorCount: 1, draftEmpty: true, selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: true, homeReady: true },
      workBuddyFillError: fail === 'fill', workBuddySendError: fail === 'send' });
    let fallbackCalls = 0;
    const badSvc = service(badNative, async () => { fallbackCalls++; return { action: 'type', text: 'must not retry' }; });
    assert((await badSvc.start({ goal: '保持失败不重放', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
    await until(() => badSvc.task.status === 'paused');
    assert.equal(badNative.calls.filter(call => call.op === 'workbuddyFill').length, 1);
    assert.equal(badNative.calls.filter(call => call.op === 'workbuddySend').length, fail === 'send' ? 1 : 0);
    assert.equal(badNative.calls.some(call => ['type', 'click', 'key'].includes(call.op)), false, `${fail} failure cannot downgrade into visual replay`);
    assert.equal(fallbackCalls, 0);
    if (fail === 'send') assert.equal(badSvc.task.draftInserted, true, 'a failed send leaves the already filled draft intact');
    assert.equal(badSvc.task.submittedAt, undefined, 'unconfirmed send is not marked submitted');
  }

  const occupiedNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash',
    workBuddyInspection: { available: true, editorCount: 1, draftEmpty: false, selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: true, homeReady: true } });
  let occupiedPlanner = 0;
  const occupiedSvc = service(occupiedNative, async () => { occupiedPlanner++; return { action: 'done', completed: false, reason: 'unreachable' }; });
  assert((await occupiedSvc.start({ goal: '不要覆盖已有草稿', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => occupiedSvc.task.status === 'paused');
  assert.equal(occupiedNative.calls.some(call => ['workbuddyFill', 'workbuddySend', 'type'].includes(call.op)), false);
  assert.equal(occupiedPlanner, 0, 'an existing nonempty draft pauses instead of falling back to visual typing');

  const sameText = '同一条已写入草稿';
  const matchingNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash',
    workBuddyInspection: { available: true, editorCount: 1, draftEmpty: false, draftMatchesRequest: true, selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: true, homeReady: true } });
  const matchingSvc = service(matchingNative, async (_goal, _shot, _signal, task) => {
    assert(task.handoffSent);
    return { action: 'done', completed: true, evidence: 'WorkBuddy 回复可见' };
  });
  assert((await matchingSvc.start({ goal: sameText, target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => matchingSvc.task.status === 'review');
  assert.deepEqual(matchingNative.workBuddyFillResults, [{ filled: true, idempotent: true }], 'native fill takes the idempotent path for the exact same draft');
  assert.equal(matchingNative.calls.find(call => call.op === 'workbuddyInspect')?.payload.text, sameText + '\n\n' + WECHAT_RULE);
  assert.equal(matchingNative.calls.find(call => call.op === 'workbuddyFill')?.payload.text, sameText + '\n\n' + WECHAT_RULE);
  assert.equal(matchingNative.calls.find(call => call.op === 'workbuddySend')?.payload.text, sameText + '\n\n' + WECHAT_RULE);
  assert.equal(matchingNative.calls.some(call => ['type', 'click', 'key'].includes(call.op)), false, 'an exact pre-existing draft is sent without visual retyping');

  const inspectFailureNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash', workBuddyInspectError: true });
  let visualFallback = 0;
  const inspectFailureSvc = service(inspectFailureNative, async () => { visualFallback++; return { action: 'done', completed: false, reason: 'fixture fallback' }; });
  assert((await inspectFailureSvc.start({ goal: '视觉回退', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => inspectFailureSvc.task.status === 'paused');
  assert.equal(visualFallback, 1, 'read-only inspect failure falls back to the existing visual flow');
  assert.equal(inspectFailureNative.calls.some(call => ['workbuddyFill', 'workbuddySend'].includes(call.op)), false);
}

async function testFlashGuardPreflightAndBrainRequest() {
  const type = validateAction({ action: 'type', text: 'fixture input' });
  const flashOCR = { ocr: [{ text: 'DeepSeek-V4.1-Flash', confidence: 0.96, x: 0.4, y: 0.49, width: 0.14, height: 0.02 }] };
  assert.equal(selectedFlash(flashOCR.ocr), true);
  assert.equal(selectedFlash([...flashOCR.ocr, { ...flashOCR.ocr[0], text: '（DeepSeek-V4.1-Flash）', x: 0.401, confidence: 0.7 }]), true, 'overlapping OCR passes count as one Flash label');
  assert.doesNotThrow(() => dispatchGuard(type, 'workbuddy', flashOCR, false, 'deepseek-v4.1-flash'));
  for (const label of ['DeepSeek-V4.1-Pro', 'DeepSeek-V4.1', 'DeepSeek-V4.1-Flash-Pro', 'DeepSeek-V4.1-Fla']) {
    const shot = { ocr: [{ ...flashOCR.ocr[0], text: label }] };
    assert.equal(selectedFlash(shot.ocr), false, `${label} is not the exact authorized Flash model`);
    assert.throws(() => dispatchGuard(type, 'workbuddy', shot, false, 'deepseek-v4.1-flash'), /未能确认/);
  }
  assert.throws(() => dispatchGuard(type, 'workbuddy', { ocr: [{ ...flashOCR.ocr[0], confidence: 0.3 }] }, false, 'deepseek-v4.1-flash'), /未能确认/);
  assert.throws(() => dispatchGuard(type, 'workbuddy', { ocr: [...flashOCR.ocr, { text: 'Hy3', confidence: 0.95, x: 0.5, y: 0.6, width: 0.05, height: 0.02 }] }, false, 'deepseek-v4.1-flash'), /菜单仍打开/);

  const wb = require('../src/main/workbuddy');
  const oldRequest = wb.request, oldChat = wb.chat;
  try {
    wb.request = async () => ({ body: JSON.stringify({ code: 0, data: { models: [
      { id: 'deepseek-v4.1-flash', credits: 'x0.11', supportsImages: true, supportsReasoning: true },
      { id: 'deepseek-v4.1-pro', credits: 'x0.20', supportsImages: true, supportsReasoning: true },
    ] } }) });
    assert.equal(await preflightWorkModel('deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
    wb.request = async () => ({ body: JSON.stringify({ code: 0, data: { models: [{ id: 'deepseek-v4.1-pro', credits: 'x0.20', supportsImages: true, supportsReasoning: true }] } }) });
    await assert.rejects(preflightWorkModel('deepseek-v4.1-flash'), /未确认/);

    const requests = [];
    wb.chat = async options => { requests.push(options); return { text: '{"action":"done","completed":true,"evidence":"visible result"}', model: options.model }; };
    const svc = service(new FakeNative(), undefined);
    await svc.nextAction({ id: 't', goal: 'fixture', taskText: '交给 WorkBuddy 的原文', agentGoal: '在 WorkBuddy 新建对话并传递 taskText 原文', target: 'workbuddy', workModel: 'deepseek-v4.1-flash', thinking: 'high', startedAt: Date.now() }, { ocr: [], preview: 'data:image/png;base64,AA==' }, new AbortController().signal);
    assert.equal(requests[0].model, 'deepseek-v4.1-flash'); assert.equal(requests[0].thinking, 'high');
    const taskPayload = JSON.parse(requests[0].messages[1].content[0].text);
    assert.equal(taskPayload.taskText, '交给 WorkBuddy 的原文');
    assert.match(taskPayload.goal, /在 WorkBuddy 新建对话/);
    assert.equal(taskPayload.executionModelVerified, false);
    assert.equal(Object.hasOwn(taskPayload, 'freeModelVerified'), false, 'Flash requests do not carry a Hy3 free-model field');
    assert.match(taskPayload.taskGoalSemantics, /目标应用中执行操作/);
    assert.match(requests[0].messages[0].content, /上一动作刚聚焦同一输入框/);

    const repairCalls = [];
    wb.chat = async options => {
      repairCalls.push(options);
      return { text: repairCalls.length === 1 ? 'secret malformed response must not be repeated' : '{"action":"type","text":"目标文字"}', model: options.model };
    };
    const repaired = await svc.nextAction({ id: 't', goal: '只回复目标文字', target: 'workbuddy', workModel: 'deepseek-v4.1-flash', thinking: 'high', startedAt: Date.now() }, { ocr: [], preview: 'data:image/png;base64,AA==' }, new AbortController().signal);
    assert.equal(repaired.action, 'type'); assert.equal(repairCalls.length, 2, 'a malformed planner response gets exactly one pre-action repair request');
    const repairText = repairCalls[1].messages.at(-1).content;
    assert.match(repairText, /未通过桌面动作 JSON 结构校验/);
    assert.doesNotMatch(repairText, /secret malformed/ , 'repair prompt does not echo malformed model output');

    const abortCalls = [];
    const controller = new AbortController();
    wb.chat = async options => { abortCalls.push(options); controller.abort(); return { text: 'not json', model: options.model }; };
    await assert.rejects(svc.nextAction({ id: 't', goal: 'fixture', target: 'workbuddy', workModel: 'deepseek-v4.1-flash', thinking: 'high', startedAt: Date.now() }, { ocr: [], preview: 'data:image/png;base64,AA==' }, controller.signal), /任务已停止/);
    assert.equal(abortCalls.length, 1, 'stop signal prevents the format repair call');

    const invalidCalls = [];
    wb.chat = async options => { invalidCalls.push(options); return { text: 'not json', model: options.model }; };
    await assert.rejects(svc.nextAction({ id: 't', goal: 'fixture', target: 'workbuddy', workModel: 'deepseek-v4.1-flash', thinking: 'high', startedAt: Date.now() }, { ocr: [], preview: 'data:image/png;base64,AA==' }, new AbortController().signal), /连续两次未返回有效/);
    assert.equal(invalidCalls.length, 2, 'two invalid planner responses pause before any action');
    wb.request = async () => ({ body: JSON.stringify({ code: 0, data: { models: [
      { id: 'deepseek-v4.1-flash', credits: 'x0.11', supportsImages: true, supportsReasoning: true },
    ] } }) });
    const runNative = new FakeNative();
    const runSvc = service(runNative, undefined);
    assert((await runSvc.start({ goal: 'fixture', target: 'current', workModel: 'deepseek-v4.1-flash' })).ok);
    await until(() => runSvc.task.status === 'paused');
    assert.equal(invalidCalls.length, 4, 'a running task pauses after exactly two invalid planner responses');
    assert.equal(runNative.calls.some(call => ['click', 'type', 'key', 'scroll'].includes(call.op)), false, 'invalid outputs never dispatch an action');
    wb.chat = async options => ({ text: '{"action":"done","completed":true,"evidence":"wrong model"}', model: 'deepseek-v4.1-pro' });
    await assert.rejects(svc.nextAction({ id: 't', goal: 'fixture', target: 'workbuddy', workModel: 'deepseek-v4.1-flash', thinking: 'high', startedAt: Date.now() }, { ocr: [], preview: 'data:image/png;base64,AA==' }, new AbortController().signal), /模型与所选/);
  } finally { wb.request = oldRequest; wb.chat = oldChat; }
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

async function testFreeChoiceProofLifecycle() {
  const svc = service(new FakeNative(), async () => ({ action: 'done', completed: true, evidence: '截图可见结果' }));
  svc.freeChoice = true; svc.freeChoicePending = true;
  const started = await svc.start({ goal: 'new fixture task', target: 'current', workModel: 'hy3' });
  assert(started.ok);
  assert.equal(svc.freeChoice, false, 'a new task starts without prior model proof');
  assert.equal(svc.freeChoicePending, false);
  await until(() => svc.task.status === 'review');
  svc.freeChoice = true; svc.freeChoicePending = true;
  await svc.close();
  assert.equal(svc.freeChoice, false, 'close revokes model proof');
  assert.equal(svc.freeChoicePending, false);
}

async function main() {
  const taskType = validateAction({ action: 'type', text: 'hello', purpose: 'task' });
  assert.throws(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: '文件传输助手', confidence: 1, x: 0.05, y: 0.2 }] }), /尚未确认/);
  assert.doesNotThrow(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: '文件传输助手', confidence: 1, x: 0.4, y: 0.08 }] }));
  const closedFree = { ocr: [{ text: 'Hy3', confidence: 0.95, x: 0.4, y: 0.49, width: 0.06, height: 0.018 }, { text: '0.00x', confidence: 0.95, x: 0.52, y: 0.49, width: 0.03, height: 0.018 }] };
  assert.doesNotThrow(() => dispatchGuard(taskType, 'workbuddy', closedFree), 'an explicit same-line selected free badge is sufficient');
  assert.doesNotThrow(() => dispatchGuard(taskType, 'workbuddy', { ocr: [{ text: '（Hy3 0.00x）', confidence: 0.95, x: 0.4, y: 0.49, width: 0.1, height: 0.018 }] }), 'combined OCR labels preserve an explicit free badge');
  for (const text of ['Hy3-x', 'Hy3-X', 'Hy3 preview', 'Hy3-Preview']) {
    assert.throws(() => dispatchGuard(taskType, 'workbuddy', { ocr: [{ text, confidence: 0.98, x: 0.4, y: 0.49, width: 0.08, height: 0.018 }, { text: '0.00x', confidence: 0.98, x: 0.52, y: 0.49, width: 0.03, height: 0.018 }] }), /尚未确认/, `${text} must not certify Hy3`);
  }
  assert.throws(() => dispatchGuard(taskType, 'workbuddy', { ocr: [{ text: 'Hy3', confidence: 0.98, x: 0.4, y: 0.49, width: 0.06, height: 0.016 }, { text: '0.00x', confidence: 0.98, x: 0.52, y: 0.513, width: 0.03, height: 0.016 }] }), /尚未确认/, 'adjacent model rows are not the same OCR line');
  const menuOCR = [
    { text: 'Hy3', confidence: 0.95, x: 0.52, y: 0.49, width: 0.06, height: 0.018 }, { text: '0.00x', confidence: 0.95, x: 0.65, y: 0.49, width: 0.03, height: 0.018 },
    { text: 'DeepSeek R1', confidence: 0.92, x: 0.52, y: 0.56, width: 0.10, height: 0.018 }, { text: '配置自定义模型', confidence: 0.94, x: 0.30, y: 0.72, width: 0.12, height: 0.018 },
  ];
  assert.equal(analyzeWorkBuddyOCR(menuOCR).menuOpen, true, 'model menu is identified by candidates/config label');
  assert.throws(() => dispatchGuard(taskType, 'workbuddy', { ocr: menuOCR }, true), /菜单仍打开/);
  assert.equal(dispatchGuard({ action: 'click', x: 0.55, y: 0.499 }, 'workbuddy', { ocr: menuOCR }).freeChoiceClick, true);
  assert.equal(dispatchGuard({ action: 'click', x: 0.55, y: 0.56 }, 'workbuddy', { ocr: menuOCR }).freeChoiceClick, false, 'clicking a different row cannot certify Hy3');
  assert.equal(dispatchGuard({ action: 'click', x: 0.55, y: 0.515 }, 'workbuddy', { ocr: menuOCR }).freeChoiceClick, false, 'click just below the OCR text box cannot certify the row');
  const repeatedHy3 = analyzeWorkBuddyOCR([
    { text: 'Hy3', confidence: 0.7, x: 0.744, y: 0.4837, width: 0.0305, height: 0.0196 },
    { text: '②Hy3~', confidence: 0.3, x: 0.7445, y: 0.484, width: 0.0305, height: 0.0196 },
  ]);
  assert.equal(repeatedHy3.selectedHy3, true, 'overlapping OCR passes count as one physical Hy3 selector label');
  const lowConfidenceMenu = [
    { text: 'Hy3曾限时免费', confidence: 0.3, x: 0.6192, y: 0.2355, width: 0.0596, height: 0.0194 },
    { text: 'Hy4 preview夜间免费', confidence: 0.3, x: 0.61, y: 0.20, width: 0.1, height: 0.0194 },
    { text: 'Step-5-Preview独家限免', confidence: 0.3, x: 0.61, y: 0.2707, width: 0.1, height: 0.0194 },
    { text: 'GLM-5.3订阅优先', confidence: 0.3, x: 0.61, y: 0.3837, width: 0.1, height: 0.0194 },
    { text: '配置自定义模型', confidence: 0.3, x: 0.61, y: 0.4323, width: 0.1, height: 0.0194 },
    { text: '0.29X', confidence: 0.3, x: 0.7413, y: 0.20, width: 0.0189, height: 0.0194 },
  ];
  const lowMenuAnalysis = analyzeWorkBuddyOCR(lowConfidenceMenu);
  assert.equal(lowMenuAnalysis.menuOpen, true, 'low-confidence candidate menu still blocks task input');
  assert.equal(lowMenuAnalysis.freeRows.length, 0, 'low-confidence Hy3 and price cannot authorize a free selection');
  const manyRows = Array.from({ length: 450 }, (_, i) => ({ text: `ordinary line ${i}`, confidence: 0.2, x: 0.1, y: i / 500, width: 0.3, height: 0.008 }));
  manyRows.push({ text: 'Hy3', confidence: 0.99, x: 0.6192, y: 0.2355, width: 0.0596, height: 0.0194 },
    { text: '②Hy3~', confidence: 0.3, x: 0.6195, y: 0.2356, width: 0.0596, height: 0.0194 },
    { text: '0.00x', confidence: 0.99, x: 0.7413, y: 0.2355, width: 0.0189, height: 0.0194 });
  const localOCR = prepareOCR(manyRows, 400);
  assert(localOCR.length <= 400 && localOCR.some(row => row.text === 'Hy3') && localOCR.some(row => row.text === '0.00x'), 'important OCR appended after the first 100 is retained locally');
  assert.equal(analyzeWorkBuddyOCR(localOCR).selectedHy3, true, 'overlapping ROI labels are compacted to one physical selector');
  assert(promptOCR(manyRows, 100).some(row => row.text === 'Hy3'), 'prompt OCR prioritizes the free-model evidence');
  const lowConfidenceButton = { ocr: [{ text: '（Hy3', confidence: 0.3, x: 0.52, y: 0.49 }] };
  assert.throws(() => dispatchGuard(taskType, 'workbuddy', lowConfidenceButton), /尚未确认/);
  assert.doesNotThrow(() => dispatchGuard(taskType, 'workbuddy', lowConfidenceButton, true), 'low-confidence closed selector label is accepted only with task proof');
  assert.throws(() => dispatchGuard(taskType, 'workbuddy', { ocr: [{ text: 'Hy3 is mentioned here', confidence: 0.3, x: 0.52, y: 0.49 }] }, true), /尚未确认/);
  assert.doesNotThrow(() => dispatchGuard(taskType, 'workbuddy', { ocr: [{ text: '②Hy3~', confidence: 0.3, x: 0.744, y: 0.4837, w: 0.0305 }] }, true), 'the task proof accepts the wrapped current-selector label');
  await testStartRaceAndStopDuringPermission();
  await testStopDuringActivateDoesNotContinue();
  await testWindowMotionAndStaleScreenshot();
  await testJournalBeforeActionScopeAndReview();
  await testDoneWithoutVisibleCompletionPauses();
  await testWorkBuddyTypePurposeAndCurrentScope();
  await testWorkBuddyFlashProfile();
  await testWorkBuddyAXHandoff();
  await testFlashGuardPreflightAndBrainRequest();
  await testInsertBackendDelayAndJournal();
  await testFreeModelIsStrictlyZeroCostAndStubbed();
  await testFreeChoiceProofLifecycle();
  console.log('DesktopService integration checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
