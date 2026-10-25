'use strict';

const assert = require('node:assert/strict');
const { Secretary } = require('../src/main/secretary');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function waitFor(predicate, timeoutMs = 1500) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out waiting for secretary');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const intent = (target = 'workbuddy') => ({ action: 'start', target, goal: '整理项目交付', criteria: '回复中列出交付与验证', ...(target === 'wechat' ? { recipient: '文件传输助手' } : {}) });

class FakeDesktop {
  constructor() {
    this.task = null; this.running = false; this.starting = false; this.generation = 0;
    this.startCalls = []; this.stopCalls = []; this.acceptCalls = []; this.followUpCalls = []; this.journalCalls = [];
  }
  async start(options) {
    this.startCalls.push(options); this.starting = true; this.running = true;
    const id = `task-${this.startCalls.length}`;
    this.task = { id, ...options, status: 'running', startedAt: Date.now(), updatedAt: Date.now(), steps: [] };
    this.starting = false;
    return { ok: true, id };
  }
  async stop(reason) {
    this.stopCalls.push(reason); this.generation++; this.running = false; this.starting = false;
    if (this.task) Object.assign(this.task, { status: 'stopped', note: reason, updatedAt: Date.now() });
    return { ok: true };
  }
  update(patch) { Object.assign(this.task, patch); }
  publicStatus() { return { running: this.running, task: this.task ? { ...this.task } : null }; }
  async journal() { this.journalCalls.push({ ...this.task }); }
  async accept(options) {
    this.acceptCalls.push(options); this.running = false;
    Object.assign(this.task, { status: 'accepted', automaticAccepted: !!options.automatic, note: options.report, updatedAt: Date.now() });
    return { ok: true };
  }
  async followUp(options) {
    this.followUpCalls.push({ ...options, sessionId: this.task.sessionId, taskId: this.task.monitorTaskId });
    this.task.followUpRound = (this.task.followUpRound || 0) + 1;
    this.task.followUpAwaitingMonitor = true;
    this.task.status = 'monitoring';
    return { ok: true, round: this.task.followUpRound, sessionId: this.task.sessionId };
  }
}

async function review(secretary, desktop, { monitorTaskId = 'monitor-1', updatedAt = Date.now(), screenshot = null } = {}) {
  Object.assign(desktop.task, { status: 'review', monitorTaskId, updatedAt });
  secretary.onStatus({ task: { ...desktop.task }, screenshot });
  const inFlight = secretary.verifying;
  if (inFlight) await inFlight;
}

async function testRequestDedupAndTurnIsolation() {
  const desktop = new FakeDesktop(), gate = deferred();
  desktop.start = async options => { desktop.startCalls.push(options); desktop.running = true; return desktop.startCalls.length === 1 ? gate.promise : { ok: true, id: 'task-2' }; };
  const secretary = new Secretary({ desktop, report: async () => {} });
  const first = secretary.dispatch(intent(), { requestId: 'turn-1', userText: '整理项目' });
  const duplicate = secretary.dispatch(intent(), { requestId: 'turn-1', userText: '整理项目' });
  assert.equal(first, duplicate, 'the same requestId returns the same in-flight operation');
  assert.equal(desktop.startCalls.length, 1);
  gate.resolve({ ok: true, id: 'task-1' });
  assert.deepEqual(await first, await duplicate);
  desktop.running = false;
  const secondTurn = await secretary.dispatch(intent(), { requestId: 'turn-2', userText: '另一项工作' });
  assert.notDeepEqual(secondTurn, await first, 'a distinct user turn does not reuse the prior request result');
  assert.equal(desktop.startCalls.length, 2);
  secretary.close();
}

async function testRunningTaskIsNeverOverwritten() {
  const desktop = new FakeDesktop();
  const existing = { id: 'already-running', origin: 'panel', status: 'monitoring', goal: '现有任务' };
  desktop.task = existing; desktop.running = true;
  const secretary = new Secretary({ desktop, report: async () => {} });
  const result = await secretary.dispatch(intent(), { requestId: 'new-turn', userText: '新的工作' });
  assert.match(result.text, /上一件事/);
  assert.equal(desktop.task, existing);
  assert.equal(desktop.startCalls.length, 0);
  secretary.close();
}

