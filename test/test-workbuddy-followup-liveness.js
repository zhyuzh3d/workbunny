'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DesktopService, WECHAT_RULE } = require('../src/main/desktop-service');
const {boundaryVisual}=require('./support/workbuddy-boundary-visual-fixture.cjs');
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
  const marker = '[workbunny:11111111-1111-4111-8111-111111111111]';
  const visual=boundaryVisual({initial:{marker,mode:'conversation',model:model==='free'?'hy3':'deepseek-v4.1-flash'}}),calls=visual.calls;
  let plans = 0;
  const svc = new DesktopService({ ...visual, planner: async () => ++plans === 1
    ? { action: 'type', purpose: 'task', text: 'placeholder', focus: { x: .5, y: .75 } }
    : { action: 'key', purpose: 'submit', key: 'enter', modifiers: [] },
    observeWorkBuddy: async task => ({ sessionId: 'session-a', taskId: task.followUpAwaitingMonitor ? 2 : 1,
      messageKey: task.followUpAwaitingMonitor ? 'new' : 'old', status: task.followUpAwaitingMonitor ? 'ok' : 'running', updatedAt: Date.now() }) });
  svc.task = { id: '11111111-1111-4111-8111-111111111111', target: 'workbuddy', scene: 'life', domain: 'work', visibilityFloor: 1,
    workModel: 'hy3', associationMarker: marker, handoffSent: true, sessionId: 'session-a', monitorTaskId: 1,
    monitorMessageKey: 'old', followUpRound: 0, status: 'review', steps: [], goal: 'fixture' };
  return { svc, calls, visual };
}

test('Hy3 follow-up uses visible free-model proof and preserves the original session', async () => {
  const { svc, calls, visual } = visualFixture('free');
  const result = await svc.followUp({ text: '请核对上一项结果' });
  assert.equal(result.ok, true, result.error); assert.equal(result.sessionId, 'session-a');
  assert.equal(result.submission,'pending');
  const outbound=calls.find(c=>c.op==='displayInput'&&c.payload.action==='type').payload.text;assert(!outbound.includes(WECHAT_RULE));assert(!outbound.includes('微信'));assert(!outbound.includes('不得操作通讯软件'));
  assert.equal(calls.filter(c => c.op==='displayInput'&&c.payload.action==='type').length, 1);
  assert.equal(calls.filter(c => c.op==='displayInput'&&c.payload.action==='key').length, 1);
  assert.equal(calls.some(c => ['workbuddyFill','workbuddySend'].includes(c.op)), false);
  assert.equal(visual.judgments.filter(j=>j.input.evidence.expectedText).length,1);
  assert(calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
  await svc.close();
});

test('Hy3 follow-up refuses a visible paid-model selection before typing', async () => {
  const { svc, calls } = visualFixture('paid');
  const result = await svc.followUp({ text: '请核对上一项结果' });
  assert.equal(result.ok, false); assert.match(result.error, /原任务模型/);
  assert.equal(calls.some(c=>c.op==='displayInput'),false);
  await svc.close();
});

test('an owner-initiated visual continuation uses the shared production boundary without channel instructions',async()=>{
 const {svc,calls}=visualFixture('free');
 const text='发布已完成的网站并返回真实链接；保留现有文件';
 const result=await svc.followUp({text,ownerInitiated:true});assert.equal(result.ok,true,result.error);
 const outbound=calls.find(c=>c.op==='displayInput'&&c.payload.action==='type').payload.text;assert(outbound.startsWith(text));assert(!outbound.includes(WECHAT_RULE));assert(!outbound.includes('文件传输助手'));assert(!outbound.includes('不得操作通讯软件'));
 assert.equal(svc.task.followUpHistory.at(-1).outboundText,outbound);await svc.close();
});
test('follow-up protects the complete envelope including criteria before either input path receives it',async()=>{
 const {svc,calls}=visualFixture('free');svc.task.criteria='private-scope-parameter';let prepared;
 svc.sensitivePolicy.prepareWorkBuddy=async text=>{prepared=text;return {text:text.replaceAll('private-scope-parameter','protected-parameter')};};
 const text='补充真实结果';const result=await svc.followUp({text});assert.equal(result.ok,true,result.error);
 assert(prepared.includes('private-scope-parameter'));assert(!prepared.includes('不得操作通讯软件'));
 const typed=calls.find(c=>c.op==='displayInput'&&c.payload.action==='type').payload.text;assert(typed.includes('protected-parameter'));assert(!typed.includes('private-scope-parameter'));assert.equal(svc.task.followUpHistory.at(-1).text,text);await svc.close();
});
