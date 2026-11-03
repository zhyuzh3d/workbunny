'use strict';
// Explicitly invoked live acceptance only; not included in npm test.
// Default creates a harmless WorkBuddy chat; --wechat sends one test to self.
const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DesktopService } = require('../src/main/desktop-service');
const { DesktopNative } = require('../src/main/desktop-native');
const { Monitor } = require('../src/main/monitor');
const { observeWorkBuddy } = require('../src/main/workbuddy-observation');
const wb = require('../src/main/workbuddy');
const { Secretary } = require('../src/main/secretary');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-task-live-'));
app.setPath('userData', temporary);
const wechat = process.argv.includes('--wechat'), sleep = ms => new Promise(r => setTimeout(r, ms));
let service, monitor;
async function verifyCollectedTask() {
  const receipts = [];
  service.task.origin = 'dialogue';
  const secretary = new Secretary({ desktop: service, report: async report => receipts.push(report), ready: () => true,
    getScene: () => 'life', epoch: () => 0, maxFollowUps: 0 });
  secretary.taskEpochs.set(service.task.id, 0);
  secretary.onStatus(service.publicStatus()); await secretary.verifying;
  assert.equal(service.task.status, 'accepted', 'actual verifier did not accept the collected reply');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'accepted');
  secretary.close(); console.log(JSON.stringify({ resultCollection: true, actualVerification: service.task.verification?.verdict, reports: receipts.length }));
}
async function run() {
  await app.whenReady();
  await require('../src/main/model-catalog').refresh('workbuddy');
  monitor = new Monitor(); monitor.start(path.join(os.homedir(), '.workbuddy/projects'));
  const journals = [];
  service = new DesktopService({ native: new DesktopNative(path.resolve('bin/desktop')), observeWorkBuddy: task => observeWorkBuddy(monitor, task),
    imageCrop: (png, rect) => nativeImage.createFromBuffer(png).crop(rect).toPNG(),
    persist: async task => journals.push({ id: task.id, status: task.status, submitAttemptedAt: task.submitAttemptedAt, handoffSent: task.handoffSent }),
    imageResize: png => { const image = nativeImage.createFromBuffer(png), size = image.getSize(); return image.resize({ width: Math.min(1280, size.width) }).toPNG(); },
    ...(wechat ? { modelRequest: opts => wb.chat({ ...opts, model: 'deepseek-v4.1-flash', thinking: 'low', maxTokens: 1500, timeoutMs: 20000, extraBody: { reasoning_effort: 'low', response_format: { type: 'json_object' } } }) } : {}),
    emit: status => { if (status.task?.status !== run.last) { run.last = status.task?.status; console.log(JSON.stringify({ target: wechat ? 'wechat' : 'workbuddy', phase: run.last })); } } });
  if (process.argv.includes('--verify-last')) {
    const snapshots = [...monitor.sessions.values()].map(v => v.snap);
    const candidates = [...new Map(snapshots.flatMap(s => [s.task, ...(s.history || [])].filter(t => t?.bunnyTaskId && t.userText?.startsWith('请只回复“Bunny委派链路验收通过”') && t.startedAt > Date.now() - 3600000 && t.summary?.includes('Bunny委派链路验收通过')).map(t => [s.sessionId + ':' + t.id, { s, t }]))).values()];
    assert.equal(candidates.length, 1, 'one exact recent synthetic task is required');
    const { s, t } = candidates[0];
    service.task = { id: t.bunnyTaskId, goal: '请只回复“Bunny委派链路验收通过”。不要读取、创建或修改任何文件，不要调用工具，不要发送任何消息。',
      criteria: '真实助手正文包含Bunny委派链路验收通过；没有操作文件。', target: 'workbuddy', status: 'review', startedAt: t.startedAt, steps: [],
      scene: 'life', domain: 'work', visibilityFloor: 1, monitorSessionId: s.sessionId, sessionId: s.sessionId,
      monitorTaskId: t.id, monitorMessageKey: t.messageKey, monitorSummary: t.summary, evidence: '绑定会话的实际助手答复', handoffSent: true };
    await verifyCollectedTask(); return;
  }
  const text = wechat ? 'Bunny 功能验收：这是一条发给文件传输助手的测试提醒，无需处理。' : '请只回复“Bunny委派链路验收通过”。不要读取、创建或修改任何文件，不要调用工具，不要发送任何消息。';
  const start = await service.start({ target: wechat ? 'wechat' : 'workbuddy', workModel: 'deepseek-v4.1-flash',
    goal: text, criteria: wechat ? '文件传输助手会话出现指定完整已发送气泡，不能只是草稿。' : '真实助手正文包含Bunny委派链路验收通过；没有操作文件。',
    ...(wechat ? { origin: 'notification', recipient: '文件传输助手', operation: 'send', message: text, inputSource: 'text' } : {}) });
  assert(start.ok, 'live task did not start: ' + start.error);
  const deadline = Date.now() + (wechat ? 130000 : 150000);
  while (service.running && Date.now() < deadline) await sleep(200);
  const task = service.task;
  if (task.status !== 'review' && task.status !== 'skipped') console.log(JSON.stringify({ diagnosis: task.note, steps: task.steps.map(s => ({ action: s.action, state: s.state, purpose: s.purpose })) }));
  if (wechat && task.status === 'skipped') { console.log(JSON.stringify({ skipped: true, reason: 'wechat-login-unavailable' })); return; }
  assert.equal(task.status, 'review', 'live task did not reach a verified observation; inspect the local app');
  if (wechat) assert.equal(task.sendState, 'confirmed');
  else {
    assert.equal(task.handoffSent, true); assert(task.monitorSessionId);
    assert(task.monitorSummary.includes('Bunny委派链路验收通过') || task.monitorEvidence.includes('Bunny委派链路验收通过'));
    assert(journals.some(r => r.submitAttemptedAt), 'submission intent was persisted');
  }
  console.log(JSON.stringify({ passed: true, target: wechat ? 'wechat-self' : 'workbuddy', steps: task.steps.length,
    sessionMonitorBound: !!task.monitorSessionId, sendState: task.sendState || null }));
}
run().then(() => finish(0), e => { console.error(e.message); finish(1); });
async function finish(code) { monitor?.stop(); await service?.close(); fs.rmSync(temporary, { recursive: true, force: true }); app.exit(code); }
