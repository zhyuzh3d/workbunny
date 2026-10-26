'use strict';

const assert = require('assert/strict');
const { DesktopService, WECHAT_RULE, validateAction, dispatchGuard, analyzeWorkBuddyOCR, selectedFlash, prepareOCR, promptOCR, preflightWorkModel,
  WORKBUDDY_TEXT_UTF16_LIMIT, workBuddyTextWithinLimit, validateWorkBuddyOutbound, makeWorkBuddyOutbound } = require('../src/main/desktop-service');
const { Monitor } = require('../src/main/monitor');
const { observeWorkBuddy } = require('../src/main/workbuddy-observation');
const { ContactDirectory, createContactDirectory } = require('../src/main/contact-directory');
const { GuiLease } = require('../src/main/gui-lease');

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
  constructor({ bundleId = 'cn.haminn.workbunny.fixture', permissionsGate, activateGate, clickGate, clickBehavior, moveAfterCapture = false, capturePNG, recognizedTexts, events = [], modelMenu = false, selectedModel = 'hy3', workBuddyInspection = { available: false }, workBuddyConversationInspection = null, workBuddyInspectError = false, workBuddyFillError = false, workBuddySendError = false } = {}) {
    this.app = { pid: 123, bundleId, name: 'Fixture' };
    this.rect = { ...rect }; this.permissionsGate = permissionsGate; this.activateGate = activateGate;
    this.moveAfterCapture = moveAfterCapture; this.capturePNG = capturePNG || Buffer.from('test-image'); this.calls = []; this.cancelled = 0; this.events = events;
    this.clickGate = clickGate; this.clickBehavior = clickBehavior; this.recognizedTexts = recognizedTexts;
    this.modelMenu = modelMenu; this.modelMenuOpen = modelMenu; this.selectedModel = selectedModel;
    this.workBuddyInspection = workBuddyInspection; this.workBuddyInspectError = workBuddyInspectError;
    this.workBuddyConversationInspection = workBuddyConversationInspection;
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
      return { pngBase64: this.capturePNG.toString('base64'), desktopRect };
    }
    if (op === 'recognize') {
      if (typeof this.recognizedTexts === 'function') return { texts: this.recognizedTexts(this.calls.filter(call => call.op === 'recognize').length - 1) };
      if (this.recognizedTexts) return { texts: this.recognizedTexts };
      if (this.modelMenu) return this.modelMenuOpen ? { texts: [
        { text: 'Hy3', confidence: 0.95, x: 0.52, y: 0.49, width: 0.06, height: 0.018 }, { text: '0.00x', confidence: 0.95, x: 0.65, y: 0.49, width: 0.03, height: 0.018 },
        { text: 'DeepSeek R1', confidence: 0.92, x: 0.52, y: 0.56, width: 0.1, height: 0.018 }, { text: '配置自定义模型', confidence: 0.94, x: 0.30, y: 0.72, width: 0.12, height: 0.018 },
      ] } : { texts: [this.selectedModel === 'flash' ? { text: 'DeepSeek-V4.1-Flash', confidence: 0.96, x: 0.52, y: 0.49, width: 0.12, height: 0.018 } : { text: '（Hy3', confidence: 0.3, x: 0.52, y: 0.49, width: 0.06, height: 0.018 }] };
      if (this.selectedModel === 'flash') return { texts: [{ text: 'DeepSeek-V4.1-Flash', confidence: 0.96, x: 0.52, y: 0.49, width: 0.12, height: 0.018 }] };
      return { texts: [{ text: 'Hy3', confidence: 1, x: 0.4, y: 0.9 }, { text: '限时免费', confidence: 1, x: 0.5, y: 0.9 }] };
    }
    if (op === 'workbuddyInspect') {
      if (this.workBuddyInspectError) throw new Error('fixture inspect unavailable');
      return payload.mode === 'conversation' ? (this.workBuddyConversationInspection || this.workBuddyInspection) : this.workBuddyInspection;
    }
    if (op === 'workbuddyFill') {
      if (this.workBuddyFillError) throw new Error('fixture fill uncertainty');
      const inspected = payload.mode === 'conversation' ? (this.workBuddyConversationInspection || this.workBuddyInspection) : this.workBuddyInspection;
      const result = { filled: true, idempotent: inspected.draftMatchesRequest === true };
      if (payload.mode === 'conversation' && this.workBuddyConversationInspection) Object.assign(this.workBuddyConversationInspection, { draftEmpty: false, draftMatchesRequest: true, sendEnabled: true });
      this.workBuddyFillResults.push(result); return result;
    }
    if (op === 'workbuddySend') {
      if (this.workBuddySendError) throw new Error('fixture send uncertainty');
      return { pressed: true };
    }
    if (op === 'click') {
      if (this.clickGate) await this.clickGate.promise;
      if (this.clickBehavior) this.clickBehavior(this, payload);
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

async function testTypeCanFocusAndInputUnderSameScreenshotGuards() {
  const focusType = validateAction({ action: 'type', text: 'hello Alice', purpose: 'task', focus: { x: 0.45, y: 0.9 } });
  assert.deepEqual(focusType.focus, { x: 0.45, y: 0.9 });
  for (const focus of [{ x: -0.01, y: 0.9 }, { x: 1, y: 0.5 }, { x: 0.5, y: NaN }, { x: '0.5', y: 0.7 }, { x: 0.5, y: 0.8, extra: true }, [], null]) {
    assert.throws(() => validateAction({ action: 'type', text: 'hello', focus }), /focus 必须包含截图归一化坐标/u);
  }

  const header = [{ text: 'Alice', confidence: 0.98, x: 0.4, y: 0.08, width: 0.08, height: 0.02 }];
  assert.throws(() => dispatchGuard(focusType, 'wechat', { ocr: [{ ...header[0], text: 'Bob' }] }, false, 'hy3', 'Alice'), /尚未确认/u,
    'focus does not bypass the screenshot recipient title guard');
  assert.throws(() => dispatchGuard({ ...focusType, focus: { x: 0.5, y: 0.4 } }, 'wechat', { ocr: header }, false, 'hy3', 'Alice'), /下方编辑区域/u,
    'focus cannot target the conversation body or header');
  const events = [];
  const native = new FakeNative({ recognizedTexts: header });
  const svc = service(native, async (_goal, _shot, _signal, task) => task.steps.some(step => step.action === 'type')
    ? { action: 'done', completed: true, evidence: '可见目标消息已发出' }
    : { action: 'type', text: 'hello Alice', purpose: 'task', focus: { x: 0.45, y: 0.9 } }, events);
  assert((await svc.start({ goal: '给 Alice 发问候', target: 'wechat', recipient: 'Alice', workModel: 'hy3' })).ok);
  await until(() => svc.task.status === 'review');
  const clickIndex = native.calls.findIndex(call => call.op === 'click');
  const typeIndex = native.calls.findIndex(call => call.op === 'type');
  const recheckIndex = native.calls.findIndex((call, index) => index > clickIndex && call.op === 'frontmost');
  assert(clickIndex >= 0 && clickIndex < recheckIndex && recheckIndex < typeIndex,
    'combined focus click rechecks the current foreground/window before any text event');
  assert.equal(native.calls[clickIndex].payload.x, 370);
  assert.equal(native.calls[clickIndex].payload.y, 560);
  assert.equal('focus' in native.calls[typeIndex].payload, false, 'focus is a service-level gesture, not forwarded as a native command');
  const typeStep = svc.task.steps.find(step => step.action === 'type');
  assert.deepEqual(typeStep.focus, { x: 0.45, y: 0.9 }, 'journal keeps normalized focus coordinates for diagnosis');
  assert.equal('text' in typeStep, false, 'action journal never stores input text');
  await svc.close();

  const movedNative = new FakeNative({ recognizedTexts: header, clickBehavior: current => { current.rect = { ...current.rect, x: current.rect.x + 4 }; } });
  const movedSvc = service(movedNative, async () => ({ action: 'type', text: 'hello Alice', purpose: 'task', focus: { x: 0.45, y: 0.9 } }));
  assert((await movedSvc.start({ goal: '给 Alice 发问候', target: 'wechat', recipient: 'Alice', workModel: 'hy3' })).ok);
  await until(() => movedSvc.task.status === 'paused');
  assert(movedNative.calls.some(call => call.op === 'click'));
  assert.equal(movedNative.calls.some(call => call.op === 'type'), false, 'frame change after focus click pauses before typing');
  await movedSvc.close();

  const clickGate = deferred(), stoppedNative = new FakeNative({ recognizedTexts: header, clickGate });
  const stoppedSvc = service(stoppedNative, async () => ({ action: 'type', text: 'hello Alice', purpose: 'task', focus: { x: 0.45, y: 0.9 } }));
  assert((await stoppedSvc.start({ goal: '给 Alice 发问候', target: 'wechat', recipient: 'Alice', workModel: 'hy3' })).ok);
  await until(() => stoppedNative.calls.some(call => call.op === 'click'));
  await stoppedSvc.stop('focus click canceled');
  clickGate.resolve();
  await delay(30);
  assert.equal(stoppedNative.calls.some(call => call.op === 'type'), false, 'stop after the click invalidates the pending type event');
  await stoppedSvc.close();
}

async function testJPEGPreviewKeepsPNGForLargeImageOCR() {
  const original = Buffer.alloc(8 * 1024 * 1024 + 1, 0x5a);
  const scaledPNG = Buffer.from('scaled-png-for-vision');
  const previewJPEG = Buffer.from('compressed-jpeg-preview');
  const native = new FakeNative({ capturePNG: original });
  const svc = new DesktopService({ native, planner: async () => ({ action: 'wait' }), imageResize: () => ({
    ocr: scaledPNG, preview: previewJPEG, mime: 'image/jpeg',
  }) });
  svc.running = true; svc.generation = 1;
  const shot = await svc.capture({ bundleId: native.app.bundleId, pid: native.app.pid, windowId: 7 }, 1);
  assert.equal(shot.preview, `data:image/jpeg;base64,${previewJPEG.toString('base64')}`);
  const recognize = native.calls.find(call => call.op === 'recognize');
  assert.equal(Buffer.from(recognize.payload.pngBase64, 'base64').toString(), scaledPNG.toString(),
    'oversized original images use the supplied scaled PNG for Vision rather than the JPEG preview');
  assert.equal(shot.preview.startsWith('data:image/jpeg;base64,'), true,
    'the verifier receives the compressed JPEG data URL without a filesystem artifact');
  await svc.close();
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
    const monitor = new Monitor(); let seeded = false;
    const observe = task => {
      if (task.submitAttemptedAt && !seeded) {
        const row = monitor.taskBlank(task.outboundText, task.draftInsertedAt);
        row.bunnyTaskId = task.id; row.status = 'ok'; row.summary = 'typed WorkBuddy task accepted'; row.endedAt = row.startedAt + 1;
        const snap = monitor.blank(); snap.sessionId = 'typed-task-session'; snap.task = row; snap.lastEventAt = row.endedAt;
        monitor.sessions.set('typed-task-file', { snap }); seeded = true;
      }
      return observeWorkBuddy(monitor, task);
    };
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
      if (purpose === 'task' && turns === 2) return { action: 'key', key: 'enter', purpose: 'submit' };
      return { action: 'done', completed: true, evidence: '任务名称和状态清晰可见' };
    }, [], { observeWorkBuddy: observe });
    assert((await svc.start({ goal: originalText, target: 'workbuddy', workModel: 'hy3' })).ok);
    await until(() => svc.task.status === 'review');
    const type = native.calls.find(x => x.op === 'type');
    assert(type);
    assert.equal(native.calls.filter(x => x.op === 'click').length, 1, 'the service clicks the unique free Hy3 row center before planning input');
    if (purpose === 'task') {
      assert(type.payload.text.startsWith(originalText), 'task typing preserves the exact original WorkBuddy request');
      assert(type.payload.text.includes(WECHAT_RULE));
      assert(type.payload.text.includes(`[workbunny:${svc.task.id}]`));
      assert(type.payload.text.includes('本轮唯一允许操作的微信会话：文件传输助手'));
      assert.match(sentGoal, /在 WorkBuddy 新建对话/);
      assert.doesNotMatch(sentGoal, /请检查当前任务进度/);
      assert.equal(svc.task.handoffSent, true);
      assert.equal(svc.task.sessionId, 'typed-task-session');
      assert.equal(svc.task.monitorTaskId, 1);
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
  assert(duplicateNative.calls.find(x => x.op === 'type').payload.text.startsWith(duplicateText + '\n\n'));
  assert.match(duplicateNative.calls.find(x => x.op === 'type').payload.text, /\[workbunny:[0-9a-f-]+\]$/i);
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
    if (turns === 2) return { action: 'key', key: 'enter', purpose: 'submit' };
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
  const observeWorkBuddy = async () => ({ taskId: 'fixture-monitor-1', sessionId: 'fixture-session-1', status: 'ok', summary: 'synthetic monitor completion', updatedAt: Date.now(), model: 'deepseek-v4.1-flash' });
  const userText = '请在 WorkBuddy 中完成这项工作，保留原文。';
  let plannerCalls = 0;
  const svc = service(native, async (goal, _shot, _signal, task) => {
    plannerCalls++;
    assert(task.handoffSent);
    assert.match(goal, /只观察已经提交的 WorkBuddy 会话/);
    assert.equal(task.taskText, userText);
    assert.equal(task.submittedAt, svc.task.submittedAt);
    return { action: 'done', completed: true, evidence: 'WorkBuddy 回复在当前对话中可见' };
  }, events, { observeWorkBuddy });
  assert((await svc.start({ goal: userText, target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => svc.task.status === 'review');
  const fillCall = native.calls.find(call => call.op === 'workbuddyFill');
  const sendCall = native.calls.find(call => call.op === 'workbuddySend');
  assert(fillCall && sendCall, 'ready Flash editor uses the dedicated fill and send path');
  assert(fillCall.payload.text.startsWith(userText + '\n\n'), 'fast path preserves exact user text');
  assert(fillCall.payload.text.includes(WECHAT_RULE));
  assert.match(fillCall.payload.text, new RegExp(`\\[workbunny:${svc.task.id}\\]`));
  assert.equal(fillCall.payload.model, 'deepseek-v4.1-flash');
  assert.deepEqual(fillCall.payload.expected, { bundleId: 'com.tencent.workbuddy.mac', pid: 234 });
  assert.equal(fillCall.payload.windowId, 7);
  assert.deepEqual(sendCall.payload.text, fillCall.payload.text);
  assert.equal(svc.task.draftInserted, true);
  assert.equal(svc.task.handoffSent, true);
  assert.deepEqual(svc.task.workbuddyUi, { available: true, homeReady: true, editorCount: 1,
    selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: false, draftEmpty: true, conversationReady: false },
  'persisted WorkBuddy UI diagnostic exposes only bounded flags and model name');
  assert(Number.isFinite(svc.task.submittedAt));
  assert.equal(plannerCalls, 0, 'a terminal Monitor record completes supervision without treating a screenshot planner as the monitor');
  assert.equal(native.calls.filter(call => call.op === 'capture').length, 2, 'a fresh screenshot is captured before send');
  assert.equal(svc.task.sessionId, 'fixture-session-1');
  assert.match(svc.task.evidence, /synthetic monitor completion/);
  assert.match(svc.task.evidence, /需独立复核/);
  assert.equal(native.calls.some(call => ['type', 'click', 'key'].includes(call.op)), false, 'fast path does not replay visual UI input');
  const inspect = native.calls.find(call => call.op === 'workbuddyInspect');
  assert.equal(inspect.payload.text, svc.task.outboundText, 'Inspect compares against the exact same persisted outbound payload');
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
  const matchingSvc = service(matchingNative, async () => { throw new Error('planner must not stand in for Monitor'); }, [], { observeWorkBuddy });
  assert((await matchingSvc.start({ goal: sameText, target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => matchingSvc.task.status === 'review');
  assert.deepEqual(matchingNative.workBuddyFillResults, [{ filled: true, idempotent: true }], 'native fill takes the idempotent path for the exact same draft');
  assert(matchingNative.calls.find(call => call.op === 'workbuddyInspect')?.payload.text.startsWith(sameText));
  assert(matchingNative.calls.find(call => call.op === 'workbuddyFill')?.payload.text.includes(`[workbunny:${matchingSvc.task.id}]`));
  assert(matchingNative.calls.find(call => call.op === 'workbuddySend')?.payload.text.includes(WECHAT_RULE));
  assert.equal(matchingNative.calls.some(call => ['type', 'click', 'key'].includes(call.op)), false, 'an exact pre-existing draft is sent without visual retyping');

  const inspectFailureNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash', workBuddyInspectError: true });
  let visualFallback = 0;
  const inspectFailureSvc = service(inspectFailureNative, async () => { visualFallback++; return { action: 'done', completed: false, reason: 'fixture fallback' }; });
  assert((await inspectFailureSvc.start({ goal: '视觉回退', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => inspectFailureSvc.task.status === 'paused');
  assert.equal(visualFallback, 1, 'read-only inspect failure falls back to the existing visual flow');
  assert.equal(inspectFailureNative.calls.some(call => ['workbuddyFill', 'workbuddySend'].includes(call.op)), false);
}

async function testWorkBuddyOutboundTextBudget() {
  const goal = '😀'.repeat(3000), criteria = '🚀'.repeat(1200);
  const native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash',
    workBuddyInspection: { available: true, editorCount: 1, draftEmpty: true, selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: false, homeReady: true } });
  const observer = async task => ({ taskId: 71, sessionId: 'budget-fixture-session', status: 'ok',
    summary: 'synthetic completion', startedAt: task.submittedAt, updatedAt: task.submittedAt + 1, model: 'deepseek-v4.1-flash' });
  const svc = service(native, async () => { throw new Error('handoff should not invoke visual planner'); }, [], { observeWorkBuddy: observer });
  assert((await svc.start({ goal, criteria, target: 'workbuddy', origin: 'dialogue', workModel: 'deepseek-v4.1-flash' })).ok);
  assert.equal(svc.task.goal, goal, '3,000 Unicode scalar goal is preserved in full');
  assert.equal(svc.task.criteria, criteria, '1,200 Unicode scalar criteria is preserved in full');
  assert(svc.task.outboundText.startsWith(goal + '\n\n验收标准：\n' + criteria));
  assert(svc.task.outboundText.includes(WECHAT_RULE));
  assert(svc.task.outboundText.includes(`[workbunny:${svc.task.id}]`));
  assert(svc.task.outboundText.length <= WORKBUDDY_TEXT_UTF16_LIMIT, 'full bounded task and fixed additions fit native UTF-16 budget');
  await until(() => svc.task.status === 'review');
  const fill = native.calls.find(call => call.op === 'workbuddyFill');
  assert.equal(fill.payload.text, svc.task.outboundText, 'native receives the complete persisted outbound text without truncation');
  await svc.close();

  for (const request of [
    { goal: 'invalid\ttab', criteria: 'ok' },
    { goal: 'valid task', criteria: 'invalid\u0001criteria' },
    { goal: 'invalid\rlone CR', criteria: 'ok' },
  ]) {
    const invalidNative = new FakeNative();
    const invalidSvc = service(invalidNative, async () => ({}));
    const result = await invalidSvc.start({ ...request, target: 'workbuddy', workModel: 'deepseek-v4.1-flash' });
    assert.equal(result.ok, false, 'unsupported control characters are refused');
    assert.equal(invalidNative.calls.length, 0, 'control-character rejection precedes native permissions, activation, or input');
    assert.equal(invalidSvc.task, null);
  }

  assert.equal(workBuddyTextWithinLimit('😀'.repeat(WORKBUDDY_TEXT_UTF16_LIMIT / 2)), true);
  assert.equal(workBuddyTextWithinLimit('😀'.repeat(WORKBUDDY_TEXT_UTF16_LIMIT / 2) + 'a'), false,
    'UTF-16 budget counts surrogate pairs as two units');
  const oversize = 'x'.repeat(WORKBUDDY_TEXT_UTF16_LIMIT + 1);
  assert.equal(workBuddyTextWithinLimit(oversize), false);
  assert.throws(() => validateWorkBuddyOutbound(oversize), /12000.*未截断/u,
    'over-budget outbound text is rejected with an explicit no-truncation result');
}

async function testMonitorBoundFollowUpAndAutomaticAcceptance() {
  let sawFollowUp = false, followUpPolls = 0;
  const previousMessageKey = 'message-key-original-round';
  const followUpMessageKey = 'message-key-followup-round';
  const conversationInspection = { available: true, conversationReady: true, associationMarkerPresent: true, editorCount: 1,
    draftEmpty: true, selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: false };
  const native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash',
    workBuddyInspection: { available: true, editorCount: 1, draftEmpty: true, selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: false, homeReady: true },
    workBuddyConversationInspection: conversationInspection });
  const observer = async task => {
    if (task.followUpAwaitingMonitor) {
      sawFollowUp = true;
      followUpPolls++;
      if (followUpPolls === 1) return { taskId: 11, messageKey: previousMessageKey, sessionId: 'fixture-session-bound', status: 'running', summary: 'stale previous round', updatedAt: task.submittedAt };
      return { taskId: 1, messageKey: followUpMessageKey, sessionId: 'fixture-session-bound', status: 'ok', summary: 'follow-up result',
        updatedAt: task.submittedAt, model: 'deepseek-v4.1-flash' };
    }
    return { taskId: 11, messageKey: previousMessageKey, sessionId: 'fixture-session-bound', status: 'running', summary: 'still running', updatedAt: Date.now() };
  };
  const svc = service(native, async () => { throw new Error('monitor path must not call visual planner'); }, [], { observeWorkBuddy: observer });
  assert((await svc.start({ goal: '按验收标准完成任务', criteria: '最终文件存在且能打开', origin: 'dialogue', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => svc.task.status === 'monitoring' && svc.task.sessionId === 'fixture-session-bound');
  assert.equal(svc.running, true, 'Monitor running state keeps the desktop task supervised in background');
  assert.equal(svc.task.origin, 'dialogue');
  assert.equal(svc.task.criteria, '最终文件存在且能打开');
  assert.equal(svc.task.goal, '按验收标准完成任务', 'the user goal remains separately intact');
  assert.equal(svc.task.bunnyTaskId, svc.task.id);
  assert.match(svc.task.outboundText, new RegExp(`\\[workbunny:${svc.task.id}\\]`));
  assert.match(svc.task.outboundText, /最终文件存在且能打开/);
  assert.equal(svc.task.monitorTaskId, 11);
  assert.equal(svc.task.monitorMessageKey, previousMessageKey);

  const beforeUnsafe = native.calls.length;
  assert.equal((await svc.followUp({ text: '请使用 AppleScript 退出微信再重试' })).ok, false);
  assert.equal(native.calls.length, beforeUnsafe, 'a model-generated follow-up cannot bypass the WeChat scope guard');
  native.app = { pid: 999, bundleId: 'cn.haminn.workbunny', name: 'workbunny' };
  const activationCount = native.calls.filter(call => call.op === 'activate').length;
  const result = await svc.followUp({ text: '请补齐缺失文件并确认可打开' });
  assert.equal(result.ok, true);
  assert.equal(native.calls.filter(call => call.op === 'activate').length, activationCount + 1, 'a bound follow-up can reactivate WorkBuddy, then must recheck the actual conversation');
  assert.equal(result.sessionId, 'fixture-session-bound');
  assert.equal(svc.task.followUpRound, 1);
  assert.equal(svc.task.previousMonitorTaskId, 11);
  assert.equal(svc.task.previousMonitorMessageKey, previousMessageKey);
  assert(svc.task.submittedAt > 0);
  const conversationInspect = native.calls.find(call => call.op === 'workbuddyInspect' && call.payload.mode === 'conversation');
  assert.equal(conversationInspect.payload.marker, svc.task.associationMarker);
  assert.equal(conversationInspect.payload.expected.bundleId, 'com.tencent.workbuddy.mac');
  assert(native.calls.some(call => call.op === 'workbuddyFill' && call.payload.mode === 'conversation'));
  assert.equal(native.calls.filter(call => call.op === 'workbuddySend').length, 2, 'one initial message and one single follow-up are sent');
  await until(() => svc.task.status === 'review');
  assert.equal(sawFollowUp, true);
  assert(followUpPolls >= 2, 'the previous round task ID is ignored until the new submission appears');
  assert.equal(svc.task.monitorTaskId, 1, 'a new Monitor instance may assign a different per-process task counter');
  assert.equal(svc.task.monitorMessageKey, followUpMessageKey);
  assert.match(svc.task.evidence, /follow-up result/);
  const sentCount = native.calls.filter(call => call.op === 'workbuddySend').length;
  svc.task.followUpRound = 2;
  assert.equal((await svc.followUp({ text: '第三轮应被拒绝' })).ok, false);
  assert.equal(native.calls.filter(call => call.op === 'workbuddySend').length, sentCount, 'service enforces the two-round follow-up ceiling');
  svc.update({ status: 'verifying' });
  assert.equal((await svc.accept({ automatic: true, report: '条件通过', evidence: '独立检查通过' })).ok, true);
  assert.equal(svc.task.userAccepted, false, 'Bunny automatic acceptance never records user acceptance');
  assert.equal(svc.task.automaticAccepted, true);
}

async function testNumericMonitorTaskIdBindsThroughRealObserver() {
  const monitor = new Monitor();
  let seeded = false;
  const observe = task => {
    if (!task.submittedAt) return null;
    if (!seeded) {
      const row = monitor.taskBlank(task.outboundText, task.submittedAt);
      row.bunnyTaskId = task.bunnyTaskId;
      row.status = 'ok'; row.summary = 'synthetic Monitor numeric-ID result';
      row.endedAt = task.submittedAt + 20;
      const snap = monitor.blank();
      snap.sessionId = 'numeric-monitor-session'; snap.task = row; snap.lastEventAt = row.endedAt;
      monitor.sessions.set('synthetic-monitor-file', { snap });
      seeded = true;
    }
    return observeWorkBuddy(monitor, task);
  };
  const native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash',
    workBuddyInspection: { available: true, editorCount: 1, draftEmpty: true, selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: false, homeReady: true } });
  const svc = service(native, async () => { throw new Error('a real observer record should complete this synthetic integration'); }, [], { observeWorkBuddy: observe });
  assert((await svc.start({ goal: 'numeric monitor integration', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => svc.task.status === 'review');
  assert.equal(svc.task.sessionId, 'numeric-monitor-session');
  assert.equal(svc.task.monitorSessionId, 'numeric-monitor-session');
  assert.equal(svc.task.monitorTaskId, 1);
  assert.equal(typeof svc.task.monitorTaskId, 'number', 'Monitor.taskBlank emits a numeric task id and service keeps its type');
  assert.match(svc.task.evidence, /synthetic Monitor numeric-ID result/);
  assert.equal(native.calls.filter(call => call.op === 'workbuddySend').length, 1);
}

function monitorWithMessage(text, sessionId, startedAt, priorTasks = 0) {
  const monitor = new Monitor();
  for (let i = 0; i < priorTasks; i++) monitor.taskBlank(`prior task ${i}`, startedAt - 1000 - i);
  const snap = monitor.blank();
  snap.sessionId = sessionId;
  monitor.beginTask(text, startedAt, snap, { priming: true });
  Object.assign(snap.task, { status: 'ok', summary: 'same persisted Monitor result', endedAt: startedAt + 5000,
    model: 'deepseek-v4.1-flash' });
  snap.lastEventAt = startedAt + 5000;
  monitor.sessions.set(`session-${sessionId}`, { snap });
  return { monitor, row: snap.task };
}

async function testMonitorMessageKeySurvivesInstanceCounterReorder() {
  const id = 'd52ab891-7385-4072-a8ea-62d7ed7db0e6';
  const task = makePausedResumeTask({ id, bunnyTaskId: id });
  task.associationMarker = `[workbunny:${id}]`;
  task.outboundText = makeWorkBuddyOutbound(task);
  const submittedAt = Date.now() - 5000, sessionId = 'stable-message-session';
  const oldInstance = monitorWithMessage(task.outboundText, sessionId, submittedAt, 10);
  const newInstance = monitorWithMessage(task.outboundText, sessionId, submittedAt, 0);
  assert.equal(oldInstance.row.id, 11);
  assert.equal(newInstance.row.id, 1);
  assert.equal(oldInstance.row.messageKey, newInstance.row.messageKey,
    'Monitor derives the same message identity when attach order changes the process-local counter');
  assert.notEqual(monitorWithMessage(task.outboundText, 'another-session', submittedAt).row.messageKey, oldInstance.row.messageKey,
    'a different session receives a different stable message identity');
  assert.notEqual(monitorWithMessage(task.outboundText, sessionId, submittedAt + 1).row.messageKey, oldInstance.row.messageKey,
    'a different user-message timestamp receives a different stable identity');
  const otherUUIDText = task.outboundText.replace(task.associationMarker, '[workbunny:11111111-1111-4111-8111-111111111111]');
  assert.notEqual(monitorWithMessage(otherUUIDText, sessionId, submittedAt).row.messageKey, oldInstance.row.messageKey,
    'a different task UUID in the user message receives a different stable identity');

  const stableNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac' });
  const stableService = service(stableNative, async () => { throw new Error('Monitor restart recovery should be read-only'); }, [], {
    observeWorkBuddy: observation => observeWorkBuddy(newInstance.monitor, observation),
  });
  stableService.task = makePausedResumeTask({ id, bunnyTaskId: id, status: 'paused', outboundText: task.outboundText,
    associationMarker: task.associationMarker, handoffSent: true, submittedAt, sessionId,
    monitorSessionId: sessionId, monitorTaskId: oldInstance.row.id, monitorMessageKey: oldInstance.row.messageKey });
  assert.equal((await stableService.resume()).ok, true);
  await until(() => stableService.task.status === 'review');
  assert.equal(stableService.task.monitorTaskId, 1);
  assert.equal(stableService.task.monitorMessageKey, oldInstance.row.messageKey);
  await stableService.close();

  const legacyNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac' });
  let observedLegacy;
  const legacyService = service(legacyNative, async () => { throw new Error('legacy message recovery should remain read-only'); }, [], {
    observeWorkBuddy: observation => { observedLegacy = observation; return observeWorkBuddy(newInstance.monitor, observation); },
  });
  legacyService.task = makePausedResumeTask({ id, bunnyTaskId: id, status: 'paused', outboundText: task.outboundText,
    associationMarker: task.associationMarker, handoffSent: true, submittedAt, sessionId,
    monitorSessionId: sessionId, monitorTaskId: oldInstance.row.id });
  assert.equal((await legacyService.resume()).ok, true);
  await until(() => legacyService.task.status === 'review');
  assert.equal(observedLegacy.monitorTaskId, undefined, 'legacy resume clears only the unstable counter and rediscovers by task marker/session/time');
  assert.equal(legacyService.task.sessionId, sessionId);
  assert.equal(legacyService.task.submittedAt, submittedAt);
  assert.equal(legacyService.task.monitorTaskId, 1);
  assert.equal(legacyService.task.monitorMessageKey, newInstance.row.messageKey);
  await legacyService.close();
}

async function testVisualWorkBuddySendBindsExactMonitorTask() {
  const monitor = new Monitor();
  let seeded = false, plannerCalls = 0, observeSnapshots = [];
  const observe = task => {
    observeSnapshots.push({ submittedAt: task.submittedAt, draftInsertedAt: task.draftInsertedAt, handoffSent: task.handoffSent });
    if (task.submitAttemptedAt && !seeded) {
      const row = monitor.taskBlank(task.outboundText, task.draftInsertedAt);
      row.bunnyTaskId = task.bunnyTaskId;
      row.status = 'ok'; row.summary = 'visual-path Monitor result'; row.endedAt = row.startedAt + 20;
      const snap = monitor.blank(); snap.sessionId = 'visual-monitor-session'; snap.task = row; snap.lastEventAt = row.endedAt;
      monitor.sessions.set('visual-monitor-file', { snap }); seeded = true;
    }
    return observeWorkBuddy(monitor, task);
  };
  const native = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash' });
  const svc = service(native, async () => {
    plannerCalls++;
    if (plannerCalls === 1) return { action: 'type', purpose: 'task', text: 'service replaces this with the exact outbound text' };
    if (plannerCalls === 2) return { action: 'key', key: 'enter', purpose: 'submit' };
    throw new Error('Monitor-bound visual handoff must stop asking the planner');
  }, [], { observeWorkBuddy: observe });
  assert((await svc.start({ goal: 'visual Monitor handoff', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => svc.task.status === 'review');
  assert.equal(plannerCalls, 2);
  assert.equal(svc.task.draftInserted, true);
  assert(Number.isFinite(svc.task.draftInsertedAt));
  assert.equal(svc.task.submitAttemptedAt > 0, true);
  assert.equal(svc.task.handoffSent, true, 'handoff is recorded only after the exact marker-bearing Monitor task is found');
  assert.equal(svc.task.submittedAt, svc.task.draftInsertedAt, 'Monitor task start time becomes the confirmed submission timestamp');
  assert.equal(svc.task.sessionId, 'visual-monitor-session');
  assert.equal(svc.task.monitorTaskId, 1, 'real Monitor taskBlank numeric IDs bind through observer');
  assert.match(svc.task.evidence, /visual-path Monitor result/);
  assert(native.calls.some(call => call.op === 'type'));
  assert.equal(native.calls.filter(call => call.op === 'key').length, 1);
  assert.equal(native.calls.some(call => call.op === 'workbuddySend'), false, 'visual submission is not confused with the dedicated AX send op');
  assert(observeSnapshots.some(item => item.draftInsertedAt && item.submittedAt === item.draftInsertedAt),
    'observer receives the temporary timestamp anchor while the stored submittedAt is still unset');
  assert.equal(observeSnapshots[0]?.handoffSent, undefined);
  await svc.close();

  let retryPlannerCalls = 0;
  const delayedNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash' });
  const delayedSvc = service(delayedNative, async () => {
    retryPlannerCalls++;
    if (retryPlannerCalls === 1) return { action: 'type', purpose: 'task', text: 'exact task' };
    return { action: 'key', key: 'enter', purpose: 'submit' };
  }, [], { observeWorkBuddy: () => null });
  assert((await delayedSvc.start({ goal: 'submission is uncertain', target: 'workbuddy', workModel: 'deepseek-v4.1-flash' })).ok);
  await until(() => delayedSvc.task.status === 'paused');
  assert.equal(delayedSvc.task.handoffSent, undefined);
  assert.equal(delayedSvc.task.submittedAt, undefined, 'uncertain submission is never marked as sent');
  assert.equal(delayedNative.calls.filter(call => call.op === 'key').length, 1, 'uncertain send is not replayed');
  assert.match(delayedSvc.task.note, /可能已发生.*Monitor.*不会|Monitor 未能精确确认/u);
  await delayedSvc.close();
}

function makePausedResumeTask(overrides = {}) {
  const id = 'bcf0b2af-d420-4fb4-8fa3-98effc9246c9';
  const task = { id, bunnyTaskId: id, goal: '恢复原任务', taskText: '恢复原任务', criteria: '核对同一交付',
    target: 'workbuddy', workModel: 'deepseek-v4.1-flash', thinking: 'high', origin: 'panel', recipient: '文件传输助手',
    associationMarker: `[workbunny:${id}]`, outboundText: '', sources: [], startedAt: Date.now() - 600000,
    attemptStartedAt: Date.now() - 600000, followUpRound: 0, status: 'failed', steps: [] };
  task.outboundText = makeWorkBuddyOutbound(task);
  return Object.assign(task, overrides);
}

async function testExplicitResumeRecoverySafety() {
  const observer = task => task.handoffSent ? ({ taskId: 1, sessionId: 'resume-session', status: 'ok',
    summary: 'same task resumed and completed', startedAt: task.submittedAt || Date.now(), updatedAt: Date.now(), model: 'deepseek-v4.1-flash' }) : null;
  const sameTextNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash',
    workBuddyInspection: { available: true, homeReady: true, editorCount: 1, draftEmpty: false, draftMatchesRequest: true,
      selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: true } });
  const sameTextService = service(sameTextNative, async () => ({ action: 'done', completed: false, reason: 'unexpected planner path' }), [], { observeWorkBuddy: observer });
  const priorReportedAt = Date.now() - 1000;
  const originalTask = makePausedResumeTask({ draftInserted: true, draftInsertedAt: Date.now() - 30000,
    report: '上次暂停的说明', reportedAt: priorReportedAt, status: 'failed' });
  sameTextService.task = originalTask;
  const originalId = originalTask.id, originalStartedAt = originalTask.startedAt, previousGeneration = sameTextService.generation;
  assert.equal(sameTextNative.calls.length, 0, 'persisted failed task remains inert until resume is explicitly called');
  const resumed = await sameTextService.resume();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.id, originalId);
  assert(sameTextService.generation > previousGeneration);
  await until(() => sameTextService.task.status === 'review');
  assert.equal(sameTextService.task.id, originalId, 'resume reuses the persisted task ID');
  assert.equal(sameTextService.task.startedAt, originalStartedAt, 'original task start remains available for the journal');
  assert(sameTextService.task.attemptStartedAt > originalStartedAt, 'runtime budget starts from this recovery attempt');
  assert.equal(sameTextService.task.report, undefined);
  assert.equal(sameTextService.task.reportedAt, undefined);
  assert.deepEqual(sameTextService.task.reportHistory, [{ report: '上次暂停的说明', reportedAt: priorReportedAt, status: 'failed' }]);
  assert.equal(sameTextNative.calls.filter(call => call.op === 'workbuddyFill').length, 1);
  assert.equal(sameTextNative.workBuddyFillResults[0].idempotent, true, 'matching saved draft resumes through native idempotent fill');
  assert.equal(sameTextNative.calls.filter(call => call.op === 'workbuddySend').length, 1);
  assert.equal(sameTextNative.calls.some(call => call.op === 'type'), false, 'resume never types over the existing exact draft');
  await sameTextService.close();

  const unknownNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash',
    workBuddyInspection: { available: true, homeReady: true, editorCount: 1, draftEmpty: false, draftMatchesRequest: false,
      selectedModel: 'Deepseek-V4.1-Flash', sendEnabled: true } });
  const unknownService = service(unknownNative, async () => ({ action: 'key', key: 'enter', purpose: 'submit' }));
  unknownService.task = makePausedResumeTask({ status: 'stopped', draftInserted: true, draftInsertedAt: Date.now() - 5000 });
  assert.equal((await unknownService.resume()).ok, true);
  await until(() => unknownService.task.status === 'paused');
  assert.match(unknownService.task.note, /未能与原 outboundText 完全匹配/u);
  assert.equal(unknownNative.calls.some(call => ['workbuddyFill', 'workbuddySend', 'type', 'key', 'click'].includes(call.op)), false,
    'an unfamiliar draft is preserved and never overwritten or submitted');
  await unknownService.close();

  const pendingNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac', selectedModel: 'flash' });
  const pendingService = service(pendingNative, async () => ({ action: 'done', completed: false, reason: '当前截图无法确认回复' }), [], { observeWorkBuddy: () => null });
  pendingService.task = makePausedResumeTask({ status: 'paused', draftInserted: true, draftInsertedAt: Date.now() - 5000,
    steps: [{ step: 1, action: 'workbuddySend', state: 'intent', at: Date.now() - 1000 }] });
  assert.equal((await pendingService.resume()).ok, true);
  assert(Number.isFinite(pendingService.task.submitAttemptedAt), 'a persisted native send intent is treated as possibly delivered after restart');
  await until(() => pendingService.task.status === 'paused');
  assert.equal(pendingService.task.handoffSent, undefined);
  assert.equal(pendingService.task.submittedAt, undefined, 'possible old send remains explicitly unconfirmed');
  assert.equal(pendingNative.calls.some(call => ['workbuddyFill', 'workbuddySend', 'type', 'key', 'click'].includes(call.op)), false,
    'possibly sent tasks resume only through monitor and read-only screenshots');
  await pendingService.close();

  const priorSubmission = Date.now() - 5000;
  const restartedMessage = 'stable-message-key-after-restart';
  const restartNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac' });
  let restartObserverTask;
  const restartService = service(restartNative, async () => { throw new Error('resumed Monitor must not invoke visual planning'); }, [], {
    observeWorkBuddy: task => {
      restartObserverTask = task;
      return { taskId: 1, messageKey: restartedMessage, sessionId: 'resume-session', status: 'ok',
        summary: 'same message found after Monitor restart', startedAt: priorSubmission, updatedAt: Date.now(), model: 'deepseek-v4.1-flash' };
    },
  });
  restartService.task = makePausedResumeTask({ status: 'paused', handoffSent: true, submittedAt: priorSubmission,
    sessionId: 'resume-session', monitorSessionId: 'resume-session', monitorTaskId: 11 });
  assert.equal((await restartService.resume()).ok, true);
  await until(() => restartService.task.status === 'review');
  assert.equal(restartObserverTask.monitorTaskId, undefined, 'old per-process task counter is cleared for legacy recovery');
  assert.equal(restartService.task.monitorTaskId, 1, 'same session and stable request marker can rebind under the new process counter');
  assert.equal(restartService.task.monitorMessageKey, restartedMessage);
  assert.equal(restartNative.calls.some(call => ['activate', 'workbuddyFill', 'workbuddySend', 'type', 'key', 'click'].includes(call.op)), false,
    'already sent resume confirms through read-only Monitor before any UI activation');
  await restartService.close();

  const keyedNative = new FakeNative({ bundleId: 'com.tencent.workbuddy.mac' });
  const keyedMessage = 'persisted-stable-message-key';
  const keyedService = service(keyedNative, async () => { throw new Error('stable-key Monitor confirmation must be read-only'); }, [], {
    observeWorkBuddy: task => ({ taskId: 1, messageKey: keyedMessage, sessionId: 'resume-session', status: 'ok',
      summary: 'same keyed message found after reorder', startedAt: priorSubmission, updatedAt: Date.now(), model: 'deepseek-v4.1-flash' }),
  });
  keyedService.task = makePausedResumeTask({ status: 'paused', handoffSent: true, submittedAt: priorSubmission,
    sessionId: 'resume-session', monitorSessionId: 'resume-session', monitorTaskId: 11, monitorMessageKey: keyedMessage });
  assert.equal((await keyedService.resume()).ok, true);
  await until(() => keyedService.task.status === 'review');
  assert.equal(keyedService.task.monitorTaskId, 1, 'a matching stable message key takes precedence over changed numeric task IDs');
  assert.equal(keyedService.task.monitorMessageKey, keyedMessage);
  assert.equal(keyedNative.calls.some(call => ['activate', 'workbuddyFill', 'workbuddySend', 'type', 'key', 'click'].includes(call.op)), false);
  await keyedService.close();

  const sourceNative = new FakeNative();
  const sourceService = service(sourceNative, async () => ({}));
  sourceService.task = makePausedResumeTask({ origin: 'dialogue', privacyEpoch: 12, sources: ['source-a'] });
  assert.equal((await sourceService.resume({ privacyEpoch: 13, sources: ['source-a'] })).ok, false);
  assert.equal((await sourceService.resume({ privacyEpoch: 12, sources: [] })).ok, false);
  assert.equal(sourceNative.calls.length, 0, 'stale privacy epoch or removed source blocks recovery before native access');
  sourceService.task = makePausedResumeTask({ origin: 'panel', sources: [null] });
  assert.equal((await sourceService.resume()).ok, false, 'corrupt persisted source references cannot be silently dropped');
  assert.equal(sourceNative.calls.length, 0);
  await sourceService.close();

  const permissionGate = deferred(), stopNative = new FakeNative({ permissionsGate: permissionGate });
  const stopService = service(stopNative, async () => ({}));
  stopService.task = makePausedResumeTask({ status: 'failed' });
  const lateResume = stopService.resume();
  await until(() => stopNative.calls.some(call => call.op === 'permissions'));
  await stopService.stop('取消恢复');
  permissionGate.resolve({ accessibilityTrusted: true, screenCaptureAllowed: true, postEventAllowed: true, sessionLocked: false });
  const lateResult = await lateResume;
  assert.equal(lateResult.ok, false);
  assert.equal(stopService.task.status, 'stopped');
  assert.equal(stopNative.calls.some(call => ['activate', 'capture', 'type', 'key', 'click', 'workbuddyFill', 'workbuddySend'].includes(call.op)), false,
    'stop invalidates a resume blocked in preflight before it can act');
  await stopService.close();
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
    assert.match(requests[0].messages[0].content, /若刚已聚焦且截图不变/);
    assert.match(requests[0].messages[0].content, /直接输出单个type动作并带focus:\{x,y\}/);

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

async function testContactDirectoryAndWechatOperations() {
  let persisted = { contacts: [] };
  const directory = new ContactDirectory({ read: async () => persisted, write: async value => { persisted = value; } });
  const remembered = await directory.remember('Alice', ['爱丽丝'], { source: 'user-correction' });
  assert.equal(remembered.confirmed, true);
  assert.deepEqual((await directory.resolve('爱丽丝')).aliases, ['Alice', '爱丽丝']);
  await directory.remember('Alice', ['阿丽丝'], { source: 'second-user-correction' });
  assert.deepEqual((await directory.resolve('Alice')).aliases, ['Alice', '爱丽丝', '阿丽丝'], 'confirmed aliases accumulate');
  assert.equal((await directory.resolve('Bob')).confirmed, false, 'unknown spoken names do not inherit another contact');
  await assert.rejects(directory.remember('Bob', ['爱丽丝']), /冲突/u);
  const failedWriteDirectory = new ContactDirectory({ read: async () => [{ recipient: 'Old', aliases: ['旧名'] }], write: async () => { throw new Error('disk error'); } });
  await assert.rejects(failedWriteDirectory.remember('Old', ['新名']), /disk error/u);
  assert.deepEqual((await failedWriteDirectory.resolve('Old')).aliases, ['Old', '旧名'], 'failed persistence leaves in-memory aliases unchanged');
  assert.equal(typeof createContactDirectory, 'function');

  const recipientOCR = [{ text: 'Alice', confidence: 0.98, x: 0.42, y: 0.08, width: 0.08, height: 0.02 }];
  const body = '确认明天下午三点';
  const serviceOpts = { contactDirectory: directory };
  const events = [];
  const native = new FakeNative({ bundleId: 'com.tencent.xinWeChat', events, recognizedTexts: index => index === 0 ? recipientOCR : index === 1 ? [
    ...recipientOCR, { text: body, confidence: 0.99, x: 0.25, y: 0.82, width: 0.24, height: 0.025 },
  ] : [...recipientOCR, { text: body, confidence: 0.99, x: 0.62, y: 0.55, width: 0.24, height: 0.025 }] });
  native.events = events;
  const actions = [
    { action: 'type', text: 'planner must be replaced', purpose: 'task', focus: { x: 0.5, y: 0.9 } },
    { action: 'key', key: 'enter', modifiers: [], purpose: 'submit' },
    { action: 'done', completed: true, evidence: '目标联系人中出现完整已发送消息' },
  ];
  const svc = service(native, async () => actions.shift(), events, serviceOpts);
  assert((await svc.start({ goal: '发送指定原文', target: 'wechat', origin: 'watch', operation: 'send',
    recipient: '爱丽丝', message: body })).ok);
  await until(() => svc.task.status === 'review');
  assert.equal(svc.task.recipient, 'Alice');
  assert.equal(svc.task.message, body);
  assert.equal(svc.task.sendState, 'confirmed');
  assert.equal(svc.task.submitAttemptedAt > 0, true);
  const sendIntent = events.findIndex(event => event.type === 'persist' && event.steps.some(step => step.purpose === 'submit' && step.state === 'intent'));
  const submitEvent = events.findIndex(event => event.type === 'native' && event.op === 'key');
  assert(sendIntent >= 0 && sendIntent < submitEvent, 'submit attempt journal must precede Enter');
  assert.equal(native.calls.filter(call => call.op === 'type').length, 1, 'the exact original message is typed once');
  assert.equal(native.calls.filter(call => call.op === 'key').length, 1, 'the message is submitted once');
  assert.equal(native.calls.find(call => call.op === 'type').payload.text, body, 'planner cannot change the user message');

  const unknownNative = new FakeNative({ bundleId: 'com.tencent.xinWeChat', recognizedTexts: recipientOCR });
  const submitThenRepeat = [
    { action: 'type', text: body }, { action: 'key', key: 'enter', modifiers: [], purpose: 'submit' },
    { action: 'key', key: 'enter', modifiers: [], purpose: 'submit' },
  ];
  const unknown = service(unknownNative, async () => submitThenRepeat.shift(), [], serviceOpts);
  assert((await unknown.start({ goal: '发送一次', target: 'wechat', origin: 'watch', operation: 'send', recipient: 'Alice', message: body })).ok);
  await until(() => unknown.task.status === 'paused');
  assert.equal(unknownNative.calls.filter(call => call.op === 'key').length, 1, 'unknown send result cannot be resubmitted');
  assert.match(unknown.task.note, /仅允许观察|不会重复/u);

  for (const operation of ['read', 'open']) {
    const guardedNative = new FakeNative({ bundleId: 'com.tencent.xinWeChat', recognizedTexts: recipientOCR });
    const guarded = service(guardedNative, async () => ({ action: 'type', text: 'not allowed', purpose: 'task' }), [], serviceOpts);
    assert((await guarded.start({ goal: '检查会话', target: 'wechat', origin: 'watch', operation, recipient: 'Alice' })).ok);
    await until(() => guarded.task.status === 'paused');
    assert.equal(guardedNative.calls.some(call => call.op === 'type' || call.op === 'key'), false, `${operation} never writes or submits`);
  }

  const navigationNative = new FakeNative({ bundleId: 'com.tencent.xinWeChat', recognizedTexts: recipientOCR });
  const navigation = service(navigationNative, async () => ({ action: 'type', text: 'Bob', purpose: 'navigation' }), [], serviceOpts);
  assert((await navigation.start({ goal: '发送指定原文', target: 'wechat', origin: 'watch', operation: 'send', recipient: 'Alice', message: body })).ok);
  await until(() => navigation.task.status === 'paused');
  assert.equal(navigationNative.calls.some(call => call.op === 'type'), false, 'navigation is limited to canonical names and confirmed aliases');
}

async function testWechatResumeDoesNotReplayOrOverwrite() {
  const header = [{ text: 'Alice', confidence: 0.99, x: 0.4, y: 0.08, width: 0.08, height: 0.02 }];
  const body = '原始待发送内容';
  const directory = createContactDirectory({ read: async () => [{ recipient: 'Alice', aliases: ['爱丽丝'] }] });
  const native = new FakeNative({ bundleId: 'com.tencent.xinWeChat', recognizedTexts: [...header, { text: body, confidence: 0.99, x: 0.4, y: 0.82, width: 0.2, height: 0.02 }] });
  const actions = [
    { action: 'type', text: body, purpose: 'task' },
    { action: 'done', completed: false, evidence: '暂未提交' },
  ];
  const svc = service(native, async () => actions.shift(), [], { contactDirectory: directory });
  assert((await svc.start({ goal: '准备微信草稿', target: 'wechat', origin: 'watch', operation: 'draft', recipient: 'Alice', message: body })).ok);
  await until(() => svc.task.status === 'paused');
  const typedBefore = native.calls.filter(call => call.op === 'type').length;
  assert.equal(typedBefore, 1);
  // A newly observed own draft can be resumed, but the task message is never typed a second time.
  const resumeActions = [{ action: 'done', completed: true, evidence: '编辑区存在原始草稿' }];
  svc.planner = async () => resumeActions.shift();
  assert((await svc.resume()).ok);
  await until(() => ['review', 'paused'].includes(svc.task.status));
  assert.equal(svc.task.status, 'review', `matching original draft should resume without retyping: ${svc.task.note}`);
  assert.equal(native.calls.filter(call => call.op === 'type').length, typedBefore);

  const stranger = new FakeNative({ bundleId: 'com.tencent.xinWeChat', recognizedTexts: [...header, { text: '别人的草稿', confidence: 0.99, x: 0.4, y: 0.82, width: 0.16, height: 0.02 }] });
  const stoppedTask = service(stranger, async () => ({ action: 'done', completed: false, evidence: 'no match' }), [], { contactDirectory: directory });
  assert((await stoppedTask.start({ goal: '草稿', target: 'wechat', origin: 'watch', operation: 'draft', recipient: 'Alice', message: body })).ok);
  await until(() => stoppedTask.task.status === 'paused');
  stoppedTask.task.draftInserted = true;
  assert((await stoppedTask.resume()).ok);
  await until(() => stoppedTask.task.status === 'paused');
  assert.equal(stranger.calls.filter(call => call.op === 'type' || call.op === 'key').length, 0, 'a different visible draft is preserved without input');

  const sent = service(new FakeNative({ bundleId: 'com.tencent.xinWeChat', recognizedTexts: header }), async () => ({ action: 'wait', reason: 'read only' }), [], { contactDirectory: directory });
  sent.task = { id: 'sent', target: 'wechat', status: 'paused', goal: 'send', operation: 'send', message: body, recipient: 'Alice', recipientAliases: ['Alice'], submitAttemptedAt: Date.now(), startedAt: Date.now(), steps: [] };
  assert((await sent.resume()).ok);
  await until(() => sent.native.calls.some(call => call.op === 'capture'));
  await sent.stop('test stop after unknown send');
  assert.equal(sent.native.calls.some(call => call.op === 'type' || call.op === 'key' || call.op === 'click'), false, 'submitted WeChat resume remains read-only');
}

async function testGuiLeaseSerializesAndReleases() {
  const lease = new GuiLease();
  assert.equal(lease.isFree(), true);
  await lease.acquire('watch');
  assert.equal(lease.isFree(), false);
  assert.equal(lease.release('wrong-owner'), false);
  assert.equal(lease.release('watch'), true);
  assert.equal(lease.isFree(), true);
  const nested = service(new FakeNative(), async () => ({}), [], { lease, owner: 'nested' });
  await nested.acquireGuiLease(); await nested.acquireGuiLease();
  nested.releaseGuiLease(); assert.equal(lease.isFree(), false, 'nested callers do not release another active GUI section');
  nested.releaseGuiLease(); assert.equal(lease.isFree(), true);

  const entered = deferred(), releasePlanner = deferred();
  const firstNative = new FakeNative();
  const sharedLease = new GuiLease();
  const first = service(firstNative, async () => { entered.resolve(); return releasePlanner.promise; }, [], { lease: sharedLease, owner: 'primary' });
  assert((await first.start({ goal: 'hold visual operation', target: 'current', workModel: 'hy3' })).ok);
  await entered.promise;
  const secondNative = new FakeNative({ bundleId: 'com.tencent.xinWeChat', recognizedTexts: [{ text: 'Alice', confidence: 0.99, x: 0.4, y: 0.08 }] });
  const second = service(secondNative, async () => ({ action: 'done', completed: false, evidence: 'view only' }), [], { lease: sharedLease, owner: 'watch' });
  assert((await second.start({ goal: 'open contact', target: 'wechat', origin: 'watch', operation: 'open', recipient: 'Alice' })).ok);
  await delay(50);
  assert.equal(secondNative.calls.some(call => call.op === 'activate'), false, 'a second Desktop cannot activate while another owner holds the GUI');
  await first.stop('release lease');
  releasePlanner.resolve({ action: 'done', completed: false, evidence: 'stopped' });
  await until(() => secondNative.calls.some(call => call.op === 'activate'));
  await until(() => second.task.status === 'paused');
  assert.equal(sharedLease.isFree(), true, 'run finally releases the shared lease');
}

async function main() {
  const taskType = validateAction({ action: 'type', text: 'hello', purpose: 'task' });
  assert.throws(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: '文件传输助手', confidence: 1, x: 0.05, y: 0.2 }] }), /尚未确认/);
  assert.doesNotThrow(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: '文件传输助手', confidence: 1, x: 0.4, y: 0.08 }] }));
  assert.throws(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: '文件传输助手', confidence: 1, x: 0.4, y: 0.08 }] }, false, 'hy3', 'Alice'), /尚未确认/, 'a different recipient requires its exact current header');
  assert.doesNotThrow(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: 'Alice', confidence: 1, x: 0.4, y: 0.08 }] }, false, 'hy3', 'Alice'));
  assert.throws(() => dispatchGuard(taskType, 'wechat', { ocr: [{ text: '爱丽丝', confidence: 1, x: 0.4, y: 0.08 }] }, false, 'hy3', 'Alice', ['爱丽丝']), /尚未确认/u,
    'aliases may locate a conversation but cannot authorize input/send unless the canonical header is visible');
  const missingDialogueRecipientNative = new FakeNative();
  const missingDialogueRecipient = service(missingDialogueRecipientNative, async () => ({ action: 'done', completed: false }));
  assert.equal((await missingDialogueRecipient.start({ goal: '发消息', target: 'wechat', origin: 'dialogue' })).ok, false);
  assert.equal(missingDialogueRecipientNative.calls.length, 0, 'dialogue-origin WeChat task cannot start without an explicit recipient');
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
  await testTypeCanFocusAndInputUnderSameScreenshotGuards();
  await testJPEGPreviewKeepsPNGForLargeImageOCR();
  await testJournalBeforeActionScopeAndReview();
  await testDoneWithoutVisibleCompletionPauses();
  await testWorkBuddyTypePurposeAndCurrentScope();
  await testWorkBuddyFlashProfile();
  await testWorkBuddyAXHandoff();
  await testWorkBuddyOutboundTextBudget();
  await testMonitorBoundFollowUpAndAutomaticAcceptance();
  await testNumericMonitorTaskIdBindsThroughRealObserver();
  await testMonitorMessageKeySurvivesInstanceCounterReorder();
  await testVisualWorkBuddySendBindsExactMonitorTask();
  await testExplicitResumeRecoverySafety();
  await testFlashGuardPreflightAndBrainRequest();
  await testInsertBackendDelayAndJournal();
  await testFreeModelIsStrictlyZeroCostAndStubbed();
  await testFreeChoiceProofLifecycle();
  await testContactDirectoryAndWechatOperations();
  await testWechatResumeDoesNotReplayOrOverwrite();
  await testGuiLeaseSerializesAndReleases();
  console.log('DesktopService integration checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
