'use strict';
// Explicitly invoked live acceptance only; never included in npm test.
// Run only when the desktop is available:
//   node_modules/.bin/electron test/test-workbuddy-lifecycle-live.cjs
// Creates one harmless WorkBuddy conversation and a single follow-up; does not
// read or modify a user project and does not intentionally invoke tools or send messages.
const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DesktopService, makeWorkBuddyOutbound } = require('../src/main/desktop-service');
const { spawnSync } = require('node:child_process');
const { DesktopNative } = require('../src/main/desktop-native');
const { Monitor } = require('../src/main/monitor');
const { observeWorkBuddy } = require('../src/main/workbuddy-observation');
const { Secretary } = require('../src/main/secretary');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wb-lifecycle-'));
const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wb-lifecycle-journal-'));
const journalFile = path.join(journalDir, 'task.jsonl');
fs.writeFileSync(journalFile, '', { mode: 0o600, flag: 'wx' });
app.setPath('userData', temporary);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const first = 'Bunny生命周期第一轮通过', second = 'Bunny生命周期第二轮通过';
let service, monitor, secretary;

async function waitReview(label, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (service.running && Date.now() < deadline) await sleep(250);
  if (service.running) { await service.stop(`${label}验收超时`); throw new Error(`${label}超过等待上限，已停止本地监督`); }
  const task = service.task;
  assert.equal(task?.status, 'review', `${label}未进入结果核对：${task?.note || '无任务'}`);
  assert.equal(task.handoffSent, true); assert(task.monitorSessionId && task.monitorMessageKey);
  return task;
}
function exactCurrentRow(task) {
  const matches = [...monitor.sessions.values()].flatMap(({ snap }) => snap?.sessionId === task.monitorSessionId
    ? [snap.task].filter(row => row?.messageKey === task.monitorMessageKey && row?.bunnyTaskId === task.id) : []);
  assert.equal(matches.length, 1, '当前任务必须唯一绑定同一会话和消息');
  assert.equal(matches[0].steps, 0, '问答过程中发现工具调用，停止验收');
  return matches[0];
}
async function run() {
  await app.whenReady();
  await require('../src/main/model-catalog').refresh('workbuddy');
  monitor = new Monitor(); monitor.start(path.join(os.homedir(), '.workbuddy/projects'));
  const writes = [];
  service = new DesktopService({ native: new DesktopNative(path.resolve('bin/desktop')),
    observeWorkBuddy: task => observeWorkBuddy(monitor, task),
    persist: async task => { fs.appendFileSync(journalFile, JSON.stringify(task) + '\n', { mode: 0o600 }); writes.push({ id: task.id, status: task.status, steps: (task.steps || []).map(s => ({ action: s.action, purpose: s.purpose, state: s.state })) }); },
    imageResize: png => { const image = nativeImage.createFromBuffer(png), size = image.getSize(); return image.resize({ width: Math.min(1280, size.width) }).toPNG(); },
    emit: state => { if (state.task?.status !== run.last) { run.last = state.task?.status; console.log(JSON.stringify({ phase: run.last })); } },
  });
  const goal = `这是纯文字测试。第一轮只回复“${first}”。不要读取、创建或修改文件，不要使用工具，不要发送任何消息；之后按用户追问修改文字。`;
  console.log(JSON.stringify({ journal: journalFile }));
  const criteria = `根据后续追问，最终答复包含“${second}”。`;
  const recoveryId = process.env.WORKBUNNY_LIVE_RECOVER_ID;
  let taskId;
  if (recoveryId) {
    assert.equal(recoveryId, '69722ee1-2a7a-439b-9911-e690e8887f28', '只允许恢复已知测试任务');
    const marker = `[workbunny:${recoveryId}]`;
    const scan = spawnSync('rg', ['-l', '--fixed-strings', '--glob', '*.jsonl', marker, path.join(os.homedir(), '.workbuddy/projects')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(scan.status, 1, '原任务已出现于会话记录，或无法确认 Monitor 记录；停止恢复');
    const front = await service.native.request('frontmost', {}, 5000);
    assert.equal(front.application?.bundleId, 'com.tencent.workbuddy.mac', '必须先由用户切到原 WorkBuddy 窗口');
    const window = front.windows.find(w => w.pid === front.application.pid && w.layer === 0 && w.rect.width > 100 && w.rect.height > 80);
    assert(window, '找不到原 WorkBuddy 窗口');
    // The original journal was in memory and is gone. Preserve uncertainty of
    // its observed submit intent, never pretend the prior click did not happen.
    const estimatedAt = fs.statSync('/tmp/bunny-workbuddy-lifecycle-live.log').mtimeMs - 600000;
    const task = { id: recoveryId, bunnyTaskId: recoveryId, goal, taskText: goal, criteria, target: 'workbuddy',
      workModel: 'deepseek-v4.1-flash', thinking: 'high', origin: 'dialogue', inputSource: 'text', scene: 'life', domain: 'work',
      visibilityFloor: 1, recipient: '文件传输助手', recipientAliases: ['文件传输助手'], operation: 'general', sources: [], privacyEpoch: 0,
      associationMarker: marker, followUpRound: 0, status: 'paused', startedAt: estimatedAt, attemptStartedAt: estimatedAt,
      draftInserted: true, draftInsertedAt: estimatedAt, submitAttemptedAt: estimatedAt,
      steps: [{ action: 'unknown', purpose: 'submit', state: 'intent', at: estimatedAt, reason: '根据原日志 awaiting 阶段恢复，提交动作结果未知' }] };
    task.outboundText = makeWorkBuddyOutbound(task);
    const state = await service.native.request('workbuddyInspect', { expected: { bundleId: front.application.bundleId, pid: front.application.pid },
      windowId: window.windowId, text: task.outboundText }, 8000);
    assert(state.available && state.homeReady && state.editorCount === 1 && state.draftEmpty === false && state.draftMatchesRequest === true,
      '当前首页草稿未与原任务全文精确匹配；停止恢复');
    service.task = task;
    await service.journal();
    console.log(JSON.stringify({ recovered: recoveryId, draftMatches: true, priorSubmit: 'unknown', mode: 'read-only' }));
    const resumed = await service.resume({ privacyEpoch: 0, sources: [], scene: 'life' });
    assert(resumed.ok, `原任务只读恢复失败：${resumed.error}`);
    taskId = recoveryId;
  } else {
    const start = await service.start({ target: 'workbuddy', origin: 'dialogue', inputSource: 'text', privacyEpoch: 0, sources: [],
      workModel: 'deepseek-v4.1-flash', goal, criteria });
    assert(start.ok, `任务未启动：${start.error}`);
    taskId = start.id;
  }
  let task = await waitReview('第一轮');
  assert.equal(task.id, taskId); assert(task.monitorSummary.includes(first), '第一轮实际正文不符合要求');
  exactCurrentRow(task);
  const sessionId = task.monitorSessionId, firstMessageKey = task.monitorMessageKey;
  const initialSubmits = task.steps.filter(step => step.purpose === 'submit' || step.action === 'workbuddySend').length;
  assert.equal(initialSubmits, 1, '第一轮只允许一次提交意图');

  await service.stop('验收中暂停原任务');
  assert.equal(service.task.status, 'stopped');
  const resumed = await service.resume({ privacyEpoch: 0, sources: [], scene: 'life' });
  assert(resumed.ok, `原任务恢复失败：${resumed.error}`);
  task = await waitReview('暂停后恢复');
  assert.equal(task.id, taskId); assert.equal(task.monitorSessionId, sessionId); assert.equal(task.monitorMessageKey, firstMessageKey);
  assert.equal(task.steps.filter(step => step.purpose === 'submit' || step.action === 'workbuddySend').length, initialSubmits,
    '只读恢复不能再次提交原任务');
  exactCurrentRow(task);

  const follow = await service.followUp({ text: `请把上一次回答改为只回复“${second}”。不要读取、创建或修改文件，不要使用工具，不要发送任何消息。` });
  assert(follow.ok, `原会话追问未能提交：${follow.error}`);
  assert.equal(follow.sessionId, sessionId);
  task = await waitReview('追问');
  assert.equal(task.id, taskId); assert.equal(task.monitorSessionId, sessionId);
  assert.notEqual(task.monitorMessageKey, firstMessageKey, '追问必须绑定新的消息');
  assert.equal(task.followUpRound, 1); assert.equal(task.followUpPending?.state, 'observed');
  assert(task.monitorSummary.includes(second), '追问后的实际正文不符合要求');
  exactCurrentRow(task);
  assert.equal(task.steps.filter(step => step.purpose === 'submit' || step.action === 'workbuddySend').length, initialSubmits + 1,
    '追问只提交一次');

  const receipts = [];
  secretary = new Secretary({ desktop: service, report: async report => receipts.push(report), ready: () => true,
    getScene: () => 'life', epoch: () => 0, maxFollowUps: 0 });
  secretary.taskEpochs.set(taskId, 0); secretary.onStatus(service.publicStatus()); await secretary.verifying;
  assert.equal(service.task.status, 'accepted', '真实验收未接受最终答复');
  assert.equal(service.task.verification?.verdict, 'pass');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'accepted');
  assert(writes.every(row => row.id === taskId), '全过程应维持同一个 Bunny 任务');
  console.log(JSON.stringify({ passed: true, initialResponse: true, readOnlyResume: true, sameSessionFollowUp: true,
    finalResponse: true, actualVerification: 'pass', reports: receipts.length, toolCallsObserved: 0 }));
}
async function finish(code) {
  secretary?.close(); monitor?.stop(); await service?.close();
  fs.rmSync(temporary, { recursive: true, force: true }); app.exit(code);
}
run().then(() => finish(0), error => { console.error(error.message); void finish(1); });
