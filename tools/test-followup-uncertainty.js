'use strict';

const assert = require('node:assert/strict');
const { DesktopService, makeWorkBuddyOutbound } = require('../src/main/desktop-service');
const { Secretary } = require('../src/main/secretary');
const { observeWorkBuddy } = require('../src/main/workbuddy-observation');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

const RECT = { x: 0, y: 0, width: 1000, height: 700 };
class UncertainSendNative {
  constructor(onSend) { this.onSend = onSend; this.calls = []; this.sends = 0; this.draftEmpty = true; this.draftMatchesRequest = false; }
  async request(op, payload = {}) {
    this.calls.push({ op, payload });
    if (op === 'permissions') return { accessibilityTrusted: true, screenCaptureAllowed: true, postEventAllowed: true };
    if (op === 'frontmost') return { application: { pid: 321, bundleId: 'com.tencent.workbuddy.mac' }, windows: [{ pid: 321, windowId: 7, layer: 0, rect: RECT }] };
    if (op === 'workbuddyInspect') {
      if (payload.mode === 'conversation') return { available: true, conversationReady: true, associationMarkerPresent: true,
        editorCount: 1, selectedModel: 'Deepseek-V4.1-Flash', draftEmpty: this.draftEmpty, draftMatchesRequest: this.draftMatchesRequest,
        sendEnabled: !this.draftEmpty };
      return { available: true, homeReady: true, editorCount: 1, selectedModel: 'Deepseek-V4.1-Flash', draftEmpty: true, sendEnabled: false };
    }
    if (op === 'workbuddyFill') {
      this.draftEmpty = false; this.draftMatchesRequest = true;
      return { filled: true };
    }
    if (op === 'workbuddySend') {
      this.sends++;
      await this.onSend(payload);
      // The native action was applied, but its acknowledgement was lost.
      throw new Error('fixture timeout after native click');
    }
    if (op === 'activate') return { activated: true };
    if (op === 'capture') return { pngBase64: Buffer.from('fixture').toString('base64'), desktopRect: RECT };
    if (op === 'recognize') return { texts: [] };
    return { performed: true };
  }
  async cancel() {}
  async close() {}
}

function fixtureTask(id) {
  const task = { id, bunnyTaskId: id, goal: '检查这份交付', taskText: '检查这份交付', criteria: '确认数据完整',
    target: 'workbuddy', workModel: 'deepseek-v4.1-flash', thinking: 'high', origin: 'dialogue', inputSource: 'text',
    privacyEpoch: 7, recipient: '文件传输助手', associationMarker: `[workbunny:${id}]`, sources: [],
    sessionId: 'wb-session-1', monitorSessionId: 'wb-session-1', monitorTaskId: 40, monitorMessageKey: 'old-message-key',
    monitorStatus: 'ok', monitorSummary: '旧回复：交付检查已完成。', submittedAt: Date.now() - 5000,
    handoffSent: true, followUpRound: 0, status: 'review', startedAt: Date.now() - 10000,
    steps: [{ step: 1, action: 'workbuddySend', state: 'input-sent', at: Date.now() - 9000 }] };
  task.outboundText = makeWorkBuddyOutbound(task);
  return task;
}

function monitorFixture(task, newReply) {
  const oldRow = { id: 40, bunnyTaskId: task.id, messageKey: 'old-message-key', sessionId: 'wb-session-1',
    startedAt: task.submittedAt, endedAt: task.submittedAt + 1000, status: 'ok', summary: '旧回复：交付检查已完成。', model: 'deepseek-v4.1-flash' };
  const rows = [oldRow];
  return {
    rows,
    monitor: { sessions: new Map([['wb-session-1', { snap: { sessionId: 'wb-session-1', task: oldRow, history: rows, lastEventAt: Date.now() } }]]) },
    addNew() {
      if (!newReply) return;
      const submittedAt = task.followUpPending?.submittedAt || task.submittedAt;
      const row = { id: 41, bunnyTaskId: task.id, messageKey: 'new-followup-message-key', sessionId: 'wb-session-1',
        startedAt: submittedAt + 10, endedAt: submittedAt + 2000, status: 'ok',
        summary: '新回复：已补充缺失的日期与金额。', model: 'deepseek-v4.1-flash' };
      rows.unshift(row);
      this.monitor.sessions.get('wb-session-1').snap.task = row;
      this.monitor.sessions.get('wb-session-1').snap.history = rows;
      this.monitor.sessions.get('wb-session-1').snap.lastEventAt = row.endedAt;
    },
  };
}

function createScenario({ newReply }) {
  const task = fixtureTask(`followup-uncertain-${newReply ? 'new' : 'old'}`);
  const monitor = monitorFixture(task, newReply);
  const journals = [], reports = [], verified = [], plannerCalls = [];
  let secretary;
  const native = new UncertainSendNative(async () => monitor.addNew());
  const desktop = new DesktopService({ native, planner: async (...args) => { plannerCalls.push(args); return { action: 'done', completed: false, reason: 'must not inspect stale response visually' }; },
    observeWorkBuddy: observedTask => observeWorkBuddy(monitor.monitor, observedTask),
    persist: async value => journals.push(structuredClone(value)),
    emit: status => secretary?.onStatus(status),
  });
  desktop.task = task;
  secretary = new Secretary({ desktop, epoch: () => 7, ready: () => true,
    verify: async ({ task: reviewed }) => {
      verified.push({ monitorMessageKey: reviewed.monitorMessageKey, summary: reviewed.monitorSummary });
      return { verdict: 'pass', report: '已依据本轮 WorkBuddy 回复核对完成' };
    },
    report: async report => reports.push(report),
  });
  return { task, monitor, native, desktop, secretary, journals, reports, verified, plannerCalls };
}

