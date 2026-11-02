'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { MemoryService } = require('../src/main/memory-service');
const { TaskNotifications } = require('../src/main/task-notifications');
const { InteractionStrategy } = require('../src/main/interaction-strategy');
const { validateIntent } = require('../src/main/dialogue-actions');
const { notificationLoginAction } = require('../src/main/desktop-service');
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-alerts-')); let now = 1000000;
  const memory = new MemoryService({ dir: root, bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 61), getSettings: () => ({ enabled: true, extract: false, scene: 'life' }) });
  await memory.init(); assert(memory.ready, memory.error);
  const sent = [], svc = new TaskNotifications({ memory, getScene: () => 'life', ready: () => memory.ready, clock: () => now,
    canOperate: async () => true, deliver: async event => { sent.push(event); return { state: 'sent' }; }, ...options });
  t.after(async () => { await svc.close(); await memory.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const enqueue = (status = 'failed', taskId = 'task-one') => svc.enqueue({ target: 'workbuddy', status, taskId, epoch: memory.generation, scene: 'life' });
  return { svc, memory, sent, enqueue, advance: ms => { now += ms; } };
}
test('default recipient, encrypted once-only delivery, status recovery and disabled policy', async t => {
  const f = await fixture(t); await f.enqueue(); await f.enqueue('stall'); await f.svc.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].recipient, '文件传输助手');
  assert(!f.sent[0].text.includes('task-one')); await f.svc.tick(); assert.equal(f.sent.length, 1);
  await f.enqueue('overdue', 'task-two'); await f.enqueue('resolved', 'task-two'); await f.svc.tick(); assert.equal(f.sent.length, 1);
  const source = await f.memory.addMessage('user', '以后异常提醒微信发给张三。');
  assert.equal(await f.svc.configure({ enabled: true, recipient: '张三' }, { sourceId: source.id }), '异常微信提醒发给张三');
  await f.enqueue('failed', 'task-three'); await f.svc.tick(); assert.equal(f.sent[1].recipient, '张三');
  const disable = await f.memory.addMessage('user', '关闭微信异常提醒。');
  await f.svc.configure({ enabled: false }, { sourceId: disable.id }); await f.enqueue('failed', 'task-four'); await f.svc.tick(); assert.equal(f.sent.length, 2);
  const external = await f.memory.addMessage('assistant', '通知张三');
  await assert.rejects(f.svc.configure({ enabled: true, recipient: '张三' }, { sourceId: external.id }), /主人/);
  await assert.rejects(f.svc.configure({ enabled: true, recipient: '李四' }, { sourceId: source.id }), /明确指定/);
  assert.doesNotThrow(() => validateIntent({ action: 'task_notifications', enabled: true, recipient: '张三' }));
});
test('expired and cancelled reminders never send; sending after restart becomes unknown', async t => {
  const f = await fixture(t); await f.enqueue(); f.advance(16 * 60000); await f.svc.tick(); assert.equal(f.sent.length, 0);
  await f.enqueue('failed', 'new-task'); const row = (await f.svc.rows()).find(r => r.value.state === 'pending');
  await f.memory.write([{ ...row, value: { ...row.value, state: 'sending' } }]);
  await f.svc.tick(); assert.equal(f.sent.length, 0); assert.equal((await f.svc.rows()).find(r => r.id === row.id).value.state, 'unknown');
});
test('a completion during asynchronous idle check cancels the reminder before irreversible send', async t => {
  let enter, release;
  const gate = new Promise(r => { release = r; });
  const f = await fixture(t, { canOperate: async () => { enter = true; await gate; return true; } });
  await f.enqueue(); const running = f.svc.tick(); while (!enter) await new Promise(r => setImmediate(r));
  await f.enqueue('resolved'); release(); await running; assert.equal(f.sent.length, 0);
});
test('unknown delivery is not retried and app-specific failure experience prefers visual', async t => {
  let calls = 0;
  const f = await fixture(t, { deliver: async () => { calls++; throw new Error('uncertain'); } });
  await f.enqueue(); await f.svc.tick(); await f.svc.tick(); assert.equal(calls, 1);
  const source = await f.memory.addMessage('user', '检查任务');
  await f.memory.write([{ id: 'strategy-task', kind: 'task', ts: Date.now(), domain: 'work', visibilityFloor: 1, value: { sources: [source.id] } }]);
  const strategies = new InteractionStrategy(f.memory), task = { id: 'strategy-task', target: 'workbuddy', scene: 'life', domain: 'work', visibilityFloor: 1 };
  assert.equal(await strategies.preferVisual(task), false); await strategies.record(task, 'failed'); assert.equal(await strategies.preferVisual(task), true);
  assert.equal(await strategies.preferVisual({ target: 'wechat' }), true);
});
test('an uncertain send remains non-retryable after the deduplication window', async t => {
  let calls = 0;
  const f = await fixture(t, { deliver: async () => { calls++; return { state: 'unknown' }; } });
  await f.enqueue(); await f.svc.tick();
  f.advance(21 * 60000);
  await f.enqueue('failed'); await f.svc.tick();
  assert.equal(calls, 1);
});
test('unrelated task history cannot hide a pending notification', async t => {
  const f = await fixture(t); await f.enqueue();
  for (let offset = 0; offset < 220; offset += 100) {
    const rows = Array.from({ length: Math.min(100, 220 - offset) }, (_, i) => ({
      id: `unrelated-${offset + i}`, kind: 'task', ts: 1000001 + offset + i,
      domain: 'life', visibilityFloor: 1, value: { sources: [] },
    }));
    await f.memory.write(rows);
  }
  await f.svc.tick(); assert.equal(f.sent.length, 1);
});
test('a negated or quoted instruction does not authorize changing the recipient', async t => {
  const f = await fixture(t);
  const negative = await f.memory.addMessage('user', '以后任务异常不要微信通知张三。');
  await assert.rejects(f.svc.configure({ enabled: true, recipient: '张三' }, { sourceId: negative.id }));
  const reported = await f.memory.addMessage('user', '张三说以后任务异常微信通知李四。');
  await assert.rejects(f.svc.configure({ enabled: true, recipient: '李四' }, { sourceId: reported.id }));
  assert.equal((await f.svc.policy()).recipient, '文件传输助手');
});
test('forgetting the authorization during configure prevents saving its recipient', async t => {
  const f = await fixture(t);
  const source = await f.memory.addMessage('user', '以后任务异常微信通知张三。');
  const policy = f.svc.policy.bind(f.svc);
  let entered, release;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  f.svc.policy = async (...args) => { const result = await policy(...args); entered(); await gate; return result; };
  const configuring = f.svc.configure({ enabled: true, recipient: '张三' }, { sourceId: source.id });
  await ready; await f.memory.remove(source.id); release();
  await assert.rejects(configuring, /来源已经变化/);
  assert.equal((await policy()).recipient, '文件传输助手');
});
test('a private recipient is not exposed in another scene notification status', async t => {
  let scene = 'private';
  const f = await fixture(t, { getScene: () => scene });
  const source = await f.memory.addMessage('user', '以后任务异常微信通知张三。', { scene: 'private', domain: 'private', visibilityFloor: 2 });
  await f.svc.configure({ enabled: true, recipient: '张三' }, { sourceId: source.id, scene });
  scene = 'work';
  assert(!((await f.svc.context()).text.includes('张三')));
});
test('cancelling a task cancels its pending alert', async t => {
  const f = await fixture(t); await f.enqueue('failed'); await f.enqueue('cancelled'); await f.svc.tick();
  assert.equal(f.sent.length, 0);
});
test('notification login is visual, single-attempt and skips phone/QR-only states', () => {
  const row = text => ({ text, confidence: .95, x: .4, y: .5, width: .2, height: .1 });
  const button = { ocr: [row('登录')] };
  assert.deepEqual(notificationLoginAction(button), { action: 'click', x: .5, y: .55, reason: '视觉确认微信一键登录，仅尝试一次' });
  assert.deepEqual(notificationLoginAction(button, true), { skip: true });
  assert.deepEqual(notificationLoginAction({ ocr: [row('扫码登录')] }), { skip: true });
  assert.deepEqual(notificationLoginAction({ ocr: [row('登录'), row('请在手机上确认登录')] }), { skip: true });
  assert.deepEqual(notificationLoginAction({ ocr: [row('为了你的账号安全，请重新登录。'), row('我知道了')] }), { skip: true });
  assert.equal(notificationLoginAction({ ocr: [row('登录'), { ...row('搜索'), x: .1 }] }), null, 'ordinary messages in the main UI do not look like a login screen');
});
