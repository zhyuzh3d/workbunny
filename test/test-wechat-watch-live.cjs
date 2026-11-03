'use strict';
// Explicit, supervised real-WeChat acceptance. One authorized fixed reply only.
// No startup restore and no retry of a send, including an uncertain send.
const { app, nativeImage } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { DesktopNative } = require('../src/main/desktop-native');
const { DesktopService } = require('../src/main/desktop-service');
const { WeChatObserver } = require('../src/main/wechat-observer');
const { WatchService } = require('../src/main/watch-service');
const { prepareVisionPreview } = require('../src/main/vision-preview');
const { verifyDelivery } = require('../src/main/secretary');
const wb = require('../src/main/workbuddy');
const recipient = 'Alice', reply = '收到，这是 Bunny 自动回复测试。';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wechat-watch-live-'));
fs.chmodSync(directory, 0o700); app.setPath('userData', path.join(directory, 'electron'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const counts = {}, captures = [], decisions = [], reports = [], operations = [], events = new Map(), receipts = new Set();
let desktop, observer, watcher, native, sendInvocations = 0, readyAt, watchId;
function trace(event) { console.log(JSON.stringify({ at: Date.now(), ...event })); }
async function execute(w, { operation, message, signal }) {
  assert.equal(w.recipient, recipient);
  if (operation === 'send') {
    assert.equal(message, reply, 'only the owner-approved exact response may be sent');
    assert.equal(sendInvocations, 0, 'this supervised run allows one send invocation');
    // Durable gate precedes even drafting. This runner never resumes a send.
    sendInvocations++;
    save('send-intent.json', { recipient, message, at: Date.now(), sendInvocations });
  } else assert.equal(operation, 'open');
  const stop = () => { void desktop.stop('短时监听测试已停止'); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const started = await desktop.start({ target: 'wechat', recipient, operation, message,
      origin: 'watch', inputSource: 'text', scene: 'life', visibilityFloor: 1, sources: [w.id], privacyEpoch: 1,
      goal: operation === 'send' ? `只给「Alice」发送这段完整原文一次：${reply}` : '打开微信会话「Alice」，确认顶部标题精确匹配。允许在顶部搜索框搜索指定联系人，type必须标记purpose:navigation；禁止在聊天编辑区输入正文、发送或修改草稿，不向上翻历史。',
      criteria: operation === 'send' ? 'Alice 会话出现本次新增的完整已发送气泡，输入框清空，只有一次发送。' : '顶部会话标题精确为 Alice。', workModel: 'deepseek-v4.1-flash' });
    if (!started.ok) return started;
    const deadline = Date.now() + 150000;
    while (desktop.running && Date.now() < deadline && !signal?.aborted) await sleep(200);
    if (signal?.aborted) return { ok: false, error: '监听已停止' };
    if (desktop.running) { await desktop.stop('短时测试操作超时；保留结果，不重发'); return { ok: false, error: '操作超时' }; }
    const task = desktop.task;
    trace({ desktopCompleted: operation, status: task.status, sendState: task.sendState });
    if (task.status !== 'review') return { ok: false, error: task.note };
    if (operation === 'send') {
      assert.equal(task.sendState, 'confirmed');
      const verified = await verifyDelivery({ task, screenshot: desktop.publicStatus().screenshot, signal });
      save('delivery.json', verified);
      if (verified.verdict !== 'pass') return { ok: false, error: verified.report };
      await desktop.accept({ automatic: true, report: verified.report });
    }
    return { ok: true, windowId: task.scope?.windowId };
  } finally { signal?.removeEventListener('abort', stop); }
}
async function run() {
  await app.whenReady();
  await require('../src/main/model-catalog').refresh('workbuddy');
  native = new DesktopNative(path.resolve('bin/desktop'));
  const raw = native.request.bind(native);
  native.request = async (op, payload, timeout) => {
    assert(['inputIdle','permissions','activate','frontmost','capture','recognize','click','key','type','scroll','visualSample','visualCommit','visualForget'].includes(op), 'no application-specific inspection or API is allowed');
    const operation = { op, beganAt: Date.now(),
      ...(['click','scroll'].includes(op) ? { x: payload?.x, y: payload?.y } : {}) };
    operations.push(operation); save('operations.json', operations);
    counts[op] = (counts[op] || 0) + 1;
    if (op === 'capture') assert(payload.captureMode === 'displayStream' && !payload.windowId);
    let result;
    try { result = await raw(op, payload, timeout); }
    catch (error) { operation.error = error.message; operation.endedAt = Date.now(); save('operations.json', operations); trace({ systemOperationFailed: op, reason: error.message }); throw error; }
    operation.endedAt = Date.now();
    if (op === 'frontmost') operation.visibleTargetWindows = result.windows.filter(w => w.bundleId === 'com.tencent.xinWeChat').map(w => ({ id: w.windowId, pid: w.pid, rect: w.rect }));
    if (['capture','visualSample'].includes(op) && result.pngBase64) fs.writeFileSync(path.join(directory, `latest-${op}.png`), Buffer.from(result.pngBase64,'base64'), { mode: 0o600 });
    save('operations.json', operations);
    if (op !== 'inputIdle' && op !== 'frontmost' && op !== 'recognize') trace({ systemOperation: op, finished: true });
    if (op === 'capture') captures.push({ backend: result.backend, capturedAt: result.capturedAt, width: result.width, height: result.height });
    return result;
  };
  const resize = png => prepareVisionPreview(nativeImage.createFromBuffer(png));
  desktop = new DesktopService({ native, imageResize: resize,
    imageCrop: (png, rect) => nativeImage.createFromBuffer(png).crop(rect).toPNG(),
    persist: async task => save('desktop-task.json', task),
    modelRequest: options => wb.chat({ ...options, thinking: 'low', timeoutMs: 25000,
      extraBody: { reasoning_effort: 'low', response_format: { type: 'json_object' } } }),
    emit: status => {
      const key = `${status.task?.status}:${status.task?.note}`;
      if (execute.lastPhase !== key) { execute.lastPhase = key; trace({ desktopPhase: status.task?.status, operation: status.task?.operation }); }
    },
  });
  observer = new WeChatObserver({ native, imageResize: resize });
  watcher = new WatchService({
    journal: {
      eventId: (id, key) => crypto.createHash('sha256').update(id + '\0' + key).digest('hex'),
      saveWatch: async w => { save('watch.json', w); return structuredClone(w); },
      listWatches: async () => [], getEvent: async id => structuredClone(events.get(id)),
      saveEvent: async (w, e) => { events.set(e.id, structuredClone(e)); save('events.json', [...events.values()]); },
      receipt: async (event, text) => { const inserted = !receipts.has(event.id); receipts.add(event.id); save('receipt-ids.json', [...receipts]); return { inserted, text }; },
    }, sensor: observer,
    inspect: async (w, frame, signal) => {
      const view = await observer.inspect(w, frame, signal);
      if (!view.headerMatched && frame.pngBase64) fs.writeFileSync(path.join(directory, 'header-missing.png'), Buffer.from(frame.pngBase64,'base64'), { mode: 0o600 });
      trace({ inspected: true, headerMatched: view.headerMatched, visibleMessages: view.messages.length,
        verifiedIncoming: view.messages.filter(m => m.incomingVerified).length, draftPresent: !!view.draft });
      return view;
    },
    propose: async (w, message, signal) => {
      const decision = await observer.propose(w, message, signal);
      if (decision.reply) assert.equal(decision.reply, reply, 'model output differs from approved exact response');
      decisions.push({ at: Date.now(), incomingVerified: message.incomingVerified, kind: message.kind,
        incomingSha256: crypto.createHash('sha256').update(message.text).digest('hex'),
        notify: decision.notify, complete: decision.complete, fixedReply: decision.reply === reply });
      save('decisions.json', decisions); trace({ decision: decisions.at(-1) }); return decision;
    }, execute, report: async report => { reports.push({ eventId: report.eventId, at: Date.now() }); trace({ reportRecorded: true }); },
    epoch: () => 1, ready: () => true,
    canOperate: async () => !desktop.running && (await native.request('inputIdle')).hidIdleMs >= 8000,
    autoSchedule: false,
  });
  const start = await watcher.start({ recipient, goal: '短时监控 Alice：只处理建立基线后收到的第一条新纯文本消息，固定回复一次，随后停止。',
    criteria: '新收到 Alice 的消息后只回复一次授权原句，然后结束。', sources: ['owner-authorized-alice-one-reply-2026-11-02'],
    watch: { mode: 'reply', policy: `只对建立基线后 Alice 发来的第一条新纯文本消息回复一次，回复原文必须是「${reply}」。完成这一次就结束。旧消息绝不回复；非文本消息只通知。`,
      completion: 'first_match', intervalSeconds: 10, durationMinutes: 8 } });
  assert(start.ok, start.error); watchId = start.id;
  trace({ started: true, directory, recipient, authorizedReply: reply });
  const bindingDeadline = Date.now() + 180000;
  let finalState;
  while (true) {
    if (fs.existsSync(path.join(directory, 'STOP'))) break;
    await watcher.tick(watchId);
    const w = watcher.items.get(watchId); finalState = w;
    trace({ watchStatus: w.status, baselineReady: w.baselineReady, quietChecks: w.quietChecks || 0,
      visionChecks: w.visionChecks || 0, eventCount: w.eventCount, sendInvocations });
    if (w.baselineReady && !readyAt) {
      readyAt = Date.now(); w.expiresAt = readyAt + 300000;
      trace({ readyForIncoming: true, deadline: w.expiresAt });
    }
    if (['paused', 'stopped', 'expired'].includes(w.status)) break;
    if (!readyAt && Date.now() > bindingDeadline) break;
    if (readyAt && Date.now() > readyAt + 305000) break;
    await sleep(10000);
  }
  const confirmed = [...events.values()].filter(e => e.phase === 'sent_confirmed');
  const result = { recipient, reply, readyAt, finishedAt: Date.now(), status: finalState?.status,
    baselineEstablished: !!readyAt, quietChecks: finalState?.quietChecks || 0, visionChecks: finalState?.visionChecks || 0,
    sendInvocations, confirmedReplies: confirmed.length, eventCount: finalState?.eventCount || 0,
    captures, nativeCalls: counts, decisions, reports, actualWeChatUsed: true, installedAppUpdated: false,
    stopped: true, reason: confirmed.length ? 'one-reply-completed' : readyAt ? 'no-confirmed-reply-before-stop' : 'baseline-unavailable' };
  if (watchId) await watcher.control('stop', { id: watchId });
  save('result.json', result); trace({ finished: result, directory });
}
run().then(() => finish(0), async error => {
  save('error.json', { reason: error.message, at: Date.now(), sendInvocations });
  trace({ failed: error.message, directory, sendInvocations });
  if (watchId) await watcher?.control('stop', { id: watchId }).catch(() => {});
  await finish(1);
});
async function finish(code) { await watcher?.close(); await desktop?.close(); await native?.close(); app.exit(code); }