async function prepareUncertainFollowUp(scenario) {
  const result = await scenario.desktop.followUp({ text: '请补充缺失的日期与金额，并给出检查依据。' });
  assert.equal(result.ok, false, 'the native acknowledgement is deliberately lost');
  assert.equal(scenario.native.sends, 1, 'the fake native send was applied exactly once');
  assert.equal(scenario.desktop.task.status, 'paused');
  assert.equal(scenario.desktop.task.followUpPending?.state, 'unknown', 'a pre-send durable marker records the uncertain attempt');
  assert.equal(scenario.desktop.task.followUpPending?.round, 1);
  assert.equal(scenario.desktop.task.previousMonitorMessageKey, 'old-message-key');
  assert.equal(scenario.desktop.task.monitorMessageKey, null, 'the stale Monitor key is cleared before sending');
  assert.equal(scenario.desktop.task.followUpAwaitingMonitor, true);
  assert.ok(scenario.desktop.task.submittedAt > scenario.task.startedAt);
  assert.match(scenario.desktop.task.outboundText, /请补充缺失的日期与金额/);
  const sendIntentSnapshot = scenario.journals.find(entry => entry.steps.some(step => step.action === 'workbuddySend' && step.state === 'intent') && entry.followUpPending?.state === 'unknown');
  assert(sendIntentSnapshot, 'uncertain follow-up state was journaled before native send');
  assert.equal(sendIntentSnapshot.followUpRound, 1);
  assert.equal(sendIntentSnapshot.previousMonitorMessageKey, 'old-message-key');
  assert.equal(sendIntentSnapshot.monitorMessageKey, null);
  assert.equal(sendIntentSnapshot.followUpAwaitingMonitor, true);
  assert.equal(sendIntentSnapshot.submittedAt, sendIntentSnapshot.followUpPending.submittedAt);
  assert.equal(sendIntentSnapshot.followUpHistory.at(-1).round, 1);
  assert.match(sendIntentSnapshot.followUpHistory.at(-1).outboundText, /请补充缺失的日期与金额/);
  const rejectedRepeat = await scenario.desktop.followUp({ text: '请再发一次刚才的追问。' });
  assert.equal(rejectedRepeat.ok, false, 'an unknown send cannot be retried before new Monitor evidence');
  assert.equal(scenario.native.sends, 1);
}

async function withFastPolls(fn) {
  const original = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => original(callback, ms >= 1000 ? 1 : ms, ...args);
  try { return await fn(); } finally { global.setTimeout = original; }
}

async function testUncertainFollowUpBindsOnlyNewReply() {
  const s = createScenario({ newReply: true });
  try {
    await prepareUncertainFollowUp(s);
    const result = await s.secretary.dispatch({ action: 'resume' }, { requestId: 'resume-new-followup', userText: '继续刚才的代办', source: 'text' });
    assert.match(result.text, /接着核对原任务/);
    await until(() => s.desktop.task.status === 'accepted', 'new follow-up reply verification');
    assert.equal(s.native.sends, 1, 'resume only observes; it never repeats the uncertain send');
    assert.equal(s.verified.length, 1);
    assert.equal(s.verified[0].monitorMessageKey, 'new-followup-message-key', 'only the distinct new message is verified');
    assert.match(s.verified[0].summary, /新回复/);
    assert.equal(s.desktop.task.followUpPending.state, 'observed');
    assert.equal(s.reports.length, 1, 'the result is reported once');
    assert.equal(s.reports[0].taskId, s.task.id);
    assert.equal(s.plannerCalls.length, 0, 'recovery stays on the read-only Monitor path');
  } finally { s.secretary.close(); await s.desktop.close(); }
}

async function testOldReplyCannotCompleteOrTriggerAnotherFollowUp() {
  const s = createScenario({ newReply: false });
  try {
    await prepareUncertainFollowUp(s);
    await withFastPolls(async () => {
      const result = await s.secretary.dispatch({ action: 'resume' }, { requestId: 'resume-no-new-followup', userText: '继续刚才的代办', source: 'text' });
      assert.match(result.text, /接着核对原任务/);
      await until(() => !s.desktop.running && ['paused', 'review'].includes(s.desktop.task.status), 'resume without a new message');
    });
    assert.equal(s.desktop.task.status, 'paused', 'the polling limit pauses when no distinct follow-up message can be bound');
    assert.equal(s.verified.length, 0, 'the old message is never passed to delivery verification');
    assert.equal(s.native.sends, 1, 'no second follow-up is sent');
    assert.equal(s.plannerCalls.length, 0, 'a stale old reply does not enter visual acceptance');
    assert.notEqual(s.desktop.task.followUpPending.state, 'observed');
  } finally { s.secretary.close(); await s.desktop.close(); }
}

async function main() {
  await testUncertainFollowUpBindsOnlyNewReply();
  await testOldReplyCannotCompleteOrTriggerAnotherFollowUp();
  console.log('Follow-up uncertainty recovery checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
