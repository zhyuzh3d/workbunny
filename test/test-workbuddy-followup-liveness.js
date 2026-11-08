'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DesktopService, WECHAT_RULE } = require('../src/main/desktop-service');
const immediateDelay = async fn => {
  const original = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => original(callback, ms === 1200 ? 0 : ms, ...args);
  try { return await fn(); } finally { global.setTimeout = original; }
};

test('a bound monitor that repeatedly disappears pauses without changing task identity', async () => immediateDelay(async () => {
  let calls = 0;
  const native = { close() {}, cancel() {} };
  const svc = new DesktopService({ native, observeWorkBuddy: async () => ++calls === 1
    ? { sessionId: 'session-a', taskId: 42, messageKey: 'stable-a', status: 'running', updatedAt: Date.now() } : null });
  svc.task = { id: 'task-a', target: 'workbuddy', scene: 'life', domain: 'work', visibilityFloor: 1,
    submittedAt: Date.now(), handoffSent: true, sessionId: 'session-a', monitorTaskId: 42, monitorMessageKey: 'stable-a', steps: [] };
  svc.running = true; const generation = svc.generation;
  await svc.monitorWorkBuddy(generation, {});
  assert.equal(svc.task.status, 'paused'); assert.equal(svc.running, false);
  assert.equal(svc.task.sessionId, 'session-a'); assert.equal(svc.task.monitorMessageKey, 'stable-a');
  assert.match(svc.task.note, /不会重发/); assert.equal(calls, 26);
  await svc.close();
}));

function visualFixture(model) {
  const rect = { x: 0, y: 0, width: 800, height: 600 }, calls = [];
  const marker = '[workbunny:11111111-1111-4111-8111-111111111111]';
  let typed = '';
  const native = {
    async request(op, payload = {}) {
      calls.push({ op, payload });
      if (op === 'frontmost') return { application: { bundleId: 'com.tencent.workbuddy.mac', pid: 11 }, windows: [{ windowId: 1, pid: 11, layer: 0, rect }] };
      if (op === 'capture') return { pngBase64: Buffer.from('fixture').toString('base64'), desktopRect: rect };
      if (op === 'recognize') return { texts: [
        { text: marker, confidence: .99, x: .4, y: .2 },
        { text: model === 'free' ? 'Hy3' : 'DeepSeek-V4.1-Flash', confidence: .99, x: .4, y: .49, width: .08, height: .02 },
        ...(model === 'free' ? [{ text: '0.00x', confidence: .99, x: .5, y: .49, width: .03, height: .02 }] : []),
        { text: typed || '输入消息', confidence: .99, x: .4, y: .75 },
      ] };
      if (op === 'type') typed = payload.text;
      if (op === 'workbuddyInspect') return {scanComplete:true,editorCount:1,conversationReady:true,associationMarkerPresent:payload.marker===marker,draftEmpty:!typed,draftMatchesRequest:typed===payload.text};
      return {};
    }, cancel() {}, close() {},
  };
  let plans = 0;
  const svc = new DesktopService({ native, planner: async () => ++plans === 1
    ? { action: 'type', purpose: 'task', text: 'placeholder', focus: { x: .5, y: .75 } }
    : { action: 'key', purpose: 'submit', key: 'enter', modifiers: [] },
    observeWorkBuddy: async task => ({ sessionId: 'session-a', taskId: task.followUpAwaitingMonitor ? 2 : 1,
      messageKey: task.followUpAwaitingMonitor ? 'new' : 'old', status: task.followUpAwaitingMonitor ? 'ok' : 'running', updatedAt: Date.now() }) });
  svc.task = { id: '11111111-1111-4111-8111-111111111111', target: 'workbuddy', scene: 'life', domain: 'work', visibilityFloor: 1,
    workModel: 'hy3', associationMarker: marker, handoffSent: true, sessionId: 'session-a', monitorTaskId: 1,
    monitorMessageKey: 'old', followUpRound: 0, status: 'review', steps: [], goal: 'fixture' };
  return { svc, calls };
}

test('Hy3 follow-up uses visible free-model proof and preserves the original session', async () => {
  const { svc, calls } = visualFixture('free');
  const result = await svc.followUp({ text: '请核对上一项结果' });
  assert.equal(result.ok, true, result.error); assert.equal(result.sessionId, 'session-a');
  assert.equal(result.submission,'pending');
  const outbound=calls.find(c=>c.op==='type').payload.text;assert(!outbound.includes(WECHAT_RULE));assert(!outbound.includes('微信'));assert(!outbound.includes('不得操作通讯软件'));
  assert.equal(calls.filter(c => c.op === 'type').length, 1);
  assert.equal(calls.filter(c => c.op === 'key').length, 1);
  assert.equal(calls.some(c => ['workbuddyFill','workbuddySend'].includes(c.op)), false);
  assert.equal(calls.filter(c=>c.op==='workbuddyInspect').length,1);
  await svc.close();
});

test('Hy3 follow-up refuses a visible paid-model selection before typing', async () => {
  const { svc, calls } = visualFixture('paid');
  const result = await svc.followUp({ text: '请核对上一项结果' });
  assert.equal(result.ok, false); assert.match(result.error, /原任务模型/);
  assert.equal(calls.some(c => ['type', 'key', 'workbuddyFill', 'workbuddySend'].includes(c.op)), false);
  await svc.close();
});

test('an owner-initiated visual continuation uses the shared production boundary without channel instructions',async()=>{
 const {svc,calls}=visualFixture('free');
 const text='发布已完成的网站并返回真实链接；保留现有文件';
 const result=await svc.followUp({text,ownerInitiated:true});assert.equal(result.ok,true,result.error);
 const outbound=calls.find(c=>c.op==='type').payload.text;assert(outbound.startsWith(text));assert(!outbound.includes(WECHAT_RULE));assert(!outbound.includes('文件传输助手'));assert(!outbound.includes('不得操作通讯软件'));
 assert.equal(svc.task.followUpHistory.at(-1).outboundText,outbound);await svc.close();
});
test('follow-up protects the complete envelope including criteria before either input path receives it',async()=>{
 const {svc,calls}=visualFixture('free');svc.task.criteria='private-scope-parameter';let prepared;
 svc.sensitivePolicy.prepareWorkBuddy=async text=>{prepared=text;return {text:text.replaceAll('private-scope-parameter','protected-parameter')};};
 const text='补充真实结果';const result=await svc.followUp({text});assert.equal(result.ok,true,result.error);
 assert(prepared.includes('private-scope-parameter'));assert(!prepared.includes('不得操作通讯软件'));
 const typed=calls.find(c=>c.op==='type').payload.text;assert(typed.includes('protected-parameter'));assert(!typed.includes('private-scope-parameter'));assert.equal(svc.task.followUpHistory.at(-1).text,text);await svc.close();
});