async function testIndependentPassAcceptsAndReportsOnce() {
  const desktop = new FakeDesktop(), reports = [];
  const secretary = new Secretary({ desktop, report: async value => reports.push(value), verify: async () => ({ verdict: 'pass', report: 'WorkBuddy 回复列出文件与验证结果。' }) });
  await secretary.dispatch(intent(), { requestId: 'pass-turn', userText: '整理项目' });
  await review(secretary, desktop, { screenshot: 'data:image/png;base64,fixture' });
  assert.equal(desktop.acceptCalls.length, 1);
  assert.equal(desktop.acceptCalls[0].automatic, true);
  assert.equal(desktop.task.status, 'accepted');
  assert.equal(reports.length, 1);
  assert.match(reports[0].text, /WorkBuddy 回复列出文件与验证结果/);
  secretary.onStatus({ task: { ...desktop.task, status: 'review' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(desktop.acceptCalls.length, 1);
  assert.equal(reports.length, 1, 'duplicate status notifications never duplicate acceptance or report');
  secretary.close();
}

async function testFollowUpsStayInWorkBuddySessionAndStopAtTwo() {
  const desktop = new FakeDesktop(), reports = [];
  const secretary = new Secretary({ desktop, report: async value => reports.push(value), verify: async () => ({ verdict: 'revise', report: '还缺少可检查的验证结果。', followUp: '请补充验证结果。' }) });
  await secretary.dispatch(intent(), { requestId: 'revise-turn', userText: '整理项目' });
  desktop.task.sessionId = 'wb-session-exact'; desktop.task.monitorSessionId = 'wb-session-exact'; desktop.task.monitorTaskId = 'monitor-0'; desktop.task.handoffSent = true;
  for (let i = 1; i <= 3; i++) await review(secretary, desktop, { monitorTaskId: `monitor-${i}`, updatedAt: 100 + i });
  assert.equal(desktop.followUpCalls.length, 2, 'revision requests are capped at two');
  assert(desktop.followUpCalls.every(call => call.sessionId === 'wb-session-exact'));
  assert.equal(desktop.startCalls.length, 1, 'follow-up reuses the bound WorkBuddy session rather than creating a task');
  assert.equal(desktop.task.status, 'paused', 'the third revise result waits for the user');
  assert.equal(reports.length, 1);
  secretary.close();
}

async function testWechatRevisionDoesNotResend() {
  const desktop = new FakeDesktop(), reports = [];
  const secretary = new Secretary({ desktop, report: async value => reports.push(value), verify: async () => ({ verdict: 'revise', report: '发送结果不确定，不能重发。', followUp: '再发一次。' }) });
  await secretary.dispatch(intent('wechat'), { requestId: 'wechat-turn', userText: '给对方发消息' });
  await review(secretary, desktop);
  assert.equal(desktop.followUpCalls.length, 0);
  assert.equal(desktop.startCalls.length, 1);
  assert.equal(desktop.task.status, 'paused');
  assert.equal(reports.length, 1);
  secretary.close();
}

async function testStopAndLockInvalidateLateChecks() {
  const desktop = new FakeDesktop(), gate = deferred();
  const secretary = new Secretary({ desktop, report: async () => {}, verify: () => gate.promise });
  await secretary.dispatch(intent(), { requestId: 'stop-turn', userText: '整理项目' });
  Object.assign(desktop.task, { status: 'review', monitorTaskId: 'monitor-1' });
  secretary.onStatus({ task: { ...desktop.task } });
  await waitFor(() => !!secretary.controller);
  await secretary.dispatch({ action: 'stop' }, { requestId: 'stop-request', userText: '暂停' });
  gate.resolve({ verdict: 'pass', report: '迟到的通过结果' });
  await secretary.verifying;
  assert.equal(desktop.acceptCalls.length, 0, 'stop cancels an in-flight verification and ignores late pass results');

  const desktop2 = new FakeDesktop(), gate2 = deferred(); let ready = true;
  const sec2 = new Secretary({ desktop: desktop2, ready: () => ready, report: async () => {}, verify: () => gate2.promise });
  await sec2.dispatch(intent(), { requestId: 'lock-turn', userText: '整理项目' });
  Object.assign(desktop2.task, { status: 'review', monitorTaskId: 'monitor-1' });
  sec2.onStatus({ task: { ...desktop2.task } });
  await waitFor(() => !!sec2.controller);
  ready = false;
  desktop2.generation++;
  Object.assign(desktop2.task, { status: 'paused', note: '本地记忆已锁定' });
  sec2.onStatus({ task: { ...desktop2.task } });
  gate2.resolve({ verdict: 'pass', report: '锁定后迟到的结果' });
  await sec2.verifying;
  assert.equal(desktop2.acceptCalls.length, 0, 'locked state blocks late verification results');
  secretary.close(); sec2.close();
}

async function testVoiceCommitAndCurrentTurnGate() {
  const desktop = new FakeDesktop();
  const secretary = new Secretary({ desktop, report: async () => {} });
  const uncommitted = await secretary.dispatch(intent(), { requestId: 'voice-uncommitted', userText: '整理项目', source: 'voice',
    voiceTurn: { waitForCommit: async () => false, isCurrent: () => true } });
  assert.match(uncommitted.text, /尚未被系统识别确认/);
  assert.equal(desktop.startCalls.length, 0);

  const stale = await secretary.dispatch(intent(), { requestId: 'voice-stale', userText: '整理项目', source: 'voice',
    voiceTurn: { waitForCommit: async () => true, isCurrent: () => false } });
  assert.match(stale.text, /没有发起操作/);
  assert.equal(desktop.startCalls.length, 0);

  let committed = 0;
  const turn = { waitForCommit: async () => { committed++; return true; }, isCurrent: () => true };
  const first = secretary.dispatch(intent(), { requestId: 'voice-confirmed-token', userText: '整理项目', source: 'voice', voiceTurn: turn });
  const duplicate = secretary.dispatch(intent(), { requestId: 'voice-confirmed-token', userText: '整理项目', source: 'voice', voiceTurn: turn });
  assert.equal(first, duplicate);
  await Promise.all([first, duplicate]);
  assert.equal(committed, 1);
  assert.equal(desktop.startCalls.length, 1, 'one confirmed voice token starts at most once');
  secretary.close();
}

async function testEpochChangeInvalidatesLateDeliveryCheck() {
  const desktop = new FakeDesktop(), gate = deferred(), reports = [];
  let epoch = 7;
  const secretary = new Secretary({ desktop, epoch: () => epoch, report: async value => reports.push(value), verify: () => gate.promise });
  await secretary.dispatch(intent(), { requestId: 'epoch-turn', userText: '整理项目' });
  Object.assign(desktop.task, { status: 'review', monitorTaskId: 'monitor-epoch' });
  secretary.onStatus({ task: { ...desktop.task } });
  await waitFor(() => !!secretary.controller);
  epoch++;
  gate.resolve({ verdict: 'pass', report: '旧记忆会话中的迟到验收结果' });
  await secretary.verifying;
  assert.equal(desktop.acceptCalls.length, 0, 'epoch changes invalidate in-flight acceptance');
  assert.equal(reports.length, 0, 'epoch changes prevent stale reports from being published');
  secretary.close();
}

async function testInternalAndRestartedTasksAreNotReplayed() {
  for (const task of [
    { id: 'internal', origin: 'panel', status: 'review', goal: 'internal task' },
    { id: 'restored', origin: 'dialogue', status: 'paused', goal: 'restored task', note: 'app restarted' },
  ]) {
    const desktop = new FakeDesktop(); desktop.task = task;
    const reports = []; let checks = 0;
    const secretary = new Secretary({ desktop, report: async value => reports.push(value), verify: async () => { checks++; return { verdict: 'pass', report: 'must not replay' }; } });
    secretary.onStatus({ task: { ...task } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(checks, 0);
    assert.equal(desktop.startCalls.length, 0);
    assert.equal(desktop.followUpCalls.length, 0);
    if (task.origin === 'panel') assert.equal(reports.length, 0);
    secretary.close();
  }
}

async function testPausedAndFailedTasksAreReported() {
  for (const status of ['paused', 'failed']) {
    const desktop = new FakeDesktop(), reports = [];
    const secretary = new Secretary({ desktop, report: async value => reports.push(value) });
    await secretary.dispatch(intent(), { requestId: `task-${status}-turn`, userText: '整理项目' });
    Object.assign(desktop.task, { status, note: '交付没有核验' });
    secretary.onStatus({ task: { ...desktop.task } });
    await waitFor(() => reports.length > 0);
    assert.match(reports[0].text, /交付没有核验/);
    secretary.close();
  }
}

async function testExplicitResumePreservesTaskAndPrivacy() {
  const desktop = new FakeDesktop(), reports = [];
  const original = { id: 'old-task', origin: 'dialogue', status: 'paused', goal: '原任务',
    userRequest: '原始用户交代', privacyEpoch: 3, sources: ['original-user'], steps: [], reportedAt: 1 };
  desktop.task = original;
  let resumed = 0;
  desktop.resume = async options => {
    resumed++;
    assert.equal(desktop.task, original);
    assert.equal(options.privacyEpoch, 3);
    assert.deepEqual(options.sources, ['original-user', 'resume-user']);
    delete desktop.task.reportedAt;
    desktop.task.status = 'review'; desktop.task.monitorMessageKey = 'stable-message';
    return { ok: true, id: original.id };
  };
  const secretary = new Secretary({ desktop, epoch: () => 3, report: async item => reports.push(item),
    verify: async () => ({ verdict: 'pass', report: '已核对原结果' }) });
  const result = await secretary.dispatch({ action: 'resume' }, { requestId: 'resume-old', userText: '继续刚才这件', sources: ['resume-user'], source: 'text' });
  if (secretary.verifying) await secretary.verifying;
  assert.equal(result.taskId, 'old-task');
  assert.equal(original.userRequest, '原始用户交代');
  assert.equal(desktop.startCalls.length, 0);
  assert.equal(resumed, 1);
  assert.equal(desktop.acceptCalls.length, 1);
  assert.equal(reports.length, 1);
  secretary.close();

  const stale = new Secretary({ desktop, epoch: () => 4, report: async () => {} });
  original.status = 'paused';
  const refused = await stale.dispatch({ action: 'resume' }, { requestId: 'stale-resume', userText: '继续' });
  assert.match(refused.text, /记忆来源已变更/);
  assert.equal(resumed, 1, 'changed privacy epochs cannot replay old tasks');
  stale.close();
}

async function testReviewDoesNotSpinOrLeaveFailedAcceptanceRunning() {
  const desktop = new FakeDesktop(), reports = [];
  let ready = true, checks = 0;
  const secretary = new Secretary({ desktop, ready: () => ready, report: async item => reports.push(item),
    verify: async () => { checks++; return { verdict: 'pass', report: '证据已核对' }; } });
  await secretary.dispatch(intent(), { requestId: 'review-readiness', userText: '整理项目' });
  desktop.task.status = 'review'; desktop.task.monitorMessageKey = 'one-message';
  ready = false;
  secretary.onStatus(desktop.publicStatus());
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(secretary.verifying, null, 'a locked memory must not schedule a self-repeating microtask');
  assert.equal(checks, 0);
  ready = true;
  desktop.accept = async () => ({ ok: false, error: '验收状态冲突' });
  secretary.onStatus(desktop.publicStatus());
  await secretary.verifying;
  assert.equal(desktop.task.status, 'paused');
  assert.match(reports[0].text, /验收状态冲突/);
  desktop.task.status = 'review';
  secretary.onStatus(desktop.publicStatus());
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(checks, 1, 'duplicate completion of the same message cannot spin or recheck');
  secretary.close();
}

async function main() {
  await testRequestDedupAndTurnIsolation();
  await testRunningTaskIsNeverOverwritten();
  await testIndependentPassAcceptsAndReportsOnce();
  await testFollowUpsStayInWorkBuddySessionAndStopAtTwo();
  await testWechatRevisionDoesNotResend();
  await testStopAndLockInvalidateLateChecks();
  await testVoiceCommitAndCurrentTurnGate();
  await testEpochChangeInvalidatesLateDeliveryCheck();
  await testInternalAndRestartedTasksAreNotReplayed();
  await testPausedAndFailedTasksAreReported();
  await testExplicitResumePreservesTaskAndPrivacy();
  await testReviewDoesNotSpinOrLeaveFailedAcceptanceRunning();
  console.log('Secretary lifecycle checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
